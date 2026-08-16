import { describe, expect, test } from 'bun:test'
import { resolveServicePlacement, SERVICE_BODY } from './placement'
import { SERVICE_TYPES, ServiceNode } from './schema'

describe('ServiceNode schema', () => {
  test('parses a wall-mounted panel point', () => {
    const node = ServiceNode.parse({
      serviceType: 'panel',
      wallId: 'wall_1',
      wallT: 0.5,
      heightAff: 1.52,
    })
    expect(node.type).toBe('bones:service')
    expect(node.id.startsWith('bonesservice')).toBe(true)
    expect(node.serviceType).toBe('panel')
    expect(node.position).toEqual([0, 0, 0])
  })

  test('parses a floor-placed sewer exit with position only', () => {
    const node = ServiceNode.parse({ serviceType: 'sewer-exit', position: [3, 0, -2] })
    expect(node.wallId).toBeUndefined()
    expect(node.position).toEqual([3, 0, -2])
  })

  test('rejects unknown service types and out-of-range wallT', () => {
    expect(() => ServiceNode.parse({ serviceType: 'hvac-unit' })).toThrow()
    expect(() => ServiceNode.parse({ serviceType: 'panel', wallT: 1.5 })).toThrow()
    expect(() => ServiceNode.parse({ serviceType: 'panel', wallT: -0.1 })).toThrow()
  })

  test('every service type has a body + sign spec', () => {
    for (const t of SERVICE_TYPES) {
      expect(SERVICE_BODY[t].dims.length).toBe(3)
      expect(SERVICE_BODY[t].sign.length).toBeGreaterThan(0)
    }
  })
})

describe('resolveServicePlacement', () => {
  const scene = {
    wall_1: { id: 'wall_1', type: 'wall', start: [0, 0], end: [4, 0], thickness: 0.12 },
  } as Record<string, Record<string, unknown>>

  test('wall-anchored: lerps start→end at wallT, height from heightAff', () => {
    const p = resolveServicePlacement(scene, {
      serviceType: 'panel',
      wallId: 'wall_1',
      wallT: 0.25,
      heightAff: 1.5,
      position: [99, 0, 99],
      rotation: [0, 0, 0],
    })
    expect(p.wallMounted).toBe(true)
    expect(p.position[0]).toBeCloseTo(1, 6)
    expect(p.position[1]).toBeCloseTo(1.5, 6)
    expect(p.position[2]).toBeCloseTo(0, 6)
    expect(p.wallThickness).toBeCloseTo(0.12, 6)
    // +X wall → normal [0, 1] → yaw 0 maps local +Z onto the normal
    expect(p.rotationY).toBeCloseTo(0, 6)
  })

  test('falls back to position when the wall is missing from the scene', () => {
    const p = resolveServicePlacement({}, {
      serviceType: 'sewer-exit',
      wallId: 'wall_gone',
      wallT: 0.5,
      position: [3, 0, -2],
      rotation: [0, 1.2, 0],
    })
    expect(p.wallMounted).toBe(false)
    expect(p.position[0]).toBe(3)
    expect(p.position[2]).toBe(-2)
    // floor default height for the sewer stub center
    expect(p.position[1]).toBeCloseTo(0.15, 6)
    expect(p.rotationY).toBeCloseTo(1.2, 6)
  })

  test('clamps wallT into the wall segment', () => {
    const p = resolveServicePlacement(scene, {
      serviceType: 'water-entry',
      wallId: 'wall_1',
      wallT: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    })
    expect(p.position[0]).toBeCloseTo(4, 6)
  })
})
