import { describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import type { Member, OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import { feet } from '../core/units'
import { jurisdictionOptions } from '../jurisdiction/profiles'
import { baselineConfig, baselineScene } from '../framing/baseline-scene'
import { computeLevel } from '../framing/compute'
import { layoutElectrical, routeWiring } from './electrical'
import { MERGE_TOL, endpointsOf, segDist } from './electrical.test-helpers'
import { computeTakeoff } from './takeoff'

/**
 * Checklist E7 — the grounding electrode system (LOD-400 B12, NEC 250).
 * Every service chain carries its GES: two driven rods below grade at the
 * meter 6 ft apart (250.53(A)(2)/(B)), a continuous GEC meter → both rods
 * sized from the service rating (250.66), an intersystem bonding
 * termination at the service (250.94), and the metal-water-pipe bond
 * (250.104) — present when a water entry is visible, LABELED as an
 * assumption when not. Takeoff rows mirror the members 1:1.
 */

// ---------------------------------------------------------------------------
// Harness (the connectivity-suite scene shapes)
// ---------------------------------------------------------------------------

function makeWall(overrides: Partial<WallSlice> = {}): WallSlice {
  const start = overrides.start ?? [0, 0]
  const end = overrides.end ?? [4, 0]
  const dx = (end[0] ?? 0) - (start[0] ?? 0)
  const dz = (end[1] ?? 0) - (start[1] ?? 0)
  const length = Math.hypot(dx, dz)
  return {
    id: 'wall_c',
    start,
    end,
    dir: [dx / length, dz / length],
    length,
    thickness: 0.114,
    height: 2.5,
    exterior: true,
    openings: [] as OpeningSlice[],
    curved: false,
    ...overrides,
  }
}

function room(
  category: RoomSlice['category'],
  polygon: [number, number][],
  overrides: Partial<RoomSlice> = {},
): RoomSlice {
  return {
    id: `room_${category}`,
    name: category,
    category,
    polygon,
    boundaryWallIds: [],
    ceilingHeight: 2.7,
    ...overrides,
  }
}

const houseWalls = (): WallSlice[] => [
  makeWall({ id: 'w_s', start: [0, 0], end: [8, 0] }),
  makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
  makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
  makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
  makeWall({ id: 'w_div', start: [4, 0], end: [4, 4], exterior: false }),
]
const houseRooms = (): RoomSlice[] => [
  room('kitchen', [[0, 0], [4, 0], [4, 4], [0, 4]]),
  room('bedroom', [[4, 0], [8, 0], [8, 4], [4, 4]], { id: 'room_bed' }),
]

/** A plausible water entry ON a wall centerline (what compute resolves). */
const WATER_ENTRY: readonly [number, number, number] = [2, 0.3, 4]

const gesMembers = (members: Member[]): Member[] =>
  members.filter(
    (m) =>
      m.role === 'ground-rod' || m.sourceId === 'GES-1' || m.sourceId === 'GES-2' || m.sourceId === 'ges-ibt',
  )

const rodsOf = (members: Member[]): Member[] => members.filter((m) => m.role === 'ground-rod')

/** Rod TOP point (rods are vertical, length in dims[1], position = center). */
const rodTop = (rod: Member): Vector3 =>
  new Vector3(rod.position[0], rod.position[1] + rod.dims[1] / 2, rod.position[2])

/**
 * E2-style continuity: union-find over the given wire members' endpoints;
 * true when `from` and `to` land on the same connected component.
 */
function connected(wires: Member[], from: Vector3, to: Vector3): boolean {
  const parent: number[] = wires.map((_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r] as number
    return r
  }
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b)
  }
  const ends = wires.map(endpointsOf)
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const [a1, a2] = ends[i] as [Vector3, Vector3]
      const [b1, b2] = ends[j] as [Vector3, Vector3]
      const touch =
        a1.distanceTo(b1) < MERGE_TOL ||
        a1.distanceTo(b2) < MERGE_TOL ||
        a2.distanceTo(b1) < MERGE_TOL ||
        a2.distanceTo(b2) < MERGE_TOL ||
        segDist(a1, b1, b2) < 0.03 ||
        segDist(a2, b1, b2) < 0.03 ||
        segDist(b1, a1, a2) < 0.03 ||
        segDist(b2, a1, a2) < 0.03
      if (touch) union(i, j)
    }
  }
  const touching = (p: Vector3): number | null => {
    for (let i = 0; i < wires.length; i++) {
      const [a, b] = ends[i] as [Vector3, Vector3]
      if (segDist(p, a, b) < 0.03) return i
    }
    return null
  }
  const fi = touching(from)
  const ti = touching(to)
  return fi !== null && ti !== null && find(fi) === find(ti)
}

const route = (waterEntry: readonly [number, number, number] | null = WATER_ENTRY) => {
  const walls = houseWalls()
  const fixtures = layoutElectrical(walls, houseRooms())
  const members = routeWiring(fixtures, walls, { waterEntry })
  return { walls, fixtures, members }
}

// ---------------------------------------------------------------------------
// Census + geometry
// ---------------------------------------------------------------------------

describe('GES census (checklist E7)', () => {
  test('exactly TWO driven rods, 6 ft apart, below grade, at the meter', () => {
    const { fixtures, members } = route()
    const rods = rodsOf(members)
    expect(rods.length).toBe(2)
    const [r1, r2] = rods as [Member, Member]
    // 6 ft plan separation (250.53(A)(2)/(B))
    const spacing = Math.hypot(
      r2.position[0] - r1.position[0],
      r2.position[2] - r1.position[2],
    )
    expect(spacing).toBeCloseTo(feet(6), 5)
    // at the METER: rod 1 within arm's reach of the meter mount
    const meter = fixtures.find((f) => f.kind === 'electric-meter')
    expect(meter).toBeDefined()
    const meterPlanDist = Math.hypot(
      (meter?.position[0] ?? 0) - r1.position[0],
      (meter?.position[2] ?? 0) - r1.position[2],
    )
    expect(meterPlanDist).toBeLessThan(1.0)
    for (const rod of rods) {
      // 8 ft embedment, top strictly below grade (250.52(A)(5), 250.53(G))
      expect(rod.length).toBeCloseTo(feet(8), 5)
      expect(rod.dims[1]).toBeCloseTo(feet(8), 5)
      const top = rod.position[1] + rod.dims[1] / 2
      const bottom = rod.position[1] - rod.dims[1] / 2
      expect(top).toBeLessThan(0)
      expect(bottom).toBeCloseTo(top - feet(8), 5)
    }
  })

  test('GEC is continuous meter → BOTH rods (E2-style union-find) and sized with a code cite', () => {
    const { fixtures, members } = route()
    const gec = members.filter((m) => m.sourceId === 'GES-1')
    expect(gec.length).toBeGreaterThan(0)
    for (const m of gec) {
      expect(m.label).toContain('NEC 250.66')
      expect(m.label).toMatch(/GEC \d+ AWG Cu/)
    }
    const meter = fixtures.find((f) => f.kind === 'electric-meter')
    const meterAt = new Vector3(...(meter?.position ?? [0, 0, 0]))
    for (const rod of rodsOf(members)) {
      expect(connected(gec, meterAt, rodTop(rod))).toBe(true)
    }
  })

  test('intersystem bonding termination mounts at the meter (250.94)', () => {
    const { fixtures, members } = route()
    const ibt = members.filter((m) => m.sourceId === 'ges-ibt')
    expect(ibt.length).toBe(1)
    const meter = fixtures.find((f) => f.kind === 'electric-meter')
    const d = Math.hypot(
      (meter?.position[0] ?? 0) - (ibt[0]?.position[0] ?? 9),
      (meter?.position[2] ?? 0) - (ibt[0]?.position[2] ?? 9),
    )
    expect(d).toBeLessThan(0.1)
    expect(ibt[0]?.label).toContain('NEC 250.94')
  })

  test('water-pipe bond: continuous panel → water entry, E4-legal legs', () => {
    const { walls, fixtures, members } = route()
    const bond = members.filter((m) => m.sourceId === 'GES-2')
    expect(bond.length).toBeGreaterThan(0)
    for (const m of bond) expect(m.label).toContain('NEC 250.104')
    const panel = fixtures.find((f) => f.kind === 'panel')
    expect(
      connected(bond, new Vector3(...(panel?.position ?? [0, 0, 0])), new Vector3(...WATER_ENTRY)),
    ).toBe(true)
    // no bond leg hangs in room air at living height (E4's invariant)
    const ceilingY = Math.max(...walls.map((w) => w.height))
    for (const m of bond) {
      const [a, b] = endpointsOf(m)
      if (Math.abs(a.y - b.y) >= 0.005 || a.distanceTo(b) < 0.05) continue
      const y = (a.y + b.y) / 2
      if (y >= ceilingY - 0.01 || y <= 0.01) continue
      const onWall = walls.some((w) => {
        const near = (x: number, z: number): boolean => {
          const dx = x - w.start[0]
          const dz = z - w.start[1]
          const along = dx * w.dir[0] + dz * w.dir[1]
          const perp = Math.abs(-dx * w.dir[1] + dz * w.dir[0])
          return along > -0.15 && along < w.length + 0.15 && perp < w.thickness / 2 + 0.08
        }
        return near(a.x, a.z) && near(b.x, b.z)
      })
      expect(onWall, `${m.label} @y=${y.toFixed(2)}`).toBe(true)
    }
  })

  test('GEC horizontal legs: at/below the grade line, or strapped ON the wall (E4)', () => {
    const { walls, members } = route()
    for (const m of members.filter((w) => w.sourceId === 'GES-1')) {
      const [a, b] = endpointsOf(m)
      if (Math.abs(a.y - b.y) >= 0.005) continue
      const y = (a.y + b.y) / 2
      if (y <= 0.01) continue // grade-line / buried — legal
      // the meter strap-out rides the wall band (never open room air)
      const onWall = walls.some((w) => {
        const near = (x: number, z: number): boolean => {
          const dx = x - w.start[0]
          const dz = z - w.start[1]
          const along = dx * w.dir[0] + dz * w.dir[1]
          const perp = Math.abs(-dx * w.dir[1] + dz * w.dir[0])
          return along > -0.15 && along < w.length + 0.15 && perp < w.thickness / 2 + 0.08
        }
        return near(a.x, a.z) && near(b.x, b.z)
      })
      expect(onWall, `${m.label} @y=${y.toFixed(2)}`).toBe(true)
    }
    // …and the legs that CARRY the run to the rods really are down at grade
    const gradeLegs = members.filter(
      (w) => w.sourceId === 'GES-1' && (w.label?.includes('grade run') || w.label?.includes('rod 1 → rod 2')),
    )
    expect(gradeLegs.length).toBeGreaterThanOrEqual(2)
    for (const m of gradeLegs) expect(m.position[1]).toBeLessThanOrEqual(0.01)
  })

  test('NO water entry: bond absent, assumption LABELED on the termination — never silent', () => {
    const { members } = route(null)
    expect(members.filter((m) => m.sourceId === 'GES-2').length).toBe(0)
    const ibt = members.find((m) => m.sourceId === 'ges-ibt')
    expect(ibt?.label).toContain('water-pipe bond not modeled')
    expect(ibt?.label).toContain('250.104')
    // rods + GEC still land — the GES itself never depends on plumbing
    expect(rodsOf(members).length).toBe(2)
  })

  test('no meter (the AC-disconnect routing subset): zero GES members', () => {
    const walls = houseWalls()
    const fixtures = layoutElectrical(walls, houseRooms()).filter(
      (f) => f.kind !== 'electric-meter',
    )
    const members = routeWiring(fixtures, walls, { waterEntry: WATER_ENTRY })
    expect(gesMembers(members).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Takeoff parity: rows == member counts / lengths
// ---------------------------------------------------------------------------

describe('GES takeoff rows mirror the members (S4 parity)', () => {
  const round1 = (n: number): number => Math.round(n * 10) / 10
  const toFeetSum = (ms: Member[]): number =>
    round1(ms.reduce((sum, m) => sum + m.length / 0.3048, 0))

  test('rods pcs / clamps pcs / GEC lf / bonding jumper lf / termination pcs', () => {
    const { fixtures, members } = route()
    const rows = computeTakeoff(members, fixtures)
    const row = (item: string) => rows.find((r) => r.item.startsWith(item))
    expect(row('Ground rods')?.quantity).toBe(rodsOf(members).length)
    expect(row('Ground rods')?.quantity).toBe(2)
    // 2 acorn clamps + the water-pipe clamp
    expect(row('Ground clamps')?.quantity).toBe(3)
    expect(row('GEC')?.quantity).toBeCloseTo(
      toFeetSum(members.filter((m) => m.sourceId === 'GES-1')),
      5,
    )
    expect(row('GEC')?.unit).toBe('lf')
    expect(row('Bonding jumper')?.quantity).toBeCloseTo(
      toFeetSum(members.filter((m) => m.sourceId === 'GES-2')),
      5,
    )
    expect(row('Intersystem bonding termination')?.quantity).toBe(1)
    // gauge on the row matches the member labels (single source of truth)
    const awg = members
      .find((m) => m.sourceId === 'GES-1')
      ?.label?.match(/GEC (\d+) AWG/)?.[1]
    expect(row('GEC')?.item).toBe(`GEC ${awg} AWG bare Cu`)
  })

  test('bond-less scene: clamps drop to 2, no jumper row', () => {
    const { fixtures, members } = route(null)
    const rows = computeTakeoff(members, fixtures)
    expect(rows.find((r) => r.item.startsWith('Ground clamps'))?.quantity).toBe(2)
    expect(rows.find((r) => r.item.startsWith('Bonding jumper'))).toBeUndefined()
  })

  test('GEC/bond lf never leaks into the NM-B tallies', () => {
    const { fixtures, members } = route()
    const withGes = computeTakeoff(members, fixtures)
    const withoutGes = computeTakeoff(
      members.filter((m) => m.sourceId !== 'GES-1' && m.sourceId !== 'GES-2'),
      fixtures,
    )
    const nm = (rows: typeof withGes) =>
      rows.filter((r) => r.item.startsWith('NM-B')).map((r) => `${r.item}|${r.quantity}`)
    expect(nm(withGes)).toEqual(nm(withoutGes))
  })
})

// ---------------------------------------------------------------------------
// Jurisdiction sweep — the GES is universal NEC
// ---------------------------------------------------------------------------

describe('GES on every jurisdiction (universal NEC)', () => {
  /** The baseline scene with a REAL placed toilet — plumbing takes the
   * placed path and models its water-meter fixture (the bond target). */
  const placedScene = (): Record<string, Record<string, unknown>> => {
    const scene = baselineScene()
    scene.toilet_1 = { ...scene.toilet_1, asset: { id: 'toilet' } }
    return scene
  }

  test('all states: 2 rods + GEC + termination + water bond on the placed scene', () => {
    for (const { code } of jurisdictionOptions()) {
      const result = computeLevel(placedScene(), baselineConfig(code))
      const rods = rodsOf(result.members)
      expect(rods.length, code).toBe(2)
      expect(result.members.some((m) => m.sourceId === 'GES-1'), code).toBe(true)
      expect(result.members.some((m) => m.sourceId === 'ges-ibt'), code).toBe(true)
      // plumbing models its water meter → the bond lands, no assumption
      expect(result.members.some((m) => m.sourceId === 'GES-2'), code).toBe(true)
      expect(
        result.warnings.some((w) => w.includes('water-pipe bond')),
        code,
      ).toBe(false)
    }
  })

  test('cross-trade parity: the bond terminates AT the plumbing water meter', () => {
    const result = computeLevel(placedScene(), baselineConfig('INTL'))
    const waterMeter = result.fixtures.find((f) => f.kind === 'water-meter')
    expect(waterMeter).toBeDefined()
    const target = new Vector3(...(waterMeter?.position ?? [0, 0, 0]))
    const bond = result.members.filter((m) => m.sourceId === 'GES-2')
    expect(bond.length).toBeGreaterThan(0)
    const nearest = Math.min(
      ...bond.flatMap((m) => endpointsOf(m).map((p) => p.distanceTo(target))),
    )
    expect(nearest).toBeLessThan(0.03)
  })

  test('fallback-path plumbing (no placed fixtures): no meter is modeled — warn + label, never silent', () => {
    // the stock baseline toilet has NO sanitary asset id → room-category
    // fallback plumbing, which draws no water-meter fixture at all
    const result = computeLevel(baselineScene(), baselineConfig('INTL'))
    expect(result.fixtures.some((f) => f.kind === 'water-meter')).toBe(false)
    expect(result.members.filter((m) => m.sourceId === 'GES-2').length).toBe(0)
    expect(
      result.warnings.some((w) => w.includes('water-pipe bond (NEC 250.104) not modeled')),
    ).toBe(true)
    const ibt = result.members.find((m) => m.sourceId === 'ges-ibt')
    expect(ibt?.label).toContain('water-pipe bond not modeled')
    // rods + GEC land regardless — the GES never depends on plumbing
    expect(rodsOf(result.members).length).toBe(2)
  })

  test('plumbing OFF + waterEntry service override: bond to the override', () => {
    const scene = baselineScene()
    scene.svc_water = {
      id: 'svc_water',
      type: 'bones:service',
      parentId: 'level_1',
      serviceType: 'water-entry',
      wallId: 'w_n',
      wallT: 0.25,
      heightAff: 0.3,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    }
    const config = baselineConfig('INTL')
    const result = computeLevel(scene, { ...config, showPlumbing: false })
    const bond = result.members.filter((m) => m.sourceId === 'GES-2')
    expect(bond.length).toBeGreaterThan(0)
    expect(result.warnings.some((w) => w.includes('water-pipe bond'))).toBe(false)
    // the bond really ends at the override's wall point: w_n runs
    // [12,8]→[0,8], t=0.25 → plan [9, 8] at 0.3 AFF
    const target = new Vector3(9, 0.3, 8)
    const nearest = Math.min(
      ...bond.flatMap((m) => endpointsOf(m).map((p) => p.distanceTo(target))),
    )
    expect(nearest).toBeLessThan(0.03)
  })

  test('plumbing OFF + no override: the level warns and the termination is labeled', () => {
    const config = baselineConfig('INTL')
    const result = computeLevel(baselineScene(), { ...config, showPlumbing: false })
    expect(result.members.filter((m) => m.sourceId === 'GES-2').length).toBe(0)
    expect(result.warnings.some((w) => w.includes('water-pipe bond (NEC 250.104) not modeled'))).toBe(
      true,
    )
    const ibt = result.members.find((m) => m.sourceId === 'ges-ibt')
    expect(ibt?.label).toContain('water-pipe bond not modeled')
  })
})
