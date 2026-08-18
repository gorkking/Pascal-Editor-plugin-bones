import { describe, expect, test } from 'bun:test'
import baseline from './master-baseline.json'
import type { Fixture } from '../core/types'
import { DEVICE_TOL, endpointsOf, unreachableDevices } from '../engines/electrical.test-helpers'
import { baselineConfig, baselineScene } from './baseline-scene'
import { computeLevel } from './compute'
import { FramingNode } from './schema'

/**
 * Movable outlets — computeLevel integration + the CRITICAL S6-style
 * byte-equality regression:
 *  - a scene with ZERO device nodes/overrides computes members STRICTLY
 *    byte-equal to MASTER (pinned in master-baseline.json, captured at
 *    724d9ad before this feature) and fixtures identical except the added
 *    `meta.deviceId` key;
 *  - a scene of SEEDED-BUT-UNMOVED device nodes stays byte-equal too (the
 *    reconciler's creations change nothing);
 *  - a MOVED node re-routes the wiring to the moved box (wire endpoint ON
 *    the box, E2 continuity preserved), warns on RO-forced spots, and
 *    duplicate nodes warn like duplicate service points;
 *  - result.devices manifests every device fixture 1:1.
 */

type BaselineEntry = {
  members: unknown[]
  fixtures: { kind: string; meta?: Record<string, unknown> }[]
  warnings: string[]
}

/** JSON-normalized (−0 → 0, exact float round-trip) deep clone. */
const norm = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Strip exactly the ONE added meta key. */
const stripDeviceIds = (fixtures: Fixture[]): unknown[] =>
  norm(fixtures).map((f: Fixture) => {
    if (!f.meta || !('deviceId' in f.meta)) return f
    const { deviceId: _dropped, ...rest } = f.meta
    return { ...f, meta: rest }
  })

describe('BYTE-EQUALITY vs master (zero device nodes/overrides)', () => {
  for (const jurisdiction of ['INTL', 'TX'] as const) {
    test(`${jurisdiction}: members strictly byte-equal; fixtures equal minus meta.deviceId`, () => {
      const pinned = (baseline as Record<string, BaselineEntry>)[jurisdiction] as BaselineEntry
      const result = computeLevel(baselineScene(), baselineConfig(jurisdiction))
      expect(norm(result.members)).toEqual(pinned.members as never)
      expect(stripDeviceIds(result.fixtures)).toEqual(pinned.fixtures as never)
      expect(norm(result.warnings)).toEqual(pinned.warnings as never)
      // and the ONLY meta delta really is deviceId, on device kinds only
      for (const f of result.fixtures) {
        const isDevice =
          f.kind === 'receptacle' || f.kind === 'receptacle-gfci' || f.kind === 'switch'
        expect(typeof f.meta?.deviceId === 'string').toBe(isDevice)
      }
    })
  }
})

// ---- integration scenes -----------------------------------------------------

const seededNodesFor = (
  scene: Record<string, Record<string, unknown>>,
  config: FramingNode,
): Record<string, Record<string, unknown>> => {
  const base = computeLevel(scene, config)
  const out = { ...scene }
  base.devices.forEach((d, i) => {
    const id = `bonesdevice_${String(i).padStart(3, '0')}`
    out[id] = {
      id,
      type: 'bones:device',
      parentId: 'level_1',
      visible: true,
      deviceId: d.deviceId,
      deviceKind: d.deviceKind,
      wallId: d.wallId,
      wallT: d.wallT,
      heightAff: d.heightAff,
      seedWallId: d.wallId,
      seedWallT: d.wallT,
      seedHeightAff: d.heightAff,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    }
  })
  return out
}

describe('computeLevel — device nodes end to end', () => {
  const config = () => baselineConfig('INTL')

  test('result.devices manifests every device fixture 1:1, unique ids', () => {
    const result = computeLevel(baselineScene(), config())
    const deviceFixtures = result.fixtures.filter(
      (f) => f.kind === 'receptacle' || f.kind === 'receptacle-gfci' || f.kind === 'switch',
    )
    expect(result.devices.length).toBe(deviceFixtures.length)
    const ids = result.devices.map((d) => d.deviceId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const d of result.devices) {
      expect(d.wallT).toBeGreaterThanOrEqual(0)
      expect(d.wallT).toBeLessThanOrEqual(1)
    }
  })

  test('SEEDED-BUT-UNMOVED nodes: members + fixtures byte-equal to the node-less scene', () => {
    const scene = baselineScene()
    const base = computeLevel(scene, config())
    const seeded = computeLevel(seededNodesFor(scene, config()), config())
    expect(seeded.members).toEqual(base.members)
    expect(seeded.fixtures).toEqual(base.fixtures)
    expect(seeded.warnings).toEqual(base.warnings)
  })

  test('MOVED node: the box moves, the wiring lands ON the moved box, E2 continuity holds', () => {
    const scene = baselineScene()
    const base = computeLevel(scene, config())
    const target = base.devices.find(
      (d) => d.deviceKind !== 'switch' && d.wallId === 'w_n',
    ) as NonNullable<(typeof base.devices)[number]>
    expect(target).toBeDefined()
    const baseFx = base.fixtures.find((f) => f.meta?.deviceId === target.deviceId) as Fixture

    const movedScene = seededNodesFor(scene, config())
    const nodeId = Object.keys(movedScene).find(
      (k) => movedScene[k]?.deviceId === target.deviceId,
    ) as string
    movedScene[nodeId] = {
      ...(movedScene[nodeId] as Record<string, unknown>),
      wallT: Math.min(1, target.wallT + 0.08),
      heightAff: 0.9,
    }
    const moved = computeLevel(movedScene, config())
    const movedFx = moved.fixtures.find((f) => f.meta?.deviceId === target.deviceId) as Fixture
    expect(movedFx).toBeDefined()
    // the box moved (position wins, engine-snapped)
    expect(movedFx.position).not.toEqual(baseFx.position)
    expect(movedFx.position[1]).toBeCloseTo(0.9, 6)
    // a wire endpoint lands ON the moved box (routeWiring consumed the
    // post-override position)
    const wires = moved.members.filter((m) => m.role === 'wire-run')
    const onBox = wires.some((w) =>
      endpointsOf(w).some(
        (e) =>
          Math.hypot(
            e.x - movedFx.position[0],
            e.y - movedFx.position[1],
            e.z - movedFx.position[2],
          ) < DEVICE_TOL,
      ),
    )
    expect(onBox).toBe(true)
    // panel-reachability is not broken by the move (checklist E2)
    expect(unreachableDevices(moved.members, moved.fixtures)).toEqual([])
  })

  test('RO-forced override warns (service parity); duplicates warn', () => {
    const scene = baselineScene()
    const base = computeLevel(scene, config())
    const target = base.devices.find(
      (d) => d.wallId === 'w_s' && d.deviceKind !== 'switch',
    ) as NonNullable<(typeof base.devices)[number]>
    const movedScene = seededNodesFor(scene, config())
    const nodeId = Object.keys(movedScene).find(
      (k) => movedScene[k]?.deviceId === target.deviceId,
    ) as string
    // door_front sits at u=3 on the 12 m south wall → wallT 0.25
    movedScene[nodeId] = {
      ...(movedScene[nodeId] as Record<string, unknown>),
      wallT: 0.25,
    }
    // plus a duplicate node for the same deviceId
    movedScene.bonesdevice_dup = {
      id: 'bonesdevice_dup',
      type: 'bones:device',
      parentId: 'level_1',
      visible: true,
      deviceId: target.deviceId,
      deviceKind: target.deviceKind,
      wallId: target.wallId,
      wallT: 0.9,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    }
    const result = computeLevel(movedScene, config())
    expect(result.warnings.some((w) => w.includes('rough opening'))).toBe(true)
    expect(
      result.warnings.some((w) =>
        w.includes(`duplicate device node (${target.deviceId}) — extra node ignored`),
      ),
    ).toBe(true)
    // the box itself is OUT of the RO band (snapped clear, never a squatter)
    const fx = result.fixtures.find((f) => f.meta?.deviceId === target.deviceId) as Fixture
    const u = fx.position[0] // w_s runs +X from x=0
    expect(u < 3 - 0.475 || u > 3 + 0.475).toBe(true)
  })

  test('electrical OFF: no manifest, no device meta anywhere', () => {
    const scene = baselineScene()
    const config = FramingNode.parse({
      id: 'bonesframing_off',
      parentId: 'level_1',
      jurisdiction: 'INTL',
      detail: '400',
      studSpacingIn: 16,
      showElectrical: false,
    })
    const result = computeLevel(scene, config)
    expect(result.devices).toEqual([])
    expect(result.fixtures.every((f) => f.meta?.deviceId === undefined)).toBe(true)
  })
})
