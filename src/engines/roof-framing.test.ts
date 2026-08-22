import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Euler, Vector3 } from 'three'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Member } from '../core/types'
import {
  birdsmouthSeat,
  detectUnframedRoofIntersections,
  extractRoofs,
  frameRoofs,
  type RoofSegmentSlice,
} from './roof-framing'
import { computeTakeoff } from './takeoff'

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

  test('ceiling joists span the depth at the eave line (ends clipped to the deck plane, B6)', () => {
    const cjs = byRole(members, 'ceiling-joist')
    expect(cjs.length).toBeGreaterThanOrEqual(20) // 8m / 16"
    const axis = longAxis(cjs[0] as Member)
    expect(Math.abs(axis.z)).toBeCloseTo(1, 5)
    // The BOX inscribes inside the field clip to the rafter slope (a square
    // end's top corner would poke through the B6 deck): each end pulls back
    // (cjD − rd/(2cosθ))/tanθ (+2 mm seam). Flag math keeps the full 6 m.
    const rd = 5.5 * 0.0254
    const cjD = 5.5 * 0.0254
    const clip = (cjD - rd / (2 * Math.cos(theta))) / Math.tan(theta) + 0.002
    expect((cjs[0] as Member).length).toBeCloseTo(6 - 2 * clip, 5)
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
    // one tie per bearing rafter — barge rafters ride the rake, no plate below
    const bearing = byRole(windy, 'rafter').filter((r) => !r.label?.includes('Barge'))
    expect(ties.length).toBe(bearing.length)
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

  test('hip members slope from the ridge END bearing to the corner', () => {
    const hip = byRole(members, 'hip')[0] as Member
    const run = 3
    const theta = (40 * Math.PI) / 180
    const rise = run * Math.tan(theta)
    // Top cut bears clear of the ridge body (round-10 gate): pulled back
    // √2·(ridgeT/2 + hipT/2) + (rd/2)·tan(hipTilt) along the slope.
    const hipTilt = Math.atan2(rise, run * Math.SQRT2)
    const t = 1.5 * 0.0254
    const rd = 5.5 * 0.0254
    const hipInset = Math.SQRT2 * ((1.5 * 0.0254) / 2 + t / 2) + (rd / 2) * Math.tan(hipTilt)
    expect(hip.length).toBeCloseTo(Math.hypot(run * Math.SQRT2, rise) - hipInset, 4)
    const axis = longAxis(hip)
    expect(Math.abs(axis.y)).toBeGreaterThan(0.3) // it climbs
  })
})

// ---------------------------------------------------------------------------
// Round-1 fabrication features (jacks, new roof types, valleys, rake, fascia)
// ---------------------------------------------------------------------------

describe('frameRoofs — hip jack rafters (LOD 350)', () => {
  // 8 × 6, pitch 40 → run 3, ridgeHalf 1; 24" o.c. jacks.
  const roof = seg({ roofType: 'hip' })
  const members = frameRoofs([roof], [], DEFAULT_SPEC)
  const jacks = byRole(members, 'jack-rafter')
  const theta = roof.pitch
  const spacing = DEFAULT_SPEC.rafterSpacing
  const baseY = roof.position[1] + roof.wallHeight

  test('jacks populate all four triangular planes', () => {
    expect(jacks.length).toBeGreaterThanOrEqual(24)
    // side planes: stations past both ridge ends on both slopes
    const sidePlane = jacks.filter(
      (j) => Math.abs(j.position[0] as number) > 1 && Math.abs(j.position[2] as number) > 0.2,
    )
    expect(sidePlane.length).toBeGreaterThan(0)
    // end planes: stations off the centerline near the ±X eaves
    const endPlane = jacks.filter((j) => Math.abs(j.position[0] as number) > 3)
    expect(endPlane.length).toBeGreaterThan(0)
  })

  test('numeric: first side-plane jack bears on the hip face, tail inscribed', () => {
    // Station d = spacing past the +X ridge end, +Z slope. The cheek bears
    // on the hip SIDE FACE: run shortens by √2·t/2 + t/2 + (rd/2)·sinθ, and
    // the tail plumb cut inscribes the box by (rd/2)·sinθ in plan
    // (round-10 gate).
    const d = spacing
    const t = 1.5 * 0.0254
    const rd = 5.5 * 0.0254
    const setback = (Math.SQRT2 * t) / 2 + t / 2 + (rd / 2) * Math.sin(theta)
    const bearingRun = 3 - d - setback
    const tailPlan = (rd / 2) * Math.sin(theta)
    const expectedLen = bearingRun / Math.cos(theta) + roof.overhang - (rd / 2) * Math.tan(theta)
    const j = jacks.find(
      (m) =>
        Math.abs((m.position[0] as number) - (1 + d)) < 1e-4 &&
        (m.position[2] as number) > 0 &&
        Math.abs(m.length - expectedLen) < 1e-4,
    ) as Member
    expect(j).toBeDefined()
    const axis = longAxis(j)
    const top = new Vector3(...j.position).add(axis.clone().multiplyScalar(j.length / 2))
    const bot = new Vector3(...j.position).sub(axis.clone().multiplyScalar(j.length / 2))
    const upper = top.y > bot.y ? top : bot
    const lower = top.y > bot.y ? bot : top
    expect(upper.z).toBeCloseTo(3 - bearingRun, 5) // clear of the hip face
    expect(upper.y).toBeCloseTo(baseY + bearingRun * Math.tan(theta), 5)
    // lower end at the inscribed tail cut
    expect(lower.z).toBeCloseTo(3 + roof.overhang * Math.cos(theta) - tailPlan, 5)
    expect(lower.y).toBeCloseTo(baseY - roof.overhang * Math.sin(theta) + tailPlan * Math.tan(theta), 5)
  })

  test('jacks shorten as they approach the corner', () => {
    // side-plane jacks only (long axis on Z); end-plane jacks run along X
    const plusEnd = jacks
      .filter(
        (j) =>
          Math.abs(longAxis(j).x) < 0.1 &&
          (j.position[0] as number) > 1 &&
          (j.position[2] as number) > 0.2,
      )
      .sort((a, b) => (a.position[0] as number) - (b.position[0] as number))
    for (let i = 1; i < plusEnd.length; i++) {
      expect((plusEnd[i] as Member).length).toBeLessThan((plusEnd[i - 1] as Member).length + 1e-9)
    }
  })

  test('king common rafter spans ridge end to tail, inscribed plumb cuts', () => {
    const kings = byRole(members, 'rafter').filter((r) => r.label?.includes('King common'))
    expect(kings).toHaveLength(2)
    const rd = 5.5 * 0.0254
    const t = 1.5 * 0.0254
    const inset = (rd / 2) * Math.tan(theta)
    // top pulled back from the hip junction like a jack cheek (round-14)
    const setback = (Math.SQRT2 * t) / 2 + (rd / 2) * Math.sin(theta)
    for (const k of kings) {
      expect(k.length).toBeCloseTo((3 - setback) / Math.cos(theta) + roof.overhang - 2 * inset, 5)
      expect(Math.abs(k.position[2] as number)).toBeLessThan(1e-6) // centerline
    }
  })

  test('LOD 200 skips jacks and kings', () => {
    const generic = frameRoofs([roof], [], { ...DEFAULT_SPEC, detail: '200' })
    expect(byRole(generic, 'jack-rafter')).toHaveLength(0)
  })
})

describe('frameRoofs — flat roof (joists + rim)', () => {
  const roof = seg({ roofType: 'flat' })
  const members = frameRoofs([roof], [], DEFAULT_SPEC)

  test('joists span the short axis over footprint + overhang, dead level', () => {
    const joists = byRole(members, 'rafter')
    expect(joists.length).toBeGreaterThanOrEqual(12)
    for (const j of joists) {
      // joists stop at the rim INNER faces (round-14): span − 2t
      expect(j.length).toBeCloseTo(6 + 2 * 0.3 - 2 * 1.5 * 0.0254, 5)
      expect(j.rotation[2]).toBeCloseTo(0, 6) // no tilt
      expect(j.label).toContain('R903.4') // drainage slope call-out
    }
  })

  test('four rim boards close the perimeter', () => {
    const rims = byRole(members, 'rim-joist')
    expect(rims).toHaveLength(4)
    // short rims BUTT between the long ones (round-14): −2t
    const lengths = rims.map((r) => r.length).sort((a, b) => a - b)
    expect(lengths[0]).toBeCloseTo(6.6 - 2 * 1.5 * 0.0254, 5)
    expect(lengths[3]).toBeCloseTo(8.6, 5)
  })
})

describe('frameRoofs — gambrel (host ratios wr=0.5, hr=0.6)', () => {
  const roof = seg({ roofType: 'gambrel' })
  const members = frameRoofs([roof], [], DEFAULT_SPEC)
  const theta = roof.pitch
  // host math: run 3, lowerRun 1.5, lowerRise 1.5·tan40, activeRh = lowerRise/0.6
  const lowerRise = 1.5 * Math.tan(theta)
  const activeRh = lowerRise / 0.6
  const upperRise = activeRh - lowerRise
  const phi = Math.atan2(upperRise, 1.5)
  const baseY = roof.position[1] + roof.wallHeight

  test('each station gets a steep lower and a shallow upper rafter per side', () => {
    const lowers = byRole(members, 'rafter').filter((r) => r.label?.includes('lower'))
    const uppers = byRole(members, 'rafter').filter((r) => r.label?.includes('upper'))
    expect(lowers.length).toBeGreaterThan(0)
    expect(lowers.length).toBe(uppers.length)
    expect((lowers[0] as Member).rotation[2]).toBeCloseTo(theta, 6)
    expect((uppers[0] as Member).rotation[2]).toBeCloseTo(phi, 6)
    // spans purlin FACE → ridge FACE with inscribed plumb cuts (round-14):
    // plan run loses gRt/2 at each end; slope length loses 2·(rd/2)·tanφ.
    const gRt = 1.5 * 0.0254
    const rd26 = 5.5 * 0.0254
    const planRun = 1.5 - gRt
    const rise2 = upperRise * (planRun / 1.5)
    const inset = (rd26 / 2) * (upperRise / 1.5)
    expect((uppers[0] as Member).length).toBeCloseTo(Math.hypot(planRun, rise2) - 2 * inset, 5)
  })

  test('ridge at the derived peak; purlins at both kinks', () => {
    const ridges = byRole(members, 'ridge')
    const ridge = ridges.find((r) => !r.label?.includes('Purlin')) as Member
    const rdd = 7.25 * 0.0254
    expect(ridge.position[1]).toBeCloseTo(baseY + activeRh - rdd / 2, 5)
    const purlins = ridges.filter((r) => r.label?.includes('Purlin'))
    expect(purlins).toHaveLength(2)
    for (const p of purlins) {
      expect(Math.abs(p.position[2] as number)).toBeCloseTo(1.5, 5) // kink plan line
      expect(p.position[1]).toBeCloseTo(baseY + lowerRise - rdd / 2, 5)
    }
  })
})

describe('frameRoofs — mansard (skirt + shallow hip top)', () => {
  const roof = seg({ roofType: 'mansard' })
  const members = frameRoofs([roof], [], DEFAULT_SPEC)
  // host math: inset = 6·0.15 = 0.9, skirtRise = 0.9·tan40, activeRh = rise/0.7
  const inset = 0.9
  const skirtRise = inset * Math.tan(roof.pitch)
  const baseY = roof.position[1] + roof.wallHeight

  test('steep skirt rafters ring all four faces at the schema pitch', () => {
    const skirt = byRole(members, 'rafter').filter((r) => r.label?.includes('Mansard skirt'))
    expect(skirt.length).toBeGreaterThanOrEqual(20)
    for (const s of skirt) expect(s.rotation[2]).toBeCloseTo(roof.pitch, 6)
  })

  test('eight hips: four skirt arrises + four on the shallow top', () => {
    const hips = byRole(members, 'hip')
    expect(hips).toHaveLength(8)
    const arris = hips.filter((h) => h.label?.includes('arris'))
    expect(arris).toHaveLength(4)
  })

  test('upper deck is a hip over the inset rectangle at the derived pitch', () => {
    // inner: 6.2 × 4.2, run 2.1 → ridge length 2; upper rise = activeRh − skirtRise
    const ridge = byRole(members, 'ridge')[0] as Member
    expect(ridge.length).toBeCloseTo(6.2 - 2 * 2.1, 4)
    const upperRise = skirtRise / 0.7 - skirtRise
    const rdd = 7.25 * 0.0254
    expect(ridge.position[1]).toBeCloseTo(baseY + skirtRise + upperRise - rdd / 2, 5)
  })
})

describe('frameRoofs — dutch gable (hip skirt + gablet)', () => {
  const roof = seg({ roofType: 'dutch' })
  const members = frameRoofs([roof], [], DEFAULT_SPEC)
  // host metrics: inset = 6·0.25 = 1.5, waistHalfX = (4−1.5)·0.98 = 2.45,
  // waistHalfZ = 1.5, skirtRise = 1.5·tan40, activeRh = skirtRise/0.5
  const skirtRise = 1.5 * Math.tan(roof.pitch)
  const baseY = roof.position[1] + roof.wallHeight

  test('gablet ridge spans the waist at the full derived peak', () => {
    const ridge = byRole(members, 'ridge')[0] as Member
    expect(ridge.length).toBeCloseTo(2 * 2.45, 4)
    const rdd = 7.25 * 0.0254
    expect(ridge.position[1]).toBeCloseTo(baseY + 2 * skirtRise - rdd / 2, 5)
    expect(longAxis(ridge).x).toBeCloseTo(1, 5) // along the long axis
  })

  test('skirt + gablet rafters both present; long-face skirt at the schema pitch', () => {
    const skirt = byRole(members, 'rafter').filter((r) => r.label?.includes('Dutch skirt'))
    expect(skirt.length).toBeGreaterThan(0)
    // the ±Z (long) faces carry the schema pitch; the end faces are slightly
    // shallower because the 0.98 waist ratio stretches their run
    const longFaces = skirt.filter((s) => Math.abs(longAxis(s).x) < 0.1)
    expect(longFaces.length).toBeGreaterThan(0)
    for (const s of longFaces) expect(s.rotation[2]).toBeCloseTo(roof.pitch, 6)
    // gablet commons (default ratios make the gablet pitch = the schema pitch)
    const gablet = byRole(members, 'rafter').filter((r) => !r.label?.includes('skirt'))
    expect(gablet.length).toBeGreaterThan(0)
  })
})

describe('frameRoofs — valleys where two gables cross (LOD 350)', () => {
  const major = seg() // 8 × 6, ridge on X, run 3
  const minor = seg({
    id: 'roofseg_wing',
    width: 4,
    depth: 4,
    yaw: Math.PI / 2, // ridge on level Z — perpendicular
    position: [1, 2.5, 4], // crosses the major +Z eave (z = 3)
  })
  const members = frameRoofs([major, minor], [], DEFAULT_SPEC)
  const valleys = byRole(members, 'valley')
  const theta = major.pitch
  const rise2 = 2 * Math.tan(theta)

  test('exactly two valleys, one each side of the wing ridge', () => {
    expect(valleys).toHaveLength(2)
  })

  test('numeric endpoints: eave foot → ridge-pierce apex (45° plan for equal pitch)', () => {
    const baseY = 2.5 + 0.5
    for (const v of valleys) {
      const axis = longAxis(v)
      const e1 = new Vector3(...v.position).add(axis.clone().multiplyScalar(v.length / 2))
      const e2 = new Vector3(...v.position).sub(axis.clone().multiplyScalar(v.length / 2))
      const apex = e1.y > e2.y ? e1 : e2
      const foot = e1.y > e2.y ? e2 : e1
      expect(apex.x).toBeCloseTo(1, 5) // wing centerline
      expect(apex.y).toBeCloseTo(baseY + rise2, 5)
      expect(apex.z).toBeCloseTo(1, 5) // run1 − rise2/tanθ = 3 − 2
      expect(foot.y).toBeCloseTo(baseY, 5)
      expect(foot.z).toBeCloseTo(3, 5) // the major eave line
      expect(Math.abs(foot.x - 1)).toBeCloseTo(2, 5) // ± the wing run
      // equal pitches → 45° in plan
      expect(Math.abs(apex.z - foot.z)).toBeCloseTo(Math.abs(apex.x - foot.x), 5)
    }
  })

  test('parallel or distant segments produce no valleys', () => {
    const parallel = seg({ id: 'p', position: [0, 2.5, 8] })
    expect(byRole(frameRoofs([major, parallel], [], DEFAULT_SPEC), 'valley')).toHaveLength(0)
  })
})

describe('frameRoofs — rake framing + fascia (LOD 350/400)', () => {
  const roof = seg()

  test('outlookers ladder both rakes at 4ft; barge rafters carry the edges', () => {
    const members = frameRoofs([roof], [], DEFAULT_SPEC)
    const outlookers = byRole(members, 'outlooker')
    expect(outlookers.length).toBeGreaterThanOrEqual(8) // ≥2 per slope per end
    const theta = roof.pitch
    for (const o of outlookers) {
      // Rolled INTO the roof plane about the long axis (yaw 0 → euler
      // [±θ, 0, 0]) — a horizontal box crossed the sloped plane, and the
      // ladder now stops at the barge's inner face (round-10 gate).
      expect(Math.abs(o.rotation[0] ?? 0)).toBeCloseTo(theta, 6)
      expect(o.rotation[1]).toBeCloseTo(0, 6)
      expect(o.rotation[2]).toBeCloseTo(0, 6)
      // ladders derive from ACTUAL rafter positions per side (round-14:
      // layout snugs the tail rafter, so the two rakes differ slightly)
      expect(o.length).toBeGreaterThan(0.3)
      expect(o.length).toBeLessThan(0.3 + 2 * DEFAULT_SPEC.rafterSpacing)
    }
    const barges = byRole(members, 'rafter').filter((r) => r.label?.includes('Barge'))
    expect(barges).toHaveLength(4)
    for (const b of barges) {
      expect(Math.abs(b.position[0] as number)).toBeCloseTo(4 + 0.3, 5)
    }
  })

  test('LOD 200 has no rake framing; tiny overhangs need none', () => {
    expect(byRole(frameRoofs([roof], [], { ...DEFAULT_SPEC, detail: '200' }), 'outlooker')).toHaveLength(0)
    expect(byRole(frameRoofs([seg({ overhang: 0.05 })], [], DEFAULT_SPEC), 'outlooker')).toHaveLength(0)
  })

  test('fascia at 400 only: sub + FINISH pairs — 4 on a gable, 8 around a hip', () => {
    expect(byRole(frameRoofs([roof], [], DEFAULT_SPEC), 'fascia')).toHaveLength(0)
    const at400 = frameRoofs([roof], [], { ...DEFAULT_SPEC, detail: '400' })
    const gableFascia = byRole(at400, 'fascia')
    expect(gableFascia).toHaveLength(4) // 2 eaves × (sub + finish)
    const subs = gableFascia.filter((f) => f.label?.includes('Sub-fascia'))
    const finish = gableFascia.filter((f) => f.label?.includes('finish'))
    expect(subs).toHaveLength(2)
    expect(finish).toHaveLength(2)
    expect((subs[0] as Member).length).toBeCloseTo(8.6, 5)
    // the finish 1x8 sits proud of the sub's face: (1.5" + 0.75")/2 outward
    const sub = subs.find((f) => (f.position[2] as number) > 0) as Member
    const fin = finish.find((f) => (f.position[2] as number) > 0) as Member
    const proud = ((1.5 + 0.75) / 2) * 0.0254
    expect((fin.position[2] as number) - (sub.position[2] as number)).toBeCloseTo(proud, 6)
    expect(fin.dims[1]).toBeCloseTo(7.25 * 0.0254, 6) // 1x8 face
    expect(fin.dims[2]).toBeCloseTo(0.75 * 0.0254, 6)
    const hip400 = frameRoofs([seg({ roofType: 'hip' })], [], { ...DEFAULT_SPEC, detail: '400' })
    expect(byRole(hip400, 'fascia')).toHaveLength(8)
  })
})

describe('frameRoofs — spec-driven sizing + cut data (LOD 400)', () => {
  test('a snow-bumped 2x10 spec sizes every rafter and deepens the ridge', () => {
    const members = frameRoofs([seg()], [], { ...DEFAULT_SPEC, rafterSize: '2x10' })
    const rafters = byRole(members, 'rafter')
    expect(rafters.length).toBeGreaterThan(0)
    for (const r of rafters) expect(r.size).toBe('2x10')
    expect((byRole(members, 'ridge')[0] as Member).size).toBe('2x12')
  })

  test('400 labels carry plumb cut, birdsmouth seat, and HAP; ties distinguished', () => {
    const at400 = frameRoofs([seg()], [], { ...DEFAULT_SPEC, detail: '400' })
    const rafter = byRole(at400, 'rafter').find((r) => !r.label?.includes('Barge')) as Member
    expect(rafter.label).toContain('plumb cut 40°')
    // 40° on a 2x6: the R802.7.1 d/4 cap governs the seat. Numeric pin:
    // seat = (5.5/4)/tan40° = 1.64"; HAP = 5.5/cos40° − seat·tan40° = 5.8".
    expect(rafter.label).toContain('birdsmouth seat 1.64"')
    expect(rafter.label).toContain('HAP 5.8"')
    const cj = byRole(at400, 'ceiling-joist')[0] as Member
    expect(cj.label).toContain('rafter tie (R802.4.2)')
    const collar = byRole(at400, 'collar-tie')[0] as Member
    expect(collar.label).toContain('Collar tie')
    // 300 keeps the labels clean
    const at300 = frameRoofs([seg()], [], DEFAULT_SPEC)
    expect((byRole(at300, 'rafter')[0] as Member).label).not.toContain('HAP')
  })

  test('birdsmouth seat: full 3½" plate on shallow pitches, d/4-capped on steep (R802.7.1)', () => {
    const d26 = 5.5 * 0.0254
    // 15° on a 2x6: (d/4)/tanθ = 5.13" > 3.5" — the plate governs.
    expect(birdsmouthSeat((15 * Math.PI) / 180, d26)).toBeCloseTo(3.5 * 0.0254, 6)
    // Steep pitches: the vertical bite seat·tanθ never exceeds d/4.
    for (const deg of [22, 30, 40, 50, 60]) {
      const theta = (deg * Math.PI) / 180
      const seat = birdsmouthSeat(theta, d26)
      expect(seat * Math.tan(theta)).toBeLessThanOrEqual(d26 / 4 + 1e-12)
      expect(seat).toBeGreaterThan(0)
    }
    // Continuity at the crossover (~21.5° for a 2x6): cap ≈ plate.
    const cross = Math.atan(d26 / 4 / (3.5 * 0.0254))
    expect(birdsmouthSeat(cross, d26)).toBeCloseTo(3.5 * 0.0254, 6)
  })
})

describe('frameRoofs — valley jacks land on the valley (round-2 gap)', () => {
  const major = seg() // 8 × 6, ridge on X, run 3
  const minor = seg({
    id: 'roofseg_wing',
    width: 4,
    depth: 4,
    yaw: Math.PI / 2,
    position: [1, 2.5, 4],
  })
  const members = frameRoofs([major, minor], [], DEFAULT_SPEC)
  const jacks = byRole(members, 'jack-rafter').filter((j) => j.label?.includes('Valley jack'))
  const baseY = 2.5 + 0.5
  const rise2 = 2 * Math.tan(major.pitch)

  test('jacks exist on both sides of the wing ridge, top on the ridge, bottom ON the valley', () => {
    expect(jacks.length).toBeGreaterThanOrEqual(4)
    for (const j of jacks) {
      const axis = longAxis(j)
      const e1 = new Vector3(...j.position).add(axis.clone().multiplyScalar(j.length / 2))
      const e2 = new Vector3(...j.position).sub(axis.clone().multiplyScalar(j.length / 2))
      const top = e1.y > e2.y ? e1 : e2
      const bot = e1.y > e2.y ? e2 : e1
      // top on the wing ridge line (x = 1 at the wing ridge height)
      expect(top.x).toBeCloseTo(1, 5)
      expect(top.y).toBeCloseTo(baseY + rise2, 5)
      // bottom on the valley: the valley plan line runs 45° from the apex
      // (1, 1) to the foot (3, 3) — x-offset from the wing ridge = z − z*
      expect(Math.abs(bot.x - 1)).toBeCloseTo(bot.z - 1, 4)
      // and on the major slope plane: y = eave + (run1 − z)·tanθ
      expect(bot.y).toBeCloseTo(baseY + (3 - bot.z) * Math.tan(major.pitch), 4)
    }
  })

  test('jacks shorten toward the apex', () => {
    const bySide = jacks.filter((j) => (j.position[0] as number) > 1)
    const sorted = bySide.sort((a, b) => (a.position[2] as number) - (b.position[2] as number))
    for (let i = 1; i < sorted.length; i++) {
      expect((sorted[i] as Member).length).toBeGreaterThan((sorted[i - 1] as Member).length)
    }
  })
})

describe('frameRoofs — hip jacks carry hurricane ties in high-wind specs', () => {
  test('every bearing rafter on a hip (commons, kings, jacks) gets a tie', () => {
    const windy = frameRoofs([seg({ roofType: 'hip' })], [], {
      ...DEFAULT_SPEC,
      hurricaneTies: true,
    })
    const ties = windy.filter((m) => m.label === 'hurricane tie')
    const bearing =
      byRole(windy, 'rafter').length + byRole(windy, 'jack-rafter').length
    expect(ties.length).toBe(bearing)
  })
})

describe('frameRoofs — 400 cut-angle labels are pinned (round-3: deletable text)', () => {
  const at400 = { ...DEFAULT_SPEC, detail: '400' as const }

  test('hip carries plumb + 45° side cuts; ridge lists the rafter plumb cut', () => {
    const members = frameRoofs([seg({ roofType: 'hip' })], [], at400)
    const hip = byRole(members, 'hip')[0] as Member
    expect(hip.label).toContain('side cuts 45°')
    expect(hip.label).toMatch(/plumb \d+°/)
    const ridge = byRole(members, 'ridge')[0] as Member
    expect(ridge.label).toContain('rafter plumb cuts 40°')
  })

  test('valley + valley jacks carry their cheek-cut call-outs', () => {
    const major = seg()
    const minor = seg({ id: 'wing', width: 4, depth: 4, yaw: Math.PI / 2, position: [1, 2.5, 4] })
    const members = frameRoofs([major, minor], [], at400)
    const valley = byRole(members, 'valley')[0] as Member
    expect(valley.label).toContain('cheek cuts 45°')
    expect(valley.label).toMatch(/plumb \d+°/)
    const vjack = byRole(members, 'jack-rafter').find((j) => j.label?.includes('Valley jack')) as Member
    expect(vjack.label).toContain('cheek 45°')
  })

  test('at 300 the fabrication cut data stays out of the labels', () => {
    const members = frameRoofs([seg({ roofType: 'hip' })], [], DEFAULT_SPEC)
    expect((byRole(members, 'hip')[0] as Member).label).not.toContain('side cuts')
    expect((byRole(members, 'ridge')[0] as Member).label).not.toContain('plumb')
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B6a: roof deck on every slope plane (R803.2)
// ---------------------------------------------------------------------------

describe('LOD-400 B6a: roof deck panels per slope plane (R803.2)', () => {
  const IN = 0.0254
  const DECK_T = (7 / 16) * IN
  const RD = 5.5 * IN // DEFAULT_SPEC 2x6 rafter depth
  const deckOf = (members: Member[]) =>
    members.filter((m) => m.role === 'sheathing' && m.system === 'roof-framing')
  const areaOf = (members: Member[]) =>
    deckOf(members).reduce((s, m) => s + m.dims[0] * m.dims[2], 0)

  test('gable: one full panel per slope, area ≈ 2 slope planes (ridge-vent/eave seams only)', () => {
    const roof = seg() // 8 × 6 @ 40°, 0.3 overhang (rake framed)
    const members = frameRoofs([roof], [], DEFAULT_SPEC)
    const deck = deckOf(members)
    expect(deck).toHaveLength(2)
    const cosT = Math.cos(roof.pitch)
    const plane =
      (roof.width + 2 * roof.overhang) * (roof.depth / 2 / cosT + roof.overhang)
    const ratio = areaOf(members) / (2 * plane)
    expect(ratio).toBeGreaterThan(0.99) // only the mm-scale edge seams missing
    expect(ratio).toBeLessThanOrEqual(1)
    for (const m of deck) expect(m.label).toContain('R803.2')
    expect(deck[0]?.material).toBe('engineered')
  })

  test('deck panels ride the rafter TOP faces: normal offset from the centerline plane = rd/2 + t/2', () => {
    const roof = seg()
    const members = frameRoofs([roof], [], DEFAULT_SPEC)
    const apex = new Vector3(
      roof.position[0],
      roof.position[1] + roof.wallHeight + (roof.depth / 2) * Math.tan(roof.pitch),
      roof.position[2],
    )
    for (const m of deckOf(members)) {
      const [rx, ry, rz] = m.rotation
      const n = new Vector3(0, 1, 0).applyEuler(new Euler(rx, ry, rz, 'XYZ'))
      // plane normal: (0, cosθ, ±sinθ)
      expect(n.y).toBeCloseTo(Math.cos(roof.pitch), 6)
      expect(Math.abs(n.z)).toBeCloseTo(Math.sin(roof.pitch), 6)
      // the apex (ridge line) lies ON the rafter-centerline plane; the deck
      // center sits exactly one half rafter + half deck up the normal
      const d = new Vector3(...m.position).sub(apex).dot(n)
      expect(d).toBeCloseTo(RD / 2 + DECK_T / 2, 6)
    }
  })

  test('shed: one panel covering the full slope', () => {
    const roof = seg({ roofType: 'shed' })
    const members = frameRoofs([roof], [], DEFAULT_SPEC)
    const deck = deckOf(members)
    expect(deck).toHaveLength(1)
    const slopeLen = roof.depth / Math.cos(roof.pitch) + 2 * roof.overhang
    const ratio = areaOf(members) / (roof.width * slopeLen)
    expect(ratio).toBeGreaterThan(0.99)
    expect(ratio).toBeLessThanOrEqual(1)
  })

  // DERIVED under-tile floor for uphill-width strip tiling (F2 — never a
  // magic number): each tapered edge loses (Δ/2 + clear)·R (∫ of the
  // per-strip wedge, taper slope 1); a hip has 8 tapered edges. A final
  // partial strip below DECK_MIN vanishes whole: ≤ (MIN·cosθ + 4·gap) of
  // plan height across each plane's eave width (also covers the drawn
  // strips' ridge/eave gap trims). End-plane apexes skip ≤ their first
  // strip (≤ 2·Δ² each). Everything /cosθ into slope area.
  const hipFloor = (w: number, d: number, pitchDeg: number, o: number): { floor: number; planes: number } => {
    const th = (pitchDeg * Math.PI) / 180
    const cosT = Math.cos(th)
    const run = Math.min(w, d) / 2
    const rh = Math.max(w, d) / 2 - run
    const R = run + o * cosT
    const planes = (2 * (2 * rh + R) * R + 2 * R * R) / cosT
    const D = 0.4 // DECK_STRIP
    const C = 0.02 // DECK_CLEAR
    const MIN = 0.1 // DECK_MIN
    const gap = (((7 / 16) * IN) / 2) * Math.sin(th) + 0.002 // deckGap
    const edgeLoss = (8 * (D / 2 + C) * R) / cosT
    const eaveWidths = 2 * 2 * (rh + R) + 2 * 2 * R
    const tailSeamLoss = ((MIN * cosT + 4 * gap) * eaveWidths) / cosT
    const apexLoss = (4 * D * D) / cosT
    return { floor: Math.max(0, 1 - (edgeLoss + tailSeamLoss + apexLoss) / planes), planes }
  }

  test('hip: strip coverage ≥ the DERIVED floor, never past the plane, EXACT pct on the label', () => {
    // incl. the round-1 examiner counter-example (5×4 @ 30° booked 84.4%
    // under the old 85% magic floor) and a spread of aspects/pitches
    for (const [w, d, p] of [[10, 8, 40], [5, 4, 30], [16, 10, 25], [6, 6, 60]] as const) {
      const roof = seg({ roofType: 'hip', width: w, depth: d, pitch: (p * Math.PI) / 180 })
      const members = frameRoofs([roof], [], DEFAULT_SPEC)
      const deck = areaOf(members)
      const { floor, planes } = hipFloor(w, d, p, roof.overhang)
      expect({ w, d, p, above: deck >= floor * planes }).toEqual({ w, d, p, above: true })
      expect(deck).toBeLessThan(planes) // strips stay INSIDE the hip lines
      // F2: the label states the EXACT coverage of THIS compose — 'slight
      // under-tile' prose is gone
      const pct = Math.round((deck / planes) * 1000) / 10
      for (const m of deckOf(members)) {
        expect(m.label).toContain(`conservative under-tile, ${pct.toFixed(1)}% of plane area`)
        expect(m.label).toContain('trim to hip lines on site')
      }
    }
    // both plane families present (long faces + triangular end faces)
    const members = frameRoofs([seg({ roofType: 'hip', width: 10, depth: 8 })], [], DEFAULT_SPEC)
    const yaws = new Set(deckOf(members).map((m) => m.rotation[1].toFixed(2)))
    expect(yaws.size).toBeGreaterThan(1)
  })

  test('F2: the takeoff deck row states the under-tile beside the buy quantity', () => {
    const members = frameRoofs([seg({ roofType: 'hip', width: 5, depth: 4, pitch: (30 * Math.PI) / 180 })], [], DEFAULT_SPEC)
    const rows = computeTakeoff(members, [])
    const row = rows.find((r) => r.item === 'Roof sheathing 7/16" WSP')
    expect(row?.detail).toContain('conservatively under-tiled')
    expect(row?.detail).toContain('buy waste factor separately')
    // …and a rect-plane roof (full coverage) carries NO waste note
    const gable = frameRoofs([seg()], [], DEFAULT_SPEC)
    const gRow = computeTakeoff(gable, []).find((r) => r.item === 'Roof sheathing 7/16" WSP')
    expect(gRow?.detail).not.toContain('under-tiled')
  })

  test('flat: one dead-level panel over the platform, on the joist tops', () => {
    const roof = seg({ roofType: 'flat' })
    const members = frameRoofs([roof], [], DEFAULT_SPEC)
    const deck = deckOf(members)
    expect(deck).toHaveLength(1)
    const halfW = roof.width / 2 + roof.overhang
    const halfD = roof.depth / 2 + roof.overhang
    expect(areaOf(members)).toBeCloseTo(4 * halfW * halfD, 6)
    expect(deck[0]?.position[1]).toBeCloseTo(
      roof.position[1] + roof.wallHeight + RD + DECK_T / 2,
      6,
    )
  })

  test('gambrel: four panels (steep + shallow per side), exact plane areas', () => {
    const roof = seg({ roofType: 'gambrel' })
    const members = frameRoofs([roof], [], DEFAULT_SPEC)
    const deck = deckOf(members)
    expect(deck).toHaveLength(4)
    const theta = roof.pitch
    const run = roof.depth / 2
    const lowerRun = run * 0.5 // host default wr
    const lowerRise = lowerRun * Math.tan(theta)
    const upperRun = run - lowerRun
    const upperRise = lowerRise / 0.6 - lowerRise // host default hr
    const phi = Math.atan2(upperRise, upperRun)
    const breakZ = upperRun
    const lower =
      roof.width * ((run + roof.overhang * Math.cos(theta) - breakZ) / Math.cos(theta))
    const upper = roof.width * (breakZ / Math.cos(phi))
    const ratio = areaOf(members) / (2 * (lower + upper))
    expect(ratio).toBeGreaterThan(0.98) // kink/ridge/eave seams only
    expect(ratio).toBeLessThanOrEqual(1)
  })

  test('mansard + dutch: skirt planes strip-tiled and the inner shapes deck too', () => {
    // Area gate is presence + bounded (skirt geometry is tapered on both
    // families — the exact-area check stays with the rectangular shapes).
    for (const roofType of ['mansard', 'dutch'] as const) {
      const roof = seg({ roofType, width: 10, depth: 8 })
      const members = frameRoofs([roof], [], DEFAULT_SPEC)
      const deck = deckOf(members)
      expect(deck.length).toBeGreaterThan(4)
      // skirt strips carry the under-tile note; the inner hip/gablet panels
      // prove the recursion decks the upper shape as well
      expect(deck.some((m) => m.label?.includes('arris'))).toBe(true)
      expect(deck.some((m) => !m.label?.includes('arris'))).toBe(true)
    }
  })

  test('LOD 200 emits no deck', () => {
    const members = frameRoofs(
      [seg(), seg({ id: 'h', roofType: 'hip', position: [30, 2.5, 0] })],
      [],
      { ...DEFAULT_SPEC, detail: '200' },
    )
    expect(deckOf(members)).toHaveLength(0)
  })

  test('valley MINOR deck carries the overlay trim FLAG (prints in the Flags block); the major stays clean', () => {
    const major = seg()
    const minor = seg({ id: 'roofseg_wing', width: 4, depth: 4, yaw: Math.PI / 2, position: [1, 2.5, 4] })
    const members = frameRoofs([major, minor], [], DEFAULT_SPEC)
    const minorDeck = deckOf(members).filter((m) => m.sourceId === 'roofseg_wing')
    const majorDeck = deckOf(members).filter((m) => m.sourceId === major.id)
    expect(minorDeck.length).toBeGreaterThan(0)
    // FLAG, not a label suffix — round-1 examiner F3: the label note never
    // printed anywhere across 13 sheets. Flags reach the takeoff Flags rows
    // and the schedules flag block.
    for (const m of minorDeck) {
      expect(m.flag).toContain('trim to the valley line')
      expect(m.label).not.toContain('valley overlay')
    }
    for (const m of majorDeck) expect(m.flag ?? '').not.toContain('valley')
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B6b: underlayment membrane 1:1 on the deck (R905.1.1)
// ---------------------------------------------------------------------------

describe('LOD-400 B6b: underlayment rides every deck panel 1:1 (R905.1.1)', () => {
  const IN = 0.0254
  const DECK_T = (7 / 16) * IN
  const shapes = ['gable', 'shed', 'hip', 'flat', 'gambrel', 'mansard', 'dutch'] as const

  test('every shape: one membrane per deck panel, same area, one deck-thickness up the plane normal', () => {
    for (const roofType of shapes) {
      const members = frameRoofs([seg({ roofType, width: 10, depth: 8 })], [], DEFAULT_SPEC)
      const deck = members.filter((m) => m.role === 'sheathing')
      const membrane = members.filter((m) => m.role === 'wrb')
      expect({ roofType, n: membrane.length }).toEqual({ roofType, n: deck.length })
      expect(deck.length).toBeGreaterThan(0)
      // deckPlane emits the pair back-to-back — pair by order
      deck.forEach((d, i) => {
        const u = membrane[i] as Member
        expect(u.dims[0]).toBeCloseTo(d.dims[0], 9)
        expect(u.dims[2]).toBeCloseTo(d.dims[2], 9)
        // the membrane sits (deck/2 + membrane/2) further UP the deck's own
        // normal — "mind the roof orientation": the offset follows the
        // plane, not world Y
        const [rx, ry, rz] = d.rotation
        const n = new Vector3(0, 1, 0).applyEuler(new Euler(rx, ry, rz, 'XYZ'))
        const delta = new Vector3(...u.position).sub(new Vector3(...d.position))
        expect(delta.dot(n)).toBeCloseTo(DECK_T / 2 + 0.001, 6)
        // the stack advances PLUMB (identical plan cover band — the
        // in-plane slide convention): delta is vertical, Δy = Δup/cosθ,
        // and cosθ is the deck normal's own y — orientation-derived
        expect(delta.x).toBeCloseTo(0, 9)
        expect(delta.z).toBeCloseTo(0, 9)
        expect(delta.y).toBeCloseTo((DECK_T / 2 + 0.001) / n.y, 6)
      })
    }
  })

  test('the top membrane carries the assumption-label contract (covering stays HOST cosmetic)', () => {
    const members = frameRoofs([seg()], [], DEFAULT_SPEC)
    const membrane = members.filter((m) => m.role === 'wrb')
    for (const u of membrane) {
      expect(u.label).toContain('R905.1.1')
      expect(u.label).toContain('covering by finish schedule — not booked')
    }
  })

  test('LOD 200 emits no membrane; valley minors carry the overlay FLAG on the membrane too', () => {
    expect(
      frameRoofs([seg()], [], { ...DEFAULT_SPEC, detail: '200' }).filter((m) => m.role === 'wrb'),
    ).toHaveLength(0)
    const major = seg()
    const minor = seg({ id: 'roofseg_wing', width: 4, depth: 4, yaw: Math.PI / 2, position: [1, 2.5, 4] })
    const members = frameRoofs([major, minor], [], DEFAULT_SPEC)
    const wingMembrane = members.filter((m) => m.role === 'wrb' && m.sourceId === 'roofseg_wing')
    expect(wingMembrane.length).toBeGreaterThan(0)
    for (const u of wingMembrane) expect(u.flag).toContain('trim to the valley line')
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B6c: drip edge at eaves + rakes (R905.2.8.5)
// ---------------------------------------------------------------------------

describe('LOD-400 B6c: drip edge members at eaves + rakes (R905.2.8.5)', () => {
  const at400 = { ...DEFAULT_SPEC, detail: '400' as const }
  const dripOf = (members: Member[]) => members.filter((m) => m.role === 'drip-edge')

  test('gable: 2 eave runs cap the fascia + 4 rake runs ride the barges', () => {
    const roof = seg()
    const drips = dripOf(frameRoofs([roof], [], at400))
    const eaves = drips.filter((m) => m.label?.includes('eave'))
    const rakes = drips.filter((m) => m.label?.includes('rake'))
    expect(eaves).toHaveLength(2)
    expect(rakes).toHaveLength(4)
    for (const e of eaves) expect(e.length).toBeCloseTo(roof.width + 2 * roof.overhang, 6)
    const t = 1.5 * 0.0254 // rafter/barge thickness
    for (const r of rakes) {
      // rake drip length == the barge slope length
      const barge = frameRoofs([roof], [], at400).find((m) => m.label?.includes('Barge'))
      expect(r.length).toBeCloseTo((barge as Member).length, 6)
      // outer edge FLUSH with the barge outer face (F1b: trim must never
      // grow the plan envelope / the shared sheet transform)
      expect(Math.abs(r.position[0]) + r.dims[2] / 2).toBeCloseTo(
        roof.width / 2 + roof.overhang + t / 2,
        6,
      )
    }
    for (const d of drips) {
      expect(d.material).toBe('steel')
      expect(d.system).toBe('roof-framing')
      expect(d.label).toContain('R905.2.8.5')
    }
  })

  test('per-shape counts: hip/mansard/dutch cap 4 fascia eaves, gambrel 2, flat 4 perimeter', () => {
    const count = (roofType: string) =>
      dripOf(frameRoofs([seg({ roofType, width: 10, depth: 8 })], [], at400)).length
    expect(count('hip')).toBe(4)
    expect(count('mansard')).toBe(4)
    expect(count('dutch')).toBe(4)
    expect(count('gambrel')).toBe(2) // rakes unframed on gambrel ends (B8d) — stated
    expect(count('flat')).toBe(4)
  })

  test('LOD 300 books none (trim class, the fascia convention)', () => {
    expect(dripOf(frameRoofs([seg()], [], DEFAULT_SPEC))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// B6 fix round F3/F4: stated gaps live ON PAPER (flags), never only in prose
// ---------------------------------------------------------------------------

describe('B6 fix round: trim gaps are flagged members, not commit-message asides (F3/F4)', () => {
  const at400 = { ...DEFAULT_SPEC, detail: '400' as const }

  test('shed at 400: ZERO drip edge is pinned AND stated as a deck flag', () => {
    const members = frameRoofs([seg({ roofType: 'shed' })], [], at400)
    expect(members.filter((m) => m.role === 'drip-edge')).toHaveLength(0)
    const deck = members.filter((m) => m.role === 'sheathing')
    expect(deck).toHaveLength(1)
    expect(deck[0]?.flag).toContain('fascia + drip edge not modeled')
    expect(deck[0]?.flag).toContain('R905.2.8.5')
  })

  test('gambrel at 400: rake-metal gap flagged on the deck panels (B8d follow-up)', () => {
    const members = frameRoofs([seg({ roofType: 'gambrel' })], [], at400)
    const deck = members.filter((m) => m.role === 'sheathing')
    expect(deck.length).toBeGreaterThan(0)
    for (const d of deck) expect(d.flag).toContain('rake framing + rake drip edge not modeled')
  })

  test('gable/hip at 400 carry NO trim-gap flag (their drip edge is real); 300 stays quiet everywhere', () => {
    for (const roofType of ['gable', 'hip'] as const) {
      const deck = frameRoofs([seg({ roofType })], [], at400).filter((m) => m.role === 'sheathing')
      for (const d of deck) expect(d.flag ?? '').not.toContain('drip edge not modeled')
    }
    for (const roofType of ['shed', 'gambrel'] as const) {
      const deck = frameRoofs([seg({ roofType })], [], DEFAULT_SPEC).filter((m) => m.role === 'sheathing')
      for (const d of deck) expect(d.flag).toBeUndefined()
    }
  })

  test('the valley overlay flag reaches the takeoff Flags section', () => {
    const major = seg()
    const minor = seg({ id: 'roofseg_wing', width: 4, depth: 4, yaw: Math.PI / 2, position: [1, 2.5, 4] })
    const members = frameRoofs([major, minor], [], DEFAULT_SPEC)
    const rows = computeTakeoff(members, [])
    const row = rows.find((r) => r.section === 'Flags' && r.detail.includes('trim to the valley line'))
    expect(row).toBeDefined()
    expect(row?.quantity).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B7a: hip ceiling joists — the R802.4.2 thrust path
// ---------------------------------------------------------------------------

describe('LOD-400 B7a: hip ceiling joists across the short span (R802.4.2)', () => {
  const IN = 0.0254
  const T = 1.5 * IN
  const RD = 5.5 * IN // 2x6 rafter depth
  const CJ_D = 5.5 * IN // 2x6 ceiling joist depth
  const cjOf = (members: Member[]) => byRole(members, 'ceiling-joist')

  // The audit repro: hip 10×12 @ 40° emitted 12 commons + 4 hips + 64 jacks
  // + 76 hurricane ties and ZERO ceiling-joist/rafter-tie/collar-tie members
  // — a non-structural ridge board with unresisted thrust and no ceiling
  // frame for the storey below.
  const roof = seg({ roofType: 'hip', width: 10, depth: 12 })
  const theta = roof.pitch
  const at400 = { ...DEFAULT_SPEC, detail: '400' as const }
  const members = frameRoofs([roof], [], at400)
  const cjs = cjOf(members)
  const baseY = roof.position[1] + roof.wallHeight

  test('audit repro census: joists present at a sane count vs span/spacing', () => {
    // stations at 16" o.c. along the long axis, band pulled off the end
    // planes: 2·(longHalf − cjEndClear)/spacing ± the layout end snap
    const cjEndClear = (CJ_D + RD / (2 * Math.cos(theta))) / Math.tan(theta) + T + 0.002
    const bandHalf = 6 - cjEndClear
    const floor = Math.floor((2 * bandHalf) / DEFAULT_SPEC.ceilingJoistSpacing) - 1
    expect(cjs.length).toBeGreaterThanOrEqual(floor)
    expect(cjs.length).toBeLessThanOrEqual(floor + 4)
    // and every station stays inside the band (the end triangles carry no
    // full-span joist — their stub ceiling rides the follow-up)
    for (const cj of cjs) {
      expect(Math.abs(cj.position[2] as number)).toBeLessThanOrEqual(bandHalf + 1e-9)
    }
  })

  test('joists span the SHORT axis at the eave line, ends inscribed in the B6 clip', () => {
    // width 10 < depth 12 → joists run along X (the commons span direction)
    const clip = (CJ_D - RD / (2 * Math.cos(theta))) / Math.tan(theta) + 0.002
    for (const cj of cjs) {
      const axis = longAxis(cj)
      expect(Math.abs(axis.x)).toBeCloseTo(1, 5)
      expect(cj.length).toBeCloseTo(10 - 2 * clip, 6)
      expect(cj.position[1]).toBeCloseTo(baseY + CJ_D / 2, 6)
      expect(cj.position[0]).toBeCloseTo(0, 6)
    }
  })

  test('labels cite R802.4.2 (+ the end-clip fabrication note at 400); the 12 m-class span flags per R802.5.1', () => {
    for (const cj of cjs) {
      expect(cj.label).toContain('rafter tie (R802.4.2)')
      expect(cj.label).toContain('ends clipped to the roof slope')
      // 10 m one-piece joists are far past the R802.5.1(2) table — honest flag
      expect(cj.flag).toContain('Ceiling joist over prescriptive span')
      expect(cj.flag).toContain('R802.5.1')
    }
    // at 300 the citation stays (code basis, the purlin-label convention)
    // while the fabrication clip note is 400-only
    const at300 = cjOf(frameRoofs([roof], [], DEFAULT_SPEC))
    expect(at300.length).toBe(cjs.length)
    for (const cj of at300) {
      expect(cj.label).toContain('rafter tie (R802.4.2)')
      expect(cj.label).not.toContain('ends clipped')
    }
  })

  test('besideRafter snapping: no joist rides a common or side-jack plane', () => {
    // parallel rafter stations: commons on ±ridgeHalf grid + side jacks past
    // the ridge ends — every joist keeps at least side-by-side contact
    const parallel = [
      ...byRole(members, 'rafter'),
      ...byRole(members, 'jack-rafter'),
    ].filter((r) => Math.abs(longAxis(r).x) > 0.5) // runs along X, like the joists
    for (const cj of cjs) {
      for (const r of parallel) {
        const gap = Math.abs((cj.position[2] as number) - (r.position[2] as number))
        expect(gap).toBeGreaterThanOrEqual(T / 2 + T / 2 - 1e-9)
      }
    }
  })

  test('alongX orientation (width ≥ depth): joists run along Z, stationed on X', () => {
    const wide = frameRoofs([seg({ roofType: 'hip', width: 12, depth: 10 })], [], at400)
    const wideCjs = cjOf(wide)
    expect(wideCjs.length).toBeGreaterThan(20)
    for (const cj of wideCjs) {
      expect(Math.abs(longAxis(cj).z)).toBeCloseTo(1, 5)
      expect(cj.position[2]).toBeCloseTo(0, 6)
    }
  })

  test('LOD 200 keeps the schematic full-span joists, unclipped and unflagged (gable convention)', () => {
    const generic = cjOf(frameRoofs([roof], [], { ...DEFAULT_SPEC, detail: '200' }))
    expect(generic.length).toBeGreaterThan(0)
    for (const cj of generic) {
      expect(cj.length).toBeCloseTo(10, 6)
      expect(cj.flag).toBeUndefined()
    }
  })

  test('compact hip joists fit the R802.5.1 table and stay flag-free', () => {
    const compact = cjOf(frameRoofs([seg({ roofType: 'hip', depth: 3.8 })], [], DEFAULT_SPEC))
    expect(compact.length).toBeGreaterThan(0)
    for (const cj of compact) expect(cj.flag).toBeUndefined()
  })

  test('snapped stations never collapse onto each other (25° layout-end repro)', () => {
    // at 25° the layout's guaranteed END station and its neighbor both snap
    // beside the same side jack — the raw map emitted two joists at ONE spot
    const m25 = cjOf(
      frameRoofs([seg({ roofType: 'hip', pitch: (25 * Math.PI) / 180 })], [], DEFAULT_SPEC),
    )
    expect(m25.length).toBeGreaterThan(0)
    const us = m25.map((cj) => cj.position[0] as number).sort((a, b) => a - b)
    for (let i = 1; i < us.length; i++) {
      expect((us[i] as number) - (us[i - 1] as number)).toBeGreaterThanOrEqual(T - 1e-9)
    }
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B7b: hip collar ties on the ridge portion (R802.4.6)
// ---------------------------------------------------------------------------

describe('LOD-400 B7b: hip collar ties on the ridge portion (R802.4.6)', () => {
  const roof = seg({ roofType: 'hip', width: 10, depth: 12 }) // ridge on Z, ridgeHalf 1
  const theta = roof.pitch
  const members = frameRoofs([roof], [], DEFAULT_SPEC)
  const ties = byRole(members, 'collar-tie')
  const baseY = roof.position[1] + roof.wallHeight
  const rise = 5 * Math.tan(theta)

  test('every other common pair carries a tie in the upper third, on the ridge portion only', () => {
    // commons on the 2 m ridge portion at 24" o.c. → 5 stations → 3 ties
    expect(ties).toHaveLength(3)
    for (const tie of ties) {
      expect(tie.position[1]).toBeCloseTo(baseY + (2 / 3) * rise, 4)
      // stationed along the ridge (Z here), never past the ridge ends
      expect(Math.abs(tie.position[2] as number)).toBeLessThanOrEqual(1)
      // spans between the two LONG planes (along X), centered
      expect(Math.abs(longAxis(tie).x)).toBeCloseTo(1, 5)
      expect(tie.position[0]).toBeCloseTo(0, 6)
      expect(tie.length).toBeCloseTo((2 * (rise / 3)) / Math.tan(theta), 4)
      expect(tie.label).toContain('R802.4.6')
      expect(tie.label).toContain('upper third')
    }
  })

  test('tie endpoints lie ON the long slope planes (regression-style reconstruction)', () => {
    const ridgeY = baseY + rise
    for (const tie of ties) {
      const axis = longAxis(tie)
      const e1 = new Vector3(...tie.position).add(axis.clone().multiplyScalar(tie.length / 2))
      const e2 = new Vector3(...tie.position).sub(axis.clone().multiplyScalar(tie.length / 2))
      for (const e of [e1, e2]) {
        expect(ridgeY - Math.abs(e.x) * Math.tan(theta)).toBeCloseTo(e.y, 6)
      }
    }
  })

  test('near-square hips (no real ridge portion) carry no collar ties', () => {
    expect(byRole(frameRoofs([seg({ roofType: 'hip', width: 6, depth: 6 })], [], DEFAULT_SPEC), 'collar-tie')).toHaveLength(0)
    expect(byRole(frameRoofs([seg({ roofType: 'hip', width: 6.1, depth: 6 })], [], DEFAULT_SPEC), 'collar-tie')).toHaveLength(0)
  })

  test('a tension tie past 20 ft stock flags its impossible field splice', () => {
    const monster = frameRoofs([seg({ roofType: 'hip', width: 26, depth: 20 })], [], DEFAULT_SPEC)
    const bigTies = byRole(monster, 'collar-tie')
    expect(bigTies.length).toBeGreaterThan(0)
    for (const tie of bigTies) {
      expect(tie.flag).toContain('exceeds 20 ft one-piece stock')
    }
  })

  test('S4: joists + ties ride the existing Roof lumber rows (no invented rows)', () => {
    const compact = frameRoofs([seg({ roofType: 'hip', depth: 3.8 })], [], DEFAULT_SPEC)
    const rows = computeTakeoff(compact, [])
    // the only 2x4s on a hip are the new collar ties — the rows ARE the
    // census (lumber books per size × stock length)
    const tieCount = byRole(compact, 'collar-tie').length
    expect(tieCount).toBeGreaterThan(0)
    const sum = (item: string) =>
      rows
        .filter((r) => r.section === 'Roof' && r.item === item && r.unit === 'pcs')
        .reduce((s, r) => s + r.quantity, 0)
    expect(sum('2x4')).toBe(tieCount)
    // ceiling joists blend into the 2x6 stick count alongside rafters/hips
    expect(sum('2x6')).toBe(compact.filter((m) => m.size === '2x6').length)
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B7c: mansard/dutch — main ceiling + the inner thrust story
// ---------------------------------------------------------------------------

describe('LOD-400 B7c: mansard/dutch ceiling joists + inner thrust story (R802.4.2/R802.4.6)', () => {
  const IN = 0.0254
  const T = 1.5 * IN
  const RD = 5.5 * IN
  const CJ_D = 5.5 * IN
  const at400 = { ...DEFAULT_SPEC, detail: '400' as const }
  const cjOf = (members: Member[]) => byRole(members, 'ceiling-joist')
  const baseY = 3.0 // position 2.5 + wallHeight 0.5

  test('mansard: main joists span the short axis at the eave line, band pulled off the end skirts', () => {
    const roof = seg({ roofType: 'mansard', width: 10, depth: 8 })
    const members = frameRoofs([roof], [], at400)
    const theta = roof.pitch
    const main = cjOf(members).filter((cj) => Math.abs((cj.position[1] as number) - (baseY + CJ_D / 2)) < 1e-6)
    const clip = (CJ_D - RD / (2 * Math.cos(theta))) / Math.tan(theta) + 0.002
    const clear = (CJ_D + RD / (2 * Math.cos(theta))) / Math.tan(theta) + T + 0.002
    const bandHalf = 5 - clear
    const floor = Math.floor((2 * bandHalf) / DEFAULT_SPEC.ceilingJoistSpacing) - 1
    expect(main.length).toBeGreaterThanOrEqual(floor)
    expect(main.length).toBeLessThanOrEqual(floor + 4)
    for (const cj of main) {
      expect(Math.abs(longAxis(cj).z)).toBeCloseTo(1, 5) // depth 8 < width 10
      expect(cj.length).toBeCloseTo(8 - 2 * clip, 6)
      expect(Math.abs(cj.position[0] as number)).toBeLessThanOrEqual(bandHalf + 1e-9)
      expect(cj.label).toContain('rafter tie (R802.4.2)')
      // an 8 m one-piece joist is past the R802.5.1(2) table — honest flag
      expect(cj.flag).toContain('Ceiling joist over prescriptive span')
    }
  })

  test('mansard: the inner hip crown models its own joists at the skirt top; steep crowns tie per R802.4.6', () => {
    const roof = seg({ roofType: 'mansard', width: 10, depth: 8 })
    const skirtRise = 1.2 * Math.tan(roof.pitch) // inset 8·0.15 at the schema pitch
    const members = frameRoofs([roof], [], at400)
    const upper = cjOf(members).filter(
      (cj) => Math.abs((cj.position[1] as number) - (baseY + skirtRise + CJ_D / 2)) < 1e-6,
    )
    expect(upper.length).toBeGreaterThan(0)
    // the DEFAULT crown computes ~8.8° — too flat for a collar tie band
    // (the gable low-pitch skip convention): pinned at zero, not fake wood
    expect(byRole(members, 'collar-tie')).toHaveLength(0)
    // a steep mansard's crown is a real hip — its ridge portion ties
    const steep = frameRoofs([seg({ roofType: 'mansard', pitch: (55 * Math.PI) / 180 })], [], at400)
    const ties = byRole(steep, 'collar-tie')
    expect(ties.length).toBeGreaterThan(0)
    for (const tie of ties) expect(tie.label).toContain('R802.4.6')
  })

  test('dutch: main joists at the eave line + the gablet thrust story above', () => {
    const roof = seg({ roofType: 'dutch', width: 10, depth: 8 })
    const members = frameRoofs([roof], [], at400)
    const main = cjOf(members).filter((cj) => Math.abs((cj.position[1] as number) - (baseY + CJ_D / 2)) < 1e-6)
    expect(main.length).toBeGreaterThan(15)
    for (const cj of main) {
      expect(Math.abs(longAxis(cj).z)).toBeCloseTo(1, 5)
      expect(cj.label).toContain('rafter tie (R802.4.2)')
    }
    // the gablet (frameGable) carries its own ceiling joists + collar ties
    // at the skirt top — the dutch ridge portion is tied
    const skirtRise = 2 * Math.tan(roof.pitch) // inset 8·0.25
    const gabletCjs = cjOf(members).filter((cj) => (cj.position[1] as number) > baseY + skirtRise)
    expect(gabletCjs.length).toBeGreaterThan(0)
    expect(byRole(members, 'collar-tie').length).toBeGreaterThan(0)
  })

  test('orientation: a depth-major mansard runs its joists along X', () => {
    const members = frameRoofs([seg({ roofType: 'mansard', width: 8, depth: 10 })], [], at400)
    const main = cjOf(members).filter((cj) => Math.abs((cj.position[1] as number) - (baseY + CJ_D / 2)) < 1e-6)
    expect(main.length).toBeGreaterThan(15)
    for (const cj of main) expect(Math.abs(longAxis(cj).x)).toBeCloseTo(1, 5)
  })

  test('degenerate near-flat skirt emits NO ceiling frame (honesty over buried wood)', () => {
    // 3° skirt: the planes never rise clear of the joist band, and the
    // inner crown's ridge underside descends into it — zero joists, silent
    const members = frameRoofs([seg({ roofType: 'mansard', pitch: (3 * Math.PI) / 180 })], [], at400)
    expect(cjOf(members)).toHaveLength(0)
  })

  test('LOD 200 keeps the schematic full-span main joists (gable convention)', () => {
    const members = frameRoofs([seg({ roofType: 'dutch', width: 10, depth: 8 })], [], {
      ...DEFAULT_SPEC,
      detail: '200',
    })
    const main = cjOf(members).filter((cj) => Math.abs((cj.position[1] as number) - (baseY + CJ_D / 2)) < 1e-6)
    expect(main.length).toBeGreaterThan(0)
    for (const cj of main) {
      expect(cj.length).toBeCloseTo(8, 6)
      expect(cj.flag).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// B7 fix round (skeptic F1): the end-plane thrust gap PRINTS — never a
// comment-only confession — + the crown bearing advisory
// ---------------------------------------------------------------------------

describe('B7 fix round: end-plane thrust statement prints (F1) + crown bearing honesty', () => {
  const IN = 0.0254
  const CJ_D = 5.5 * IN
  const at400 = { ...DEFAULT_SPEC, detail: '400' as const }
  const cjOf = (members: Member[]) => byRole(members, 'ceiling-joist')

  test('hip at 400: every ceiling joist carries the end-plane statement, composed onto over-span honesty (M2)', () => {
    const members = frameRoofs([seg({ roofType: 'hip', width: 10, depth: 12 })], [], at400)
    const cjs = cjOf(members)
    expect(cjs.length).toBeGreaterThan(0)
    for (const cj of cjs) {
      expect(cj.flag).toContain('end-triangle stub joists not modeled')
      expect(cj.flag).toContain('verify tie detail (R802.4.2)')
      // never MASKS the over-span honesty — composes ' | ' onto it
      expect(cj.flag).toContain('Ceiling joist over prescriptive span')
      expect(cj.flag).toContain(' | ')
    }
  })

  test('near-square subsumption: the statement covers the zero-collar-tie case too', () => {
    const square = frameRoofs([seg({ roofType: 'hip', width: 6, depth: 6 })], [], at400)
    expect(byRole(square, 'collar-tie')).toHaveLength(0)
    const cjs = cjOf(square)
    expect(cjs.length).toBeGreaterThan(0)
    for (const cj of cjs) {
      expect(cj.flag).toContain('collar ties ride the ridge portion only')
    }
  })

  test('mansard/dutch at 400: the skirt end faces state the same gap on the MAIN joists', () => {
    for (const roofType of ['mansard', 'dutch'] as const) {
      const members = frameRoofs([seg({ roofType, width: 10, depth: 8 })], [], at400)
      const main = cjOf(members).filter(
        (cj) => Math.abs((cj.position[1] as number) - (3.0 + CJ_D / 2)) < 1e-6,
      )
      expect(main.length).toBeGreaterThan(0)
      for (const cj of main) {
        expect(cj.flag).toContain(`${roofType} skirt end faces`)
        expect(cj.flag).toContain('end-triangle stub joists not modeled')
        expect(cj.flag).toContain('verify tie detail (R802.4.2)')
      }
    }
  })

  test('the statement reaches a takeoff Flags row on the hip compose (P4 prints it)', () => {
    const members = frameRoofs([seg({ roofType: 'hip', width: 10, depth: 12 })], [], at400)
    const rows = computeTakeoff(members, [])
    const row = rows.find(
      (r) => r.section === 'Flags' && r.detail.includes('end-triangle stub joists not modeled'),
    )
    expect(row).toBeDefined()
    expect(row?.quantity).toBe(cjOf(members).length)
  })

  test('300 stays quiet (the B6 stated-gap convention); a compact 400 hip carries ONLY the statement', () => {
    const at300 = frameRoofs([seg({ roofType: 'hip', width: 10, depth: 12 })], [], DEFAULT_SPEC)
    for (const cj of cjOf(at300)) {
      expect(cj.flag ?? '').not.toContain('stub joists')
    }
    // a span-legal 400 hip: the statement is the WHOLE flag (nothing to compose)
    const compact = frameRoofs([seg({ roofType: 'hip', depth: 3.8 })], [], at400)
    const cjs = cjOf(compact)
    expect(cjs.length).toBeGreaterThan(0)
    for (const cj of cjs) {
      expect(cj.flag).toBe(
        'hip end planes: rafter ties parallel to the end-plane span + end-triangle stub joists not modeled (collar ties ride the ridge portion only) — verify tie detail (R802.4.2)',
      )
    }
  })

  test('mansard crown joists confess their assumed bearing; the main joists stay clean of the clause', () => {
    const members = frameRoofs([seg({ roofType: 'mansard', width: 10, depth: 8 })], [], at400)
    const skirtRise = 1.2 * Math.tan((40 * Math.PI) / 180)
    const crown = cjOf(members).filter(
      (cj) => Math.abs((cj.position[1] as number) - (3.0 + skirtRise + CJ_D / 2)) < 1e-6,
    )
    expect(crown.length).toBeGreaterThan(0)
    for (const cj of crown) {
      expect(cj.label).toContain('assumed bearing at skirt top — verify')
      expect(cj.label).toContain('rafter tie (R802.4.2)') // the clause APPENDS, never replaces
    }
    const main = cjOf(members).filter(
      (cj) => Math.abs((cj.position[1] as number) - (3.0 + CJ_D / 2)) < 1e-6,
    )
    expect(main.length).toBeGreaterThan(0)
    for (const cj of main) expect(cj.label).not.toContain('assumed bearing')
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B7 blast radius: untouched shapes byte-equal to master (pinned)
// ---------------------------------------------------------------------------

describe('B7 blast radius: gable/shed/flat/gambrel/valley byte-equal to master (hash pins)', () => {
  // sha256 of the framed member JSON, captured at master 779d70e — the B7
  // hip-family members must not perturb these shapes by a single byte.
  const hashOf = (members: Member[]): string =>
    createHash('sha256').update(JSON.stringify(members)).digest('hex').slice(0, 16)
  const PINS: [string, Partial<RoofSegmentSlice>, Partial<FramingSpec>, string][] = [
    ['gable-300', {}, {}, '0630b9f861ee5f6c'],
    ['gable-400', {}, { detail: '400' }, '956ef4b91c7d838c'],
    ['gable-200', {}, { detail: '200' }, '34f8a921c61c82e3'],
    ['gable-400-windy', {}, { detail: '400', hurricaneTies: true }, 'cf188b8d03379ed1'],
    ['gable-big-400', { width: 10, depth: 12 }, { detail: '400' }, '9488d2b7f7a2c3c9'],
    ['shed-300', { roofType: 'shed' }, {}, '76e8a43f3f95a947'],
    ['shed-400', { roofType: 'shed' }, { detail: '400' }, '56128ff5e8d68001'],
    ['shed-200', { roofType: 'shed' }, { detail: '200' }, '4da5818e22a231e4'],
    ['shed-big-400', { roofType: 'shed', depth: 8 }, { detail: '400' }, '0d54b38723e03603'],
    ['flat-400', { roofType: 'flat' }, { detail: '400' }, 'e5d74f2bb9f51fd1'],
    ['gambrel-400', { roofType: 'gambrel' }, { detail: '400' }, '7001177e55d8903e'],
  ]

  for (const [name, over, sp, pin] of PINS) {
    test(`${name} reproduces the master bytes`, () => {
      const members = frameRoofs([seg(over)], [], { ...DEFAULT_SPEC, ...sp })
      expect(hashOf(members)).toBe(pin)
    })
  }

  test('valley pair (gable × gable) reproduces the master bytes', () => {
    const members = frameRoofs(
      [seg(), seg({ id: 'roofseg_wing', width: 4, depth: 4, yaw: Math.PI / 2, position: [1, 2.5, 4] })],
      [],
      { ...DEFAULT_SPEC, detail: '400' },
    )
    expect(hashOf(members)).toBe('2ef111d64bcdd8d9')
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B8a: ridge <3:12 — a plain ridge board is not a ridge beam
// ---------------------------------------------------------------------------

describe('LOD-400 B8a: sub-3:12 gable ridge flags R802.4.3 (flag route, v1)', () => {
  // 2.5:12 — the audit exhibit: frameGable emitted a plain ridge BOARD with
  // no beam, no posts and no statement. The v1 fix is the honest flag (the
  // stated-gap convention); the beam+post member set is the follow-up.
  const low = seg({ pitch: Math.atan(2.5 / 12) })
  const FLAG =
    'ridge slope < 3:12 — ridge beam required, R802.4.3 (plain ridge board modeled; structural ridge beam + posts to bearing not modeled — verify design)'

  test('2.5:12 gable: the ridge carries the R802.4.3 flag at 300 and 400', () => {
    for (const detail of ['300', '400'] as const) {
      const members = frameRoofs([low], [], { ...DEFAULT_SPEC, detail })
      const ridge = byRole(members, 'ridge')
      expect(ridge).toHaveLength(1)
      expect((ridge[0] as Member).flag).toBe(FLAG)
      // the flag rides the RIDGE only — rafters/joists keep their own honesty
      for (const m of members) {
        if (m.role !== 'ridge') expect(m.flag ?? '').not.toContain('R802.4.3')
      }
    }
  })

  test('slopes at/above 3:12 stay clean: exactly 3:12, and the default 40°', () => {
    for (const pitch of [Math.atan(3 / 12), (40 * Math.PI) / 180]) {
      const members = frameRoofs([seg({ pitch })], [], { ...DEFAULT_SPEC, detail: '400' })
      for (const m of members) expect(m.flag ?? '').not.toContain('R802.4.3')
    }
  })

  test('LOD 200 stays schematic (no code claims — the flag convention)', () => {
    const members = frameRoofs([low], [], { ...DEFAULT_SPEC, detail: '200' })
    for (const m of members) expect(m.flag ?? '').not.toContain('R802.4.3')
  })

  test('the flag reaches a takeoff Flags row (P4 prints it — the B7 convention)', () => {
    const rows = computeTakeoff(frameRoofs([low], [], { ...DEFAULT_SPEC, detail: '400' }), [])
    const row = rows.find(
      (r) => r.section === 'Flags' && r.detail.includes('ridge beam required, R802.4.3'),
    )
    expect(row).toBeDefined()
    expect(row?.quantity).toBe(1) // one ridge, one statement
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B8b: flat roofs carry the uplift path (R802.11)
// ---------------------------------------------------------------------------

describe('LOD-400 B8b: flat-roof joists tie BOTH bearing ends under high wind (R802.11)', () => {
  const windy = { ...DEFAULT_SPEC, hurricaneTies: true }
  const tiesOf = (members: Member[]) => members.filter((m) => m.label === 'hurricane tie')

  test('windy census: exactly two ties per joist, at the plate line on the joist underside plane', () => {
    const roof = seg({ roofType: 'flat' }) // 8 × 6 → joists run along Z, bearing at z = ±3
    const members = frameRoofs([roof], [], windy)
    const joists = byRole(members, 'rafter')
    const ties = tiesOf(members)
    expect(joists.length).toBeGreaterThan(0)
    expect(ties.length).toBe(2 * joists.length)
    const plusEnd = ties.filter((m) => (m.position[2] as number) > 0)
    expect(plusEnd.length).toBe(joists.length)
    for (const tie of ties) {
      // plate line = the FOOTPRINT edge (never the overhung rim line)…
      expect(Math.abs(tie.position[2] as number)).toBeCloseTo(3, 6)
      // …at the joist underside plane (the shed lowY convention)
      expect(tie.position[1]).toBeCloseTo(roof.position[1] + roof.wallHeight, 6)
      expect(tie.material).toBe('steel')
    }
    // each tie sits BESIDE a joist face (t/2 + 1.5"), snapped toward center
    const clear = (1.5 / 2) * 0.0254 + 1.5 * 0.0254
    const stations = joists.map((j) => j.position[0] as number)
    for (const tie of plusEnd) {
      const x = tie.position[0] as number
      expect(stations.some((u) => Math.abs(u + (u >= 0 ? -1 : 1) * clear - x) < 1e-9)).toBe(true)
    }
  })

  test('spansX orientation (width < depth): ties land on the ±X plate lines', () => {
    const members = frameRoofs([seg({ roofType: 'flat', width: 6, depth: 8 })], [], windy)
    const ties = tiesOf(members)
    expect(ties.length).toBe(2 * byRole(members, 'rafter').length)
    for (const tie of ties) expect(Math.abs(tie.position[0] as number)).toBeCloseTo(3, 6)
  })

  test('the takeoff picks the tie row up free (role+material+system)', () => {
    const members = frameRoofs([seg({ roofType: 'flat' })], [], windy)
    const rows = computeTakeoff(members, [])
    const row = rows.find((r) => r.item === 'Hurricane ties')
    expect(row?.quantity).toBe(tiesOf(members).length)
    expect(row?.detail).toContain('R802.11')
  })

  test('non-windy flat stays byte-equal (default spec and explicit false)', () => {
    const plain = frameRoofs([seg({ roofType: 'flat' })], [], DEFAULT_SPEC)
    expect(plain).toEqual(frameRoofs([seg({ roofType: 'flat' })], [], { ...DEFAULT_SPEC, hurricaneTies: false }))
    expect(tiesOf(plain)).toHaveLength(0)
    // …and at 400, where the flat-400 sha pin above holds the whole story
    expect(tiesOf(frameRoofs([seg({ roofType: 'flat' })], [], { ...DEFAULT_SPEC, detail: '400' }))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// LOD-400 B8c: unframed roof intersections warn — never silent
// ---------------------------------------------------------------------------

describe('LOD-400 B8c: overlapping segment pairs the valley detector skips WARN', () => {
  const PHRASE = 'roof intersection not framed — valley detail required'

  test('the audit exhibit: a hip wing into a gable main frames NO valley members — and now warns', () => {
    const major = seg()
    const wing = seg({
      id: 'roofseg_hipwing',
      roofType: 'hip',
      width: 4,
      depth: 4,
      yaw: Math.PI / 2,
      position: [1, 2.5, 4], // same crossing the gable×gable valley pair uses
    })
    // the silence being closed: zero valley boards, zero valley jacks
    const members = frameRoofs([major, wing], [], DEFAULT_SPEC)
    expect(byRole(members, 'valley')).toHaveLength(0)
    expect(members.some((m) => m.label?.includes('Valley jack'))).toBe(false)
    // …so the detector must say so, naming both segments
    const warnings = detectUnframedRoofIntersections([major, wing])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(PHRASE)
    expect(warnings[0]).toContain('roofseg_hipwing')
    expect(warnings[0]).toContain('roofseg_test')
  })

  test('a QUALIFYING perpendicular gable×gable pair stays quiet — its members ARE the answer', () => {
    const major = seg()
    const minor = seg({ id: 'roofseg_wing', width: 4, depth: 4, yaw: Math.PI / 2, position: [1, 2.5, 4] })
    expect(byRole(frameRoofs([major, minor], [], DEFAULT_SPEC), 'valley')).toHaveLength(2)
    expect(detectUnframedRoofIntersections([major, minor])).toHaveLength(0)
  })

  test('non-qualifying gable pairs warn: parallel overlap, fully BURIED cross, eave mismatch', () => {
    const major = seg()
    // parallel ridges, footprints overlapping — the ⊥ test skips the pair
    expect(detectUnframedRoofIntersections([major, seg({ id: 'par', position: [2, 2.5, 3] })])).toHaveLength(1)
    // perpendicular but fully buried inside the major (never crosses the eave)
    const buried = seg({ id: 'bur', width: 3, depth: 2, yaw: Math.PI / 2, position: [0, 2.5, 0] })
    expect(detectUnframedRoofIntersections([major, buried])).toHaveLength(1)
    // qualifying geometry, but the eaves mismatch > 0.05 — detectValleys refuses it
    const lifted = seg({ id: 'lif', width: 4, depth: 4, yaw: Math.PI / 2, position: [1, 2.8, 4] })
    expect(detectUnframedRoofIntersections([major, lifted])).toHaveLength(1)
  })

  test('adjacent wings never warn: shared edge and a 3 cm graze are composition, not intersection', () => {
    const major = seg() // x ∈ [−4, 4]
    expect(detectUnframedRoofIntersections([major, seg({ id: 'abut', position: [8, 2.5, 0] })])).toHaveLength(0)
    expect(detectUnframedRoofIntersections([major, seg({ id: 'graze', position: [7.97, 2.5, 0] })])).toHaveLength(0)
  })

  test('vertically separated stacks never warn (a cupola floats above the main ridge)', () => {
    // major peak: 2.5 + 0.5 + 3·tan40° ≈ 5.52 — the cupola's base sits above it
    const major = seg()
    const cupola = seg({ id: 'cup', width: 2, depth: 2, position: [0, 6, 0] })
    expect(detectUnframedRoofIntersections([major, cupola])).toHaveLength(0)
    // …but the same cupola resting ON the roof band still warns
    expect(
      detectUnframedRoofIntersections([major, seg({ id: 'low', width: 2, depth: 2, position: [0, 3, 0] })]),
    ).toHaveLength(1)
  })

  test('three wings: the served valley pair stays quiet while the hip wing warns once', () => {
    const major = seg()
    const gableWing = seg({ id: 'roofseg_wing', width: 4, depth: 4, yaw: Math.PI / 2, position: [1, 2.5, 4] })
    const hipWing = seg({
      id: 'roofseg_hipwing',
      roofType: 'hip',
      width: 4,
      depth: 4,
      yaw: Math.PI / 2,
      position: [-2, 2.5, -4],
    })
    const warnings = detectUnframedRoofIntersections([major, gableWing, hipWing])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('roofseg_hipwing')
  })
})
