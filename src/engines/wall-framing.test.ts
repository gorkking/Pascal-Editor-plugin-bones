import { describe, expect, test } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
import type { Member, OpeningSlice, WallSlice } from '../core/types'
import { inches } from '../core/units'
import { frameWall, studPositions } from './wall-framing'

const T = inches(1.5)

function makeWall(overrides: Partial<WallSlice> = {}): WallSlice {
  const start = overrides.start ?? [0, 0]
  const end = overrides.end ?? [4, 0]
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

function door(u: number, width = 0.9, height = 2.1): OpeningSlice {
  return {
    id: 'door_test',
    kind: 'door',
    u,
    width,
    height,
    sillHeight: 0,
    roughWidth: width + T,
    roughHeight: height + T,
  }
}

function window_(u: number, width = 1.2, height = 1.2, sillHeight = 0.9): OpeningSlice {
  return {
    id: 'window_test',
    kind: 'window',
    u,
    width,
    height,
    sillHeight,
    roughWidth: width + T,
    roughHeight: height + T,
  }
}

const byRole = (members: Member[], role: string): Member[] =>
  members.filter((m) => m.role === role)

describe('studPositions', () => {
  test('4m wall at 16" o.c. → studs from edge to edge, end stud guaranteed', () => {
    const positions = studPositions(4, inches(16), T / 2)
    expect(positions[0]).toBeCloseTo(T / 2, 5)
    expect(positions[positions.length - 1]).toBeCloseTo(4 - T / 2, 5)
    // interior spacing is o.c.
    expect((positions[1] ?? 0) - (positions[0] ?? 0)).toBeCloseTo(inches(16), 5)
    // no two studs overlap
    for (let i = 1; i < positions.length; i++) {
      expect((positions[i] ?? 0) - (positions[i - 1] ?? 0)).toBeGreaterThan(T - 1e-9)
    }
  })
})

describe('frameWall — solid wall', () => {
  const wall = makeWall()
  const members = frameWall(wall)

  test('emits one bottom plate and a double top plate', () => {
    expect(byRole(members, 'bottom-plate')).toHaveLength(1)
    expect(byRole(members, 'top-plate')).toHaveLength(1)
    expect(byRole(members, 'cap-plate')).toHaveLength(1)
  })

  test('studs run plate-to-plate', () => {
    const studs = byRole(members, 'stud')
    expect(studs.length).toBeGreaterThanOrEqual(10) // 4m / 16" ≈ 9.8 + end stud
    const stud = studs[0] as Member
    expect(stud.dims[1]).toBeCloseTo(2.5 - 3 * T, 5)
    // stud center Y = bottom plate + half height
    expect(stud.position[1] ?? 0).toBeCloseTo(T + (2.5 - 3 * T) / 2, 5)
  })

  test('thin wall frames 2x4, thick wall frames 2x6', () => {
    expect(members[0]?.size).toBe('2x4')
    const thick = frameWall(makeWall({ thickness: 0.15 }))
    expect(thick[0]?.size).toBe('2x6')
  })

  test('members inherit the wall yaw and level-local placement', () => {
    const angled = frameWall(makeWall({ start: [0, 0], end: [0, 3] }))
    const plate = angled[0] as Member
    // wall along +Z: yaw = atan2(-1, 0) = -π/2
    expect(plate.rotation[1] ?? 0).toBeCloseTo(-Math.PI / 2, 5)
    expect(plate.position[0] ?? 0).toBeCloseTo(0, 5)
    expect(plate.position[2] ?? 0).toBeCloseTo(1.5, 5)
  })
})

describe('frameWall — door opening', () => {
  const wall = makeWall({ openings: [door(2)] })
  const members = frameWall(wall)

  test('emits kings, trimmers, and a span-sized header', () => {
    expect(byRole(members, 'king-stud')).toHaveLength(2)
    expect(byRole(members, 'trimmer')).toHaveLength(2)
    const headers = byRole(members, 'header')
    expect(headers).toHaveLength(1)
    // RO = 0.9 + 1.5" ≈ 0.938m ≈ 36.9" → 4x8 per the fallback table
    expect(headers[0]?.size).toBe('4x8')
  })

  test('no common stud lands inside the rough opening', () => {
    const ro = 0.9 + T
    for (const stud of byRole(members, 'stud')) {
      // distance along wall = x (wall runs along +X from 0)
      const u = stud.position[0] ?? 0
      expect(Math.abs(u - 2) > ro / 2 + 2 * T - inches(0.75)).toBe(true)
    }
  })

  test('cripples fill between header and top plates', () => {
    expect(byRole(members, 'cripple').length).toBeGreaterThan(0)
  })

  test('doors get no sill', () => {
    expect(byRole(members, 'sill')).toHaveLength(0)
  })
})

describe('frameWall — window opening', () => {
  const wall = makeWall({ openings: [window_(2)] })
  const members = frameWall(wall)

  test('emits a rough sill with supporting cripples below', () => {
    expect(byRole(members, 'sill')).toHaveLength(1)
    const sill = byRole(members, 'sill')[0] as Member
    expect(sill.position[1] ?? 0).toBeCloseTo(0.9 - T / 2, 5)
    const cripples = byRole(members, 'cripple')
    const below = cripples.filter((c) => (c.position[1] ?? 0) < 0.9)
    expect(below.length).toBeGreaterThanOrEqual(2) // at least both sill ends
  })

  test('small window header uses the light end of the table', () => {
    const small = frameWall(makeWall({ openings: [window_(2, 0.55, 0.6, 1.2)] }))
    const header = byRole(small, 'header')[0] as Member
    // RO ≈ 0.588m ≈ 23.1" → 4x4
    expect(header.size).toBe('4x4')
  })
})

describe('frameWall — guards', () => {
  test('curved walls return no members (flagged upstream)', () => {
    expect(frameWall(makeWall({ curved: true }))).toHaveLength(0)
  })

  test('oversized opening span is flagged for engineering', () => {
    const wide = makeWall({ end: [8, 0], openings: [door(4, 3.4, 2.1)] })
    const header = frameWall(wide).find((m) => m.role === 'header')
    expect(header?.flag).toContain('ENGINEERED')
  })

  test('spec with 24" spacing produces fewer studs', () => {
    const at16 = frameWall(makeWall()).filter((m) => m.role === 'stud').length
    const at24 = frameWall(makeWall(), { ...DEFAULT_SPEC, studSpacing: inches(24) }).filter(
      (m) => m.role === 'stud',
    ).length
    expect(at24).toBeLessThan(at16)
  })
})
