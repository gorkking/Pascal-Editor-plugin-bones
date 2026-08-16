import { describe, expect, test } from 'bun:test'
import { computeLevel } from './framing/compute'
import { FramingNode } from './framing/schema'
import { selectedWallInfo, wallOverridePatch } from './panel-selection'

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
    // long host ids get truncated to a tail
    const longId = 'wall_0123456789abcdef'
    nodes[longId] = { ...(nodes.wall_int as Record<string, unknown>), id: longId, name: undefined }
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
