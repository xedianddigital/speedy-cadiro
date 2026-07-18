"use client"

// Holds the client's view of the engine: one EventSource carries the snapshot,
// every new listing, per-search status and log lines. The browser reconnects an
// EventSource on its own, and the server replies with a fresh snapshot, so a
// dropped stream self-heals without a page refresh.

import { useCallback, useEffect, useRef, useState } from "react"
import type { Listing, SearchStatus, ServerEvent, WhisperState } from "@/lib/poe/types"

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
  /** searchInternalId -> unix ms when its auto-travel cooldown ends. */
  cooldowns: Record<string, number>
  logs: LogLine[]
  connected: boolean
  sessionValid: boolean | null
  sessionMessage: string | null
  setWhisperState: (listingId: string, state: WhisperState) => void
}

export function useLiveFeed(soundEnabled: boolean): LiveFeed {
  const [listings, setListings] = useState<Listing[]>([])
  const [statuses, setStatuses] = useState<Record<string, SearchStatus>>({})
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({})
  const [logs, setLogs] = useState<LogLine[]>([])
  const [connected, setConnected] = useState(false)
  const [sessionValid, setSessionValid] = useState<boolean | null>(null)
  const [sessionMessage, setSessionMessage] = useState<string | null>(null)

  const logId = useRef(0)
  // Read inside the handler without resubscribing when the toggle changes.
  const soundRef = useRef(soundEnabled)
  soundRef.current = soundEnabled

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
          break

        case "listing":
          // Newest first; the server caps how many survive.
          setListings((prev) => {
            if (prev.some((l) => l.id === event.listing.id)) return prev
            return [event.listing, ...prev]
          })
          if (soundRef.current) beep()
          break

        case "expire":
          setListings((prev) => prev.filter((l) => l.id !== event.listingId))
          break

        case "cooldown":
          setCooldowns((prev) => ({ ...prev, [event.searchInternalId]: event.until }))
          break

        case "status":
          setStatuses((prev) => ({ ...prev, [event.searchInternalId]: event.status }))
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
    cooldowns,
    logs,
    connected,
    sessionValid,
    sessionMessage,
    setWhisperState,
  }
}

/** Short notification tone. WebAudio avoids shipping an audio asset. */
function beep(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = "sine"
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.26)
    osc.onended = () => void ctx.close()
  } catch {
    // Autoplay policy blocked it, or no audio device. Not worth surfacing.
  }
}
