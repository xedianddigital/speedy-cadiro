"use client"

// The feed. Newest listing first, each with a Travel to Hideout button.
//
// The server always re-fetches a listing for a fresh whisper token before
// sending, so a card never goes dead just because its token aged out. The
// countdown here is informational.

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { Listing, WhisperState } from "@/lib/poe/types"

export function ListingFeed({
  listings,
  onWhisperState,
  listingTtlMs,
}: {
  listings: Listing[]
  onWhisperState: (id: string, state: WhisperState) => void
  listingTtlMs: number
}) {
  if (listings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <p className="text-sm text-muted-foreground">Waiting for listings…</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Live search only pushes items listed from now on, not existing ones.
        </p>
      </div>
    )
  }

  return (
    <ul className="space-y-2">
      {listings.map((listing) => (
        <ListingCard
          key={listing.id}
          listing={listing}
          onWhisperState={onWhisperState}
          listingTtlMs={listingTtlMs}
        />
      ))}
    </ul>
  )
}

function ListingCard({
  listing,
  onWhisperState,
  listingTtlMs,
}: {
  listing: Listing
  onWhisperState: (id: string, state: WhisperState) => void
  listingTtlMs: number
}) {
  const [error, setError] = useState<string | null>(null)

  const travel = async () => {
    setError(null)
    onWhisperState(listing.id, "sending")
    try {
      const res = await fetch("/api/whisper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingId: listing.id }),
      })
      const data = await res.json()
      if (!data.ok) {
        setError(data.message ?? "Failed.")
        onWhisperState(listing.id, "error")
      } else {
        onWhisperState(listing.id, "sent")
      }
    } catch (err) {
      setError((err as Error).message)
      onWhisperState(listing.id, "error")
    }
  }

  const name = [listing.itemName, listing.itemType].filter(Boolean).join(" ") || "Unknown item"

  return (
    <li className="overflow-hidden rounded-lg border border-border bg-card">
      <LifeBar receivedAt={listing.receivedAt} ttlMs={listingTtlMs} />
      <div className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {name}
            {listing.corrupted && <span className="ml-2 text-xs text-destructive">corrupted</span>}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {listing.priceAmount != null
              ? `${listing.priceAmount} ${listing.priceCurrency ?? ""}`.trim()
              : "no price"}
            {listing.sellerAccount && ` · ${listing.sellerAccount}`}
            {listing.listedAgo && ` · ${listing.listedAgo}`}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{listing.searchTitle}</p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button size="sm" onClick={travel} disabled={listing.whisperState === "sending"}>
            {labelFor(listing.whisperState)}
          </Button>
          <TokenCountdown expMs={listing.tokenExpMs} />
        </div>
      </div>

      {listing.mods.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
          {listing.mods.slice(0, 6).map((mod, i) => (
            <li key={i} className="truncate text-[11px] text-muted-foreground">
              {mod}
            </li>
          ))}
          {listing.mods.length > 6 && (
            <li className="text-[11px] text-muted-foreground/70">
              +{listing.mods.length - 6} more
            </li>
          )}
        </ul>
      )}

      {listing.autoTravelled && (
        <p className="mt-2 text-[11px] text-amber-400">auto-travelled</p>
      )}
      {error && <p className="mt-2 text-[11px] text-destructive">{error}</p>}
      </div>
    </li>
  )
}

/**
 * Drains over the listing's TTL. The server expires it at zero and pushes an
 * `expire` event, so this is a preview of a removal that is about to happen,
 * not a client-side guess.
 */
function LifeBar({ receivedAt, ttlMs }: { receivedAt: number; ttlMs: number }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])

  const remaining = Math.max(0, receivedAt + ttlMs - now)
  const pct = Math.max(0, Math.min(100, (remaining / ttlMs) * 100))
  // Green while there's time, amber under a third, red in the last 20s.
  const tone =
    remaining < 20_000 ? "bg-destructive" : pct < 33 ? "bg-amber-500" : "bg-emerald-500"

  return (
    <div className="h-0.5 w-full bg-border" title={`${Math.ceil(remaining / 1000)}s left`}>
      <div className={`h-full transition-[width] duration-500 ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function labelFor(state: WhisperState): string {
  switch (state) {
    case "sending":
      return "Sending…"
    case "sent":
      return "Sent ✓"
    case "error":
      return "Retry"
    case "expired":
      return "Gone"
    default:
      return "Travel"
  }
}

/** Whisper tokens live 300s. Purely informational - the server re-fetches. */
function TokenCountdown({ expMs }: { expMs: number | null }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (expMs == null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [expMs])

  if (expMs == null) return null
  const left = Math.max(0, Math.floor((expMs - now) / 1000))
  return (
    <span className={`text-[10px] ${left === 0 ? "text-muted-foreground/60" : "text-muted-foreground"}`}>
      {left === 0 ? "token expired" : `token ${left}s`}
    </span>
  )
}
