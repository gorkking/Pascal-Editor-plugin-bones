import { describe, expect, test } from 'bun:test'
import type { OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import { feet, inches } from '../core/units'
import { layoutElectrical, openingSpans, pointInPolygon, streetEdgePoint } from './electrical'
import { unreachableDevices } from './electrical.test-helpers'
import { routeWiring } from './electrical'
import { computeTakeoff } from './takeoff'

/**
 * LOD-400 BATCH 14 gates — receptacle COVERAGE (outdoor / sink-GFCI /
 * counter / basin). Before B14 the engine had ZERO outdoor receptacles ever
 * (interiorFaces() returns interior faces only) while rules.json booked
 * `outdoorFrontAndBack`, every kitchen/bath box sat at 15" AFF, and the
 * 210.8(A)(7) sink-radius test hid behind a stale "once sink positions are
 * extracted" comment although compute extracts placedFixtures today.
 */

const RO_PAD = inches(1.5)

function wall(
  id: string,
  start: [number, number],
  end: [number, number],
  overrides: Partial<WallSlice> = {},
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
    thickness: 0.15,
    height: 2.5,
    exterior: true,
    openings: [],
    curved: false,
    ...overrides,
  }
}

function door(u: number, width = 0.9, id = 'door_test'): OpeningSlice {
  return {
    id,
    kind: 'door',
    u,
    width,
    height: 2.1,
    sillHeight: 0,
    roughWidth: width + RO_PAD,
    roughHeight: 2.1 + RO_PAD,
  }
}

function room(
  category: RoomSlice['category'],
  polygon: readonly (readonly [number, number])[],
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

/** 8×6 rect shell: south w_s / east w_e / north w_n / west w_w, one living
 * room filling it. The panel lands on the longest exterior wall (south),
 * the meter beside it → the street edge is SOUTH (z = minZ − margin). */
function rectScene(southDoorU?: number): { walls: WallSlice[]; rooms: RoomSlice[] } {
  const walls = [
    wall('w_s', [0, 0], [8, 0], southDoorU === undefined ? {} : { openings: [door(southDoorU)] }),
    wall('w_e', [8, 0], [8, 6]),
    wall('w_n', [8, 6], [0, 6]),
    wall('w_w', [0, 6], [0, 0]),
  ]
  const rooms = [
    room('living', [
      [0, 0],
      [8, 0],
      [8, 6],
      [0, 6],
    ]),
  ]
  return { walls, rooms }
}

const outdoor = (fixtures: { kind: string }[]) =>
  fixtures.filter((f) => f.kind === 'receptacle-wr-gfci')

describe('B14a outdoor receptacles — NEC 210.52(E) front + back, WR GFCI, in-use covers', () => {
  test('a plain shell places >= 2 outdoor WR GFCI receptacles, front on the street-nearest wall, back opposite', () => {
    const { walls, rooms } = rectScene()
    const fixtures = layoutElectrical(walls, rooms)
    const out = outdoor(fixtures)
    expect(out.length).toBeGreaterThanOrEqual(2)

    // the meter anchors the street pick — assert the shared definition agrees
    const meter = fixtures.find((f) => f.kind === 'electric-meter')
    expect(meter).toBeDefined()
    const street = streetEdgePoint(walls, [
      (meter as { position: readonly number[] }).position[0] as number,
      (meter as { position: readonly number[] }).position[2] as number,
    ])
    expect(street[1]).toBeLessThan(0) // south edge

    const front = out.find((f) => f.meta?.outdoor === 'front')
    const back = out.find((f) => f.meta?.outdoor === 'back')
    expect(front).toBeDefined()
    expect(back).toBeDefined()
    expect(front?.sourceId).toBe('w_s') // street-nearest exterior wall
    expect(back?.sourceId).toBe('w_n') // opposite-facing, farthest from street
  })

  test('outdoor boxes carry the WR / GFCI / in-use-cover marks in kind, meta AND label', () => {
    const { walls, rooms } = rectScene()
    const out = outdoor(layoutElectrical(walls, rooms))
    for (const f of out) {
      expect(f.kind).toBe('receptacle-wr-gfci')
      expect(f.meta?.wr).toBe(true)
      expect(f.meta?.inUseCover).toBe(true)
      expect(f.label).toContain('210.52(E)')
      expect(f.label).toContain('406.9(B)')
      expect(f.label).toContain('WR GFCI')
      expect(String(f.meta?.deviceId)).toMatch(/^recep-w_[a-z]+-out-(front|back)$/)
    }
  })

  test('outdoor boxes mount on the EXTERIOR face — outside every room polygon', () => {
    const { walls, rooms } = rectScene()
    const out = outdoor(layoutElectrical(walls, rooms))
    for (const f of out) {
      const plan: [number, number] = [f.position[0], f.position[2]]
      expect(rooms.some((r) => pointInPolygon(plan, r.polygon))).toBe(false)
    }
  })

  test('RO clearance: a front door at the wall midpoint pushes the front box clear (box-edge aware)', () => {
    const doorU = 4 // exactly the naive midpoint of the 8 m south wall
    const { walls, rooms } = rectScene(doorU)
    const front = outdoor(layoutElectrical(walls, rooms)).find((f) => f.meta?.outdoor === 'front')
    expect(front).toBeDefined()
    const w = walls[0] as WallSlice
    const u =
      (Number(front?.position[0]) - w.start[0]) * w.dir[0] +
      (Number(front?.position[2]) - w.start[1]) * w.dir[1]
    const aff = Number(front?.position[1])
    const spans = openingSpans(w, aff - inches(2.25), aff + inches(2.25))
    expect(spans.length).toBeGreaterThan(0)
    const boxHalf = inches(1.5)
    for (const s of spans) {
      expect(u + boxHalf <= s.lo || u - boxHalf >= s.hi).toBe(true)
    }
    // bite-proof: the naive midpoint DOES sit inside the RO
    const hit = spans.some((s) => doorU > s.lo && doorU < s.hi)
    expect(hit).toBe(true)
  })

  test('outdoor receptacles ride their own 20 A GFCI exterior circuit (EXT-1) — never AFCI', () => {
    const { walls, rooms } = rectScene()
    const out = outdoor(layoutElectrical(walls, rooms))
    for (const f of out) {
      expect(f.meta?.circuit).toBe('EXT-1')
      expect(f.meta?.breakerA).toBe(20)
      expect(f.meta?.gaugeAwg).toBe(12)
      expect(f.meta?.gfci).toBe(true)
      expect(f.meta?.afci).toBeUndefined()
    }
  })

  test('E2: the outdoor boxes are panel-reachable as continuous cable', () => {
    const { walls, rooms } = rectScene()
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    const stranded = unreachableDevices(members, fixtures)
    expect(stranded).toEqual([])
    // the EXT-1 homerun exists as real cable
    expect(members.some((m) => m.sourceId === 'EXT-1')).toBe(true)
  })

  test('takeoff distinguishes WR from interior GFCI and books the in-use covers 1:1', () => {
    const { walls, rooms } = rectScene()
    // add a kitchen so INTERIOR GFCI exists alongside the WR boxes
    const kitchen = room('kitchen', [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ])
    const fixtures = layoutElectrical(walls, [kitchen, ...rooms])
    const roomsAll = [kitchen, ...rooms]
    void roomsAll
    const rows = computeTakeoff([], fixtures)
    const wrRow = rows.find((r) => r.item === 'WR GFCI receptacles (outdoor)')
    const gfciRow = rows.find((r) => r.item === 'GFCI receptacles')
    const coverRow = rows.find((r) => r.item === 'In-use covers (extra-duty)')
    const wrCount = outdoor(fixtures).length
    expect(wrRow?.quantity).toBe(wrCount)
    expect(coverRow?.quantity).toBe(wrCount)
    expect(coverRow?.detail).toContain('406.9(B)')
    // interior GFCI row excludes the WR boxes
    expect(gfciRow?.quantity).toBe(fixtures.filter((f) => f.kind === 'receptacle-gfci').length)
    expect(gfciRow?.quantity).toBeGreaterThan(0)
  })

  test('single-exterior-wall scene: both required outlets land on it, apart, and the level WARNS', () => {
    const walls = [
      wall('w_only', [0, 0], [8, 0]),
      wall('w_int', [0, 2], [8, 2], { exterior: false, thickness: 0.114 }),
    ]
    const warnings: string[] = []
    const out = outdoor(layoutElectrical(walls, [], undefined, warnings))
    expect(out.length).toBe(2)
    expect(new Set(out.map((f) => f.sourceId))).toEqual(new Set(['w_only']))
    const us = out.map(
      (f) => (f.position[0] - 0) * 1 + (f.position[2] - 0) * 0,
    )
    expect(Math.abs((us[0] as number) - (us[1] as number))).toBeGreaterThan(1)
    expect(warnings.some((w) => w.includes('single exterior wall') && w.includes('210.52(E)'))).toBe(
      true,
    )
  })

  test('no exterior wall at all: zero outdoor boxes, explicit warning — never silent', () => {
    const walls = [
      wall('w_a', [0, 0], [6, 0], { exterior: false }),
      wall('w_b', [0, 2], [6, 2], { exterior: false }),
    ]
    const warnings: string[] = []
    const out = outdoor(layoutElectrical(walls, [], undefined, warnings))
    expect(out.length).toBe(0)
    expect(warnings.some((w) => w.includes('210.52(E)'))).toBe(true)
  })

  test('outdoor mount height stays under the 6\'6" grade cap (210.52(E)(1))', () => {
    const { walls, rooms } = rectScene()
    for (const f of outdoor(layoutElectrical(walls, rooms))) {
      expect(f.position[1]).toBeLessThanOrEqual(feet(6.5))
      expect(f.position[1]).toBeGreaterThan(0)
    }
  })
})
