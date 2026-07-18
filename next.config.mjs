/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  // Emits .next/standalone with a self-contained server and only the modules
  // actually reachable, which is what the Electron build ships.
  output: 'standalone',
  // better-sqlite3 is deliberately NOT listed as a server external package.
  // Doing so makes Next emit an aliased module plus a symlink under
  // .next/node_modules that cannot be packaged. lib/poe/cookie-detect.ts loads
  // it through createRequire instead, which resolves at runtime in both the dev
  // tree and a packaged app.
}

export default nextConfig
