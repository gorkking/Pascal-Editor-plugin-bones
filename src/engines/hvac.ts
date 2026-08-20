/**
 * HVAC engine — ducted system layout. Pure function:
 * (WallSlice[], RoomSlice[], FramingSpec) → {members, fixtures}.
 *
 * Sizing and layout follow the rules of thumb in data/mep-rules.json /
 * docs/research/mep.md (Manual J/S/D are the real methods — labeled as such):
 *  - tonnage from conditioned area (sqft per ton, climate-typical 500),
 *    garages excluded;
 *  - the air handler lives in a service space (laundry > garage > hallway >
 *    largest room);
 *  - the trunk runs MANHATTAN along the hallway/corridor axis (else along
 *    the dominant register-spread axis), fed by a perpendicular leg from the
 *    equipment; branches leave the trunk at right angles to each register;
 *  - each register's cfm comes from the room's share of the conditioned
 *    area (400 cfm/ton split proportionally) and the trunk cross-section
 *    STEPS DOWN after each takeoff to match the remaining cfm;
 *  - one central return sized ~200 in² of grille per ton (≈2 cfm/in² face
 *    velocity), flagged when it can't carry the supply cfm;
 *  - DUCTS NEVER CROSS TOP PLATES: trunk + branches route at ATTIC elevation
 *    (above every wall's plate band) and supply registers are CEILING boots
 *    dropping through the ceiling plane like recessed lights. IRC R602.6/
 *    R602.6.1 limit plate notching/boring (a >50% bored plate needs a 16 ga
 *    tie) — a rectangular duct never fits those limits, so residential
 *    practice runs the trunk in the attic above the ceiling joists (M1601
 *    duct installation); see docs/research/mep.md §3.6;
 *  - bath exhaust fans (M1505) and a laundry dryer vent (M1502) run to
 *    exterior terminations BELOW the plate band (through a stud bay);
 *  - a thermostat mounts on an interior wall near the return (52" AFF);
 *  - LOD 400 — or a heat-pump service node at any LOD — adds the condensate
 *    drain to the exterior and the OUTDOOR AC CONDENSER ROW (night-4 user
 *    ask): N units sized from conditioned area at a climate-zone divisor
 *    (zones 1-2 ≈ 1 ton/450 sqft, 3-4 ≈ 550, 5+ ≈ 650 — an ASSUMPTION,
 *    Manual J/S govern), one condenser per ≤ 5 tons. Each unit gets a 4"
 *    concrete pad + cabinet outside an exterior wall (≥ 0.3 m off the face,
 *    ≥ 0.6 m between units, clear of door/window ROs — per mfr clearance +
 *    IRC M1403), a refrigerant LINE-SET — suction ¾" (insulated) + liquid
 *    ⅜" running as a parallel pair — from the cabinet through ONE
 *    exterior-wall penetration at ~0.4 m (snapped clear of ROs), then
 *    following the WALL GRAPH to the air handler coil on the plumbing
 *    engine's routePipe rails (E1 RO detours, junction jumpers, flagged
 *    air-run fallback — never a straight diagonal through room air), and
 *    a wall disconnect + whip (NEC 440.14; the dedicated branch circuit is
 *    routed separately). A run longer than ~15 m carries a 'verify
 *    manufacturer max line-set length / oil return' advisory (mfr specs
 *    govern). The heat-pump service node still wins unit #1's
 *    position verbatim (checklist A4) and the row re-anchors to it.
 *    NOTE: the climate-zone divisor keys off `context.stateCode` — the
 *    one-line compute.ts hookup (`stateCode: code`) is deferred while
 *    src/framing/* is frozen for parallel tracks; absent it, the mid band
 *    (550) applies.
 */

import mepRules from '../../data/mep-rules.json'
import wallAssemblies from '../../data/wall-assemblies.json'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Fixture, Member, RoomSlice, ServiceOverrides, WallSlice } from '../core/types'
import { inches, toFeet } from '../core/units'
import {
  buildWallGraph,
  clearOfOpenings,
  nearestWallPoint,
  openingSpans,
  overridePlanPoint,
  overrideWallPoint,
  pointInPolygon,
  polygonCentroid,
  segmentCrossesRo,
  wallPlan,
} from './electrical'
import { routePipe, type PipeSpec } from './plumbing'

type Pt = readonly [number, number]

const rules = mepRules as {
  hvac?: {
    sizingRuleOfThumb?: { coolingSqftPerTon?: number }
    ducted?: { branchRoundIn?: number }
    attic?: { trunkAboveWallTopM?: number; topPlateBandM?: number }
    condenser?: {
      sqftPerTonByZoneBand?: { hot?: number; mid?: number; cold?: number }
      maxTonsPerUnit?: number
      minTons?: number
      padSideM?: number
      padThicknessM?: number
      unitDimsM?: number[]
      unitClearM?: number
      wallClearM?: number
      linesetSuctionDiaM?: number
      linesetLiquidDiaM?: number
      linesetHeightM?: number
      linesetMaxLenAdvisoryM?: number
      disconnectAboveUnitM?: number
    }
  }
}

const ASSEMBLIES = wallAssemblies as {
  exterior?: { stateClimateZone?: Record<string, string> }
}

const SQFT_PER_TON = rules.hvac?.sizingRuleOfThumb?.coolingSqftPerTon ?? 500
const TRUNK_W = inches(14)
const TRUNK_H = inches(8)
const TRUNK_MIN_W = inches(8)
const BRANCH_SIDE = inches(rules.hvac?.ducted?.branchRoundIn ?? 6)
const EXHAUST_SIDE = inches(4)
/** Trunk plane above the TALLEST wall plate — ceiling-joist depth + working
 * clearance (data/mep-rules.json hvac.attic; R602.6 + M1601 basis). */
const TRUNK_ATTIC_CLEARANCE = rules.hvac?.attic?.trunkAboveWallTopM ?? 0.3
/** Top-plate band no duct may enter: [wall.height − band, wall.height]. */
const PLATE_BAND = rules.hvac?.attic?.topPlateBandM ?? 0.09
/** Interior storeys (a storey stacked ABOVE) have no attic: the trunk caps
 * below the ceiling as a dropped-soffit run at ceiling − this drop. */
const SOFFIT_DROP = 0.35
/** Register grille hangs just BELOW the host ceiling mesh (like a recessed
 * light) — at/above the plane it disappears from inside the room (visual
 * round 2026-08-16: bare ceilings from below). */
const REGISTER_BELOW_CEILING = 0.04
/** The boot drops through the plane to meet the grille. */
const BOOT_BELOW_CEILING = 0.05
/** Thermostat mount height (device center) — 48–52" practice band. */
const TSTAT_AFF = inches(52)
/** Heat-pump pad stands this far outside its exterior wall. */
const PAD_OFFSET = 0.6

// ---- AC condenser row (data/mep-rules.json hvac.condenser) ------------------
const COND = rules.hvac?.condenser
/** Cooling divisor (sqft/ton) by IECC zone band — ASSUMPTION, Manual J/S govern. */
const COND_SQFT_HOT = COND?.sqftPerTonByZoneBand?.hot ?? 450
const COND_SQFT_MID = COND?.sqftPerTonByZoneBand?.mid ?? 550
const COND_SQFT_COLD = COND?.sqftPerTonByZoneBand?.cold ?? 650
/** Residential condensers top out ~5 tons — bigger loads take more units. */
export const MAX_TONS_PER_CONDENSER = COND?.maxTonsPerUnit ?? 5
const COND_MIN_TONS = COND?.minTons ?? 1.5
/** 4" concrete equipment pad, ~0.95 × 0.95 m footprint (IRC M1403). */
const COND_PAD_SIDE = COND?.padSideM ?? 0.95
const COND_PAD_T = COND?.padThicknessM ?? 0.1016
/** Condenser cabinet W × H × D on the pad. */
const COND_DIMS: readonly [number, number, number] = [
  COND?.unitDimsM?.[0] ?? 0.9,
  COND?.unitDimsM?.[1] ?? 0.8,
  COND?.unitDimsM?.[2] ?? 0.35,
]
/** Clear space BETWEEN units in the row — per mfr clearance + IRC M1403. */
const COND_UNIT_CLEAR = COND?.unitClearM ?? 0.6
/** Clear space between the wall FACE and the cabinet. */
const COND_WALL_CLEAR = COND?.wallClearM ?? 0.3
/** Refrigerant line-set: suction ¾" (insulated) + liquid ⅜" pair, through
 * ONE wall penetration at ~0.4 m, then wall-following to the air handler. */
const LINESET_SUCTION_DIA = COND?.linesetSuctionDiaM ?? 0.019
const LINESET_LIQUID_DIA = COND?.linesetLiquidDiaM ?? 0.0095
const LINESET_Y = COND?.linesetHeightM ?? 0.4
/** The suction rides +2 cm / liquid −2 cm off LINESET_Y: a PARALLEL pair
 * with a 4 cm offset — two pipes, never one coincident stack. */
export const LINESET_PAIR_OFFSET = 0.02
/** Runs longer than this get the oil-return advisory — an ASSUMPTION class
 * (typical mfr line-set charts top out 15–30 m; the manufacturer governs). */
const LINESET_MAX_LEN_ADVISORY = COND?.linesetMaxLenAdvisoryM ?? 15
const LINESET_LONG_FLAG =
  'line-set over ~15 m — verify manufacturer max line-set length / oil return (mfr specs govern)'
/** Disconnect box center above the unit top, on the wall face (NEC 440.14). */
const DISCONNECT_ABOVE_UNIT = COND?.disconnectAboveUnitM ?? 0.3
/**
 * Worst-case exterior assembly beyond the wall FACE the pad must clear:
 * brick veneer's 4.625" assembly offset (1" airspace + 3.625" wythe,
 * R703.8 / Table R703.3(1)) + 7/16" sheathing ≈ 0.129 m. The hvac engine
 * doesn't know this wall's cladding, so every pad keeps the worst-case
 * stand-off — the CABINET stays at its anchor (byte-stable), only the pad
 * slab slides outward under it when the anchor tucks it too close.
 */
const PAD_CLADDING_ALLOW = 0.13
/** ACCA rule of thumb: airflow per ton of cooling. */
export const CFM_PER_TON = 400
/** Return grille sizing: ~200 in² per ton keeps face velocity near 2 cfm/in². */
export const RETURN_IN2_PER_TON = 200
/**
 * Stock return-grille free areas (in², 10x10 → 20x40 nominal). A single
 * central return tops out at the biggest stock grille — larger systems
 * genuinely need a second return, which is exactly what the balance flag
 * calls out (a flag that can never fire is no flag — round-3 finding).
 */
export const RETURN_GRILLE_CATALOG_IN2 = [100, 144, 216, 288, 400, 600, 800] as const

/** Shoelace polygon area (m²). */
export function polygonArea(polygon: readonly Pt[]): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, z1] = polygon[i] as Pt
    const [x2, z2] = polygon[(i + 1) % polygon.length] as Pt
    sum += x1 * z2 - x2 * z1
  }
  return Math.abs(sum) / 2
}

function centroid(polygon: readonly Pt[]): Pt {
  let x = 0
  let z = 0
  for (const [px, pz] of polygon) {
    x += px
    z += pz
  }
  const n = Math.max(1, polygon.length)
  return [x / n, z / n]
}

/** Clearance a register drop point keeps off every wall centerline: half the
 * wall body + the 6" boot's half section + working slack. */
const REGISTER_WALL_MARGIN = 0.12

/** The wall whose plan band (centerline ± thickness/2 + margin) holds `p`. */
function wallBandAt(p: Pt, walls: WallSlice[], margin = REGISTER_WALL_MARGIN): WallSlice | null {
  for (const w of walls) {
    if (w.curved || w.length < 0.1) continue
    const dx = p[0] - w.start[0]
    const dz = p[1] - w.start[1]
    const along = dx * w.dir[0] + dz * w.dir[1]
    if (along < -margin || along > w.length + margin) continue
    const off = Math.abs(-dx * w.dir[1] + dz * w.dir[0])
    if (off < w.thickness / 2 + margin) return w
  }
  return null
}

/**
 * Interior drop point for a room's ceiling register: the AREA centroid
 * (shoelace), nudged back inside the polygon and off every wall band. The
 * old VERTEX-AVERAGE centroid drifted onto (or past) walls in concave/L
 * rooms, so the supply boot bored through the plate band and the register
 * printed inside the wall (skeptic round 2026-08-16). Search: growing radial
 * ring (8 directions), then edge-midpoint pull-ins for degenerate slivers.
 */
export function roomInteriorPoint(polygon: readonly Pt[], walls: WallSlice[]): Pt {
  const c = polygonCentroid(polygon)
  const ok = (q: Pt): boolean => pointInPolygon(q, polygon) && wallBandAt(q, walls) === null
  if (ok(c)) return c
  for (let step = 0.15; step <= 1.66; step += 0.15) {
    for (let k = 0; k < 8; k++) {
      const ang = (k * Math.PI) / 4
      const q: Pt = [c[0] + Math.cos(ang) * step, c[1] + Math.sin(ang) * step]
      if (ok(q)) return q
    }
  }
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Pt
    const b = polygon[(i + 1) % polygon.length] as Pt
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const n = Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]))
    for (const s of [1, -1] as const) {
      const q: Pt = [mid[0] + (-(b[1] - a[1]) / n) * 0.3 * s, mid[1] + ((b[0] - a[0]) / n) * 0.3 * s]
      if (ok(q)) return q
    }
  }
  return c
}

/** Cooling tons from conditioned area, rounded up to the half ton, min 1.5. */
export function tonsFor(conditionedAreaM2: number): number {
  const sqft = conditionedAreaM2 * 10.7639
  const raw = sqft / SQFT_PER_TON
  return Math.max(1.5, Math.ceil(raw * 2) / 2)
}

/** Smallest stock grille covering the tonnage — capped at the catalog top. */
export function returnGrilleIn2(tons: number): number {
  const need = tons * RETURN_IN2_PER_TON
  for (const size of RETURN_GRILLE_CATALOG_IN2) {
    if (size >= need) return size
  }
  return RETURN_GRILLE_CATALOG_IN2[RETURN_GRILLE_CATALOG_IN2.length - 1] as number
}

/**
 * Cooling divisor (sqft/ton) for a state, from its dominant IECC climate
 * zone (data/wall-assemblies.json exterior.stateClimateZone — same read the
 * wall-layers batt sizing does): zones 1-2 (FL/TX/AZ style heat) size at
 * 1 ton/450 sqft, zones 3-4 at 550, zones 5+ at 650. Unknown / zone-less
 * codes (INTL, AUTO unresolved) assume the mid band. ASSUMPTION only —
 * ACCA Manual J/S govern (IRC M1401.3); the labels say so.
 */
export function condenserSqftPerTon(stateCode?: string): {
  divisor: number
  zone: string | null
} {
  const raw = stateCode ? ASSEMBLIES.exterior?.stateClimateZone?.[stateCode] : undefined
  const m = raw ? /^(\d)([ABC])?/.exec(raw.trim()) : null
  if (!m) return { divisor: COND_SQFT_MID, zone: null }
  const z = Number(m[1])
  const zone = `${m[1]}${m[2] ?? ''}`
  if (z <= 2) return { divisor: COND_SQFT_HOT, zone }
  if (z <= 4) return { divisor: COND_SQFT_MID, zone }
  return { divisor: COND_SQFT_COLD, zone }
}

/**
 * Outdoor-unit plan for a conditioned area: total tons at the climate-band
 * divisor (rounded UP to the half ton, min 1.5), one condenser per ≤ 5 tons
 * (unit count = ceil(total/5)), per-unit tonnage = total/count rounded to
 * the NEAREST half ton. A tiny home floors at 1 unit / 1.5 tons.
 */
export function condenserPlan(
  conditionedAreaM2: number,
  stateCode?: string,
): { totalTons: number; count: number; unitTons: number; divisor: number; zone: string | null } {
  const { divisor, zone } = condenserSqftPerTon(stateCode)
  const sqft = conditionedAreaM2 * 10.7639
  const totalTons = Math.max(COND_MIN_TONS, Math.ceil((sqft / divisor) * 2) / 2)
  const count = Math.max(1, Math.ceil(totalTons / MAX_TONS_PER_CONDENSER))
  const unitTons = Math.max(COND_MIN_TONS, Math.round((totalTons / count) * 2) / 2)
  return { totalTons, count, unitTons, divisor, zone }
}

/** A straight horizontal duct run between two plan points. */
function duct(
  from: Pt,
  to: Pt,
  y: number,
  w: number,
  h: number,
  sourceId: string,
  label: string,
  material: Member['material'] = 'duct',
  role: Member['role'] = 'duct-run',
  minLen = 0.15,
): Member | null {
  const dx = to[0] - from[0]
  const dz = to[1] - from[1]
  const length = Math.hypot(dx, dz)
  if (length < minLen) return null
  return {
    system: 'hvac',
    role,
    dims: [length, h, w],
    length,
    position: [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2],
    rotation: [0, Math.atan2(-dz, dx), 0],
    material,
    sourceId,
    label,
  }
}

/** Vertical duct/pipe/conduit (riser/boot/drop) between two heights at one plan point. */
function ductDrop(
  at: Pt,
  y0: number,
  y1: number,
  w: number,
  h: number,
  sourceId: string,
  label: string,
  material: Member['material'] = 'duct',
  role: Member['role'] = 'duct-run',
): Member | null {
  const lo = Math.min(y0, y1)
  const hi = Math.max(y0, y1)
  const length = hi - lo
  if (length < 0.05) return null
  return {
    system: 'hvac',
    role,
    dims: [w, length, h],
    length,
    position: [at[0], (lo + hi) / 2, at[1]],
    rotation: [0, 0, 0],
    material,
    sourceId,
    label,
  }
}

/** Manhattan (X then Z) pair of runs. */
function manhattanDuct(
  members: Member[],
  from: Pt,
  to: Pt,
  y: number,
  w: number,
  h: number,
  sourceId: string,
  label: string,
  material: Member['material'] = 'duct',
  role: Member['role'] = 'duct-run',
): void {
  const elbow: Pt = [to[0], from[1]]
  const a = duct(from, elbow, y, w, h, sourceId, label, material, role)
  if (a) members.push(a)
  const b = duct(elbow, to, y, w, h, sourceId, label, material, role)
  if (b) members.push(b)
}

/** Closest point on segment [a,b] to p. */
function projectOnto(a: Pt, b: Pt, p: Pt): Pt {
  const abx = b[0] - a[0]
  const abz = b[1] - a[1]
  const len2 = abx * abx + abz * abz
  if (len2 < 1e-12) return a
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / len2))
  return [a[0] + abx * t, a[1] + abz * t]
}

/** Nearest point on any exterior wall (exhaust/service terminations) —
 * carries the wall so exhaust heights can key off the EXIT wall's height. */
function nearestExteriorExit(walls: WallSlice[], p: Pt): { at: Pt; wall: WallSlice } | null {
  let best: { at: Pt; wall: WallSlice } | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const wall of walls) {
    if (!wall.exterior || wall.curved) continue
    const [ax, az] = wall.start
    const point = projectOnto([ax, az], [wall.end[0], wall.end[1]], p)
    const d = Math.hypot(point[0] - p[0], point[1] - p[1])
    if (d < bestDist) {
      bestDist = d
      best = { at: point, wall }
    }
  }
  return best
}

/** True when the plan segment a→b passes through `w`'s body (sampled). */
function segCrossesWall(a: Pt, b: Pt, w: WallSlice): boolean {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const steps = Math.max(1, Math.ceil(len / 0.1))
  for (let i = 0; i <= steps; i++) {
    const p: Pt = [a[0] + ((b[0] - a[0]) * i) / steps, a[1] + ((b[1] - a[1]) * i) / steps]
    const dx = p[0] - w.start[0]
    const dz = p[1] - w.start[1]
    const along = dx * w.dir[0] + dz * w.dir[1]
    if (along < 0 || along > w.length) continue
    if (Math.abs(-dx * w.dir[1] + dz * w.dir[0]) < w.thickness / 2 + 0.02) return true
  }
  return false
}

/**
 * The height budget for an exhaust run: the LOWEST wall it must pass through
 * — the exit wall plus every wall the Manhattan legs cross — capped at the
 * room ceiling. Keying off room.ceilingHeight alone put the duct inside a
 * SHORTER exit wall's own plate band (skeptic round 2026-08-16: 2.4 m wall
 * under a 2.5 m ceiling).
 */
function minWallHeightAlong(
  from: Pt,
  to: Pt,
  exitWall: WallSlice,
  roomCeiling: number,
  walls: WallSlice[],
): number {
  let minH = Math.min(roomCeiling, exitWall.height)
  const elbow: Pt = [to[0], from[1]]
  for (const w of walls) {
    if (w.curved || w.length < 0.1) continue
    if (segCrossesWall(from, elbow, w) || segCrossesWall(elbow, to, w)) {
      minH = Math.min(minH, w.height)
    }
  }
  return minH
}

/** Axis-aligned bounds of a polygon. */
function bounds(polygon: readonly Pt[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const [x, z] of polygon) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  return { minX, maxX, minZ, maxZ }
}

/** Equipment room preference: laundry > garage > hallway > largest room. */
export function equipmentRoomOf(rooms: RoomSlice[]): RoomSlice {
  const byArea = [...rooms].sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))
  return (
    rooms.find((r) => r.category === 'laundry') ??
    rooms.find((r) => r.category === 'garage') ??
    rooms.find((r) => r.category === 'hallway') ??
    (byArea[0] as RoomSlice)
  )
}

/**
 * AUTO spot for the thermostat: the INTERIOR wall face nearest the return /
 * air handler (it must read mixed house air, not an exterior wall's envelope
 * temperature), device center 52" AFF, clear of rough openings. Exported so
 * the Bones panel's "Place service points" action seeds a `bones:service`
 * thermostat node exactly where the engine auto-places.
 */
export function placeThermostatSpot(
  walls: WallSlice[],
  rooms: RoomSlice[],
): { wall: WallSlice; u: number; heightAff: number } | null {
  if (rooms.length === 0) return null
  const equipAt = centroid(equipmentRoomOf(rooms).polygon)
  // The central return hangs just off the air handler (same offset the
  // layout uses for the return grille).
  const target: Pt = [equipAt[0] + 0.5, equipAt[1] + 0.5]
  const straight = walls.filter((w) => !w.curved && w.length >= 0.1)
  const pick = (candidates: WallSlice[]): { wall: WallSlice; u: number } | null => {
    let best: { wall: WallSlice; u: number } | null = null
    let bestDist = Number.POSITIVE_INFINITY
    for (const wall of candidates) {
      const [ax, az] = wall.start
      const point = projectOnto([ax, az], [wall.end[0], wall.end[1]], target)
      const d = Math.hypot(point[0] - target[0], point[1] - target[1])
      if (d < bestDist) {
        bestDist = d
        best = {
          wall,
          u: (point[0] - ax) * wall.dir[0] + (point[1] - az) * wall.dir[1],
        }
      }
    }
    return best
  }
  const spot = pick(straight.filter((w) => !w.exterior)) ?? pick(straight)
  if (!spot) return null
  const raw = Math.max(0, Math.min(spot.wall.length, spot.u))
  const u = clearOfOpenings(spot.wall, raw, TSTAT_AFF - 0.15, TSTAT_AFF + 0.15)
  return { wall: spot.wall, u, heightAff: TSTAT_AFF }
}

/**
 * AUTO plan point of the heat-pump / condenser pad: 0.6 m outside the
 * exterior wall nearest the air handler (shortest lineset, off the wall so
 * service clearance survives). Exported for the Bones panel action.
 */
export function placeHeatPumpSpot(walls: WallSlice[], rooms: RoomSlice[]): Pt | null {
  if (rooms.length === 0) return null
  const equipAt = centroid(equipmentRoomOf(rooms).polygon)
  const exit = nearestExteriorExit(walls, equipAt)?.at
  if (!exit) return null
  const ox = exit[0] - equipAt[0]
  const oz = exit[1] - equipAt[1]
  const n = Math.max(1e-6, Math.hypot(ox, oz))
  return [exit[0] + (ox / n) * PAD_OFFSET, exit[1] + (oz / n) * PAD_OFFSET]
}

/** Plan point on a wall centerline at distance `u` from its start. */
function wallPointAt(wall: WallSlice, u: number): Pt {
  return [wall.start[0] + wall.dir[0] * u, wall.start[1] + wall.dir[1] * u]
}

/** One placed outdoor unit: plan center, its wall anchor, outward normal. */
type CondenserSlot = {
  at: Pt
  /** Along-wall anchor (pad center + line-set penetration + disconnect). */
  u: number
  /** Unit outward normal (away from the house). */
  out: Pt
}

/**
 * The condenser row: unit #1 sits AT the anchor (the heat-pump service node
 * verbatim when present — checklist A4 — else the auto pad spot, slid along
 * the wall only if it fronts a door/window RO), subsequent units step along
 * the SAME exterior wall at pad + 0.6 m clear pitch, each ≥ 0.3 m off the
 * wall face, never in front of a rough opening (slide past it). When one
 * direction runs off the wall the row grows the other way; a row that
 * exhausts both directions keeps its pitch past the end and warns.
 */
/**
 * Where the heat-pump SERVICE NODE should seed: the engine's unit-#1 anchor
 * AFTER the condenser row's RO slide — seeding at the raw spot let the sign
 * sit fronting a window the engine had already slid away from (A4 seed
 * parity, night-4 narrow round). equipAt only matters for the degenerate
 * on-wall-anchor fallback, so the anchor itself is a safe stand-in.
 */
export function placeCondenserSeedSpot(walls: WallSlice[], rooms: RoomSlice[]): Pt | null {
  const anchor = placeHeatPumpSpot(walls, rooms)
  if (!anchor) return null
  // The REAL equipAt (dawn review 1d: passing `anchor` let the degenerate
  // on-wall fallback pick the opposite out-normal and seed inside-out).
  const equipAt = rooms.length > 0 ? centroid(equipmentRoomOf(rooms).polygon) : anchor
  const row = condenserRow(walls, anchor, false, 1, equipAt)
  const slid = row.slots[0]?.at
  if (!slid) return anchor
  // Corner-flip guard (dawn review 1e): if the slid spot's nearest exterior
  // wall differs from the raw anchor's, seeding there would re-derive the
  // whole row on the OTHER wall — keep the raw anchor in that case (the
  // engine's own slide still applies at compute time).
  const rawExit = nearestExteriorExit(walls, anchor)
  const slidExit = nearestExteriorExit(walls, slid)
  if (rawExit && slidExit && rawExit.wall.id !== slidExit.wall.id) return anchor
  return slid
}

function condenserRow(
  walls: WallSlice[],
  anchor: Pt,
  anchorVerbatim: boolean,
  count: number,
  equipAt: Pt,
): { wall: WallSlice | null; slots: CondenserSlot[]; warnings: string[] } {
  const warnings: string[] = []
  const exit = nearestExteriorExit(walls, anchor)
  if (!exit) {
    // No exterior wall at all — stack the row along +X from the anchor.
    const pitch = COND_PAD_SIDE + COND_UNIT_CLEAR
    const slots: CondenserSlot[] = Array.from({ length: count }, (_, i) => ({
      at: [anchor[0] + i * pitch, anchor[1]] as Pt,
      u: 0,
      out: [0, 1] as Pt,
    }))
    if (count > 0) warnings.push('no exterior wall — condenser row placed at the anchor, verify')
    return { wall: null, slots, warnings }
  }
  const wall = exit.wall
  const foot = exit.at
  const u0 = Math.max(0, Math.min(wall.length, (anchor[0] - wall.start[0]) * wall.dir[0] + (anchor[1] - wall.start[1]) * wall.dir[1]))
  // Outward normal: anchor relative to its wall foot; a degenerate on-wall
  // anchor falls back to "away from the equipment room".
  const ox = anchor[0] - foot[0]
  const oz = anchor[1] - foot[1]
  const off = Math.hypot(ox, oz)
  let out: Pt
  if (off > 1e-6) out = [ox / off, oz / off]
  else {
    const n: Pt = [-wall.dir[1], wall.dir[0]]
    const sign = (foot[0] - equipAt[0]) * n[0] + (foot[1] - equipAt[1]) * n[1] >= 0 ? 1 : -1
    out = [n[0] * sign, n[1] * sign]
  }
  // Row units keep the anchor's stand-off, floored at the mfr clearance:
  // wall face + 0.3 m + half the cabinet depth.
  const minOff = wall.thickness / 2 + COND_WALL_CLEAR + COND_DIMS[2] / 2
  const rowOff = Math.max(off, minOff)
  const halfW = COND_PAD_SIDE / 2
  // Keep-outs: rough openings whose vertical span reaches the unit/disconnect
  // zone [0, pad + cabinet + disconnect], padded by half a pad + slack.
  const keepouts = openingSpans(wall, 0, COND_PAD_T + COND_DIMS[1] + DISCONNECT_ABOVE_UNIT).map(
    (s) => ({ lo: s.lo - halfW - 0.05, hi: s.hi + halfW + 0.05 }),
  )
  const slide = (u: number, d: 1 | -1): number => {
    let v = u
    for (let guard = 0; guard < 24; guard++) {
      const hit = keepouts.find((k) => v > k.lo && v < k.hi)
      if (!hit) return v
      v = d > 0 ? hit.hi : hit.lo
    }
    return v
  }
  const inRange = (u: number): boolean => u >= halfW && u <= wall.length - halfW
  // Unit #1: verbatim override anchors exactly; the auto spot slides to the
  // NEAREST clear along-wall position when it fronts an RO.
  let u1 = u0
  if (!anchorVerbatim) {
    const fwd = slide(u0, 1)
    const bwd = slide(u0, -1)
    const cands = [fwd, bwd].filter((c) => inRange(c))
    u1 = cands.length > 0
      ? (cands.reduce((best, c) => (Math.abs(c - u0) < Math.abs(best - u0) ? c : best)) as number)
      : fwd
  }
  const slots: CondenserSlot[] = []
  const at1: Pt =
    anchorVerbatim || u1 === u0 ? anchor : (() => {
      const p = wallPointAt(wall, u1)
      return [p[0] + out[0] * rowOff, p[1] + out[1] * rowOff] as Pt
    })()
  slots.push({ at: at1, u: u1, out })
  // Subsequent units: step along the wall at pad + clear pitch, sliding past
  // ROs; grow the other way when a direction runs out of wall.
  const pitch = COND_PAD_SIDE + COND_UNIT_CLEAR
  const d0: 1 | -1 = wall.length - u1 >= u1 ? 1 : -1
  let fwdCursor = u1
  let bwdCursor = u1
  for (let k = 1; k < count; k++) {
    let u = slide(fwdCursor + d0 * pitch, d0)
    if (inRange(u)) fwdCursor = u
    else {
      const alt = slide(bwdCursor - d0 * pitch, (d0 === 1 ? -1 : 1) as 1 | -1)
      if (inRange(alt)) {
        u = alt
        bwdCursor = alt
      } else {
        u = fwdCursor + d0 * pitch
        fwdCursor = u
        warnings.push('condenser row exceeds the exterior wall — verify placement')
      }
    }
    const p = wallPointAt(wall, u)
    slots.push({ at: [p[0] + out[0] * rowOff, p[1] + out[1] * rowOff] as Pt, u, out })
  }
  return { wall, slots, warnings }
}

export function layoutHvac(
  walls: WallSlice[],
  rooms: RoomSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
  overrides?: Pick<ServiceOverrides, 'thermostat' | 'heatPump'>,
  context?: { hasLevelAbove?: boolean; stateCode?: string },
): { members: Member[]; fixtures: Fixture[]; warnings: string[] } {
  const members: Member[] = []
  const fixtures: Fixture[] = []
  const warnings: string[] = []
  if (rooms.length === 0) return { members, fixtures, warnings }
  const fab = spec.detail !== '200'

  const conditioned = rooms.filter((r) => r.category !== 'garage')
  const habitable = conditioned.filter((r) => r.category !== 'hallway')
  if (habitable.length === 0) return { members, fixtures, warnings }

  const areaM2 = conditioned.reduce((sum, r) => sum + polygonArea(r.polygon), 0)
  const habitableArea = habitable.reduce((sum, r) => sum + polygonArea(r.polygon), 0)
  const tons = tonsFor(areaM2)
  const totalCfm = tons * CFM_PER_TON
  const ceiling = Math.min(...conditioned.map((r) => r.ceilingHeight))
  // DUCTS NEVER CROSS TOP PLATES (prod report): the trunk plane sits above
  // the TALLEST wall's plate band — R602.6/R602.6.1 cap plate notching/
  // boring (a >50% bored plate needs a 16 ga tie) and a duct never fits, so
  // practice is an attic trunk above the ceiling joists (M1601) with supply
  // boots dropping through the CEILING.
  // INTERIOR STOREYS (a walled storey stacked above — skeptic 2026-08-16:
  // the "attic" trunk rose INTO the storey above): there is no attic, so the
  // trunk caps below this storey's ceiling as a dropped-soffit run and the
  // level says so. Top storeys keep the attic routing.
  const wallTop = walls.reduce((m, w) => Math.max(m, w.height), ceiling)
  const interiorStorey = context?.hasLevelAbove === true
  const trunkY = interiorStorey ? ceiling - SOFFIT_DROP : wallTop + TRUNK_ATTIC_CLEARANCE
  if (interiorStorey) {
    warnings.push('interior-storey ducts run in soffits/floor webs — verify')
  }

  const equipRoom = equipmentRoomOf(rooms)
  const equipAt = centroid(equipRoom.polygon)

  fixtures.push({
    system: 'hvac',
    kind: 'equipment',
    position: [equipAt[0], 1.0, equipAt[1]],
    rotationY: 0,
    sourceId: equipRoom.id,
    label: `Air handler — ${tons} ton (rule of thumb; Manual J/S govern)`,
    meta: { tons, conditionedSqft: Math.round(areaM2 * 10.7639), cfm: totalCfm },
  })

  // Central return sized to the tonnage; flag when it can't carry the supply.
  const grilleIn2 = returnGrilleIn2(tons)
  const returnCapacityCfm = grilleIn2 * 2 // ≈2 cfm/in² face velocity
  fixtures.push({
    system: 'hvac',
    kind: 'return',
    position: [equipAt[0] + 0.5, ceiling - 0.05, equipAt[1] + 0.5],
    rotationY: 0,
    sourceId: equipRoom.id,
    label:
      `Central return — ${grilleIn2} in² grille` +
      (returnCapacityCfm < totalCfm
        ? ` — UNDERSIZED vs ${totalCfm} cfm supply (add a second return)`
        : ''),
    meta: { grilleIn2, capacityCfm: returnCapacityCfm },
  })

  // CEILING registers at habitable room AREA centroids (nudged off wall
  // bands — roomInteriorPoint), cfm from the room's area share — each one is
  // a boot dropping through the ceiling plane; the grille hangs just BELOW
  // the plane (like a recessed light) so it's visible from inside the room.
  const registers: { room: RoomSlice; at: Pt; cfm: number }[] = habitable.map((room) => {
    const at = roomInteriorPoint(room.polygon, walls)
    const cfm = Math.round((totalCfm * polygonArea(room.polygon)) / Math.max(1e-6, habitableArea))
    fixtures.push({
      system: 'hvac',
      kind: 'register',
      position: [at[0], room.ceilingHeight - REGISTER_BELOW_CEILING, at[1]],
      rotationY: 0,
      sourceId: room.id,
      label: `Supply register — ${cfm} cfm (ceiling)`,
      meta: { cfm, ceiling: true },
    })
    return { room, at, cfm }
  })

  // ---- Manhattan trunk along the hallway axis, stepping down per takeoff ----
  // Axis: the hallway's long bbox axis (corridors are where trunks live);
  // without a hallway, the dominant spread axis of the registers.
  const hallway = rooms.find((r) => r.category === 'hallway')
  const axisSource = hallway ? bounds(hallway.polygon) : bounds(registers.map((r) => r.at))
  const alongX = axisSource.maxX - axisSource.minX >= axisSource.maxZ - axisSource.minZ
  const axisCross = hallway
    ? alongX
      ? (axisSource.minZ + axisSource.maxZ) / 2
      : (axisSource.minX + axisSource.maxX) / 2
    : alongX
      ? equipAt[1]
      : equipAt[0]
  const u = (p: Pt): number => (alongX ? p[0] : p[1])
  const onAxis = (uu: number): Pt => (alongX ? [uu, axisCross] : [axisCross, uu])

  // Feed: the air handler rises into the attic at its own plan point, then a
  // perpendicular leg reaches the trunk axis — every trunk/branch run lives
  // at attic elevation (trunkY), never in the plate band.
  const uEq = u(equipAt)
  const riser = ductDrop(
    equipAt,
    1.0,
    trunkY,
    TRUNK_W,
    TRUNK_H,
    equipRoom.id,
    `Trunk riser ${Math.round(toFeet(TRUNK_W) * 12)}"×${Math.round(toFeet(TRUNK_H) * 12)}" — ${interiorStorey ? 'to soffit (M1601)' : 'to attic (M1601)'}`,
  )
  if (riser) members.push(riser)
  const feed = duct(
    equipAt,
    onAxis(uEq),
    trunkY,
    TRUNK_W,
    TRUNK_H,
    equipRoom.id,
    `Trunk feed ${Math.round(toFeet(TRUNK_W) * 12)}"×${Math.round(toFeet(TRUNK_H) * 12)}"`,
  )
  if (feed) members.push(feed)

  // Takeoffs in each direction from the feed point; the cross-section steps
  // down after every takeoff in proportion to the remaining cfm.
  for (const direction of [1, -1] as const) {
    const takeoffs = registers
      .filter((r) => (u(r.at) - uEq) * direction > 0.15)
      .sort((a, b) => (u(a.at) - u(b.at)) * direction)
    // Registers hugging the feed line tee straight off the feed point.
    let remaining = takeoffs.reduce((sum, t) => sum + t.cfm, 0)
    let cursor = uEq
    for (const takeoff of takeoffs) {
      const next = u(takeoff.at)
      const w = Math.max(TRUNK_MIN_W, TRUNK_W * (remaining / Math.max(1, totalCfm)))
      const segment = duct(
        onAxis(cursor),
        onAxis(next),
        trunkY,
        w,
        TRUNK_H,
        equipRoom.id,
        `Trunk ${Math.round(toFeet(w) * 12)}"×${Math.round(toFeet(TRUNK_H) * 12)}" — ${remaining} cfm`,
      )
      if (segment) members.push(segment)
      cursor = next
      remaining -= takeoff.cfm
    }
  }
  // Branches leave the trunk at right angles to each register (still in the
  // attic), then a drop boot carries the air through the CEILING plane.
  for (const { room, at, cfm } of registers) {
    const branch = duct(
      onAxis(u(at)),
      at,
      trunkY,
      BRANCH_SIDE,
      BRANCH_SIDE,
      room.id,
      `6" branch — ${cfm} cfm`,
    )
    if (branch) members.push(branch)
    const boot = ductDrop(
      at,
      room.ceilingHeight - BOOT_BELOW_CEILING,
      trunkY,
      BRANCH_SIDE,
      BRANCH_SIDE,
      room.id,
      'Supply boot 6" — ceiling drop (M1601)',
    )
    if (boot) members.push(boot)
  }

  // ---- exhaust: bath fans + laundry dryer vent to exterior terminations ----
  if (fab) {
    for (const room of rooms) {
      if (room.category !== 'bathroom' && room.category !== 'laundry') continue
      const at = centroid(room.polygon)
      const exit = nearestExteriorExit(walls, at)
      if (room.category === 'bathroom') {
        fixtures.push({
          system: 'hvac',
          kind: 'exhaust-fan',
          position: [at[0], room.ceilingHeight - 0.05, at[1]],
          rotationY: 0,
          sourceId: room.id,
          label: 'Bath exhaust fan — 50 cfm (M1505.4)',
          meta: { cfm: 50 },
        })
        if (exit) {
          // High on the wall but BELOW the plate band of every wall the run
          // passes through — the EXIT wall's OWN height governs, not the
          // room ceiling (a shorter exit wall used to put the duct in ITS
          // plate band). The 4" duct exits a stud bay, never a top plate
          // (R602.6).
          const cap = minWallHeightAlong(at, exit.at, exit.wall, room.ceilingHeight, walls)
          manhattanDuct(
            members,
            at,
            exit.at,
            cap - (PLATE_BAND + EXHAUST_SIDE / 2 + 0.03),
            EXHAUST_SIDE,
            EXHAUST_SIDE,
            room.id,
            'Bath exhaust 4" — exterior termination (M1505)',
          )
        }
      } else if (exit) {
        manhattanDuct(
          members,
          at,
          exit.at,
          0.35,
          EXHAUST_SIDE,
          EXHAUST_SIDE,
          room.id,
          'Dryer exhaust 4" — exterior termination (M1502)',
        )
      }
    }
  }

  // ---- LOD 400 (or a heat-pump service node at ANY LOD): condensate drain
  // + outdoor unit on its pad + refrigerant lineset through the wall ----
  const hpPlan = overridePlanPoint(walls, overrides?.heatPump)
  if (spec.detail === '400' || hpPlan) {
    const exit = nearestExteriorExit(walls, equipAt)?.at
    if (spec.detail === '400' && exit) {
      // Condensate falls 1/8" per foot toward the exterior (M1411.3.1) —
      // rendered with the actual pitch, chaining down across both legs.
      const CONDENSATE_SLOPE = 1 / 96
      const condensate = (from: Pt, to: Pt, yHigh: number): number => {
        const dx = to[0] - from[0]
        const dz = to[1] - from[1]
        const plan = Math.hypot(dx, dz)
        if (plan < 0.05) return yHigh
        const drop = plan * CONDENSATE_SLOPE
        const length = Math.hypot(plan, drop)
        members.push({
          system: 'hvac',
          role: 'pipe-run',
          dims: [length, inches(0.75), inches(0.75)],
          length,
          position: [(from[0] + to[0]) / 2, yHigh - drop / 2, (from[1] + to[1]) / 2],
          // +X points uphill (toward `from`), matching the plumbing slope convention
          rotation: [0, Math.atan2(-(from[1] - to[1]), from[0] - to[0]), Math.atan2(drop, plan)],
          material: 'pvc',
          sourceId: equipRoom.id,
          label: 'Condensate ¾" — slope 1/8"/ft to exterior (M1411.3.1)',
        })
        return yHigh - drop
      }
      const elbow: Pt = [exit[0], equipAt[1]]
      condensate(elbow, exit, condensate(equipAt, elbow, 0.25))
    }
    // Outdoor CONDENSER ROW (night-4 user ask — generalizes the old single
    // heat-pump block): the heat-pump service node still wins unit #1's
    // position verbatim (moving it re-anchors pads, cabinets, line-sets AND
    // the whole row), else unit #1 takes the auto pad spot; units 2..N step
    // along the same exterior wall. Sizing is a labeled ASSUMPTION
    // (1 ton per 450/550/650 sqft by climate-zone band — Manual J/S govern).
    const anchor = hpPlan ?? placeHeatPumpSpot(walls, rooms)
    if (anchor) {
      const plan = condenserPlan(areaM2, context?.stateCode)
      const row = condenserRow(walls, anchor, hpPlan != null, plan.count, equipAt)
      warnings.push(...row.warnings)
      const unitTopY = COND_PAD_T + COND_DIMS[1]
      // Line-set rails: the wall graph + the air handler's wall anchor are
      // shared by every unit's run (the coil is one point).
      const linesetGraph = buildWallGraph(walls)
      const ahAnchor = nearestWallPoint(walls, equipAt)
      const sizingNote = `assumed 1 ton/${plan.divisor} sqft${plan.zone ? `, zone ${plan.zone}` : ''}`
      for (let i = 0; i < row.slots.length; i++) {
        const slot = row.slots[i] as CondenserSlot
        const n = i + 1
        const at = slot.at
        // Cabinet back faces the house: unit #1 keeps the legacy facing (the
        // anchor's bearing from the equipment room); row units face outward.
        const rotY =
          i === 0
            ? Math.atan2(at[0] - equipAt[0], at[1] - equipAt[1])
            : Math.atan2(slot.out[0], slot.out[1])
        // The pad's inner edge must clear the wall's exterior assembly —
        // brick veneer reaches ~0.13 m past the face (R703.8) and a 0.95 m
        // square pad centered on the legacy 0.6 m anchor would run INTO it
        // (S1). Slide the SLAB outward just enough; the cabinet stays put.
        let padCenter: Pt = at
        if (row.wall) {
          const foot = wallPointAt(row.wall, slot.u)
          const standOff = (at[0] - foot[0]) * slot.out[0] + (at[1] - foot[1]) * slot.out[1]
          const needed = row.wall.thickness / 2 + PAD_CLADDING_ALLOW + COND_PAD_SIDE / 2
          const push = Math.max(0, needed - standOff)
          if (push > 0) {
            padCenter = [at[0] + slot.out[0] * push, at[1] + slot.out[1] * push]
          }
        }
        // The PAD is always poured parallel to the row wall — only the
        // CABINET keeps unit #1's legacy facing. An oblique square pad
        // reaches (|sin|+|cos|)·half toward the wall and punched through
        // the assembly after an RO slide (verify night-4 batch F1); the
        // wall-aligned pad is exactly what the clearance math assumes.
        const padRotY = row.wall ? Math.atan2(slot.out[0], slot.out[1]) : rotY
        members.push({
          system: 'hvac',
          role: 'equipment',
          dims: [COND_PAD_SIDE, COND_PAD_T, COND_PAD_SIDE],
          length: COND_PAD_SIDE,
          position: [padCenter[0], COND_PAD_T / 2, padCenter[1]],
          rotation: [0, padRotY, 0],
          material: 'concrete',
          sourceId: equipRoom.id,
          label: 'Condenser pad 4" — concrete (per mfr clearance + IRC M1403)',
        })
        members.push({
          system: 'hvac',
          role: 'equipment',
          dims: COND_DIMS,
          length: COND_DIMS[0],
          position: [at[0], COND_PAD_T + COND_DIMS[1] / 2, at[1]],
          rotation: [0, rotY, 0],
          material: 'steel',
          sourceId: equipRoom.id,
          label: `AC condenser #${n} — ${plan.unitTons} tons outdoor unit`,
        })
        fixtures.push({
          system: 'hvac',
          kind: 'equipment',
          position: [at[0], COND_PAD_T + COND_DIMS[1] / 2, at[1]],
          rotationY: rotY,
          sourceId: equipRoom.id,
          label: `AC Condenser #${n} — ${plan.unitTons} tons (${sizingNote})`,
          meta: {
            tons: plan.unitTons,
            equipment: 'condenser',
            unit: n,
            units: plan.count,
            totalTons: plan.totalTons,
          },
        })
        // Refrigerant LINE-SET (suction ¾" insulated + liquid ⅜", M1411):
        // cabinet service-valve side → ONE exterior-wall penetration at the
        // unit's along-wall spot SNAPPED clear of any RO crossing the pipe
        // band (~0.4 m up) → the WALL GRAPH to the air handler's wall anchor
        // on the plumbing engine's routePipe rails (E1 RO detours over the
        // header / under the sill, junction jumpers, flagged air-run
        // fallback) → a coil stub into the equipment room. The two pipes run
        // the SAME plan path as a parallel pair, suction +2 cm / liquid
        // −2 cm — cold line insulated, warm line bare. A run over ~15 m
        // carries the oil-return advisory (mfr line-set charts govern).
        const runMembers: Member[] = []
        const pipes = [
          {
            dia: LINESET_SUCTION_DIA,
            y: LINESET_Y + LINESET_PAIR_OFFSET,
            sourceId: `lineset-suction-${n}`,
            label: 'Line-set suction ¾" — insulated (M1411)',
          },
          {
            dia: LINESET_LIQUID_DIA,
            y: LINESET_Y - LINESET_PAIR_OFFSET,
            sourceId: `lineset-liquid-${n}`,
            label: 'Line-set liquid ⅜" (M1411)',
          },
        ]
        if (row.wall && ahAnchor) {
          // Penetration: the unit's anchor slid clear of every RO whose
          // vertical span crosses the pipe band (a verbatim heat-pump node
          // can front a window the ROW never slid for).
          const penU = clearOfOpenings(
            row.wall,
            slot.u,
            LINESET_Y - LINESET_PAIR_OFFSET - 0.05,
            LINESET_Y + LINESET_PAIR_OFFSET + 0.05,
          )
          const pen = wallPointAt(row.wall, penU)
          const foot = wallPointAt(row.wall, slot.u)
          const standOff = (at[0] - foot[0]) * slot.out[0] + (at[1] - foot[1]) * slot.out[1]
          // Service-valve elbow: slide OUTSIDE the wall (parallel to it) to
          // face the penetration, then straight in through the wall.
          const elbowOut: Pt = [pen[0] + slot.out[0] * standOff, pen[1] + slot.out[1] * standOff]
          for (const pipe of pipes) {
            // outside stub — can't detour; flagged when it crosses an RO
            // volume (E1 honesty, same contract as the service laterals)
            for (const [a, b] of [
              [at, elbowOut],
              [elbowOut, pen],
            ] as const) {
              const seg = duct(
                a, b, pipe.y, pipe.dia, pipe.dia, pipe.sourceId, pipe.label,
                'copper', 'pipe-run', 0.02,
              )
              if (!seg) continue
              if (segmentCrossesRo(walls, [a[0], pipe.y, a[1]], [b[0], pipe.y, b[1]])) {
                seg.flag = 'line-set crosses a door/window RO — verify routing'
              }
              runMembers.push(seg)
            }
            // in-wall route: penetration → air-handler wall anchor
            const spec: PipeSpec = {
              side: pipe.dia,
              material: 'copper',
              role: 'pipe-run',
              sourceId: pipe.sourceId,
              label: pipe.label,
            }
            routePipe(
              runMembers, spec, linesetGraph,
              { wall: row.wall, u: penU }, ahAnchor, pipe.y, walls,
            )
            // coil stub: wall anchor → the air handler
            const ap = wallPlan(ahAnchor)
            const stub = duct(
              [ap[0], ap[1]], equipAt, pipe.y, pipe.dia, pipe.dia,
              pipe.sourceId, pipe.label, 'copper', 'pipe-run', 0.02,
            )
            if (stub) runMembers.push(stub)
          }
        } else {
          // No exterior wall / no wall anchor (degenerate scene): flagged
          // Manhattan air legs — never silent (routePipe fallback semantics).
          for (const pipe of pipes) {
            const elbow: Pt = [equipAt[0], at[1]]
            for (const [a, b] of [
              [at, elbow],
              [elbow, equipAt],
            ] as const) {
              const seg = duct(
                a, b, pipe.y, pipe.dia, pipe.dia, pipe.sourceId,
                `${pipe.label} (air run — no wall path, verify)`,
                'copper', 'pipe-run', 0.02,
              )
              if (!seg) continue
              seg.flag = 'AIR RUN: line-set found no wall path — route along a wall'
              runMembers.push(seg)
            }
          }
        }
        // routePipe emits system 'plumbing' — the line-set is HVAC scope
        // (S4 sections, M2 row); the >15 m advisory rides every leg of the
        // long run so it aggregates as ONE flag line.
        const suctionLen = runMembers
          .filter((m) => m.sourceId === `lineset-suction-${n}`)
          .reduce((sum, m) => sum + m.length, 0)
        for (const m of runMembers) {
          m.system = 'hvac'
          if (suctionLen > LINESET_MAX_LEN_ADVISORY && !m.flag) m.flag = LINESET_LONG_FLAG
          members.push(m)
        }
        // DISCONNECT on the wall face above the unit (NEC 440.14 — within
        // sight) + a short liquid-tight whip down to the cabinet. The
        // dedicated branch circuit is deliberately NOT routed here (panel
        // integration is a parallel electrical track).
        if (row.wall) {
          const faceOff = row.wall.thickness / 2 + 0.02
          const discY = unitTopY + DISCONNECT_ABOVE_UNIT
          // The disconnect is DERIVED (only the unit anchor is verbatim):
          // a unit dragged in front of a window must not mount its box on
          // the glass — slide the box along the wall to the nearest clear
          // spot within sight (±1.2m), else keep + ⚠ (dawn visual round:
          // box mid-RO with the AC stub crossing, silently).
          let discU = slot.u
          const discSpans = openingSpans(row.wall, discY - 0.15, discY + 0.15)
          const inSpan = (u: number): boolean =>
            discSpans.some((sp) => u > sp.lo - 0.08 && u < sp.hi + 0.08)
          if (inSpan(discU)) {
            let best: number | null = null
            for (const sp of discSpans) {
              for (const cand of [sp.lo - 0.1, sp.hi + 0.1]) {
                if (cand < 0.1 || cand > row.wall.length - 0.1) continue
                if (inSpan(cand)) continue
                if (Math.abs(cand - slot.u) > 1.2) continue
                if (best === null || Math.abs(cand - slot.u) < Math.abs(best - slot.u)) best = cand
              }
            }
            if (best !== null) discU = best
            else warnings.push(
              `AC disconnect #${n} sits in a door/window rough opening — move the unit clear (NEC 440.14)`,
            )
          }
          const discFoot = wallPointAt(row.wall, discU)
          const face: Pt = [
            discFoot[0] + slot.out[0] * faceOff,
            discFoot[1] + slot.out[1] * faceOff,
          ]
          // Dedicated 2-pole branch circuit (NEC 440): ≤3-ton units run
          // 30A/10 AWG, larger 40A/8 AWG — routeWiring homeruns the panel
          // to this box like any device (compute wires it post-HVAC).
          const acGauge = plan.unitTons <= 3 ? 10 : 8
          const acBreaker = acGauge === 10 ? 30 : 40
          fixtures.push({
            system: 'hvac',
            kind: 'disconnect',
            position: [face[0], discY, face[1]],
            rotationY: Math.atan2(slot.out[0], slot.out[1]),
            sourceId: row.wall.id,
            label: `AC disconnect — NEC 440.14, within sight (AC-${n}, ${acBreaker}A 2-pole)`,
            meta: {
              unit: n,
              circuit: `AC-${n}`,
              gaugeAwg: acGauge,
              breakerA: acBreaker,
              // ~MCA proxy for the schedule's VA column (assumption-labeled
              // on the condenser fixture itself: 1 ton ≈ 1200 VA).
              va: Math.round(plan.unitTons * 1200),
            },
          })
          const whipY = unitTopY - 0.1
          const whipLabel = 'Condenser whip — liquid-tight conduit (NEC 440.14)'
          const drop = ductDrop(
            face, whipY, discY, 0.016, 0.016, `ac-whip-${n}`, whipLabel, 'steel', 'wire-run',
          )
          if (drop) members.push(drop)
          const run = duct(
            face, at, whipY, 0.016, 0.016, `ac-whip-${n}`, whipLabel, 'steel', 'wire-run',
          )
          if (run) members.push(run)
        }
      }
    }
  }

  // Thermostat: the bones:service node when present (verbatim — checklist
  // A4), else the auto spot on an interior wall near the return, 52" AFF.
  const tstatForced = overrideWallPoint(walls, overrides?.thermostat)
  const tstatSpot = tstatForced
    ? {
        wall: tstatForced.wall,
        u: tstatForced.u,
        heightAff: overrides?.thermostat?.heightAff ?? TSTAT_AFF,
      }
    : placeThermostatSpot(walls, rooms)
  if (tstatSpot) {
    const { wall } = tstatSpot
    const p: Pt = [
      wall.start[0] + wall.dir[0] * tstatSpot.u,
      wall.start[1] + wall.dir[1] * tstatSpot.u,
    ]
    const nx = equipAt[0] - p[0]
    const nz = equipAt[1] - p[1]
    fixtures.push({
      system: 'hvac',
      kind: 'thermostat',
      position: [p[0], tstatSpot.heightAff, p[1]],
      rotationY: Math.atan2(nx, nz),
      sourceId: wall.id,
      label: `Thermostat ${Math.round(toFeet(tstatSpot.heightAff) * 12)}" AFF — near the return`,
    })
  }

  return { members, fixtures, warnings }
}
