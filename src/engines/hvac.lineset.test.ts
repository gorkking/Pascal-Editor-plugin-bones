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
// 2. Parallel pair — same plan path, constant vertical offset
// ---------------------------------------------------------------------------

describe('line-set pair parallelism', () => {
  test('every horizontal suction leg has a liquid twin 2×offset below on the same plan line', () => {
    const { walls, rooms } = shell(26, 10)
    const { members } = layoutHvac(walls, rooms, LOD400)
    for (let n = 1; n <= 2; n++) {
      const horiz = (id: string) =>
        runOf(members, id).filter((m) => !(m.rotation[1] === 0 && m.dims[1] === m.length))
      const suction = horiz(`lineset-suction-${n}`)
      const liquid = horiz(`lineset-liquid-${n}`)
      expect(suction.length).toBeGreaterThan(0)
      expect(suction.length).toBe(liquid.length)
      for (const s of suction) {
        const twin = liquid.find(
          (l) =>
            Math.abs(l.position[0] - s.position[0]) < 1e-6 &&
            Math.abs(l.position[2] - s.position[2]) < 1e-6 &&
            Math.abs(l.dims[0] - s.dims[0]) < 1e-6,
        )
        expect(twin).toBeDefined()
        // suction rides ABOVE the liquid line by exactly the pair offset
        expect((s.position[1] - (twin as Member).position[1])).toBeCloseTo(
          2 * LINESET_PAIR_OFFSET,
          9,
        )
      }
    }
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
