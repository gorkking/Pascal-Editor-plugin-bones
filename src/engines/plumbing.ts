/**
 * Plumbing engine — LOD 200 schematic DWV + supply for wet rooms. Pure
 * function: (WallSlice[], RoomSlice[], FramingSpec) → {members, fixtures}.
 *
 * The layout logic mirrors how residential plumbing is actually organized
 * (docs/research/mep.md, data/mep-rules.json):
 *  - wet rooms (kitchen / bathroom / laundry) cluster around a shared
 *    plumbing core to minimize runs;
 *  - ONE 3" vent stack rises inside the wet wall nearest the bathroom and
 *    penetrates the roof (IRC P3102/P3103);
 *  - drains slope to the stack (schematic straight runs here — real DWV
 *    slopes 1/4"/ft and routes through joist bays. // LOD 400);
 *  - hot/cold supplies run parallel above the drains;
 *  - fixtures rough in at standard heights (toilet 12" center-off-wall,
 *    lav ~21" AFF drain, kitchen sink ~18" AFF, laundry box ~42").
 */

import mepRules from '../../data/mep-rules.json'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Fixture, Member, RoomSlice, WallSlice } from '../core/types'
import { inches } from '../core/units'

type Pt = readonly [number, number]

const rules = mepRules as {
  plumbing?: {
    dwv?: { buildingDrainIn?: number; ventStackIn?: number }
    fixtureRoughIn?: { toiletCenterFromWallIn?: number; lavHeightIn?: number }
  }
}

/** Pipe box side for a nominal diameter (round pipe drawn as a square box). */
const pipeSide = (nominalIn: number): number => inches(nominalIn)

const MAIN_DRAIN = pipeSide(rules.plumbing?.dwv?.buildingDrainIn ?? 3)
const BRANCH_DRAIN = pipeSide(2)
const STACK_SIDE = pipeSide(rules.plumbing?.dwv?.ventStackIn ?? 3)
const SUPPLY_SIDE = pipeSide(0.75)

export function polygonCentroid(polygon: readonly Pt[]): Pt {
  let x = 0
  let z = 0
  for (const [px, pz] of polygon) {
    x += px
    z += pz
  }
  const n = Math.max(1, polygon.length)
  return [x / n, z / n]
}

/** Closest point on a wall's segment to `p`, plus the distance. */
function nearestOnWall(wall: WallSlice, p: Pt): { point: Pt; distance: number } {
  const [ax, az] = wall.start
  const [dx, dz] = wall.dir
  const t = Math.max(0, Math.min(wall.length, (p[0] - ax) * dx + (p[1] - az) * dz))
  const point: Pt = [ax + dx * t, az + dz * t]
  return { point, distance: Math.hypot(p[0] - point[0], p[1] - point[1]) }
}

/** The wet wall for a room: a boundary wall (else the nearest wall) whose
 * midpoint is closest to the shared wet-core centroid. */
export function wetWallFor(
  room: RoomSlice,
  walls: WallSlice[],
  core: Pt,
): WallSlice | null {
  const candidates =
    room.boundaryWallIds.length > 0
      ? walls.filter((w) => room.boundaryWallIds.includes(w.id))
      : walls
  if (candidates.length === 0) return null
  const centroid = polygonCentroid(room.polygon)
  let best: WallSlice | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const wall of candidates) {
    const mid: Pt = [
      wall.start[0] + (wall.dir[0] * wall.length) / 2,
      wall.start[1] + (wall.dir[1] * wall.length) / 2,
    ]
    // Serve the room (near its centroid) AND the core (short shared runs).
    const score =
      Math.hypot(mid[0] - centroid[0], mid[1] - centroid[1]) +
      Math.hypot(mid[0] - core[0], mid[1] - core[1])
    if (score < bestScore) {
      bestScore = score
      best = wall
    }
  }
  return best
}

/** A straight horizontal run between two plan points as a pipe Member. */
function run(
  from: Pt,
  to: Pt,
  y: number,
  side: number,
  material: Member['material'],
  role: Member['role'],
  sourceId: string,
  label: string,
): Member | null {
  const dx = to[0] - from[0]
  const dz = to[1] - from[1]
  const length = Math.hypot(dx, dz)
  if (length < 0.05) return null
  return {
    system: 'plumbing',
    role,
    dims: [length, side, side],
    length,
    position: [(from[0] + to[0]) / 2, y, (from[1] + to[1]) / 2],
    rotation: [0, Math.atan2(-dz, dx), 0],
    material,
    sourceId,
    label,
  }
}

export function layoutPlumbing(
  walls: WallSlice[],
  rooms: RoomSlice[],
  _spec: FramingSpec = DEFAULT_SPEC,
): { members: Member[]; fixtures: Fixture[] } {
  const members: Member[] = []
  const fixtures: Fixture[] = []
  const wetRooms = rooms.filter((r) =>
    r.category === 'kitchen' || r.category === 'bathroom' || r.category === 'laundry',
  )
  if (wetRooms.length === 0 || walls.length === 0) return { members, fixtures }

  // Shared wet core: the centroid of every wet room — plumbing clusters.
  const core = polygonCentroid(wetRooms.flatMap((r) => [polygonCentroid(r.polygon)]))

  // The stack lives at the bathroom's wet wall (else the first wet room's).
  const stackRoom = wetRooms.find((r) => r.category === 'bathroom') ?? (wetRooms[0] as RoomSlice)
  const stackWall = wetWallFor(stackRoom, walls, core)
  if (!stackWall) return { members, fixtures }
  const stackAt = nearestOnWall(stackWall, polygonCentroid(stackRoom.polygon)).point
  const stackHeight = stackWall.height + 0.6 // through-roof vent (P3103.1)

  members.push({
    system: 'plumbing',
    role: 'vent-stack',
    dims: [STACK_SIDE, stackHeight, STACK_SIDE],
    length: stackHeight,
    position: [stackAt[0], stackHeight / 2, stackAt[1]],
    rotation: [0, 0, 0],
    material: 'pvc',
    sourceId: stackRoom.id,
    label: '3" DWV vent stack (through roof)',
  })
  fixtures.push({
    system: 'plumbing',
    kind: 'cleanout',
    position: [stackAt[0], 0.15, stackAt[1]],
    rotationY: 0,
    sourceId: stackRoom.id,
    label: 'Cleanout (P3005.2)',
  })

  // Per wet room: stub-outs on its wet wall + schematic drain/supply runs
  // back to the stack.
  for (const room of wetRooms) {
    const wall = wetWallFor(room, walls, core)
    if (!wall) continue
    const centroid = polygonCentroid(room.polygon)
    const at = nearestOnWall(wall, centroid).point
    // Face the room: normal pointing from the wall point toward the centroid.
    const nx = centroid[0] - at[0]
    const nz = centroid[1] - at[1]
    const rotationY = Math.atan2(nx, nz)

    const stubs: { kind: Fixture['kind']; y: number; label: string; offset: number }[] =
      room.category === 'bathroom'
        ? [
            { kind: 'stub-out', y: inches(12), label: 'Toilet rough-in 12" off wall', offset: -0.4 },
            {
              kind: 'stub-out',
              y: inches(rules.plumbing?.fixtureRoughIn?.lavHeightIn ?? 21),
              label: 'Lavatory supply/drain',
              offset: 0.4,
            },
          ]
        : room.category === 'kitchen'
          ? [{ kind: 'stub-out', y: inches(18), label: 'Kitchen sink supply/drain', offset: 0 }]
          : [{ kind: 'stub-out', y: inches(42), label: 'Laundry box', offset: 0 }]

    for (const stub of stubs) {
      fixtures.push({
        system: 'plumbing',
        kind: stub.kind,
        position: [
          at[0] + wall.dir[0] * stub.offset,
          stub.y,
          at[1] + wall.dir[1] * stub.offset,
        ],
        rotationY,
        sourceId: room.id,
        label: stub.label,
      })
    }

    // Schematic runs to the stack — main size from the stack room, branch
    // size elsewhere. Supplies (hot/cold pair) ride above the drain.
    const isStackRoom = room.id === stackRoom.id
    const drainSide = isStackRoom ? MAIN_DRAIN : BRANCH_DRAIN
    const drain = run(
      at,
      stackAt,
      0.08,
      drainSide,
      'pvc',
      'pipe-run',
      room.id,
      `${isStackRoom ? '3"' : '2"'} drain (schematic)`,
    )
    if (drain) members.push(drain)
    for (const lateral of [-0.06, 0.06]) {
      const supply = run(
        [at[0] + wall.dir[0] * lateral, at[1] + wall.dir[1] * lateral],
        [stackAt[0] + wall.dir[0] * lateral, stackAt[1] + wall.dir[1] * lateral],
        0.4,
        SUPPLY_SIDE,
        'copper',
        'pipe-run',
        room.id,
        `Supply ${lateral < 0 ? 'hot' : 'cold'} ¾" (schematic)`,
      )
      if (supply) members.push(supply)
    }
  }

  // Water heater: laundry > garage > near the stack.
  const whRoom =
    rooms.find((r) => r.category === 'laundry') ?? rooms.find((r) => r.category === 'garage')
  const whAt = whRoom ? polygonCentroid(whRoom.polygon) : [stackAt[0] + 0.6, stackAt[1] + 0.6]
  fixtures.push({
    system: 'plumbing',
    kind: 'water-heater',
    position: [whAt[0] as number, 0.6, whAt[1] as number],
    rotationY: 0,
    sourceId: whRoom?.id ?? stackRoom.id,
    label: 'Water heater',
  })

  return { members, fixtures }
}
