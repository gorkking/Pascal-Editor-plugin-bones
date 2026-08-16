import { describe, expect, test } from 'bun:test'
import type { WallSlice } from '../core/types'
import { extractServiceOverrides } from '../core/wall-model'
import { FramingNode } from './schema'
import { computeLevel, resolveWallConstruction, wallConstruction } from './compute'

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

  // RO-warning PARITY (skeptic 2026-08-16): thermostat + electric-meter
  // overrides used to mount silently inside window ROs while panel/WH/
  // water-entry warned — every verbatim service mount gets the same gate.
  test('thermostat override inside the window RO → explicit warning; clear → none', () => {
    const inRo = computeLevel(
      roScene({ svc_t: svc('svc_t', 'thermostat', 0.52, 1.5) }),
      makeConfig({ showHvac: true }),
    )
    expect(inRo.warnings).toContain(
      'Service point “thermostat” sits in a door/window rough opening — move it clear',
    )
    const clear = computeLevel(
      roScene({ svc_t: svc('svc_t', 'thermostat', 0.9, 1.5) }),
      makeConfig({ showHvac: true }),
    )
    expect(clear.warnings.some((w) => w.includes('Service point “thermostat”'))).toBe(false)
  })

  test('electric-meter override inside the window RO → explicit warning; clear → none', () => {
    const inRo = computeLevel(
      roScene({ svc_em: svc('svc_em', 'electric-meter', 0.52, 1.4) }),
      makeConfig({ showElectrical: true }),
    )
    expect(inRo.warnings).toContain(
      'Service point “electric-meter” sits in a door/window rough opening — move it clear',
    )
    const clear = computeLevel(
      roScene({ svc_em: svc('svc_em', 'electric-meter', 0.9, 1.4) }),
      makeConfig({ showElectrical: true }),
    )
    expect(clear.warnings.some((w) => w.includes('Service point “electric-meter”'))).toBe(false)
  })
})

/**
 * GATE (duplicate service nodes): two nodes of one type on a level must not
 * resolve by object insertion order (host-dependent) — the LOWEST id wins,
 * deterministically, and computeLevel says the extra is ignored.
 */
describe('computeLevel — duplicate service points', () => {
  function dupScene(): Record<string, Record<string, unknown>> {
    const wall = (id: string, start: [number, number], end: [number, number]) => ({
      id,
      type: 'wall',
      parentId: 'level_1',
      start,
      end,
      thickness: 0.114,
      height: 2.5,
      frontSide: 'exterior',
      children: [],
    })
    const panel = (id: string, wallT: number) => ({
      id,
      type: 'bones:service',
      parentId: 'level_1',
      serviceType: 'panel',
      wallId: 'w_s',
      wallT,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    })
    return {
      level_1: { id: 'level_1', type: 'level', level: 0, height: 2.5 },
      w_s: wall('w_s', [0, 0], [8, 0]),
      w_e: wall('w_e', [8, 0], [8, 6]),
      w_n: wall('w_n', [8, 6], [0, 6]),
      w_w: wall('w_w', [0, 6], [0, 0]),
      // inserted FIRST but higher id — must NOT win
      svc_z: panel('svc_z', 0.2),
      svc_a: panel('svc_a', 0.9),
    }
  }

  test('extraction: lowest id wins, the type is reported as duplicated', () => {
    const { overrides, duplicates } = extractServiceOverrides(dupScene(), 'level_1')
    expect(duplicates).toEqual(['panel'])
    expect(overrides.panel?.wallT).toBeCloseTo(0.9, 6) // svc_a, not first-inserted svc_z
  })

  test('computeLevel warns and mounts the panel at the winner', () => {
    const result = computeLevel(dupScene(), makeConfig({ showElectrical: true }))
    expect(result.warnings).toContain('duplicate service point (panel) — extra node ignored')
    const panel = result.fixtures.find((f) => f.kind === 'panel')
    expect(panel?.position[0]).toBeCloseTo(0.9 * 8, 1) // svc_a's wallT on the 8 m wall
  })

  test('a single node per type stays warning-free', () => {
    const nodes = dupScene()
    delete nodes.svc_z
    const result = computeLevel(nodes, makeConfig({ showElectrical: true }))
    expect(result.warnings.some((w) => w.includes('duplicate service point'))).toBe(false)
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

  test('object override resolves like its construction string', () => {
    expect(
      wallConstruction(wall(true), { wallOverrides: { w: { construction: 'cmu' } } }, 'framed'),
    ).toBe('cmu')
  })
})

/**
 * GATE (mixed wall construction — schema + resolution): the override union
 * accepts the legacy strings AND { construction: 'cmu', cmuHeightM } (back-
 * compat: absent height = full-height CMU, exactly like the string).
 */
describe('resolveWallConstruction — mixed CMU/framed overrides', () => {
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

  test('string overrides resolve with no cmuHeightM (full height, as today)', () => {
    expect(resolveWallConstruction(wall(true), { wallOverrides: { w: 'cmu' } }, 'framed')).toEqual({
      construction: 'cmu',
    })
    expect(resolveWallConstruction(wall(true), { wallOverrides: {} }, 'cmu')).toEqual({
      construction: 'cmu',
    })
    expect(resolveWallConstruction(wall(false), { wallOverrides: {} }, 'cmu')).toEqual({
      construction: 'framed',
    })
  })

  test('object override without a height = full-height CMU as today', () => {
    expect(
      resolveWallConstruction(
        wall(true),
        { wallOverrides: { w: { construction: 'cmu' } } },
        'framed',
      ),
    ).toEqual({ construction: 'cmu' })
  })

  test('object override carries the requested height through verbatim', () => {
    expect(
      resolveWallConstruction(
        wall(true),
        { wallOverrides: { w: { construction: 'cmu', cmuHeightM: 1.2 } } },
        'framed',
      ),
    ).toEqual({ construction: 'cmu', cmuHeightM: 1.2 })
  })

  test('schema: FramingNode parses both override forms and rejects junk', () => {
    const parsed = FramingNode.parse({
      jurisdiction: 'FL',
      wallOverrides: {
        a: 'framed',
        b: 'cmu',
        c: { construction: 'cmu', cmuHeightM: 1.016 },
        d: { construction: 'cmu' },
      },
    })
    expect(parsed.wallOverrides.a).toBe('framed')
    expect(parsed.wallOverrides.c).toEqual({ construction: 'cmu', cmuHeightM: 1.016 })
    expect(parsed.wallOverrides.d).toEqual({ construction: 'cmu' })
    expect(() =>
      FramingNode.parse({ wallOverrides: { x: { construction: 'framed', cmuHeightM: 1 } } }),
    ).toThrow()
    expect(() =>
      FramingNode.parse({ wallOverrides: { x: { construction: 'cmu', cmuHeightM: -1 } } }),
    ).toThrow()
  })
})

/**
 * GATE (extended service points): thermostat / heat-pump / electric-meter
 * nodes flow through computeLevel's extraction EXTENSION (compute.ts owns it
 * — wall-model.ts stays untouched) into the hvac + electrical engines, with
 * the same lowest-id duplicate rule as the core five.
 */
describe('computeLevel — thermostat / heat-pump / electric-meter nodes', () => {
  function hvacScene(service: Record<string, Record<string, unknown>> = {}) {
    const wall = (id: string, start: [number, number], end: [number, number]) => ({
      id,
      type: 'wall',
      parentId: 'level_1',
      start,
      end,
      thickness: 0.114,
      height: 2.5,
      frontSide: 'exterior',
      backSide: 'interior',
      children: [],
    })
    return {
      level_1: { id: 'level_1', type: 'level', level: 0, height: 2.5 },
      w_s: wall('w_s', [0, 0], [8, 0]),
      w_e: wall('w_e', [8, 0], [8, 6]),
      w_n: wall('w_n', [8, 6], [0, 6]),
      w_w: wall('w_w', [0, 6], [0, 0]),
      z_bed: {
        id: 'z_bed',
        type: 'zone',
        parentId: 'level_1',
        name: 'Bedroom',
        polygon: [[0, 0], [8, 0], [8, 6], [0, 6]],
      },
      ...service,
    }
  }
  const svc = (id: string, serviceType: string, extra: Record<string, unknown>) => ({
    id,
    type: 'bones:service',
    parentId: 'level_1',
    serviceType,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    ...extra,
  })

  test('thermostat node re-mounts the tstat fixture (verbatim wall anchor)', () => {
    const result = computeLevel(
      hvacScene({ svc_t: svc('svc_t', 'thermostat', { wallId: 'w_e', wallT: 0.5, heightAff: 1.3 }) }),
      makeConfig({ showHvac: true }),
    )
    const tstat = result.fixtures.find((f) => f.kind === 'thermostat')
    expect(tstat).toBeDefined()
    // w_e runs [8,0] → [8,6]; t=0.5 → [8,3]
    expect(tstat?.position[0]).toBeCloseTo(8, 6)
    expect(tstat?.position[2]).toBeCloseTo(3, 6)
    expect(tstat?.position[1]).toBeCloseTo(1.3, 6)
  })

  test('heat-pump node re-anchors the outdoor unit + lineset', () => {
    const result = computeLevel(
      hvacScene({ svc_hp: svc('svc_hp', 'heat-pump', { position: [10, 0, 3] }) }),
      makeConfig({ showHvac: true }),
    )
    const condenser = result.fixtures.find((f) => f.label?.includes('Condenser'))
    expect(condenser?.position[0]).toBeCloseTo(10, 6)
    expect(condenser?.position[2]).toBeCloseTo(3, 6)
    expect(result.members.some((m) => m.label?.includes('lineset'))).toBe(true)
    expect(
      result.members.some((m) => m.role === 'equipment' && m.material === 'concrete'),
    ).toBe(true)
  })

  test('electric-meter node re-mounts the meter (electrical engine consumer)', () => {
    const result = computeLevel(
      hvacScene({ svc_em: svc('svc_em', 'electric-meter', { wallId: 'w_n', wallT: 0.25, heightAff: 1.4 }) }),
      makeConfig({ showElectrical: true }),
    )
    const meter = result.fixtures.find((f) => f.kind === 'electric-meter')
    expect(meter).toBeDefined()
    // w_n runs [8,6] → [0,6]; t=0.25 → [6,6] (± the exterior-face offset)
    expect(Math.abs((meter?.position[0] ?? 0) - 6)).toBeLessThan(0.05)
    expect(Math.abs((meter?.position[2] ?? 0) - 6)).toBeLessThan(0.2)
    expect(meter?.position[1]).toBeCloseTo(1.4, 6)
  })

  test('duplicate thermostat nodes: lowest id wins + warning (extension parity)', () => {
    const result = computeLevel(
      hvacScene({
        // inserted first but HIGHER id — must not win
        svc_z: svc('svc_z', 'thermostat', { wallId: 'w_e', wallT: 0.1 }),
        svc_a: svc('svc_a', 'thermostat', { wallId: 'w_e', wallT: 0.9 }),
      }),
      makeConfig({ showHvac: true }),
    )
    expect(result.warnings).toContain('duplicate service point (thermostat) — extra node ignored')
    const tstat = result.fixtures.find((f) => f.kind === 'thermostat')
    expect(tstat?.position[2]).toBeCloseTo(0.9 * 6, 6) // svc_a's wallT on the 6 m wall
  })
})
