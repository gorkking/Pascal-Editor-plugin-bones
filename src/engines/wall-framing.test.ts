import { describe, expect, test } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
import type { Member, OpeningSlice, WallSlice } from '../core/types'
import { feet, inches } from '../core/units'
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

// ---------------------------------------------------------------------------
// Round-1 fabrication features (corners, tees, laps, trimmers, fire blocking)
// ---------------------------------------------------------------------------

import { detectCorners, detectTees, frameWalls } from './wall-framing'

/** Plan-view AABB of an axis-aligned member (yaw 0 or ±π/2). */
function planAabb(m: Member): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const yaw = m.rotation[1]
  const alongX = Math.abs(Math.cos(yaw)) > 0.5
  const hx = alongX ? m.dims[0] / 2 : m.dims[2] / 2
  const hz = alongX ? m.dims[2] / 2 : m.dims[0] / 2
  return {
    minX: (m.position[0] as number) - hx,
    maxX: (m.position[0] as number) + hx,
    minZ: (m.position[2] as number) - hz,
    maxZ: (m.position[2] as number) + hz,
  }
}

const overlaps = (a: ReturnType<typeof planAabb>, b: ReturnType<typeof planAabb>) =>
  a.minX < b.maxX - 1e-9 && b.minX < a.maxX - 1e-9 && a.minZ < b.maxZ - 1e-9 && b.minZ < a.maxZ - 1e-9

describe('frameWalls — California corners', () => {
  const A = makeWall({ id: 'wall_A', start: [0, 0], end: [4, 0] })
  const B = makeWall({ id: 'wall_B', start: [0, 0], end: [0, 3] })
  const members = frameWalls([A, B])

  test('detects the L-corner with the longer wall through', () => {
    const corners = detectCorners([A, B])
    expect(corners).toHaveLength(1)
    expect(corners[0]?.through.id).toBe('wall_A')
    expect(corners[0]?.throughEnd).toBe('start')
  })

  test('through wall gains the third (backing) stud at the corner', () => {
    const backing = members.filter((m) => m.label === 'California corner backing')
    expect(backing).toHaveLength(1)
    const stud = backing[0] as Member
    expect(stud.sourceId).toBe('wall_A')
    // setback = butting thickness (0.1) + half stud thickness
    expect(stud.position[0] as number).toBeCloseTo(0.1 + T / 2, 4)
    expect(stud.position[2] as number).toBeCloseTo(0, 6)
  })

  test('cap plates lap without colliding and cover the joint', () => {
    const capA = members.find((m) => m.role === 'cap-plate' && m.sourceId === 'wall_A') as Member
    const capB = members.find((m) => m.role === 'cap-plate' && m.sourceId === 'wall_B') as Member
    // A's cap extends past the corner by half of B's thickness…
    const a = planAabb(capA)
    expect(a.minX).toBeCloseTo(-0.05, 4)
    // …and B's cap pulls short by half of A's thickness (0.1/2 = 0.05),
    // which clears A's cap half-width (0.089/2 ≈ 0.0445).
    const b = planAabb(capB)
    expect(b.minZ).toBeCloseTo(0.05, 4)
    expect(overlaps(a, b)).toBe(false)
    // The lap covers the corner: A's cap spans B's plate zone in plan.
    expect(a.minX).toBeLessThan(0.045) // reaches over B's z-axis plate width
  })
})

describe('frameWalls — partition backing at tees', () => {
  const through = makeWall({ id: 'wall_T', start: [0, 0], end: [6, 0] })
  const partition = makeWall({ id: 'wall_P', start: [3, 0], end: [3, 2] })
  const members = frameWalls([through, partition])

  test('detects the tee on the through wall at the partition line', () => {
    const tees = detectTees([through, partition])
    expect(tees).toHaveLength(1)
    expect(tees[0]?.through.id).toBe('wall_T')
    expect(tees[0]?.u).toBeCloseTo(3, 5)
  })

  test('emits ladder backing at 0.6 / 1.2 / 1.8 m centered on the tee', () => {
    const backing = members.filter((m) => m.role === 'backing' && m.sourceId === 'wall_T')
    expect(backing).toHaveLength(3)
    const ys = backing.map((b) => b.position[1] as number).sort((p, q) => p - q)
    expect(ys[0]).toBeCloseTo(0.6, 5)
    expect(ys[1]).toBeCloseTo(1.2, 5)
    expect(ys[2]).toBeCloseTo(1.8, 5)
    for (const block of backing) {
      expect(block.position[0] as number).toBeCloseTo(3, 4)
      expect(block.dims[0]).toBeCloseTo(inches(16) - T, 5) // one stud bay
    }
  })

  test('corner junctions do not double as tees', () => {
    const A = makeWall({ id: 'a', start: [0, 0], end: [4, 0] })
    const B = makeWall({ id: 'b', start: [0, 0], end: [0, 3] })
    expect(detectTees([A, B])).toHaveLength(0)
  })
})

describe('frameWall — double trimmers past 6 ft', () => {
  test('a 6ft-2in RO bears on two trimmers per side; 5ft-10in on one', () => {
    const wideRo = inches(74)
    const wide = frameWall(
      makeWall({ end: [6, 0], openings: [{ ...door(3, wideRo - T, 2.1), roughWidth: wideRo }] }),
    )
    expect(byRole(wide, 'trimmer')).toHaveLength(4)

    const narrowRo = inches(70)
    const narrow = frameWall(
      makeWall({ end: [6, 0], openings: [{ ...door(3, narrowRo - T, 2.1), roughWidth: narrowRo }] }),
    )
    expect(byRole(narrow, 'trimmer')).toHaveLength(2)
    // Doubled openings keep kings outside the full trimmer pack.
    const kings = byRole(wide, 'king-stud').map((k) => k.position[0] as number).sort((a, b) => a - b)
    expect((kings[1] ?? 0) - (kings[0] ?? 0)).toBeCloseTo(wideRo + 2 * 2 * T + T, 4)
  })
})

describe('studPositions — no bay ever exceeds the o.c. spacing', () => {
  test('property: random lengths at 16" and 24" o.c.', () => {
    for (const spacing of [inches(16), inches(24)]) {
      for (let len = 0.6; len < 8; len += 0.137) {
        const us = studPositions(len, spacing, T / 2)
        for (let i = 1; i < us.length; i++) {
          const gap = (us[i] as number) - (us[i - 1] as number)
          expect(gap).toBeLessThanOrEqual(spacing + 1e-6)
          expect(gap).toBeGreaterThan(0)
        }
        // end stud guaranteed
        expect(us[us.length - 1]).toBeCloseTo(len - T / 2, 6)
      }
    }
  })
})

describe('frameWall — LOD 400 fabrication', () => {
  test('fire blocking rows appear at 10 ft in tall walls, only at detail 400', () => {
    const tall = makeWall({ height: 3.6 })
    const at400 = frameWall(tall, { ...DEFAULT_SPEC, detail: '400' })
    const blocks = byRole(at400, 'fire-blocking')
    expect(blocks.length).toBeGreaterThan(5)
    for (const b of blocks) {
      expect(b.position[1] as number).toBeCloseTo(feet(10), 5)
    }
    expect(byRole(frameWall(tall, { ...DEFAULT_SPEC, detail: '300' }), 'fire-blocking')).toHaveLength(0)
    // standard-height walls have no concealed 10ft cavity
    expect(byRole(frameWall(makeWall(), { ...DEFAULT_SPEC, detail: '400' }), 'fire-blocking')).toHaveLength(0)
  })

  test('plates on 20ft+ walls carry the splice call-out', () => {
    const long = frameWall(makeWall({ end: [7, 0] }))
    const plate = long.find((m) => m.role === 'top-plate') as Member
    expect(plate.label).toContain('spliced')
    expect(plate.label).toContain('24" lap')
    const short = frameWall(makeWall())
    expect((short.find((m) => m.role === 'top-plate') as Member).label).not.toContain('spliced')
  })
})

describe('frameWalls — cap-plate lap clears the cap WIDTH on thin walls (round-2)', () => {
  test('two 6cm walls (thinner than a 2x4 cap) still lap without colliding', () => {
    const A = makeWall({ id: 'thin_a', start: [0, 0], end: [4, 0], thickness: 0.06 })
    const B = makeWall({ id: 'thin_b', start: [0, 0], end: [0, 3], thickness: 0.06 })
    const members = frameWalls([A, B])
    const capA = members.find((m) => m.role === 'cap-plate' && m.sourceId === 'thin_a') as Member
    const capB = members.find((m) => m.role === 'cap-plate' && m.sourceId === 'thin_b') as Member
    expect(overlaps(planAabb(capA), planAabb(capB))).toBe(false)
    // the butting cap pulls back past the through cap's half-WIDTH (3.5"/2),
    // not just the drawn half-thickness (0.03)
    expect(planAabb(capB).minZ).toBeGreaterThanOrEqual((3.5 * 0.0254) / 2 - 1e-9)
  })
})
