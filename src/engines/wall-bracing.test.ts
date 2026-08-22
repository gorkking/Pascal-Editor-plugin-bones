import { describe, expect, test } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
import type { WallSlice } from '../core/types'
import { feet, inches } from '../core/units'
import { baselineConfig, baselineScene } from '../framing/baseline-scene'
import { computeLevel } from '../framing/compute'
import {
  BRACED_LINE_OFFSET_TOL,
  BRACED_PANEL_MIN_LENGTH,
  PORTAL_OPENING_MIN_SPAN,
  bracingWarnings,
  identifyBracedWallLines,
  portalMinPanelWidth,
} from './wall-bracing'

function makeWall(
  id: string,
  start: [number, number],
  end: [number, number],
  overrides: Partial<WallSlice> = {},
): WallSlice {
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  return {
    id,
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

/** 12×8 rect shell — the baseline-scene footprint as raw slices. */
const rectShell = (): WallSlice[] => [
  makeWall('w_s', [0, 0], [12, 0]),
  makeWall('w_e', [12, 0], [12, 8]),
  makeWall('w_n', [12, 8], [0, 8]),
  makeWall('w_w', [0, 8], [0, 0]),
]

describe('identifyBracedWallLines', () => {
  test('rect shell → four lines: X1/X2 (south/north), Z1/Z2 (west/east)', () => {
    const lines = identifyBracedWallLines(rectShell())
    expect(lines.map((l) => `${l.label}:${l.wallIds.join('+')}`)).toEqual([
      'X1:w_s',
      'X2:w_n',
      'Z1:w_w',
      'Z2:w_e',
    ])
    // Offsets are the perpendicular coordinates; lengths are the wall runs.
    expect(lines.find((l) => l.label === 'X1')?.offset).toBeCloseTo(0, 6)
    expect(lines.find((l) => l.label === 'X2')?.offset).toBeCloseTo(8, 6)
    expect(lines.find((l) => l.label === 'X1')?.totalLength).toBeCloseTo(12, 6)
  })

  test('walls offset within 4 ft brace ONE line (R602.10.1.1); past it they split', () => {
    // Two colinear-ish south walls, the second jogged 1 m north (< 4 ft).
    const near = identifyBracedWallLines([
      makeWall('a', [0, 0], [6, 0]),
      makeWall('b', [6, 1], [12, 1]),
    ])
    expect(near).toHaveLength(1)
    expect(near[0]?.wallIds).toEqual(['a', 'b'])
    expect(near[0]?.offset).toBeCloseTo(0.5, 6)
    // Jogged 1.5 m (> 4 ft = 1.219 m): two lines.
    const far = identifyBracedWallLines([
      makeWall('a', [0, 0], [6, 0]),
      makeWall('b', [6, 1.5], [12, 1.5]),
    ])
    expect(far.map((l) => l.label)).toEqual(['X1', 'X2'])
    expect(BRACED_LINE_OFFSET_TOL).toBeCloseTo(feet(4), 9)
  })

  test('interior / curved walls stay out; oblique walls join their dominant axis', () => {
    const lines = identifyBracedWallLines([
      makeWall('ext', [0, 0], [12, 0]),
      makeWall('int', [0, 4], [12, 4], { exterior: false }),
      makeWall('curve', [0, 8], [12, 8], { curved: true }),
      // 30°-ish off the x axis: |dx| > |dz| → x-line.
      makeWall('slant', [0, 0.5], [10, 0.9]),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]?.wallIds).toEqual(['ext', 'slant'])
  })
})

describe('bracingWarnings — the CS-WSP declaration', () => {
  test('one honest not-verified flag per line, method named from the spec', () => {
    const warnings = bracingWarnings(rectShell(), DEFAULT_SPEC)
    expect(warnings).toHaveLength(4)
    for (const w of warnings) {
      expect(w).toContain('CS-WSP continuous sheathing assumed')
      expect(w).toContain('R602.10 panel length/spacing not verified')
    }
    expect(warnings[0]).toContain('braced wall line X1 (1 wall, 12.0m)')
  })

  test('LOD 200 makes no code claims — zero bracing warnings', () => {
    expect(bracingWarnings(rectShell(), { ...DEFAULT_SPEC, detail: '200' })).toEqual([])
  })
})

describe('portalMinPanelWidth — Table R602.10.5 CS-PF minimums, snapped UP', () => {
  test('16" at 8 ft, 18" at 9 ft, 20" at 10 ft; 2.5 m snaps up to 18"', () => {
    expect(portalMinPanelWidth(feet(8))).toBeCloseTo(inches(16), 9)
    expect(portalMinPanelWidth(feet(9))).toBeCloseTo(inches(18), 9)
    expect(portalMinPanelWidth(feet(10))).toBeCloseTo(inches(20), 9)
    expect(portalMinPanelWidth(2.5)).toBeCloseTo(inches(18), 9)
  })

  test('threshold constants match the tables they cite', () => {
    expect(PORTAL_OPENING_MIN_SPAN).toBeCloseTo(feet(6), 9)
    expect(BRACED_PANEL_MIN_LENGTH).toBeCloseTo(feet(4), 9)
  })
})

describe('computeLevel integration — every framed level declares its lines', () => {
  test('baseline scene carries the four line declarations (INTL and CA alike)', () => {
    for (const code of ['INTL', 'CA'] as const) {
      const result = computeLevel(baselineScene(), baselineConfig(code))
      const lines = result.warnings.filter((w) => w.startsWith('braced wall line'))
      expect(lines, code).toHaveLength(4)
      expect(lines.every((w) => w.includes('not verified')), code).toBe(true)
    }
  })

  test('LOD 200 scene: no bracing declarations', () => {
    const config = { ...baselineConfig('INTL'), detail: '200' as const }
    const result = computeLevel(baselineScene(), config)
    expect(result.warnings.filter((w) => w.startsWith('braced wall line'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Jurisdiction truth (the B9 defect): SDC-D wall members ≠ INTL, and the
// difference is EXACTLY the bracing/portal content — enumerated.
// ---------------------------------------------------------------------------

import { FramingNode } from '../framing/schema'
import type { Member } from '../core/types'

/** Garage box: 6.4×8 m shell, 16-ft door RO centered in the south wall —
 * returns land between the CS-PF minimum (18" @ 2.5 m walls) and the 48"
 * braced-panel minimum: portal territory on both sides. */
const garageScene = (): Record<string, Record<string, unknown>> => {
  const wall = (id: string, start: [number, number], end: [number, number], children: string[] = []) => ({
    id,
    type: 'wall',
    parentId: 'level_1',
    start,
    end,
    thickness: 0.15,
    height: 2.5,
    frontSide: 'exterior',
    children,
  })
  return {
    level_1: { id: 'level_1', type: 'level', level: 0, height: 2.5 },
    w_s: wall('w_s', [0, 0], [6.4, 0], ['garage_door']),
    garage_door: {
      id: 'garage_door',
      type: 'door',
      parentId: 'w_s',
      position: [3.2, 0, 0],
      width: feet(16) - inches(1.5),
      height: 2.13,
    },
    w_e: wall('w_e', [6.4, 0], [6.4, 8]),
    w_n: wall('w_n', [6.4, 8], [0, 8]),
    w_w: wall('w_w', [0, 8], [0, 0]),
    slab_1: {
      id: 'slab_1',
      type: 'slab',
      parentId: 'level_1',
      polygon: [
        [0, 0],
        [6.4, 0],
        [6.4, 8],
        [0, 8],
      ],
      holes: [],
    },
    z_garage: {
      id: 'z_garage',
      type: 'zone',
      parentId: 'level_1',
      name: 'Garage',
      polygon: [
        [0, 0],
        [6.4, 0],
        [6.4, 8],
        [0, 8],
      ],
      boundaryWallIds: ['w_s', 'w_e', 'w_n', 'w_w'],
    },
  }
}

const garageConfig = (jurisdiction: string): FramingNode =>
  FramingNode.parse({
    id: 'bonesframing_garage',
    parentId: 'level_1',
    jurisdiction,
    detail: '400',
    studSpacingIn: 16,
    showWalls: true,
    showFoundation: true,
    showFloor: false,
    showRoof: false,
    showElectrical: false,
    showPlumbing: false,
    showHvac: false,
  })

describe('SDC-D ≠ INTL on the garage scene — delta enumerated (B9 jurisdiction truth)', () => {
  // The B9 defect was STRUCTURAL wall members byte-identical CA vs INTL —
  // assembly LAYERS already differ by jurisdiction (cladding family,
  // climate-zone labels; pre-existing, not bracing), so the gate compares
  // the structural set.
  const LAYER_ROLES = new Set(['drywall', 'sheathing', 'wrb', 'cladding', 'insulation'])
  const wallMembers = (code: string): Member[] =>
    computeLevel(garageScene(), garageConfig(code)).members.filter(
      (m) => m.system === 'wall-framing' && !LAYER_ROLES.has(m.role),
    )
  const isPortalHardware = (m: Member): boolean =>
    (m.role === 'post' || m.role === 'strap') && (m.label ?? '').includes('R602.10.6.4')
  /** Strip a member list down to the non-bracing content: portal members
   * out, the R602.10 parts of composed flags out. */
  const stripBracing = (members: Member[]): unknown[] =>
    JSON.parse(
      JSON.stringify(
        members
          .filter((m) => !isPortalHardware(m))
          .map((m) => {
            if (!m.flag?.includes('R602.10')) return m
            const rest = m.flag.split(' | ').filter((p) => !p.includes('R602.10'))
            const { flag: _dropped, ...restMember } = m
            return rest.length > 0 ? { ...restMember, flag: rest.join(' | ') } : restMember
          }),
      ),
    )

  test('CA garage returns build the CS-PF portal set; INTL flags the same returns', () => {
    const ca = wallMembers('CA')
    const intl = wallMembers('INTL')
    // CA: 4 doubled hold-down posts + 2 header straps, kings unflagged
    expect(ca.filter((m) => m.role === 'post' && isPortalHardware(m))).toHaveLength(4)
    expect(ca.filter((m) => m.role === 'strap')).toHaveLength(2)
    // INTL: zero hardware, both garage kings carry the honest flag
    expect(intl.some(isPortalHardware)).toBe(false)
    const flaggedKings = intl.filter(
      (m) => m.role === 'king-stud' && (m.flag ?? '').includes('portal frame (R602.10.6.4)'),
    )
    expect(flaggedKings).toHaveLength(2)
  })

  test('the CA-vs-INTL structural delta is EXACTLY the bracing/portal content', () => {
    const ca = wallMembers('CA')
    const intl = wallMembers('INTL')
    expect(JSON.parse(JSON.stringify(ca))).not.toEqual(JSON.parse(JSON.stringify(intl)))
    // Grid studs YIELD to the portal posts' keep-outs (contact allowed,
    // overlap never) — enumerate them: every INTL stud missing from CA
    // stands within one stud thickness of a CA portal post.
    const postPlans = ca
      .filter((m) => m.role === 'post' && isPortalHardware(m))
      .map((m) => [m.position[0], m.position[2]] as const)
    // Strictly INSIDE one stud thickness — a stud in exact face contact
    // with a post (distance == t) survives, mirroring the keep-out's ±EPS.
    const yieldsToPost = (m: Member): boolean =>
      m.role === 'stud' &&
      m.label === undefined &&
      postPlans.some(([x, z]) => Math.hypot(m.position[0] - x, m.position[2] - z) < 0.0381 - 1e-5)
    const yielded = intl.filter(yieldsToPost)
    expect(yielded.length).toBeGreaterThan(0)
    expect(yielded.length).toBeLessThanOrEqual(postPlans.length)
    expect(stripBracing(ca)).toEqual(stripBracing(intl.filter((m) => !yieldsToPost(m))) as never)
  })

  test('never plain framing silently: every jurisdiction answers the 16-ft door', () => {
    for (const code of ['CA', 'INTL', 'TX'] as const) {
      const members = wallMembers(code)
      const portal = members.filter(isPortalHardware)
      const flagged = members.filter((m) => (m.flag ?? '').includes('R602.10'))
      expect(portal.length > 0 || flagged.length > 0, code).toBe(true)
    }
  })
})
