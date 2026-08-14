import { describe, expect, test } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
import type { Member, SlabSlice } from '../core/types'
import { feet, inches } from '../core/units'
import { frameFloor, joistSizeFor, polygonSpans, validateJoistBearing } from './floor-framing'

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

  test('FLUSH girder at mid-span: girder top = joist top, joists hung on hangers', () => {
    const girders = byRole(members, 'girder')
    expect(girders.length).toBeGreaterThanOrEqual(1)
    const girder = girders[0] as Member
    expect(girder.position[0]).toBeCloseTo(3, 5) // mid of 6m span
    // FLUSH: tops align (girder is deeper, so centers differ by the depth gap)
    const joist = byRole(members, 'joist')[0] as Member
    const girderTop = (girder.position[1] as number) + girder.dims[1] / 2
    const joistTop = (joist.position[1] as number) + joist.dims[1] / 2
    expect(girderTop).toBeCloseTo(joistTop, 5)
    // interrupted rows hang on hangers at both girder faces
    const hangers = byRole(members, 'hanger')
    expect(hangers.length).toBeGreaterThanOrEqual(20) // 2 per interrupted row
    expect(hangers.length % 2).toBe(0)
    // joist rows are SPLIT at the girder line
    const gt = 3.5 * 0.0254
    for (const j of byRole(members, 'joist')) {
      const half = j.dims[0] / 2
      const lo = (j.position[0] as number) - half
      const hi = (j.position[0] as number) + half
      expect(lo > 3 - gt / 2 - 1e-6 || hi < 3 + gt / 2 + 1e-6).toBe(true)
    }
    expect(byRole(members, 'post').length).toBeGreaterThanOrEqual(2)
    expect(byRole(members, 'joist')[0]?.size).toBe('2x8') // halved span 3m
    expect(girder.flag).toContain('verify')
  })

  test('posts descend the storey below (parameterized height)', () => {
    const tall = frameFloor([slab(rect(6, 9))], [], DEFAULT_SPEC, 3.1)
    const post = byRole(tall, 'post')[0] as Member
    expect(post.dims[1]).toBeCloseTo(3.1, 5)
    expect(post.length).toBeCloseTo(3.1, 5)
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

  test('rows past the notch lose their second segment (girder splits the rest)', () => {
    const joists = byRole(members, 'joist')
    // 6x6 bbox tie → runAxis 'x'; rows along z. The 6m span needs a flush
    // girder at x=3, so full-width rows split into two segments; rows past
    // the notch (z>3) only span x∈[0,3] and keep a single segment.
    const beforeRows = new Set(
      joists.filter((j) => (j.position[2] as number) < 3).map((j) => (j.position[2] as number).toFixed(4)),
    )
    const before = joists.filter((j) => (j.position[2] as number) < 3)
    const after = joists.filter((j) => (j.position[2] as number) > 3)
    expect(before.length).toBeGreaterThan(beforeRows.size) // ≥2 segments per full row
    // after-notch rows: single segment ending at the girder cut (≈3 − gt/2)
    const gt = 3.5 * 0.0254
    expect(Math.max(...after.map((j) => j.length))).toBeCloseTo(3 - gt / 2, 2)
    // rims follow all 6 edges
    expect(byRole(members, 'rim-joist')).toHaveLength(6)
  })
})

// ---------------------------------------------------------------------------
// Round-1 fabrication features (stairwells, sistered joists, bearing check)
// ---------------------------------------------------------------------------

import type { WallSlice } from '../core/types'

function bearingWall(id: string, start: [number, number], end: [number, number]): WallSlice {
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  return {
    id, start, end, length, dir: [dx / length, dz / length],
    thickness: 0.1, height: 2.5, exterior: false, openings: [], curved: false,
  }
}

describe('frameFloor — stairwell hole framing (R502.10)', () => {
  // 4m x 6m slab (joists along X), 1x2.4m stair hole centered-ish.
  const hole: [number, number][] = [
    [1.5, 2],
    [2.5, 2],
    [2.5, 4.4],
    [1.5, 4.4],
  ]
  const members = frameFloor([slab(rect(4, 6), { holes: [hole] })])

  test('no joist crosses the hole; cut ends hang on hangers at the headers', () => {
    for (const j of byRole(members, 'joist')) {
      if (j.label?.includes('trimmer')) continue
      const z = j.position[2] as number
      if (z > 2 - T / 2 && z < 4.4 + T / 2) {
        const half = j.dims[0] / 2
        const lo = (j.position[0] as number) - half
        const hi = (j.position[0] as number) + half
        // segment must not overlap the hole run extent [1.5, 2.5]
        expect(hi <= 1.5 + 1e-6 || lo >= 2.5 - 1e-6).toBe(true)
      }
    }
    const stairHangers = byRole(members, 'hanger').filter((h) => h.label?.includes('stair'))
    expect(stairHangers.length).toBeGreaterThanOrEqual(4)
  })

  test('doubled headers at both hole ends, doubled trimmers alongside', () => {
    const headers = byRole(members, 'header')
    expect(headers).toHaveLength(4) // 2 plies × 2 ends
    for (const h of headers) {
      expect(h.label).toContain('doubled')
      // headers run ACROSS the joists (along Z) → yaw −π/2
      expect(Math.abs(Math.abs(h.rotation[1] as number) - Math.PI / 2)).toBeLessThan(1e-6)
    }
    const headerXs = headers.map((h) => h.position[0] as number).sort((a, b) => a - b)
    expect(headerXs[0]).toBeLessThan(1.5) // outside the hole start
    expect(headerXs[3]).toBeGreaterThan(2.5) // outside the hole end
    const trimmers = byRole(members, 'joist').filter((j) => j.label?.includes('trimmer'))
    expect(trimmers.length).toBeGreaterThanOrEqual(4) // 2 plies × 2 sides
    const trimmerZs = trimmers.map((j) => j.position[2] as number)
    expect(Math.min(...trimmerZs)).toBeLessThan(2)
    expect(Math.max(...trimmerZs)).toBeGreaterThan(4.4)
  })

  test('LOD 200 skips the stair kit (generic members only)', () => {
    const generic = frameFloor([slab(rect(4, 6), { holes: [hole] })], [], {
      ...DEFAULT_SPEC,
      detail: '200',
    })
    expect(byRole(generic, 'header')).toHaveLength(0)
  })
})

describe('frameFloor — sistered joists under parallel bearing walls', () => {
  // Joists run along X (4m span); a 3m interior wall also along X.
  const wall = bearingWall('wall_bearing', [0.5, 3], [3.5, 3])
  const members = frameFloor([slab(rect(4, 6))], [wall])

  test('one extra joist rides beside the wall line, extended to the nearest bearings', () => {
    const sisters = byRole(members, 'joist').filter((j) => j.label?.includes('Sistered'))
    expect(sisters).toHaveLength(1)
    const s = sisters[0] as Member
    expect(s.position[2] as number).toBeCloseTo(3 + T, 5) // one thickness beside
    // the wall runs x ∈ [0.5, 3.5]; the nearest bearings are the polygon
    // edges at 0 and 4 — the sister spans support-to-support (R502.6),
    // never ending mid-span (round-2 counterexample)
    expect(s.length).toBeCloseTo(4, 4)
    expect((s.position[0] as number) - s.dims[0] / 2).toBeCloseTo(0, 5)
    expect((s.position[0] as number) + s.dims[0] / 2).toBeCloseTo(4, 5)
    expect(s.label).toContain('wall_bearing')
  })

  test('perpendicular and short walls get no sister', () => {
    const perp = bearingWall('w_perp', [2, 1], [2, 5])
    const short = bearingWall('w_short', [1, 2], [2.2, 2])
    const none = frameFloor([slab(rect(4, 6))], [perp, short])
    expect(byRole(none, 'joist').filter((j) => j.label?.includes('Sistered'))).toHaveLength(0)
  })
})

describe('frameFloor — LOD 400 bearing validation', () => {
  test('a well-framed floor produces zero unsupported-end flags', () => {
    const members = frameFloor(
      [slab(rect(6, 9), { holes: [[[2, 3], [3, 3], [3, 5], [2, 5]]] })],
      [],
      { ...DEFAULT_SPEC, detail: '400' },
    )
    const flagged = byRole(members, 'joist').filter((j) => j.flag?.includes('Unsupported'))
    expect(flagged).toHaveLength(0)
    // and the kit is present, so the checker had real geometry to verify
    expect(byRole(members, 'hanger').length).toBeGreaterThan(0)
  })
})

describe('frameFloor — LOD 400 bearing flag actually FIRES (round-2 gap)', () => {
  test('an injected joist ending mid-span gets the R502.6 flag', () => {
    const badJoist: Member = {
      system: 'floor-framing',
      role: 'joist',
      size: '2x8',
      dims: [1.5, 0.184, T],
      length: 1.5,
      position: [1.25, -0.1, 2], // spans x ∈ [0.5, 2.0] — neither end bears
      rotation: [0, 0, 0],
      material: 'lumber',
      sourceId: 'slab_test',
    }
    const members = [badJoist]
    validateJoistBearing(members, rect(4, 6), 'x', [])
    expect(badJoist.flag).toContain('Unsupported joist end')
    expect(badJoist.flag).toContain('R502.6')
    // a joist that bears on both polygon edges stays clean
    const good: Member = { ...badJoist, dims: [4, 0.184, T], length: 4, position: [2, -0.1, 2], flag: undefined }
    validateJoistBearing([good], rect(4, 6), 'x', [])
    expect(good.flag).toBeUndefined()
  })

  test('sisters over a girder split at it and hang — all at LOD 400 with zero flags', () => {
    // 6×9 slab needs a girder at x=3; a bearing wall along X crosses it.
    const wall = bearingWall('w_cross', [1, 4], [5, 4])
    const members = frameFloor([slab(rect(6, 9))], [wall], { ...DEFAULT_SPEC, detail: '400' })
    const sisters = byRole(members, 'joist').filter((j) => j.label?.includes('Sistered'))
    expect(sisters.length).toBe(2) // split at the flush girder
    const gt = 3.5 * 0.0254
    for (const s of sisters) {
      const lo = (s.position[0] as number) - s.dims[0] / 2
      const hi = (s.position[0] as number) + s.dims[0] / 2
      expect(lo > 3 - gt / 2 - 1e-6 || hi < 3 + gt / 2 + 1e-6).toBe(true)
      expect(s.flag).toBeUndefined() // both halves bear (edge + girder)
    }
    const flagged = byRole(members, 'joist').filter((j) => j.flag)
    expect(flagged).toHaveLength(0)
  })
})

describe('frameFloor — hole bearings are confined to the hole cross band (round-3)', () => {
  // The round-3 counterexample: a stair hole near one corner, a bearing
  // wall far away. The old code treated the hole's run coordinates as
  // bearing EVERYWHERE, clipping the sister to mid-air at x=1.5.
  const hole: [number, number][] = [
    [0.5, 0.5],
    [1.5, 0.5],
    [1.5, 1.5],
    [0.5, 1.5],
  ]
  const wall = bearingWall('w_far', [0, 4], [4, 4])
  const members = frameFloor([slab(rect(4, 6), { holes: [hole] })], [wall], {
    ...DEFAULT_SPEC,
    detail: '400',
  })

  test('the sister ignores the distant hole and spans edge to edge', () => {
    const sisters = byRole(members, 'joist').filter((j) => j.label?.includes('Sistered'))
    expect(sisters).toHaveLength(1)
    const s = sisters[0] as Member
    expect((s.position[0] as number) - s.dims[0] / 2).toBeCloseTo(0, 5)
    expect((s.position[0] as number) + s.dims[0] / 2).toBeCloseTo(4, 5)
  })

  test('no joist anywhere carries an unsupported-end flag', () => {
    expect(byRole(members, 'joist').filter((j) => j.flag)).toHaveLength(0)
  })

  test('the validator still accepts hole bearings INSIDE the band and rejects them outside', () => {
    const mk = (cross: number): Member => ({
      system: 'floor-framing',
      role: 'joist',
      size: '2x8',
      dims: [1, 0.184, T],
      length: 1,
      position: [2, -0.1, cross], // spans x ∈ [1.5, 2.5]: left end at the hole run line
      rotation: [0, 0, 0],
      material: 'lumber',
      sourceId: 'slab_test',
    })
    const inside = mk(1.0) // within the hole cross band [0.5, 1.5]
    const outside = mk(4.0) // far outside
    validateJoistBearing([inside, outside], rect(4, 6), 'x', [
      { u: 1.5, cross: [0.5, 1.5] },
      { u: 2.5, cross: [0.5, 1.5] },
    ])
    expect(inside.flag).toBeUndefined() // header bears it
    expect(outside.flag).toContain('Unsupported') // no header out here
  })
})

describe('frameFloor — sisters split at stair holes (round-4 counterexample)', () => {
  // Bearing wall flanking the stairwell by 1 cm of modeling slop: the sister
  // row (wall cross + t) lands INSIDE the hole cross band and must split.
  const hole: [number, number][] = [
    [1.5, 2],
    [2.5, 2],
    [2.5, 3],
    [1.5, 3],
  ]
  const wall = bearingWall('w_flank', [0, 1.99], [4, 1.99])
  const members = frameFloor([slab(rect(4, 6), { holes: [hole] })], [wall], {
    ...DEFAULT_SPEC,
    detail: '400',
  })
  const sisters = byRole(members, 'joist').filter((j) => j.label?.includes('Sistered'))

  test('the sister never bridges the stairwell — split at the hole run', () => {
    expect(sisters.length).toBe(2)
    for (const s of sisters) {
      const lo = (s.position[0] as number) - s.dims[0] / 2
      const hi = (s.position[0] as number) + s.dims[0] / 2
      expect(hi <= 1.5 + 1e-6 || lo >= 2.5 - 1e-6).toBe(true)
    }
    // cut ends hang on the stair headers
    const hangers = byRole(members, 'hanger').filter(
      (h) => h.label?.includes('stair') && Math.abs((h.position[2] as number) - (1.99 + T)) < 1e-6,
    )
    expect(hangers.length).toBe(2)
  })

  test('zero flags on the fixed geometry; wall fully over the hole also splits', () => {
    expect(byRole(members, 'joist').filter((j) => j.flag)).toHaveLength(0)
    const over = frameFloor(
      [slab(rect(4, 6), { holes: [hole] })],
      [bearingWall('w_over', [0, 2.5], [4, 2.5])],
      { ...DEFAULT_SPEC, detail: '400' },
    )
    const overSisters = byRole(over, 'joist').filter((j) => j.label?.includes('Sistered'))
    for (const s of overSisters) {
      const lo = (s.position[0] as number) - s.dims[0] / 2
      const hi = (s.position[0] as number) + s.dims[0] / 2
      expect(hi <= 1.5 + 1e-6 || lo >= 2.5 - 1e-6).toBe(true)
    }
    expect(byRole(over, 'joist').filter((j) => j.flag)).toHaveLength(0)
  })

  test('the validator now FLAGS a hole-bridging joist (falsifiable forever)', () => {
    const bridging: Member = {
      system: 'floor-framing',
      role: 'joist',
      size: '2x8',
      dims: [4, 0.184, T],
      length: 4,
      position: [2, -0.1, 2.5], // spans x ∈ [0,4] straight across the hole band
      rotation: [0, 0, 0],
      material: 'lumber',
      sourceId: 'slab_test',
    }
    validateJoistBearing([bridging], rect(4, 6), 'x', [], [
      { run: [1.5, 2.5], cross: [2, 3] },
    ])
    expect(bridging.flag).toContain('crosses a floor opening')
    expect(bridging.flag).toContain('R502.10')
  })
})

describe('frameFloor — girders respect stair holes (round-5 counterexample)', () => {
  // 6×9 slab needs the mid-span girder at x=3; the stairwell straddles it.
  const hole: [number, number][] = [
    [2.5, 4],
    [3.5, 4],
    [3.5, 6],
    [2.5, 6],
  ]
  const members = frameFloor([slab(rect(6, 9), { holes: [hole] })], [], {
    ...DEFAULT_SPEC,
    detail: '400',
  })

  test('the girder is split at the hole — no segment crosses the opening', () => {
    const girders = byRole(members, 'girder')
    expect(girders.length).toBeGreaterThanOrEqual(2)
    for (const g of girders) {
      const half = g.length / 2
      const lo = (g.position[2] as number) - half
      const hi = (g.position[2] as number) + half
      expect(hi <= 4 + 1e-6 || lo >= 6 - 1e-6).toBe(true)
    }
    // cut ends hang at the stair trimmers
    const gHangers = byRole(members, 'hanger').filter((h) => h.label?.includes('girder'))
    expect(gHangers.length).toBeGreaterThanOrEqual(2)
  })

  test('no posts land inside the opening; zero flags on the fixed geometry', () => {
    for (const p of byRole(members, 'post')) {
      const z = p.position[2] as number
      expect(z <= 4 + 1e-6 || z >= 6 - 1e-6).toBe(true)
    }
    expect(members.filter((m) => m.flag?.includes('crosses a floor opening'))).toHaveLength(0)
  })

  test('the validator FLAGS an injected hole-crossing girder (falsifiable)', () => {
    const bad: Member = {
      system: 'floor-framing',
      role: 'girder',
      size: '4x10',
      dims: [0.089, 0.235, 9],
      length: 9,
      position: [3, -0.15, 4.5],
      rotation: [0, -Math.PI / 2, 0],
      material: 'engineered',
      sourceId: 'slab_test',
    }
    validateJoistBearing([bad], rect(6, 9), 'x', [], [{ run: [2.5, 3.5], cross: [4, 6] }])
    expect(bad.flag).toContain('Girder crosses a floor opening')
  })

  test('PARTIAL joist overlap is flagged too (end at the header face)', () => {
    const partial: Member = {
      system: 'floor-framing',
      role: 'joist',
      size: '2x8',
      dims: [2.5, 0.184, T],
      length: 2.5,
      position: [2.75, -0.1, 5], // spans x ∈ [1.5, 4.0] over hole run [2.5, 3.5]
      rotation: [0, 0, 0],
      material: 'lumber',
      sourceId: 'slab_test',
    }
    validateJoistBearing([partial], rect(6, 9), 'x', [], [{ run: [2.5, 3.5], cross: [4, 6] }])
    expect(partial.flag).toContain('crosses a floor opening')
  })
})

describe('frameFloor — round-5 seam cases (hanger window, orphan hangers)', () => {
  test('a wall 1cm below the hole high edge still splits WITH hangers', () => {
    // 5×7 slab, hole x[1,3]×z[2,3]; wall at z = 3 - 0.01 → sister at 3.028,
    // inside the widened ±t band → split + hangers (was the 19mm window).
    const hole: [number, number][] = [
      [1, 2],
      [3, 2],
      [3, 3],
      [1, 3],
    ]
    const wall = bearingWall('w_seam', [0.5, 2.99], [4.5, 2.99])
    const members = frameFloor([slab(rect(5, 7), { holes: [hole] })], [wall], {
      ...DEFAULT_SPEC,
      detail: '400',
    })
    const sisters = byRole(members, 'joist').filter((j) => j.label?.includes('Sistered'))
    for (const s of sisters) {
      const lo = (s.position[0] as number) - s.dims[0] / 2
      const hi = (s.position[0] as number) + s.dims[0] / 2
      expect(hi <= 1 + 1e-6 || lo >= 3 - 1e-6).toBe(true)
    }
    const sisterHangers = byRole(members, 'hanger').filter(
      (h) => Math.abs((h.position[2] as number) - (2.99 + T)) < 1e-6,
    )
    expect(sisterHangers.length).toBe(2)
    expect(members.filter((m) => m.flag)).toHaveLength(0)
  })

  test('a hole hugging the rim leaves no orphan hangers and no header outside the slab', () => {
    // hole 10cm from the x=0 edge: the left joist sliver is dropped — the
    // left-side hangers and any header ply past the polygon must vanish.
    const hole: [number, number][] = [
      [0.1, 2],
      [1.1, 2],
      [1.1, 3.4],
      [0.1, 3.4],
    ]
    const members = frameFloor([slab(rect(4, 6), { holes: [hole] })], [], {
      ...DEFAULT_SPEC,
      detail: '400',
    })
    // no hanger at the left cut line (sliver side), hangers remain on the right
    const leftHangers = byRole(members, 'hanger').filter(
      (h) => Math.abs((h.position[0] as number) - 0.1) < 1e-6,
    )
    expect(leftHangers).toHaveLength(0)
    // every header ply sits inside the slab
    for (const h of byRole(members, 'header')) {
      expect(h.position[0] as number).toBeGreaterThanOrEqual(0)
      expect(h.position[0] as number).toBeLessThanOrEqual(4)
    }
  })
})

// ---------------------------------------------------------------------------
// Round-6: girder presence — the hole-interaction matrix closed
// ---------------------------------------------------------------------------

describe('frameFloor — girder presence (round-6 counterexamples)', () => {
  // The reviewer's L: full width for z<5, wing x∈[3,6] for z∈[5,9].
  const L: [number, number][] = [
    [0, 0],
    [6, 0],
    [6, 9],
    [3, 9],
    [3, 5],
    [0, 5],
  ]

  test('wing rows land ON the notch rim — never cut at an absent girder', () => {
    const members = frameFloor([slab(L)], [], { ...DEFAULT_SPEC, detail: '400' })
    const gt = 3.5 * 0.0254
    const wingRows = byRole(members, 'joist').filter(
      (j) => (j.position[2] as number) > 5 && !j.label?.includes('trimmer'),
    )
    expect(wingRows.length).toBeGreaterThan(0)
    for (const j of wingRows) {
      const lo = (j.position[0] as number) - j.dims[0] / 2
      // ends exactly at the notch rim x=3, NOT at the girder face 3+gt/2
      expect(lo).toBeCloseTo(3, 5)
    }
    // the girder itself only spans where the polygon has full width
    for (const g of byRole(members, 'girder')) {
      const half = g.length / 2
      expect((g.position[2] as number) + half).toBeLessThanOrEqual(5 + 1e-6)
    }
    expect(members.filter((m) => m.flag?.includes('Unsupported'))).toHaveLength(0)
  })

  test('no orphan girder hangers inside a stairwell straddling the girder', () => {
    const hole: [number, number][] = [
      [2.5, 4],
      [3.5, 4],
      [3.5, 6],
      [2.5, 6],
    ]
    const members = frameFloor([slab(rect(6, 9), { holes: [hole] })], [], {
      ...DEFAULT_SPEC,
      detail: '400',
    })
    // every girder-face hanger must sit where the girder EXISTS (z ∉ (4,6))
    const girderHangers = byRole(members, 'hanger').filter((h) => h.label?.includes('girder'))
    expect(girderHangers.length).toBeGreaterThan(0)
    for (const h of girderHangers) {
      const z = h.position[2] as number
      expect(z <= 4 + 1e-6 || z >= 6 - 1e-6).toBe(true)
    }
    // and every hanger overall has a joist/girder end within reach
    const joistEnds: [number, number][] = []
    for (const j of members.filter((m) => m.role === 'joist' || m.role === 'girder')) {
      const half = j.length / 2
      if (Math.abs(Math.cos(j.rotation[1] as number)) > 0.5) {
        joistEnds.push(
          [(j.position[0] as number) - half, j.position[2] as number],
          [(j.position[0] as number) + half, j.position[2] as number],
        )
      } else {
        joistEnds.push(
          [j.position[0] as number, (j.position[2] as number) - half],
          [j.position[0] as number, (j.position[2] as number) + half],
        )
      }
    }
    for (const h of byRole(members, 'hanger')) {
      const hx = h.position[0] as number
      const hz = h.position[2] as number
      const attached = joistEnds.some(([ex, ez]) => Math.hypot(ex - hx, ez - hz) < 0.15)
      expect(attached).toBe(true)
    }
  })

  test('stair trimmers split at the girder — no ply passes through the 4x10', () => {
    const hole: [number, number][] = [
      [2.5, 4],
      [3.5, 4],
      [3.5, 6],
      [2.5, 6],
    ]
    const members = frameFloor([slab(rect(6, 9), { holes: [hole] })], [], {
      ...DEFAULT_SPEC,
      detail: '400',
    })
    const gt = 3.5 * 0.0254
    const trimmers = byRole(members, 'joist').filter((j) => j.label?.includes('trimmer'))
    expect(trimmers.length).toBeGreaterThan(0)
    for (const tr of trimmers) {
      const half = tr.dims[0] / 2
      const lo = (tr.position[0] as number) - half
      const hi = (tr.position[0] as number) + half
      expect(lo > 3 - gt / 2 - 1e-6 || hi < 3 + gt / 2 + 1e-6).toBe(true)
    }
  })

  test('header plies clamp against the POLYGON — L-shape notch stays empty', () => {
    // hole in the wing, 5cm from the notch line: no ply may land at x < 3
    // within the wing band (that is the notch — outside the slab).
    const hole: [number, number][] = [
      [3.05, 6],
      [4, 6],
      [4, 7.5],
      [3.05, 7.5],
    ]
    const members = frameFloor([slab(L, { holes: [hole] })], [], {
      ...DEFAULT_SPEC,
      detail: '400',
    })
    for (const h of byRole(members, 'header')) {
      const x = h.position[0] as number
      const z = h.position[2] as number
      if (z > 5) expect(x).toBeGreaterThanOrEqual(3 - 1e-6)
    }
  })

  test('twin holes sharing a cross band emit ONE trimmer per line', () => {
    const holes: [number, number][][] = [
      [
        [0.8, 2],
        [1.6, 2],
        [1.6, 3.2],
        [0.8, 3.2],
      ],
      [
        [2.4, 2],
        [3.2, 2],
        [3.2, 3.2],
        [2.4, 3.2],
      ],
    ]
    const members = frameFloor([slab(rect(4, 9), { holes })], [], {
      ...DEFAULT_SPEC,
      detail: '400',
    })
    const trimmers = byRole(members, 'joist').filter((j) => j.label?.includes('trimmer'))
    const lines = trimmers.map((tr) => (tr.position[2] as number).toFixed(6))
    expect(new Set(lines).size).toBe(lines.length) // no coincident duplicates
  })

  test('no blocking row embedded inside the girder body', () => {
    const members = frameFloor([slab(rect(6, 9))], [], { ...DEFAULT_SPEC, detail: '400' })
    expect(byRole(members, 'girder').length).toBeGreaterThan(0)
    expect(byRole(members, 'blocking')).toHaveLength(0)
  })
})
