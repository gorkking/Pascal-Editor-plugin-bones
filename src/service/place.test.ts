import { describe, expect, test } from 'bun:test'
import { extractRooms, extractSlabs, extractWalls } from '../core/wall-model'
import { placePanelSpot } from '../engines/electrical'
import { placeMeterSpot, placeWhSpot } from '../engines/plumbing'
import { buildServicePointNodes, placedServiceTypes } from './place'
import { ServiceNode } from './schema'

/**
 * The "Place service points" action: creates the five service nodes at the
 * ENGINES' auto positions, idempotently (types already present are skipped).
 */

// Synthetic scene: one level, four exterior walls + a garage divider, a
// garage zone (panel/WH rule) and a bathroom (sewer/stack rule).
function scene(): Record<string, Record<string, unknown>> {
  const wall = (id: string, start: [number, number], end: [number, number], extra = {}) => ({
    id,
    type: 'wall',
    parentId: 'level_1',
    start,
    end,
    thickness: 0.114,
    height: 2.5,
    frontSide: 'exterior',
    children: [],
    ...extra,
  })
  const zone = (id: string, name: string, polygon: [number, number][], boundaryWallIds: string[]) => ({
    id,
    type: 'zone',
    parentId: 'level_1',
    name,
    polygon,
    boundaryWallIds,
  })
  return {
    level_1: { id: 'level_1', type: 'level', level: 0, height: 2.5 },
    w_s: wall('w_s', [0, 0], [10, 0]),
    w_e: wall('w_e', [10, 0], [10, 8]),
    w_n: wall('w_n', [10, 8], [0, 8]),
    w_w: wall('w_w', [0, 8], [0, 0]),
    w_mid: wall('w_mid', [5, 0], [5, 8], { frontSide: 'interior', backSide: 'interior' }),
    z_garage: zone('z_garage', 'Garage', [[0, 0], [5, 0], [5, 8], [0, 8]], ['w_w', 'w_mid']),
    z_bath: zone('z_bath', 'Bathroom', [[5, 0], [10, 0], [10, 4], [5, 4]], []),
  }
}

describe('buildServicePointNodes', () => {
  test('creates all five service types at the engines’ auto spots', () => {
    const nodes = scene()
    const created = buildServicePointNodes(nodes, 'level_1')
    expect(created.map((n) => n.serviceType).sort()).toEqual([
      'panel',
      'power-entry',
      'sewer-exit',
      'water-entry',
      'water-heater',
    ])
    // every node validates against the schema and parents cleanly
    for (const n of created) {
      expect(() => ServiceNode.parse(n)).not.toThrow()
      expect(n.type).toBe('bones:service')
    }

    const slabs = extractSlabs(nodes, 'level_1')
    const walls = extractWalls(nodes, 'level_1', slabs)
    const rooms = extractRooms(nodes, 'level_1')

    // panel node sits exactly at the electrical engine's auto spot
    const panelSpot = placePanelSpot(walls, rooms)
    const panelNode = created.find((n) => n.serviceType === 'panel')
    expect(panelNode?.wallId).toBe(panelSpot?.wall.id ?? '')
    expect(panelNode?.wallT).toBeCloseTo((panelSpot?.u ?? 0) / (panelSpot?.wall.length ?? 1), 6)
    expect(panelNode?.heightAff).toBeCloseTo(panelSpot?.heightAff ?? 0, 6)

    // water-heater and water-entry mirror the plumbing engine's spots
    const whSpot = placeWhSpot(walls, rooms)
    const whNode = created.find((n) => n.serviceType === 'water-heater')
    expect(whNode?.wallId).toBe(whSpot?.wall.id ?? '')
    expect(whNode?.heightAff).toBeCloseTo(whSpot?.heightAff ?? 0, 6)

    const meterSpot = placeMeterSpot(walls)
    const meterNode = created.find((n) => n.serviceType === 'water-entry')
    expect(meterNode?.wallId).toBe(meterSpot?.wall.id ?? '')

    // sewer exit is floor-placed: position only, no wall anchor
    const sewer = created.find((n) => n.serviceType === 'sewer-exit')
    expect(sewer?.wallId).toBeUndefined()
    expect(sewer?.position).not.toEqual([0, 0, 0])
  })

  test('idempotent: existing types are skipped, missing ones fill in', () => {
    const nodes = scene()
    const first = buildServicePointNodes(nodes, 'level_1')
    // simulate the panel + sewer-exit already created on this level
    const panel = first.find((n) => n.serviceType === 'panel') as ServiceNode
    const sewer = first.find((n) => n.serviceType === 'sewer-exit') as ServiceNode
    nodes[panel.id] = { ...panel, parentId: 'level_1' } as unknown as Record<string, unknown>
    nodes[sewer.id] = { ...sewer, parentId: 'level_1' } as unknown as Record<string, unknown>

    const second = buildServicePointNodes(nodes, 'level_1')
    expect(second.map((n) => n.serviceType).sort()).toEqual([
      'power-entry',
      'water-entry',
      'water-heater',
    ])

    // all five present → nothing to create
    for (const n of second) {
      nodes[n.id] = { ...n, parentId: 'level_1' } as unknown as Record<string, unknown>
    }
    expect(buildServicePointNodes(nodes, 'level_1')).toEqual([])
  })

  test('service nodes on ANOTHER level do not block this one', () => {
    const nodes = scene()
    nodes.level_2 = { id: 'level_2', type: 'level', level: 1, height: 2.5 }
    const other = ServiceNode.parse({ serviceType: 'panel', wallId: 'w_x', wallT: 0.5 })
    nodes[other.id] = { ...other, parentId: 'level_2' } as unknown as Record<string, unknown>
    const created = buildServicePointNodes(nodes, 'level_1')
    expect(created.some((n) => n.serviceType === 'panel')).toBe(true)
  })

  test('wall-less level: no wall-anchored nodes, no crash', () => {
    const nodes: Record<string, Record<string, unknown>> = {
      level_1: { id: 'level_1', type: 'level', level: 0, height: 2.5 },
    }
    expect(buildServicePointNodes(nodes, 'level_1')).toEqual([])
  })
})

/**
 * GATE (panel badge/disable): the "Place service points" button counts
 * DISTINCT service types (visible nodes only) — five duplicate panels must
 * NOT read as "all placed" while four types are still missing.
 */
describe('placedServiceTypes', () => {
  const svc = (id: string, serviceType: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'bones:service',
    parentId: 'level_1',
    serviceType,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    ...extra,
  })

  test('duplicates of one type count ONCE', () => {
    const nodes: Record<string, Record<string, unknown>> = {
      a: svc('a', 'panel'),
      b: svc('b', 'panel'),
      c: svc('c', 'panel'),
      d: svc('d', 'panel'),
      e: svc('e', 'panel'),
      f: svc('f', 'water-heater'),
    }
    const types = placedServiceTypes(nodes, 'level_1')
    expect(types.size).toBe(2)
    expect([...types].sort()).toEqual(['panel', 'water-heater'])
    // …so the action still has three types to create
    const created = buildServicePointNodes({ ...scene(), ...nodes }, 'level_1')
    expect(created.map((n) => n.serviceType).sort()).toEqual([
      'power-entry',
      'sewer-exit',
      'water-entry',
    ])
  })

  test('hidden nodes and foreign levels/types do not count', () => {
    const nodes: Record<string, Record<string, unknown>> = {
      a: svc('a', 'panel', { visible: false }),
      b: svc('b', 'water-heater', { parentId: 'level_2' }),
      c: svc('c', 'flux-capacitor'),
      d: svc('d', 'sewer-exit'),
    }
    const types = placedServiceTypes(nodes, 'level_1')
    expect([...types]).toEqual(['sewer-exit'])
  })
})
