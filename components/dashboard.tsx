"use client"

import { useCallback, useEffect, useState } from "react"
import { SessionPanel } from "@/components/session-panel"
import { SearchPanel } from "@/components/search-panel"
import { CurrentListing } from "@/components/current-listing"
import { CooldownBar } from "@/components/cooldown-bar"
import { OptionsModal } from "@/components/options-modal"
import { ErrorBoundary } from "@/components/error-boundary"
import { useLiveFeed } from "@/components/use-live-feed"
import {
  AUTO_TRAVEL_COOLDOWN_MAX_MS,
  AUTO_TRAVEL_COOLDOWN_MIN_MS,
  DEFAULT_SETTINGS,
  type Settings,
} from "@/lib/poe/types"

export function Dashboard() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  /** null while we're still asking the server. */
  const [sessionReady, setSessionReady] = useState<boolean | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [update, setUpdate] = useState<{ latest: string; url: string } | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)

  useEffect(() => {
    void window.poeDesktop?.version().then(setVersion)
    // Open Options from the native File -> Options menu.
    return window.poeDesktop?.onOpenOptions(() => setOptionsOpen(true))
  }, [])

  useEffect(() => {
    void window.poeDesktop
      ?.checkForUpdate()
      .then((result) => {
        if (result.available) setUpdate({ latest: result.latest, url: result.url })
      })
      .catch(() => {
        // Offline or GitHub unreachable - just skip the notice.
      })
  }, [])

  const feed = useLiveFeed(settings.soundEnabled, settings.soundName)
  const current = feed.listings[0] ?? null

  // Only worth mentioning once the connection has actually dropped after
  // being up - showing it during the very first, near-instant connect on
  // launch would just be a flash of noise.
  const [everConnected, setEverConnected] = useState(false)
  useEffect(() => {
    if (feed.connected) setEverConnected(true)
  }, [feed.connected])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" })
        setSettings(await res.json())
      } catch {
        // Keep defaults.
      }
    })()
  }, [])

  const patchSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch })) // optimistic
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
      const data = await res.json()
      if (data.settings) setSettings(data.settings)
    } catch {
      // The optimistic value stands; next load reconciles.
    }
  }, [])

  const intervalSec = Math.round(settings.autoTravelCooldownMs / 1000)

  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">
            SpeedyCadiro
            {version && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">v{version}</span>
            )}
          </h1>
          <p className="text-xs text-muted-foreground">Auto-travel to matching listings.</p>
        </div>
        <div className="flex items-center gap-3">
          <SessionPanel onSessionChange={setSessionReady} />
        </div>
      </header>

      {everConnected && !feed.connected && (
        <p className="mb-4 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          Reconnecting to the local SpeedyCadiro server…
        </p>
      )}

      {update && !updateDismissed && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2.5">
          <p className="text-xs text-sky-400">
            <span className="font-medium">SpeedyCadiro v{update.latest} is available.</span> You&apos;re
            on v{version}.{" "}
            <a href={update.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Download it
            </a>
            .
          </p>
          <button
            onClick={() => setUpdateDismissed(true)}
            className="shrink-0 text-sky-400/70 hover:text-sky-400"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {sessionReady === false && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <p className="text-xs font-medium text-amber-400">Sign in to get started</p>
          <p className="mt-0.5 text-[11px] text-amber-400/80">
            Use <strong>Sign in</strong> above. Searches stay paused until you&apos;re signed in.
          </p>
        </div>
      )}

      {feed.sessionValid === false && feed.sessionMessage && (
        <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {feed.sessionMessage}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-4">
          <section className="rounded-lg border border-border bg-card px-4 py-2.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-semibold">Travel interval</span>
              <span className="font-medium tabular-nums text-muted-foreground">{intervalSec}s</span>
            </div>
            <input
              type="range"
              min={AUTO_TRAVEL_COOLDOWN_MIN_MS / 1000}
              max={AUTO_TRAVEL_COOLDOWN_MAX_MS / 1000}
              step={5}
              value={intervalSec}
              onChange={(e) => patchSettings({ autoTravelCooldownMs: Number(e.target.value) * 1000 })}
              className="mt-1 w-full accent-emerald-500"
            />
            <p className="mt-0.5 text-[10.5px] leading-tight text-muted-foreground">
              Cooldown before the next match can trigger auto-travel, so you can finish the trade
              without interruption.
            </p>
          </section>

          <SearchPanel statuses={feed.statuses} statusErrors={feed.statusErrors} />

          {feed.logs.length > 0 && (
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-2 text-sm font-semibold">Activity</h2>
              <ul className="space-y-1">
                {feed.logs.slice(0, 10).map((line) => (
                  <li
                    key={line.id}
                    className={`flex gap-2 text-[11px] ${
                      line.level === "error"
                        ? "text-destructive"
                        : line.level === "warn"
                          ? "text-amber-400"
                          : "text-muted-foreground"
                    }`}
                  >
                    <span className="shrink-0 tabular-nums opacity-60">
                      {new Date(line.at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                    <span>{line.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="space-y-3">
          <CooldownBar until={feed.cooldownUntil} totalMs={settings.autoTravelCooldownMs} />
          {/* Keyed by listing id: if this listing's data ever crashes the card,
              the next different listing remounts a clean instance rather than
              reusing broken state. */}
          <ErrorBoundary
            key={current?.id ?? "none"}
            fallback={(error) => (
              <div className="rounded-xl border border-dashed border-destructive/40 p-6 text-center">
                <p className="text-sm font-medium text-destructive">Couldn&apos;t display this listing.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  The rest of the app is unaffected - this clears automatically on the next match.
                </p>
                <p className="mt-2 rounded bg-muted/40 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  {error.message}
                </p>
              </div>
            )}
          >
            <CurrentListing listing={current} onWhisperState={feed.setWhisperState} />
          </ErrorBoundary>
        </div>
      </div>

      <OptionsModal
        open={optionsOpen}
        settings={settings}
        onPatch={patchSettings}
        onClose={() => setOptionsOpen(false)}
      />
    </main>
  )
}
