// Global settings: the auto-travel master switch, its cooldown, and sound.

import { getSettings, saveSettings } from "@/lib/poe/config"
import { AUTO_TRAVEL_COOLDOWN_MAX_MS, AUTO_TRAVEL_COOLDOWN_MIN_MS } from "@/lib/poe/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  return Response.json(await getSettings())
}

interface SettingsPatch {
  autoTravelEnabled?: boolean
  autoTravelCooldownMs?: number
  soundEnabled?: boolean
  instantBuyoutOnly?: boolean
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)))

export async function PATCH(req: Request): Promise<Response> {
  let body: SettingsPatch
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 })
  }

  const patch: SettingsPatch = {}
  if (typeof body.autoTravelEnabled === "boolean") patch.autoTravelEnabled = body.autoTravelEnabled
  if (typeof body.soundEnabled === "boolean") patch.soundEnabled = body.soundEnabled
  if (typeof body.instantBuyoutOnly === "boolean") patch.instantBuyoutOnly = body.instantBuyoutOnly

  // Clamp rather than reject: these are bounded to keep request rates sane, and
  // a slider out of range shouldn't fail the whole save.
  if (typeof body.autoTravelCooldownMs === "number" && Number.isFinite(body.autoTravelCooldownMs)) {
    patch.autoTravelCooldownMs = clamp(
      body.autoTravelCooldownMs,
      AUTO_TRAVEL_COOLDOWN_MIN_MS,
      AUTO_TRAVEL_COOLDOWN_MAX_MS,
    )
  }

  return Response.json({ ok: true, settings: await saveSettings(patch) })
}
