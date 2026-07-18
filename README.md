# PoE Trade Notifier

A local live-search notifier for Path of Exile trade. It watches official trade
searches over PoE's own live-search WebSocket, shows new listings the moment
they appear, and can send the same "Travel to Hideout" whisper the official
trade site's button sends.

Everything runs on your machine. Your cookies are stored only in `.data/config.json`
(gitignored) and are sent nowhere except `pathofexile.com`.

---

## Requirements

- **Node.js 20.9 or newer** (Next.js 16 will not start on Node 18)
- **pnpm** (ships with Node via Corepack)
- A browser logged in to pathofexile.com

## Setup

```bash
corepack enable pnpm
pnpm install
pnpm dev
```

Then open <http://localhost:3000>.

If `pnpm install` skips the native build for `better-sqlite3`, run
`pnpm rebuild better-sqlite3`. That module is only used to read browser cookie
databases; it is loaded lazily, so if the build fails the app still works with
manual cookie paste.

---

## Windows

```powershell
# 1. Install Node 20+ (LTS) from https://nodejs.org, then in PowerShell:
node --version          # must print v20.9+ or v22+

# 2. From the project folder:
corepack enable pnpm
pnpm install
pnpm dev
```

Open <http://localhost:3000>.

### Cookie detection on Windows

Click **Detect from browser**. What works:

| Browser | Result |
|---|---|
| **Firefox** | Works. Cookies are stored unencrypted; read directly. |
| **Chrome / Edge / Brave, version ≤ 126** | Works via DPAPI. |
| **Chrome / Edge / Brave, version ≥ 127** | **Does not work.** Use manual paste. |

Chrome 127 introduced *app-bound encryption*: the cookie key is held by a
Windows service and is deliberately unreadable by other processes. This is not
a bug in this app and cannot be worked around. **On Windows, Firefox is the
smoother option.**

### Manual paste (always works)

1. On pathofexile.com, press `F12` → **Application** → **Cookies** →
   `https://www.pathofexile.com`
2. Copy `POESESSID` (required), `cf_clearance`, and `POETOKEN` if present.
3. In the app, click **Paste manually**, fill them in, and save.

Open the app in the **same browser** the cookies came from. `cf_clearance` is
bound to the exact User-Agent, so the app uses your browser's real
`navigator.userAgent` when it can. Using a different browser can cause
Cloudflare to reject requests.

---

## Using it

1. **Session** — click *Detect from browser*, or paste cookies manually. The
   pill shows `valid` once the API accepts them.
2. **Watched searches** — paste a trade search URL, e.g.
   `https://www.pathofexile.com/trade/search/Mirage/aBcDeFg`. Add it, and the
   status dot goes green when the live socket connects.
3. **Feed** — new listings appear newest-first. Click **Travel** to whisper the
   seller.

Live search only pushes items listed **from now on**. An empty feed on a quiet
search is normal.

### Auto-travel

Off by default, behind two switches: a global master toggle in Settings and a
per-search checkbox. When armed, the first matching listing is whispered
automatically, subject to a per-search cooldown (default 10s).

This whispers sellers automatically from your account. GGG tolerates live-search
notifiers, but automated whispering is a grey area in their terms. Keep the
cooldown sane and don't leave it running unattended.

---

## Troubleshooting

**Status dot stuck on error, log says 1013**
The live socket rejects a **stale POESESSID** even while the REST API still
accepts it, and reports it as "try again later". Click *Detect from browser*
again to pick up the rotated cookie.

Repeatedly reconnecting also earns a real 1013 throttle that persists for a
while. The app backs off automatically (60s floor); wait it out rather than
restarting in a loop.

**Session shows `invalid` right after detecting**
Usually a User-Agent mismatch. Open the app in the same browser your cookies
came from, or paste that browser's User-Agent manually.

**`next dev` exits immediately**
Node is too old. Check with `node --version`; you need 20.9+.

---

## How it works

```
browser cookie store ──> lib/poe/cookie-detect.ts ──> .data/config.json
                                                            │
trade search URL ──> lib/poe/parse-url.ts ──> watched search
                                                            │
                                    lib/poe/live-engine.ts  │
                          wss://…/api/trade/live/{league}/{id}
                                            │ pushes result ids
                                            ▼
                            POST /api/trade/fetch (≤10 per call)
                                            │ full listings
                                            ▼
                          SSE  /api/events  ──> dashboard UI
                                            │
                        POST /api/trade/whisper  ("Travel to Hideout")
```

Whisper tokens are JWTs that expire **300 seconds** after they are issued, so a
manual travel always re-fetches the listing for a fresh token first. Auto-travel
uses the token straight off the live push, which is by definition fresh.
