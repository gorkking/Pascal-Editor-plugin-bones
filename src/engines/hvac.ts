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
 *    drain to the exterior and the outdoor unit (pad + cabinet + refrigerant
 *    lineset through the wall to the air handler).
 */

import mepRules from '../../data/mep-rules.json'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Fixture, Member, RoomSlice, ServiceOverrides, WallSlice } from '../core/types'
import { inches, toFeet } from '../core/units'
import { clearOfOpenings, overridePlanPoint, overrideWallPoint } from './electrical'

type Pt = readonly [number, number]

const rules = mepRules as {
  hvac?: {
    sizingRuleOfThumb?: { coolingSqftPerTon?: number }
    ducted?: { branchRoundIn?: number }
    attic?: { trunkAboveWallTopM?: number; topPlateBandM?: number }
  }
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
/** Thermostat mount height (device center) — 48–52" practice band. */
const TSTAT_AFF = inches(52)
/** Heat-pump pad stands this far outside its exterior wall. */
const PAD_OFFSET = 0.6
/** Condenser pad slab: 1.0 × 0.7 m, 9 cm thick. */
const PAD_DIMS = [1.0, 0.09, 0.7] as const
/** Outdoor unit cabinet (typical 2–4 ton heat pump). */
const HP_DIMS = [0.9, 0.8, 0.4] as const
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
): Member | null {
  const dx = to[0] - from[0]
  const dz = to[1] - from[1]
  const length = Math.hypot(dx, dz)
  if (length < 0.15) return null
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

/** Vertical duct (riser/boot) between two heights at one plan point. */
function ductDrop(
  at: Pt,
  y0: number,
  y1: number,
  w: number,
  h: number,
  sourceId: string,
  label: string,
): Member | null {
  const lo = Math.min(y0, y1)
  const hi = Math.max(y0, y1)
  const length = hi - lo
  if (length < 0.05) return null
  return {
    system: 'hvac',
    role: 'duct-run',
    dims: [w, length, h],
    length,
    position: [at[0], (lo + hi) / 2, at[1]],
    rotation: [0, 0, 0],
    material: 'duct',
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

/** Nearest point on any exterior wall (exhaust/service terminations). */
function nearestExteriorPoint(walls: WallSlice[], p: Pt): Pt | null {
  let best: Pt | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const wall of walls) {
    if (!wall.exterior || wall.curved) continue
    const [ax, az] = wall.start
    const point = projectOnto([ax, az], [wall.end[0], wall.end[1]], p)
    const d = Math.hypot(point[0] - p[0], point[1] - p[1])
    if (d < bestDist) {
      bestDist = d
      best = point
    }
  }
  return best
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
  const exit = nearestExteriorPoint(walls, equipAt)
  if (!exit) return null
  const ox = exit[0] - equipAt[0]
  const oz = exit[1] - equipAt[1]
  const n = Math.max(1e-6, Math.hypot(ox, oz))
  return [exit[0] + (ox / n) * PAD_OFFSET, exit[1] + (oz / n) * PAD_OFFSET]
}

export function layoutHvac(
  walls: WallSlice[],
  rooms: RoomSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
  overrides?: Pick<ServiceOverrides, 'thermostat' | 'heatPump'>,
): { members: Member[]; fixtures: Fixture[] } {
  const members: Member[] = []
  const fixtures: Fixture[] = []
  if (rooms.length === 0) return { members, fixtures }
  const fab = spec.detail !== '200'

  const conditioned = rooms.filter((r) => r.category !== 'garage')
  const habitable = conditioned.filter((r) => r.category !== 'hallway')
  if (habitable.length === 0) return { members, fixtures }

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
  const wallTop = walls.reduce((m, w) => Math.max(m, w.height), ceiling)
  const trunkY = wallTop + TRUNK_ATTIC_CLEARANCE

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

  // CEILING registers at habitable room centroids, cfm from the room's area
  // share — each one is a boot dropping through the ceiling plane (like a
  // recessed light), never a plate-band penetration.
  const registers: { room: RoomSlice; at: Pt; cfm: number }[] = habitable.map((room) => {
    const at = centroid(room.polygon)
    const cfm = Math.round((totalCfm * polygonArea(room.polygon)) / Math.max(1e-6, habitableArea))
    fixtures.push({
      system: 'hvac',
      kind: 'register',
      position: [at[0], room.ceilingHeight - 0.02, at[1]],
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
    `Trunk riser ${Math.round(toFeet(TRUNK_W) * 12)}"×${Math.round(toFeet(TRUNK_H) * 12)}" — to attic (M1601)`,
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
      room.ceilingHeight - 0.02,
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
      const exit = nearestExteriorPoint(walls, at)
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
          // High on the wall but BELOW the plate band: the 4" duct exits
          // through a stud bay, never through a top plate (R602.6).
          manhattanDuct(
            members,
            at,
            exit,
            room.ceilingHeight - (PLATE_BAND + EXHAUST_SIDE / 2 + 0.03),
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
          exit,
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
    const exit = nearestExteriorPoint(walls, equipAt)
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
    // Outdoor unit: the heat-pump service node when present (verbatim plan
    // point — moving it re-anchors pad, cabinet AND lineset), else the auto
    // pad 0.6 m outside the exterior wall nearest the air handler.
    const pad = hpPlan ?? placeHeatPumpSpot(walls, rooms)
    if (pad) {
      const outX = pad[0] - equipAt[0]
      const outZ = pad[1] - equipAt[1]
      const rotY = Math.atan2(outX, outZ) // cabinet back faces the house
      members.push({
        system: 'hvac',
        role: 'equipment',
        dims: PAD_DIMS,
        length: PAD_DIMS[0],
        position: [pad[0], PAD_DIMS[1] / 2, pad[1]],
        rotation: [0, rotY, 0],
        material: 'concrete',
        sourceId: equipRoom.id,
        label: 'Condenser pad — concrete, exterior',
      })
      members.push({
        system: 'hvac',
        role: 'equipment',
        dims: HP_DIMS,
        length: HP_DIMS[0],
        position: [pad[0], PAD_DIMS[1] + HP_DIMS[1] / 2, pad[1]],
        rotation: [0, rotY, 0],
        material: 'steel',
        sourceId: equipRoom.id,
        label: `Heat pump / condenser — ${tons} ton outdoor unit`,
      })
      fixtures.push({
        system: 'hvac',
        kind: 'equipment',
        position: [pad[0], PAD_DIMS[1] + HP_DIMS[1] / 2, pad[1]],
        rotationY: rotY,
        sourceId: equipRoom.id,
        label: `Condenser — ${tons} ton, exterior pad`,
        meta: { tons },
      })
      // Lineset stub through the wall back to the air handler.
      manhattanDuct(
        members,
        equipAt,
        pad,
        0.4,
        inches(0.875),
        inches(0.875),
        equipRoom.id,
        'Refrigerant lineset ⅞" suction / ⅜" liquid (insulated)',
        'copper',
        'pipe-run',
      )
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

  return { members, fixtures }
}
