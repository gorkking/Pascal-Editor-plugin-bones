/**
 * Plumbing engine — DWV + supply for wet rooms. Pure function:
 * (WallSlice[], RoomSlice[], FramingSpec) → {members, fixtures}.
 *
 * The layout logic mirrors how residential plumbing is actually organized
 * (docs/research/mep.md, data/mep-rules.json):
 *  - wet rooms (kitchen / bathroom / laundry) cluster around a shared
 *    plumbing core to minimize runs;
 *  - ONE 3" vent stack rises inside the wet wall nearest the bathroom and
 *    penetrates the roof (IRC P3102/P3103);
 *  - drains route MANHATTAN (axis-aligned legs, no diagonal air runs) and
 *    every horizontal run is rendered with the code slope — 1/4" per foot
 *    (P3005.3), so remote rooms arrive at the stack lower than they left;
 *  - the 3" building drain continues from the stack base to a sewer exit at
 *    the nearest exterior wall, with a cleanout at each end (P3005.2) and a
 *    DFU check against Table P3005.4.1 (flags when 3" is undersized);
 *  - each fixture stub drops to the drain plane (trap arm, P3105) and each
 *    remote room re-vents: a 1½" riser to 6" above the flood rim (P3104.4)
 *    then level legs back to the stack;
 *  - supplies split at the water heater: a ¾" cold service from the nearest
 *    exterior wall feeds the WH, ½" cold branches serve every stub, ½" hot
 *    branches (the WH loop) serve everything but toilets;
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
const SUPPLY_MAIN = pipeSide(0.75)
const SUPPLY_BRANCH = pipeSide(0.5)
const VENT_SIDE = pipeSide(1.5)

/** Schematic drain plane above the slab (renders inside the room volume). */
const DRAIN_Y = 0.08
/** P3005.3: horizontal DWV slope — 1/4" per foot = 1:48. */
export const DRAIN_SLOPE = 1 / 48
/** P3104.4: vents reconnect >= 6" above the fixture flood rim (~36" lav). */
const VENT_RECONNECT_Y = inches(42)
const SUPPLY_COLD_Y = 0.38
const SUPPLY_HOT_Y = 0.44

/**
 * Drainage fixture units per wet-room group (Table P3004.1: WC 3 + lav 1 +
 * tub/shower 2 = bathroom group 6; kitchen sink 2; laundry standpipe 2).
 */
export const DFU_BY_CATEGORY: Record<string, number> = {
  bathroom: 6,
  kitchen: 2,
  laundry: 2,
}
/** Table P3005.4.1: a 3" building drain at 1/4"/ft carries 42 DFU. */
export const MAIN_CAPACITY_DFU = 42

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

/** Nearest point on any exterior wall — the sewer/service exit. */
function nearestExteriorPoint(walls: WallSlice[], p: Pt): Pt | null {
  let best: Pt | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const wall of walls) {
    if (!wall.exterior || wall.curved) continue
    const { point, distance } = nearestOnWall(wall, p)
    if (distance < bestDist) {
      bestDist = distance
      best = point
    }
  }
  return best
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

// ---------------------------------------------------------------------------
// Pipe emitters
// ---------------------------------------------------------------------------

type PipeSpec = {
  side: number
  material: Member['material']
  role: Member['role']
  sourceId: string
  label: string
  flag?: string
}

/**
 * One horizontal pipe leg from `from` (HIGH end, at `yHigh`) to `to`,
 * dropping DRAIN_SLOPE per unit of plan length when `sloped`. Returns the
 * arrival height so chained legs keep falling. Rotation follows the rafter
 * convention: [0, ψ, tilt] with +X pointing uphill.
 */
function leg(
  members: Member[],
  spec: PipeSpec,
  from: Pt,
  to: Pt,
  yHigh: number,
  sloped: boolean,
): number {
  const dx = to[0] - from[0]
  const dz = to[1] - from[1]
  const plan = Math.hypot(dx, dz)
  if (plan < 0.05) return yHigh
  const drop = sloped ? plan * DRAIN_SLOPE : 0
  const yLow = yHigh - drop
  const length = Math.hypot(plan, drop)
  // +X must point UPHILL: from `to` (low) toward `from` (high).
  const yaw = Math.atan2(-(from[1] - to[1]), from[0] - to[0])
  members.push({
    system: 'plumbing',
    role: spec.role,
    dims: [length, spec.side, spec.side],
    length,
    position: [(from[0] + to[0]) / 2, (yHigh + yLow) / 2, (from[1] + to[1]) / 2],
    rotation: [0, yaw, sloped ? Math.atan2(drop, plan) : 0],
    material: spec.material,
    sourceId: spec.sourceId,
    label: spec.label,
    flag: spec.flag,
  })
  return yLow
}

/** Manhattan (X-leg then Z-leg) run; returns the arrival height. */
function manhattan(
  members: Member[],
  spec: PipeSpec,
  from: Pt,
  to: Pt,
  yHigh: number,
  sloped: boolean,
): number {
  const elbow: Pt = [to[0], from[1]]
  const y1 = leg(members, spec, from, elbow, yHigh, sloped)
  return leg(members, spec, elbow, to, y1, sloped)
}

/** Total Manhattan plan distance. */
const manhattanDist = (a: Pt, b: Pt): number => Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])

/** Vertical pipe segment at a plan point. */
function riser(
  members: Member[],
  spec: PipeSpec,
  at: Pt,
  y0: number,
  y1: number,
): void {
  const length = Math.abs(y1 - y0)
  if (length < 0.03) return
  members.push({
    system: 'plumbing',
    role: spec.role,
    dims: [spec.side, length, spec.side],
    length,
    position: [at[0], (y0 + y1) / 2, at[1]],
    rotation: [0, 0, 0],
    material: spec.material,
    sourceId: spec.sourceId,
    label: spec.label,
    flag: spec.flag,
  })
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

type Stub = {
  kind: Fixture['kind']
  y: number
  label: string
  offset: number
  /** Toilets are cold-only — everything else joins the water-heater loop. */
  hot: boolean
}

export function layoutPlumbing(
  walls: WallSlice[],
  rooms: RoomSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
): { members: Member[]; fixtures: Fixture[] } {
  const members: Member[] = []
  const fixtures: Fixture[] = []
  const fab = spec.detail !== '200' // traps/vents/supply branches gate
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

  // ---- per wet room: stubs + trap drops + sloped Manhattan branch drains ----
  for (const room of wetRooms) {
    const wall = wetWallFor(room, walls, core)
    if (!wall) continue
    const centroid = polygonCentroid(room.polygon)
    const at = nearestOnWall(wall, centroid).point
    // Face the room: normal pointing from the wall point toward the centroid.
    const nx = centroid[0] - at[0]
    const nz = centroid[1] - at[1]
    const rotationY = Math.atan2(nx, nz)

    const stubs: Stub[] =
      room.category === 'bathroom'
        ? [
            {
              kind: 'stub-out',
              y: inches(rules.plumbing?.fixtureRoughIn?.toiletCenterFromWallIn ?? 12),
              label: 'Toilet rough-in 12" off wall',
              offset: -0.4,
              hot: false,
            },
            {
              kind: 'stub-out',
              y: inches(rules.plumbing?.fixtureRoughIn?.lavHeightIn ?? 21),
              label: 'Lavatory supply/drain',
              offset: 0.4,
              hot: true,
            },
          ]
        : room.category === 'kitchen'
          ? [{ kind: 'stub-out' as const, y: inches(18), label: 'Kitchen sink supply/drain', offset: 0, hot: true }]
          : [{ kind: 'stub-out' as const, y: inches(42), label: 'Laundry box', offset: 0, hot: true }]

    // Branch size: the bathroom group carries the WC — its branch must be 3"
    // (P3005 water closets discharge to min 3"); sinks/laundry run 2".
    const isBathroom = room.category === 'bathroom'
    const drainSide = isBathroom ? MAIN_DRAIN : BRANCH_DRAIN
    const drainLabelSize = isBathroom ? '3"' : '2"'
    const dfu = DFU_BY_CATEGORY[room.category] ?? 2

    // Heights chain backward from the stack so every leg falls toward it.
    const branchPlan = manhattanDist(at, stackAt)
    const yAt = DRAIN_Y + branchPlan * DRAIN_SLOPE

    for (const stub of stubs) {
      const stubAt: Pt = [at[0] + wall.dir[0] * stub.offset, at[1] + wall.dir[1] * stub.offset]
      fixtures.push({
        system: 'plumbing',
        kind: stub.kind,
        position: [stubAt[0], stub.y, stubAt[1]],
        rotationY,
        sourceId: room.id,
        label: stub.label,
      })
      if (!fab) continue
      // Trap arm + drop: the fixture falls to its collector height, which
      // sits above yAt by the along-wall distance's worth of slope.
      const collectorY = yAt + Math.abs(stub.offset) * DRAIN_SLOPE
      riser(
        members,
        {
          side: BRANCH_DRAIN,
          material: 'pvc',
          role: 'pipe-run',
          sourceId: room.id,
          label: `Fixture drop + trap arm (within P3105 limit)`,
        },
        stubAt,
        stub.y,
        collectorY,
      )
      // Collector along the wet wall back to the branch point (sloped).
      leg(
        members,
        {
          side: drainSide,
          material: 'pvc',
          role: 'pipe-run',
          sourceId: room.id,
          label: `${drainLabelSize} branch drain (collector, 1/4"/ft)`,
        },
        stubAt,
        at,
        collectorY,
        true,
      )
    }

    // Branch drain to the stack: Manhattan, sloped 1/4"/ft, arriving at
    // DRAIN_Y. The bathroom usually shares the stack wall (zero length).
    manhattan(
      members,
      {
        side: drainSide,
        material: 'pvc',
        role: 'pipe-run',
        sourceId: room.id,
        label: `${drainLabelSize} branch drain — ${dfu} DFU, 1/4"/ft (P3005.3)`,
      },
      at,
      stackAt,
      yAt,
      true,
    )

    // Re-vent (P3104.4): rise to 6" above the flood rim at the branch point,
    // then run level back to the stack. The stack room IS the stack's vent.
    if (fab && branchPlan > 0.3) {
      const ventSpec: PipeSpec = {
        side: VENT_SIDE,
        material: 'pvc',
        role: 'pipe-run',
        sourceId: room.id,
        label: '1½" vent — reconnects 6" above flood rim (P3104.4)',
      }
      riser(members, ventSpec, at, yAt, VENT_RECONNECT_Y)
      manhattan(members, ventSpec, at, stackAt, VENT_RECONNECT_Y, false)
    }
  }

  // ---- 3" building drain: stack base → sewer exit at an exterior wall ----
  const totalDfu = wetRooms.reduce((sum, r) => sum + (DFU_BY_CATEGORY[r.category] ?? 2), 0)
  let exit: Pt = nearestExteriorPoint(walls, stackAt) ?? [stackAt[0] + 1, stackAt[1]]
  // A stack sitting ON the exterior wall still needs a real lateral — carry
  // the exit 0.6m past the wall (away from the wet core) toward the sewer.
  if (manhattanDist(stackAt, exit) < 0.3) {
    const ox = exit[0] - core[0]
    const oz = exit[1] - core[1]
    const n = Math.max(1e-6, Math.hypot(ox, oz))
    exit = [exit[0] + (ox / n) * 0.6, exit[1] + (oz / n) * 0.6]
  }
  const undersized = totalDfu > MAIN_CAPACITY_DFU
  manhattan(
    members,
    {
      side: MAIN_DRAIN,
      material: 'pvc',
      role: 'pipe-run',
      sourceId: stackRoom.id,
      label: `3" building drain — ${totalDfu} DFU @ 1/4"/ft to sewer`,
      flag: undersized
        ? `UNDERSIZED: ${totalDfu} DFU exceeds ${MAIN_CAPACITY_DFU} on a 3" building drain (P3005.4.1) — upsize to 4"`
        : undefined,
    },
    stackAt,
    exit,
    DRAIN_Y,
    true,
  )
  fixtures.push({
    system: 'plumbing',
    kind: 'cleanout',
    position: [exit[0], 0.15, exit[1]],
    rotationY: 0,
    sourceId: stackRoom.id,
    label: 'Cleanout @ sewer exit (P3005.2.1)',
  })

  // ---- supplies: cold service → WH; hot/cold branches to every stub ----
  const whRoom =
    rooms.find((r) => r.category === 'laundry') ?? rooms.find((r) => r.category === 'garage')
  const whAt: Pt = whRoom
    ? polygonCentroid(whRoom.polygon)
    : [stackAt[0] + 0.6, stackAt[1] + 0.6]
  fixtures.push({
    system: 'plumbing',
    kind: 'water-heater',
    position: [whAt[0], 0.6, whAt[1]],
    rotationY: 0,
    sourceId: whRoom?.id ?? stackRoom.id,
    label: 'Water heater',
  })

  if (fab) {
    // Cold water service from the nearest exterior wall to the WH.
    const service = nearestExteriorPoint(walls, whAt)
    if (service) {
      manhattan(
        members,
        {
          side: SUPPLY_MAIN,
          material: 'copper',
          role: 'pipe-run',
          sourceId: whRoom?.id ?? stackRoom.id,
          label: 'Supply cold ¾" — water service',
        },
        service,
        whAt,
        SUPPLY_COLD_Y,
        false,
      )
    }
    // Branches: cold to every stub, hot (the WH loop) to all but toilets.
    for (const room of wetRooms) {
      const wall = wetWallFor(room, walls, core)
      if (!wall) continue
      const at = nearestOnWall(wall, polygonCentroid(room.polygon)).point
      const stubs: { at: Pt; y: number; hot: boolean }[] =
        room.category === 'bathroom'
          ? [
              { at: [at[0] - wall.dir[0] * 0.4, at[1] - wall.dir[1] * 0.4], y: inches(12), hot: false },
              { at: [at[0] + wall.dir[0] * 0.4, at[1] + wall.dir[1] * 0.4], y: inches(21), hot: true },
            ]
          : [{ at, y: room.category === 'kitchen' ? inches(18) : inches(42), hot: true }]
      for (const stub of stubs) {
        const cold: PipeSpec = {
          side: SUPPLY_BRANCH,
          material: 'copper',
          role: 'pipe-run',
          sourceId: room.id,
          label: 'Supply cold ½"',
        }
        manhattan(members, cold, whAt, stub.at, SUPPLY_COLD_Y, false)
        riser(members, cold, stub.at, SUPPLY_COLD_Y, stub.y)
        if (stub.hot) {
          const hot: PipeSpec = {
            side: SUPPLY_BRANCH,
            material: 'copper',
            role: 'pipe-run',
            sourceId: room.id,
            label: 'Supply hot ½" (WH loop)',
          }
          manhattan(members, hot, whAt, stub.at, SUPPLY_HOT_Y, false)
          riser(members, hot, stub.at, SUPPLY_HOT_Y, stub.y)
        }
      }
    }
  }

  return { members, fixtures }
}
