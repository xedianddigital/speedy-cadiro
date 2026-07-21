"use client"

// The one thing this app is about: the listing you're being sent to buy. Shows
// the current travel target clearly - what, how much, from whom - with a manual
// re-travel button. Auto-travel handles the teleport; you handle the purchase.

import { useState } from "react"
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
  const mods = listing.mods ?? []

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="border-b border-border bg-muted/40 p-4">
        <h3 className="truncate text-base font-semibold">{name}</h3>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
        <div className="mt-1.5 text-2xl font-bold tabular-nums text-emerald-400">
          {listing.priceAmount != null ? listing.priceAmount : "—"}
          {listing.priceCurrency && (
            <span className="ml-1.5 text-base font-medium text-emerald-400/80">
              {listing.priceCurrency}
            </span>
          )}
        </div>
      </div>

      <div className="space-y-3 p-4">
        <p className="truncate text-xs">
          <span className="text-muted-foreground">Seller: </span>
          {listing.sellerCharacter || listing.sellerAccount || "—"}
        </p>

        {mods.length > 0 && (
          <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded-md bg-muted/40 p-2.5">
            {mods.map((mod, i) => (
              <li key={i} className="text-[11px] leading-tight text-foreground/80">
                {typeof mod === "string" ? mod : String(mod)}
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={travel} disabled={listing.whisperState === "sending"}>
            {label(listing.whisperState)}
          </Button>
          {listing.corrupted && <span className="text-xs text-destructive">corrupted</span>}
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
    case "capped":
      return "Hourly cap hit — travel manually"
    default:
      return "Travel again"
  }
}
