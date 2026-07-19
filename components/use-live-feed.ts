"use client"

// Holds the client's view of the engine: one EventSource carries the snapshot,
// every new listing, per-search status and log lines. The browser reconnects an
// EventSource on its own, and the server replies with a fresh snapshot, so a
// dropped stream self-heals without a page refresh.

import { useCallback, useEffect, useRef, useState } from "react"
import type { Listing, SearchStatus, ServerEvent, WhisperState } from "@/lib/poe/types"
import { playSound } from "@/components/sounds"

// The server owns the buffer: it evicts on size and expires on TTL, and tells
// us via `expire`. The client just mirrors that.

export interface LogLine {
  id: number
  level: "info" | "warn" | "error"
  message: string
  at: number
}

export interface LiveFeed {
  listings: Listing[]
  statuses: Record<string, SearchStatus>
  /** Last error reported per search, so the UI can explain a red or grey dot. */
  statusErrors: Record<string, string>
  /** Unix ms when the global travel cooldown ends (all searches paused until then). */
  cooldownUntil: number | null
  logs: LogLine[]
  connected: boolean
  sessionValid: boolean | null
  sessionMessage: string | null
  setWhisperState: (listingId: string, state: WhisperState) => void
}

export function useLiveFeed(soundEnabled: boolean, soundName: string): LiveFeed {
  const [listings, setListings] = useState<Listing[]>([])
  const [statuses, setStatuses] = useState<Record<string, SearchStatus>>({})
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({})
  const [logs, setLogs] = useState<LogLine[]>([])
  const [connected, setConnected] = useState(false)
  const [sessionValid, setSessionValid] = useState<boolean | null>(null)
  const [sessionMessage, setSessionMessage] = useState<string | null>(null)

  const logId = useRef(0)
  // Read inside the handler without resubscribing when settings change.
  const soundRef = useRef({ enabled: soundEnabled, name: soundName })
  soundRef.current = { enabled: soundEnabled, name: soundName }

  // Two watched searches can both match the same PoE listing at once, so the
  // server can legitimately emit two "listing" events with the same id. The
  // state update below already no-ops on a duplicate id, but without this the
  // sound cue fired every time regardless - so it played twice for one match.
  const knownIdsRef = useRef<Set<string>>(new Set())

  const setWhisperState = useCallback((listingId: string, state: WhisperState) => {
    setListings((prev) =>
      prev.map((l) => (l.id === listingId ? { ...l, whisperState: state } : l)),
    )
  }, [])

  useEffect(() => {
    const source = new EventSource("/api/events")

    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)

    source.onmessage = (raw) => {
      let event: ServerEvent
      try {
        event = JSON.parse(raw.data)
      } catch {
        return
      }

      switch (event.type) {
        case "snapshot":
          setListings(event.listings)
          setStatuses(event.statuses)
          knownIdsRef.current = new Set(event.listings.map((l) => l.id))
          break

        case "listing":
          // A duplicate id (two searches matching the same item) must not
          // replay the sound or re-insert the card.
          if (knownIdsRef.current.has(event.listing.id)) break
          knownIdsRef.current.add(event.listing.id)
          // Newest first; the server caps how many survive.
          setListings((prev) => [event.listing, ...prev])
          if (soundRef.current.enabled) playSound(soundRef.current.name)
          break

        case "expire":
          knownIdsRef.current.delete(event.listingId)
          setListings((prev) => prev.filter((l) => l.id !== event.listingId))
          break

        case "cooldown":
          setCooldownUntil(event.until)
          break

        case "status":
          setStatuses((prev) => ({ ...prev, [event.searchInternalId]: event.status }))
          setStatusErrors((prev) => {
            const next = { ...prev }
            if (event.error) next[event.searchInternalId] = event.error
            // A healthy connection clears whatever went wrong before it.
            else if (event.status === "connected") delete next[event.searchInternalId]
            return next
          })
          break

        case "whisper":
          setListings((prev) =>
            prev.map((l) => (l.id === event.listingId ? { ...l, whisperState: event.state } : l)),
          )
          if (event.message) {
            pushLog(event.state === "error" ? "error" : "info", event.message)
          }
          break

        case "session":
          setSessionValid(event.valid)
          setSessionMessage(event.message ?? null)
          break

        case "log":
          pushLog(event.level, event.message)
          break
      }
    }

    function pushLog(level: LogLine["level"], message: string) {
      logId.current += 1
      const line = { id: logId.current, level, message, at: Date.now() }
      setLogs((prev) => [line, ...prev].slice(0, 50))
    }

    return () => source.close()
  }, [])

  return {
    listings,
    statuses,
    statusErrors,
    cooldownUntil,
    logs,
    connected,
    sessionValid,
    sessionMessage,
    setWhisperState,
  }
}
