import { describe, expect, test } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
import type { Fixture, Member, OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import { PLUMBING_COLORS, plumbingPipeColor } from '../plans/circuit-colors'
import { LINESET_PAIR_OFFSET, layoutHvac } from './hvac'

/**
 * GATES (line-set round — "piped to the exchanger along a sensible path"):
 *  1. CONTINUITY (E2 applied to refrigerant pipe): each unit's suction AND
 *     liquid runs form one endpoint-adjacent chain from the condenser
 *     cabinet to the air handler — no gaps, no floating segments;
 *  2. the pair runs PARALLEL: every horizontal suction leg has a liquid twin
 *     on the same plan centerline, offset 2·LINESET_PAIR_OFFSET below;
 *  3. the wall PENETRATION clears rough openings — a verbatim heat-pump node
 *     fronting a low window slides the through-wall leg out of the RO (the
 *     unit itself stays verbatim, A4);
 *  4. runs over ~15 m carry the oil-return ADVISORY (assumption class — the
 *     manufacturer's line-set chart governs), short runs stay clean;
 *  5. the WHIP is endpoint-adjacent disconnect → unit and the disconnect
 *     stays within sight (NEC 440.14 pin);
 *  6. the render colors mirror the plumbing hot/cold convention: suction
 *     cold-blue / liquid warm-red, distinct from supply cold/hot (E3).
 */

const LOD400 = { ...DEFAULT_SPEC, detail: '400' as const }

function wall(
  id: string,
  start: [number, number],
  end: [number, number],
  exterior = false,
  openings: OpeningSlice[] = [],
): WallSlice {
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  return {
    id,
    start,
    end,
    length,
    dir: [dx / length, dz / length],
    thickness: 0.2,
    height: 2.7,
    exterior,
    openings,
    curved: false,
  }
}

function room(
  id: string,
  name: string,
  category: RoomSlice['category'],
  polygon: [number, number][],
): RoomSlice {
  return { id, name, category, polygon, boundaryWallIds: [], ceilingHeight: 2.5 }
}

function shell(W: number, D: number, southOpenings: OpeningSlice[] = []) {
  const walls = [
    wall('w_south', [0, 0], [W, 0], true, southOpenings),
    wall('w_north', [0, D], [W, D], true),
    wall('w_west', [0, 0], [0, D], true),
    wall('w_east', [W, 0], [W, D], true),
  ]
  const rooms = [
    room('r_laundry', 'Laundry', 'laundry', [[0, 0], [3, 0], [3, 3], [0, 3]]),
    room('r_living', 'Living', 'other', [[3, 0], [W, 0], [W, D], [3, D]]),
    room('r_bed', 'Bedroom', 'bedroom', [[0, 3], [3, 3], [3, D], [0, D]]),
  ]
  return { walls, rooms }
}

type Endpoint = { x: number; y: number; z: number }

/** Horizontal leg()/duct() + vertical riser()/ductDrop() member endpoints. */
function endpointsOf(m: Member): [Endpoint, Endpoint] {
  if (m.rotation[1] === 0 && m.dims[1] === m.length) {
    return [
      { x: m.position[0], y: m.position[1] - m.length / 2, z: m.position[2] },
      { x: m.position[0], y: m.position[1] + m.length / 2, z: m.position[2] },
    ]
  }
  const yaw = m.rotation[1]
  const hx = (m.dims[0] / 2) * Math.cos(yaw)
  const hz = -(m.dims[0] / 2) * Math.sin(yaw)
  return [
    { x: m.position[0] - hx, y: m.position[1], z: m.position[2] - hz },
    { x: m.position[0] + hx, y: m.position[1], z: m.position[2] + hz },
  ]
}

const TOL = 0.06

/**
 * E2-style continuity: union-find over member endpoints (3D adjacency
 * within TOL); true when a member endpoint near `from` connects to one near
 * `to` (both matched by PLAN distance — the terminals sit at pipe height).
 */
function chainConnects(
  members: Member[],
  from: readonly [number, number],
  to: readonly [number, number],
): boolean {
  const pts: Endpoint[] = []
  const owner: number[] = [] // endpoint index → member index
  members.forEach((m, i) => {
    for (const e of endpointsOf(m)) {
      pts.push(e)
      owner.push(i)
    }
  })
  const parent = pts.map((_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r] as number
    let c = i
    while (parent[c] !== c) {
      const nxt = parent[c] as number
      parent[c] = r
      c = nxt
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i] as Endpoint
      const b = pts[j] as Endpoint
      // both endpoints of one member are trivially connected
      if (owner[i] === owner[j]) {
        union(i, j)
        continue
      }
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < TOL) union(i, j)
    }
  }
  const at = (p: readonly [number, number]): number => {
    let best = -1
    let bestD = Number.POSITIVE_INFINITY
    for (let i = 0; i < pts.length; i++) {
      const e = pts[i] as Endpoint
      const d = Math.hypot(e.x - p[0], e.z - p[1])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return bestD < TOL ? best : -1
  }
  const i0 = at(from)
  const i1 = at(to)
  return i0 >= 0 && i1 >= 0 && find(i0) === find(i1)
}

const condensersOf = (fixtures: Fixture[]): Fixture[] =>
  fixtures.filter((f) => f.kind === 'equipment' && f.meta?.equipment === 'condenser')

const runOf = (members: Member[], sourceId: string): Member[] =>
  members.filter((m) => m.sourceId === sourceId)

// ---------------------------------------------------------------------------
// 1. Continuity — condenser → air handler as one endpoint-adjacent chain
// ---------------------------------------------------------------------------

describe('line-set continuity (E2 for refrigerant pipe)', () => {
  test('plain shell: both pipes of every unit chain condenser → air handler', () => {
    const { walls, rooms } = shell(26, 10)
    const { members, fixtures } = layoutHvac(walls, rooms, LOD400)
    const units = condensersOf(fixtures)
    const handler = fixtures.find((f) => f.label?.includes('Air handler')) as Fixture
    expect(units.length).toBe(2)
    for (let n = 1; n <= units.length; n++) {
      const unit = units[n - 1] as Fixture
      for (const pipe of [`lineset-suction-${n}`, `lineset-liquid-${n}`]) {
        const legs = runOf(members, pipe)
        expect(legs.length).toBeGreaterThan(0)
        expect(
          chainConnects(
            legs,
            [unit.position[0], unit.position[2]],
            [handler.position[0], handler.position[2]],
          ),
        ).toBe(true)
      }
    }
  })

  test('a door RO on the path keeps the chain CONTINUOUS through the detour', () => {
    // The E1 detour (rise / cross over the header / drop) must not open a
    // gap: risers land exactly on the horizontal legs' endpoints.
    const { walls, rooms } = shell(26, 10, [
      {
        id: 'd_mid',
        kind: 'door',
        u: 5,
        width: 0.85,
        height: 2.03,
        sillHeight: 0,
        roughWidth: 0.9,
        roughHeight: 2.1,
      },
    ])
    const out = layoutHvac(walls, rooms, DEFAULT_SPEC, { heatPump: { position: [8, 0, -0.7] } })
    const handler = out.fixtures.find((f) => f.label?.includes('Air handler')) as Fixture
    const unit = condensersOf(out.fixtures)[0] as Fixture
    for (const pipe of ['lineset-suction-1', 'lineset-liquid-1']) {
      expect(
        chainConnects(
          runOf(out.members, pipe),
          [unit.position[0], unit.position[2]],
          [handler.position[0], handler.position[2]],
        ),
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Parallel pair — ONE shared route, ±offset on EVERY member (skeptic
// round: per-pipe routing collapsed the pair on detours and let a
// band-splitting sill make the pipes cross)
// ---------------------------------------------------------------------------

/** Axis-aligned AABB of a lineset member (the gate scenes' walls run on
 * plan axes — asserted via the quarter-yaw check before trusting this). */
function aabbOf(m: Member): { min: [number, number, number]; max: [number, number, number] } {
  const [a, b] = endpointsOf(m)
  const vertical = m.rotation[1] === 0 && m.dims[1] === m.length
  if (vertical) {
    return {
      min: [m.position[0] - m.dims[0] / 2, Math.min(a.y, b.y), m.position[2] - m.dims[2] / 2],
      max: [m.position[0] + m.dims[0] / 2, Math.max(a.y, b.y), m.position[2] + m.dims[2] / 2],
    }
  }
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minZ = Math.min(a.z, b.z)
  const maxZ = Math.max(a.z, b.z)
  const alongX = maxX - minX >= maxZ - minZ
  return {
    min: [
      alongX ? minX : m.position[0] - m.dims[2] / 2,
      m.position[1] - m.dims[1] / 2,
      alongX ? m.position[2] - m.dims[2] / 2 : minZ,
    ],
    max: [
      alongX ? maxX : m.position[0] + m.dims[2] / 2,
      m.position[1] + m.dims[1] / 2,
      alongX ? m.position[2] + m.dims[2] / 2 : maxZ,
    ],
  }
}

/** Suction × liquid volume hits deeper than the 2 mm skin (the skeptic's
 * SAT harness distilled to the axis-aligned case). */
function pairHits(suction: Member[], liquid: Member[], skin = 0.002): number {
  let hits = 0
  for (const s of suction) {
    for (const l of liquid) {
      const A = aabbOf(s)
      const B = aabbOf(l)
      let pen = Number.POSITIVE_INFINITY
      for (let k = 0; k < 3; k++) {
        pen = Math.min(
          pen,
          Math.min(A.max[k] as number, B.max[k] as number) -
            Math.max(A.min[k] as number, B.min[k] as number),
        )
      }
      if (pen > skin) hits++
    }
  }
  return hits
}

/** The pair contract: bijective twins — every suction member has a liquid
 * member of the SAME length exactly 2×offset below. Horizontal legs share
 * their plan center; RISERS sit 2×offset apart in plan instead (the pair
 * ROLLS 90° at vertical transitions so the lower pipe's riser never bores
 * through the upper pipe — coaxial risers were the coincident-stack class). */
function expectTwinned(members: Member[], n: number): { suction: Member[]; liquid: Member[] } {
  const suction = runOf(members, `lineset-suction-${n}`)
  const liquid = runOf(members, `lineset-liquid-${n}`)
  expect(suction.length).toBeGreaterThan(0)
  expect(suction.length).toBe(liquid.length)
  for (const m of [...suction, ...liquid]) {
    const quarter = m.rotation[1] / (Math.PI / 2)
    expect(Math.abs(quarter - Math.round(quarter))).toBeLessThan(1e-9)
  }
  for (const s of suction) {
    const sVert = s.rotation[1] === 0 && s.dims[1] === s.length
    const twin = liquid.find((l) => {
      if (Math.abs(l.length - s.length) > 1e-9) return false
      if (Math.abs(s.position[1] - l.position[1] - 2 * LINESET_PAIR_OFFSET) > 1e-9) return false
      const planD = Math.hypot(
        l.position[0] - s.position[0],
        l.position[2] - s.position[2],
      )
      return sVert ? Math.abs(planD - 2 * LINESET_PAIR_OFFSET) < 1e-9 : planD < 1e-9
    })
    expect(twin).toBeDefined()
  }
  return { suction, liquid }
}

describe('line-set pair parallelism — non-vacuous over E1 detours', () => {
  test('door-detour scene: every member twins at 2×offset; zero pair SAT hits', () => {
    // The exact skeptic repro: per-pipe routing left the liquid detour leg
    // fully INSIDE the suction leg over the header (9 SAT hits).
    const { walls, rooms } = shell(26, 10, [
      {
        id: 'd_mid',
        kind: 'door',
        u: 5,
        width: 0.85,
        height: 2.03,
        sillHeight: 0,
        roughWidth: 0.9,
        roughHeight: 2.1,
      },
    ])
    const out = layoutHvac(walls, rooms, DEFAULT_SPEC, { heatPump: { position: [8, 0, -0.7] } })
    const { suction, liquid } = expectTwinned(out.members, 1)
    // the scene genuinely detours — risers exist on BOTH pipes
    const risers = (legs: Member[]) =>
      legs.filter((m) => m.rotation[1] === 0 && m.dims[1] === m.length)
    expect(risers(suction).length).toBeGreaterThanOrEqual(2)
    expect(risers(liquid).length).toBe(risers(suction).length)
    expect(pairHits(suction, liquid)).toBe(0)
  })

  test('an RO sill landing BETWEEN the two bands still yields ONE shared decision', () => {
    // Sill 0.43 / top 2.66: the old per-pipe bands split (suction [0.40,
    // 0.44] detoured under, liquid [0.36,0.40] ran straight) and the
    // suction risers pierced the liquid horizontal. The shared envelope
    // band makes one decision for the pair.
    const splitter: OpeningSlice = {
      id: 'w_split',
      kind: 'window',
      u: 5,
      width: 0.95,
      height: 2.2,
      sillHeight: 0.43,
      roughWidth: 1.0,
      roughHeight: 2.23,
    }
    const { walls, rooms } = shell(26, 10, [splitter])
    const out = layoutHvac(walls, rooms, DEFAULT_SPEC, { heatPump: { position: [8, 0, -0.7] } })
    const { suction, liquid } = expectTwinned(out.members, 1)
    // same decision on both pipes: identical riser counts …
    const risers = (legs: Member[]) =>
      legs.filter((m) => m.rotation[1] === 0 && m.dims[1] === m.length)
    expect(risers(suction).length).toBe(risers(liquid).length)
    // … and the pipes never touch, let alone cross
    expect(pairHits(suction, liquid)).toBe(0)
  })

  test('plain shell: multi-unit runs stay twinned too', () => {
    const { walls, rooms } = shell(26, 10)
    const { members } = layoutHvac(walls, rooms, LOD400)
    for (let n = 1; n <= 2; n++) {
      const { suction, liquid } = expectTwinned(members, n)
      expect(pairHits(suction, liquid)).toBe(0)
    }
  })

  test('corner-hug RO: a riser LEADING a turned wall still rolls ACROSS that wall (stale-axis class)', () => {
    // Skeptic round 2: an RO edge within ~6 cm of a wall junction drops the
    // <1.5 cm approach leg on the turned wall, so the RISER is the first
    // member there — the emission-order axis pointed along the PREVIOUS
    // (orthogonal) wall, the roll ran ALONG the new wall, both risers sat
    // on the centerline and one pierced the other pipe's detour crossing
    // (1 SAT hit, 9.5 mm penetration at 70638b2).
    const door: OpeningSlice = {
      id: 'd_w',
      kind: 'door',
      u: 0.48,
      width: 0.85,
      height: 2.03,
      sillHeight: 0,
      roughWidth: 0.9,
      roughHeight: 2.1,
    }
    const walls = [
      wall('w_south', [0, 0], [26, 0], true),
      wall('w_north', [0, 10], [26, 10], true),
      wall('w_west', [0, 0], [0, 10], true, [door]),
      wall('w_east', [26, 0], [26, 10], true),
    ]
    const rooms = [
      room('r_laundry', 'Laundry', 'laundry', [[0, 3], [2, 3], [2, 6], [0, 6]]),
      room('r_living', 'Living', 'other', [[2, 0], [26, 0], [26, 10], [2, 10]]),
      room('r_bed', 'Bedroom', 'bedroom', [[0, 6], [2, 6], [2, 10], [0, 10]]),
    ]
    const out = layoutHvac(walls, rooms, DEFAULT_SPEC, { heatPump: { position: [8, 0, -0.7] } })
    const { suction, liquid } = expectTwinned(out.members, 1)
    // the route turns the corner and genuinely detours on the WEST wall:
    // its risers live near x = 0 …
    const vertical = (m: Member) => m.rotation[1] === 0 && m.dims[1] === m.length
    const westRisers = [...suction, ...liquid].filter(
      (m) => vertical(m) && Math.abs(m.position[0]) < 0.05,
    )
    expect(westRisers.length).toBeGreaterThanOrEqual(2)
    // … rolled ACROSS the wall (x = ±offset), never left ON the centerline
    for (const r of westRisers) {
      expect(Math.abs(Math.abs(r.position[0]) - LINESET_PAIR_OFFSET)).toBeLessThan(1e-9)
    }
    expect(pairHits(suction, liquid)).toBe(0)
  })

  test('DOUBLE corner-hug: doors on BOTH junction walls — corner risers cancel, rolls stay per-wall, no dupes', () => {
    // Attack 3b (round-3 merge gate): with ROs hugging the shared junction
    // on both orthogonal walls, the geometric roll-axis lookup matched the
    // WRONG wall's crossing (both walls' crossings sit at one elevation
    // touching the junction point) and rolled the corner riser ALONG
    // w_west again (2 SAT hits at 40276ab); the descend/re-ascend riser
    // pair at the corner was also emitted twice byte-identically
    // (double-booked lf). A real pipe stays UP around the corner: the
    // identical opposite risers cancel and the two crossings connect
    // directly at the detour plane.
    const doorAt = (id: string): OpeningSlice => ({
      id,
      kind: 'door',
      u: 0.48,
      width: 0.85,
      height: 2.03,
      sillHeight: 0,
      roughWidth: 0.9,
      roughHeight: 2.1,
    })
    const walls = [
      wall('w_south', [0, 0], [26, 0], true, [doorAt('d_s')]),
      wall('w_north', [0, 10], [26, 10], true),
      wall('w_west', [0, 0], [0, 10], true, [doorAt('d_w')]),
      wall('w_east', [26, 0], [26, 10], true),
    ]
    const rooms = [
      room('r_laundry', 'Laundry', 'laundry', [[0, 3], [2, 3], [2, 6], [0, 6]]),
      room('r_living', 'Living', 'other', [[2, 0], [26, 0], [26, 10], [2, 10]]),
      room('r_bed', 'Bedroom', 'bedroom', [[0, 6], [2, 6], [2, 10], [0, 10]]),
    ]
    const out = layoutHvac(walls, rooms, DEFAULT_SPEC, { heatPump: { position: [8, 0, -0.7] } })
    const { suction, liquid } = expectTwinned(out.members, 1)
    const vertical = (m: Member) => m.rotation[1] === 0 && m.dims[1] === m.length
    // per-wall roll axes: a riser on the X-axis wall (w_south, z ≈ 0)
    // rolls in Z; a riser on the Z-axis wall (w_west, x ≈ 0) rolls in X —
    // and the corner pair itself is GONE, so every survivor belongs to
    // exactly one wall and NEVER drops at the junction
    const risers = [...suction, ...liquid].filter(vertical)
    expect(risers.length).toBeGreaterThan(0)
    for (const r of risers) {
      const xRoll = Math.abs(Math.abs(r.position[0]) - LINESET_PAIR_OFFSET) < 1e-9
      const zRoll = Math.abs(Math.abs(r.position[2]) - LINESET_PAIR_OFFSET) < 1e-9
      const onWest = Math.abs(r.position[0]) <= LINESET_PAIR_OFFSET + 1e-9
      const onSouth = Math.abs(r.position[2]) <= LINESET_PAIR_OFFSET + 1e-9
      // never at the junction itself (that riser pair must have canceled)
      expect(onWest && onSouth).toBe(false)
      if (onWest) expect(xRoll).toBe(true) // Z-wall → X-roll
      if (onSouth) expect(zRoll).toBe(true) // X-wall → Z-roll
    }
    // no byte-identical duplicates within a pipe (unique position|dims)
    for (const legs of [suction, liquid]) {
      const seen = new Set<string>()
      for (const m of legs) {
        const key = `${m.position.join(',')}|${m.dims.join(',')}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
    // the canceled corner stays CONTINUOUS (crossings meet at the junction)
    const handler = out.fixtures.find((f) => f.label?.includes('Air handler')) as Fixture
    const unit = condensersOf(out.fixtures)[0] as Fixture
    for (const legs of [suction, liquid]) {
      expect(
        chainConnects(
          legs,
          [unit.position[0], unit.position[2]],
          [handler.position[0], handler.position[2]],
        ),
      ).toBe(true)
    }
    expect(pairHits(suction, liquid)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Penetration clears rough openings (verbatim node fronting a low window)
// ---------------------------------------------------------------------------

describe('wall penetration clears ROs', () => {
  test('a heat-pump node fronting a LOW window slides the through-wall leg clear; the unit stays verbatim', () => {
    // Low glazing crosses the line-set band [0.33, 0.47] — the ROW anchors
    // verbatim (A4) but the PENETRATION may not bore through glass.
    const lowWindow: OpeningSlice = {
      id: 'w_low',
      kind: 'window',
      u: 5,
      width: 0.95,
      height: 1.0,
      sillHeight: 0.2,
      roughWidth: 1.0,
      roughHeight: 1.05,
    }
    const { walls, rooms } = shell(26, 10, [lowWindow])
    const out = layoutHvac(walls, rooms, DEFAULT_SPEC, { heatPump: { position: [5, 0, -0.7] } })
    const unit = condensersOf(out.fixtures)[0] as Fixture
    // unit #1 verbatim on the node
    expect(unit.position[0]).toBeCloseTo(5, 6)
    expect(unit.position[2]).toBeCloseTo(-0.7, 6)
    // the through-wall suction leg (outside → centerline) sits clear of the
    // RO span [4.5, 5.5]
    const suction = runOf(out.members, 'lineset-suction-1')
    const throughLegs = suction.filter((m) => {
      const [a, b] = endpointsOf(m)
      const zs = [a.z, b.z].sort((p, q) => p - q)
      return (zs[0] as number) < -0.15 && Math.abs(zs[1] as number) < 1e-6
    })
    expect(throughLegs.length).toBeGreaterThan(0)
    for (const m of throughLegs) {
      const [a] = endpointsOf(m)
      expect(Math.abs(a.x - 5)).toBeGreaterThan(0.5)
      expect(m.flag).toBeUndefined() // slid clear — nothing to warn about
    }
    // and the chain still closes unit → handler
    const handler = out.fixtures.find((f) => f.label?.includes('Air handler')) as Fixture
    expect(
      chainConnects(
        suction,
        [unit.position[0], unit.position[2]],
        [handler.position[0], handler.position[2]],
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Long-run advisory (~15 m — manufacturer line-set charts govern)
// ---------------------------------------------------------------------------

describe('line-set length advisory', () => {
  test('a run over ~15 m carries the oil-return advisory on every leg', () => {
    const { walls, rooms } = shell(40, 14)
    const out = layoutHvac(walls, rooms, LOD400, { heatPump: { position: [40.7, 0, 7] } })
    const legs = runOf(out.members, 'lineset-suction-1')
    expect(legs.length).toBeGreaterThan(0)
    const total = legs.reduce((s, m) => s + m.length, 0)
    expect(total).toBeGreaterThan(15)
    expect(
      legs.every((m) =>
        m.flag?.includes('verify manufacturer max line-set length / oil return'),
      ),
    ).toBe(true)
  })

  test('a short run stays advisory-free', () => {
    const { walls, rooms } = shell(26, 10)
    const { members } = layoutHvac(walls, rooms, LOD400)
    const legs = members.filter((m) => m.sourceId.startsWith('lineset-'))
    expect(legs.length).toBeGreaterThan(0)
    expect(legs.every((m) => m.flag === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Whip adjacency + disconnect within sight (NEC 440.14)
// ---------------------------------------------------------------------------

describe('whip — disconnect → unit, endpoint-adjacent', () => {
  test('each whip chains from its disconnect to its unit; the box stays within sight', () => {
    const { walls, rooms } = shell(26, 10)
    const { members, fixtures } = layoutHvac(walls, rooms, LOD400)
    const units = condensersOf(fixtures)
    for (let n = 1; n <= units.length; n++) {
      const unit = units[n - 1] as Fixture
      const disc = fixtures.find((f) => f.kind === 'disconnect' && f.meta?.unit === n) as Fixture
      expect(disc).toBeDefined()
      const whip = runOf(members, `ac-whip-${n}`)
      expect(whip.length).toBeGreaterThan(0)
      expect(
        chainConnects(
          whip,
          [disc.position[0], disc.position[2]],
          [unit.position[0], unit.position[2]],
        ),
      ).toBe(true)
      // within sight — the NEC 440.14 distance pin
      const dist = Math.hypot(
        disc.position[0] - unit.position[0],
        disc.position[1] - unit.position[1],
        disc.position[2] - unit.position[2],
      )
      expect(dist).toBeLessThanOrEqual(1.0)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Colors — the plumbing hot/cold convention mirrored (E3)
// ---------------------------------------------------------------------------

describe('line-set colors', () => {
  test('suction maps cold-blue, liquid warm-red — distinct from supply cold/hot', () => {
    expect(plumbingPipeColor('lineset-suction-1')).toBe(PLUMBING_COLORS.linesetSuction)
    expect(plumbingPipeColor('lineset-liquid-2')).toBe(PLUMBING_COLORS.linesetLiquid)
    // never confusable with the plumbing supply colors byte-for-byte
    expect(PLUMBING_COLORS.linesetSuction).not.toBe(PLUMBING_COLORS.cold)
    expect(PLUMBING_COLORS.linesetLiquid).not.toBe(PLUMBING_COLORS.hot)
    // whips and condensate never inherit pipe colors
    expect(plumbingPipeColor('ac-whip-1')).toBeNull()
    expect(plumbingPipeColor('r_laundry')).toBeNull()
  })
})
