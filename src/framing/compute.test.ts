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

/**
 * GATE (silent RO/compliance bypass): a `bones:service` override is honored
 * verbatim (A4), but forcing the point into a door/window rough opening MUST
 * surface a warning — placePanel's forced branch skips panelMountU's
 * clearance scan (visual round: unflagged window-RO panel at wallT 0.52).
 */
describe('computeLevel — service override in a rough opening warns', () => {
  // 8×6 shell; w_s carries a door at u=2 and a window at u=4.16 (wallT 0.52).
  function roScene(service: Record<string, Record<string, unknown>> = {}) {
    const wall = (id: string, start: [number, number], end: [number, number], children: string[] = []) => ({
      id,
      type: 'wall',
      parentId: 'level_1',
      start,
      end,
      thickness: 0.114,
      height: 2.5,
      frontSide: 'exterior',
      backSide: 'interior',
      children,
    })
    return {
      level_1: { id: 'level_1', type: 'level', level: 0, height: 2.5 },
      w_s: wall('w_s', [0, 0], [8, 0], ['door_1', 'win_1']),
      w_e: wall('w_e', [8, 0], [8, 6]),
      w_n: wall('w_n', [8, 6], [0, 6]),
      w_w: wall('w_w', [0, 6], [0, 0]),
      door_1: { id: 'door_1', type: 'door', position: [2, 1.05, 0], width: 0.9, height: 2.1 },
      win_1: { id: 'win_1', type: 'window', position: [4.16, 1.5, 0], width: 1.2, height: 1.5 },
      z_bath: {
        id: 'z_bath',
        type: 'zone',
        parentId: 'level_1',
        name: 'Bathroom',
        polygon: [[5, 0], [8, 0], [8, 4], [5, 4]],
      },
      fx_wc: {
        id: 'fx_wc',
        type: 'item',
        parentId: 'level_1',
        asset: { id: 'toilet' },
        position: [7.5, 0, 0.5],
        rotation: [0, 0, 0],
      },
      ...service,
    }
  }
  const svc = (
    id: string,
    serviceType: string,
    wallT: number,
    heightAff?: number,
  ): Record<string, unknown> => ({
    id,
    type: 'bones:service',
    parentId: 'level_1',
    serviceType,
    wallId: 'w_s',
    wallT,
    ...(heightAff === undefined ? {} : { heightAff }),
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  })
  const PANEL_RO_WARNING =
    'Service point “panel” sits in a door/window rough opening — move it clear (NEC 110.26)'

  test('panel override inside the window RO → explicit warning', () => {
    const result = computeLevel(
      roScene({ svc_p: svc('svc_p', 'panel', 0.52) }),
      makeConfig({ showElectrical: true }),
    )
    expect(result.warnings).toContain(PANEL_RO_WARNING)
  })

  test('panel override clear of every RO → no warning', () => {
    const result = computeLevel(
      roScene({ svc_p: svc('svc_p', 'panel', 0.9) }),
      makeConfig({ showElectrical: true }),
    )
    expect(result.warnings).not.toContain(PANEL_RO_WARNING)
  })

  test('water-entry override inside the door RO → explicit warning', () => {
    // u = 0.25 × 8 = 2 — dead center of the door; meter mounts at 0.3 m AFF.
    const result = computeLevel(
      roScene({ svc_m: svc('svc_m', 'water-entry', 0.25) }),
      makeConfig({ showPlumbing: true }),
    )
    expect(result.warnings).toContain(
      'Service point “water-entry” sits in a door/window rough opening — move it clear',
    )
  })

  test('water-heater override inside the window RO → explicit warning; clear → none', () => {
    const inRo = computeLevel(
      roScene({ svc_wh: svc('svc_wh', 'water-heater', 0.52, 1.5) }),
      makeConfig({ showPlumbing: true }),
    )
    expect(inRo.warnings).toContain(
      'Service point “water-heater” sits in a door/window rough opening — move it clear',
    )
    const clear = computeLevel(
      roScene({ svc_wh: svc('svc_wh', 'water-heater', 0.9, 1.5) }),
      makeConfig({ showPlumbing: true }),
    )
    expect(
      clear.warnings.some((w) => w.includes('Service point “water-heater”')),
    ).toBe(false)
  })

  test('no override → auto placement never triggers the service-point warning', () => {
    const result = computeLevel(
      roScene(),
      makeConfig({ showElectrical: true, showPlumbing: true }),
    )
    expect(result.warnings.some((w) => w.includes('Service point'))).toBe(false)
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
