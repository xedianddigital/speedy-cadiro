// Assembles .next/standalone into something Electron can ship.
//
// `next build` emits a standalone server plus only the traced dependencies, but
// deliberately leaves out static assets. It also leaves better-sqlite3 compiled
// against the system Node, whereas the packaged server runs under Electron's
// Node and needs a matching ABI. Both are fixed here.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const standalone = path.join(root, '.next', 'standalone')

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function copyDir(from, to) {
  if (!(await exists(from))) {
    console.warn(`  skip (missing): ${path.relative(root, from)}`)
    return
  }
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.cp(from, to, { recursive: true })
  console.log(`  ${path.relative(root, from)} -> ${path.relative(root, to)}`)
}

async function main() {
  if (!(await exists(standalone))) {
    throw new Error("No .next/standalone. Run `next build` with output: 'standalone' first.")
  }

  // Running the server from the standalone dir during testing leaves real
  // cookies in .data. Packaging that would hand a live session to everyone who
  // downloads the installer, so remove it before the packager ever sees it.
  const strayData = path.join(standalone, '.data')
  if (await exists(strayData)) {
    await fs.rm(strayData, { recursive: true, force: true })
    console.log('Removed stray .data (local session) from standalone')
  }

  console.log('Copying static assets into standalone…')
  await copyDir(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'))
  await copyDir(path.join(root, 'public'), path.join(standalone, 'public'))

  // Drop the traced node_modules entirely. Two reasons:
  //
  //  1. It contains symlinks into the pnpm store, which electron-builder cannot
  //     package (it tries to recreate links whose targets aren't in the bundle).
  //  2. Its better-sqlite3 is compiled for the system Node. electron-builder
  //     rebuilds the copy in the project's own node_modules against Electron's
  //     ABI and ships that one at the app root. Leaving this copy in place would
  //     shadow the correct build and fail at runtime.
  //
  // Node resolution walks up from server/, so requires resolve against the app
  // root's node_modules, which holds the correctly rebuilt dependencies.
  const tracedModules = [
    path.join(standalone, 'node_modules'),
    // Next also links serverExternalPackages here, as symlinks into the
    // project's node_modules that don't survive packaging.
    path.join(standalone, '.next', 'node_modules'),
  ]
  for (const dir of tracedModules) {
    if (!(await exists(dir))) continue
    await fs.rm(dir, { recursive: true, force: true })
    console.log(`Removed ${path.relative(standalone, dir)} (resolved from the app root instead)`)
  }

  console.log('\nStandalone ready:', path.relative(root, standalone))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
