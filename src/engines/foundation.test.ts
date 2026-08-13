import { describe, expect, test } from 'bun:test'
import { Euler, Vector3 } from 'three'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Member, WallSlice } from '../core/types'
import { inches } from '../core/units'
import { anchorBoltPositions, buildFoundation } from './foundation'

const FOOTING_HEIGHT = inches(8)

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
    thickness: 0.15,
    height: 2.5,
    exterior: true,
    openings: [],
    curved: false,
    ...overrides,
  }
}

const slab = {
  id: 'slab_test',
  polygon: [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
  holes: [],
  elevation: 0.05,
  thickness: 0.1,
} as const

const byRole = (members: Member[], role: string): Member[] =>
  members.filter((m) => m.role === role)

describe('anchorBoltPositions — R403.1.6 layout', () => {
  const spacing = DEFAULT_SPEC.anchorBoltSpacing // 6' = 1.8288 m
  const endDist = DEFAULT_SPEC.anchorBoltEndDistance // 12" = 0.3048 m

  test("6m wall → 4 bolts: ends at 12', interior gaps even and ≤ 6' o.c.", () => {
    const bolts = anchorBoltPositions(6, spacing, endDist)
    expect(bolts).toHaveLength(4)
    // first/last within (here exactly at) the 12" end distance
    expect(bolts[0]).toBeCloseTo(endDist, 6)
    expect(bolts[bolts.length - 1]).toBeCloseTo(6 - endDist, 6)
    // no gap may exceed the max o.c. spacing
    for (let i = 1; i < bolts.length; i++) {
      expect((bolts[i] ?? 0) - (bolts[i - 1] ?? 0)).toBeLessThanOrEqual(spacing + 1e-9)
    }
    // even layout: interior gap = span / 3
    expect((bolts[1] ?? 0) - (bolts[0] ?? 0)).toBeCloseTo((6 - 2 * endDist) / 3, 6)
  })

  test('minimum TWO bolts even on a wall shorter than one spacing', () => {
    const bolts = anchorBoltPositions(1, spacing, endDist)
    expect(bolts).toHaveLength(2)
    expect(bolts[0]).toBeCloseTo(endDist, 6)
    expect(bolts[1]).toBeCloseTo(1 - endDist, 6)
  })

  test('very short wall pulls the two bolts to the third points', () => {
    const bolts = anchorBoltPositions(0.5, spacing, endDist)
    expect(bolts).toHaveLength(2)
    expect(bolts[0]).toBeCloseTo(0.5 / 3, 6)
    expect(bolts[1]).toBeCloseTo(0.5 * (2 / 3), 6) // second third point
    // both still within the code end distance of an end
    expect(bolts[0] ?? 0).toBeLessThanOrEqual(endDist)
    expect(0.5 - (bolts[1] ?? 0)).toBeLessThanOrEqual(endDist)
  })
})

describe('buildFoundation — exterior wall, default spec', () => {
  const wall = makeWall() // 4m along +X
  const members = buildFoundation([wall], [])

  test('every member is foundation-system and tied to the wall', () => {
    expect(members.length).toBeGreaterThan(0)
    for (const m of members) {
      expect(m.system).toBe('foundation')
      expect(m.sourceId).toBe('wall_test')
      expect(m.rotation[1] ?? 0).toBeCloseTo(0, 6) // wall along +X → yaw 0
    }
  })

  test('one continuous footing: spec width × 8" high, bottom at -footingDepth', () => {
    const footings = byRole(members, 'footing')
    expect(footings).toHaveLength(1)
    const f = footings[0] as Member
    expect(f.material).toBe('concrete')
    expect(f.dims[0]).toBeCloseTo(4, 6) // runs the wall length
    expect(f.dims[1]).toBeCloseTo(FOOTING_HEIGHT, 6)
    expect(f.dims[2]).toBeCloseTo(DEFAULT_SPEC.footingWidth, 6)
    // centered under the wall in plan
    expect(f.position[0] ?? 0).toBeCloseTo(2, 6)
    expect(f.position[2] ?? 0).toBeCloseTo(0, 6)
    // R403.1.4.1: bearing bottom at frost depth
    const bottom = (f.position[1] ?? 0) - f.dims[1] / 2
    expect(bottom).toBeCloseTo(-DEFAULT_SPEC.footingDepth, 6)
    expect(f.length).toBeCloseTo(4, 6)
  })

  test('stemwall spans footing top → y = 0 at spec thickness', () => {
    const stems = byRole(members, 'stemwall')
    expect(stems).toHaveLength(1)
    const s = stems[0] as Member
    expect(s.material).toBe('concrete')
    expect(s.dims[2]).toBeCloseTo(DEFAULT_SPEC.stemwallThickness, 6)
    const bottom = (s.position[1] ?? 0) - s.dims[1] / 2
    const top = (s.position[1] ?? 0) + s.dims[1] / 2
    expect(bottom).toBeCloseTo(-DEFAULT_SPEC.footingDepth + FOOTING_HEIGHT, 6)
    expect(top).toBeCloseTo(0, 6)
  })

  test('anchor bolts are 5/8" square × 10" steel piercing the plate line', () => {
    const bolts = byRole(members, 'anchor-bolt')
    expect(bolts.length).toBeGreaterThanOrEqual(2)
    for (const b of bolts) {
      expect(b.material).toBe('steel')
      expect(b.dims[0]).toBeCloseTo(inches(5 / 8), 6)
      expect(b.dims[2]).toBeCloseTo(inches(5 / 8), 6)
      expect(b.dims[1]).toBeCloseTo(inches(10), 6)
      const bottom = (b.position[1] ?? 0) - b.dims[1] / 2
      const top = (b.position[1] ?? 0) + b.dims[1] / 2
      expect(bottom).toBeCloseTo(-inches(7), 6) // 7" embedment per R403.1.6
      expect(top).toBeGreaterThan(0) // sticks up through the plate
    }
  })

  test('no hold-downs and no slab edge without seismic spec / slabs', () => {
    expect(byRole(members, 'hold-down')).toHaveLength(0)
    expect(byRole(members, 'slab-edge')).toHaveLength(0)
  })
})

describe('buildFoundation — anchor bolt layout on a 6m wall', () => {
  const wall = makeWall({ end: [6, 0] })
  const bolts = byRole(buildFoundation([wall], []), 'anchor-bolt')

  test('4 bolts, first/last within 12" of the wall ends, gaps ≤ 6\' o.c.', () => {
    expect(bolts).toHaveLength(4)
    const us = bolts.map((b) => b.position[0] ?? 0).sort((a, b) => a - b)
    expect(us[0] ?? 0).toBeLessThanOrEqual(DEFAULT_SPEC.anchorBoltEndDistance + 1e-9)
    expect(6 - (us[us.length - 1] ?? 0)).toBeLessThanOrEqual(
      DEFAULT_SPEC.anchorBoltEndDistance + 1e-9,
    )
    for (let i = 1; i < us.length; i++) {
      expect((us[i] ?? 0) - (us[i - 1] ?? 0)).toBeLessThanOrEqual(
        DEFAULT_SPEC.anchorBoltSpacing + 1e-9,
      )
    }
  })
})

describe('buildFoundation — seismic hold-downs', () => {
  const seismic: FramingSpec = { ...DEFAULT_SPEC, seismicHoldDowns: true }
  const wall = makeWall()
  const holdDowns = byRole(buildFoundation([wall], [], seismic), 'hold-down')

  test('one HDU at each end, just inside the corner, bearing on y = 0', () => {
    expect(holdDowns).toHaveLength(2)
    const us = holdDowns.map((h) => h.position[0] ?? 0).sort((a, b) => a - b)
    const inset = inches(1.5) + inches(3) / 2 // past the end stud, half body
    expect(us[0]).toBeCloseTo(inset, 6)
    expect(us[1]).toBeCloseTo(4 - inset, 6)
    for (const h of holdDowns) {
      expect(h.material).toBe('steel')
      expect(h.label).toBe('HDU hold-down')
      expect(h.dims[0]).toBeCloseTo(inches(3), 6)
      expect(h.dims[1]).toBeCloseTo(inches(12), 6)
      expect(h.dims[2]).toBeCloseTo(inches(3), 6)
      // body base sits at the plate line
      expect((h.position[1] ?? 0) - h.dims[1] / 2).toBeCloseTo(0, 6)
    }
  })
})

describe('buildFoundation — slab edge', () => {
  const wall = makeWall()
  const edges = byRole(buildFoundation([wall], [slab]), 'slab-edge')

  test('one 12"-deep concrete thickened edge tucked just below y = 0', () => {
    expect(edges).toHaveLength(1)
    const e = edges[0] as Member
    expect(e.material).toBe('concrete')
    expect(e.dims[0]).toBeCloseTo(4, 6) // runs the wall
    expect(e.dims[1]).toBeCloseTo(inches(12), 6)
    // subtle: barely wider than the stemwall
    expect(e.dims[2]).toBeCloseTo(DEFAULT_SPEC.stemwallThickness + inches(3), 6)
    const top = (e.position[1] ?? 0) + e.dims[1] / 2
    expect(top).toBeLessThan(0)
    expect(top).toBeGreaterThan(-inches(1)) // "just" below the slab line
  })
})

describe('buildFoundation — wall frame mapping (rotated wall)', () => {
  // Wall along +Z: same yaw convention as wall-framing (atan2(-dz, dx)).
  const wall = makeWall({ start: [1, 0], end: [1, 3] })
  const members = buildFoundation([wall], [])
  const footing = byRole(members, 'footing')[0] as Member

  test('footing yaw maps the +X box axis onto the wall direction', () => {
    expect(footing.rotation[1] ?? 0).toBeCloseTo(-Math.PI / 2, 6)
    // Verify with three: the rotated local +X axis is the wall dir in plan.
    const axis = new Vector3(1, 0, 0).applyEuler(new Euler(...footing.rotation))
    expect(axis.x).toBeCloseTo(wall.dir[0] ?? 0, 6)
    expect(axis.y).toBeCloseTo(0, 6)
    expect(axis.z).toBeCloseTo(wall.dir[1] ?? 0, 6)
  })

  test('members are placed at the wall midline in level space', () => {
    expect(footing.position[0] ?? 0).toBeCloseTo(1, 6)
    expect(footing.position[2] ?? 0).toBeCloseTo(1.5, 6)
    // bolts march along z (the wall run), staying on x = 1
    for (const b of byRole(members, 'anchor-bolt')) {
      expect(b.position[0] ?? 0).toBeCloseTo(1, 6)
    }
    const zs = byRole(members, 'anchor-bolt').map((b) => b.position[2] ?? 0)
    expect(Math.min(...zs)).toBeCloseTo(DEFAULT_SPEC.anchorBoltEndDistance, 6)
    expect(Math.max(...zs)).toBeCloseTo(3 - DEFAULT_SPEC.anchorBoltEndDistance, 6)
  })
})

describe('buildFoundation — guards', () => {
  test('interior walls get nothing (slab bears them)', () => {
    const interior = makeWall({ exterior: false })
    expect(buildFoundation([interior], [slab])).toHaveLength(0)
  })

  test('curved walls are skipped like wall-framing v1', () => {
    const curved = makeWall({ curved: true })
    expect(buildFoundation([curved], [])).toHaveLength(0)
  })

  test('shallow spec (footingDepth = footing height) omits the stemwall', () => {
    const shallow: FramingSpec = { ...DEFAULT_SPEC, footingDepth: inches(8) }
    const members = buildFoundation([makeWall()], [], shallow)
    expect(byRole(members, 'stemwall')).toHaveLength(0)
    const f = byRole(members, 'footing')[0] as Member
    expect((f.position[1] ?? 0) - f.dims[1] / 2).toBeCloseTo(-inches(8), 6)
    expect((f.position[1] ?? 0) + f.dims[1] / 2).toBeCloseTo(0, 6)
  })

  test('mixed level: only exterior walls produce foundation members', () => {
    const walls = [
      makeWall({ id: 'ext_a' }),
      makeWall({ id: 'int_b', exterior: false, start: [0, 2], end: [4, 2] }),
      makeWall({ id: 'ext_c', start: [0, 0], end: [0, 4] }),
    ]
    const members = buildFoundation(walls, [])
    const sources = new Set(members.map((m) => m.sourceId))
    expect(sources.has('ext_a')).toBe(true)
    expect(sources.has('ext_c')).toBe(true)
    expect(sources.has('int_b')).toBe(false)
  })
})
