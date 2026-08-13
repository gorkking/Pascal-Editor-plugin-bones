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
 *  - bath exhaust fans (M1505) and a laundry dryer vent (M1502) run to
 *    exterior terminations;
 *  - LOD 400 adds the condensate drain to the exterior, the refrigerant
 *    lineset to a condenser pad outside the nearest exterior wall, and a
 *    thermostat on the wall nearest the hallway.
 */

import mepRules from '../../data/mep-rules.json'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Fixture, Member, RoomSlice, WallSlice } from '../core/types'
import { inches, toFeet } from '../core/units'

type Pt = readonly [number, number]

const rules = mepRules as {
  hvac?: {
    sizingRuleOfThumb?: { coolingSqftPerTon?: number }
    ducted?: { branchRoundIn?: number }
  }
}

const SQFT_PER_TON = rules.hvac?.sizingRuleOfThumb?.coolingSqftPerTon ?? 500
const TRUNK_W = inches(14)
const TRUNK_H = inches(8)
const TRUNK_MIN_W = inches(8)
const BRANCH_SIDE = inches(rules.hvac?.ducted?.branchRoundIn ?? 6)
const EXHAUST_SIDE = inches(4)
/** ACCA rule of thumb: airflow per ton of cooling. */
export const CFM_PER_TON = 400
/** Return grille sizing: ~200 in² per ton keeps face velocity near 2 cfm/in². */
export const RETURN_IN2_PER_TON = 200

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

/** Return grille free area (in²) for a tonnage. */
export function returnGrilleIn2(tons: number): number {
  return Math.round(tons * RETURN_IN2_PER_TON)
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

export function layoutHvac(
  walls: WallSlice[],
  rooms: RoomSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
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
  const ductY = ceiling - 0.15

  // Equipment room preference: laundry > garage > hallway > largest room.
  const byArea = [...rooms].sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))
  const equipRoom =
    rooms.find((r) => r.category === 'laundry') ??
    rooms.find((r) => r.category === 'garage') ??
    rooms.find((r) => r.category === 'hallway') ??
    (byArea[0] as RoomSlice)
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
      (returnCapacityCfm < totalCfm ? ' — UNDERSIZED vs supply cfm' : ''),
    meta: { grilleIn2, capacityCfm: returnCapacityCfm },
  })

  // Registers at habitable room centroids, cfm from the room's area share.
  const registers: { room: RoomSlice; at: Pt; cfm: number }[] = habitable.map((room) => {
    const at = centroid(room.polygon)
    const cfm = Math.round((totalCfm * polygonArea(room.polygon)) / Math.max(1e-6, habitableArea))
    fixtures.push({
      system: 'hvac',
      kind: 'register',
      position: [at[0], room.ceilingHeight - 0.05, at[1]],
      rotationY: 0,
      sourceId: room.id,
      label: `Supply register — ${cfm} cfm`,
      meta: { cfm },
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

  // Feed leg: equipment → its projection on the trunk axis (perpendicular).
  const uEq = u(equipAt)
  const feed = duct(
    equipAt,
    onAxis(uEq),
    ductY,
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
        ductY,
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
  // Branches leave the trunk at right angles to each register.
  for (const { room, at, cfm } of registers) {
    const branch = duct(
      onAxis(u(at)),
      at,
      ductY,
      BRANCH_SIDE,
      BRANCH_SIDE,
      room.id,
      `6" branch — ${cfm} cfm`,
    )
    if (branch) members.push(branch)
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
          manhattanDuct(
            members,
            at,
            exit,
            room.ceilingHeight - 0.1,
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

  // ---- LOD 400: condensate drain + refrigerant lineset to a condenser pad ----
  if (spec.detail === '400') {
    const exit = nearestExteriorPoint(walls, equipAt)
    if (exit) {
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
      // Condenser pad just outside the exterior wall.
      const outX = exit[0] - equipAt[0]
      const outZ = exit[1] - equipAt[1]
      const norm = Math.max(1e-6, Math.hypot(outX, outZ))
      const pad: Pt = [exit[0] + (outX / norm) * 0.5, exit[1] + (outZ / norm) * 0.5]
      fixtures.push({
        system: 'hvac',
        kind: 'equipment',
        position: [pad[0], 0.2, pad[1]],
        rotationY: 0,
        sourceId: equipRoom.id,
        label: `Condenser — ${tons} ton, exterior pad`,
        meta: { tons },
      })
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

  // Thermostat: on the wall nearest the hallway centroid (else the unit).
  const tstatNear = hallway ? centroid(hallway.polygon) : equipAt
  let bestWall: WallSlice | null = null
  let bestPoint: Pt = tstatNear
  let bestDist = Number.POSITIVE_INFINITY
  for (const wall of walls) {
    const [ax, az] = wall.start
    const point = projectOnto([ax, az], [wall.end[0], wall.end[1]], tstatNear)
    const d = Math.hypot(point[0] - tstatNear[0], point[1] - tstatNear[1])
    if (d < bestDist) {
      bestDist = d
      bestWall = wall
      bestPoint = point
    }
  }
  if (bestWall) {
    const nx = tstatNear[0] - bestPoint[0]
    const nz = tstatNear[1] - bestPoint[1]
    fixtures.push({
      system: 'hvac',
      kind: 'thermostat',
      position: [bestPoint[0], inches(60), bestPoint[1]],
      rotationY: Math.atan2(nx, nz),
      sourceId: bestWall.id,
      label: 'Thermostat 60" AFF',
    })
  }

  return { members, fixtures }
}
