"use client"

import { useCallback, useEffect, useState } from "react"
import { SessionPanel } from "@/components/session-panel"
import { SearchPanel } from "@/components/search-panel"
import { ListingFeed } from "@/components/listing-feed"
import { useLiveFeed } from "@/components/use-live-feed"
import {
  AUTO_TRAVEL_COOLDOWN_MAX_MS,
  AUTO_TRAVEL_COOLDOWN_MIN_MS,
  BUFFER_SIZE_MAX,
  BUFFER_SIZE_MIN,
  DEFAULT_SETTINGS,
  MAX_ACTIVE_SEARCHES,
  type Settings,
} from "@/lib/poe/types"

export function Dashboard() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  /** null while we're still asking the server. */
  const [sessionReady, setSessionReady] = useState<boolean | null>(null)

  const feed = useLiveFeed(settings.soundEnabled)

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

  return (
    <main className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">PoE Trade Notifier</h1>
          <p className="text-xs text-muted-foreground">
            Runs locally. Your cookies never leave this machine.
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={`h-2 w-2 rounded-full ${
              feed.connected ? "bg-emerald-500" : "bg-destructive animate-pulse"
            }`}
          />
          {feed.connected ? "stream live" : "stream down"}
        </span>
      </header>

      {sessionReady === false && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <p className="text-xs font-medium text-amber-400">Step 1: connect your PoE session</p>
          <p className="mt-0.5 text-[11px] text-amber-400/80">
            Click <strong>Detect from browser</strong> below. If that can&apos;t read your cookies
            it will say why, and you can paste them manually. Searches stay paused until this is
            done.
          </p>
        </div>
      )}

      {feed.sessionValid === false && feed.sessionMessage && (
        <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {feed.sessionMessage}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          {/* No `key` here: remounting on every change wiped the result message
              the panel had just set, so detection appeared to do nothing. */}
          <SessionPanel onSessionChange={setSessionReady} />

          <SearchPanel
            statuses={feed.statuses}
            statusErrors={feed.statusErrors}
            cooldowns={feed.cooldowns}
            autoTravelEnabled={settings.autoTravelEnabled}
          />

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Settings</h2>

            <label className="flex items-center justify-between gap-3 py-1 text-xs">
              <span>
                Auto-travel
                <span className="ml-1.5 text-muted-foreground">(master switch)</span>
              </span>
              <input
                type="checkbox"
                checked={settings.autoTravelEnabled}
                onChange={(e) => patchSettings({ autoTravelEnabled: e.target.checked })}
                className="accent-amber-500"
              />
            </label>

            <div className="py-1">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span>Pause after travel</span>
                <span className="text-muted-foreground">
                  {Math.round(settings.autoTravelCooldownMs / 1000)}s
                </span>
              </div>
              <input
                type="range"
                min={AUTO_TRAVEL_COOLDOWN_MIN_MS / 1000}
                max={AUTO_TRAVEL_COOLDOWN_MAX_MS / 1000}
                step={1}
                value={Math.round(settings.autoTravelCooldownMs / 1000)}
                onChange={(e) =>
                  patchSettings({ autoTravelCooldownMs: Number(e.target.value) * 1000 })
                }
                className="mt-1 w-full accent-amber-500"
              />
              <p className="text-[11px] text-muted-foreground">
                After an auto-travel, new listings are ignored for this long.
              </p>
            </div>

            <label className="flex items-center justify-between gap-3 py-1 text-xs">
              <span>
                Feed size
                <span className="ml-1.5 text-muted-foreground">(manual travel)</span>
              </span>
              <input
                type="number"
                min={BUFFER_SIZE_MIN}
                max={BUFFER_SIZE_MAX}
                step={1}
                value={settings.bufferSize}
                onChange={(e) => patchSettings({ bufferSize: Number(e.target.value) })}
                className="w-16 rounded-md border border-input bg-background px-2 py-1 text-right text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </label>

            <label className="flex items-center justify-between gap-3 py-1 text-xs">
              <span>Listing lifetime</span>
              <span className="flex items-center gap-1">
                <input
                  type="number"
                  min={30}
                  max={900}
                  step={30}
                  value={Math.round(settings.listingTtlMs / 1000)}
                  onChange={(e) => patchSettings({ listingTtlMs: Number(e.target.value) * 1000 })}
                  className="w-16 rounded-md border border-input bg-background px-2 py-1 text-right text-xs outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-muted-foreground">s</span>
              </span>
            </label>

            <label className="flex items-center justify-between gap-3 py-1 text-xs">
              <span>Sound on new listing</span>
              <input
                type="checkbox"
                checked={settings.soundEnabled}
                onChange={(e) => patchSettings({ soundEnabled: e.target.checked })}
                className="accent-amber-500"
              />
            </label>

            {settings.autoTravelEnabled && (
              <p className="mt-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-400">
                Auto-travel whispers sellers automatically on your account. Keep the cooldown
                sane and don't leave it running unattended.
              </p>
            )}
          </section>

          {feed.logs.length > 0 && (
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-2 text-sm font-semibold">Activity</h2>
              <ul className="space-y-1">
                {feed.logs.slice(0, 12).map((line) => (
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

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Feed</h2>
            <span className="text-xs text-muted-foreground">
              {feed.listings.length}/{settings.bufferSize} · expire after{" "}
              {Math.round(settings.listingTtlMs / 60000)}m
            </span>
          </div>
          <ListingFeed
            listings={feed.listings}
            onWhisperState={feed.setWhisperState}
            listingTtlMs={settings.listingTtlMs}
          />
        </div>
      </div>
    </main>
  )
}
