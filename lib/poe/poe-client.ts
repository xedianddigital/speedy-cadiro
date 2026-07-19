// Thin authenticated client for pathofexile.com. Acts as "you": sends the three
// cookies (POESESSID, POETOKEN, cf_clearance) plus the matching browser
// User-Agent that Cloudflare's cf_clearance is bound to. Nothing here automates
// gameplay - it only reads listings and posts the same whisper the official
// "Travel to Hideout" button sends.

import type { Listing, Session } from "./types"
import { decodeWhisperToken, tokenExpiryMs } from "./jwt"
import { rateLimiter } from "./rate-limit"

const BASE = "https://www.pathofexile.com"

export class SessionError extends Error {}
export class CloudflareError extends Error {}
export class RateLimitError extends Error {
  constructor(
    message: string,
    public retryAfterMs: number,
  ) {
    super(message)
  }
}

function cookieHeader(session: Session): string {
  const parts = [`POESESSID=${session.poesessid}`]
  if (session.poetoken) parts.push(`POETOKEN=${session.poetoken}`)
  if (session.cfClearance) parts.push(`cf_clearance=${session.cfClearance}`)
  return parts.join("; ")
}

function baseHeaders(session: Session, referer?: string): Record<string, string> {
  return {
    "User-Agent": session.userAgent || "poe-lean-notifier/1.0",
    Cookie: cookieHeader(session),
    Accept: "application/json",
    Origin: BASE,
    Referer: referer ?? `${BASE}/trade`,
    "X-Requested-With": "XMLHttpRequest",
  }
}

function detectAuthFailure(status: number, body: string): void {
  if (status === 401) throw new SessionError("POESESSID expired or invalid (401).")
  if (status === 403) {
    // Cloudflare challenges usually return HTML, not JSON.
    if (/cloudflare|cf-|just a moment|challenge/i.test(body) && !body.trim().startsWith("{")) {
      throw new CloudflareError("Cloudflare blocked the request (403). Re-detect cf_clearance + User-Agent.")
    }
    throw new SessionError("Forbidden (403) - session likely expired.")
  }
}

/**
 * Every call to pathofexile.com goes through here: paced by the shared limiter
 * and fed back into it so the published budget drives the next call's timing.
 */
async function paced(url: string, init: RequestInit): Promise<Response> {
  return rateLimiter.schedule(async () => {
    const res = await fetch(url, init)
    rateLimiter.observe(res)
    return res
  })
}

function retryAfterMs(res: Response): number {
  // PoE returns X-Rate-Limit-* headers; fall back to Retry-After seconds.
  const retryAfter = res.headers.get("Retry-After")
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (!Number.isNaN(secs)) return Math.max(1000, secs * 1000)
  }
  return 5000
}

/**
 * Validate that the session is genuinely logged in.
 *
 * /api/trade/data/leagues is public - it returns JSON even for a bogus or guest
 * session, so it reports every session as valid and is useless here. /my-account
 * instead redirects to /login unless you are actually authenticated, so a 200
 * means a real logged-in account and a redirect means the session is guest or
 * expired. This is what makes "connected" mean the live socket will accept it.
 */
export async function validateSession(session: Session): Promise<{ ok: boolean; account?: string; reason?: string }> {
  try {
    const res = await paced(`${BASE}/my-account`, {
      headers: { ...baseHeaders(session, `${BASE}/`), Accept: "text/html" },
      redirect: "manual",
      cache: "no-store",
    })

    // redirect:"manual" surfaces the 3xx itself; an opaqueredirect shows as 0.
    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      return { ok: false, reason: "Not logged in - the session is a guest or has expired." }
    }
    if (res.status === 401) return { ok: false, reason: "Session expired." }
    if (res.status === 403) {
      return { ok: false, reason: "Cloudflare blocked the request - the User-Agent likely doesn't match the cookies." }
    }
    if (!res.ok) return { ok: false, reason: `Unexpected status ${res.status}.` }

    const html = await res.text()
    // A 200 that is actually the login form (some setups render it inline) still
    // means not-logged-in. A real account page has a logout control.
    if (/name=["']login["']|id=["']login["']|type=["']password["']/i.test(html) && !/logout/i.test(html)) {
      return { ok: false, reason: "Not logged in - reached the login page." }
    }
    const account = html.match(/\/account\/view-profile\/([^"'/?]+)/i)?.[1]
    return { ok: true, account: account ? decodeURIComponent(account) : undefined }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

interface RawResult {
  id: string
  listing?: {
    indexed?: string
    whisper?: string
    whisper_token?: string
    hideout_token?: string
    account?: { name?: string; lastCharacterName?: string; online?: unknown }
    price?: { type?: string; amount?: number; currency?: string }
  }
  item?: {
    name?: string
    typeLine?: string
    baseType?: string
    corrupted?: boolean
    // Typed as string[] because that's what GGG's docs promise, but a few
    // item kinds (seen on cluster jewels and some enchants) send structured
    // objects instead - stringifyMod() below is what actually enforces this.
    explicitMods?: unknown[]
    implicitMods?: unknown[]
    craftedMods?: unknown[]
    enchantMods?: unknown[]
  }
}

/**
 * Coerce one mod entry to displayable text. Almost always already a plain
 * string; the fallback exists because a few item kinds (cluster jewels, some
 * enchants) have been observed sending a structured object here instead, and
 * rendering that directly used to crash the listing card (`[object Object]`
 * is what `String()` alone gives you - not much better, so try the shapes
 * GGG actually uses for mod text first).
 */
function stringifyMod(mod: unknown): string {
  if (typeof mod === "string") return mod
  if (mod && typeof mod === "object") {
    const obj = mod as Record<string, unknown>
    for (const key of ["description", "text", "name", "mod", "value"]) {
      if (typeof obj[key] === "string") return obj[key] as string
    }
    try {
      return JSON.stringify(obj)
    } catch {
      return "(unreadable mod)"
    }
  }
  return String(mod)
}

function relativeTime(iso?: string): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const diff = Date.now() - then
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function normalize(raw: RawResult, searchInternalId: string, searchTitle: string): Listing {
  const listing = raw.listing ?? {}
  const item = raw.item ?? {}
  const token = listing.whisper_token ?? listing.hideout_token ?? null
  // Instant buyout is identified by the token type: the Travel-to-Hideout token
  // carries tok:"hideout" (confirmed from the trade site's own whisper request).
  const instantBuyout = decodeWhisperToken(token)?.tok === "hideout"
  const mods = [
    ...(item.enchantMods ?? []),
    ...(item.implicitMods ?? []),
    ...(item.explicitMods ?? []),
    ...(item.craftedMods ?? []),
  ].map(stringifyMod)
  return {
    id: raw.id,
    searchInternalId,
    searchTitle,
    itemName: item.name || "",
    itemType: item.typeLine || item.baseType || "",
    priceAmount: listing.price?.amount ?? null,
    priceCurrency: listing.price?.currency ?? null,
    sellerAccount: listing.account?.name ?? null,
    sellerCharacter: listing.account?.lastCharacterName ?? null,
    listedAgo: relativeTime(listing.indexed),
    mods,
    corrupted: Boolean(item.corrupted),
    instantBuyout,
    whisperToken: token,
    tokenExpMs: tokenExpiryMs(token),
    receivedAt: Date.now(),
    whisperState: "idle",
    autoTravelled: false,
  }
}

/**
 * Fetch full listing details for up to 10 result ids.
 * `searchId` is the PoE trade search id (used as the `query` param).
 */
export async function fetchListings(
  session: Session,
  ids: string[],
  searchId: string,
  searchInternalId: string,
  searchTitle: string,
  league: string,
): Promise<Listing[]> {
  if (ids.length === 0) return []
  const batch = ids.slice(0, 10)
  const referer = `${BASE}/trade/search/${encodeURIComponent(league)}/${searchId}`
  const url = `${BASE}/api/trade/fetch/${batch.join(",")}?query=${searchId}&realm=pc`

  // Fetch immediately, NOT through the paced queue. A live-search result token
  // expires ~10s after it is issued, so any queued delay makes it expire and
  // return 400. Still feed the response headers back to the limiter so the rest
  // of the app's pacing stays accurate.
  const res = await fetch(url, { headers: baseHeaders(session, referer), cache: "no-store" })
  rateLimiter.observe(res)
  const text = await res.text()

  if (res.status === 429) {
    const wait = retryAfterMs(res)
    rateLimiter.penalise(wait)
    throw new RateLimitError("Rate limited by trade fetch.", wait)
  }
  // 400 means the result token expired before we fetched it - the listing moved
  // too fast. That's normal on a hot search, not an error; return nothing.
  if (res.status === 400) return []
  detectAuthFailure(res.status, text)
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`)

  let data: { result?: (RawResult | null)[] }
  try {
    data = JSON.parse(text)
  } catch {
    throw new CloudflareError("Non-JSON response from /fetch (possible Cloudflare challenge).")
  }
  const results = (data.result ?? []).filter(Boolean) as RawResult[]
  return results.map((r) => normalize(r, searchInternalId, searchTitle))
}

/**
 * Fetch a single listing by id to obtain a FRESH whisper token (tokens expire
 * ~5 min after they are issued). Returns null if the listing is gone.
 */
export async function refetchListing(
  session: Session,
  id: string,
  searchId: string,
  searchInternalId: string,
  searchTitle: string,
  league: string,
): Promise<Listing | null> {
  const listings = await fetchListings(session, [id], searchId, searchInternalId, searchTitle, league)
  return listings[0] ?? null
}

/**
 * Send the direct whisper / Travel-to-Hideout request. This is exactly what the
 * official trade site's button does: POST /api/trade/whisper with { token }.
 */
export async function sendWhisper(
  session: Session,
  token: string,
  league?: string,
  searchId?: string,
): Promise<void> {
  const referer =
    league && searchId
      ? `${BASE}/trade/search/${encodeURIComponent(league)}/${searchId}`
      : `${BASE}/trade`
  const res = await paced(`${BASE}/api/trade/whisper`, {
    method: "POST",
    headers: {
      ...baseHeaders(session, referer),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
    cache: "no-store",
  })
  const text = await res.text()

  if (res.status === 429) {
    const wait = retryAfterMs(res)
    rateLimiter.penalise(wait)
    throw new RateLimitError("Rate limited on whisper.", wait)
  }
  detectAuthFailure(res.status, text)
  if (!res.ok) {
    // Common: 404/400 when the token has expired.
    throw new Error(`whisper failed: ${res.status} ${text.slice(0, 200)}`)
  }
}

export { BASE as POE_BASE }
