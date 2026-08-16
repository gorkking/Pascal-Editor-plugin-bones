/**
 * Building characteristics — whole-building metrics about the model itself
 * (not the bill of materials): floor area, conditioned volume, envelope
 * area, glazing, the jurisdiction's wall insulation, and a schematic
 * envelope UA → design heat loss / cooling tonnage to help dimension the
 * HVAC. Pure function:
 * (WallSlice[], RoomSlice[], SlabSlice[], FramingSpec, stateCode) →
 * BuildingCharacteristics | null.
 *
 * Everything approximate is SAID so: each derived number carries its
 * citation or assumption in `notes`. This is a drafting aid, not a
 * Manual J — the UA counts wall + window conduction only.
 */

import assemblies from '../../data/wall-assemblies.json'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { RoomSlice, SlabSlice, WallSlice } from '../core/types'
import { toInches } from '../core/units'
import { LUMBER_CROSS_SECTIONS } from '../lumber'

type Pt = readonly [number, number]

type ZoneInsulation = {
  value: string
  battThicknessIn?: number
  studDepthIn?: number
  citation: string
}
type AssembliesData = {
  exterior: {
    stateClimateZone?: Record<string, string>
    stateClimateZoneCitation?: string
    insulationByClimateZone?: Record<string, ZoneInsulation>
  }
}
const DATA = assemblies as unknown as AssembliesData

// ---- conversion + rule-of-thumb constants (all cited in `notes`) ----
/** RSI (m²·K/W) per imperial R (ft²·°F·h/BTU). */
export const R_IMPERIAL_TO_RSI = 0.1761
/** W/m²K per BTU/h·ft²·°F. */
export const U_IMPERIAL_TO_SI = 5.678263
/** 2021 IECC Table R402.1.2 climate-typical fenestration U-factor. */
export const WINDOW_U_IMPERIAL = 0.32
/** Winter design temperature difference (indoor 20°C − design −2°C ≈ 22 K). */
export const DESIGN_DELTA_T_K = 22
/** Cooling RULE OF THUMB: 1 ton per 55 m² of conditioned floor. */
export const COOLING_M2_PER_TON = 55
/** UA density (W/K per m² floor) at which the tonnage adjustment is 1.0. */
export const REFERENCE_UA_DENSITY = 0.6

export type BuildingCharacteristics = {
  /** Conditioned floor area, m² (rooms; slabs minus holes as fallback). */
  floorAreaM2: number
  /** Conditioned volume, m³ (per-room area × ceiling height). */
  volumeM3: number
  /** Exterior wall envelope net of openings, m². */
  envelopeAreaM2: number
  windowCount: number
  windowAreaM2: number
  doorCount: number
  insulation: {
    /** Primary IECC climate zone for the state, e.g. "2A". */
    climateZone: string
    /** Prescriptive wall cavity R-value (imperial), e.g. 13. */
    wallR: number
    citation: string
  }
  /** Envelope conductance Σ(A·U) for walls + windows, W/K. */
  uaWPerK: number
  /** uaWPerK × ΔT 22 K — schematic winter design heat loss, W. */
  designHeatLossW: number
  /** RULE OF THUMB cooling estimate, tons (12,000 BTU/h each). */
  coolingTonsEstimate: number
  /** Citations + assumptions for every derived number above. */
  notes: string[]
}

/** Shoelace ring area, m² (same pattern as the takeoff areas block). */
function ringArea(polygon: readonly Pt[]): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, z1] = polygon[i] as Pt
    const [x2, z2] = polygon[(i + 1) % polygon.length] as Pt
    sum += x1 * z2 - x2 * z1
  }
  return Math.abs(sum) / 2
}

/** "2A (1A Miami/Keys)" → { label: "2A", key: "2" }; 4C (marine) → "4M". */
function parseZone(raw: string): { label: string; key: string } | null {
  const m = /^(\d)([ABC])?/.exec(raw.trim())
  if (!m) return null
  const digit = m[1] as string
  const letter = m[2] ?? ''
  return {
    label: `${digit}${letter}`,
    key: digit === '4' && letter === 'C' ? '4M' : digit,
  }
}

export function computeCharacteristics(
  walls: WallSlice[],
  rooms: RoomSlice[],
  slabs: SlabSlice[] = [],
  spec: FramingSpec = DEFAULT_SPEC,
  /** Resolved state code (drives the climate-zone insulation lookup). */
  stateCode = 'NY',
): BuildingCharacteristics | null {
  if (walls.length === 0 && rooms.length === 0 && slabs.length === 0) return null
  const notes: string[] = []

  // ---- floor area: rooms are the truth; slab outlines are the fallback ----
  let floorAreaM2 = 0
  if (rooms.length > 0) {
    for (const room of rooms) floorAreaM2 += ringArea(room.polygon)
  } else {
    for (const slab of slabs) {
      let area = ringArea(slab.polygon)
      for (const hole of slab.holes) area -= ringArea(hole)
      floorAreaM2 += Math.max(0, area)
    }
    if (slabs.length > 0) {
      notes.push('Floor area from slab outlines (minus holes) — no rooms/zones drawn')
    }
  }

  // ---- volume: per-room area × its ceiling height ----
  let volumeM3 = 0
  if (rooms.length > 0) {
    for (const room of rooms) volumeM3 += ringArea(room.polygon) * room.ceilingHeight
  } else {
    const heights = walls.filter((w) => w.exterior).map((w) => w.height)
    const avgH =
      heights.length > 0 ? heights.reduce((a, b) => a + b, 0) / heights.length : 2.4
    volumeM3 = floorAreaM2 * avgH
    if (floorAreaM2 > 0) {
      notes.push(
        `Volume estimated as floor area × mean exterior wall height (${avgH.toFixed(2)} m) — no rooms drawn`,
      )
    }
  }

  // ---- envelope: exterior wall faces net of openings; glazing census ----
  let envelopeAreaM2 = 0
  let windowCount = 0
  let windowAreaM2 = 0
  let doorCount = 0
  let curvedSkipped = 0
  for (const wall of walls) {
    for (const o of wall.openings) {
      if (o.kind === 'window') {
        windowCount++
        windowAreaM2 += o.width * o.height
      } else doorCount++
    }
    if (!wall.exterior) continue
    if (wall.curved) {
      curvedSkipped++
      continue
    }
    let area = wall.length * wall.height
    for (const o of wall.openings) area -= o.width * o.height
    envelopeAreaM2 += Math.max(0, area)
  }
  if (curvedSkipped > 0) notes.push(`${curvedSkipped} curved wall(s) excluded from the envelope`)
  notes.push('Opening areas use nominal door/window sizes, not rough openings')

  // ---- insulation: state → IECC climate zone → prescriptive wall R ----
  const zoneRaw = DATA.exterior.stateClimateZone?.[stateCode]
  const zone = zoneRaw ? parseZone(zoneRaw) : null
  const zoneTable = DATA.exterior.insulationByClimateZone ?? {}
  const entry = zone ? zoneTable[zone.key] : undefined
  const fallbackEntry = zoneTable['4']
  const picked =
    entry && typeof entry.value === 'string'
      ? entry
      : fallbackEntry && typeof fallbackEntry.value === 'string'
        ? fallbackEntry
        : { value: 'R13', citation: '2021 IECC Table R402.1.3 / IRC N1102.1.3' }
  const wallR = Number.parseInt(picked.value.replace(/^R/i, ''), 10) || 13
  const climateZone = zone?.label ?? '4 (assumed)'
  if (!zone) {
    notes.push(
      `Climate zone unknown for '${stateCode}' — zone 4 assumed; set the jurisdiction for a real lookup`,
    )
  } else {
    notes.push(
      `Climate zone ${zone.label} — 2021 IECC Figure R301.1 dominant zone for ${stateCode}` +
        (/[(/-]/.test(zoneRaw ?? '') ? ' (zone varies within the state — confirm with AHJ)' : ''),
    )
  }
  notes.push(`Wall cavity ${picked.value} — ${picked.citation}`)
  // Does the prescriptive batt even fit the spec'd stud bay?
  if (picked.battThicknessIn) {
    const bayIn = toInches(LUMBER_CROSS_SECTIONS[spec.exteriorStudSize][1])
    if (picked.battThicknessIn > bayIn + 0.01) {
      notes.push(
        `${picked.value} batt wants a ${picked.battThicknessIn}" bay — spec exterior studs (${spec.exteriorStudSize}) give ${bayIn.toFixed(1)}"; use continuous insulation or deeper studs`,
      )
    }
  }

  // ---- UA: wall + window conduction, W/K ----
  const wallRsi = wallR * R_IMPERIAL_TO_RSI
  const wallU = wallRsi > 0 ? 1 / wallRsi : 0
  const windowU = WINDOW_U_IMPERIAL * U_IMPERIAL_TO_SI
  const uaWPerK = envelopeAreaM2 * wallU + windowAreaM2 * windowU
  notes.push(
    `Window U-${WINDOW_U_IMPERIAL} BTU/h·ft²·°F assumed — 2021 IECC Table R402.1.2 climate-typical fenestration U-factor`,
  )
  notes.push(
    `UA counts wall + window conduction only (RSI = R × ${R_IMPERIAL_TO_RSI}); roof, floor, doors and infiltration excluded — schematic`,
  )

  // ---- design loads ----
  const designHeatLossW = uaWPerK * DESIGN_DELTA_T_K
  notes.push(`Design heat loss at ΔT = ${DESIGN_DELTA_T_K} K (winter design assumption)`)
  const baseTons = floorAreaM2 / COOLING_M2_PER_TON
  const uaDensity = floorAreaM2 > 0 ? uaWPerK / floorAreaM2 : 0
  const factor = Math.min(1.2, Math.max(0.8, uaDensity / REFERENCE_UA_DENSITY))
  const coolingTonsEstimate = baseTons * factor
  notes.push(
    `Cooling RULE OF THUMB: 1 ton per ${COOLING_M2_PER_TON} m² floor, ±20% by envelope UA density — not a Manual J load calculation`,
  )
  notes.push('Metrics cover the X-rayed level only')

  return {
    floorAreaM2,
    volumeM3,
    envelopeAreaM2,
    windowCount,
    windowAreaM2,
    doorCount,
    insulation: { climateZone, wallR, citation: picked.citation },
    uaWPerK,
    designHeatLossW,
    coolingTonsEstimate,
    notes,
  }
}

/** One display row per metric — the panel and the CSV share this shape.
 * Area-derived metrics on a slab-less model print 'n/a — no floor slabs'
 * instead of absurd zeros (round-3 scorecard C5: 'Floor area 0.0 m² …
 * Cooling ~0.0 ton' printed as fact). */
const NO_SLAB_NA = 'n/a — no floor slabs (see flags)'

export function characteristicsRows(
  c: BuildingCharacteristics,
): { metric: string; value: string; unit: string }[] {
  const noSlab = c.floorAreaM2 <= 0
  return [
    noSlab
      ? { metric: 'Floor area', value: NO_SLAB_NA, unit: '' }
      : { metric: 'Floor area', value: c.floorAreaM2.toFixed(1), unit: 'm2' },
    noSlab
      ? { metric: 'Volume', value: NO_SLAB_NA, unit: '' }
      : { metric: 'Volume', value: c.volumeM3.toFixed(1), unit: 'm3' },
    { metric: 'Envelope area (net)', value: c.envelopeAreaM2.toFixed(1), unit: 'm2' },
    { metric: 'Windows', value: String(c.windowCount), unit: 'count' },
    { metric: 'Window area', value: c.windowAreaM2.toFixed(1), unit: 'm2' },
    { metric: 'Doors', value: String(c.doorCount), unit: 'count' },
    { metric: 'Climate zone', value: c.insulation.climateZone, unit: 'IECC' },
    { metric: 'Wall insulation', value: `R-${c.insulation.wallR}`, unit: 'ft2·F·h/BTU' },
    { metric: 'Envelope UA', value: c.uaWPerK.toFixed(1), unit: 'W/K' },
    {
      metric: `Design heat loss (dT ${DESIGN_DELTA_T_K}K)`,
      value: c.designHeatLossW.toFixed(0),
      unit: 'W',
    },
    noSlab
      ? { metric: 'Cooling estimate (rule of thumb)', value: NO_SLAB_NA, unit: '' }
      : {
          metric: 'Cooling estimate (rule of thumb)',
          value: c.coolingTonsEstimate.toFixed(1),
          unit: 'tons',
        },
  ]
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** metric,value,unit rows + one `Note,…` row per citation/assumption. */
export function characteristicsCsv(c: BuildingCharacteristics): string {
  return [
    'metric,value,unit',
    ...characteristicsRows(c).map((r) =>
      [csvField(r.metric), csvField(r.value), csvField(r.unit)].join(','),
    ),
    ...c.notes.map((n) => `Note,${csvField(n)},`),
  ].join('\n')
}
