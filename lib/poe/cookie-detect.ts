// Best-effort, LOCAL-ONLY reader for the three pathofexile.com cookies plus a
// matching User-Agent, so the "Detect from browser" button can populate the
// session in one click.
//
// This reads your own browser's on-disk cookie store (the cookies are HttpOnly,
// so a page script cannot read them - only a local process can). It never sends
// anything anywhere. If a platform/browser combination isn't supported or is
// blocked (e.g. Chrome app-bound "v20" encryption), it returns a clear reason
// and the UI falls back to manual paste.

import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createRequire } from "node:module"

const execFileAsync = promisify(execFile)

/**
 * Load better-sqlite3 without the bundler seeing it.
 *
 * A plain `import("better-sqlite3")` gets compiled into an aliased external
 * module (`better-sqlite3-<hash>`) that only resolves through a symlink in the
 * dev tree. That symlink can't be packaged, so the packaged app failed with
 * "Cannot find module better-sqlite3-<hash>".
 *
 * Resolving from the working directory instead lets Node walk up to whichever
 * node_modules actually holds the build compiled for the running ABI - the
 * project's in development, the app root's in a packaged build.
 */
function loadSqlite(): typeof import("better-sqlite3") {
  const requireCjs = createRequire(path.join(process.cwd(), "noop.js"))
  // Split so no bundler can statically match the specifier.
  const pkg = ["better", "sqlite3"].join("-")
  return requireCjs(pkg) as typeof import("better-sqlite3")
}

const WANTED = ["POESESSID", "POETOKEN", "cf_clearance"] as const
type WantedCookie = (typeof WANTED)[number]

export interface DetectedSession {
  poesessid?: string
  poetoken?: string
  cfClearance?: string
  userAgent?: string
  source: string
}

export interface DetectResult {
  ok: boolean
  session?: DetectedSession
  reason?: string
  /** Which cookies were found (helps the UI tell the user what's missing). */
  found: WantedCookie[]
}

const HOST_MATCH = (host: string) =>
  host === "pathofexile.com" ||
  host === ".pathofexile.com" ||
  host === "www.pathofexile.com" ||
  host.endsWith(".pathofexile.com")

// ---------- Chrome / Edge (Chromium) ----------

interface ChromiumPaths {
  userData: string
  label: string
}

function chromiumCandidates(): ChromiumPaths[] {
  const home = os.homedir()
  const platform = process.platform
  const out: ChromiumPaths[] = []
  if (platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    out.push({ userData: path.join(local, "Google", "Chrome", "User Data"), label: "Chrome" })
    out.push({ userData: path.join(local, "Microsoft", "Edge", "User Data"), label: "Edge" })
    out.push({ userData: path.join(local, "BraveSoftware", "Brave-Browser", "User Data"), label: "Brave" })
  } else if (platform === "darwin") {
    const appSup = path.join(home, "Library", "Application Support")
    out.push({ userData: path.join(appSup, "Google", "Chrome"), label: "Chrome" })
    out.push({ userData: path.join(appSup, "Microsoft Edge"), label: "Edge" })
    out.push({ userData: path.join(appSup, "BraveSoftware", "Brave-Browser"), label: "Brave" })
  } else {
    // Native, snap, and flatpak installs each keep a separate config tree.
    const configRoots = [
      path.join(home, ".config"),
      path.join(home, "snap", "chromium", "current", ".config"),
      path.join(home, ".var", "app", "com.google.Chrome", "config"),
      path.join(home, ".var", "app", "com.brave.Browser", "config"),
    ]
    for (const config of configRoots) {
      out.push({ userData: path.join(config, "google-chrome"), label: "Chrome" })
      out.push({ userData: path.join(config, "chromium"), label: "Chromium" })
      out.push({ userData: path.join(config, "microsoft-edge"), label: "Edge" })
      out.push({ userData: path.join(config, "BraveSoftware", "Brave-Browser"), label: "Brave" })
    }
  }
  return out
}

/**
 * Copy a live cookie database aside so it can be opened read-only.
 *
 * On Windows the browser keeps the file open, and fs.copyFile (CopyFileW) fails
 * with EBUSY. A plain read succeeds anyway, because SQLite opens its files
 * allowing other readers - so fall back to read-then-write.
 *
 * The -wal and -shm siblings come along when present: a cookie written moments
 * ago may still live only in the write-ahead log, and opening the main file
 * without them would miss it or fail outright.
 */
async function copyDbForReading(src: string, dest: string): Promise<void> {
  try {
    await fs.copyFile(src, dest)
  } catch {
    await fs.writeFile(dest, await fs.readFile(src))
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await fs.writeFile(dest + suffix, await fs.readFile(src + suffix))
    } catch {
      // Absent or unreadable; the main database alone is usually enough.
    }
  }
}

async function removeDbCopy(dest: string): Promise<void> {
  await Promise.all(
    [dest, `${dest}-wal`, `${dest}-shm`].map((p) => fs.rm(p, { force: true }).catch(() => {})),
  )
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function dpapiUnprotect(buf: Buffer): Promise<Buffer> {
  // Windows-only: unprotect via PowerShell + System.Security.Cryptography.ProtectedData.
  const b64 = buf.toString("base64")
  const script = [
    "Add-Type -AssemblyName System.Security;",
    `$b=[Convert]::FromBase64String('${b64}');`,
    "$o=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');",
    "[Convert]::ToBase64String($o)",
  ].join(" ")
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ])
  return Buffer.from(stdout.trim(), "base64")
}

// Windows wraps a 256-bit AES-GCM key with DPAPI. macOS and Linux instead derive
// a 128-bit AES-CBC key with PBKDF2 from a per-browser "Safe Storage" password.
type CryptoScheme = "gcm" | "cbc"

interface ChromiumCrypto {
  /** Candidate keys, tried in order (Linux can't tell v10 from v11 up front). */
  keys: Buffer[]
  scheme: CryptoScheme
}

const SAFE_STORAGE_SERVICE: Record<string, string> = {
  Chrome: "Chrome Safe Storage",
  Chromium: "Chromium Safe Storage",
  Edge: "Microsoft Edge Safe Storage",
  Brave: "Brave Safe Storage",
}

function deriveCbcKey(password: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1")
}

async function macKeychainPassword(label: string): Promise<string | null> {
  const service = SAFE_STORAGE_SERVICE[label] ?? "Chrome Safe Storage"
  try {
    // Prompts once, then the user can "Always Allow".
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-w",
      "-s",
      service,
      "-a",
      label,
    ])
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function linuxKeyringPassword(label: string): Promise<string | null> {
  const app = label === "Edge" ? "microsoft-edge" : label.toLowerCase()
  const attempts = [
    ["lookup", "xdg:schema", "chrome_libsecret_os_crypt_password_v2", "application", app],
    ["lookup", "xdg:schema", "chrome_libsecret_os_crypt_password_v1", "application", app],
    ["lookup", "application", app],
  ]
  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync("secret-tool", args)
      if (stdout.trim()) return stdout.trim()
    } catch {
      // secret-tool missing or no match - try the next schema.
    }
  }
  return null
}

async function getChromiumCrypto(userData: string, label: string): Promise<ChromiumCrypto> {
  if (process.platform === "win32") {
    const raw = await fs.readFile(path.join(userData, "Local State"), "utf8")
    const json = JSON.parse(raw) as { os_crypt?: { encrypted_key?: string } }
    const encKeyB64 = json.os_crypt?.encrypted_key
    if (!encKeyB64) throw new Error("No os_crypt.encrypted_key in Local State.")
    // Strip the "DPAPI" prefix (5 bytes), then unprotect with the current user's key.
    const key = await dpapiUnprotect(Buffer.from(encKeyB64, "base64").subarray(5))
    return { keys: [key], scheme: "gcm" }
  }

  if (process.platform === "darwin") {
    const pw = await macKeychainPassword(label)
    if (!pw) {
      throw new Error(
        `Could not read "${SAFE_STORAGE_SERVICE[label] ?? label}" from the macOS Keychain (denied or absent).`,
      )
    }
    return { keys: [deriveCbcKey(pw, 1003)], scheme: "cbc" }
  }

  // Linux: v11 cookies use a keyring-derived password, v10 uses the well-known
  // "peanuts" fallback used when no keyring is available. Try both.
  const keys: Buffer[] = []
  const pw = await linuxKeyringPassword(label)
  if (pw) keys.push(deriveCbcKey(pw, 1))
  keys.push(deriveCbcKey("peanuts", 1))
  return { keys, scheme: "cbc" }
}

/** Chromium's AES-CBC mode uses a fixed IV of 16 space characters. */
const CBC_IV = Buffer.alloc(16, 0x20)

function stripPkcs7(buf: Buffer): Buffer {
  if (buf.length === 0) return buf
  const pad = buf[buf.length - 1]
  if (pad < 1 || pad > 16 || pad > buf.length) return buf
  return buf.subarray(0, buf.length - pad)
}

function isPlausibleCookie(text: string): boolean {
  // Cookie values are printable ASCII; a wrong key yields binary garbage.
  return text.length > 0 && /^[\x20-\x7e]+$/.test(text)
}

function decryptChromiumValue(encrypted: Buffer, cryptoInfo: ChromiumCrypto): string | null {
  if (encrypted.length === 0) return null
  const prefix = encrypted.subarray(0, 3).toString("latin1")

  if (prefix === "v20") {
    // App-bound encryption (Chrome 127+) - the key is held by a Windows service
    // and is deliberately not reachable from another process.
    throw new Error("APP_BOUND")
  }

  if (prefix !== "v10" && prefix !== "v11") {
    // Legacy: DPAPI-encrypted directly (older Chrome) - handled by caller on win32.
    return null
  }

  const body = encrypted.subarray(3)

  if (cryptoInfo.scheme === "gcm") {
    const nonce = body.subarray(0, 12)
    const tag = body.subarray(body.length - 16)
    const ciphertext = body.subarray(12, body.length - 16)
    const decipher = crypto.createDecipheriv("aes-256-gcm", cryptoInfo.keys[0], nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  }

  // CBC has no auth tag, so a wrong key decrypts to garbage rather than failing.
  // Try each candidate and keep the first result that looks like a cookie.
  for (const key of cryptoInfo.keys) {
    try {
      const decipher = crypto.createDecipheriv("aes-128-cbc", key, CBC_IV)
      decipher.setAutoPadding(false)
      const out = Buffer.concat([decipher.update(body), decipher.final()])
      const text = stripPkcs7(out).toString("utf8")
      if (isPlausibleCookie(text)) return text
    } catch {
      // Wrong key or bad block size - try the next candidate.
    }
  }
  return null
}

async function readChromiumVersion(userData: string): Promise<string | null> {
  try {
    const v = await fs.readFile(path.join(userData, "Last Version"), "utf8")
    return v.trim()
  } catch {
    return null
  }
}

function buildChromeUA(version: string | null, label: string): string {
  const major = version ? version.split(".")[0] : "120"
  const platform = process.platform
  const osToken =
    platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64"
  const brand =
    label === "Edge"
      ? ` Edg/${major}.0.0.0`
      : label === "Brave"
        ? ""
        : ""
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${brand}`
}

async function tryChromium(): Promise<DetectResult> {
  const reasons: string[] = []
  let sqlite: typeof import("better-sqlite3")
  try {
    // Lazy-load: the app must not crash if the native binary isn't built.
    sqlite = loadSqlite()
  } catch (err) {
    return {
      ok: false,
      found: [],
      reason: `Could not load the SQLite reader (${(err as Error).message}). Use manual paste.`,
    }
  }

  for (const cand of chromiumCandidates()) {
    if (!(await exists(cand.userData))) continue
    // Cookies live under the profile; check Default first, then Profile *.
    const profileDirs = ["Default", "Profile 1", "Profile 2", "Profile 3"]
    for (const profile of profileDirs) {
      const cookiesPath = path.join(cand.userData, profile, "Network", "Cookies")
      const legacyCookiesPath = path.join(cand.userData, profile, "Cookies")
      const dbPath = (await exists(cookiesPath))
        ? cookiesPath
        : (await exists(legacyCookiesPath))
          ? legacyCookiesPath
          : null
      if (!dbPath) continue

      try {
        const cryptoInfo = await getChromiumCrypto(cand.userData, cand.label)
        // Copy the (possibly locked) DB to a temp file before opening.
        const tmp = path.join(os.tmpdir(), `poe-cookies-${Date.now()}.db`)
        await copyDbForReading(dbPath, tmp)
        const found: Partial<Record<WantedCookie, string>> = {}
        let appBound = false
        try {
          const db = new sqlite(tmp, { readonly: true, fileMustExist: true })
          const rows = db
            .prepare("SELECT host_key, name, encrypted_value FROM cookies WHERE name IN (?,?,?)")
            .all(...WANTED) as { host_key: string; name: WantedCookie; encrypted_value: Buffer }[]
          db.close()
          for (const row of rows) {
            if (!HOST_MATCH(row.host_key)) continue
            try {
              const value = decryptChromiumValue(Buffer.from(row.encrypted_value), cryptoInfo)
              if (value) found[row.name] = sanitize(value)
            } catch (e) {
              if ((e as Error).message === "APP_BOUND") appBound = true
            }
          }
        } finally {
          await removeDbCopy(tmp)
        }

        const foundKeys = Object.keys(found) as WantedCookie[]
        if (foundKeys.length > 0) {
          const version = await readChromiumVersion(cand.userData)
          return {
            ok: true,
            found: foundKeys,
            session: {
              poesessid: found.POESESSID,
              poetoken: found.POETOKEN,
              cfClearance: found.cf_clearance,
              userAgent: buildChromeUA(version, cand.label),
              source: `${cand.label} (${profile})`,
            },
          }
        }
        if (appBound) {
          reasons.push(
            `${cand.label}: cookies use app-bound encryption (Chrome 127+) which can't be read externally.`,
          )
        }
      } catch (err) {
        reasons.push(`${cand.label} (${profile}): ${(err as Error).message}`)
      }
    }
  }

  return {
    ok: false,
    found: [],
    reason:
      reasons.length > 0
        ? reasons.join(" ")
        : "No Chromium cookie store with pathofexile.com cookies found.",
  }
}

// ---------- Firefox (unencrypted sqlite) ----------

function firefoxProfileRoots(): string[] {
  const home = os.homedir()
  if (process.platform === "win32") {
    return [path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Mozilla", "Firefox", "Profiles")]
  }
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "Firefox", "Profiles")]
  }
  // Linux: plain, snap, and flatpak installs each keep their own profile tree.
  return [
    path.join(home, ".mozilla", "firefox"),
    path.join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    path.join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
  ]
}

async function tryFirefox(): Promise<DetectResult> {
  let sqlite: typeof import("better-sqlite3")
  try {
    sqlite = loadSqlite()
  } catch (err) {
    return { ok: false, found: [], reason: `SQLite reader unavailable (${(err as Error).message}).` }
  }
  const roots: string[] = []
  for (const root of firefoxProfileRoots()) {
    if (await exists(root)) roots.push(root)
  }
  if (roots.length === 0) {
    return { ok: false, found: [], reason: "No Firefox profiles directory found." }
  }
  const entries: { root: string; name: string }[] = []
  for (const root of roots) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) entries.push({ root, name: entry.name })
    }
  }
  for (const entry of entries) {
    const cookiesPath = path.join(entry.root, entry.name, "cookies.sqlite")
    if (!(await exists(cookiesPath))) continue
    try {
      const tmp = path.join(os.tmpdir(), `poe-ff-${Date.now()}.db`)
      await copyDbForReading(cookiesPath, tmp)
      const found: Partial<Record<WantedCookie, string>> = {}
      try {
        const db = new sqlite(tmp, { readonly: true, fileMustExist: true })
        const rows = db
          .prepare("SELECT host, name, value FROM moz_cookies WHERE name IN (?,?,?)")
          .all(...WANTED) as { host: string; name: WantedCookie; value: string }[]
        db.close()
        for (const row of rows) {
          if (!HOST_MATCH(row.host)) continue
          found[row.name] = sanitize(row.value)
        }
      } finally {
        await removeDbCopy(tmp)
      }
      const foundKeys = Object.keys(found) as WantedCookie[]
      if (foundKeys.length > 0) {
        const major = await readFirefoxMajor(path.join(entry.root, entry.name))
        return {
          ok: true,
          found: foundKeys,
          session: {
            poesessid: found.POESESSID,
            poetoken: found.POETOKEN,
            cfClearance: found.cf_clearance,
            userAgent: buildFirefoxUA(major),
            source: `Firefox ${major ?? "?"} (${entry.name})`,
          },
        }
      }
    } catch {
      // try next profile
    }
  }
  return { ok: false, found: [], reason: "No Firefox profile had pathofexile.com cookies." }
}

/** Major version from a profile's compatibility.ini (e.g. "152.0.4_2026..." -> "152"). */
async function readFirefoxMajor(profileDir: string): Promise<string | null> {
  try {
    const ini = await fs.readFile(path.join(profileDir, "compatibility.ini"), "utf8")
    const match = ini.match(/^LastVersion=(\d+)/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function buildFirefoxUA(major: string | null): string {
  const version = major ?? "121"
  // Firefox froze the `rv:` token at 109.0 from version 110 onward, while the
  // trailing Firefox/<version> keeps incrementing.
  const rv = Number(version) >= 110 ? "109.0" : `${version}.0`
  const osToken =
    process.platform === "win32"
      ? `Windows NT 10.0; Win64; x64; rv:${rv}`
      : process.platform === "darwin"
        ? `Macintosh; Intel Mac OS X 10.15; rv:${rv}`
        : `X11; Linux x86_64; rv:${rv}`
  return `Mozilla/5.0 (${osToken}) Gecko/20100101 Firefox/${version}.0`
}

function sanitize(value: string): string {
  // Some Chromium builds prepend a 32-byte binary header to the plaintext.
  // POESESSID is a 32-char hex string; cf_clearance/POETOKEN are URL-safe.
  // Strip any leading non-printable bytes.
  return value.replace(/^[\x00-\x1f]+/, "").trim()
}

/**
 * Work out the User-Agent of an installed browser without reading any cookies.
 *
 * Browser version files stay readable even when the cookie database is locked
 * or encrypted, so this still works in exactly the cases where detection fails
 * and the user has to paste cookies by hand. That matters because cf_clearance
 * is bound to the exact User-Agent: pasting the right cookies with the wrong
 * agent still gets rejected.
 */
export async function detectUserAgent(): Promise<{ userAgent: string; source: string } | null> {
  for (const cand of chromiumCandidates()) {
    if (!(await exists(cand.userData))) continue
    const version = await readChromiumVersion(cand.userData)
    if (version) {
      return { userAgent: buildChromeUA(version, cand.label), source: `${cand.label} ${version.split(".")[0]}` }
    }
  }

  for (const root of firefoxProfileRoots()) {
    if (!(await exists(root))) continue
    let entries: string[]
    try {
      entries = (await fs.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const name of entries) {
      const major = await readFirefoxMajor(path.join(root, name))
      if (major) return { userAgent: buildFirefoxUA(major), source: `Firefox ${major}` }
    }
  }

  return null
}

/** Try all supported browsers, Chromium first. */
export async function detectSession(): Promise<DetectResult> {
  const chromium = await tryChromium()
  if (chromium.ok && chromium.session?.poesessid) return chromium

  const firefox = await tryFirefox()
  if (firefox.ok && firefox.session?.poesessid) return firefox

  // If a browser yielded *some* cookies but not POESESSID, that's a login
  // problem, not a reading problem - say so plainly.
  if (chromium.ok || firefox.ok) {
    const partial = chromium.ok ? chromium : firefox
    return {
      ok: false,
      found: partial.found,
      reason: `Found ${partial.found.join(", ")} but not POESESSID, which means you aren't logged in to pathofexile.com in that browser. Log in there, then try again.`,
      session: partial.session,
    }
  }

  const details = [chromium.reason, firefox.reason].filter(Boolean).join(" ")

  // Chrome 127+ is the single most common cause on Windows and cannot be worked
  // around, so lead with it rather than burying it in a merged string.
  if (/app-bound/i.test(details)) {
    return {
      ok: false,
      found: [],
      reason:
        "Chrome 127 and newer encrypt cookies with a key only Chrome itself can use, so they cannot be read by any other program. Either paste your cookies manually below, or log in to pathofexile.com in Firefox and detect again.",
    }
  }

  return {
    ok: false,
    found: [],
    reason: `No pathofexile.com cookies found in Chrome, Edge, Brave or Firefox. Make sure you're logged in at pathofexile.com in one of them. (${details})`,
  }
}
