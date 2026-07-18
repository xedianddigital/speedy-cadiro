// Global settings: the auto-travel master switch, its cooldown, and sound.

import { getSettings, saveSettings } from "@/lib/poe/config"
import {
  AUTO_TRAVEL_COOLDOWN_MAX_MS,
  AUTO_TRAVEL_COOLDOWN_MIN_MS,
  BUFFER_SIZE_MAX,
  BUFFER_SIZE_MIN,
} from "@/lib/poe/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(): Promise<Response> {
  return Response.json(await getSettings())
}

interface SettingsPatch {
  autoTravelEnabled?: boolean
  autoTravelCooldownMs?: number
  soundEnabled?: boolean
  bufferSize?: number
  listingTtlMs?: number
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

  // Clamp rather than reject: these are bounded to keep request rates sane, and
  // a slider out of range shouldn't fail the whole save.
  if (typeof body.autoTravelCooldownMs === "number" && Number.isFinite(body.autoTravelCooldownMs)) {
    patch.autoTravelCooldownMs = clamp(
      body.autoTravelCooldownMs,
      AUTO_TRAVEL_COOLDOWN_MIN_MS,
      AUTO_TRAVEL_COOLDOWN_MAX_MS,
    )
  }
  if (typeof body.bufferSize === "number" && Number.isFinite(body.bufferSize)) {
    patch.bufferSize = clamp(body.bufferSize, BUFFER_SIZE_MIN, BUFFER_SIZE_MAX)
  }
  if (typeof body.listingTtlMs === "number" && Number.isFinite(body.listingTtlMs)) {
    // 30s to 15min.
    patch.listingTtlMs = clamp(body.listingTtlMs, 30_000, 900_000)
  }

  return Response.json({ ok: true, settings: await saveSettings(patch) })
}
