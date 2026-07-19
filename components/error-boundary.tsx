"use client"

// A render exception with no boundary above it takes down the ENTIRE app -
// Next replaces the whole document with its built-in crash screen, whose
// Reload/Back buttons just re-fetch `/`, which re-renders the same bad data
// and crashes again. That looked like a permanently stuck black screen.
//
// Scoping a boundary around just the risky, data-driven part of the UI (the
// current listing, built from whatever pathofexile.com's API happens to send
// back) means a malformed listing can only ever break that one card - the
// rest of the app (search list, settings, sign-in) keeps working.

import { Component, type ReactNode } from "react"

interface Props {
  children: ReactNode
  fallback: (error: Error) => ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error("[SpeedyCadiro] render error:", error)
    void window.poeDesktop?.reportError(error.message, error.stack)
  }

  render() {
    if (this.state.error) return this.props.fallback(this.state.error)
    return this.props.children
  }
}
