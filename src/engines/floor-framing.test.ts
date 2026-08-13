import { describe, expect, test } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
import type { Member, SlabSlice } from '../core/types'
import { feet, inches } from '../core/units'
import { frameFloor, joistSizeFor, polygonSpans } from './floor-framing'

const T = inches(1.5)

function slab(polygon: [number, number][], overrides: Partial<SlabSlice> = {}): SlabSlice {
  return { id: 'slab_test', polygon, holes: [], elevation: 0.05, thickness: 0.2, ...overrides }
}

const rect = (w: number, d: number): [number, number][] => [
  [0, 0],
  [w, 0],
  [w, d],
  [0, d],
]

const byRole = (members: Member[], role: string): Member[] => members.filter((m) => m.role === role)

describe('polygonSpans', () => {
  test('rectangle → one full span', () => {
    const spans = polygonSpans(rect(4, 6), 'x', 3)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.[0]).toBeCloseTo(0, 6)
    expect(spans[0]?.[1]).toBeCloseTo(4, 6)
  })

  test('L-shape → clipped span in the notch', () => {
    // 6x6 square with a 3x3 notch cut from the (x>3, z>3) corner.
    const L: [number, number][] = [
      [0, 0],
      [6, 0],
      [6, 3],
      [3, 3],
      [3, 6],
      [0, 6],
    ]
    const below = polygonSpans(L, 'x', 1.5) // full width
    expect(below[0]?.[1]).toBeCloseTo(6, 6)
    const above = polygonSpans(L, 'x', 4.5) // clipped to the leg
    expect(above[0]?.[1]).toBeCloseTo(3, 6)
  })
})

describe('joistSizeFor', () => {
  test('escalates depth with span, null past the table', () => {
    expect(joistSizeFor(feet(10), DEFAULT_SPEC)).toBe('2x8')
    expect(joistSizeFor(feet(14), DEFAULT_SPEC)).toBe('2x10')
    expect(joistSizeFor(feet(17), DEFAULT_SPEC)).toBe('2x12')
    expect(joistSizeFor(feet(25), DEFAULT_SPEC)).toBeNull()
  })
})

describe('frameFloor — rectangular slab 4m x 6m', () => {
  const members = frameFloor([slab(rect(4, 6))])
  const joists = byRole(members, 'joist')

  test('joists span the short (X) direction, laid along Z at o.c.', () => {
    expect(joists.length).toBeGreaterThanOrEqual(14) // 6m / 16" ≈ 14.8
    for (const j of joists) {
      expect(j.dims[0]).toBeCloseTo(4, 5) // run length = short span
      expect(j.rotation[1]).toBeCloseTo(0, 6) // along X → no yaw
    }
    // rows advance along Z
    const zs = joists.map((j) => j.position[2] as number).sort((a, b) => a - b)
    expect((zs[1] ?? 0) - (zs[0] ?? 0)).toBeCloseTo(inches(16), 4)
  })

  test('4m span (13.1 ft) picks 2x10 from the table', () => {
    expect(joists[0]?.size).toBe('2x10')
    expect(byRole(members, 'girder')).toHaveLength(0)
  })

  test('joist tops hang under the slab surface', () => {
    const depth = 9.25 * 0.0254
    const j = joists[0] as Member
    expect((j.position[1] as number) + depth / 2).toBeCloseTo(0.05 - 0.2, 4)
  })

  test('rim joists trace the four perimeter edges', () => {
    const rims = byRole(members, 'rim-joist')
    expect(rims).toHaveLength(4)
    const lengths = rims.map((r) => r.length).sort((a, b) => a - b)
    expect(lengths[0]).toBeCloseTo(4, 5)
    expect(lengths[3]).toBeCloseTo(6, 5)
  })

  test('one blocking row at mid-span between rows', () => {
    const blocking = byRole(members, 'blocking')
    expect(blocking.length).toBeGreaterThanOrEqual(joists.length - 2)
    for (const b of blocking) {
      expect(b.position[0]).toBeCloseTo(2, 5) // mid of the 4m span
      expect(b.length).toBeCloseTo(inches(16) - T, 5)
    }
  })
})

describe('frameFloor — wide slab needs a girder', () => {
  // 6m x 9m: short span 6m = 19.7ft > 2x12's 17.4ft → girder + halved span.
  const members = frameFloor([slab(rect(6, 9))])

  test('girder at mid-span with posts, joists re-sized for the half span', () => {
    const girders = byRole(members, 'girder')
    expect(girders.length).toBeGreaterThanOrEqual(1)
    expect(girders[0]?.position[0]).toBeCloseTo(3, 5) // mid of 6m span
    expect(byRole(members, 'post').length).toBeGreaterThanOrEqual(2)
    // halved span 3m = 9.8ft → 2x8
    expect(byRole(members, 'joist')[0]?.size).toBe('2x8')
    expect(girders[0]?.flag).toContain('verify')
  })
})

describe('frameFloor — L-shaped slab clips joists', () => {
  const L: [number, number][] = [
    [0, 0],
    [6, 0],
    [6, 3],
    [3, 3],
    [3, 6],
    [0, 6],
  ]
  const members = frameFloor([slab(L)])

  test('rows past the notch are shorter than rows before it', () => {
    const joists = byRole(members, 'joist')
    // short axis is a tie (6x6 bbox) → runAxis 'x'; rows along z
    const before = joists.filter((j) => (j.position[2] as number) < 3)
    const after = joists.filter((j) => (j.position[2] as number) > 3)
    expect(Math.max(...before.map((j) => j.length))).toBeCloseTo(6, 3)
    expect(Math.max(...after.map((j) => j.length))).toBeCloseTo(3, 3)
    // rims follow all 6 edges
    expect(byRole(members, 'rim-joist')).toHaveLength(6)
  })
})
