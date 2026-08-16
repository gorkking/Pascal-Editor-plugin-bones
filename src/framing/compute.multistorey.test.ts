import { describe, expect, test } from 'bun:test'
import { extractLevels } from '../core/wall-model'
import { FramingNode } from './schema'
import { computeLevel } from './compute'

/**
 * Prod report (2026-08-15, "starter house"): a two-storey house wore its
 * roof at GROUND level — trusses rendered inside the ground floor.
 * INVARIANT — members are emitted in the framing node's LEVEL-LOCAL space
 * (the host mounts each node inside its level group at the stacked storey
 * elevation): a roof living two storeys up must come out shifted by the
 * storey delta, and a shared roof is framed by exactly ONE X-ray node.
 */

const wall = (id: string, level: string, start: [number, number], end: [number, number]) => ({
  id,
  type: 'wall',
  parentId: level,
  start,
  end,
  thickness: 0.114,
  height: 2.5,
  frontSide: 'exterior',
  backSide: 'interior',
  children: [],
})

function twoStoreyScene() {
  const nodes: Record<string, Record<string, unknown>> = {
    bldg: { id: 'bldg', type: 'building', children: ['lvl0', 'lvl1', 'lvlroof'] },
    lvl0: { id: 'lvl0', type: 'level', parentId: 'bldg', level: 0, height: 2.7 },
    lvl1: { id: 'lvl1', type: 'level', parentId: 'bldg', level: 1, height: 2.7 },
    lvlroof: { id: 'lvlroof', type: 'level', parentId: 'bldg', level: 2, height: 2.0 },
    w0a: wall('w0a', 'lvl0', [0, 0], [8, 0]),
    w0b: wall('w0b', 'lvl0', [8, 0], [8, 5]),
    w0c: wall('w0c', 'lvl0', [8, 5], [0, 5]),
    w0d: wall('w0d', 'lvl0', [0, 5], [0, 0]),
    w1a: wall('w1a', 'lvl1', [0, 0], [8, 0]),
    w1b: wall('w1b', 'lvl1', [8, 0], [8, 5]),
    w1c: wall('w1c', 'lvl1', [8, 5], [0, 5]),
    w1d: wall('w1d', 'lvl1', [0, 5], [0, 0]),
    roofseg: {
      id: 'roofseg',
      type: 'roof-segment',
      parentId: 'lvlroof',
      position: [4, 0, 2.5],
      rotation: 0,
      roofType: 'gable',
      width: 8.6,
      depth: 5.6,
      pitch: 30,
      thickness: 0.2,
    },
  }
  return nodes
}

const bones = (id: string, levelId: string) =>
  FramingNode.parse({ id, parentId: levelId, jurisdiction: 'AUTO' }) as FramingNode

describe('multi-storey elevations (prod 2026-08-15)', () => {
  test('extractLevels stacks storeys like the host (per building, ordinal order)', () => {
    const levels = extractLevels(twoStoreyScene())
    const byId = new Map(levels.map((l) => [l.id, l]))
    expect(byId.get('lvl0')?.baseY).toBe(0)
    expect(byId.get('lvl1')?.baseY).toBeCloseTo(2.7, 5)
    expect(byId.get('lvlroof')?.baseY).toBeCloseTo(5.4, 5)
  })

  test('baseElevation offsets stack on top of the storey below', () => {
    const nodes = twoStoreyScene()
    ;(nodes.lvl1 as Record<string, unknown>).baseElevation = 0.3
    const byId = new Map(extractLevels(nodes).map((l) => [l.id, l]))
    expect(byId.get('lvl1')?.baseY).toBeCloseTo(3.0, 5)
    expect(byId.get('lvlroof')?.baseY).toBeCloseTo(5.7, 5)
  })

  test('ground-floor X-ray lifts the roof by the storey delta — never at its own ceiling', () => {
    const nodes = twoStoreyScene()
    const node = bones('bonesframing_0', 'lvl0')
    nodes.bonesframing_0 = node as unknown as Record<string, unknown>
    const result = computeLevel(nodes, node)
    const roof = result.members.filter((m) => m.system === 'roof-framing')
    expect(roof.length).toBeGreaterThan(0)
    // cross-level members stay roof-LEVEL-local and carry the tag — the
    // renderer mounts them into the roof level's Object3D, so stacked,
    // exploded AND solo transforms all apply natively (round 3)
    expect(roof.every((m) => m.levelId === 'lvlroof')).toBe(true)
    const maxY = Math.max(...roof.map((m) => m.position[1]))
    expect(maxY).toBeLessThan(4.0) // local, never pre-shifted to world
  })

  test('roof on the node.s own level frames with no shift (single-storey regression)', () => {
    const nodes = twoStoreyScene()
    // move the roof segment onto lvl0 and drop the other levels' walls
    ;(nodes.roofseg as Record<string, unknown>).parentId = 'lvl0'
    const node = bones('bonesframing_0', 'lvl0')
    nodes.bonesframing_0 = node as unknown as Record<string, unknown>
    const result = computeLevel(nodes, node)
    const roof = result.members.filter((m) => m.system === 'roof-framing')
    expect(roof.length).toBeGreaterThan(0)
    const minY = Math.min(...roof.map((m) => m.position[1]))
    expect(minY).toBeLessThan(5.0)
  })

  test('a shared roof is framed by exactly one X-ray — the highest storey wins', () => {
    const nodes = twoStoreyScene()
    const node0 = bones('bonesframing_0', 'lvl0')
    const node1 = bones('bonesframing_1', 'lvl1')
    nodes.bonesframing_0 = node0 as unknown as Record<string, unknown>
    nodes.bonesframing_1 = node1 as unknown as Record<string, unknown>
    const r0 = computeLevel(nodes, node0)
    const r1 = computeLevel(nodes, node1)
    const roof0 = r0.members.filter((m) => m.system === 'roof-framing')
    const roof1 = r1.members.filter((m) => m.system === 'roof-framing')
    expect(roof0).toEqual([])
    expect(r0.warnings.some((w) => w.includes('Roof is framed by'))).toBe(true)
    expect(roof1.length).toBeGreaterThan(0)
    // tagged to the roof level, roof-level-local coordinates
    expect(roof1.every((m) => m.levelId === 'lvlroof')).toBe(true)
  })

  test('floor-one X-ray frames its own walls level-locally (y from 0)', () => {
    const nodes = twoStoreyScene()
    const node = bones('bonesframing_1', 'lvl1')
    nodes.bonesframing_1 = node as unknown as Record<string, unknown>
    const result = computeLevel(nodes, node)
    const studs = result.members.filter((m) => m.system === 'wall-framing')
    expect(studs.length).toBeGreaterThan(0)
    // level-local: plates start at y≈0, never at world 2.7
    const minY = Math.min(...studs.map((m) => m.position[1]))
    expect(minY).toBeLessThan(0.5)
  })
})

describe('multi-storey — verify-round defect gates', () => {
  test('height-less legacy levels stack at the host default 2.5, not 2.7', () => {
    const nodes = twoStoreyScene()
    delete (nodes.lvl0 as Record<string, unknown>).height
    delete (nodes.lvl1 as Record<string, unknown>).height
    const byId = new Map(extractLevels(nodes).map((l) => [l.id, l]))
    expect(byId.get('lvl1')?.baseY).toBeCloseTo(2.5, 5)
    expect(byId.get('lvlroof')?.baseY).toBeCloseTo(5.0, 5)
  })

  test('own-level roof: election still applies — no double framing', () => {
    // porch roof drawn on lvl0 itself; nodes on lvl0 AND lvl1
    const nodes = twoStoreyScene()
    ;(nodes.roofseg as Record<string, unknown>).parentId = 'lvl0'
    const node0 = bones('bonesframing_0', 'lvl0')
    const node1 = bones('bonesframing_1', 'lvl1')
    nodes.bonesframing_0 = node0 as unknown as Record<string, unknown>
    nodes.bonesframing_1 = node1 as unknown as Record<string, unknown>
    const roof0 = computeLevel(nodes, node0).members.filter((m) => m.system === 'roof-framing')
    const roof1 = computeLevel(nodes, node1).members.filter((m) => m.system === 'roof-framing')
    expect(roof0.length + roof1.length).toBeGreaterThan(0)
    expect(Math.min(roof0.length, roof1.length)).toBe(0)
  })

  test('two buildings: each ground floor keeps its foundation and slab-on-grade', () => {
    const nodes = twoStoreyScene()
    // building B: single storey, its own ground level with walls + slab
    nodes.bldgB = { id: 'bldgB', type: 'building', children: ['lvlB0'] }
    nodes.lvlB0 = { id: 'lvlB0', type: 'level', parentId: 'bldgB', level: 0, height: 4.0 }
    nodes.wBa = wall('wBa', 'lvlB0', [20, 0], [26, 0])
    nodes.wBb = wall('wBb', 'lvlB0', [26, 0], [26, 4])
    nodes.wBc = wall('wBc', 'lvlB0', [26, 4], [20, 4])
    nodes.wBd = wall('wBd', 'lvlB0', [20, 4], [20, 0])
    nodes.slabB = {
      id: 'slabB',
      type: 'slab',
      parentId: 'lvlB0',
      polygon: [
        [20, 0],
        [26, 0],
        [26, 4],
        [20, 4],
      ],
      holes: [],
      elevation: 0.05,
      thickness: 0.1,
    }
    const nodeB = bones('bonesframing_b', 'lvlB0')
    nodes.bonesframing_b = nodeB as unknown as Record<string, unknown>
    const result = computeLevel(nodes, nodeB)
    // ground of building B: foundation present, NO elevated floor framing
    expect(result.members.filter((m) => m.system === 'foundation').length).toBeGreaterThan(0)
    expect(result.members.filter((m) => m.system === 'floor-framing')).toEqual([])
  })

  test('two buildings: each frames its OWN roof; no cross-building adoption', () => {
    const nodes = twoStoreyScene()
    nodes.bldgB = { id: 'bldgB', type: 'building', children: ['lvlB0', 'lvlBroof'] }
    nodes.lvlB0 = { id: 'lvlB0', type: 'level', parentId: 'bldgB', level: 0, height: 2.5 }
    nodes.lvlBroof = { id: 'lvlBroof', type: 'level', parentId: 'bldgB', level: 1, height: 0.4 }
    nodes.wBa = wall('wBa', 'lvlB0', [20, 0], [26, 0])
    nodes.roofsegB = {
      id: 'roofsegB',
      type: 'roof-segment',
      parentId: 'lvlBroof',
      position: [23, 0, 2],
      rotation: 0,
      roofType: 'gable',
      width: 6.5,
      depth: 4.5,
      pitch: 30,
      thickness: 0.2,
    }
    const nodeA = bones('bonesframing_0', 'lvl0')
    const nodeB = bones('bonesframing_b', 'lvlB0')
    nodes.bonesframing_0 = nodeA as unknown as Record<string, unknown>
    nodes.bonesframing_b = nodeB as unknown as Record<string, unknown>
    const roofA = computeLevel(nodes, nodeA).members.filter((m) => m.system === 'roof-framing')
    const roofB = computeLevel(nodes, nodeB).members.filter((m) => m.system === 'roof-framing')
    // both buildings' roofs frame — by their own nodes
    expect(roofA.length).toBeGreaterThan(0)
    expect(roofB.length).toBeGreaterThan(0)
    // each tagged to its own building's roof level
    expect(roofA.every((m) => m.levelId === 'lvlroof')).toBe(true)
    expect(roofB.every((m) => m.levelId === 'lvlBroof')).toBe(true)
  })
})

describe('multi-storey — mixed roof levels (re-verify regression)', () => {
  test('porch on the ground level + main roof above: the owner frames BOTH', () => {
    const nodes = twoStoreyScene()
    nodes.porchseg = {
      id: 'porchseg',
      type: 'roof-segment',
      parentId: 'lvl0',
      position: [50, 2.5, 2],
      rotation: 0,
      roofType: 'shed',
      width: 3,
      depth: 2,
      pitch: 15,
      thickness: 0.15,
    }
    const node0 = bones('bonesframing_0', 'lvl0')
    const node1 = bones('bonesframing_1', 'lvl1')
    nodes.bonesframing_0 = node0 as unknown as Record<string, unknown>
    nodes.bonesframing_1 = node1 as unknown as Record<string, unknown>
    const roof0 = computeLevel(nodes, node0).members.filter((m) => m.system === 'roof-framing')
    const roof1 = computeLevel(nodes, node1).members.filter((m) => m.system === 'roof-framing')
    // node1 owns: it frames BOTH the main roof and the ground-level porch
    expect(roof0).toEqual([])
    const porch = roof1.filter((m) => m.position[0] > 40)
    const main = roof1.filter((m) => m.position[0] <= 40)
    expect(porch.length).toBeGreaterThan(0)
    expect(main.length).toBeGreaterThan(0)
    // each tagged to ITS source level, positions level-local (unshifted)
    expect(porch.every((m) => m.levelId === 'lvl0')).toBe(true)
    expect(main.every((m) => m.levelId === 'lvlroof')).toBe(true)
  })

  test('single X-ray on the ground frames both roof levels too', () => {
    const nodes = twoStoreyScene()
    nodes.porchseg = {
      id: 'porchseg',
      type: 'roof-segment',
      parentId: 'lvl0',
      position: [50, 2.5, 2],
      rotation: 0,
      roofType: 'shed',
      width: 3,
      depth: 2,
      pitch: 15,
      thickness: 0.15,
    }
    const node0 = bones('bonesframing_0', 'lvl0')
    nodes.bonesframing_0 = node0 as unknown as Record<string, unknown>
    const roof = computeLevel(nodes, node0).members.filter((m) => m.system === 'roof-framing')
    expect(roof.filter((m) => m.position[0] > 40).length).toBeGreaterThan(0)
    expect(roof.filter((m) => m.position[0] <= 40).length).toBeGreaterThan(0)
  })
})
