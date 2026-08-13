import { describe, expect, test } from 'bun:test'
import { Euler, Vector3 } from 'three'
import { DEFAULT_SPEC } from '../core/spec'
import type { Member } from '../core/types'
import { extractRoofs, frameRoofs, type RoofSegmentSlice } from './roof-framing'

const byRole = (members: Member[], role: string): Member[] => members.filter((m) => m.role === role)

/** Rotate the member's +X axis by its euler — where the box's long axis points. */
function longAxis(member: Member): Vector3 {
  const [rx, ry, rz] = member.rotation
  return new Vector3(1, 0, 0).applyEuler(new Euler(rx, ry, rz, 'XYZ'))
}

function seg(overrides: Partial<RoofSegmentSlice> = {}): RoofSegmentSlice {
  return {
    id: 'roofseg_test',
    roofType: 'gable',
    position: [0, 2.5, 0],
    yaw: 0,
    width: 8,
    depth: 6,
    pitch: (40 * Math.PI) / 180,
    overhang: 0.3,
    wallHeight: 0.5,
    ...overrides,
  }
}

describe('extractRoofs', () => {
  const nodes: Record<string, Record<string, unknown>> = {
    level_1: { id: 'level_1', type: 'level', level: 0 },
    roof_1: {
      id: 'roof_1',
      type: 'roof',
      parentId: 'level_1',
      position: [10, 2.5, 5],
      rotation: Math.PI / 2,
      children: ['roofseg_1'],
    },
    roofseg_1: {
      id: 'roofseg_1',
      type: 'roof-segment',
      parentId: 'roof_1',
      position: [2, 0, 0],
      rotation: 0.1,
      roofType: 'gable',
      width: 8,
      depth: 6,
      pitch: 40,
      overhang: 0.3,
      wallHeight: 0.5,
    },
    roofseg_orphan: {
      id: 'roofseg_orphan',
      type: 'roof-segment',
      parentId: 'nowhere',
      position: [0, 0, 0],
    },
  }

  test('finds segments through the roof group, composing its transform', () => {
    const roofs = extractRoofs(nodes, 'level_1')
    expect(roofs).toHaveLength(1)
    const r = roofs[0] as RoofSegmentSlice
    // Ry(π/2) maps +X (2,0,0) → (0,0,-2), then + roof position (10, 2.5, 5).
    expect(r.position[0]).toBeCloseTo(10, 5)
    expect(r.position[1]).toBeCloseTo(2.5, 5)
    expect(r.position[2]).toBeCloseTo(3, 5)
    expect(r.yaw).toBeCloseTo(Math.PI / 2 + 0.1, 5)
    // degrees → radians
    expect(r.pitch).toBeCloseTo((40 * Math.PI) / 180, 5)
  })

  test('segments that never reach the level are ignored', () => {
    expect(extractRoofs(nodes, 'level_1').some((r) => r.id === 'roofseg_orphan')).toBe(false)
  })
})

describe('frameRoofs — gable', () => {
  const roof = seg()
  const members = frameRoofs([roof], [], DEFAULT_SPEC)
  const rafters = byRole(members, 'rafter')
  const theta = roof.pitch

  test('rafters on both slopes at o.c. spacing', () => {
    // 8m width / 24" o.c. ≈ 14 positions × 2 slopes
    expect(rafters.length).toBeGreaterThanOrEqual(24)
    const plusSide = rafters.filter((r) => (r.position[2] as number) > 0)
    const minusSide = rafters.filter((r) => (r.position[2] as number) < 0)
    expect(plusSide.length).toBe(minusSide.length)
  })

  test('rafter long axis points down-slope (verified via three.js Euler)', () => {
    const plus = rafters.find((r) => (r.position[2] as number) > 0) as Member
    const axis = longAxis(plus)
    // +Z-side rafter: axis ≈ (0, sinθ, -cosθ) — rises toward the ridge.
    expect(Math.abs(axis.x)).toBeLessThan(1e-6)
    expect(axis.y).toBeCloseTo(Math.sin(theta), 5)
    expect(axis.z).toBeCloseTo(-Math.cos(theta), 5)
  })

  test('ridge runs along the width at the peak, one size deeper', () => {
    const ridge = byRole(members, 'ridge')
    expect(ridge).toHaveLength(1)
    const r = ridge[0] as Member
    expect(r.size).toBe('2x8') // rafters 2x6 → ridge 2x8
    const rise = (roof.depth / 2) * Math.tan(theta)
    const ridgeDepth = 7.25 * 0.0254
    expect(r.position[1]).toBeCloseTo(2.5 + 0.5 + rise - ridgeDepth / 2, 4)
    expect(longAxis(r).x).toBeCloseTo(1, 5) // along X
  })

  test('ceiling joists span the depth at the eave line', () => {
    const cjs = byRole(members, 'ceiling-joist')
    expect(cjs.length).toBeGreaterThanOrEqual(20) // 8m / 16"
    const axis = longAxis(cjs[0] as Member)
    expect(Math.abs(axis.z)).toBeCloseTo(1, 5)
    expect((cjs[0] as Member).length).toBeCloseTo(6, 5)
  })

  test('collar ties sit in the upper third, every other rafter', () => {
    const ties = byRole(members, 'collar-tie')
    expect(ties.length).toBeGreaterThan(0)
    const rise = (roof.depth / 2) * Math.tan(theta)
    for (const tie of ties) {
      expect(tie.position[1]).toBeCloseTo(2.5 + 0.5 + (2 / 3) * rise, 4)
    }
    // collar length = 2·(remaining rise)/tanθ
    expect((ties[0] as Member).length).toBeCloseTo((2 * (rise / 3)) / Math.tan(theta), 4)
  })

  test('no hurricane ties by default; present under a high-wind spec', () => {
    expect(members.some((m) => m.label === 'hurricane tie')).toBe(false)
    const windy = frameRoofs([roof], [], { ...DEFAULT_SPEC, hurricaneTies: true })
    const ties = windy.filter((m) => m.label === 'hurricane tie')
    expect(ties.length).toBe(byRole(windy, 'rafter').length)
  })

  test('segment yaw carries into every member', () => {
    const rotated = frameRoofs([seg({ yaw: Math.PI / 2 })], [], DEFAULT_SPEC)
    const rafters = byRole(rotated, 'rafter')
    // yaw π/2 maps the segment's ±Z slopes onto level ±X: every rafter now
    // sits within the slope band on X while spreading along Z (the old width).
    for (const r of rafters) {
      expect(Math.abs(r.position[0] as number)).toBeLessThan(1.75)
    }
    const zs = rafters.map((r) => Math.abs(r.position[2] as number))
    expect(Math.max(...zs)).toBeGreaterThan(3.5)
  })
})

describe('frameRoofs — shed', () => {
  const members = frameRoofs([seg({ roofType: 'shed' })], [], DEFAULT_SPEC)

  test('single plane: one rafter per position, no ridge', () => {
    expect(byRole(members, 'ridge')).toHaveLength(0)
    const rafters = byRole(members, 'rafter')
    expect(rafters.length).toBeGreaterThanOrEqual(12)
    // slope length spans the whole depth
    expect((rafters[0] as Member).length).toBeGreaterThan(6)
  })
})

describe('frameRoofs — hip', () => {
  const members = frameRoofs([seg({ roofType: 'hip' })], [], DEFAULT_SPEC)

  test('four hips to the corners + shortened ridge', () => {
    expect(byRole(members, 'hip')).toHaveLength(4)
    const ridge = byRole(members, 'ridge')[0] as Member
    // 8m wide, 6m deep → run 3m → ridge = 8 − 2·3 = 2m
    expect(ridge.length).toBeCloseTo(2, 4)
  })

  test('hip members slope from ridge end to corner', () => {
    const hip = byRole(members, 'hip')[0] as Member
    const run = 3
    const rise = run * Math.tan((40 * Math.PI) / 180)
    expect(hip.length).toBeCloseTo(Math.hypot(run * Math.SQRT2, rise), 4)
    const axis = longAxis(hip)
    expect(Math.abs(axis.y)).toBeGreaterThan(0.3) // it climbs
  })
})

describe('frameRoofs — unsupported types emit nothing', () => {
  test('flat / gambrel produce no members (panel warns via count)', () => {
    expect(frameRoofs([seg({ roofType: 'flat' })], [], DEFAULT_SPEC)).toHaveLength(0)
    expect(frameRoofs([seg({ roofType: 'gambrel' })], [], DEFAULT_SPEC)).toHaveLength(0)
  })
})
