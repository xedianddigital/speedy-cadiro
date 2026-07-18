"use client"

import { useCallback, useEffect, useState } from "react"
import { SessionPanel } from "@/components/session-panel"
import { SearchPanel } from "@/components/search-panel"
import { CurrentListing } from "@/components/current-listing"
import { CooldownBar } from "@/components/cooldown-bar"
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

  useEffect(() => {
    void window.poeDesktop?.version().then(setVersion)
  }, [])

  const feed = useLiveFeed(settings.soundEnabled)
  const current = feed.listings[0] ?? null

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
            PoE Trade Notifier
            {version && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">v{version}</span>
            )}
          </h1>
          <p className="text-xs text-muted-foreground">
            Auto-travel to matching listings. Runs locally — nothing leaves this machine.
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={`h-2 w-2 rounded-full ${
              feed.connected ? "bg-emerald-500" : "bg-destructive animate-pulse"
            }`}
          />
          {feed.connected ? "connected" : "reconnecting"}
        </span>
      </header>

      {sessionReady === false && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <p className="text-xs font-medium text-amber-400">Sign in to get started</p>
          <p className="mt-0.5 text-[11px] text-amber-400/80">
            Use <strong>Sign in to pathofexile.com</strong> below. Searches stay paused until
            you&apos;re signed in.
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
          <SessionPanel onSessionChange={setSessionReady} />

          <SearchPanel statuses={feed.statuses} statusErrors={feed.statusErrors} />

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Settings</h2>

            <div className="py-1.5">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span>Travel interval</span>
                <span className="font-medium tabular-nums text-muted-foreground">
                  {intervalSec}s
                </span>
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
              <p className="text-[11px] text-muted-foreground">
                After a travel, all searches pause this long so you can finish buying.
              </p>
            </div>

            <label className="flex items-center justify-between gap-3 py-1.5 text-xs">
              <span>Instant buyout only</span>
              <input
                type="checkbox"
                checked={settings.instantBuyoutOnly}
                onChange={(e) => patchSettings({ instantBuyoutOnly: e.target.checked })}
                className="size-4 accent-emerald-500"
              />
            </label>

            <label className="flex items-center justify-between gap-3 py-1.5 text-xs">
              <span>Sound on match</span>
              <input
                type="checkbox"
                checked={settings.soundEnabled}
                onChange={(e) => patchSettings({ soundEnabled: e.target.checked })}
                className="size-4 accent-emerald-500"
              />
            </label>
          </section>

          {feed.logs.length > 0 && (
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-2 text-sm font-semibold">Activity</h2>
              <ul className="space-y-1">
                {feed.logs.slice(0, 10).map((line) => (
                  <li
                    key={line.id}
                    className={`text-[11px] ${
                      line.level === "error"
                        ? "text-destructive"
                        : line.level === "warn"
                          ? "text-amber-400"
                          : "text-muted-foreground"
                    }`}
                  >
                    {line.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="space-y-3">
          <CooldownBar until={feed.cooldownUntil} totalMs={settings.autoTravelCooldownMs} />
          <CurrentListing listing={current} onWhisperState={feed.setWhisperState} />
        </div>
      </div>
    </main>
  )
}
