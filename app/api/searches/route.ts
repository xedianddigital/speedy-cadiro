// List and add watched searches.

import { addSearch, getSearches } from "@/lib/poe/config"
import { parseTradeUrl } from "@/lib/poe/parse-url"
import { engine } from "@/lib/poe/live-engine"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  const searches = await getSearches()
  const { statuses } = engine.getState()
  return Response.json({
    searches: searches.map((s) => ({ ...s, status: statuses[s.id] ?? "idle" })),
  })
}

export async function POST(req: Request): Promise<Response> {
  let body: { url?: string; title?: string; autoTravel?: boolean; active?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 })
  }

  const url = body.url?.trim()
  if (!url) {
    return Response.json({ ok: false, error: "A trade search URL is required." }, { status: 400 })
  }

  const parsed = parseTradeUrl(url)
  if (!parsed) {
    return Response.json(
      {
        ok: false,
        error: "Could not parse that URL. Expected .../trade/search/{league}/{searchId}.",
      },
      { status: 400 },
    )
  }

  const search = await addSearch({
    url,
    league: parsed.league,
    searchId: parsed.searchId,
    title: body.title?.trim() || `${parsed.league} · ${parsed.searchId.slice(0, 6)}`,
    // New searches always start paused - the user arms them by hand once
    // they're ready, rather than a freshly pasted URL immediately opening a
    // live WebSocket.
    active: body.active ?? false,
    autoTravel: body.autoTravel ?? true,
  })

  await engine.sync()
  return Response.json({ ok: true, search })
}
