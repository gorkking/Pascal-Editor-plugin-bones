import { describe, expect, test } from 'bun:test'
import { Euler, Vector3 } from 'three'
import type { Fixture, Member, OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import { layoutElectrical, routeWiring } from './electrical'

/**
 * Round-12 Phase 0: GLOBAL panel-to-device reachability (the harness the
 * round-12 reviewer demanded before any other electrical work).
 *
 * Every routed circuit must be physically continuous cable: a union-find
 * over wire-member endpoints (2 cm merge, 3 cm endpoint-to-segment attach)
 * must connect the panel to EVERY device. Three verified bugs used to pass
 * the old proximity-only tests while stranding devices:
 *  - B1: panel mounted inside a door RO → 22/22 devices unreachable;
 *  - B2: tee junction snapped out of a door RO → unbridged 0.52 m hop;
 *  - M1: junctions within JUNCTION_TOL but not coincident → 5–25 cm gaps.
 */

// ---------------------------------------------------------------------------
// Fixtures
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
    openings: [],
    curved: false,
    ...overrides,
  }
}

const door = (u: number, roughWidth = 0.95): OpeningSlice => ({
  id: `door_${u}`,
  kind: 'door',
  u,
  width: roughWidth - 0.05,
  roughWidth,
  height: 2.1,
  roughHeight: 2.15,
  sillHeight: 0,
})

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

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

const MERGE_TOL = 0.02
const ATTACH_TOL = 0.03
/** Devices attach to their box stub's endpoint — tight, no fudge. */
const DEVICE_TOL = 0.02

function endpointsOf(m: Member): [Vector3, Vector3] {
  const axis = new Vector3(1, 0, 0)
    .applyEuler(new Euler(m.rotation[0], m.rotation[1], m.rotation[2], 'XYZ'))
    .multiplyScalar(
      (m.dims[0] >= Math.max(m.dims[1], m.dims[2]) ? m.dims[0] : m.dims[1]) / 2,
    )
  // vertical wires store length in dims[1]
  const vertical = m.dims[1] > m.dims[0]
  const a = new Vector3(...m.position)
  const half = vertical ? new Vector3(0, m.dims[1] / 2, 0) : axis
  return [a.clone().add(half), a.clone().sub(half)]
}

function segDist(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = b.clone().sub(a)
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(1e-9, ab.lengthSq())))
  return p.distanceTo(a.clone().add(ab.multiplyScalar(t)))
}

/**
 * Union-find over wire endpoints; returns the ids of devices NOT connected
 * to the panel component.
 */
export function unreachableDevices(
  members: Member[],
  fixtures: Fixture[],
): string[] {
  const wires = members.filter((m) => m.role === 'wire-run')
  const panel = fixtures.find((f) => f.kind === 'panel')
  if (!panel) return []
  const routed = fixtures.filter((f) => f !== panel && typeof f.meta?.circuit === 'string')

  const parent: number[] = wires.map((_, i) => i)
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
        segDist(a1, b1, b2) < ATTACH_TOL ||
        segDist(a2, b1, b2) < ATTACH_TOL ||
        segDist(b1, a1, a2) < ATTACH_TOL ||
        segDist(b2, a1, a2) < ATTACH_TOL
      if (touch) union(i, j)
    }
  }

  const componentsNear = (p: Vector3, tol: number): Set<number> => {
    const comps = new Set<number>()
    for (let i = 0; i < wires.length; i++) {
      const [a, b] = ends[i] as [Vector3, Vector3]
      if (p.distanceTo(a) < tol || p.distanceTo(b) < tol || segDist(p, a, b) < tol) {
        comps.add(find(i))
      }
    }
    return comps
  }

  // Circuits run on per-circuit drill planes (12mm steps) so each homerun
  // is its OWN component — every one of them must touch the panel.
  const panelComps = componentsNear(new Vector3(...panel.position), 0.35)
  if (panelComps.size === 0) return routed.map((f) => f.sourceId)
  const out: string[] = []
  for (const f of routed) {
    const comps = componentsNear(new Vector3(...f.position), DEVICE_TOL)
    const connected = [...comps].some((c) => panelComps.has(c))
    if (!connected) out.push(`${f.kind}@${f.position.join(',')}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Scenarios — (b), (c), (d) reproduced the three round-12 blockers pre-fix
// ---------------------------------------------------------------------------

describe('panel-to-device reachability (round-12 phase 0)', () => {
  test('(a) clean two-room plan: every device reaches the panel', () => {
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [8, 0] }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
      makeWall({ id: 'w_div', start: [4, 0], end: [4, 4], exterior: false, openings: [door(2)] }),
    ]
    const rooms = [
      room('kitchen', [[0, 0], [4, 0], [4, 4], [0, 4]]),
      room('bedroom', [[4, 0], [8, 0], [8, 4], [4, 4]], { id: 'room_bed' }),
    ]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('(b) B1: door spanning the panel wall midpoint no longer strands the plan', () => {
    // Garage wall (longest) with the door dead-center — the old placePanel
    // mounted INSIDE the RO and 22/22 devices were unreachable.
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [8, 0], openings: [door(4, 0.95)] }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
      makeWall({ id: 'w_div', start: [4, 0], end: [4, 4], exterior: false, openings: [door(2)] }),
    ]
    const rooms = [
      room('garage', [[0, 0], [4, 0], [4, 4], [0, 4]], { boundaryWallIds: ['w_s', 'w_div', 'w_w'] }),
      room('kitchen', [[4, 0], [8, 0], [8, 4], [4, 4]]),
    ]
    const fixtures = layoutElectrical(walls, rooms)
    const panel = fixtures.find((f) => f.kind === 'panel')
    expect(panel).toBeDefined()
    // panel mounted OUTSIDE the door RO
    const p = panel as Fixture
    const u = Math.hypot(p.position[0] - 0, p.position[2] - 0)
    expect(Math.abs(u - 4) > 0.95 / 2).toBe(true)
    const members = routeWiring(fixtures, walls)
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('(b2) 16-ft overhead garage door variant', () => {
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [8, 0], openings: [door(4, 4.9)] }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
    ]
    const rooms = [
      room('garage', [[0, 0], [8, 0], [8, 4], [0, 4]], { boundaryWallIds: ['w_s'] }),
    ]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('(c) B2: tee landing in a door RO gets a junction jumper, not a silent gap', () => {
    // Divider tees into the south wall exactly where a door sits: the
    // junction snaps out of the RO — the jumper must bridge the hop.
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [8, 0], openings: [door(3)] }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
      makeWall({ id: 'w_div', start: [3, 0], end: [3, 4], exterior: false }),
    ]
    const rooms = [
      room('kitchen', [[0, 0], [3, 0], [3, 4], [0, 4]]),
      room('bedroom', [[3, 0], [8, 0], [8, 4], [3, 4]], { id: 'room_bed' }),
    ]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('(d) M1: a divider stopping short of the perimeter still connects', () => {
    // Tee wall ends 0.2 m short of both perimeter walls (within
    // JUNCTION_TOL) — the old graph accepted the junction without bridging.
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [8, 0] }),
      makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
      makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
      makeWall({ id: 'w_div', start: [4, 0.2], end: [4, 3.8], exterior: false }),
    ]
    const rooms = [
      room('kitchen', [[0, 0], [4, 0], [4, 4], [0, 4]]),
      room('laundry', [[4, 0], [8, 0], [8, 4], [4, 4]]),
    ]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls)
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('box stubs: every wall device position touches a wire endpoint (2 cm)', () => {
    const walls = [
      makeWall({ id: 'w_s', start: [0, 0], end: [6, 0] }),
      makeWall({ id: 'w_e', start: [6, 0], end: [6, 4] }),
      makeWall({ id: 'w_n', start: [6, 4], end: [0, 4] }),
      makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
    ]
    const rooms = [room('bedroom', [[0, 0], [6, 0], [6, 4], [0, 4]])]
    const fixtures = layoutElectrical(walls, rooms)
    const members = routeWiring(fixtures, walls).filter((m) => m.role === 'wire-run')
    const wallDevices = fixtures.filter(
      (f) =>
        f.kind !== 'panel' &&
        f.kind !== 'light' &&
        f.kind !== 'smoke-alarm' &&
        typeof f.meta?.circuit === 'string',
    )
    expect(wallDevices.length).toBeGreaterThan(0)
    for (const d of wallDevices) {
      const p = new Vector3(...d.position)
      const touched = members.some((m) => {
        const [a, b] = endpointsOf(m)
        return p.distanceTo(a) < DEVICE_TOL || p.distanceTo(b) < DEVICE_TOL
      })
      expect(touched).toBe(true)
    }
  })
})
