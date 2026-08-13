import { describe, expect, test } from 'bun:test'
import { Euler, Vector3 } from 'three'
import type { Fixture, OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import { feet, inches } from '../core/units'
import {
  layoutElectrical,
  pointInPolygon,
  polygonCentroid,
  receptaclePositions,
  usableSegments,
} from './electrical'

/** Rough-opening pad the extractor applies (wall-model.ts). */
const RO_PAD = inches(1.5)
/** Face offset: half default wall thickness + the 3/4" device-box proud. */
const OFF = 0.1 / 2 + inches(0.75)

const SIX_FT = feet(6)
const TWELVE_FT = feet(12)

function makeWall(overrides: Partial<WallSlice> = {}): WallSlice {
  const start = overrides.start ?? [0, 0]
  const end = overrides.end ?? [6, 0]
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  return {
    id: 'wall_test',
    start,
    end,
    length,
    dir: [dx / length, dz / length],
    thickness: 0.1,
    height: 2.5,
    exterior: false,
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

function window_(u: number, width = 1.2): OpeningSlice {
  return {
    id: 'window_test',
    kind: 'window',
    u,
    width,
    height: 1.2,
    sillHeight: 0.9,
    roughWidth: width + RO_PAD,
    roughHeight: 1.2 + RO_PAD,
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

const ofKind = (fixtures: Fixture[], kind: Fixture['kind']): Fixture[] =>
  fixtures.filter((f) => f.kind === kind)
const receptaclesOf = (fixtures: Fixture[]): Fixture[] =>
  fixtures.filter((f) => f.kind === 'receptacle' || f.kind === 'receptacle-gfci')

/** Direction a device faces after its Y rotation (renderer boxes face local +Z). */
const facing = (rotationY: number): Vector3 =>
  new Vector3(0, 0, 1).applyEuler(new Euler(0, rotationY, 0, 'XYZ'))

/** Assert the NEC 210.52(A) walk over one face: ends <= 6ft, gaps <= 12ft. */
function expectNecSpacing(us: number[], segStart: number, segEnd: number): void {
  const sorted = [...us].sort((a, b) => a - b)
  expect(sorted.length).toBeGreaterThan(0)
  expect((sorted[0] ?? 0) - segStart).toBeLessThanOrEqual(SIX_FT + 1e-9)
  expect(segEnd - (sorted[sorted.length - 1] ?? 0)).toBeLessThanOrEqual(SIX_FT + 1e-9)
  for (let i = 1; i < sorted.length; i++) {
    expect((sorted[i] ?? 0) - (sorted[i - 1] ?? 0)).toBeLessThanOrEqual(TWELVE_FT + 1e-9)
  }
}

describe('geometry helpers', () => {
  test('pointInPolygon ray cast', () => {
    const square = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ] as const
    expect(pointInPolygon([2, 2], square)).toBe(true)
    expect(pointInPolygon([5, 2], square)).toBe(false)
    expect(pointInPolygon([-0.1, 2], square)).toBe(false)
    // concave L-shape: notch is outside
    const ell = [
      [0, 0],
      [4, 0],
      [4, 2],
      [2, 2],
      [2, 4],
      [0, 4],
    ] as const
    expect(pointInPolygon([1, 3], ell)).toBe(true)
    expect(pointInPolygon([3, 3], ell)).toBe(false)
  })

  test('polygonCentroid of a rectangle is its center', () => {
    const c = polygonCentroid([
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ])
    expect(c[0]).toBeCloseTo(2, 6)
    expect(c[1]).toBeCloseTo(1.5, 6)
  })

  test('receptaclePositions: even fill satisfies the 6ft/12ft rule', () => {
    // 6m ≈ 19.7ft → 2 receptacles at quarter points
    expect(receptaclePositions({ a: 0, b: 6 })).toEqual([1.5, 4.5])
    // short segment → single receptacle at midpoint
    expect(receptaclePositions({ a: 1, b: 3 })).toEqual([2])
    // property check across lengths
    for (const L of [0.7, 2, 3.7, 6, 9.99, 15, 30]) {
      expectNecSpacing(receptaclePositions({ a: 0, b: L }), 0, L)
    }
  })
})

describe('usableSegments — doorways break the wall line (210.52(A)(2))', () => {
  test('solid wall is one segment', () => {
    expect(usableSegments(makeWall())).toEqual([{ a: 0, b: 6 }])
  })

  test('a door splits the wall at its rough opening', () => {
    const halfRo = (0.9 + RO_PAD) / 2
    const segs = usableSegments(makeWall({ openings: [door(3)] }))
    expect(segs).toHaveLength(2)
    expect(segs[0]?.a).toBeCloseTo(0, 6)
    expect(segs[0]?.b).toBeCloseTo(3 - halfRo, 6)
    expect(segs[1]?.a).toBeCloseTo(3 + halfRo, 6)
    expect(segs[1]?.b).toBeCloseTo(6, 6)
  })

  test('windows do NOT break the wall line', () => {
    expect(usableSegments(makeWall({ openings: [window_(3)] }))).toEqual([{ a: 0, b: 6 }])
  })

  test('stub segments under 2ft are dropped', () => {
    // door near the start leaves a ~0.13m stub → only the far segment survives
    const segs = usableSegments(makeWall({ openings: [door(0.6)] }))
    expect(segs).toHaveLength(1)
    expect(segs[0]?.a).toBeCloseTo(0.6 + (0.9 + RO_PAD) / 2, 6)
  })
})

describe('receptacles — solid 6m interior wall', () => {
  const wall = makeWall() // (0,0) → (6,0), interior
  const fixtures = layoutElectrical([wall], [])
  const receptacles = receptaclesOf(fixtures)

  test('interior wall gets receptacles on BOTH faces', () => {
    expect(receptacles).toHaveLength(4) // 2 per face
    expect(receptacles.filter((r) => (r.position[2] ?? 0) > 0)).toHaveLength(2)
    expect(receptacles.filter((r) => (r.position[2] ?? 0) < 0)).toHaveLength(2)
  })

  test('spacing <= 12ft and ends <= 6ft on each face', () => {
    for (const sign of [1, -1]) {
      const us = receptacles
        .filter((r) => Math.sign(r.position[2] ?? 0) === sign)
        .map((r) => r.position[0] ?? 0)
      expectNecSpacing(us, 0, 6)
    }
  })

  test('mounted 15in AFF, offset to the wall face, sourced to the wall', () => {
    for (const r of receptacles) {
      expect(r.system).toBe('electrical')
      expect(r.position[1]).toBeCloseTo(inches(15), 6)
      expect(Math.abs(r.position[2] ?? 0)).toBeCloseTo(OFF, 6)
      expect(r.sourceId).toBe('wall_test')
    }
  })

  test('rotationY points each device away from its wall (three.js check)', () => {
    for (const r of receptacles) {
      const dir = facing(r.rotationY)
      // outward normal of the face the device sits on
      expect(dir.z * Math.sign(r.position[2] ?? 0)).toBeCloseTo(1, 6)
      expect(dir.x).toBeCloseTo(0, 6)
    }
  })
})

describe('receptacles — wall with a door (spans measured around the doorway)', () => {
  const wall = makeWall({ openings: [door(3)] })
  const receptacles = receptaclesOf(layoutElectrical([wall], []))
  const halfRo = (0.9 + RO_PAD) / 2

  test('each side of the doorway gets its own walk', () => {
    // both flanking segments ≈ 2.53m (8.3ft) → 1 receptacle each per face
    expect(receptacles).toHaveLength(4)
    const us = [...new Set(receptacles.map((r) => Math.round((r.position[0] ?? 0) * 1e6) / 1e6))]
    expect(us.sort((a, b) => a - b)).toEqual([
      Math.round(((3 - halfRo) / 2) * 1e6) / 1e6,
      Math.round(((3 + halfRo + 6) / 2) * 1e6) / 1e6,
    ])
  })

  test('no receptacle lands inside the doorway', () => {
    for (const r of receptacles) {
      expect(Math.abs((r.position[0] ?? 0) - 3)).toBeGreaterThan(halfRo)
    }
  })

  test('per-segment ends stay within 6ft of the doorway edges', () => {
    const side = receptacles.filter((r) => (r.position[2] ?? 0) > 0).map((r) => r.position[0] ?? 0)
    expectNecSpacing(
      side.filter((u) => u < 3),
      0,
      3 - halfRo,
    )
    expectNecSpacing(
      side.filter((u) => u > 3),
      3 + halfRo,
      6,
    )
  })

  test('a window changes nothing — receptacles go under windows', () => {
    const solid = receptaclesOf(layoutElectrical([makeWall()], []))
    const windowed = receptaclesOf(layoutElectrical([makeWall({ openings: [window_(3)] })], []))
    expect(windowed.map((r) => r.position)).toEqual(solid.map((r) => r.position))
  })
})

describe('receptacles — exterior walls get one face, resolved into the room', () => {
  const livingNorth = room('other', [
    [0, 0],
    [6, 0],
    [6, 4],
    [0, 4],
  ])

  test('face lands on the side whose offset point is inside a room', () => {
    const wall = makeWall({ exterior: true })
    const receptacles = receptaclesOf(layoutElectrical([wall], [livingNorth]))
    expect(receptacles).toHaveLength(2) // one face only
    for (const r of receptacles) {
      expect(r.position[2]).toBeCloseTo(OFF, 6) // room is at z > 0
      expect(facing(r.rotationY).z).toBeCloseTo(1, 6)
    }
  })

  test('room on the other side flips the face', () => {
    const wall = makeWall({ exterior: true })
    const south = room('other', [
      [0, -4],
      [6, -4],
      [6, 0],
      [0, 0],
    ])
    const receptacles = receptaclesOf(layoutElectrical([wall], [south]))
    expect(receptacles).toHaveLength(2)
    for (const r of receptacles) {
      expect(r.position[2]).toBeCloseTo(-OFF, 6)
      expect(facing(r.rotationY).z).toBeCloseTo(-1, 6)
    }
  })

  test('no room data → defaults to the +normal face', () => {
    const receptacles = receptaclesOf(layoutElectrical([makeWall({ exterior: true })], []))
    expect(receptacles).toHaveLength(2)
    for (const r of receptacles) expect(r.position[2]).toBeCloseTo(OFF, 6)
  })

  test('wall along +Z: face offset and rotation follow the wall frame', () => {
    // exterior wall (0,0)→(0,3); room to its -X side
    const wall = makeWall({ start: [0, 0], end: [0, 3], exterior: true })
    const west = room('other', [
      [-4, 0],
      [0, 0],
      [0, 3],
      [-4, 3],
    ])
    const receptacles = receptaclesOf(layoutElectrical([wall], [west]))
    expect(receptacles).toHaveLength(1) // 3m ≈ 9.8ft → single device
    const r = receptacles[0] as Fixture
    expect(r.position[0]).toBeCloseTo(-OFF, 6)
    expect(r.position[2]).toBeCloseTo(1.5, 6) // segment midpoint along the wall
    const dir = facing(r.rotationY)
    expect(dir.x).toBeCloseTo(-1, 6) // faces into the room, away from the wall
    expect(dir.z).toBeCloseTo(0, 6)
  })
})

describe('GFCI — NEC 210.8(A) room zones', () => {
  const kitchen = room('kitchen', [
    [0, 0],
    [6, 0],
    [6, 4],
    [0, 4],
  ])

  test('receptacles whose face point falls in a kitchen become GFCI', () => {
    const wall = makeWall({ exterior: true })
    const receptacles = receptaclesOf(layoutElectrical([wall], [kitchen]))
    expect(receptacles).toHaveLength(2)
    for (const r of receptacles) expect(r.kind).toBe('receptacle-gfci')
  })

  test('ordinary rooms keep plain receptacles', () => {
    const bedroom = room('bedroom', kitchen.polygon)
    const receptacles = receptaclesOf(layoutElectrical([makeWall({ exterior: true })], [bedroom]))
    for (const r of receptacles) expect(r.kind).toBe('receptacle')
  })

  test('an interior kitchen/living partition is GFCI on the kitchen face only', () => {
    // wall (0,0)→(6,0); kitchen above (z>0), living below (z<0)
    const living = room('other', [
      [0, -4],
      [6, -4],
      [6, 0],
      [0, 0],
    ])
    const receptacles = receptaclesOf(layoutElectrical([makeWall()], [kitchen, living]))
    expect(receptacles).toHaveLength(4)
    for (const r of receptacles) {
      expect(r.kind).toBe((r.position[2] ?? 0) > 0 ? 'receptacle-gfci' : 'receptacle')
    }
  })
})

describe('switches — one per door at the latch side, 48in AFF', () => {
  const halfRo = (0.9 + RO_PAD) / 2

  test('interior wall: switch on BOTH faces, 8in past the +u RO edge', () => {
    const fixtures = layoutElectrical([makeWall({ end: [4, 0], openings: [door(2)] })], [])
    const switches = ofKind(fixtures, 'switch')
    expect(switches).toHaveLength(2)
    for (const s of switches) {
      expect(s.position[0]).toBeCloseTo(2 + halfRo + inches(8), 6)
      expect(s.position[1]).toBeCloseTo(inches(48), 6)
      expect(Math.abs(s.position[2] ?? 0)).toBeCloseTo(OFF, 6)
      expect(s.sourceId).toBe('door_test')
    }
  })

  test('door near the wall end flips the switch to the other side of the RO', () => {
    const fixtures = layoutElectrical([makeWall({ end: [4, 0], openings: [door(3.4)] })], [])
    const switches = ofKind(fixtures, 'switch')
    expect(switches).toHaveLength(2)
    for (const s of switches) {
      expect(s.position[0]).toBeCloseTo(3.4 - halfRo - inches(8), 6)
    }
  })

  test('exterior wall gets a single switch on the interior face', () => {
    const kitchen = room('kitchen', [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
    const fixtures = layoutElectrical(
      [makeWall({ end: [4, 0], exterior: true, openings: [door(2)] })],
      [kitchen],
    )
    const switches = ofKind(fixtures, 'switch')
    expect(switches).toHaveLength(1)
    expect(switches[0]?.position[2]).toBeCloseTo(OFF, 6)
  })
})

describe('lights and smoke alarms', () => {
  test('every room gets a ceiling light at its centroid', () => {
    const living = room('other', [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ])
    const lights = ofKind(layoutElectrical([], [living]), 'light')
    expect(lights).toHaveLength(1)
    const light = lights[0] as Fixture
    expect(light.position[0]).toBeCloseTo(2, 6)
    expect(light.position[1]).toBeCloseTo(2.7, 6) // ceilingHeight
    expect(light.position[2]).toBeCloseTo(1.5, 6)
    expect(light.sourceId).toBe(living.id)
  })

  test('each bedroom gets a ceiling smoke alarm (IRC R314.3)', () => {
    const bedroom = room('bedroom', [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
    const alarms = ofKind(layoutElectrical([], [bedroom]), 'smoke-alarm')
    expect(alarms).toHaveLength(1)
    const alarm = alarms[0] as Fixture
    expect(alarm.position[1]).toBeCloseTo(2.7, 6)
    // nudged 12" off the centroid so it doesn't overlap the room light
    expect(alarm.position[0]).toBeCloseTo(2 + inches(12), 6)
    expect(alarm.sourceId).toBe(bedroom.id)
  })

  test('a hallway adds one alarm outside the sleeping area', () => {
    const bedroom = room('bedroom', [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
    const hallway = room('hallway', [
      [4, 0],
      [6, 0],
      [6, 4],
      [4, 4],
    ])
    const alarms = ofKind(layoutElectrical([], [bedroom, hallway]), 'smoke-alarm')
    expect(alarms).toHaveLength(2)
    const hall = alarms.find((a) => a.sourceId === hallway.id) as Fixture
    expect(hall.position[0]).toBeCloseTo(5, 6)
    expect(hall.position[2]).toBeCloseTo(2, 6)
  })

  test('no bedrooms, no hallway → no alarms', () => {
    const living = room('other', [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ])
    expect(ofKind(layoutElectrical([], [living]), 'smoke-alarm')).toHaveLength(0)
  })
})

describe('service panel', () => {
  test('prefers the longest garage-bounding wall over a longer exterior wall', () => {
    const garageWall = makeWall({ id: 'wall_garage', start: [0, 0], end: [5, 0] })
    const bigExterior = makeWall({ id: 'wall_ext', start: [10, 0], end: [18, 0], exterior: true })
    const garage = room(
      'garage',
      [
        [0, 0],
        [5, 0],
        [5, 5],
        [0, 5],
      ],
      { boundaryWallIds: ['wall_garage'] },
    )
    const panels = ofKind(layoutElectrical([garageWall, bigExterior], [garage]), 'panel')
    expect(panels).toHaveLength(1)
    const panel = panels[0] as Fixture
    expect(panel.sourceId).toBe('wall_garage')
    expect(panel.position[0]).toBeCloseTo(2.5, 6) // wall midpoint
    expect(panel.position[1]).toBeCloseTo(inches(60), 6) // 60in AFF
    expect(panel.position[2]).toBeCloseTo(OFF, 6) // garage side (z > 0)
    expect(facing(panel.rotationY).z).toBeCloseTo(1, 6) // faces into the garage
  })

  test('no garage → longest exterior wall, interior face', () => {
    const short = makeWall({ id: 'wall_short', start: [0, 0], end: [4, 0], exterior: true })
    const long = makeWall({ id: 'wall_long', start: [0, 4], end: [8, 4], exterior: true })
    const panels = ofKind(layoutElectrical([short, long], []), 'panel')
    expect(panels[0]?.sourceId).toBe('wall_long')
    expect(panels[0]?.position[0]).toBeCloseTo(4, 6)
  })

  test('no walls → no panel', () => {
    expect(ofKind(layoutElectrical([], []), 'panel')).toHaveLength(0)
  })
})

describe('count sanity — two-room plan (living + kitchen)', () => {
  // 8m x 4m shell, divider at x=3.5; exterior door in the south kitchen wall,
  // interior door in the divider.
  const south = makeWall({
    id: 'w_south',
    start: [0, 0],
    end: [8, 0],
    exterior: true,
    openings: [door(6, 0.9, 'door_entry')],
  })
  const east = makeWall({ id: 'w_east', start: [8, 0], end: [8, 4], exterior: true })
  const north = makeWall({ id: 'w_north', start: [8, 4], end: [0, 4], exterior: true })
  const west = makeWall({ id: 'w_west', start: [0, 4], end: [0, 0], exterior: true })
  const divider = makeWall({
    id: 'w_div',
    start: [3.5, 0],
    end: [3.5, 4],
    openings: [door(2, 0.9, 'door_kitchen')],
  })
  const living = room('other', [
    [0, 0],
    [3.5, 0],
    [3.5, 4],
    [0, 4],
  ])
  const kitchen = room('kitchen', [
    [3.5, 0],
    [8, 0],
    [8, 4],
    [3.5, 4],
  ])
  const fixtures = layoutElectrical([south, east, north, west, divider], [living, kitchen])

  test('fixture counts per kind', () => {
    // receptacles: south 3 (door splits 8m), east 2, north 3, west 2,
    // divider 2 per face x 2 faces = 4 → 14 total
    expect(receptaclesOf(fixtures)).toHaveLength(14)
    // switches: entry door 1 face + interior door 2 faces
    expect(ofKind(fixtures, 'switch')).toHaveLength(3)
    expect(ofKind(fixtures, 'light')).toHaveLength(2)
    expect(ofKind(fixtures, 'smoke-alarm')).toHaveLength(0)
    expect(ofKind(fixtures, 'panel')).toHaveLength(1)
    expect(fixtures).toHaveLength(20)
  })

  test('exterior walls emit on the interior face only', () => {
    for (const r of receptaclesOf(fixtures)) {
      const [x, , z] = r.position
      expect(x).toBeGreaterThan(0)
      expect(x).toBeLessThan(8)
      expect(z).toBeGreaterThan(0)
      expect(z).toBeLessThan(4)
    }
  })

  test('kitchen-side receptacles are GFCI, living-side are plain', () => {
    for (const r of receptaclesOf(fixtures)) {
      const x = r.position[0] ?? 0
      if (x > 3.5 + 0.01) expect(r.kind).toBe('receptacle-gfci')
      if (x < 3.5 - 0.01) expect(r.kind).toBe('receptacle')
    }
    expect(ofKind(fixtures, 'receptacle-gfci')).toHaveLength(8)
    expect(ofKind(fixtures, 'receptacle')).toHaveLength(6)
  })

  test('every fixture is tagged electrical with a valid source', () => {
    const ids = new Set(['w_south', 'w_east', 'w_north', 'w_west', 'w_div'])
    for (const f of fixtures) {
      expect(f.system).toBe('electrical')
      if (f.kind === 'receptacle' || f.kind === 'receptacle-gfci' || f.kind === 'panel') {
        expect(ids.has(f.sourceId)).toBe(true)
      }
    }
  })
})
