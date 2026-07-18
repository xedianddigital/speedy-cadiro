# PoE Trade Notifier

A local live-search notifier for Path of Exile trade. It watches official trade
searches over PoE's own live-search WebSocket, shows new listings the moment
they appear, and can send the same "Travel to Hideout" whisper the official
trade site's button sends.

Everything runs on your machine. Your cookies are stored only in `.data/config.json`
(gitignored) and are sent nowhere except `pathofexile.com`.

---

## Install (Windows)

1. Download **`PoE Trade Notifier-Setup-x.y.z.exe`** from the
   [Releases page](../../releases/latest).
2. Run it. It installs per-user and launches itself — no admin rights, no
   wizard, nothing else to install.
3. Windows SmartScreen will warn that the app is unsigned. Click **More info →
   Run anyway**. (Code signing certificates cost money; the build is
   reproducible from source via GitHub Actions if you'd rather verify it.)

Everything is bundled: you do **not** need Node.js, pnpm, or anything else.

Your session and settings are stored in
`%APPDATA%\poe-trade-notifier\data\config.json` and are not touched by
uninstalling.

---

## Running from source (developers)

Requires **Node.js 20.9+**.

```bash
corepack enable pnpm
pnpm install
pnpm dev        # http://localhost:3000 in a browser
pnpm electron   # or run the desktop shell against the dev server
```

Building installers yourself:

```bash
pnpm dist:win     # Windows NSIS installer  -> dist/
pnpm dist:linux   # Linux AppImage          -> dist/
pnpm dist:dir     # unpacked app, no installer (fastest for testing)
```

Installers for tagged releases are built on GitHub Actions; see
`.github/workflows/build.yml`.

> After running any `dist:*` script, `pnpm dev` will fail to read cookies:
> electron-builder recompiles `better-sqlite3` against Electron's ABI, which
> plain Node can't load. Run `pnpm rebuild:node` to switch it back.

---

### Connecting your session

**Sign in to pathofexile.com** (recommended). Opens a login window inside the
app. Nothing is read from disk, so it works on every browser and every version
— including Chrome 127+, where cookies cannot be read externally at all. The
Cloudflare clearance is issued to this window, so the User-Agent matches by
construction. The login persists across restarts.

**Detect from browser** reads cookies from an installed browser's profile
instead:

| Browser | Result |
|---|---|
| **Firefox** (any version) | Works — cookies are stored unencrypted. |
| **Chrome / Edge / Brave ≤ 126** | Works via DPAPI. |
| **Chrome / Edge / Brave ≥ 127** | **Cannot work.** Use the in-app sign-in. |

Chrome 127 introduced *app-bound encryption*: the key lives in a Windows
service that deliberately refuses other processes. No program can read those
cookies — that's the point of the feature, not a bug here.

**Paste manually** is the last resort: `F12` → **Application** (Chrome/Edge) or
**Storage** (Firefox) → **Cookies** → `https://www.pathofexile.com`. Copy
`POESESSID` (required), plus `cf_clearance` and `POETOKEN` if present.

The **User-Agent field must match the browser the cookies came from** —
Cloudflare binds `cf_clearance` to it. The app prefills a matching agent from
the browser it finds installed, but to be certain, copy `navigator.userAgent`
from that browser's console.

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

### The two modes

**Auto-travel** — off by default, behind two switches: a global master toggle in
Settings and a per-search checkbox. On the first matching listing it whispers
the seller immediately, then **stops scanning that search for 5–30s**
(configurable, default 15s). Without that pause a busy search would yank you
between hideouts once a second. The socket stays connected during the pause and
incoming listings are simply discarded, which costs zero API calls.

**Manual travel** — the feed holds a bounded number of listings (default 10),
newest first. Each has a Travel button and a draining bar showing its remaining
life. Listings expire after 3 minutes (configurable) and are replaced by newer
ones; when the buffer is full the oldest is evicted.

This whispers sellers automatically from your account. GGG tolerates live-search
notifiers, but automated whispering is a grey area in their terms. Keep the
cooldown sane and don't leave it running unattended.

## Staying under GGG's limits

PoE actively defends against bots, so the app is deliberately conservative:

- **Published budgets are obeyed.** Every response carries `X-Rate-Limit-*`
  headers (`hits:period:restrict`). All requests are serialised through one
  limiter that paces itself from the tightest published rule at 60% of budget,
  adds jitter, and sits out any restriction rather than discovering limits by
  being 429'd.
- **At most 5 live searches** run at once. One WebSocket per search is the
  clearest bot signal there is.
- **Cooldowns discard rather than disconnect.** Reconnecting on every cooldown
  is exactly what earns a 1013.
- **Reconnects back off exponentially** (1s→30s), and only reset after a socket
  has stayed up 30s — because PoE accepts the upgrade and *then* closes when it
  wants you to slow down.

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
