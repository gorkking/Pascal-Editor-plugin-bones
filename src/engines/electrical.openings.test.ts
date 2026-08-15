import { describe, expect, test } from 'bun:test'
import type { Fixture, Member, OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import { layoutElectrical, panelMountU, routeWiring } from './electrical'
import { endpointsOf, unreachableDevices } from './electrical.test-helpers'

/**
 * Prod report (2026-08-15): drop a low window or a door on a wall and the
 * wires bored straight through the rough opening; a switch box could land on
 * the glass. INVARIANT — nothing electrical occupies ANY rough opening:
 *  - no wire-run passes through an RO volume (detour over header/under sill),
 *  - no device box mounts inside an RO,
 *  - the panel never mounts across an RO,
 *  - and every detour still leaves the circuit physically continuous.
 * Also in review/CHECKLIST.md as invariant E1.
 */

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

const room = (category: RoomSlice['category'], polygon: [number, number][]): RoomSlice => ({
  id: `room_${category}`,
  name: category,
  category,
  polygon,
  boundaryWallIds: [],
  ceilingHeight: 2.7,
})

/** RO boxes in world space, deflated 2 cm so edge-riding detours don't trip. */
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
      // lateral half-extent: the wall body only — face-mounted box stubs
      // (thickness/2 + FACE_OFFSET) sit outside the RO plane by design
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
  p[0] > b.min[0] && p[0] < b.max[0] && p[1] > b.min[1] && p[1] < b.max[1] && p[2] > b.min[2] && p[2] < b.max[2]

/** Wire segments sampled every 5 cm against every RO box. */
function wiresThroughOpenings(members: Member[], walls: WallSlice[]): string[] {
  const boxes = roBoxes(walls)
  const bad: string[] = []
  for (const m of members) {
    if (m.role !== 'wire-run') continue
    if (m.label?.includes('⚠')) continue // flagged degenerate runs are exempt
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

function devicesInOpenings(fixtures: Fixture[], walls: WallSlice[]): string[] {
  const boxes = roBoxes(walls)
  return fixtures
    .filter((f) => f.kind !== 'light' && f.kind !== 'smoke-alarm')
    .filter((f) => boxes.some((b) => inBox([f.position[0], f.position[1], f.position[2]], b)))
    .map((f) => `${f.kind}@${f.position.join(',')}`)
}

const RECT: [number, number][] = [
  [0, 0],
  [8, 0],
  [8, 4],
  [0, 4],
]

describe('electrical vs rough openings (prod 2026-08-15)', () => {
  test('low picture window: wires detour, no box in the glass, still connected', () => {
    // sill 0.2 m — the 18" drill plane runs straight through it pre-fix
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [8, 0], openings: [opening('window', 4, 2.4, 0.2, 1.8)] }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
    ]
    const rooms = [room('bedroom', RECT)]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    expect(devicesInOpenings(fixtures, walls)).toEqual([])
    expect(wiresThroughOpenings(members, walls)).toEqual([])
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('normal-sill window still gets receptacles beneath it (NEC 210.52(A)(2)(2))', () => {
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [8, 0], openings: [opening('window', 4, 1.5, 0.9, 1.2)] }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
    ]
    const rooms = [room('bedroom', RECT)]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    // a receptacle SHOULD land under the window — fixed glass counts as wall space
    const under = fixtures.filter(
      (f) => f.kind.startsWith('receptacle') && f.sourceId === 'w_s' && Math.abs(f.position[0] - 4) < 1.5,
    )
    expect(under.length).toBeGreaterThan(0)
    expect(wiresThroughOpenings(members, walls)).toEqual([])
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('window butted to the door latch side: the switch box moves off the glass', () => {
    const walls = [
      makeWall({
        id: 'w_s',
        start: [0, 0],
        end: [8, 0],
        openings: [opening('door', 2.5, 0.95, 0, 2.15), opening('window', 4.2, 2.0, 0.3, 1.9)],
      }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
    ]
    const rooms = [room('bedroom', RECT)]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    expect(devicesInOpenings(fixtures, walls)).toEqual([])
    expect(wiresThroughOpenings(members, walls)).toEqual([])
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('full-height glazing: the crossing is flagged, never silent', () => {
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [8, 0], openings: [opening('window', 4, 3.0, 0, 2.48)] }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
    ]
    const rooms = [room('bedroom', RECT)]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    // unflagged wires stay out; if anything crosses it carries the ⚠ label
    expect(wiresThroughOpenings(members, walls)).toEqual([])
    expect(devicesInOpenings(fixtures, walls)).toEqual([])
  })

  test('window over the wall midpoint pushes the panel aside', () => {
    const wall = makeWall({
      id: 'w_s',
      start: [0, 0],
      end: [8, 0],
      openings: [opening('window', 4, 2.0, 0.8, 1.4)], // crosses panel height 60" AFF
    })
    const u = panelMountU(wall)
    expect(Math.abs(u - 4) > 1.0).toBe(true)
  })

  test('transom above the door: detour ducks the transom too', () => {
    const walls = [
      makeWall({
        id: 'w_s',
        start: [0, 0],
        end: [8, 0],
        height: 3.0,
        openings: [opening('door', 4, 0.95, 0, 2.15), opening('window', 4, 0.95, 2.25, 0.5)],
      }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4], height: 3.0 }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4], height: 3.0 }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0], height: 3.0 }),
    ]
    const rooms = [room('bedroom', RECT)]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    expect(wiresThroughOpenings(members, walls)).toEqual([])
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })
})
