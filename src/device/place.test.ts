import { describe, expect, test } from 'bun:test'
import type { Fixture, WallSlice } from '../core/types'
import { layoutElectrical } from '../engines/electrical'
import { deriveWallDevices } from './derive'
import { reconcileDeviceNodes } from './place'

/**
 * The bones:device reconciler — every derived wall device gets a node, and
 * the diff never fights the user:
 *  - CREATE at the derived anchor, seed = anchor (creation moves nothing);
 *  - RE-SEAT unmoved nodes when the derivation drifts;
 *  - NEVER touch a moved node's anchor (deviceKind still follows);
 *  - REMOVE orphans + duplicate extras.
 * Plus deriveWallDevices: switch fixtures resolve their wall via the
 * OPENING id, hallway switches via the nearest wall.
 */

function makeWall(overrides: Partial<WallSlice> = {}): WallSlice {
  const start = overrides.start ?? [0, 0]
  const end = overrides.end ?? [6, 0]
  const dx = (end[0] ?? 0) - (start[0] ?? 0)
  const dz = (end[1] ?? 0) - (start[1] ?? 0)
  const length = Math.hypot(dx, dz)
  return {
    id: 'w1',
    start,
    end,
    dir: [dx / length, dz / length],
    length,
    thickness: 0.114,
    height: 2.44,
    exterior: true,
    openings: [],
    curved: false,
    ...overrides,
  }
}

describe('deriveWallDevices', () => {
  test('receptacles anchor their own wall; door switches resolve via the opening', () => {
    const wall = makeWall({
      id: 'w_door',
      start: [0, 0],
      end: [8, 0],
      openings: [
        {
          id: 'open_1',
          kind: 'door',
          u: 4,
          width: 0.9,
          roughWidth: 0.95,
          height: 2.1,
          roughHeight: 2.15,
          sillHeight: 0,
        },
      ],
    })
    const fixtures = layoutElectrical([wall], [])
    const devices = deriveWallDevices(fixtures, [wall])
    expect(devices.length).toBeGreaterThan(0)
    for (const d of devices) {
      expect(d.wallId).toBe('w_door')
      expect(d.wallT).toBeGreaterThanOrEqual(0)
      expect(d.wallT).toBeLessThanOrEqual(1)
      expect(Number.isFinite(d.heightAff)).toBe(true)
    }
    const sw = devices.find((d) => d.deviceKind === 'switch')
    expect(sw?.deviceId).toContain('open_1')
  })

  test('hallway switches (room-sourced) resolve to the nearest wall', () => {
    const wall = makeWall({ id: 'w_hall', start: [0, 0], end: [6, 0], exterior: false })
    const hallway = {
      id: 'room_hall',
      name: 'Hallway',
      category: 'hallway' as const,
      polygon: [
        [0, 0],
        [6, 0],
        [6, 2],
        [0, 2],
      ] as [number, number][],
      boundaryWallIds: [],
      ceilingHeight: 2.5,
    }
    const fixtures = layoutElectrical([wall], [hallway])
    const hallSwitch = fixtures.find(
      (f) => f.kind === 'switch' && String(f.meta?.deviceId).includes('-hall-'),
    ) as Fixture
    expect(hallSwitch).toBeDefined()
    const devices = deriveWallDevices([hallSwitch], [wall])
    expect(devices).toHaveLength(1)
    expect(devices[0]?.wallId).toBe('w_hall')
  })
})

describe('reconcileDeviceNodes', () => {
  const derived = (deviceId: string, wallT: number, heightAff = 0.381) => ({
    deviceId,
    deviceKind: 'receptacle' as const,
    wallId: 'w1',
    wallT,
    heightAff,
  })
  const existing = (
    id: string,
    deviceId: string,
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id,
    type: 'bones:device',
    parentId: 'level_1',
    deviceId,
    deviceKind: 'receptacle',
    wallId: 'w1',
    wallT: 0.25,
    heightAff: 0.381,
    seedWallId: 'w1',
    seedWallT: 0.25,
    seedHeightAff: 0.381,
    position: [0, 0, 0],
    ...fields,
  })

  test('creates missing nodes at the derived anchor with seed == anchor', () => {
    const plan = reconcileDeviceNodes({}, 'level_1', [derived('recep:w1:0:p', 0.25)])
    expect(plan.update).toEqual([])
    expect(plan.remove).toEqual([])
    expect(plan.create).toHaveLength(1)
    const node = plan.create[0]
    expect(node?.deviceId).toBe('recep:w1:0:p')
    expect(node?.wallT).toBe(0.25)
    expect(node?.seedWallT).toBe(0.25)
    expect(node?.wallId).toBe('w1')
    expect(node?.seedWallId).toBe('w1')
    expect(node?.heightAff).toBeCloseTo(0.381, 9)
    expect(node?.seedHeightAff).toBeCloseTo(0.381, 9)
    expect(node?.position).toEqual([0, 0, 0])
  })

  test('a stable scene plans ZERO ops (the reconcile effect converges)', () => {
    const plan = reconcileDeviceNodes(
      { a: existing('a', 'recep:w1:0:p') },
      'level_1',
      [derived('recep:w1:0:p', 0.25)],
    )
    expect(plan.create).toEqual([])
    expect(plan.update).toEqual([])
    expect(plan.remove).toEqual([])
  })

  test('re-seats an UNMOVED node (anchor + seed) when the derivation drifts', () => {
    const plan = reconcileDeviceNodes(
      { a: existing('a', 'recep:w1:0:p') },
      'level_1',
      [derived('recep:w1:0:p', 0.4, 0.5)],
    )
    expect(plan.update).toEqual([
      {
        id: 'a',
        data: {
          wallId: 'w1',
          wallT: 0.4,
          heightAff: 0.5,
          seedWallId: 'w1',
          seedWallT: 0.4,
          seedHeightAff: 0.5,
        },
      },
    ])
  })

  test('NEVER touches a moved node’s anchor; deviceKind still follows the engine', () => {
    const movedOnly = reconcileDeviceNodes(
      { a: existing('a', 'recep:w1:0:p', { wallT: 0.8 }) },
      'level_1',
      [derived('recep:w1:0:p', 0.4)],
    )
    expect(movedOnly.update).toEqual([])
    expect(movedOnly.remove).toEqual([])
    // GFCI zone change: same moved box, new derived kind
    const kindFlip = reconcileDeviceNodes(
      { a: existing('a', 'recep:w1:0:p', { wallT: 0.8 }) },
      'level_1',
      [{ ...derived('recep:w1:0:p', 0.4), deviceKind: 'receptacle-gfci' as const }],
    )
    expect(kindFlip.update).toEqual([{ id: 'a', data: { deviceKind: 'receptacle-gfci' } }])
  })

  test('removes orphans (moved or not) and duplicate extras (lowest id wins)', () => {
    const plan = reconcileDeviceNodes(
      {
        gone: existing('gone', 'recep:w1:9:p', { wallT: 0.9 }),
        z: existing('z', 'recep:w1:0:p'),
        a: existing('a', 'recep:w1:0:p'),
      },
      'level_1',
      [derived('recep:w1:0:p', 0.25)],
    )
    expect(plan.remove.sort()).toEqual(['gone', 'z'])
    expect(plan.create).toEqual([])
  })

  test('foreign-level nodes are out of scope', () => {
    const plan = reconcileDeviceNodes(
      { other: existing('other', 'recep:w1:0:p', { parentId: 'level_2' }) },
      'level_1',
      [derived('recep:w1:0:p', 0.25)],
    )
    expect(plan.remove).toEqual([])
    expect(plan.create).toHaveLength(1) // level_1 still needs its own node
  })
})
