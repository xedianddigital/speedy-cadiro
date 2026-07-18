// Proactive rate limiting for pathofexile.com.
//
// GGG publishes their limits on every response and expects clients to respect
// them rather than discover them by getting 429'd:
//
//   X-Rate-Limit-Rules:        Ip,Account
//   X-Rate-Limit-Ip:           8:10:60,15:60:600
//   X-Rate-Limit-Ip-State:     1:10:0,1:60:0
//
// Each triple is hits:period:restrictTime. The rule is the budget, the state is
// current usage. Getting restricted is what makes a client look like a bot, so
// this serialises every request through one queue and paces it to stay well
// under the tightest published budget.

export interface RateRule {
  hits: number
  periodSec: number
  restrictSec: number
}

export interface RateState {
  hits: number
  periodSec: number
  restrictedForSec: number
}

/** Spend at most this fraction of the published budget. */
const SAFETY = 0.6

/** Never fire faster than this, even if the budget would allow it. */
const MIN_SPACING_MS = 350

/** Random extra delay so requests don't form a perfectly regular pattern. */
const JITTER_MS = 120

function parseTriples(header: string | null): { a: number; b: number; c: number }[] {
  if (!header) return []
  return header
    .split(",")
    .map((part) => part.trim().split(":").map(Number))
    .filter((n) => n.length === 3 && n.every((v) => Number.isFinite(v)))
    .map(([a, b, c]) => ({ a, b, c }))
}

export class RateLimiter {
  /** Serialises callers; PoE limits are global, not per-endpoint. */
  private chain: Promise<unknown> = Promise.resolve()
  private nextAllowedAt = 0
  private spacingMs = MIN_SPACING_MS
  private rules: RateRule[] = []
  private states: RateState[] = []

  /** Human-readable snapshot for the UI. */
  get status(): { spacingMs: number; worstUsage: number; restrictedForSec: number } {
    let worst = 0
    let restricted = 0
    for (let i = 0; i < this.states.length; i += 1) {
      const rule = this.rules[i]
      const state = this.states[i]
      if (rule?.hits) worst = Math.max(worst, state.hits / rule.hits)
      restricted = Math.max(restricted, state.restrictedForSec)
    }
    return { spacingMs: this.spacingMs, worstUsage: worst, restrictedForSec: restricted }
  }

  /** Run `fn` when the budget allows. Calls are executed one at a time. */
  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.nextAllowedAt - Date.now()
      if (wait > 0) await sleep(wait)
      try {
        return await fn()
      } finally {
        // Reserve the next slot even if the call threw.
        this.nextAllowedAt = Date.now() + this.spacingMs + Math.random() * JITTER_MS
      }
    })
    // Keep the chain alive regardless of individual failures.
    this.chain = run.catch(() => undefined)
    return run as Promise<T>
  }

  /** Feed a response's headers back in so pacing tracks the real budget. */
  observe(res: Response): void {
    const names = (res.headers.get("X-Rate-Limit-Rules") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

    const rules: RateRule[] = []
    const states: RateState[] = []

    for (const name of names) {
      const ruleTriples = parseTriples(res.headers.get(`X-Rate-Limit-${name}`))
      const stateTriples = parseTriples(res.headers.get(`X-Rate-Limit-${name}-State`))
      for (const t of ruleTriples) rules.push({ hits: t.a, periodSec: t.b, restrictSec: t.c })
      for (const t of stateTriples) {
        states.push({ hits: t.a, periodSec: t.b, restrictedForSec: t.c })
      }
    }

    if (rules.length > 0) {
      this.rules = rules
      this.states = states

      // Tightest budget wins: a 15-per-60s rule implies 4s between calls, which
      // at 60% utilisation becomes ~6.7s.
      let spacing = MIN_SPACING_MS
      for (const rule of rules) {
        if (rule.hits <= 0) continue
        spacing = Math.max(spacing, ((rule.periodSec * 1000) / rule.hits) / SAFETY)
      }
      this.spacingMs = spacing
    }

    // If any bucket says we're restricted, sit out the full penalty.
    const restricted = Math.max(0, ...states.map((s) => s.restrictedForSec), 0)
    if (restricted > 0) {
      this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + restricted * 1000)
    }

    const retryAfter = Number(res.headers.get("Retry-After"))
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + retryAfter * 1000)
    }
  }

  /** Back off hard after a 429, on top of whatever the headers said. */
  penalise(ms: number): void {
    this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + ms)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One limiter per process: GGG's budgets are per IP and per account. */
const globalRef = globalThis as unknown as { __poeRateLimiter?: RateLimiter }
export const rateLimiter: RateLimiter = globalRef.__poeRateLimiter ?? new RateLimiter()
if (!globalRef.__poeRateLimiter) globalRef.__poeRateLimiter = rateLimiter
