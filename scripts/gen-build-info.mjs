// Stamps each build with its commit and time, so a running app is traceable to
// the exact code that produced it without hand-bumping the version every time.
// The version in package.json still moves for meaningful releases; this makes
// every build in between uniquely identifiable.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function shortCommit() {
  // CI provides the SHA in the environment; fall back to git locally.
  const fromEnv = process.env.GITHUB_SHA
  if (fromEnv) return fromEnv.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
  } catch {
    return 'local'
  }
}

const info = {
  commit: shortCommit(),
  builtAt: new Date().toISOString(),
}

await fs.writeFile(
  path.join(root, 'electron', 'build-info.json'),
  JSON.stringify(info, null, 2) + '\n',
)
console.log(`build-info: commit ${info.commit} @ ${info.builtAt}`)
