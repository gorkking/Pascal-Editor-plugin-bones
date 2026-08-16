/**
 * Plumbing engine — DWV + supply. Pure function:
 * (WallSlice[], RoomSlice[], FramingSpec, PlacedFixtureSlice[]) → {members, fixtures}.
 *
 * TWO paths:
 *  - PLACED fixtures (the items the user actually dropped — toilet, shower,
 *    sinks…) are the demand points: a water-service meter + ¾" cold main, a
 *    water heater placed like the electrical panel (garage tank / exterior
 *    tankless), per-fixture hot+cold homeruns along the wall graph, and a
 *    real DWV tree — trap → trap arm (P3105.1 limits) → DFU-sized branches
 *    (P3004.1 / P3005.4.1, never decreasing downstream, ≥3" once a WC is
 *    upstream) falling at the P3005.3 slope under the slab to a 3" stack,
 *    building drain and sewer-exit cleanout.
 *  - No placed fixtures → the original room-category fallback below.
 *
 * The room-category fallback mirrors how residential plumbing is organized
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
import { feet, inches, toFeet } from '../core/units'
import type { PlacedFixtureSlice } from '../core/wall-model'
import {
  buildWallGraph,
  clearOfOpenings,
  nearestWallPoint,
  openingSpans,
  panelMountU,
  pointInPolygon,
  wallPath,
  wallPlan,
  type WallPoint,
} from './electrical'

type Pt = readonly [number, number]

const rules = mepRules as {
  plumbing?: {
    dwv?: {
      buildingDrainIn?: number
      ventStackIn?: number
      slopeInPerFtBySize?: Record<string, number>
      maxTrapArmFtBySize?: Record<string, number>
      maxDfuHorizontalBranchBySize?: Record<string, number>
      maxDfuBuildingDrainBySizeAtQuarterInSlope?: Record<string, number>
    }
    supply?: { mainIn?: number; branchIn?: number }
    fixtureRoughIn?: {
      toiletCenterFromWallIn?: number
      lavHeightIn?: number
      toiletSupplyHeightIn?: number
      lavSupplyHeightIn?: number
      lavDrainHeightIn?: number
      showerValveHeightIn?: number
      tubValveHeightIn?: number
    }
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
// Below the electrical drill band (WIRE_RUN_Y 0.457 + 12mm/circuit): hot
// tops out at 0.34 + 5*0.008 = 0.38, leaving >= 6cm of stud between the
// trades (verify round D2: hot homeruns interpenetrated circuit runs).
const SUPPLY_COLD_Y = 0.28
const SUPPLY_HOT_Y = 0.34

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
 * dropping `slope` per unit of plan length when `sloped`. Returns the
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
  minLen = 0.05,
  slope = DRAIN_SLOPE,
): number {
  const dx = to[0] - from[0]
  const dz = to[1] - from[1]
  const plan = Math.hypot(dx, dz)
  if (plan < minLen) return yHigh
  const drop = sloped ? plan * slope : 0
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
  slope = DRAIN_SLOPE,
): number {
  const elbow: Pt = [to[0], from[1]]
  const y1 = leg(members, spec, from, elbow, yHigh, sloped, 0.05, slope)
  return leg(members, spec, elbow, to, y1, sloped, 0.05, slope)
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
  // Only true no-ops are dropped — a kitchen hot stub 1.8cm above the hot
  // plane still deserves its riser (round-6 advisory).
  if (length < 0.008) return
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
// Placed-fixture engine (LOD 400 rebuild): the items the user dropped are
// the demand points; the room-category path stays as the fallback.
// ---------------------------------------------------------------------------

/** IRC P3005.3 slope for a nominal size: 1/4"/ft ≤ 2.5", 1/8"/ft ≥ 3". */
function slopeFor(sizeIn: number): number {
  const table = rules.plumbing?.dwv?.slopeInPerFtBySize ?? {}
  const inPerFt = table[String(sizeIn)] ?? (sizeIn >= 3 ? 0.125 : 0.25)
  return inPerFt / 12
}

/** IRC Table P3105.1 trap-arm limit (m, trap weir → vent) for a trap size. */
function trapArmMax(sizeIn: number): number {
  return feet(rules.plumbing?.dwv?.maxTrapArmFtBySize?.[String(sizeIn)] ?? 8)
}

/** Nominal drain sizes the engine stocks (2.5" is skipped — uncommon). */
const BRANCH_SIZES = [1.5, 2, 3, 4] as const

/**
 * Smallest horizontal-branch size that carries `dfu` (Table P3005.4.1),
 * never below the largest upstream trap, ≥ 3" once a water closet is
 * upstream (P3005.4.1: no WC on a pipe smaller than 3").
 */
function branchSize(dfu: number, minIn: number, hasWC: boolean): number {
  const table = rules.plumbing?.dwv?.maxDfuHorizontalBranchBySize ?? {}
  const floor = Math.max(minIn, hasWC ? 3 : 1.5)
  for (const size of BRANCH_SIZES) {
    if (size < floor) continue
    if (dfu <= (table[String(size)] ?? Number.POSITIVE_INFINITY)) return size
  }
  return 4
}

/** Supply rough-in stub heights (fixtureRoughIn.* — practice defaults). */
const STUB_HEIGHT: Record<PlacedFixtureSlice['kind'], number> = {
  toilet: inches(rules.plumbing?.fixtureRoughIn?.toiletSupplyHeightIn ?? 7),
  lavatory: inches(rules.plumbing?.fixtureRoughIn?.lavSupplyHeightIn ?? 21),
  shower: inches(rules.plumbing?.fixtureRoughIn?.showerValveHeightIn ?? 44),
  bathtub: inches(rules.plumbing?.fixtureRoughIn?.tubValveHeightIn ?? 30),
  'clothes-washer': inches(42), // laundry outlet box — practice, not code
  'kitchen-sink': inches(18), // supplies under the sink — practice
}

/** Where the fixture's tailpiece meets its trap (drop start height). */
const DRAIN_CONN_Y: Record<PlacedFixtureSlice['kind'], number> = {
  toilet: 0, // closet flange at the floor
  lavatory: inches(rules.plumbing?.fixtureRoughIn?.lavDrainHeightIn ?? 19),
  shower: 0, // floor drain
  bathtub: 0,
  'clothes-washer': inches(30), // 2" standpipe trap
  'kitchen-sink': inches(18),
}

const KIND_LABEL: Record<PlacedFixtureSlice['kind'], string> = {
  toilet: 'Toilet',
  lavatory: 'Lavatory',
  shower: 'Shower',
  bathtub: 'Bathtub',
  'clothes-washer': 'Clothes washer',
  'kitchen-sink': 'Kitchen sink',
}

/** Per-branch plane step (like electrical's per-circuit drill planes). */
const SUPPLY_STEP = 0.008
/** Anchors must clear ROs across the whole stub band (44" shower valve). */
const ANCHOR_CLEAR_TOP = 1.25
/** A fixture farther than this from any wall is an island (air-run + flag). */
const ISLAND_DIST = 1.2

const round1ft = (m: number): number => Math.round(toFeet(m) * 10) / 10

/**
 * One level pipe leg along a wall at `runY`, detouring around any rough
 * opening crossing that plane — over the header when wall remains above,
 * under the sill otherwise. Supply and vent pipes may jog like cable
 * (checklist P5 inherits invariant E1); drains never route through here.
 */
function pipeWallLeg(
  members: Member[],
  spec: PipeSpec,
  wall: WallSlice,
  u0: number,
  u1: number,
  runY: number,
): void {
  const dir = Math.sign(u1 - u0) || 1
  const legLo = Math.min(u0, u1)
  const legHi = Math.max(u0, u1)
  const crossed = openingSpans(wall, runY - 0.02, runY + 0.02)
    .filter((s) => s.lo < legHi && s.hi > legLo)
    .sort((a, b) => (a.lo - b.lo) * dir)
  const at = (u: number): Pt => [wall.start[0] + wall.dir[0] * u, wall.start[1] + wall.dir[1] * u]
  const clamp = (u: number) => Math.max(legLo, Math.min(legHi, u))
  let cursor = u0
  for (const s of crossed) {
    const near = clamp(dir > 0 ? s.lo : s.hi)
    const far = clamp(dir > 0 ? s.hi : s.lo)
    const blockedAt = (yy: number) =>
      openingSpans(wall, yy - 0.02, yy + 0.02).some((o) => o.lo < s.hi && o.hi > s.lo)
    let detourY: number | null = null
    // start 7in over the header (electrical crosses at +4in — verify round
    // D2: coincident 0.95m pipe/wire segments over the same door)
    for (let yy = s.topY + inches(7); yy <= wall.height - 0.05; yy += inches(4)) {
      if (!blockedAt(yy)) {
        detourY = yy
        break
      }
    }
    if (detourY === null) {
      for (let yy = s.sillY - inches(7); yy >= 0.04; yy -= inches(4)) {
        if (!blockedAt(yy)) {
          detourY = yy
          break
        }
      }
    }
    if (detourY === null) {
      // RO spans floor to ceiling — nowhere inside this wall to route.
      leg(
        members,
        { ...spec, label: `${spec.label} (⚠ crosses full-height opening — verify)` },
        at(cursor),
        at(far),
        runY,
        false,
        0.015,
      )
      cursor = far
      continue
    }
    leg(members, spec, at(cursor), at(near), runY, false, 0.015)
    riser(members, spec, at(near), runY, detourY)
    leg(members, spec, at(near), at(far), detourY, false, 0.015)
    riser(members, spec, at(far), detourY, runY)
    cursor = far
  }
  leg(members, spec, at(cursor), at(u1), runY, false, 0.015)
}

/**
 * Route a level pipe between two wall anchors following the wall graph at
 * `runY` (buildWallGraph BFS — same rails as electrical homeruns), bridging
 * junction gaps explicitly. Disconnected wall islands fall back to flagged
 * Manhattan air legs.
 */
function routePipe(
  members: Member[],
  spec: PipeSpec,
  graph: ReturnType<typeof buildWallGraph>,
  from: WallPoint,
  to: WallPoint,
  runY: number,
): void {
  const legs = wallPath(graph, from, to)
  if (legs) {
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i] as { wall: WallSlice; u0: number; u1: number }
      pipeWallLeg(members, spec, l.wall, l.u0, l.u1, runY)
      const next = legs[i + 1]
      if (next) {
        const a = wallPlan({ wall: l.wall, u: l.u1 })
        const b = wallPlan({ wall: next.wall, u: next.u0 })
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.015) {
          leg(members, { ...spec, label: `${spec.label} (junction jumper)` }, a, b, runY, false, 0.01)
        }
      }
    }
    return
  }
  const a = wallPlan(from)
  const b = wallPlan(to)
  manhattan(
    members,
    {
      ...spec,
      label: `${spec.label} (air run — no wall path, verify)`,
      flag: spec.flag ?? `AIR RUN: ${spec.label} found no wall path — route under floor/ceiling`,
    },
    a,
    b,
    runY,
    false,
  )
}

/** One anchored fixture in the DWV/supply solve. */
type Anchored = {
  f: PlacedFixtureSlice
  anchor: WallPoint
  /** Wall-anchor plan point (stub bay, clear of ROs). */
  plan: Pt
  /** Too far from every wall — island air-run fallback. */
  island: boolean
  /** Where the stub-out fixture sits (the wall bay; the item itself for islands). */
  stubAt: Pt
  stubY: number
  /** Trap-arm plan length fixture → anchor. */
  armLen: number
  /** Manhattan distance anchor → stack (drain-tree ordering). */
  dist: number
  /** Drain rise above the stack base at this node (P3005.3 chaining). */
  rise: number
  /** Drain-tree parent (index into the anchored list; -1 = the stack). */
  parent: number
  /** Downstream accumulation: subtree DFU / largest trap / WC upstream. */
  subDfu: number
  subMaxDrain: number
  subWC: boolean
  /** Size (in) of the branch edge from this node toward its parent. */
  edgeSize: number
}

/**
 * The placed-fixture engine. Geometry contract (gated in
 * plumbing.connectivity.test.ts, checklist row P5):
 *  - every fixture is cold-reachable from the service meter, hot fixtures
 *    hot-reachable from the water heater, as physically continuous pipe;
 *  - every trap drains to the sewer exit along a strictly falling path;
 *  - no pipe crosses a rough opening (supply/vents detour like cable);
 *  - trap arms over the P3105.1 limit carry flags.
 */
function placedPlumbing(
  walls: WallSlice[],
  rooms: RoomSlice[],
  spec: FramingSpec,
  placed: PlacedFixtureSlice[],
): { members: Member[]; fixtures: Fixture[] } {
  const members: Member[] = []
  const fixtures: Fixture[] = []
  const fab = spec.detail !== '200' // traps/vents/supply branches gate
  const straight = walls.filter((w) => !w.curved && w.length >= 0.1)
  if (straight.length === 0) return { members, fixtures }
  const graph = buildWallGraph(walls)

  // ---- anchors: snap each fixture to its nearest wall stud bay, clear of
  // every RO the stub/vent band crosses ----
  const anchored: Anchored[] = []
  for (const f of placed) {
    const anchor = nearestWallPoint(walls, f.plan, ANCHOR_CLEAR_TOP)
    if (!anchor) continue
    const plan = wallPlan(anchor) as Pt
    const armLen = Math.hypot(plan[0] - f.plan[0], plan[1] - f.plan[1])
    const island = armLen > ISLAND_DIST
    anchored.push({
      f,
      anchor,
      plan,
      island,
      stubAt: island ? f.plan : plan,
      stubY: STUB_HEIGHT[f.kind],
      armLen,
      dist: 0,
      rise: 0,
      parent: -1,
      subDfu: f.dfu,
      subMaxDrain: f.drainIn,
      subWC: f.kind === 'toilet',
      edgeSize: 3,
    })
  }
  if (anchored.length === 0) return { members, fixtures }

  // ---- the stack lands on the wall nearest the DFU-weighted centroid (the
  // wet wall carrying the most drainage) ----
  const totalDfu = anchored.reduce((s, a) => s + a.f.dfu, 0)
  const wx = anchored.reduce((s, a) => s + a.f.plan[0] * a.f.dfu, 0) / Math.max(1, totalDfu)
  const wz = anchored.reduce((s, a) => s + a.f.plan[1] * a.f.dfu, 0) / Math.max(1, totalDfu)
  const stackAnchor = nearestWallPoint(walls, [wx, wz], Number.POSITIVE_INFINITY)
  if (!stackAnchor) return { members, fixtures }
  const stackAt = wallPlan(stackAnchor) as Pt

  // ---- drain tree: each node's parent is the nearest node strictly closer
  // to the stack (acyclic by construction; distances only fall downstream) ----
  for (const a of anchored) a.dist = manhattanDist(a.plan, stackAt)
  const order = anchored
    .map((_, i) => i)
    .sort((i, j) => (anchored[i] as Anchored).dist - (anchored[j] as Anchored).dist)
  for (const i of order) {
    const me = anchored[i] as Anchored
    let best = -1
    let bestDist = me.dist // default parent: the stack itself
    for (let j = 0; j < anchored.length; j++) {
      if (j === i) continue
      const other = anchored[j] as Anchored
      if (other.dist >= me.dist - 0.01) continue
      const d = manhattanDist(me.plan, other.plan)
      if (d < bestDist) {
        bestDist = d
        best = j
      }
    }
    me.parent = best
  }
  // Downstream DFU accumulation (children first — farthest nodes first).
  for (let k = order.length - 1; k >= 0; k--) {
    const me = anchored[order[k] as number] as Anchored
    if (me.parent >= 0) {
      const p = anchored[me.parent] as Anchored
      p.subDfu += me.subDfu
      p.subMaxDrain = Math.max(p.subMaxDrain, me.subMaxDrain)
      p.subWC = p.subWC || me.subWC
    }
  }
  // Edge sizes + heights, root outward: h(child) = h(parent) + run × slope
  // (IRC P3005.3) — sizes never decrease downstream because downstream
  // subtrees are supersets.
  for (const i of order) {
    const me = anchored[i] as Anchored
    me.edgeSize = branchSize(me.subDfu, me.subMaxDrain, me.subWC)
    const parent = me.parent >= 0 ? (anchored[me.parent] as Anchored) : null
    const pPlan = parent ? parent.plan : stackAt
    const pRise = parent ? parent.rise : 0
    me.rise = pRise + manhattanDist(me.plan, pPlan) * slopeFor(me.edgeSize)
  }
  // Bury the whole DWV tree under the slab: the stack base sits deep enough
  // that the farthest trap arm still arrives below floor level.
  let maxRise = 0
  for (const a of anchored) {
    maxRise = Math.max(maxRise, a.rise + a.armLen * slopeFor(a.f.drainIn))
  }
  const base = -(maxRise + 0.12)

  // ---- stack: below the building drain up through the roof (P3103.1) ----
  const stackTop = stackAnchor.wall.height + 0.6
  members.push({
    system: 'plumbing',
    role: 'vent-stack',
    dims: [STACK_SIDE, stackTop - base, STACK_SIDE],
    length: stackTop - base,
    position: [stackAt[0], (stackTop + base) / 2, stackAt[1]],
    rotation: [0, 0, 0],
    material: 'pvc',
    sourceId: 'dwv-stack',
    label: '3" DWV stack — through roof (P3103.1)',
  })
  fixtures.push({
    system: 'plumbing',
    kind: 'cleanout',
    position: [stackAt[0], 0.15, stackAt[1]],
    rotationY: 0,
    sourceId: 'dwv-stack',
    label: 'Cleanout at stack base (P3005.2)',
  })

  // ---- per fixture: stub-out + P-trap + trap arm + DFU-sized branch ----
  for (const a of anchored) {
    const rotationY = a.island
      ? a.f.yaw
      : Math.atan2(a.f.plan[0] - a.plan[0], a.f.plan[1] - a.plan[1])
    fixtures.push({
      system: 'plumbing',
      kind: 'stub-out',
      position: [a.stubAt[0], a.stubY, a.stubAt[1]],
      rotationY,
      sourceId: a.f.id,
      label: `${KIND_LABEL[a.f.kind]} rough-in — supply @ ${Math.round(a.stubY / 0.0254)}" AFF, ${a.f.drainIn}" trap`,
      meta: { fixtureId: a.f.id, kind: a.f.kind, hot: a.f.hot, dfu: a.f.dfu },
    })

    const drainSide = pipeSide(Math.max(a.f.drainIn, 1.25))
    const yNode = base + a.rise
    if (fab) {
      // IRC P2705.1: WC centerline ≥ 30" center-to-center from neighbors —
      // measured WITHIN a room: a wall between the two fixtures means
      // back-to-back bathrooms, not a clearance violation (verify round D5).
      const wallBetween = (pA: Pt, pB: Pt): boolean =>
        walls.some((w) => {
          const q1: Pt = w.start
          const q2: Pt = [w.start[0] + w.dir[0] * w.length, w.start[1] + w.dir[1] * w.length]
          const d = (o: Pt, e: Pt, pt: Pt) => (e[0] - o[0]) * (pt[1] - o[1]) - (e[1] - o[1]) * (pt[0] - o[0])
          const d1 = d(pA, pB, q1)
          const d2 = d(pA, pB, q2)
          const d3 = d(q1, q2, pA)
          const d4 = d(q1, q2, pB)
          return d1 * d2 < 0 && d3 * d4 < 0
        })
      const crowd =
        a.f.kind === 'toilet'
          ? placed.find(
              (o) =>
                o.id !== a.f.id &&
                Math.hypot(o.plan[0] - a.f.plan[0], o.plan[1] - a.f.plan[1]) < inches(30) &&
                !wallBetween(a.f.plan, o.plan),
            )
          : undefined
      const yArm = yNode + a.armLen * slopeFor(a.f.drainIn)
      // A fixture dropped inside a door/window rough opening puts its trap
      // riser THROUGH the RO — never silent (verify round D4: unflagged
      // 1.25" riser through a doorway).
      const riserTop = Math.max(DRAIN_CONN_Y[a.f.kind], 0.5)
      const inRO = walls.some((w) => {
        const dx = a.f.plan[0] - w.start[0]
        const dz = a.f.plan[1] - w.start[1]
        const u = dx * w.dir[0] + dz * w.dir[1]
        const off = Math.abs(-dx * w.dir[1] + dz * w.dir[0])
        if (off > w.thickness / 2 + 0.06 || u < 0 || u > w.length) return false
        return openingSpans(w, 0, riserTop).some((sp) => u > sp.lo && u < sp.hi)
      })
      const roFlag = inRO
        ? `OPENING: ${KIND_LABEL[a.f.kind]} sits in a door/window rough opening — its trap riser crosses the RO; move the fixture`
        : undefined
      riser(
        members,
        {
          side: drainSide,
          material: 'pvc',
          role: 'pipe-run',
          sourceId: `dwv-trap-${a.f.id}`,
          label: `${a.f.drainIn}" P-trap + drop — ${KIND_LABEL[a.f.kind]} (P3201)`,
          flag:
            roFlag ??
            (crowd
              ? `CLEARANCE: ${KIND_LABEL[crowd.kind]} sits within 30" of the WC centerline (P2705.1)`
              : undefined),
        },
        a.f.plan,
        DRAIN_CONN_Y[a.f.kind],
        yArm,
      )
      // Trap arm to the wet wall — Table P3105.1 length limit by trap size
      // (WCs are exempt in the IRC; flagged anyway when clearly unroutable).
      const limit = trapArmMax(a.f.drainIn)
      leg(
        members,
        {
          side: drainSide,
          material: 'pvc',
          role: 'pipe-run',
          sourceId: `dwv-arm-${a.f.id}`,
          label: `${a.f.drainIn}" trap arm — ${KIND_LABEL[a.f.kind]} (≤ ${toFeet(limit).toFixed(0)} ft, P3105.1)`,
          flag:
            a.armLen > limit
              ? `TRAP ARM: ${KIND_LABEL[a.f.kind]} sits ${round1ft(a.armLen)} ft from its wall — exceeds ${toFeet(limit).toFixed(0)} ft for a ${a.f.drainIn}" arm (P3105.1); move it closer or vent at the island`
              : undefined,
        },
        a.f.plan,
        a.plan,
        yArm,
        true,
        0.015,
        slopeFor(a.f.drainIn),
      )
    }
    // Branch drain toward the parent node — DFU-sized (P3004.1/P3005.4.1),
    // falling at the P3005.3 slope for its size.
    const pPlan = a.parent >= 0 ? (anchored[a.parent] as Anchored).plan : stackAt
    manhattan(
      members,
      {
        side: pipeSide(a.edgeSize),
        material: 'pvc',
        role: 'pipe-run',
        sourceId: `dwv-branch-${a.f.id}`,
        label: `${a.edgeSize}" branch drain — ${a.subDfu} DFU @ ${a.edgeSize >= 3 ? '1/8' : '1/4'}"/ft (P3004.1, P3005.3)`,
      },
      a.plan,
      pPlan,
      yNode,
      true,
      slopeFor(a.edgeSize),
    )
  }

  // ---- building drain: stack base → sewer-exit cleanout at the nearest
  // exterior point, at 1/4"/ft (preferred practice even for 3") ----
  const core: Pt = [wx, wz]
  let exit: Pt = nearestExteriorPoint(walls, stackAt) ?? [stackAt[0] + 1, stackAt[1]]
  if (manhattanDist(stackAt, exit) < 0.3) {
    const ox = exit[0] - core[0]
    const oz = exit[1] - core[1]
    const n = Math.max(1e-6, Math.hypot(ox, oz))
    exit = [exit[0] + (ox / n) * 0.6, exit[1] + (oz / n) * 0.6]
  }
  const drainTable = rules.plumbing?.dwv?.maxDfuBuildingDrainBySizeAtQuarterInSlope ?? {}
  const cap3 = drainTable['3'] ?? 42
  const cap4 = drainTable['4'] ?? 216
  // No size reduction in the direction of flow (P3005.3 / module contract):
  // the main is at least the largest branch discharging into the stack
  // (verify round D3: a 4" branch fed a 3" main unflagged).
  const maxBranchIn = anchored.reduce((m, a) => Math.max(m, a.edgeSize), 0)
  const mainSize = Math.max(
    totalDfu > cap3 ? 4 : (rules.plumbing?.dwv?.buildingDrainIn ?? 3),
    maxBranchIn,
  )
  manhattan(
    members,
    {
      side: pipeSide(mainSize),
      material: 'pvc',
      role: 'pipe-run',
      sourceId: 'dwv-main',
      label: `${mainSize}" building drain — ${totalDfu} DFU @ 1/4"/ft to sewer (P3005.4.1)`,
      flag:
        totalDfu > cap4
          ? `UNDERSIZED: ${totalDfu} DFU exceeds ${cap4} on a 4" building drain (P3005.4.1) — engineered sizing required`
          : undefined,
    },
    stackAt,
    exit,
    base,
    true,
    0.25 / 12,
  )
  fixtures.push({
    system: 'plumbing',
    kind: 'cleanout',
    position: [exit[0], 0.15, exit[1]],
    rotationY: 0,
    sourceId: 'dwv-main',
    label: 'Cleanout @ sewer exit (P3005.2.1)',
  })

  // ---- re-vents: one per wet wall, rising to 6" above the flood rim and
  // returning to the stack along the wall graph (P3104.4) ----
  if (fab) {
    const ventWalls = new Map<string, Anchored>()
    for (const a of anchored) {
      if (a.island) continue
      const prev = ventWalls.get(a.anchor.wall.id)
      if (!prev || a.dist < prev.dist) ventWalls.set(a.anchor.wall.id, a)
    }
    for (const [wallId, a] of ventWalls) {
      if (manhattanDist(a.plan, stackAt) < 0.3) continue // the stack IS this wall's vent
      const ventSpec: PipeSpec = {
        side: VENT_SIDE,
        material: 'pvc',
        role: 'pipe-run',
        sourceId: `dwv-vent-${wallId}`,
        label: '1½" re-vent — reconnects 6" above flood rim (P3104.4)',
      }
      riser(members, ventSpec, a.plan, base + a.rise, VENT_RECONNECT_Y)
      routePipe(members, ventSpec, graph, a.anchor, stackAnchor, VENT_RECONNECT_Y)
    }
  }

  // ---- main water service: meter on the longest exterior wall, clear of
  // ROs (P2903.7: ¾" minimum service) ----
  const exterior = straight.filter((w) => w.exterior)
  const meterWall = [...(exterior.length > 0 ? exterior : straight)].sort(
    (p, q) => q.length - p.length,
  )[0] as WallSlice
  const meterU = clearOfOpenings(meterWall, panelMountU(meterWall), 0, ANCHOR_CLEAR_TOP)
  const meterAnchor: WallPoint = { wall: meterWall, u: meterU }
  const meterPlan = wallPlan(meterAnchor) as Pt
  const METER_Y = 0.3
  fixtures.push({
    system: 'plumbing',
    kind: 'water-meter',
    position: [meterPlan[0], METER_Y, meterPlan[1]],
    rotationY: 0,
    sourceId: meterWall.id,
    label: 'Water service meter — ¾" min (P2903.7)',
  })

  // ---- water heater: garage wall like the electrical panel (tank, M1307.3
  // 18" ignition height) — else tankless on an exterior wall at 1.2 m AFF ----
  const facePoint = (wall: WallSlice, side: 1 | -1, u: number): Pt => [
    wall.start[0] + wall.dir[0] * u + -wall.dir[1] * side * (wall.thickness / 2 + 0.08),
    wall.start[1] + wall.dir[1] * u + wall.dir[0] * side * (wall.thickness / 2 + 0.08),
  ]
  const garages = rooms.filter((r) => r.category === 'garage')
  const boundsGarage = (wall: WallSlice): RoomSlice | undefined =>
    garages.find(
      (g) =>
        g.boundaryWallIds.includes(wall.id) ||
        pointInPolygon(facePoint(wall, 1, wall.length / 2), g.polygon) ||
        pointInPolygon(facePoint(wall, -1, wall.length / 2), g.polygon),
    )
  const garageWall = straight
    .filter((w) => boundsGarage(w) !== undefined)
    .sort((p, q) => q.length - p.length)[0]
  const tank = garageWall !== undefined
  const whWall = garageWall ?? meterWall
  const whURaw = (() => {
    if (whWall === meterWall) return Math.min(whWall.length - 0.4, meterU + 1.2)
    // The electrical panel claims panelMountU on this SAME wall (both
    // trades elect the longest garage wall) — keep the tank a panel-width
    // + NEC 110.26 working space away (verify round D1: the 50-gal tank
    // ENGULFED the panel).
    const panelU = panelMountU(whWall)
    const off = 1.2
    return panelU + off <= whWall.length - 0.4 ? panelU + off : Math.max(0.4, panelU - off)
  })()
  const whU = clearOfOpenings(whWall, whURaw, 0, 2.1)
  const whAnchor: WallPoint = { wall: whWall, u: whU }
  const whWallPlan = wallPlan(whAnchor) as Pt
  let side: 1 | -1 = 1
  if (garageWall) {
    const g = boundsGarage(garageWall)
    if (g && pointInPolygon(facePoint(garageWall, -1, whU), g.polygon)) side = -1
  } else if (rooms.some((r) => pointInPolygon(facePoint(whWall, -1, whU), r.polygon))) {
    side = -1
  }
  const whOff = tank ? 0.35 : whWall.thickness / 2 + 0.13
  const nx = -whWall.dir[1] * side
  const nz = whWall.dir[0] * side
  const whPlan: Pt = [whWallPlan[0] + nx * whOff, whWallPlan[1] + nz * whOff]
  const whDims: readonly [number, number, number] = tank ? [0.6, 1.5, 0.6] : [0.45, 0.6, 0.25]
  const whBottom = tank ? inches(18) : 1.2 // M1307.3 garage ignition height
  const whCenterY = whBottom + whDims[1] / 2
  members.push({
    system: 'plumbing',
    role: 'water-heater',
    dims: whDims,
    length: whDims[1],
    position: [whPlan[0], whCenterY, whPlan[1]],
    rotation: [0, Math.atan2(nx, nz), 0],
    material: 'steel',
    sourceId: 'wh',
    label: tank
      ? 'Water heater — 50 gal tank (M1305.1 30×30" service space, M1307.3 18" ignition height)'
      : 'Tankless water heater — wall-mounted 1.2 m AFF (M1305.1 service space)',
  })
  fixtures.push({
    system: 'plumbing',
    kind: 'water-heater',
    position: [whPlan[0], whCenterY, whPlan[1]],
    rotationY: Math.atan2(nx, nz),
    sourceId: 'wh',
    label: tank ? 'Water heater (50 gal tank)' : 'Water heater (tankless)',
  })

  // ---- supply: ¾" cold main meter → WH, manifolds at the WH wall, then
  // ½" hot/cold homeruns along the wall graph on stepped planes ----
  if (fab) {
    const mainSpec: PipeSpec = {
      side: SUPPLY_MAIN,
      material: 'copper',
      role: 'pipe-run',
      sourceId: 'cold-main',
      label: 'Cold main ¾" — water service (P2903.7)',
    }
    riser(members, mainSpec, meterPlan, METER_Y, SUPPLY_COLD_Y)
    routePipe(members, mainSpec, graph, meterAnchor, whAnchor, SUPPLY_COLD_Y)
    // Manifold riser at the WH wall bay: crosses every stepped cold plane,
    // then feeds the tank inlet.
    riser(members, mainSpec, whWallPlan, SUPPLY_COLD_Y, whCenterY)
    leg(members, mainSpec, whWallPlan, whPlan, whCenterY, false, 0.015)
    const hotMain: PipeSpec = {
      side: SUPPLY_MAIN,
      material: 'copper',
      role: 'pipe-run',
      sourceId: 'hot-main',
      label: 'Hot header ¾" — from water heater',
    }
    const hotHeaderY = whCenterY - 0.1
    leg(members, hotMain, whPlan, whWallPlan, hotHeaderY, false, 0.015)
    riser(members, hotMain, whWallPlan, hotHeaderY, SUPPLY_HOT_Y)

    let coldIdx = 0
    let hotIdx = 0
    for (const a of anchored) {
      const coldY = SUPPLY_COLD_Y + (coldIdx++ % 6) * SUPPLY_STEP
      const cold: PipeSpec = {
        side: SUPPLY_BRANCH,
        material: 'copper',
        role: 'pipe-run',
        sourceId: `cold-${a.f.id}`,
        label: `Cold ½" — ${KIND_LABEL[a.f.kind]}`,
      }
      routePipe(members, cold, graph, whAnchor, a.anchor, coldY)
      riser(members, cold, a.plan, coldY, a.stubY)
      if (a.island) {
        manhattan(
          members,
          {
            ...cold,
            label: `${cold.label} (island — air run under floor, verify)`,
            flag: `ISLAND: ${KIND_LABEL[a.f.kind]} sits ${round1ft(a.armLen)} ft from the nearest wall — supply routed as an air run; run it under the floor`,
          },
          a.plan,
          a.stubAt,
          a.stubY,
          false,
        )
      }
      if (a.f.hot) {
        const hotY = SUPPLY_HOT_Y + (hotIdx++ % 6) * SUPPLY_STEP
        const hot: PipeSpec = {
          side: SUPPLY_BRANCH,
          material: 'copper',
          role: 'pipe-run',
          sourceId: `hot-${a.f.id}`,
          label: `Hot ½" — ${KIND_LABEL[a.f.kind]} (WH loop)`,
        }
        // Hot drops in the same bay, nudged 1" along the wall so red and
        // blue never z-fight (lav spread is 8" in reality).
        const hotAt: Pt = [
          a.plan[0] + a.anchor.wall.dir[0] * 0.025,
          a.plan[1] + a.anchor.wall.dir[1] * 0.025,
        ]
        routePipe(members, hot, graph, whAnchor, a.anchor, hotY)
        leg(members, hot, a.plan, hotAt, hotY, false, 0.01)
        riser(members, hot, hotAt, hotY, a.stubY)
        if (a.island) {
          manhattan(
            members,
            { ...hot, label: `${hot.label} (island — air run under floor, verify)` },
            hotAt,
            a.stubAt,
            a.stubY,
            false,
          )
        }
      }
    }
  }

  return { members, fixtures }
}

// ---------------------------------------------------------------------------
// The engine — dispatcher + room-category fallback
// ---------------------------------------------------------------------------

/**
 * Lay out plumbing for one level. When the scene carries PLACED sanitary
 * fixtures they are the demand points; otherwise the room-category fallback
 * guesses a schematic layout from wet-room zones.
 */
export function layoutPlumbing(
  walls: WallSlice[],
  rooms: RoomSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
  placed: PlacedFixtureSlice[] = [],
): { members: Member[]; fixtures: Fixture[] } {
  if (placed.length > 0) {
    const result = placedPlumbing(walls, rooms, spec, placed)
    // Placed fixtures but no usable walls → let the fallback try (it
    // returns empty on wall-less scenes too, but never crashes).
    if (result.members.length > 0 || result.fixtures.length > 0) return result
  }
  return roomPlumbing(walls, rooms, spec)
}

type Stub = {
  kind: Fixture['kind']
  y: number
  label: string
  offset: number
  /** Toilets are cold-only — everything else joins the water-heater loop. */
  hot: boolean
}

/** Room-category fallback — used when the scene carries no placed fixtures. */
function roomPlumbing(
  walls: WallSlice[],
  rooms: RoomSlice[],
  spec: FramingSpec,
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
