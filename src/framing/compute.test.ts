import { describe, expect, test } from 'bun:test'
import type { WallSlice } from '../core/types'
import { FramingNode } from './schema'
import { computeLevel, wallConstruction } from './compute'

/** A minimal one-level scene: two exterior walls, one interior, one curved. */
function makeScene(): Record<string, Record<string, unknown>> {
  return {
    level_1: { id: 'level_1', type: 'level', level: 0, height: 2.7 },
    wall_ext: {
      id: 'wall_ext',
      type: 'wall',
      parentId: 'level_1',
      start: [0, 0],
      end: [6, 0],
      thickness: 0.15,
      height: 2.5,
      frontSide: 'exterior',
      backSide: 'interior',
      children: ['door_1'],
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
      curveOffset: 0.5,
      children: [],
    },
    door_1: { id: 'door_1', type: 'door', position: [2, 1.05, 0], width: 0.9, height: 2.1 },
  }
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  const config = FramingNode.parse({ jurisdiction: 'INTL', ...overrides })
  return { ...config, parentId: 'level_1' as FramingNode['parentId'] }
}

describe('computeLevel', () => {
  test('frames straight walls, warns on curved ones', () => {
    const result = computeLevel(makeScene(), makeConfig())
    expect(result.members.filter((m) => m.system === 'wall-framing').length).toBeGreaterThan(20)
    expect(result.warnings.some((w) => w.includes('Curved'))).toBe(true)
    // door framing came through the pipeline
    expect(result.members.some((m) => m.role === 'header')).toBe(true)
  })

  test('showWalls: false silences wall framing', () => {
    const result = computeLevel(makeScene(), makeConfig({ showWalls: false }))
    expect(result.members.filter((m) => m.system === 'wall-framing')).toHaveLength(0)
  })

  test('jurisdiction resolves AUTO without touching the network', () => {
    const result = computeLevel(makeScene(), makeConfig({ jurisdiction: 'AUTO' }))
    expect(result.jurisdiction).not.toBe('AUTO')
    expect(result.jurisdiction.length).toBeGreaterThanOrEqual(2)
  })

  test('LOD 300 in a deep-frost state digs deeper footings than LOD 200', () => {
    const at200 = computeLevel(makeScene(), makeConfig({ jurisdiction: 'MN', detail: '200' }))
    const at300 = computeLevel(makeScene(), makeConfig({ jurisdiction: 'MN', detail: '300' }))
    expect(at300.spec.footingDepth).toBeGreaterThanOrEqual(at200.spec.footingDepth)
  })

  test('per-wall skip override removes that wall from the skeleton', () => {
    const result = computeLevel(
      makeScene(),
      makeConfig({ wallOverrides: { wall_ext: 'skip' } }),
    )
    expect(result.members.some((m) => m.sourceId === 'wall_ext')).toBe(false)
    expect(
      result.members.some((m) => m.sourceId === 'wall_int' && m.system === 'wall-framing'),
    ).toBe(true)
  })
})

describe('wallConstruction', () => {
  const wall = (exterior: boolean): WallSlice => ({
    id: 'w',
    start: [0, 0],
    end: [4, 0],
    length: 4,
    dir: [1, 0],
    thickness: 0.15,
    height: 2.5,
    exterior,
    openings: [],
    curved: false,
  })

  test('override beats jurisdiction default', () => {
    expect(wallConstruction(wall(true), { wallOverrides: { w: 'framed' } }, 'cmu')).toBe('framed')
    expect(wallConstruction(wall(true), { wallOverrides: { w: 'skip' } }, 'framed')).toBe('skip')
  })

  test('exterior default applies only to exterior walls', () => {
    expect(wallConstruction(wall(true), { wallOverrides: {} }, 'cmu')).toBe('cmu')
    expect(wallConstruction(wall(false), { wallOverrides: {} }, 'cmu')).toBe('framed')
    expect(wallConstruction(wall(true), { wallOverrides: {} }, 'framed')).toBe('framed')
  })
})
