"use client"

// Watched searches: paste a trade URL, then pause/resume, arm auto-travel, or
// remove. Live status per search comes from the SSE stream, not from polling.

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { MAX_ACTIVE_SEARCHES, type SearchStatus, type WatchedSearch } from "@/lib/poe/types"

const ICON_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded border border-input text-xs text-muted-foreground hover:bg-muted hover:text-foreground"

export function SearchPanel({
  statuses,
  statusErrors,
}: {
  statuses: Record<string, SearchStatus>
  statusErrors: Record<string, string>
}) {
  const [searches, setSearches] = useState<WatchedSearch[]>([])
  const [url, setUrl] = useState("")
  const [title, setTitle] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const res = await fetch("/api/searches", { cache: "no-store" })
      const data = await res.json()
      setSearches(data.searches ?? [])
    } catch {
      // Leave the current list in place.
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/searches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), title: title.trim() || undefined }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not add that search.")
      } else {
        setUrl("")
        setTitle("")
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  const patch = async (id: string, body: Partial<WatchedSearch>) => {
    await fetch(`/api/searches/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    await refresh()
  }

  const remove = async (id: string) => {
    await fetch(`/api/searches/${id}`, { method: "DELETE" })
    await refresh()
  }

  const setAllActive = async (active: boolean) => {
    setBusy(true)
    try {
      await Promise.all(
        searches
          .filter((s) => s.active !== active)
          .map((s) =>
            fetch(`/api/searches/${s.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ active }),
            }),
          ),
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Watched searches</h2>
        <span className="text-[11px] text-muted-foreground">
          {searches.filter((s) => s.active).length}/{MAX_ACTIVE_SEARCHES} active
        </span>
      </div>

      <div className="mb-3 space-y-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim() && !busy) void add()
          }}
          placeholder="https://www.pathofexile.com/trade/search/{league}/…"
          spellCheck={false}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Label (optional)"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
          <Button size="sm" onClick={add} disabled={busy || !url.trim()}>
            Add
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {searches.length > 0 && (
        <div className="mb-3 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className={`flex-1 ${busy || searches.every((s) => !s.active) ? "" : "text-amber-400"}`}
            onClick={() => void setAllActive(false)}
            disabled={busy || searches.every((s) => !s.active)}
          >
            Pause all
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={`flex-1 ${busy || searches.every((s) => s.active) ? "" : "text-emerald-400"}`}
            onClick={() => void setAllActive(true)}
            disabled={busy || searches.every((s) => s.active)}
          >
            Resume all
          </Button>
        </div>
      )}

      {searches.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No searches yet. Paste a live trade search URL above.
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {searches.map((s) => {
            const status = statuses[s.id] ?? (s.active ? "connecting" : "idle")
            return (
              <li key={s.id} className="flex items-start gap-2 rounded-md border border-border bg-background p-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{s.title}</p>
                  <div className="mt-1">
                    <StatusDot status={status} active={s.active} />
                  </div>

                  {s.active && statusErrors[s.id] && (
                    <p className="mt-2 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                      {statusErrors[s.id]}
                    </p>
                  )}
                </div>

                {/* Vertical close/pause/open stack, flush to the card's right
                    edge - keeps every card's action layout identical whether
                    the title is one line or wraps to two. */}
                <div className="flex shrink-0 flex-col items-center gap-1">
                  <button
                    onClick={() => remove(s.id)}
                    title="Remove"
                    className={`${ICON_BUTTON} hover:border-destructive/50 hover:text-destructive`}
                  >
                    ✕
                  </button>
                  <button
                    onClick={() => patch(s.id, { active: !s.active })}
                    title={s.active ? "Pause" : "Resume"}
                    className={ICON_BUTTON}
                  >
                    {s.active ? "⏸" : "▶"}
                  </button>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open on the trade site"
                    className={ICON_BUTTON}
                  >
                    ↗
                  </a>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function StatusDot({ status, active }: { status: SearchStatus; active: boolean }) {
  const map: Record<SearchStatus, { cls: string; label: string }> = {
    connected: { cls: "bg-emerald-500", label: "connected" },
    connecting: { cls: "bg-amber-500 animate-pulse", label: "connecting" },
    // A dropped socket on an active search is retried, so say so rather than
    // showing the same grey as a deliberately paused one.
    disconnected: active
      ? { cls: "bg-amber-500 animate-pulse", label: "reconnecting" }
      : { cls: "bg-muted-foreground", label: "disconnected" },
    error: { cls: "bg-destructive", label: "error" },
    idle: { cls: "bg-muted-foreground/50", label: "paused" },
  }
  const { cls, label } = map[status]
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${cls}`} />
      {label}
    </span>
  )
}
