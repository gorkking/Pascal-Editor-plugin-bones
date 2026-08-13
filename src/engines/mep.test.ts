import { describe, expect, test } from 'bun:test'
import type { Fixture, Member, RoomSlice, WallSlice } from '../core/types'
import { layoutHvac, polygonArea, tonsFor } from './hvac'
import { layoutPlumbing, wetWallFor } from './plumbing'

/** A 10m × 8m two-bath plan: kitchen, bathroom, bedroom, hallway, laundry. */
function wall(id: string, start: [number, number], end: [number, number]): WallSlice {
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  return {
    id,
    start,
    end,
    length,
    dir: [dx / length, dz / length],
    thickness: 0.1,
    height: 2.5,
    exterior: false,
    openings: [],
    curved: false,
  }
}

function room(
  id: string,
  name: string,
  category: RoomSlice['category'],
  polygon: [number, number][],
  boundaryWallIds: string[] = [],
): RoomSlice {
  return { id, name, category, polygon, boundaryWallIds, ceilingHeight: 2.5 }
}

const walls = [
  wall('w_south', [0, 0], [10, 0]),
  wall('w_north', [0, 8], [10, 8]),
  wall('w_mid', [5, 0], [5, 8]),
  wall('w_bathwall', [5, 4], [10, 4]),
]

const rooms = [
  room('r_kitchen', 'Kitchen', 'kitchen', [[0, 0], [5, 0], [5, 4], [0, 4]], ['w_south', 'w_mid']),
  room('r_bath', 'Bathroom', 'bathroom', [[5, 0], [10, 0], [10, 4], [5, 4]], ['w_mid', 'w_bathwall']),
  room('r_bed', 'Bedroom', 'bedroom', [[5, 4], [10, 4], [10, 8], [5, 8]]),
  room('r_hall', 'Hallway', 'hallway', [[0, 4], [5, 4], [5, 8], [2, 8], [2, 6], [0, 6]]),
  room('r_laundry', 'Laundry', 'laundry', [[2, 6], [5, 6], [5, 8], [2, 8]]),
]

const byKind = (fixtures: Fixture[], kind: string) => fixtures.filter((f) => f.kind === kind)
const byRole = (members: Member[], role: string) => members.filter((m) => m.role === role)

describe('layoutPlumbing', () => {
  const { members, fixtures } = layoutPlumbing(walls, rooms)

  test('one vent stack rising through the roof at the bathroom wet wall', () => {
    const stacks = byRole(members, 'vent-stack')
    expect(stacks).toHaveLength(1)
    const stack = stacks[0] as Member
    expect(stack.length).toBeCloseTo(2.5 + 0.6, 5)
    expect(stack.material).toBe('pvc')
    expect(stack.sourceId).toBe('r_bath')
  })

  test('every wet room gets stub-outs (2 bath, 1 kitchen, 1 laundry)', () => {
    const stubs = byKind(fixtures, 'stub-out')
    expect(stubs.filter((s) => s.sourceId === 'r_bath')).toHaveLength(2)
    expect(stubs.filter((s) => s.sourceId === 'r_kitchen')).toHaveLength(1)
    expect(stubs.filter((s) => s.sourceId === 'r_laundry')).toHaveLength(1)
  })

  test('drains + hot/cold supplies run from remote wet rooms toward the stack', () => {
    const pipes = byRole(members, 'pipe-run')
    const drains = pipes.filter((p) => p.label?.includes('drain'))
    const supplies = pipes.filter((p) => p.label?.includes('Supply'))
    // Kitchen and bath share the w_mid wet wall back-to-back (the ideal
    // plumbing core), so their runs collapse to zero and only the remote
    // laundry needs a real drain run.
    expect(drains.length).toBeGreaterThanOrEqual(1)
    expect(supplies.length).toBeGreaterThanOrEqual(2) // hot+cold for the remote room
    for (const s of supplies) expect(s.material).toBe('copper')
  })

  test('water heater prefers the laundry; cleanout at the stack base', () => {
    expect(byKind(fixtures, 'water-heater')[0]?.sourceId).toBe('r_laundry')
    expect(byKind(fixtures, 'cleanout')).toHaveLength(1)
  })

  test('no wet rooms → nothing (never crashes on empty scenes)', () => {
    const empty = layoutPlumbing(walls, [room('r', 'Living', 'other', [[0, 0], [1, 0], [1, 1]])])
    expect(empty.members).toHaveLength(0)
    expect(empty.fixtures).toHaveLength(0)
    const noWalls = layoutPlumbing([], rooms)
    expect(noWalls.members).toHaveLength(0)
  })

  test('wetWallFor honors boundary walls', () => {
    const core: [number, number] = [5, 2]
    const picked = wetWallFor(rooms[1] as RoomSlice, walls, core)
    expect(['w_mid', 'w_bathwall']).toContain(picked?.id ?? '')
  })
})

describe('layoutHvac', () => {
  const { members, fixtures } = layoutHvac(walls, rooms)

  test('tonnage from conditioned area (garage excluded), sane bounds', () => {
    expect(polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]])).toBeCloseTo(12, 6)
    // 10x8m = 80m² ≈ 861 sqft → 861/500 = 1.72 → 2.0 tons
    expect(tonsFor(80)).toBe(2)
    const equip = byKind(fixtures, 'equipment')[0] as Fixture
    expect(equip.meta?.tons).toBe(2)
    expect(equip.sourceId).toBe('r_laundry') // service-space preference
  })

  test('a register in every habitable room (laundry included), none in the hallway', () => {
    const regs = byKind(fixtures, 'register')
    expect(regs.map((r) => r.sourceId).sort()).toEqual(['r_bath', 'r_bed', 'r_kitchen', 'r_laundry'])
  })

  test('trunk + one branch per register, branches end at the registers', () => {
    const ducts = byRole(members, 'duct-run')
    const trunk = ducts.find((d) => d.label?.includes('Trunk'))
    expect(trunk).toBeDefined()
    const branches = ducts.filter((d) => d.label?.includes('branch'))
    const regs = byKind(fixtures, 'register')
    for (const reg of regs) {
      const [rx, , rz] = reg.position
      const onBranchEnd = branches.some((b) => {
        // A branch ends at the register: center + half length along the
        // branch direction (member +X maps to (cos ψ, 0, -sin ψ)).
        const [cx, , cz] = b.position
        const yaw = b.rotation[1]
        const dx = Math.cos(yaw)
        const dz = -Math.sin(yaw)
        const half = b.length / 2
        const ends = [
          [cx + dx * half, cz + dz * half],
          [cx - dx * half, cz - dz * half],
        ]
        return ends.some(([ex, ez]) => Math.hypot((ex as number) - rx, (ez as number) - rz) < 0.02)
      })
      // A register sitting ON the trunk line needs no branch — the trunk
      // serves it directly (engine drops sub-15cm branches).
      const onTrunk = (() => {
        if (!trunk) return false
        const [cx, , cz] = trunk.position
        const yaw = trunk.rotation[1]
        const dx = Math.cos(yaw)
        const dz = -Math.sin(yaw)
        const half = trunk.length / 2
        const ax = cx - dx * half
        const az = cz - dz * half
        const t = Math.max(0, Math.min(trunk.length, (rx - ax) * dx + (rz - az) * dz))
        return Math.hypot(ax + dx * t - rx, az + dz * t - rz) < 0.16
      })()
      expect(onBranchEnd || onTrunk).toBe(true)
    }
  })

  test('return near the unit, thermostat on a wall at 60 inches', () => {
    expect(byKind(fixtures, 'return')).toHaveLength(1)
    const tstat = byKind(fixtures, 'thermostat')[0] as Fixture
    expect(tstat.position[1]).toBeCloseTo(60 * 0.0254, 5)
    expect(walls.some((w) => w.id === tstat.sourceId)).toBe(true)
  })

  test('no rooms → nothing', () => {
    const empty = layoutHvac(walls, [])
    expect(empty.members).toHaveLength(0)
    expect(empty.fixtures).toHaveLength(0)
  })
})
