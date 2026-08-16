import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import type { Fixture, Member, OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import { inches } from '../core/units'
import type { PlacedFixtureSlice } from '../core/wall-model'
import { endpointsOf, segDist } from './electrical.test-helpers'
import { layoutPlumbing } from './plumbing'

/**
 * Checklist invariant P5 — placed-fixture plumbing is PHYSICAL:
 *  (a) every stub-out is cold-reachable from the service meter as continuous
 *      pipe; hot fixtures are hot-reachable from the water heater;
 *  (b) every fixture's trap drains to the sewer exit;
 *  (c) drain paths only ever FALL toward the exit (walked as a directed
 *      graph — a rise anywhere breaks reachability);
 *  (d) no pipe crosses a rough opening (supply/vents detour like cable —
 *      invariant E1 applied to plumbing);
 *  (e) a fixture too far from any wall gets its trap-arm flag (P3105.1) and
 *      its island air-run flag — never a silent impossible run.
 *
 * endpointsOf resolves pitched drain legs through the full XYZ euler
 * (rotation[2] carries the P3005.3 fall), verified by (b)/(c) walking the
 * sloped tree end-to-end.
 */

// ---- scene builders (electrical.openings.test.ts pattern) ------------------

function makeWall(overrides: Partial<WallSlice> = {}): WallSlice {
  const start = overrides.start ?? [0, 0]
  const end = overrides.end ?? [4, 0]
  const dx = (end[0] ?? 0) - (start[0] ?? 0)
  const dz = (end[1] ?? 0) - (start[1] ?? 0)
  const length = Math.hypot(dx, dz)
  return {
    id: 'wall',
    start,
    end,
    dir: [dx / length, dz / length],
    length,
    thickness: 0.114,
    height: 2.5,
    exterior: true,
    openings: [],
    curved: false,
    ...overrides,
  }
}

const opening = (
  kind: 'door' | 'window',
  u: number,
  roughWidth: number,
  sillHeight: number,
  roughHeight: number,
): OpeningSlice => ({
  id: `${kind}_${u}`,
  kind,
  u,
  width: roughWidth - 0.05,
  roughWidth,
  height: roughHeight - 0.05,
  roughHeight,
  sillHeight,
})

const room = (
  id: string,
  category: RoomSlice['category'],
  polygon: [number, number][],
  boundaryWallIds: string[] = [],
): RoomSlice => ({ id, name: category, category, polygon, boundaryWallIds, ceilingHeight: 2.5 })

/** Placed-fixture builder with the stage-1 sanitary profiles baked in. */
const PROFILES: Record<
  PlacedFixtureSlice['kind'],
  { hot: boolean; dfu: number; drainIn: number }
> = {
  toilet: { hot: false, dfu: 3, drainIn: 3 },
  lavatory: { hot: true, dfu: 1, drainIn: 1.25 },
  shower: { hot: true, dfu: 2, drainIn: 2 },
  bathtub: { hot: true, dfu: 2, drainIn: 1.5 },
  'clothes-washer': { hot: true, dfu: 2, drainIn: 2 },
  'kitchen-sink': { hot: true, dfu: 2, drainIn: 1.5 },
}
const pf = (
  id: string,
  kind: PlacedFixtureSlice['kind'],
  plan: [number, number],
): PlacedFixtureSlice => ({ id, kind, plan, yaw: 0, ...PROFILES[kind] })

// ---- (a) supply reachability: union-find over pipe endpoints ---------------

const MERGE_TOL = 0.02
const ATTACH_TOL = 0.03

/**
 * unreachableDevices adapted for plumbing: pipes are pre-filtered by system
 * prefix (cold-/hot-/dwv-), the source is a point (meter or WH — not a
 * panel fixture), and targets carry their own attach tolerance.
 */
function unreachableFrom(
  pipes: Member[],
  source: readonly [number, number, number],
  sourceTol: number,
  targets: { id: string; position: readonly [number, number, number] }[],
  targetTol: number,
): string[] {
  const parent: number[] = pipes.map((_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r] as number
    let c = i
    while (parent[c] !== c) {
      const n = parent[c] as number
      parent[c] = r
      c = n
    }
    return r
  }
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }
  const ends = pipes.map(endpointsOf)
  for (let i = 0; i < pipes.length; i++) {
    for (let j = i + 1; j < pipes.length; j++) {
      const [a1, a2] = ends[i] as [Vector3, Vector3]
      const [b1, b2] = ends[j] as [Vector3, Vector3]
      const touch =
        a1.distanceTo(b1) < MERGE_TOL ||
        a1.distanceTo(b2) < MERGE_TOL ||
        a2.distanceTo(b1) < MERGE_TOL ||
        a2.distanceTo(b2) < MERGE_TOL ||
        segDist(a1, b1, b2) < ATTACH_TOL ||
        segDist(a2, b1, b2) < ATTACH_TOL ||
        segDist(b1, a1, a2) < ATTACH_TOL ||
        segDist(b2, a1, a2) < ATTACH_TOL
      if (touch) union(i, j)
    }
  }
  const componentsNear = (p: Vector3, tol: number): Set<number> => {
    const comps = new Set<number>()
    for (let i = 0; i < pipes.length; i++) {
      const [a, b] = ends[i] as [Vector3, Vector3]
      if (p.distanceTo(a) < tol || p.distanceTo(b) < tol || segDist(p, a, b) < tol) {
        comps.add(find(i))
      }
    }
    return comps
  }
  const sourceComps = componentsNear(new Vector3(...source), sourceTol)
  if (sourceComps.size === 0) return targets.map((t) => t.id)
  const out: string[] = []
  for (const t of targets) {
    const comps = componentsNear(new Vector3(...t.position), targetTol)
    if (![...comps].some((c) => sourceComps.has(c))) out.push(t.id)
  }
  return out
}

const byPrefix = (members: Member[], prefix: string): Member[] =>
  members.filter((m) => m.role === 'pipe-run' && m.sourceId.startsWith(prefix))

const stubs = (fixtures: Fixture[]): Fixture[] => fixtures.filter((f) => f.kind === 'stub-out')

function checkSupply(members: Member[], fixtures: Fixture[]): void {
  const meter = fixtures.find((f) => f.kind === 'water-meter') as Fixture
  const wh = fixtures.find((f) => f.kind === 'water-heater') as Fixture
  expect(meter).toBeDefined()
  expect(wh).toBeDefined()
  const targets = stubs(fixtures).map((f) => ({ id: String(f.meta?.fixtureId), position: f.position }))
  const hotTargets = stubs(fixtures)
    .filter((f) => f.meta?.hot === true)
    .map((f) => ({ id: String(f.meta?.fixtureId), position: f.position }))
  expect(unreachableFrom(byPrefix(members, 'cold-'), meter.position, 0.12, targets, 0.03)).toEqual([])
  // hot drops land in the same bay nudged 1" off the cold drop
  expect(unreachableFrom(byPrefix(members, 'hot-'), wh.position, 0.35, hotTargets, 0.08)).toEqual([])
}

// ---- (b)+(c) drain continuity, walked strictly DOWNHILL --------------------

/**
 * Directed walk over the DWV tree (vents excluded): edges only traverse from
 * the higher member end to the lower, so reaching the sewer exit PROVES the
 * path falls monotonically. Returns fixture ids whose trap never gets there.
 */
function drainFailures(members: Member[], fixtureIds: string[]): string[] {
  const drains = members.filter(
    (m) =>
      m.role === 'pipe-run' && m.sourceId.startsWith('dwv-') && !m.sourceId.startsWith('dwv-vent'),
  )
  const NODE_TOL = 0.07
  const pts: Vector3[] = []
  const nodeOf = (p: Vector3): number => {
    for (let i = 0; i < pts.length; i++) {
      if ((pts[i] as Vector3).distanceTo(p) < NODE_TOL) return i
    }
    pts.push(p)
    return pts.length - 1
  }
  const edges = new Map<number, number[]>()
  const addEdge = (a: number, b: number) => {
    const list = edges.get(a) ?? []
    list.push(b)
    edges.set(a, list)
  }
  const topOf = new Map<string, number>() // sourceId → highest node
  for (const m of drains) {
    const [a, b] = endpointsOf(m)
    const hi = a.y >= b.y ? a : b
    const lo = a.y >= b.y ? b : a
    const hn = nodeOf(hi)
    const ln = nodeOf(lo)
    addEdge(hn, ln) // downhill only
    if (Math.abs(hi.y - lo.y) < 1e-9) addEdge(ln, hn) // dead level (risers/arms never are)
    const prev = topOf.get(m.sourceId)
    if (prev === undefined || (pts[prev] as Vector3).y < hi.y) topOf.set(m.sourceId, hn)
  }
  // exit = the LOW end of the building drain
  const mains = drains.filter((m) => m.sourceId === 'dwv-main')
  expect(mains.length).toBeGreaterThan(0)
  let exitNode = -1
  let exitY = Number.POSITIVE_INFINITY
  for (const m of mains) {
    for (const p of endpointsOf(m)) {
      if (p.y < exitY) {
        exitY = p.y
        exitNode = nodeOf(p)
      }
    }
  }
  const reaches = (start: number): boolean => {
    const seen = new Set<number>([start])
    const queue = [start]
    while (queue.length > 0) {
      const n = queue.shift() as number
      if (n === exitNode) return true
      for (const next of edges.get(n) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    return false
  }
  const failures: string[] = []
  for (const id of fixtureIds) {
    const start = topOf.get(`dwv-trap-${id}`)
    if (start === undefined || !reaches(start)) failures.push(id)
  }
  return failures
}

/** Every horizontal drain leg must carry a real pitch (P3005.3). */
function levelDrains(members: Member[]): string[] {
  return members
    .filter(
      (m) =>
        m.role === 'pipe-run' &&
        m.sourceId.startsWith('dwv-') &&
        !m.sourceId.startsWith('dwv-vent') &&
        m.dims[0] > m.dims[1] &&
        m.length > 0.06,
    )
    .filter((m) => Math.abs(m.rotation[2]) < 1e-9)
    .map((m) => `${m.label ?? m.sourceId}`)
}

// ---- (d) no pipe through a rough opening (electrical.openings pattern) -----

type RoBox = { min: [number, number, number]; max: [number, number, number] }
const EPS = 0.02
function roBoxes(walls: WallSlice[]): RoBox[] {
  const out: RoBox[] = []
  for (const w of walls) {
    for (const o of w.openings) {
      const lo = o.u - o.roughWidth / 2 + EPS
      const hi = o.u + o.roughWidth / 2 - EPS
      if (hi <= lo) continue
      const a = [w.start[0] + w.dir[0] * lo, w.start[1] + w.dir[1] * lo] as const
      const b = [w.start[0] + w.dir[0] * hi, w.start[1] + w.dir[1] * hi] as const
      const lat = w.thickness / 2 + 0.005
      const nx = -w.dir[1]
      const nz = w.dir[0]
      out.push({
        min: [
          Math.min(a[0], b[0]) - Math.abs(nx) * lat,
          o.sillHeight + EPS,
          Math.min(a[1], b[1]) - Math.abs(nz) * lat,
        ],
        max: [
          Math.max(a[0], b[0]) + Math.abs(nx) * lat,
          o.sillHeight + o.roughHeight - EPS,
          Math.max(a[1], b[1]) + Math.abs(nz) * lat,
        ],
      })
    }
  }
  return out
}

const inBox = (p: [number, number, number], b: RoBox): boolean =>
  p[0] > b.min[0] &&
  p[0] < b.max[0] &&
  p[1] > b.min[1] &&
  p[1] < b.max[1] &&
  p[2] > b.min[2] &&
  p[2] < b.max[2]

/** Pipe segments sampled every 5 cm against every RO box. */
function pipesThroughOpenings(members: Member[], walls: WallSlice[]): string[] {
  const boxes = roBoxes(walls)
  const bad: string[] = []
  for (const m of members) {
    if (m.system !== 'plumbing') continue
    if (m.role !== 'pipe-run' && m.role !== 'vent-stack') continue
    if (m.flag || m.label?.includes('⚠') || m.label?.includes('air run')) continue
    const [a, b] = endpointsOf(m)
    const steps = Math.max(2, Math.ceil(a.distanceTo(b) / 0.05))
    for (let i = 0; i <= steps; i++) {
      const p: [number, number, number] = [
        a.x + ((b.x - a.x) * i) / steps,
        a.y + ((b.y - a.y) * i) / steps,
        a.z + ((b.z - a.z) * i) / steps,
      ]
      if (boxes.some((box) => inBox(p, box))) {
        bad.push(`${m.label ?? m.role} @ ${p.map((v) => v.toFixed(2)).join(',')}`)
        break
      }
    }
  }
  return bad
}

// ---- scenarios --------------------------------------------------------------

/** 10×8 shell, garage west of x=5 / z<5, door + low window in the pipes' way. */
function housePlan() {
  const walls = [
    makeWall({
      id: 'w_s',
      start: [0, 0],
      end: [10, 0],
      openings: [opening('door', 4, 0.95, 0, 2.15)],
    }),
    makeWall({ id: 'w_e', start: [10, 0], end: [10, 8] }),
    makeWall({
      id: 'w_n',
      start: [10, 8],
      end: [0, 8],
      openings: [opening('window', 9, 1.2, 0.3, 1.6)],
    }),
    makeWall({ id: 'w_w', start: [0, 8], end: [0, 0] }),
    makeWall({ id: 'w_mid', start: [5, 0], end: [5, 8], exterior: false }),
  ]
  const rooms = [
    room('r_garage', 'garage', [
      [0, 0],
      [5, 0],
      [5, 5],
      [0, 5],
    ], ['w_w', 'w_mid']),
    room('r_bath', 'bathroom', [
      [5, 0],
      [10, 0],
      [10, 4],
      [5, 4],
    ]),
    room('r_kitchen', 'kitchen', [
      [0, 5],
      [5, 5],
      [5, 8],
      [0, 8],
    ]),
  ]
  return { walls, rooms }
}

describe('P5 gate — bathroom + far kitchen sink (toilet, lav, shower, sink)', () => {
  const { walls, rooms } = housePlan()
  const placed = [
    pf('wc', 'toilet', [6.5, 0.6]),
    pf('lav', 'lavatory', [7.6, 0.6]),
    pf('shw', 'shower', [9.3, 0.7]),
    pf('ks', 'kitchen-sink', [1.5, 7.6]),
  ]
  const { members, fixtures } = layoutPlumbing(walls, rooms, undefined, placed)

  test('(a) every stub cold-reachable from the meter; hot ones from the WH', () => {
    expect(stubs(fixtures)).toHaveLength(4)
    checkSupply(members, fixtures)
  })

  test('toilets stay cold-only (no hot homerun)', () => {
    expect(byPrefix(members, 'hot-wc')).toHaveLength(0)
    expect(byPrefix(members, 'cold-wc').length).toBeGreaterThan(0)
  })

  test('(b)+(c) every trap drains to the sewer exit, strictly downhill', () => {
    expect(drainFailures(members, ['wc', 'lav', 'shw', 'ks'])).toEqual([])
    expect(levelDrains(members)).toEqual([])
  })

  test('(d) no pipe crosses the door or the low window', () => {
    expect(pipesThroughOpenings(members, walls)).toEqual([])
  })

  test('DFU sizing: WC branch ≥ 3", building drain labeled with the total', () => {
    const wcBranch = members.filter((m) => m.sourceId === 'dwv-branch-wc')
    expect(wcBranch.length).toBeGreaterThan(0)
    for (const m of wcBranch) expect(Math.min(m.dims[1], m.dims[2])).toBeCloseTo(inches(3), 6)
    const main = members.find((m) => m.sourceId === 'dwv-main') as Member
    expect(main.label).toContain('8 DFU') // 3+1+2+2
    expect(main.label).toContain('3"')
    expect(main.flag).toBeUndefined()
  })

  test('garage scene mounts a TANK water heater 18" off the floor (M1307.3)', () => {
    const tank = members.find((m) => m.role === 'water-heater') as Member
    expect(tank.label).toContain('tank')
    expect(tank.position[1] - tank.dims[1] / 2).toBeCloseTo(inches(18), 6)
    // inside the garage
    expect(tank.position[0]).toBeLessThan(5)
  })

  test('rough-in stub heights follow fixtureRoughIn.*', () => {
    const byId = new Map(stubs(fixtures).map((f) => [String(f.meta?.fixtureId), f]))
    expect(byId.get('wc')?.position[1]).toBeCloseTo(inches(7), 6)
    expect(byId.get('lav')?.position[1]).toBeCloseTo(inches(21), 6)
    expect(byId.get('shw')?.position[1]).toBeCloseTo(inches(44), 6)
    expect(byId.get('ks')?.position[1]).toBeCloseTo(inches(18), 6)
  })

  test('remote wet walls re-vent back to the stack (P3104.4)', () => {
    expect(members.some((m) => m.sourceId.startsWith('dwv-vent-'))).toBe(true)
  })

  test('one stack through the roof + cleanouts at stack base and sewer exit', () => {
    const stack = members.filter((m) => m.role === 'vent-stack')
    expect(stack).toHaveLength(1)
    expect((stack[0] as Member).dims[1]).toBeGreaterThan(2.5 + 0.6) // roof + burial
    const cleanouts = fixtures.filter((f) => f.kind === 'cleanout')
    expect(cleanouts).toHaveLength(2)
    expect(cleanouts.some((c) => c.label?.includes('sewer'))).toBe(true)
  })
})

describe('P5 gate — island fixture (air-run fallback + trap-arm flag)', () => {
  const walls = [
    makeWall({ id: 'w_s', start: [0, 0], end: [10, 0] }),
    makeWall({ id: 'w_e', start: [10, 0], end: [10, 8] }),
    makeWall({ id: 'w_n', start: [10, 8], end: [0, 8] }),
    makeWall({ id: 'w_w', start: [0, 8], end: [0, 0] }),
  ]
  const rooms = [room('r_kitchen', 'kitchen', [
    [0, 0],
    [10, 0],
    [10, 8],
    [0, 8],
  ])]
  const placed = [pf('island', 'kitchen-sink', [4, 4]), pf('wc', 'toilet', [8, 0.6])]
  const { members, fixtures } = layoutPlumbing(walls, rooms, undefined, placed)

  test('(e) trap arm beyond Table P3105.1 fires its flag', () => {
    const arm = members.find((m) => m.sourceId === 'dwv-arm-island') as Member
    expect(arm.flag).toContain('TRAP ARM')
    expect(arm.flag).toContain('P3105.1')
    // the wall-hugging toilet stays clean
    expect(members.find((m) => m.sourceId === 'dwv-arm-wc')?.flag).toBeUndefined()
  })

  test('(e) supply reaches the island as a FLAGGED air run, still continuous', () => {
    const air = members.filter((m) => m.sourceId === 'cold-island' && m.flag?.includes('ISLAND'))
    expect(air.length).toBeGreaterThan(0)
    checkSupply(members, fixtures)
  })

  test('no garage → tankless WH on an exterior wall', () => {
    const wh = members.find((m) => m.role === 'water-heater') as Member
    expect(wh.label).toContain('Tankless')
    expect(wh.position[1] - wh.dims[1] / 2).toBeCloseTo(1.2, 6)
  })

  test('island drains still reach the exit downhill (buried run)', () => {
    expect(drainFailures(members, ['island', 'wc'])).toEqual([])
  })
})

describe('P5 gate — two bathrooms accumulate DFU downstream', () => {
  const walls = [
    makeWall({ id: 'w_s', start: [0, 0], end: [12, 0] }),
    makeWall({ id: 'w_e', start: [12, 0], end: [12, 8] }),
    makeWall({ id: 'w_n', start: [12, 8], end: [0, 8] }),
    makeWall({ id: 'w_w', start: [0, 8], end: [0, 0] }),
    makeWall({ id: 'w_mid', start: [6, 0], end: [6, 8], exterior: false }),
  ]
  const rooms: RoomSlice[] = []
  const placed = [
    pf('wc_a', 'toilet', [1.0, 0.6]),
    pf('lav_a', 'lavatory', [2.0, 0.6]),
    pf('wc_b', 'toilet', [11.0, 0.6]),
    pf('lav_b', 'lavatory', [10.0, 0.6]),
    pf('tub_b', 'bathtub', [11.4, 2.0]),
  ]
  const { members, fixtures } = layoutPlumbing(walls, rooms, undefined, placed)

  test('(a)+(b)+(c) both bathrooms fully served and drained', () => {
    checkSupply(members, fixtures)
    expect(drainFailures(members, ['wc_a', 'lav_a', 'wc_b', 'lav_b', 'tub_b'])).toEqual([])
    expect(levelDrains(members)).toEqual([])
  })

  test('sizes never decrease downstream: WC branches 3", main carries 10 DFU', () => {
    for (const id of ['wc_a', 'wc_b']) {
      const branch = members.filter((m) => m.sourceId === `dwv-branch-${id}`)
      expect(branch.length).toBeGreaterThan(0)
      for (const m of branch) expect(Math.min(m.dims[1], m.dims[2])).toBeCloseTo(inches(3), 6)
    }
    const main = members.find((m) => m.sourceId === 'dwv-main') as Member
    expect(main.label).toContain('10 DFU')
  })

  test('(d) clean even with both baths on exterior walls', () => {
    expect(pipesThroughOpenings(members, walls)).toEqual([])
  })
})

describe('P5 gate — placed path leaves the fallback intact', () => {
  test('no placed fixtures → the room-category engine still answers', () => {
    const { walls, rooms } = housePlan()
    const { members, fixtures } = layoutPlumbing(walls, rooms)
    // fallback vocabulary: room-sourced stubs, no meter, no supply prefixes
    expect(fixtures.some((f) => f.kind === 'water-meter')).toBe(false)
    expect(members.some((m) => m.sourceId.startsWith('cold-'))).toBe(false)
    expect(fixtures.some((f) => f.kind === 'stub-out')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Verify-round defect gates (skeptic round 1, 2026-08-16)
// ---------------------------------------------------------------------------

describe('P5 gate — cross-trade coexistence (verify round)', () => {
  const { walls, rooms } = housePlan()
  const placed = [
    pf('wc', 'toilet', [6.5, 0.6]),
    pf('lav', 'lavatory', [7.6, 0.6]),
    pf('shw', 'shower', [9.3, 0.7]),
    pf('ks', 'kitchen-sink', [1.5, 7.6]),
  ]
  const { members, fixtures } = layoutPlumbing(walls, rooms, undefined, placed)
  const { layoutElectrical, routeWiring } = require('./electrical') as typeof import('./electrical')
  const elecFixtures = layoutElectrical(walls, rooms)
  const wires = routeWiring(elecFixtures, walls).filter((m) => m.role === 'wire-run')

  test('D1: the water heater never engulfs the electrical panel', () => {
    const wh = members.find((m) => m.role === 'water-heater')
    const panel = elecFixtures.find((f) => f.kind === 'panel')
    expect(wh).toBeDefined()
    expect(panel).toBeDefined()
    const w = wh as Member
    const p = panel as Fixture
    const inside =
      Math.abs(p.position[0] - w.position[0]) < w.dims[0] / 2 + 0.05 &&
      Math.abs(p.position[1] - w.position[1]) < w.dims[1] / 2 + 0.05 &&
      Math.abs(p.position[2] - w.position[2]) < w.dims[2] / 2 + 0.05
    expect(inside).toBe(false)
  })

  test('D2: no supply run shares a plane with a wire run (>=2cm separation on parallel co-linear pairs)', () => {
    const supplies = members.filter(
      (m) => m.role === 'pipe-run' && (m.sourceId.startsWith('hot-') || m.sourceId.startsWith('cold-')),
    )
    let worst = Number.POSITIVE_INFINITY
    for (const pipe of supplies) {
      for (const wire of wires) {
        // parallel horizontal members on the same wall plane: compare when
        // both are horizontal and overlap in plan
        const pH = pipe.dims[0] >= pipe.dims[1]
        const wH = wire.dims[0] >= wire.dims[1]
        if (!pH || !wH) continue
        const dYaw = Math.abs(pipe.rotation[1] - wire.rotation[1]) % Math.PI
        if (dYaw > 0.05 && Math.abs(dYaw - Math.PI) > 0.05) continue
        const planDist = Math.hypot(pipe.position[0] - wire.position[0], pipe.position[2] - wire.position[2])
        if (planDist > (pipe.dims[0] + wire.dims[0]) / 2) continue
        const dy = Math.abs(pipe.position[1] - wire.position[1])
        // only co-planar candidates matter (same stud bay band)
        if (planDist < 0.08) worst = Math.min(worst, dy)
      }
    }
    expect(worst).toBeGreaterThan(0.02)
  })
})

describe('P5 gate — DFU main sizing + RO riser + through-wall clearance (verify round)', () => {
  test('D3: the building drain is never smaller than its largest branch', () => {
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [30, 0] }),
      makeWall({ id: 'w_e', start: [30, 0], end: [30, 8] }),
      makeWall({ id: 'w_n', start: [30, 8], end: [0, 8] }),
      makeWall({ id: 'w_w', start: [0, 8], end: [0, 0] }),
    ]
    const rooms = [room('r', 'bathroom', [[0, 0], [30, 0], [30, 8], [0, 8]])]
    const placed = [
      ...[1, 1.5, 2, 2.5, 3, 3.5].map((x, i) => pf(`s${i}`, 'shower', [x, 0.5])),
      ...[10, 11, 12, 13, 14, 15, 16].map((x, i) => pf(`t${i}`, 'toilet', [x, 0.5])),
    ]
    const { members } = layoutPlumbing(walls, rooms, undefined, placed)
    const main = members.find((m) => m.sourceId === 'dwv-main')
    const branchMax = Math.max(
      ...members
        .filter((m) => m.sourceId.startsWith('dwv-branch-'))
        .map((m) => Math.min(m.dims[1], m.dims[2]) / 0.0254),
    )
    expect(main).toBeDefined()
    const mainIn = Math.min((main as Member).dims[1], (main as Member).dims[2]) / 0.0254
    expect(mainIn + 1e-6).toBeGreaterThanOrEqual(branchMax)
  })

  test('D4: a fixture inside a door RO gets an OPENING flag', () => {
    const { walls, rooms } = housePlan()
    const placed = [pf('lav', 'lavatory', [4, 0.05]), pf('wc', 'toilet', [6.5, 0.6])]
    const { members } = layoutPlumbing(walls, rooms, undefined, placed)
    const flags = members.filter((m) => m.flag?.includes('OPENING')).map((m) => m.flag)
    expect(flags.length).toBeGreaterThan(0)
  })

  test('D5: back-to-back toilets across a wall do NOT trigger the clearance flag', () => {
    const { walls, rooms } = housePlan()
    const placed = [pf('wc1', 'toilet', [4.8, 4]), pf('wc2', 'toilet', [5.2, 4])]
    const { members } = layoutPlumbing(walls, rooms, undefined, placed)
    const clearanceFlags = members.filter((m) => m.flag?.includes('CLEARANCE'))
    expect(clearanceFlags).toEqual([])
  })
})

describe('P5 gate — re-verify round 2 (riser colinearity, short garage wall)', () => {
  test('D2b: pipe and wire detour RISERS never share a plan point at a door', () => {
    const { walls, rooms } = housePlan()
    const placed = [pf('wc', 'toilet', [6.5, 0.6]), pf('ks', 'kitchen-sink', [1.5, 7.6])]
    const { members } = layoutPlumbing(walls, rooms, undefined, placed)
    const { layoutElectrical, routeWiring } = require('./electrical') as typeof import('./electrical')
    const wires = routeWiring(layoutElectrical(walls, rooms), walls)
    const vertical = (m: Member) => m.dims[1] > m.dims[0]
    const pipeRisers = members.filter((m) => m.role === 'pipe-run' && vertical(m) && (m.sourceId.startsWith('cold-') || m.sourceId.startsWith('hot-')))
    const wireRisers = wires.filter((m) => m.role === 'wire-run' && vertical(m))
    for (const p of pipeRisers) {
      for (const w of wireRisers) {
        const planDist = Math.hypot(p.position[0] - w.position[0], p.position[2] - w.position[2])
        const yOverlap =
          Math.min(p.position[1] + p.dims[1] / 2, w.position[1] + w.dims[1] / 2) -
          Math.max(p.position[1] - p.dims[1] / 2, w.position[1] - w.dims[1] / 2)
        if (yOverlap > 0.1) expect(planDist).toBeGreaterThan(0.02)
      }
    }
  })

  test('D1b: a 1.5m garage wall falls back to tankless — never a tank on the panel', () => {
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [10, 0] }),
      makeWall({ id: 'w_e', start: [10, 0], end: [10, 8] }),
      makeWall({ id: 'w_n', start: [10, 8], end: [0, 8] }),
      makeWall({ id: 'w_w', start: [0, 8], end: [0, 0] }),
      makeWall({ id: 'w_g', start: [0, 5], end: [1.5, 5], exterior: false }),
    ]
    const rooms = [
      room('r_garage', 'garage', [[0, 5], [1.5, 5], [1.5, 8], [0, 8]], ['w_g']),
      room('r_bath', 'bathroom', [[5, 0], [10, 0], [10, 4], [5, 4]]),
    ]
    const placed = [pf('wc', 'toilet', [6.5, 0.6])]
    const { members, fixtures } = layoutPlumbing(walls, rooms, undefined, placed)
    const wh = members.find((m) => m.role === 'water-heater')
    const whFix = fixtures.find((f) => f.kind === 'water-heater')
    expect((whFix?.label ?? '').toLowerCase()).toContain('tankless')
    // and never overlapping the panel enclosure box
    const { layoutElectrical } = require('./electrical') as typeof import('./electrical')
    const panel = layoutElectrical(walls, rooms).find((f) => f.kind === 'panel')
    if (wh && panel) {
      const overlap =
        Math.abs(panel.position[0] - wh.position[0]) < wh.dims[0] / 2 + 0.2 &&
        Math.abs(panel.position[2] - wh.position[2]) < wh.dims[2] / 2 + 0.2 &&
        Math.abs(panel.position[1] - wh.position[1]) < wh.dims[1] / 2 + 0.38
      expect(overlap).toBe(false)
    }
  })
})

describe('P5 gate — re-verify round 3 (mulled-opening riser clearance)', () => {
  test('D2c: a window 1.5cm past the door edge never swallows the shifted risers', () => {
    const walls = [
      makeWall({
        id: 'w_s',
        start: [0, 0],
        end: [10, 0],
        openings: [
          opening('door', 4, 0.95, 0, 2.15),
          opening('window', 4.69, 0.4, 0.5, 1.4), // RO [4.49, 4.89], sill above the run plane
        ],
      }),
      makeWall({ id: 'w_e', start: [10, 0], end: [10, 8] }),
      makeWall({ id: 'w_n', start: [10, 8], end: [0, 8] }),
      makeWall({ id: 'w_w', start: [0, 8], end: [0, 0] }),
      makeWall({ id: 'w_mid', start: [5, 0], end: [5, 8], exterior: false }),
    ]
    const rooms = [
      room('r_bath', 'bathroom', [[5, 0], [10, 0], [10, 4], [5, 4]]),
      room('r_kitchen', 'kitchen', [[0, 5], [5, 5], [5, 8], [0, 8]]),
    ]
    const placed = [pf('wc', 'toilet', [6.5, 0.6]), pf('ks', 'kitchen-sink', [1.5, 7.6])]
    const { members } = layoutPlumbing(walls, rooms, undefined, placed)
    // no unflagged supply member point inside either RO volume
    const bad = pipesThroughOpenings(members, walls)
    expect(bad).toEqual([])
  })
})

describe('P5 gate — re-verify round 4 (exhaustion flags, clamp re-check, wire skin)', () => {
  const wideWalls = (windowW: number, sill: number) => [
    makeWall({
      id: 'w_s',
      start: [0, 0],
      end: [10, 0],
      openings: [opening('door', 4, 0.95, 0, 2.15), opening('window', 4.49 + windowW / 2 + 0.0, windowW, sill, 1.4)],
    }),
    makeWall({ id: 'w_e', start: [10, 0], end: [10, 8] }),
    makeWall({ id: 'w_n', start: [10, 8], end: [0, 8] }),
    makeWall({ id: 'w_w', start: [0, 8], end: [0, 0] }),
    makeWall({ id: 'w_mid', start: [5, 0], end: [5, 8], exterior: false }),
  ]
  const roomsFor = () => [
    room('r_bath', 'bathroom', [[5, 0], [10, 0], [10, 4], [5, 4]]),
    room('r_kitchen', 'kitchen', [[0, 5], [5, 5], [5, 8], [0, 8]]),
  ]

  test('1.2m mulled window: risers are clear OR carry the OPENING flag — never silent', () => {
    const walls = wideWalls(1.2, 0.7)
    const placed = [pf('wc', 'toilet', [6.5, 0.6]), pf('ks', 'kitchen-sink', [1.5, 7.6])]
    const { members } = layoutPlumbing(walls, roomsFor(), undefined, placed)
    // pipesThroughOpenings ignores flagged members; unflagged crossings = 0
    expect(pipesThroughOpenings(members, walls)).toEqual([])
  })

  test('narrow window: cleared risers stay >=2cm from the RO edge (electrical stands there)', () => {
    const walls = wideWalls(0.465, 0.5)
    const placed = [pf('wc', 'toilet', [6.5, 0.6]), pf('ks', 'kitchen-sink', [1.5, 7.6])]
    const { members } = layoutPlumbing(walls, roomsFor(), undefined, placed)
    expect(pipesThroughOpenings(members, walls)).toEqual([])
    const risers = members.filter(
      (m) => m.role === 'pipe-run' && m.dims[1] > m.dims[0] && !m.flag &&
        (m.sourceId.startsWith('cold-') || m.sourceId.startsWith('hot-')),
    )
    for (const r of risers) {
      const u = r.position[0] // w_s runs along +x from origin
      if (Math.abs(r.position[2]) > 0.1) continue
      for (const w of wideWalls(0.465, 0.5).slice(0, 1)) {
        const { openingSpans } = require('./electrical') as typeof import('./electrical')
        for (const sp of openingSpans(w, 0.02, w.height - 0.02)) {
          if (u > sp.lo - 0.02 && u < sp.hi + 0.02) {
            throw new Error(`riser ${r.sourceId} at u=${u.toFixed(3)} within 2cm of RO [${sp.lo},${sp.hi}]`)
          }
        }
      }
    }
  })
})

describe('P5 gate — re-verify round 5 (jumper through a tee-spanning window)', () => {
  test('sill-0.5 1.2m window over the tee: jumpers are flagged, never silent', () => {
    const walls = [
      makeWall({
        id: 'w_s',
        start: [0, 0],
        end: [10, 0],
        openings: [opening('door', 4, 0.95, 0, 2.15), opening('window', 5.09, 1.2, 0.5, 1.4)],
      }),
      makeWall({ id: 'w_e', start: [10, 0], end: [10, 8] }),
      makeWall({ id: 'w_n', start: [10, 8], end: [0, 8] }),
      makeWall({ id: 'w_w', start: [0, 8], end: [0, 0] }),
      makeWall({ id: 'w_mid', start: [5, 0], end: [5, 8], exterior: false }),
    ]
    const rooms = [
      room('r_bath', 'bathroom', [[5, 0], [10, 0], [10, 4], [5, 4]]),
      room('r_kitchen', 'kitchen', [[0, 5], [5, 5], [5, 8], [0, 8]]),
    ]
    const placed = [pf('wc', 'toilet', [6.5, 0.6]), pf('ks', 'kitchen-sink', [1.5, 7.6])]
    const { members } = layoutPlumbing(walls, rooms, undefined, placed)
    expect(pipesThroughOpenings(members, walls)).toEqual([])
  })
})
