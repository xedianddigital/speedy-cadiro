"use client"

// Shown while the global travel cooldown is active: every search is paused so
// the user can finish the purchase they were just sent to, without being yanked
// to another hideout. Drains to zero, then disappears.

import { useEffect, useState } from "react"

export function CooldownBar({ until, totalMs }: { until: number | null; totalMs: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!until || until <= Date.now()) return
    const t = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(t)
  }, [until])

  if (!until) return null
  const remaining = until - now
  if (remaining <= 0) return null

  const pct = Math.max(0, Math.min(100, (remaining / totalMs) * 100))

  return (
    <div className="overflow-hidden rounded-lg border border-emerald-500/30 bg-emerald-500/10">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <span className="text-xs font-medium text-emerald-400">
          Purchase window — searches paused
        </span>
        <span className="text-xs tabular-nums text-emerald-400">
          {(remaining / 1000).toFixed(1)}s
        </span>
      </div>
      <div className="h-1 w-full bg-emerald-500/20">
        <div
          className="h-full bg-emerald-500 transition-[width] duration-200 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
