// Shared types for the PoE lean trade notifier.

export interface Session {
  poesessid: string
  poetoken: string
  cfClearance: string
  userAgent: string
  updatedAt: number
}

export type SearchStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"

export interface WatchedSearch {
  /** Internal id used by this app (not the PoE search id). */
  id: string
  /** Full URL the user pasted. */
  url: string
  /** League segment parsed from the URL, e.g. "Mirage". */
  league: string
  /** PoE trade search id parsed from the URL. */
  searchId: string
  /** Human label (defaults to league + short id). */
  title: string
  /** Whether the live search WebSocket should be running. */
  active: boolean
  /** Per-search opt-in: instantly fire Travel to Hideout on first match. */
  autoTravel: boolean
}

export interface Settings {
  /**
   * The travel interval / listing lifecycle: after travelling to a listing, wait
   * this long before fetching and travelling to the next one. This is the whole
   * rhythm of the app - one hideout every interval, market permitting. Also how
   * long the current listing stays on screen. Clamped to TRAVEL_INTERVAL_MIN/MAX.
   */
  autoTravelCooldownMs: number
  /** Play a sound when a new listing arrives. */
  soundEnabled: boolean
  /** Which notification sound to play. One of SOUND_NAMES. */
  soundName: string
}

/** Selectable notification sounds (synthesised in the browser, no assets). */
export const SOUND_NAMES = ["chime", "ping", "coin", "alert"] as const

export type WhisperState = "idle" | "sending" | "sent" | "error" | "expired"

export interface Listing {
  /** PoE listing id (result id from /fetch). */
  id: string
  /** Internal id of the search that surfaced this listing. */
  searchInternalId: string
  searchTitle: string
  itemName: string
  itemType: string
  priceAmount: number | null
  priceCurrency: string | null
  sellerAccount: string | null
  sellerCharacter: string | null
  listedAgo: string | null
  mods: string[]
  corrupted: boolean
  /** True when the whisper token is a Travel-to-Hideout (instant buyout) token. */
  instantBuyout: boolean
  /** Token used for POST /api/trade/whisper (Travel to Hideout). */
  whisperToken: string | null
  /** Unix ms when the whisper token expires (parsed from the JWT). */
  tokenExpMs: number | null
  receivedAt: number
  whisperState: WhisperState
  autoTravelled: boolean
  note?: string
}

export interface AppConfig {
  session: Session | null
  searches: WatchedSearch[]
  settings: Settings
}

export const DEFAULT_SETTINGS: Settings = {
  autoTravelCooldownMs: 20_000,
  soundEnabled: true,
  soundName: "chime",
}

/** Travel interval bounds offered in the UI. */
export const AUTO_TRAVEL_COOLDOWN_MIN_MS = 10_000
export const AUTO_TRAVEL_COOLDOWN_MAX_MS = 90_000

/**
 * Each watched search is a separate WebSocket to GGG. Running many at once is
 * the clearest bot signal there is, so refuse past this many active at a time.
 */
export const MAX_ACTIVE_SEARCHES = 5

// ---- SSE event payloads ----

export type ServerEvent =
  /** Sent once when a client attaches, so it can rehydrate without a refresh. */
  | { type: "snapshot"; listings: Listing[]; statuses: Record<string, SearchStatus> }
  | { type: "listing"; listing: Listing }
  /** The current listing aged out or was replaced. */
  | { type: "expire"; listingId: string }
  /**
   * A travel happened; ALL searches are paused until `until` (unix ms) so the
   * user isn't yanked to another hideout while finalising a purchase.
   */
  | { type: "cooldown"; until: number }
  | { type: "status"; searchInternalId: string; status: SearchStatus; error?: string }
  | { type: "session"; valid: boolean; message?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "whisper"; listingId: string; state: WhisperState; message?: string }
