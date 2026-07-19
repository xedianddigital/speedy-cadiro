"use client"

// Next's own built-in crash screen is what users were seeing as a "black
// screen" - it replaces the whole document, and its Reload/Back buttons just
// re-fetch `/`, which can hit the exact same bad state and crash again,
// looking permanently stuck. This replaces it with a screen that actually
// recovers in place (no navigation, so no chance of hitting a dead server)
// and logs the real error so a recurrence is diagnosable.

import { useEffect } from "react"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[SpeedyCadiro] unhandled error:", error)
    void window.poeDesktop?.reportError(error.message, error.stack)
  }, [error])

  return (
    <html lang="en">
      <body className="antialiased">
        <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
          <p className="text-sm font-medium">Something went wrong.</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            SpeedyCadiro hit an unexpected error. Your searches keep running in the background - this
            only affects the window.
          </p>
          <button
            onClick={reset}
            className="mt-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
