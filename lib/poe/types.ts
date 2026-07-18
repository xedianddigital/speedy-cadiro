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
  /** Global master switch for auto-travel. When false, no search auto-travels. */
  autoTravelEnabled: boolean
  /**
   * After an auto-travel, stop processing new listings for this long. Prevents
   * being yanked between hideouts once per second on a busy search, and keeps
   * our request rate low. Clamped to AUTO_TRAVEL_COOLDOWN_MIN/MAX_MS.
   */
  autoTravelCooldownMs: number
  /** Play a sound when a new listing arrives. */
  soundEnabled: boolean
  /** How many listings the manual feed holds before evicting the oldest. */
  bufferSize: number
  /** How long a listing stays in the manual feed before expiring. */
  listingTtlMs: number
}

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
  autoTravelEnabled: false,
  autoTravelCooldownMs: 15_000,
  soundEnabled: true,
  bufferSize: 10,
  listingTtlMs: 180_000,
}

/** Cooldown bounds offered in the UI. */
export const AUTO_TRAVEL_COOLDOWN_MIN_MS = 5_000
export const AUTO_TRAVEL_COOLDOWN_MAX_MS = 30_000

/** Buffer bounds for the manual feed. */
export const BUFFER_SIZE_MIN = 1
export const BUFFER_SIZE_MAX = 50

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
  /** A listing aged out of the manual feed, or was evicted when it filled up. */
  | { type: "expire"; listingId: string }
  /** Auto-travel cooldown: scanning is suspended until `until` (unix ms). */
  | { type: "cooldown"; searchInternalId: string; until: number }
  | { type: "status"; searchInternalId: string; status: SearchStatus; error?: string }
  | { type: "session"; valid: boolean; message?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "whisper"; listingId: string; state: WhisperState; message?: string }
