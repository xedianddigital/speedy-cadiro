"use client"

// Session setup: sign in to pathofexile.com inside the app. Shows just one
// action at a time - Sign in when logged out, Sign out when logged in.

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

/** Exposed by electron/preload.js; absent when the UI runs in a browser tab. */
declare global {
  interface Window {
    poeDesktop?: {
      isDesktop: boolean
      version: () => Promise<string>
      uninstall: () => Promise<{ ok: boolean }>
      onOpenOptions: (cb: () => void) => () => void
      login: () => Promise<{ ok: boolean; valid: boolean; reason?: string; found?: string[] }>
      checkForUpdate: () => Promise<
        { available: false; current: string } | { available: true; current: string; latest: string; url: string }
      >
      reportError: (message: string, stack?: string) => Promise<{ ok: boolean }>
    }
  }
}

interface SessionInfo {
  configured: boolean
  valid?: boolean
  reason?: string
  userAgent?: string
  updatedAt?: number
  has?: { poesessid: boolean; poetoken: boolean; cfClearance: boolean }
}

export function SessionPanel({
  onSessionChange,
}: {
  /** Reports whether the stored session is present and accepted by the API. */
  onSessionChange: (ready: boolean) => void
}) {
  const [info, setInfo] = useState<SessionInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null)
  // Set after mount: the bridge only exists in the desktop shell, and reading it
  // during render would mismatch the server-rendered markup.
  const [isDesktop, setIsDesktop] = useState(false)

  const refresh = async () => {
    try {
      const res = await fetch("/api/session", { cache: "no-store" })
      const data: SessionInfo = await res.json()
      setInfo(data)
      onSessionChange(Boolean(data.configured && data.valid))
    } catch {
      setInfo(null)
      onSessionChange(false)
    }
  }

  useEffect(() => {
    setIsDesktop(Boolean(window.poeDesktop?.isDesktop))
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Notices (login progress, sign-out confirmation, errors) are transient by
  // nature - without this they sit there forever and read as the UI being
  // stuck, especially once the action they describe has long finished.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])

  const signIn = async () => {
    setBusy(true)
    setNotice({ kind: "warn", text: "Log in to pathofexile.com in the window that opened…" })
    try {
      const result = await window.poeDesktop!.login()
      if (result.valid) {
        setNotice({ kind: "ok", text: "Connected. Signed in to pathofexile.com." })
      } else {
        setNotice({ kind: "error", text: result.reason ?? "Sign-in didn't complete." })
      }
      await refresh()
    } catch (err) {
      setNotice({ kind: "error", text: `Sign-in failed: ${(err as Error).message}` })
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    setBusy(true)
    try {
      await fetch("/api/session", { method: "DELETE" })
      setNotice({ kind: "warn", text: "Session cleared." })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const signedIn = Boolean(info?.configured && info?.valid)
  // Configured but not valid means a session was stored but pathofexile.com
  // no longer accepts it (expired, revoked) - worth a word before "Sign in"
  // otherwise looks unchanged from a plain first-time login.
  const expired = Boolean(info?.configured && info?.valid === false)

  return (
    <div className="relative flex items-center gap-2">
      {expired && <Pill tone="error">expired</Pill>}

      {isDesktop && !signedIn && (
        <Button size="sm" onClick={signIn} disabled={busy || info === null}>
          {busy ? "Working…" : "Sign in"}
        </Button>
      )}

      {signedIn && (
        <Button size="sm" variant="ghost" onClick={clear} disabled={busy}>
          {busy ? "Working…" : "Sign out"}
        </Button>
      )}

      {notice && (
        <p
          className={`absolute right-0 top-full z-10 mt-1.5 w-64 rounded-md border border-border bg-card px-3 py-2 text-xs shadow-md ${
            notice.kind === "ok"
              ? "text-emerald-400"
              : notice.kind === "warn"
                ? "text-amber-400"
                : "text-destructive"
          }`}
        >
          {notice.text}
        </p>
      )}
    </div>
  )
}

function Pill({ tone, children }: { tone: "ok" | "error" | "muted"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "bg-emerald-500/15 text-emerald-400"
      : tone === "error"
        ? "bg-destructive/15 text-destructive"
        : "bg-muted text-muted-foreground"
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children}</span>
}
