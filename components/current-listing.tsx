"use client"

// The one thing this app is about: the listing you're being sent to buy. Shows
// the current travel target clearly - what, how much, from whom - with a manual
// re-travel button. Auto-travel handles the teleport; you handle the purchase.

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type { Listing, WhisperState } from "@/lib/poe/types"

export function CurrentListing({
  listing,
  onWhisperState,
}: {
  listing: Listing | null
  onWhisperState: (id: string, state: WhisperState) => void
}) {
  if (!listing) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border p-10 text-center">
        <p className="text-sm font-medium text-muted-foreground">Watching for a match…</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The next matching listing appears here, and you&apos;re taken to the seller automatically.
        </p>
      </div>
    )
  }
  return <Card listing={listing} onWhisperState={onWhisperState} />
}

function Card({
  listing,
  onWhisperState,
}: {
  listing: Listing
  onWhisperState: (id: string, state: WhisperState) => void
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

  const name = listing.itemName || listing.itemType || "Unknown item"
  const subtitle = listing.itemName && listing.itemType ? listing.itemType : null

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-start justify-between gap-4 border-b border-border bg-muted/40 p-4">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{name}</h3>
          {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-lg font-semibold tabular-nums">
            {listing.priceAmount != null ? listing.priceAmount : "—"}
            {listing.priceCurrency && (
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                {listing.priceCurrency}
              </span>
            )}
          </div>
          {listing.instantBuyout && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-400">
              instant buyout
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3 p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Seller</dt>
          <dd className="truncate">{listing.sellerCharacter || listing.sellerAccount || "—"}</dd>
          {listing.listedAgo && (
            <>
              <dt className="text-muted-foreground">Listed</dt>
              <dd>{listing.listedAgo}</dd>
            </>
          )}
          <dt className="text-muted-foreground">From</dt>
          <dd className="truncate">{listing.searchTitle}</dd>
        </dl>

        {listing.mods.length > 0 && (
          <ul className="space-y-0.5 rounded-md bg-muted/40 p-2.5">
            {listing.mods.map((mod, i) => (
              <li key={i} className="text-[11px] leading-tight text-foreground/80">
                {mod}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={travel} disabled={listing.whisperState === "sending"}>
            {label(listing.whisperState)}
          </Button>
          {listing.corrupted && <span className="text-xs text-destructive">corrupted</span>}
          <TokenTtl expMs={listing.tokenExpMs} />
        </div>

        {error && <p className="text-[11px] text-destructive">{error}</p>}
      </div>
    </div>
  )
}

function label(state: WhisperState): string {
  switch (state) {
    case "sending":
      return "Travelling…"
    case "sent":
      return "Travelled ✓ — go again"
    case "error":
      return "Retry travel"
    case "expired":
      return "Listing gone"
    default:
      return "Travel again"
  }
}

/** Whisper tokens live 300s; the server re-fetches on manual travel, so this is informational. */
function TokenTtl({ expMs }: { expMs: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (expMs == null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [expMs])
  if (expMs == null) return null
  const left = Math.max(0, Math.floor((expMs - now) / 1000))
  return (
    <span className="ml-auto text-[10px] text-muted-foreground">
      {left === 0 ? "token refreshes on travel" : `token ${left}s`}
    </span>
  )
}
