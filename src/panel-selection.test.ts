import { describe, expect, test } from 'bun:test'
import type { WallSlice } from './core/types'
import { COURSE_HEIGHT, snapCmuHeight } from './engines/cmu'
import { computeLevel, resolveWallConstruction } from './framing/compute'
import { FramingNode } from './framing/schema'
import {
  CMU_SEAM_NOTE,
  cmuHeightControl,
  cmuHeightOverride,
  selectedWallInfo,
  wallOverridePatch,
} from './panel-selection'

/** One level: exterior wall (thick, marked), interior partition, curved wall. */
function makeScene(): Record<string, Record<string, unknown>> {
  return {
    level_1: { id: 'level_1', type: 'level', level: 0, height: 2.7 },
    level_2: { id: 'level_2', type: 'level', level: 1, height: 2.7 },
    wall_ext: {
      id: 'wall_ext',
      type: 'wall',
      parentId: 'level_1',
      name: 'South wall',
      start: [0, 0],
      end: [6, 0],
      thickness: 0.15,
      height: 2.5,
      frontSide: 'exterior',
      backSide: 'interior',
      children: [],
    },
    wall_int: {
      id: 'wall_int',
      type: 'wall',
      parentId: 'level_1',
      start: [3, 0],
      end: [3, 4],
      thickness: 0.1,
      height: 2.5,
      frontSide: 'interior',
      backSide: 'interior',
      children: [],
    },
    wall_curved: {
      id: 'wall_curved',
      type: 'wall',
      parentId: 'level_1',
      start: [0, 4],
      end: [6, 4],
      thickness: 0.15,
      curveOffset: 0.5,
      frontSide: 'exterior',
      backSide: 'interior',
      children: [],
    },
    wall_hidden: {
      id: 'wall_hidden',
      type: 'wall',
      parentId: 'level_1',
      visible: false,
      start: [0, 0],
      end: [0, 4],
      thickness: 0.15,
      children: [],
    },
    wall_upstairs: {
      id: 'wall_upstairs',
      type: 'wall',
      parentId: 'level_2',
      start: [0, 0],
      end: [6, 0],
      thickness: 0.15,
      frontSide: 'exterior',
      backSide: 'interior',
      children: [],
    },
    item_1: { id: 'item_1', type: 'item', parentId: 'level_1', position: [1, 0, 1] },
  }
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  const config = FramingNode.parse({ jurisdiction: 'INTL', ...overrides })
  return { ...config, parentId: 'level_1' as FramingNode['parentId'] }
}

const select = (id?: string, levelId: string | null = 'level_1') => ({
  levelId,
  selectedIds: id ? [id] : [],
})

describe('selectedWallInfo', () => {
  test('wall on the active level resolves: name, exterior, framed recipe', () => {
    const nodes = makeScene()
    const config = makeConfig()
    const result = computeLevel(nodes, config)
    const info = selectedWallInfo(nodes, select('wall_ext'), config, result)
    expect(info).not.toBeNull()
    expect(info?.wallId).toBe('wall_ext')
    expect(info?.label).toBe('South wall')
    expect(info?.exterior).toBe(true)
    expect(info?.construction).toBe('framed')
    expect(info?.override).toBeUndefined()
    // 0.15m thick ≥ thickWallThreshold → exterior stud size
    expect(info?.assembly).toBe('2x6 studs @ 16" o.c.')
  })

  test('exterior framed wall carries the climate-zone insulation line', () => {
    const nodes = makeScene()
    const config = makeConfig({ jurisdiction: 'MN' })
    const result = computeLevel(nodes, config)
    const info = selectedWallInfo(nodes, select('wall_ext'), config, result)
    expect(info?.insulation).toMatch(/^R-\d+ cavity · IECC zone /)
    expect(info?.insulation).toContain(result.characteristics?.insulation.climateZone ?? '')
  })

  test('interior partition: not exterior, 2x4, no insulation line', () => {
    const nodes = makeScene()
    const config = makeConfig()
    const result = computeLevel(nodes, config)
    const info = selectedWallInfo(nodes, select('wall_int'), config, result)
    expect(info?.exterior).toBe(false)
    expect(info?.assembly).toBe('2x4 studs @ 16" o.c.')
    expect(info?.insulation).toBeNull()
  })

  test('24" spacing config shows in the recipe', () => {
    const nodes = makeScene()
    const config = makeConfig({ studSpacingIn: 24 })
    const result = computeLevel(nodes, config)
    const info = selectedWallInfo(nodes, select('wall_ext'), config, result)
    expect(info?.assembly).toBe('2x6 studs @ 24" o.c.')
  })

  test('unnamed wall labels with a short id tail', () => {
    const nodes = makeScene()
    const config = makeConfig()
    const result = computeLevel(nodes, config)
    const info = selectedWallInfo(nodes, select('wall_int'), config, result)
    expect(info?.label).toBe('Wall wall_int')
    // long host ids get truncated to a tail (own segment — a cloned
    // position would be a colinear duplicate and resolve to the twin)
    const longId = 'wall_0123456789abcdef'
    nodes[longId] = {
      ...(nodes.wall_int as Record<string, unknown>),
      id: longId,
      name: undefined,
      start: [6, 0],
      end: [6, 4],
    }
    const long = selectedWallInfo(nodes, select(longId), config, computeLevel(nodes, makeConfig()))
    expect(long?.label).toBe('Wall …abcdef')
  })

  test('empty / non-wall / unknown selections hide the card', () => {
    const nodes = makeScene()
    const config = makeConfig()
    const result = computeLevel(nodes, config)
    expect(selectedWallInfo(nodes, select(undefined), config, result)).toBeNull()
    expect(selectedWallInfo(nodes, select('item_1'), config, result)).toBeNull()
    expect(selectedWallInfo(nodes, select('nope'), config, result)).toBeNull()
    expect(selectedWallInfo(nodes, { levelId: 'level_1' }, config, result)).toBeNull()
  })

  test('wall on ANOTHER level than the active one hides the card', () => {
    const nodes = makeScene()
    const config = makeConfig()
    const result = computeLevel(nodes, config)
    // upstairs wall while level_1 is active
    expect(selectedWallInfo(nodes, select('wall_upstairs'), config, result)).toBeNull()
    // no active level at all
    expect(selectedWallInfo(nodes, select('wall_ext', null), config, result)).toBeNull()
  })

  test('hidden wall (dropped by extraction) hides the card', () => {
    const nodes = makeScene()
    const config = makeConfig()
    const result = computeLevel(nodes, config)
    expect(selectedWallInfo(nodes, select('wall_hidden'), config, result)).toBeNull()
  })

  test('missing framing node or result hides the card', () => {
    const nodes = makeScene()
    const config = makeConfig()
    const result = computeLevel(nodes, config)
    expect(selectedWallInfo(nodes, select('wall_ext'), undefined, result)).toBeNull()
    expect(selectedWallInfo(nodes, select('wall_ext'), config, null)).toBeNull()
  })

  test('overrides resolve: cmu shows the block module, skip says so', () => {
    const nodes = makeScene()
    const cmuConfig = makeConfig({ wallOverrides: { wall_ext: 'cmu' } })
    const cmuInfo = selectedWallInfo(
      nodes,
      select('wall_ext'),
      cmuConfig,
      computeLevel(nodes, cmuConfig),
    )
    expect(cmuInfo?.construction).toBe('cmu')
    expect(cmuInfo?.override).toBe('cmu')
    expect(cmuInfo?.assembly).toContain('CMU')
    expect(cmuInfo?.insulation).toBeNull()

    const skipConfig = makeConfig({ wallOverrides: { wall_int: 'skip' } })
    const skipInfo = selectedWallInfo(
      nodes,
      select('wall_int'),
      skipConfig,
      computeLevel(nodes, skipConfig),
    )
    expect(skipInfo?.construction).toBe('skip')
    expect(skipInfo?.assembly).toContain('Skipped')
  })

  test('CMU-default jurisdiction (FL): exterior wall reads cmu with NO override', () => {
    const nodes = makeScene()
    const config = makeConfig({ jurisdiction: 'FL' })
    const result = computeLevel(nodes, config)
    const ext = selectedWallInfo(nodes, select('wall_ext'), config, result)
    expect(ext?.construction).toBe('cmu')
    expect(ext?.override).toBeUndefined()
    const int = selectedWallInfo(nodes, select('wall_int'), config, result)
    expect(int?.construction).toBe('framed')
  })

  test('curved wall still resolves, flagged curved', () => {
    const nodes = makeScene()
    const config = makeConfig()
    const result = computeLevel(nodes, config)
    const info = selectedWallInfo(nodes, select('wall_curved'), config, result)
    expect(info?.curved).toBe(true)
    expect(info?.duplicateNote).toBeNull()
  })

  // GATE (skeptic 2026-08-16): compute's colinear dedupe drops overlapping
  // twins — the card used to claim a stud recipe for the NEVER-FRAMED
  // duplicate and write an inert override against its id. A selected
  // duplicate now resolves to the KEPT twin: its engineering, its id.
  test('coincident duplicate wall resolves to the KEPT twin (same dedupe as compute)', () => {
    const nodes = makeScene()
    // shorter colinear twin overlapping wall_ext's centerline
    nodes.wall_dup = {
      id: 'wall_dup',
      type: 'wall',
      parentId: 'level_1',
      start: [1, 0],
      end: [5, 0],
      thickness: 0.15,
      height: 2.5,
      frontSide: 'exterior',
      backSide: 'interior',
      children: [],
    }
    const config = makeConfig()
    const result = computeLevel(nodes, config)
    // compute itself says the twin is skipped
    expect(result.warnings.some((w) => w.includes('duplicate overlapping wall'))).toBe(true)
    const info = selectedWallInfo(nodes, select('wall_dup'), config, result)
    expect(info).not.toBeNull()
    // engineering + override target = the framed twin, not the duplicate
    expect(info?.wallId).toBe('wall_ext')
    expect(info?.label).toBe('South wall')
    expect(info?.assembly).toBe('2x6 studs @ 16" o.c.')
    expect(info?.duplicateNote).toContain('South wall')
    // the override write lands on the id the engines consume
    const patch = wallOverridePatch(config, info?.wallId ?? '', 'cmu')
    expect(patch.wallOverrides.wall_ext).toBe('cmu')
    expect(patch.wallOverrides.wall_dup).toBeUndefined()
    // the kept wall itself carries no note
    const kept = selectedWallInfo(nodes, select('wall_ext'), config, result)
    expect(kept?.duplicateNote).toBeNull()
  })
})

describe('wallOverridePatch', () => {
  test('merges into existing overrides without dropping siblings', () => {
    const config = makeConfig({ wallOverrides: { wall_a: 'cmu' } })
    const patch = wallOverridePatch(config, 'wall_b', 'skip')
    expect(patch).toEqual({ wallOverrides: { wall_a: 'cmu', wall_b: 'skip' } })
  })

  test('does not mutate the framing node', () => {
    const config = makeConfig({ wallOverrides: { wall_a: 'cmu' } })
    wallOverridePatch(config, 'wall_a', 'framed')
    expect(config.wallOverrides).toEqual({ wall_a: 'cmu' })
  })

  test('write shape matches the schema record', () => {
    const config = makeConfig()
    const patch = wallOverridePatch(config, 'wall_x', 'cmu')
    // round-trips through the zod schema the scene store validates with
    expect(FramingNode.shape.wallOverrides.parse(patch.wallOverrides)).toEqual({
      wall_x: 'cmu',
    })
  })
})

// GATES (mixed-wall UI, S5 write side): the height slider's write shape —
// full height stays the plain legacy string, partial is the object form
// with a course-snapped height the resolver reads straight back.
describe('cmuHeightOverride / cmuHeightControl', () => {
  const H = 2.5 // wall_ext height — 12 whole courses fit under it

  test('full height writes the plain legacy string — byte-equal to today', () => {
    expect(cmuHeightOverride(H, H)).toBe('cmu')
    // at or above every fitting course also collapses to the string
    expect(cmuHeightOverride(H, 12 * COURSE_HEIGHT)).toBe('cmu')
    expect(cmuHeightOverride(H, 99)).toBe('cmu')
    // degenerate wall (shorter than one course) never emits the object form
    expect(cmuHeightOverride(0.1, 0.1)).toBe('cmu')
  })

  test('partial height writes the object form with a course-snapped height', () => {
    const write = cmuHeightOverride(H, 1.0) // ~5 courses
    expect(write).toEqual({ construction: 'cmu', cmuHeightM: 5 * COURSE_HEIGHT })
    // the patch shape round-trips through the zod record the store validates
    const patch = wallOverridePatch(makeConfig(), 'wall_ext', write)
    expect(FramingNode.shape.wallOverrides.parse(patch.wallOverrides)).toEqual({
      wall_ext: write,
    })
  })

  test('snap round-trip: reading the written override back is stable', () => {
    const write = cmuHeightOverride(H, 1.0)
    const ctl = cmuHeightControl(H, write)
    expect(ctl?.valueM).toBeCloseTo(5 * COURSE_HEIGHT, 10)
    // snapping the control's own value is idempotent…
    expect(snapCmuHeight(ctl?.valueM ?? 0, H)).toBeCloseTo(ctl?.valueM ?? 0, 10)
    // …and writing it back produces the identical override
    expect(cmuHeightOverride(H, ctl?.valueM ?? 0)).toEqual(write)
  })

  test('resolver reads the written height back off the patched config', () => {
    const wall = { id: 'wall_ext', exterior: true } as WallSlice
    const partial = makeConfig({ wallOverrides: { wall_ext: cmuHeightOverride(H, 1.0) } })
    expect(resolveWallConstruction(wall, partial, 'framed')).toEqual({
      construction: 'cmu',
      cmuHeightM: 5 * COURSE_HEIGHT,
    })
    // the full-height string resolves with NO height carried — today's path
    const full = makeConfig({ wallOverrides: { wall_ext: cmuHeightOverride(H, H) } })
    expect(resolveWallConstruction(wall, full, 'framed')).toEqual({ construction: 'cmu' })
  })

  test("readout prints 'height · courses · percent'; partial gates the seam note", () => {
    const ctl = cmuHeightControl(2.4384, { construction: 'cmu', cmuHeightM: 1.0 }) // 8ft wall
    expect(ctl?.readout).toBe('1.02m · 5 courses · 42%')
    expect(ctl?.partial).toBe(true)
    const full = cmuHeightControl(2.4384, 'cmu')
    expect(full?.readout).toBe('2.44m · 12 courses · 100%')
    expect(full?.partial).toBe(false)
    // no stored override (jurisdiction-default CMU) also reads full height
    expect(cmuHeightControl(2.4384, undefined)?.readout).toBe('2.44m · 12 courses · 100%')
    // singular course
    expect(cmuHeightControl(0.25, { construction: 'cmu', cmuHeightM: 0.1 })?.readout).toBe(
      '0.20m · 1 course · 100%',
    )
    // both surfaces share the exact seam wording (board spec verbatim)
    expect(CMU_SEAM_NOTE).toBe('PT sill + anchor bolts at the seam — R403.1.6')
  })

  test('slider bounds: 1 course → full wall height, one course per step', () => {
    const ctl = cmuHeightControl(H, 'cmu')
    expect(ctl?.minM).toBe(COURSE_HEIGHT)
    expect(ctl?.maxM).toBe(H)
    expect(ctl?.stepM).toBe(COURSE_HEIGHT)
    expect(ctl?.totalCourses).toBe(12)
  })

  test('wall shorter than one course has no control', () => {
    expect(cmuHeightControl(0.15, 'cmu')).toBeNull()
  })

  test('selectedWallInfo carries the wall height + the stored partial override', () => {
    const nodes = makeScene()
    const write = cmuHeightOverride(H, 1.0)
    const config = makeConfig({ wallOverrides: { wall_ext: write } })
    const info = selectedWallInfo(nodes, select('wall_ext'), config, computeLevel(nodes, config))
    expect(info?.wallHeightM).toBe(H)
    expect(info?.construction).toBe('cmu')
    expect(info?.override).toEqual(write)
  })
})
