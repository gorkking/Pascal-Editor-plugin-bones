import { describe, expect, test } from 'bun:test'
import type { OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import { layoutElectrical, routeWiring } from './electrical'
import { endpointsOf, unreachableDevices } from './electrical.test-helpers'

/**
 * Checklist E4: no wire ever crosses open room air at living height.
 * Every horizontal wire segment must be (a) along some wall's centerline
 * band, (b) at/above the ceiling plane (joist/attic crossings — how a real
 * pull bridges disconnected islands), or (c) below grade (buried feeder).
 * Bed-height jumpers and cross-room diagonals are physically impossible
 * cable paths even when they avoid ROs.
 */

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

/** E4 violations: horizontal segments hanging in open air at living height. */
function airRuns(members: ReturnType<typeof routeWiring>, walls: WallSlice[]): string[] {
  const bad: string[] = []
  const ceilingY = Math.max(...walls.map((w) => w.height))
  const onSomeWall = (px: number, pz: number, qx: number, qz: number): boolean =>
    walls.some((w) => {
      const near = (x: number, z: number): boolean => {
        const dx = x - w.start[0]
        const dz = z - w.start[1]
        const along = dx * w.dir[0] + dz * w.dir[1]
        const perp = Math.abs(-dx * w.dir[1] + dz * w.dir[0])
        return along > -0.15 && along < w.length + 0.15 && perp < w.thickness / 2 + 0.08
      }
      return near(px, pz) && near(qx, qz)
    })
  for (const m of members) {
    if (m.material !== 'copper') continue
    const [a, b] = endpointsOf(m)
    const horizontal = Math.abs(a.y - b.y) < 0.005
    const len = a.distanceTo(b)
    if (!horizontal || len < 0.05) continue
    const y = (a.y + b.y) / 2
    if (y >= ceilingY - 0.01) continue // joist/attic crossing — legal
    if (y <= 0.01) continue // buried — legal
    if (onSomeWall(a.x, a.z, b.x, b.z)) continue
    bad.push(`${m.label ?? m.sourceId} @y=${y.toFixed(2)} len=${len.toFixed(2)}`)
  }
  return bad
}

describe('E4 — no air runs at living height', () => {
  test('connected two-room plan: every horizontal wire lies on a wall', () => {
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [8, 0] }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
      makeWall({ id: 'w_div', start: [4, 0], end: [4, 4], exterior: false }),
    ]
    const rooms = [
      room('kitchen', [[0, 0], [4, 0], [4, 4], [0, 4]]),
      room('bedroom', [[4, 0], [8, 0], [8, 4], [4, 4]], { id: 'room_bed' }),
    ]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    expect(airRuns(members, walls)).toEqual([])
  })

  test('disconnected island: hops cross at CEILING height, stay connected', () => {
    // Main room + a detached island wall 2m away — no shared junctions, so
    // the wall graph cannot bridge them. Pre-fix: two bed-height air legs.
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [6, 0] }),
      makeWall({ id: 'w_e', start: [6, 0], end: [6, 4] }),
      makeWall({ id: 'w_n', start: [6, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
      makeWall({ id: 'w_island', start: [8.5, 1], end: [8.5, 3], exterior: false }),
    ]
    const rooms = [
      room('other', [[0, 0], [6, 0], [6, 4], [0, 4]]),
      // a room leaning on the island wall so devices land there
      room('bedroom', [[6.5, 0], [10.5, 0], [10.5, 4], [6.5, 4]], { id: 'room_isl' }),
    ]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    expect(members.length).toBeGreaterThan(0)
    // the E4 invariant: nothing horizontal hangs in the air below ceiling
    expect(airRuns(members, walls)).toEqual([])
    // and the ceiling crossing is not a teleport: connectivity still holds
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })
})
