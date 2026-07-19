"use client"

// Watched searches: paste a trade URL, then pause/resume, arm auto-travel, or
// remove. Live status per search comes from the SSE stream, not from polling.

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { MAX_ACTIVE_SEARCHES, type SearchStatus, type WatchedSearch } from "@/lib/poe/types"

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
          placeholder="https://www.pathofexile.com/trade/search/Mirage/…"
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
            className="flex-1 text-amber-400"
            onClick={() => void setAllActive(false)}
            disabled={busy || searches.every((s) => !s.active)}
          >
            Pause all
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1 text-emerald-400"
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
        <ul className="space-y-2">
          {searches.map((s) => {
            const status = statuses[s.id] ?? (s.active ? "connecting" : "idle")
            return (
              <li key={s.id} className="rounded-md border border-border bg-background p-2.5">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{s.title}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {s.league} · {s.searchId}
                    </p>
                  </div>
                  <StatusDot status={status} active={s.active} />
                </div>

                {s.active && statusErrors[s.id] && (
                  <p className="mb-2 rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                    {statusErrors[s.id]}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => patch(s.id, { active: !s.active })}>
                    {s.active ? "Pause" : "Resume"}
                  </Button>

                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  >
                    open on site
                  </a>

                  <button
                    onClick={() => remove(s.id)}
                    className="ml-auto text-[11px] text-muted-foreground hover:text-destructive"
                  >
                    remove
                  </button>
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
