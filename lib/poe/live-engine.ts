// The live-search engine. Holds one WebSocket per active watched search against
// pathofexile.com's official live-search endpoint, turns the ids it pushes into
// full listings via /api/trade/fetch, and broadcasts everything to connected UI
// clients over SSE.
//
// This is a long-lived singleton stashed on globalThis so Next's dev-mode module
// reloading doesn't leave orphaned sockets behind.

import { EventEmitter } from "node:events"
import WebSocket from "ws"
import {
  AUTO_TRAVEL_COOLDOWN_MAX_MS,
  AUTO_TRAVEL_COOLDOWN_MIN_MS,
  MAX_ACTIVE_SEARCHES,
  type Listing,
  type SearchStatus,
  type ServerEvent,
  type Session,
  type WatchedSearch,
} from "./types"
import { getSearches, getSession, getSettings } from "./config"
import {
  CloudflareError,
  RateLimitError,
  SessionError,
  fetchListings,
  refetchListing,
  sendWhisper,
} from "./poe-client"

const WS_BASE = "wss://www.pathofexile.com/api/trade/live"

/** Reconnect backoff: 1s, 2s, 4s … capped. */
const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

/**
 * PoE accepts the upgrade and *then* closes with 1013 when it wants us to slow
 * down, so "opened" is not proof of health. Only clear the backoff after the
 * socket has stayed up this long, otherwise a reject loop never backs off.
 */
const STABLE_MS = 30_000

/** Minimum wait after an explicit "try again later" / policy close. */
const THROTTLED_MIN_MS = 60_000

/** Keep the connection from being reaped as idle. */
const PING_MS = 30_000

/** /fetch accepts at most 10 ids per call. */
// One token per fetch: the current protocol delivers one result JWT per
// message, and result tokens (unlike plain ids) can't be safely comma-batched.
const FETCH_BATCH = 1
/** Fire almost immediately: the whole point is the shortest path to the hideout. */
const FETCH_DEBOUNCE_MS = 0

/** How often to sweep the buffer for listings that have aged out. */
const EXPIRY_SWEEP_MS = 5_000

interface Connection {
  search: WatchedSearch
  ws: WebSocket | null
  status: SearchStatus
  attempts: number
  reconnectTimer: NodeJS.Timeout | null
  /** Fires once a socket has been up long enough to count as healthy. */
  stableTimer: NodeJS.Timeout | null
  pingTimer: NodeJS.Timeout | null
  /** Set when we deliberately close, so onclose doesn't schedule a reconnect. */
  stopping: boolean
  /** Ids pushed by the socket that haven't been fetched yet. */
  pending: string[]
  flushTimer: NodeJS.Timeout | null
  fetching: boolean
}

interface CachedListing {
  listing: Listing
  search: WatchedSearch
}

class LiveEngine {
  readonly events = new EventEmitter()
  private connections = new Map<string, Connection>()
  private listings = new Map<string, CachedListing>()
  /**
   * Global travel lock. After ANY travel (auto or manual, from any search),
   * every search stops fetching until this passes - so a match on one search
   * can't yank the user to another hideout mid-purchase. The socket stays open;
   * only fetching pauses, which costs zero API calls.
   */
  private travelPausedUntil = 0

  private sweepTimer: NodeJS.Timeout | null = null

  constructor() {
    // SSE clients come and go; don't warn when several attach at once.
    this.events.setMaxListeners(0)
    this.sweepTimer = setInterval(() => void this.sweepExpired(), EXPIRY_SWEEP_MS)
    // Don't hold the process open just for the sweep.
    this.sweepTimer.unref?.()
  }

  /** Clear the current listing once it has outlived the travel interval. */
  private async sweepExpired(): Promise<void> {
    if (this.listings.size === 0) return
    const { autoTravelCooldownMs } = await getSettings()
    const cutoff = Date.now() - autoTravelCooldownMs
    for (const [id, cached] of this.listings) {
      if (cached.listing.receivedAt < cutoff) {
        this.listings.delete(id)
        this.emit({ type: "expire", listingId: id })
      }
    }
  }

  // ---- broadcast ----

  private emit(event: ServerEvent): void {
    this.events.emit("event", event)
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.emit({ type: "log", level, message })
  }

  private setStatus(conn: Connection, status: SearchStatus, error?: string): void {
    conn.status = status
    this.emit({ type: "status", searchInternalId: conn.search.id, status, error })
  }

  // ---- public API ----

  /** Snapshot for a UI client that just connected. */
  getState(): { listings: Listing[]; statuses: Record<string, SearchStatus> } {
    const statuses: Record<string, SearchStatus> = {}
    for (const [id, conn] of this.connections) statuses[id] = conn.status
    const listings = [...this.listings.values()]
      .map((c) => c.listing)
      .sort((a, b) => b.receivedAt - a.receivedAt)
    return { listings, statuses }
  }

  /** Reconcile running sockets with what config says should be active. */
  async sync(): Promise<void> {
    const searches = await getSearches()
    const wanted = new Set(searches.filter((s) => s.active).map((s) => s.id))

    for (const [id, conn] of this.connections) {
      if (!wanted.has(id)) {
        this.stop(id)
      } else {
        // Keep the cached search row fresh (title/autoTravel may have changed).
        const updated = searches.find((s) => s.id === id)
        if (updated) conn.search = updated
      }
    }

    for (const search of searches) {
      if (search.active && !this.connections.has(search.id)) {
        await this.start(search)
      }
    }
  }

  async start(search: WatchedSearch): Promise<void> {
    if (this.connections.has(search.id)) return

    if (this.connections.size >= MAX_ACTIVE_SEARCHES) {
      const message = `Not starting "${search.title}": ${MAX_ACTIVE_SEARCHES} live searches already running. Pause one first.`
      this.log("warn", message)
      this.emit({ type: "status", searchInternalId: search.id, status: "error", error: message })
      return
    }

    const conn: Connection = {
      search,
      ws: null,
      status: "idle",
      attempts: 0,
      reconnectTimer: null,
      stableTimer: null,
      pingTimer: null,
      stopping: false,
      pending: [],
      flushTimer: null,
      fetching: false,
    }
    this.connections.set(search.id, conn)
    await this.connect(conn)
  }

  stop(id: string): void {
    const conn = this.connections.get(id)
    if (!conn) return
    conn.stopping = true
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)
    if (conn.flushTimer) clearTimeout(conn.flushTimer)
    this.clearTimers(conn)
    conn.ws?.close()
    conn.ws = null
    this.connections.delete(id)
    this.emit({ type: "status", searchInternalId: id, status: "disconnected" })
  }

  stopAll(): void {
    for (const id of [...this.connections.keys()]) this.stop(id)
  }

  // ---- socket lifecycle ----

  private async connect(conn: Connection): Promise<void> {
    const session = await getSession()
    if (!session?.poesessid) {
      this.setStatus(conn, "error", "No session configured.")
      this.emit({ type: "session", valid: false, message: "Add your PoE cookies first." })
      return
    }

    const { league, searchId } = conn.search
    const url = `${WS_BASE}/${encodeURIComponent(league)}/${searchId}`
    this.setStatus(conn, "connecting")

    let ws: WebSocket
    try {
      ws = new WebSocket(url, {
        // Mirror the headers the trade site's own live-search socket sends
        // (captured from a working browser connection). The exact User-Agent
        // matters because cf_clearance is bound to it, and the Sec-Fetch-* set
        // is what marks the upgrade as a legitimate same-origin websocket.
        headers: {
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          Cookie: liveCookieHeader(session),
          Origin: "https://www.pathofexile.com",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "websocket",
          "Sec-Fetch-Site": "same-origin",
          "User-Agent": session.userAgent || FALLBACK_UA,
        },
      })
    } catch (err) {
      this.setStatus(conn, "error", (err as Error).message)
      this.scheduleReconnect(conn)
      return
    }

    conn.ws = ws

    ws.on("open", () => {
      this.setStatus(conn, "connected")
      this.log("info", `Live search connected: ${conn.search.title}`)

      // Don't trust "open" alone - wait for the socket to prove it survives.
      conn.stableTimer = setTimeout(() => {
        conn.attempts = 0
        conn.stableTimer = null
      }, STABLE_MS)

      conn.pingTimer = setInterval(() => {
        if (conn.ws?.readyState === WebSocket.OPEN) conn.ws.ping()
      }, PING_MS)
    })

    ws.on("message", (raw) => {
      void this.onMessage(conn, raw.toString())
    })

    ws.on("error", (err) => {
      this.setStatus(conn, "error", err.message)
    })

    ws.on("unexpected-response", (_req, res) => {
      // A failed upgrade is how an expired session shows up here.
      const reason =
        res.statusCode === 401 || res.statusCode === 403
          ? `Session rejected (${res.statusCode}). Re-detect your cookies.`
          : `Live search refused the connection (${res.statusCode}).`
      this.setStatus(conn, "error", reason)
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.emit({ type: "session", valid: false, message: reason })
      }
    })

    ws.on("close", (code) => {
      this.clearTimers(conn)
      conn.ws = null
      if (conn.stopping) return
      this.setStatus(conn, "disconnected", describeClose(code))
      this.scheduleReconnect(conn, code)
    })
  }

  private clearTimers(conn: Connection): void {
    if (conn.stableTimer) {
      clearTimeout(conn.stableTimer)
      conn.stableTimer = null
    }
    if (conn.pingTimer) {
      clearInterval(conn.pingTimer)
      conn.pingTimer = null
    }
  }

  private scheduleReconnect(conn: Connection, code?: number): void {
    if (conn.stopping) return

    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** conn.attempts, BACKOFF_MAX_MS)
    // 1013 (try again later) and 1008 (policy violation) are GGG telling us to
    // stop. Honour that with a real pause rather than the usual ramp - retrying
    // fast is itself a likely cause of a policy close.
    const throttled = code === 1013 || code === 1008
    const delay = throttled ? Math.max(backoff, THROTTLED_MIN_MS) : backoff

    // Give up after enough refusals rather than looping forever. The session is
    // known good once we've seen auth:true, so this is a rate/policy wall the
    // user must wait out.
    if (throttled && conn.attempts >= 4) {
      conn.stopping = true
      this.setStatus(
        conn,
        "error",
        "Live search keeps getting rejected (1008/1013). This IP is likely rate-limited from too many recent connections - wait a few minutes, then resume. Avoid using the official trade site on this account at the same time.",
      )
      this.log("error", `${conn.search.title}: giving up after repeated policy closes.`)
      return
    }

    conn.attempts += 1
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer)
    conn.reconnectTimer = setTimeout(() => {
      void this.connect(conn)
    }, delay)

    this.log(
      throttled ? "error" : "warn",
      throttled
        ? `${conn.search.title}: server asked us to back off (${code}). Waiting ${Math.round(delay / 1000)}s.`
        : `${conn.search.title}: reconnecting in ${Math.round(delay / 1000)}s.`,
    )
  }

  // ---- incoming ids -> listings ----

  private async onMessage(conn: Connection, raw: string): Promise<void> {
    let msg: { new?: string[]; result?: unknown; count?: unknown; auth?: unknown; error?: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      // A non-JSON frame is itself a clue about why a close follows.
      this.log("warn", `${conn.search.title}: unexpected frame ${raw.slice(0, 120)}`)
      return
    }

    // The server announces auth state on connect. Surfacing it turns a mystery
    // 1008 into "the session was rejected" or confirms the session is fine and
    // the close is about something else.
    if (typeof msg.auth === "boolean") {
      this.log(
        msg.auth ? "info" : "error",
        msg.auth
          ? `${conn.search.title}: server accepted the session.`
          : `${conn.search.title}: server did NOT accept the session (auth:false). The POESESSID is invalid or expired.`,
      )
      if (!msg.auth) {
        this.emit({ type: "session", valid: false, message: "Live search rejected the session (auth:false)." })
      }
    }

    if (msg.error) {
      this.setStatus(conn, "error", String(msg.error))
      return
    }

    // GGG's current protocol pushes one result token per message,
    // {"result":"<jwt>","count":N}. The whole token is passed to /fetch to get
    // the listing. Older builds sent {"new":["id",...]}; support both. A token
    // is either kind - /fetch accepts a plain id or a result JWT alike.
    const tokens: string[] = []
    if (typeof msg.result === "string") tokens.push(msg.result)
    else if (Array.isArray(msg.new)) tokens.push(...msg.new.filter((x) => typeof x === "string"))
    if (tokens.length === 0) return

    // Global travel lock: while any travel is in its cooldown, every search
    // drops incoming tokens. Zero API calls, and it stops a busy search flooding
    // travels or interrupting a purchase in progress.
    if (Date.now() < this.travelPausedUntil) return

    // Only the newest token matters - the goal is the shortest path to the most
    // recent listing, and stale ones are likely already sold.
    const newest = tokens[tokens.length - 1]
    conn.pending = [newest]
    if (conn.flushTimer) return
    conn.flushTimer = setTimeout(() => {
      conn.flushTimer = null
      void this.flush(conn)
    }, FETCH_DEBOUNCE_MS)
  }

  private async flush(conn: Connection): Promise<void> {
    if (conn.fetching || conn.pending.length === 0) return
    conn.fetching = true
    try {
      const session = await getSession()
      if (!session) return

      while (conn.pending.length > 0) {
        const batch = conn.pending.splice(0, FETCH_BATCH)
        try {
          const listings = await fetchListings(
            session,
            batch,
            conn.search.searchId,
            conn.search.id,
            conn.search.title,
            conn.search.league,
          )
          for (const listing of listings) await this.onListing(conn, listing, session)
        } catch (err) {
          if (err instanceof RateLimitError) {
            // Put them back and wait out the window.
            conn.pending.unshift(...batch)
            this.log("warn", `Rate limited; retrying in ${Math.round(err.retryAfterMs / 1000)}s.`)
            await sleep(err.retryAfterMs)
            continue
          }
          if (err instanceof SessionError || err instanceof CloudflareError) {
            this.emit({ type: "session", valid: false, message: err.message })
            this.setStatus(conn, "error", err.message)
            return
          }
          this.log("error", `Fetch failed: ${(err as Error).message}`)
        }
      }
    } finally {
      conn.fetching = false
    }
  }

  private async onListing(conn: Connection, listing: Listing, session: Session): Promise<void> {
    const settings = await getSettings()

    // Instant-buyout only: drop listings without a Travel-to-Hideout token
    // (mixed / negotiable-price whispers), if the user asked for it.
    if (settings.instantBuyoutOnly && !listing.instantBuyout) {
      this.log("info", `Skipped (not instant buyout): ${listing.itemName || listing.itemType}`)
      return
    }

    this.cache(listing, conn.search)
    this.emit({ type: "listing", listing })

    if (!settings.autoTravelEnabled || !conn.search.autoTravel) return
    if (!listing.whisperToken) return
    if (Date.now() < this.travelPausedUntil) return

    // Arm the GLOBAL cooldown before the whisper: every search pauses, so a
    // match elsewhere can't travel the user away mid-purchase, and a burst in
    // flight can't queue a second travel.
    const cooldown = clampCooldown(settings.autoTravelCooldownMs)
    this.travelPausedUntil = Date.now() + cooldown
    for (const c of this.connections.values()) c.pending = []
    this.emit({ type: "cooldown", until: this.travelPausedUntil })
    this.log("info", `Travelling to ${listing.itemName || listing.itemType} - all searches paused ${Math.round(cooldown / 1000)}s.`)

    // The token was just issued, so it is fresh - whisper immediately.
    this.emit({ type: "whisper", listingId: listing.id, state: "sending" })
    try {
      await sendWhisper(session, listing.whisperToken, conn.search.league, conn.search.searchId)
      listing.whisperState = "sent"
      listing.autoTravelled = true
      this.emit({ type: "whisper", listingId: listing.id, state: "sent" })
      this.log("info", `Auto-travelled: ${listing.itemName || listing.itemType}`)
    } catch (err) {
      listing.whisperState = "error"
      this.emit({
        type: "whisper",
        listingId: listing.id,
        state: "error",
        message: (err as Error).message,
      })
    }
  }

  /** Only the current listing is kept: this app shows one travel target at a time. */
  private cache(listing: Listing, search: WatchedSearch): void {
    for (const oldId of this.listings.keys()) {
      if (oldId !== listing.id) this.emit({ type: "expire", listingId: oldId })
    }
    this.listings.clear()
    this.listings.set(listing.id, { listing, search })
  }

  // ---- manual travel ----

  /**
   * Manual "Travel to Hideout". Whisper tokens expire 300s after issue, so this
   * always re-fetches the listing for a fresh token before sending.
   */
  async travelTo(listingId: string): Promise<{ ok: boolean; message?: string }> {
    const cached = this.listings.get(listingId)
    if (!cached) return { ok: false, message: "Listing is no longer in the feed." }

    const session = await getSession()
    if (!session) return { ok: false, message: "No session configured." }

    const { search } = cached
    this.emit({ type: "whisper", listingId, state: "sending" })

    try {
      const fresh = await refetchListing(
        session,
        listingId,
        search.searchId,
        search.id,
        search.title,
        search.league,
      )
      if (!fresh?.whisperToken) {
        cached.listing.whisperState = "expired"
        this.emit({
          type: "whisper",
          listingId,
          state: "expired",
          message: "Listing is gone or no longer offers a travel token.",
        })
        return { ok: false, message: "Listing is gone." }
      }

      await sendWhisper(session, fresh.whisperToken, search.league, search.searchId)

      cached.listing.whisperToken = fresh.whisperToken
      cached.listing.tokenExpMs = fresh.tokenExpMs
      cached.listing.whisperState = "sent"
      this.emit({ type: "whisper", listingId, state: "sent" })

      // A manual travel also arms the global cooldown, so auto-travel can't yank
      // the user away while they finish this purchase.
      const { autoTravelCooldownMs } = await getSettings()
      this.travelPausedUntil = Date.now() + clampCooldown(autoTravelCooldownMs)
      for (const c of this.connections.values()) c.pending = []
      this.emit({ type: "cooldown", until: this.travelPausedUntil })
      return { ok: true }
    } catch (err) {
      const message = (err as Error).message
      cached.listing.whisperState = "error"
      if (err instanceof SessionError || err instanceof CloudflareError) {
        this.emit({ type: "session", valid: false, message })
      }
      this.emit({ type: "whisper", listingId, state: "error", message })
      return { ok: false, message }
    }
  }
}

/**
 * Cookies for the live socket, matching what the trade site itself sends on its
 * live-search WebSocket: cf_clearance (required - Cloudflare proxies the socket)
 * plus POESESSID and POETOKEN. cf_clearance is bound to the exact User-Agent it
 * was issued against, so it is always sent together with that same agent.
 */
function liveCookieHeader(session: Session): string {
  const parts: string[] = []
  if (session.poesessid) parts.push(`POESESSID=${session.poesessid}`)
  if (session.poetoken) parts.push(`POETOKEN=${session.poetoken}`)
  if (session.cfClearance) parts.push(`cf_clearance=${session.cfClearance}`)
  return parts.join("; ")
}

const FALLBACK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

function clampCooldown(ms: number): number {
  return Math.min(AUTO_TRAVEL_COOLDOWN_MAX_MS, Math.max(AUTO_TRAVEL_COOLDOWN_MIN_MS, ms))
}

function describeClose(code: number): string | undefined {
  switch (code) {
    case 1013:
      // Observed in practice when POESESSID has rotated: the REST API still
      // accepts the old cookie but the live socket does not, and GGG reports it
      // as "try again later" rather than an auth error.
      return "Server said try again later (1013). Usually a stale POESESSID - re-detect your cookies."
    case 1008:
      // The session authenticates (auth:true) and is then policy-closed: rate
      // limiting from too many recent connections is the usual cause.
      return "Server closed with a policy violation (1008). Usually rate limiting from too many recent live-search connections."
    case 1006:
      return "Connection dropped abnormally (1006)."
    default:
      return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Survive dev-mode hot reloads.
const globalRef = globalThis as unknown as { __poeEngine?: LiveEngine }

export const engine: LiveEngine = globalRef.__poeEngine ?? new LiveEngine()
if (!globalRef.__poeEngine) globalRef.__poeEngine = engine

export type { LiveEngine }
