// The live-search engine. Holds one WebSocket per active watched search against
// pathofexile.com's official live-search endpoint, turns the ids it pushes into
// full listings via /api/trade/fetch, and broadcasts everything to connected UI
// clients over SSE.
//
// This is a long-lived singleton stashed on globalThis so Next's dev-mode module
// reloading doesn't leave orphaned sockets behind.

import { EventEmitter } from "node:events"
import WebSocket from "ws"
import type { Listing, SearchStatus, ServerEvent, Session, WatchedSearch } from "./types"
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
const FETCH_BATCH = 10
/** Wait briefly so a burst of ids becomes one batched fetch. */
const FETCH_DEBOUNCE_MS = 120

/** How many recent listings to keep for the UI and for whisper re-fetching. */
const LISTING_CACHE_MAX = 500

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
  private lastAutoTravelAt = new Map<string, number>()

  constructor() {
    // SSE clients come and go; don't warn when several attach at once.
    this.events.setMaxListeners(0)
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
        headers: {
          Cookie: cookieHeader(session),
          "User-Agent": session.userAgent || "poe-lean-notifier/1.0",
          Origin: "https://www.pathofexile.com",
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
    // stop. Honour that with a real pause rather than the usual ramp.
    const throttled = code === 1013 || code === 1008
    const delay = throttled ? Math.max(backoff, THROTTLED_MIN_MS) : backoff

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
    let msg: { new?: string[]; auth?: unknown; error?: unknown }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.error) {
      this.setStatus(conn, "error", String(msg.error))
      return
    }
    if (!Array.isArray(msg.new) || msg.new.length === 0) return

    for (const id of msg.new) {
      if (!this.listings.has(id) && !conn.pending.includes(id)) conn.pending.push(id)
    }
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
    this.cache(listing, conn.search)
    this.emit({ type: "listing", listing })

    const settings = await getSettings()
    if (!settings.autoTravelEnabled || !conn.search.autoTravel) return
    if (!listing.whisperToken) return

    const last = this.lastAutoTravelAt.get(conn.search.id) ?? 0
    if (Date.now() - last < settings.autoTravelCooldownMs) {
      this.log("info", `Auto-travel skipped (cooldown): ${listing.itemName || listing.itemType}`)
      return
    }
    this.lastAutoTravelAt.set(conn.search.id, Date.now())

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

  private cache(listing: Listing, search: WatchedSearch): void {
    this.listings.set(listing.id, { listing, search })
    if (this.listings.size > LISTING_CACHE_MAX) {
      // Map preserves insertion order, so the oldest key is first.
      const oldest = this.listings.keys().next().value
      if (oldest) this.listings.delete(oldest)
    }
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

function cookieHeader(session: Session): string {
  const parts = [`POESESSID=${session.poesessid}`]
  if (session.poetoken) parts.push(`POETOKEN=${session.poetoken}`)
  if (session.cfClearance) parts.push(`cf_clearance=${session.cfClearance}`)
  return parts.join("; ")
}

function describeClose(code: number): string | undefined {
  switch (code) {
    case 1013:
      // Observed in practice when POESESSID has rotated: the REST API still
      // accepts the old cookie but the live socket does not, and GGG reports it
      // as "try again later" rather than an auth error.
      return "Server said try again later (1013). Usually a stale POESESSID - re-detect your cookies."
    case 1008:
      return "Server rejected the connection (1008 policy violation)."
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
