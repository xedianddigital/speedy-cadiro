// Read, save and clear the stored PoE session.
//
// GET never returns cookie values - only whether each is present, plus a live
// validation result. The UI has no reason to ever hold the raw cookies.

import { clearSession, getSession, saveSession } from "@/lib/poe/config"
import { detectUserAgent } from "@/lib/poe/cookie-detect"
import { validateSession } from "@/lib/poe/poe-client"
import { engine } from "@/lib/poe/live-engine"
import type { Session } from "@/lib/poe/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  const session = await getSession()
  if (!session) {
    return Response.json({ configured: false })
  }

  const validation = await validateSession(session)
  return Response.json({
    configured: true,
    valid: validation.ok,
    reason: validation.reason,
    userAgent: session.userAgent,
    updatedAt: session.updatedAt,
    has: {
      poesessid: Boolean(session.poesessid),
      poetoken: Boolean(session.poetoken),
      cfClearance: Boolean(session.cfClearance),
    },
  })
}

export async function POST(req: Request): Promise<Response> {
  let body: Partial<Session>
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 })
  }

  const poesessid = body.poesessid?.trim()
  if (!poesessid) {
    return Response.json({ ok: false, error: "POESESSID is required." }, { status: 400 })
  }

  // cf_clearance is bound to the exact User-Agent of the browser that earned it.
  // The desktop shell's own UA identifies Electron and would always mismatch, so
  // fall back to a real installed browser's UA instead.
  let userAgent = body.userAgent?.trim() ?? ""
  if (!userAgent || /Electron\//i.test(userAgent)) {
    userAgent = (await detectUserAgent())?.userAgent ?? ""
  }

  const session: Session = {
    poesessid,
    poetoken: body.poetoken?.trim() ?? "",
    cfClearance: body.cfClearance?.trim() ?? "",
    userAgent,
    updatedAt: Date.now(),
  }

  // Validate before storing so the UI can report a bad paste immediately.
  const validation = await validateSession(session)
  await saveSession(session)

  // New cookies mean existing sockets are stale.
  engine.stopAll()
  await engine.sync()

  return Response.json({ ok: true, valid: validation.ok, reason: validation.reason })
}

export async function DELETE(): Promise<Response> {
  engine.stopAll()
  await clearSession()
  return Response.json({ ok: true })
}
