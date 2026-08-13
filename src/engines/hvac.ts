/**
 * HVAC engine — LOD 200 schematic ducted system. Pure function:
 * (WallSlice[], RoomSlice[], FramingSpec) → {members, fixtures}.
 *
 * Sizing and layout follow the rules of thumb in data/mep-rules.json /
 * docs/research/mep.md (Manual J/S/D are the real methods — labeled as such):
 *  - tonnage from conditioned area (sqft per ton, climate-typical 500);
 *  - the air handler lives in a service space (laundry > garage > hallway >
 *    largest room);
 *  - one rectangular trunk runs at ceiling height from the equipment toward
 *    the register centroid; round branches tee off to a ceiling register in
 *    every habitable room; one central return near the equipment;
 *  - thermostat on the wall nearest the hallway (else nearest the unit).
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
const BRANCH_SIDE = inches(rules.hvac?.ducted?.branchRoundIn ?? 6)

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

/** A straight horizontal duct run between two plan points. */
function duct(
  from: Pt,
  to: Pt,
  y: number,
  w: number,
  h: number,
  sourceId: string,
  label: string,
): Member | null {
  const dx = to[0] - from[0]
  const dz = to[1] - from[1]
  const length = Math.hypot(dx, dz)
  if (length < 0.15) return null
  return {
    system: 'hvac',
    role: 'duct-run',
    dims: [length, h, w],
    length,
    position: [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2],
    rotation: [0, Math.atan2(-dz, dx), 0],
    material: 'duct',
    sourceId,
    label,
  }
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

export function layoutHvac(
  walls: WallSlice[],
  rooms: RoomSlice[],
  _spec: FramingSpec = DEFAULT_SPEC,
): { members: Member[]; fixtures: Fixture[] } {
  const members: Member[] = []
  const fixtures: Fixture[] = []
  if (rooms.length === 0) return { members, fixtures }

  const conditioned = rooms.filter((r) => r.category !== 'garage')
  const habitable = conditioned.filter((r) => r.category !== 'hallway')
  if (habitable.length === 0) return { members, fixtures }

  const areaM2 = conditioned.reduce((sum, r) => sum + polygonArea(r.polygon), 0)
  const tons = tonsFor(areaM2)
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
    meta: { tons, conditionedSqft: Math.round(areaM2 * 10.7639) },
  })
  fixtures.push({
    system: 'hvac',
    kind: 'return',
    position: [equipAt[0] + 0.5, ceiling - 0.05, equipAt[1] + 0.5],
    rotationY: 0,
    sourceId: equipRoom.id,
    label: 'Central return',
  })

  // Registers at habitable room centroids (ceiling diffusers).
  const registers: { room: RoomSlice; at: Pt }[] = habitable.map((room) => {
    const at = centroid(room.polygon)
    fixtures.push({
      system: 'hvac',
      kind: 'register',
      position: [at[0], room.ceilingHeight - 0.05, at[1]],
      rotationY: 0,
      sourceId: room.id,
      label: 'Supply register',
    })
    return { room, at }
  })

  // Trunk: equipment → centroid of all registers; branches tee off the trunk.
  const regCentroid = centroid(registers.map((r) => r.at))
  const trunk = duct(equipAt, regCentroid, ductY, TRUNK_W, TRUNK_H, equipRoom.id,
    `Trunk ${Math.round(toFeet(TRUNK_W) * 12)}"×${Math.round(toFeet(TRUNK_H) * 12)}" (schematic)`)
  if (trunk) members.push(trunk)
  for (const { room, at } of registers) {
    const tee = trunk ? projectOnto(equipAt, regCentroid, at) : equipAt
    const branch = duct(tee, at, ductY, BRANCH_SIDE, BRANCH_SIDE, room.id, '6" branch (schematic)')
    if (branch) members.push(branch)
    // // LOD 400: Manhattan routing through joist bays + register throw sizing.
  }

  // Thermostat: on the wall nearest the hallway centroid (else the unit).
  const hallway = rooms.find((r) => r.category === 'hallway')
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
