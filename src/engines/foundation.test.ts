import { describe, expect, test } from 'bun:test'
import { Euler, Vector3 } from 'three'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Member, WallSlice } from '../core/types'
import { inches } from '../core/units'
import { anchorBoltPositions, buildFoundation, cornerExtensions } from './foundation'

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

  test('NO thickened edge where a footing + stemwall already run (round-10)', () => {
    // The slab pours AGAINST the stemwall (R403.1); a turned-down
    // monolithic edge is the alternative detail. Emitting both doubled the
    // perimeter concrete inside one volume — the interpenetration gate
    // pinned it. Footing + stemwall remain the perimeter elements.
    expect(edges).toHaveLength(0)
    const members = buildFoundation([wall], [slab])
    expect(byRole(members, 'footing').length).toBeGreaterThan(0)
    expect(byRole(members, 'stemwall').length).toBeGreaterThan(0)
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
  test('interior walls get no perimeter run (no stemwall/bolts/slab-edge)', () => {
    const interior = makeWall({ exterior: false })
    const members = buildFoundation([interior], [slab])
    expect(byRole(members, 'stemwall')).toHaveLength(0)
    expect(byRole(members, 'anchor-bolt')).toHaveLength(0)
    expect(byRole(members, 'slab-edge')).toHaveLength(0)
    expect(byRole(members, 'hold-down')).toHaveLength(0)
  })

  test('at LOD 200 interior walls get nothing at all (slab bears them)', () => {
    const lod200: FramingSpec = { ...DEFAULT_SPEC, detail: '200' }
    const interior = makeWall({ exterior: false })
    expect(buildFoundation([interior], [slab], lod200)).toHaveLength(0)
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

  test('mixed level: interior walls never join the perimeter run', () => {
    const walls = [
      makeWall({ id: 'ext_a' }),
      makeWall({ id: 'int_b', exterior: false, start: [0, 2], end: [4, 2] }),
      makeWall({ id: 'ext_c', start: [0, 0], end: [0, 4] }),
    ]
    const members = buildFoundation(walls, [])
    const perimeterRoles = ['stemwall', 'anchor-bolt', 'slab-edge', 'hold-down']
    const intMembers = members.filter((m) => m.sourceId === 'int_b')
    // the long interior wall gets ONLY its thickened footing + bars
    expect(intMembers.length).toBeGreaterThan(0)
    for (const m of intMembers) expect(perimeterRoles).not.toContain(m.role)
    expect(members.some((m) => m.sourceId === 'ext_a' && m.role === 'stemwall')).toBe(true)
    expect(members.some((m) => m.sourceId === 'ext_c' && m.role === 'stemwall')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// LOD 350 — corner continuity (rubric: monolithic footing corners)
// ---------------------------------------------------------------------------

/** World-space run extents of a member along its local +X axis. */
function runEnds(m: Member): { near: Vector3; far: Vector3; axis: Vector3 } {
  const axis = new Vector3(1, 0, 0).applyEuler(new Euler(...m.rotation))
  const c = new Vector3(...m.position)
  const half = axis.clone().multiplyScalar((m.dims[0] ?? 0) / 2)
  return { near: c.clone().sub(half), far: c.clone().add(half), axis }
}

/** Plan-view (XZ) check that `point` lies inside the member's box. */
function coversInPlan(m: Member, point: readonly [number, number]): boolean {
  const { near, axis } = runEnds(m)
  const p = new Vector3(point[0], near.y, point[1])
  const d = p.clone().sub(near)
  const along = d.dot(axis)
  const acrossV = d.clone().sub(axis.clone().multiplyScalar(along))
  return (
    along >= -1e-9 &&
    along <= (m.dims[0] ?? 0) + 1e-9 &&
    acrossV.length() <= (m.dims[2] ?? 0) / 2 + 1e-9
  )
}

describe('buildFoundation — LOD 350 corner continuity', () => {
  const halfOtherFooting = DEFAULT_SPEC.footingWidth / 2 // 8" = 0.2032 m
  // L-corner at (4, 0): A runs +X and ends there, B runs +Z and starts there.
  const wallA = makeWall({ id: 'wall_a', start: [0, 0], end: [4, 0] })
  const wallB = makeWall({ id: 'wall_b', start: [4, 0], end: [4, 3] })
  const members = buildFoundation([wallA, wallB], [])
  const footA = byRole(members, 'footing').find((m) => m.sourceId === 'wall_a') as Member
  const footB = byRole(members, 'footing').find((m) => m.sourceId === 'wall_b') as Member

  test('the LONGER wall lays through the corner; the other butts flush', () => {
    // A (4 m) is the through wall: its run extends footingWidth/2 past the
    // corner, out to B's far footing face. B (3 m) retreats the same amount
    // and butts against A's side face — no overlap, no jutting ends.
    expect(footA.dims[0] - wallA.length).toBeCloseTo(halfOtherFooting, 6)
    expect(footB.dims[0] - wallB.length).toBeCloseTo(-halfOtherFooting, 6)
    const { near: aNear, far: aFar } = runEnds(footA)
    expect(aNear.x).toBeCloseTo(0, 6) // free end untouched
    expect(aFar.x).toBeCloseTo(4 + halfOtherFooting, 6)
    const { near: bNear, far: bFar } = runEnds(footB)
    expect(bNear.z).toBeCloseTo(halfOtherFooting, 6) // flush against A's face
    expect(bFar.z).toBeCloseTo(3, 6)
  })

  test('the corner is covered exactly ONCE — no overlapping pour boxes', () => {
    // through run covers the corner point…
    expect(coversInPlan(footA, [4, 0])).toBe(true)
    // …the butting run stops at the through run's face (flush, not inside)
    expect(coversInPlan(footB, [4, 0])).toBe(false)
    // zero plan overlap between the two boxes (the round-2 visual bug:
    // overlapping translucent boxes z-fight and read as corner seams)
    const { near: bNear } = runEnds(footB)
    const aFaceZ = DEFAULT_SPEC.footingWidth / 2
    expect(bNear.z).toBeGreaterThanOrEqual(aFaceZ - 1e-9)
    // and the through run reaches B's far face exactly (flush outer corner)
    const { far: aFar } = runEnds(footA)
    expect(aFar.x - 4).toBeCloseTo(halfOtherFooting, 6)
  })

  test('no double-height stack: one footing per wall, both on the SAME course', () => {
    expect(byRole(members, 'footing')).toHaveLength(2)
    expect(footA.position[1] ?? 0).toBeCloseTo(footB.position[1] ?? 0, 6)
    expect(footA.dims[1]).toBeCloseTo(footB.dims[1], 6)
    // course top/bottom identical → overlap is within one pour, not stacked
    const topA = (footA.position[1] ?? 0) + footA.dims[1] / 2
    const topB = (footB.position[1] ?? 0) + footB.dims[1] / 2
    expect(topA).toBeCloseTo(topB, 6)
  })

  test('stemwalls interlock with their OWN width — narrow runs stay flush too', () => {
    const stemA = byRole(members, 'stemwall').find((m) => m.sourceId === 'wall_a') as Member
    const stemB = byRole(members, 'stemwall').find((m) => m.sourceId === 'wall_b') as Member
    const halfStem = DEFAULT_SPEC.stemwallThickness / 2
    expect(stemA.dims[0] - wallA.length).toBeCloseTo(halfStem, 6)
    expect(stemB.dims[0] - wallB.length).toBeCloseTo(-halfStem, 6)
    expect(coversInPlan(stemA, [4, 0])).toBe(true)
    // flush: B's stem starts exactly at A's stem face — never past it
    const { near: bNear } = runEnds(stemB)
    expect(bNear.z).toBeCloseTo(halfStem, 6)
  })

  test('anchor bolts stay on the PLATE (never march into the extended pour)', () => {
    const boltsA = byRole(members, 'anchor-bolt').filter((m) => m.sourceId === 'wall_a')
    for (const b of boltsA) {
      expect(b.position[0] ?? 0).toBeGreaterThanOrEqual(0)
      expect(b.position[0] ?? 0).toBeLessThanOrEqual(4)
    }
  })

  test('diagonal corner: through/butt measured along the run, tie broken by id', () => {
    // corner at (3,3) between two 45° walls of EQUAL length → 'diag_a' through
    const diagA = makeWall({ id: 'diag_a', start: [0, 0], end: [3, 3] })
    const diagB = makeWall({ id: 'diag_b', start: [3, 3], end: [6, 0] })
    const foots = byRole(buildFoundation([diagA, diagB], []), 'footing')
    const fA = foots.find((m) => m.sourceId === 'diag_a') as Member
    const fB = foots.find((m) => m.sourceId === 'diag_b') as Member
    expect(fA.dims[0] - diagA.length).toBeCloseTo(halfOtherFooting, 6)
    expect(fB.dims[0] - diagB.length).toBeCloseTo(-halfOtherFooting, 6)
    // far end of the through run sits exactly 8" past the corner in plan
    const { far } = runEnds(fA)
    expect(Math.hypot(far.x - 3, far.z - 3)).toBeCloseTo(halfOtherFooting, 6)
    expect(coversInPlan(fA, [3, 3])).toBe(true)
    expect(coversInPlan(fB, [3, 3])).toBe(false)
  })

  test('LOD 200 keeps plain wall-length runs (350 gate)', () => {
    const lod200: FramingSpec = { ...DEFAULT_SPEC, detail: '200' }
    const foots = byRole(buildFoundation([wallA, wallB], [], lod200), 'footing')
    for (const f of foots) expect(f.dims[0]).toBeCloseTo(f.sourceId === 'wall_a' ? 4 : 3, 6)
  })

  test('collinear butt splice is NOT a corner — no extension', () => {
    const a = makeWall({ id: 'seg_a', start: [0, 0], end: [4, 0] })
    const b = makeWall({ id: 'seg_b', start: [4, 0], end: [8, 0] })
    const foots = byRole(buildFoundation([a, b], []), 'footing')
    for (const f of foots) expect(f.dims[0]).toBeCloseTo(4, 6)
  })
})

// ---------------------------------------------------------------------------
// LOD 350 — interior thickened footings under bearing walls
// ---------------------------------------------------------------------------

describe('buildFoundation — interior thickened footings (LOD 350)', () => {
  const bearing = makeWall({ id: 'int_bearing', exterior: false, start: [0, 1], end: [3, 1] })

  test('interior wall > 2.4 m gets a 12"-deep × footingWidth footing, top at slab line', () => {
    const members = buildFoundation([bearing], [slab])
    const foots = byRole(members, 'footing')
    expect(foots).toHaveLength(1)
    const f = foots[0] as Member
    expect(f.material).toBe('concrete')
    expect(f.dims[0]).toBeCloseTo(3, 6) // runs the wall
    expect(f.dims[1]).toBeCloseTo(inches(12), 6) // 12" deep
    expect(f.dims[2]).toBeCloseTo(DEFAULT_SPEC.footingWidth, 6)
    // monolithic with the slab: top at y = 0, bottom 12" down
    expect((f.position[1] ?? 0) + f.dims[1] / 2).toBeCloseTo(0, 6)
    expect((f.position[1] ?? 0) - f.dims[1] / 2).toBeCloseTo(-inches(12), 6)
    // centered under the wall in plan
    expect(f.position[0] ?? 0).toBeCloseTo(1.5, 6)
    expect(f.position[2] ?? 0).toBeCloseTo(1, 6)
    // no perimeter kit sneaks in
    expect(byRole(members, 'stemwall')).toHaveLength(0)
    expect(byRole(members, 'anchor-bolt')).toHaveLength(0)
  })

  test('short partitions (≤ 2.4 m) bear on the slab — no footing', () => {
    const short = makeWall({ id: 'int_short', exterior: false, start: [0, 1], end: [2.4, 1] })
    expect(buildFoundation([short], [slab])).toHaveLength(0)
  })

  test('gated at LOD 350: detail 200 emits nothing for interior walls', () => {
    const lod200: FramingSpec = { ...DEFAULT_SPEC, detail: '200' }
    expect(buildFoundation([bearing], [slab], lod200)).toHaveLength(0)
  })

  test('interior footing carries its own 2× #4 bars at 3" clear off ITS bottom', () => {
    const bars = byRole(buildFoundation([bearing], [slab]), 'rebar')
    expect(bars).toHaveLength(2)
    for (const b of bars) {
      const bottom = (b.position[1] ?? 0) - b.dims[1] / 2
      expect(bottom - -inches(12)).toBeCloseTo(inches(3), 6) // 3" clear cover
      expect(b.dims[0]).toBeCloseTo(3, 6) // continuous along the run
    }
  })
})

// ---------------------------------------------------------------------------
// LOD 350 — rebar (2× #4 continuous + stemwall verticals)
// ---------------------------------------------------------------------------

describe('buildFoundation — rebar (LOD 350)', () => {
  const wall = makeWall() // 4 m along +X, no corners
  const members = buildFoundation([wall], [])
  const longs = members.filter((m) => m.role === 'rebar' && m.label === '#4 continuous footing bar')
  const verts = members.filter((m) => m.role === 'rebar' && m.label === '#4 stemwall vertical')

  test('2 continuous #4 bars per footing run, 0.5" square, full run length', () => {
    expect(longs).toHaveLength(2)
    for (const b of longs) {
      expect(b.material).toBe('steel')
      expect(b.dims[0]).toBeCloseTo(4, 6)
      expect(b.dims[1]).toBeCloseTo(inches(0.5), 6)
      expect(b.dims[2]).toBeCloseTo(inches(0.5), 6)
      expect(b.length).toBeCloseTo(4, 6)
    }
  })

  test('longitudinal bars sit 3" clear off the footing bottom', () => {
    for (const b of longs) {
      const barBottom = (b.position[1] ?? 0) - b.dims[1] / 2
      const footingBottom = -DEFAULT_SPEC.footingDepth
      expect(barBottom - footingBottom).toBeCloseTo(inches(3), 6)
    }
  })

  test('longitudinal bars split the footing width in thirds (v = ±width/6)', () => {
    // wall runs +X → across-offset v shows up on world z
    const zs = longs.map((b) => b.position[2] ?? 0).sort((a, b) => a - b)
    expect(zs[0]).toBeCloseTo(-DEFAULT_SPEC.footingWidth / 6, 6)
    expect(zs[1]).toBeCloseTo(DEFAULT_SPEC.footingWidth / 6, 6)
  })

  test('stemwall verticals at 48" o.c. — 5 bars, ≤48" gaps, clear of every bolt', () => {
    expect(verts).toHaveLength(5)
    const us = verts.map((b) => b.position[0] ?? 0).sort((a, b) => a - b)
    expect(us[0]).toBeCloseTo(inches(4), 6) // end cover
    expect(us[us.length - 1]).toBeCloseTo(4 - inches(4), 6)
    for (let i = 1; i < us.length; i++) {
      const gap = (us[i] ?? 0) - (us[i - 1] ?? 0)
      // Bars near an anchor bolt nudge one hand-width aside (round-12:
      // both layouts anchor to the run ends, so shared multiples used to
      // COINCIDE — a #4 bar inside a 5/8" bolt). Gaps stay ≤ 48" + nudge.
      expect(gap).toBeLessThanOrEqual(inches(48) + inches(4) + 1e-9)
    }
    const boltUs = members
      .filter((m) => m.role === 'anchor-bolt')
      .map((b) => b.position[0] ?? 0)
    for (const u of us) {
      for (const b of boltUs) {
        expect(Math.abs(u - b)).toBeGreaterThanOrEqual(inches(3) - 1e-9)
      }
    }
  })

  test('verticals RISE from the footing into the stemwall (numeric extents)', () => {
    const footingTop = -DEFAULT_SPEC.footingDepth + FOOTING_HEIGHT
    for (const v of verts) {
      const bottom = (v.position[1] ?? 0) - v.dims[1] / 2
      const top = (v.position[1] ?? 0) + v.dims[1] / 2
      expect(bottom).toBeCloseTo(-DEFAULT_SPEC.footingDepth + inches(3), 6) // stands on the mat
      expect(top).toBeCloseTo(-inches(2), 6) // 2" shy of the stemwall top
      expect(bottom).toBeLessThan(footingTop) // anchored IN the footing
      expect(top).toBeGreaterThan(footingTop) // …rising INTO the stemwall
      expect(v.dims[0]).toBeCloseTo(inches(0.5), 6)
      expect(v.dims[2]).toBeCloseTo(inches(0.5), 6)
    }
  })

  test('seismic spec tightens verticals to 24" o.c. — 8 bars on the 4 m run', () => {
    const seismic: FramingSpec = { ...DEFAULT_SPEC, seismicHoldDowns: true }
    const sVerts = buildFoundation([wall], [], seismic).filter(
      (m) => m.label === '#4 stemwall vertical',
    )
    expect(sVerts).toHaveLength(8)
    const us = sVerts.map((b) => b.position[0] ?? 0).sort((a, b) => a - b)
    for (let i = 1; i < us.length; i++) {
      expect((us[i] ?? 0) - (us[i - 1] ?? 0)).toBeLessThanOrEqual(inches(24) + 1e-9)
    }
  })

  test('corner-extended runs carry full-length continuous bars', () => {
    const a = makeWall({ id: 'ca', start: [0, 0], end: [4, 0] })
    const b = makeWall({ id: 'cb', start: [4, 0], end: [4, 3] })
    const bars = buildFoundation([a, b], []).filter(
      (m) => m.label === '#4 continuous footing bar' && m.sourceId === 'ca',
    )
    expect(bars).toHaveLength(2)
    for (const bar of bars) {
      expect(bar.dims[0]).toBeCloseTo(4 + DEFAULT_SPEC.footingWidth / 2, 6)
    }
  })

  test('no stemwall → no verticals (shallow spec), longitudinal bars remain', () => {
    const shallow: FramingSpec = { ...DEFAULT_SPEC, footingDepth: inches(8) }
    const rebar = byRole(buildFoundation([wall], [], shallow), 'rebar')
    expect(rebar.filter((m) => m.label === '#4 stemwall vertical')).toHaveLength(0)
    expect(rebar.filter((m) => m.label === '#4 continuous footing bar')).toHaveLength(2)
  })

  test('gated at LOD 350: detail 200 emits zero rebar', () => {
    const lod200: FramingSpec = { ...DEFAULT_SPEC, detail: '200' }
    expect(byRole(buildFoundation([wall], [], lod200), 'rebar')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// LOD 400 — plate washers at anchor bolts (R602.11.1)
// ---------------------------------------------------------------------------

describe('buildFoundation — plate washers (LOD 400, R602.11.1)', () => {
  const fabSeismic: FramingSpec = { ...DEFAULT_SPEC, detail: '400', seismicHoldDowns: true }
  const wall = makeWall() // 4 m → 3 anchor bolts under the default spec
  const members = buildFoundation([wall], [], fabSeismic)
  const bolts = byRole(members, 'anchor-bolt')
  const washers = byRole(members, 'plate-washer')

  test('exactly one 3×3×0.229" steel washer per anchor bolt', () => {
    expect(bolts.length).toBeGreaterThan(0)
    expect(washers).toHaveLength(bolts.length)
    for (const w of washers) {
      expect(w.material).toBe('steel')
      expect(w.dims[0]).toBeCloseTo(inches(3), 6)
      expect(w.dims[1]).toBeCloseTo(inches(0.229), 6)
      expect(w.dims[2]).toBeCloseTo(inches(3), 6)
    }
  })

  test('each washer is centered on its bolt in plan, seated on the 1.5" plate', () => {
    const boltUs = bolts.map((b) => b.position[0] ?? 0).sort((a, b) => a - b)
    const washerUs = washers.map((w) => w.position[0] ?? 0).sort((a, b) => a - b)
    for (let i = 0; i < boltUs.length; i++) {
      expect(washerUs[i]).toBeCloseTo(boltUs[i] ?? 0, 6)
    }
    for (const w of washers) {
      expect(w.position[2] ?? 0).toBeCloseTo(0, 6) // on the wall line, like the bolts
      const bottom = (w.position[1] ?? 0) - w.dims[1] / 2
      expect(bottom).toBeCloseTo(inches(1.5), 6) // top of the 2x mudsill
    }
  })

  test('washers vanish without the seismic trigger, even at detail 400', () => {
    const fabOnly: FramingSpec = { ...DEFAULT_SPEC, detail: '400' }
    expect(byRole(buildFoundation([wall], [], fabOnly), 'plate-washer')).toHaveLength(0)
  })

  test('washers vanish below detail 400, even with the seismic trigger', () => {
    const seismic300: FramingSpec = { ...DEFAULT_SPEC, detail: '300', seismicHoldDowns: true }
    expect(byRole(buildFoundation([wall], [], seismic300), 'plate-washer')).toHaveLength(0)
  })
})

describe('cornerExtensions — oblique corners (round-10)', () => {
  test('45° corner scales the lap by (1+|cosθ|)/sinθ; 90° keeps ±1', () => {
    // Horizontal run meeting a 45° chamfer: through = the longer wall.
    const a = makeWall({ id: 'w_long', start: [0, 0], end: [4, 0] })
    const c = Math.SQRT1_2
    const b = makeWall({ id: 'w_chamfer', start: [4, 0], end: [4 + c, c] })
    const ext = cornerExtensions([a, b])
    const expected = (1 + c) / c // (1+cos45°)/sin45° ≈ 2.414
    expect(ext.get('w_long')?.end).toBeCloseTo(expected, 6) // through extends
    expect(ext.get('w_chamfer')?.start).toBeCloseTo(-expected, 6) // butt retreats
    // Perpendicular corners keep the classic ±1 (regression).
    const d = makeWall({ id: 'w_perp', start: [4, 0], end: [4, 3] })
    const ext2 = cornerExtensions([a, d])
    expect(ext2.get('w_long')?.end).toBeCloseTo(1, 6)
    expect(ext2.get('w_perp')?.start).toBeCloseTo(-1, 6)
  })
})
