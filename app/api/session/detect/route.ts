// One-click cookie detection from the local browser profile.
//
// Detection runs on the machine hosting this app. If the app is opened from a
// different browser than the one holding the cookies, the caller may pass its
// own navigator.userAgent - an exact UA always beats a reconstructed one,
// because cf_clearance is bound to it.

import { detectSession, detectUserAgent } from "@/lib/poe/cookie-detect"
import { saveSession } from "@/lib/poe/config"
import { validateSession } from "@/lib/poe/poe-client"
import { engine } from "@/lib/poe/live-engine"
import type { Session } from "@/lib/poe/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(req: Request): Promise<Response> {
  let clientUserAgent = ""
  try {
    const body = (await req.json()) as { userAgent?: string }
    clientUserAgent = body.userAgent?.trim() ?? ""
  } catch {
    // Body is optional.
  }

  // The desktop shell's own UA identifies Electron, not the browser the cookies
  // came from, so it can never match what cf_clearance was issued against.
  if (/Electron\//i.test(clientUserAgent)) clientUserAgent = ""

  const result = await detectSession()
  if (!result.session?.poesessid) {
    // Even when cookies can't be read, the browser's version usually can be -
    // hand that back so the manual form can be prefilled with a UA that matches.
    const suggested = await detectUserAgent()
    return Response.json(
      {
        ok: false,
        found: result.found,
        error: result.reason ?? "No cookies found.",
        suggestedUserAgent: suggested?.userAgent,
        suggestedUserAgentSource: suggested?.source,
      },
      { status: 404 },
    )
  }

  const detectedUA = result.session.userAgent ?? ""
  // Prefer the real UA from the requesting browser when it looks like the same
  // browser family the cookies came from; otherwise the reconstructed one.
  const useClientUA = clientUserAgent !== "" && sameBrowserFamily(clientUserAgent, detectedUA)

  const session: Session = {
    poesessid: result.session.poesessid,
    poetoken: result.session.poetoken ?? "",
    cfClearance: result.session.cfClearance ?? "",
    userAgent: useClientUA ? clientUserAgent : detectedUA,
    updatedAt: Date.now(),
  }

  const validation = await validateSession(session)
  await saveSession(session)

  engine.stopAll()
  await engine.sync()

  return Response.json({
    ok: true,
    valid: validation.ok,
    reason: validation.reason,
    source: result.session.source,
    found: result.found,
    userAgent: session.userAgent,
    userAgentSource: useClientUA ? "browser" : "reconstructed",
    // cf_clearance is worthless without a matching UA - warn rather than fail.
    warning:
      !useClientUA && clientUserAgent && !sameBrowserFamily(clientUserAgent, detectedUA)
        ? "Your cookies came from a different browser than the one you opened this app in. If requests fail, open the app in that browser or paste its User-Agent manually."
        : undefined,
  })
}

function browserFamily(ua: string): string {
  if (/Firefox\//i.test(ua)) return "firefox"
  if (/Edg\//i.test(ua)) return "edge"
  if (/Chrome\//i.test(ua)) return "chrome"
  if (/Safari\//i.test(ua)) return "safari"
  return "unknown"
}

function sameBrowserFamily(a: string, b: string): boolean {
  const fa = browserFamily(a)
  const fb = browserFamily(b)
  return fa !== "unknown" && fa === fb
}
