import { describe, expect, test } from 'bun:test'
import { extractLevels, extractWalls } from '../core/wall-model'
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
    // roof level ABOVE the lvl0 owner → strataAbove: takes the exploded
    // roof stratum drop (F1)
    expect(roof.every((m) => m.strataAbove === true)).toBe(true)
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
    // F1b — INTENDED limitation (checklist A3): an owner ON the roof level
    // frames the roof as own-level members: no levelId tag, no strataAbove,
    // no foreign group — and therefore no stratum drop in exploded view.
    expect(roof.every((m) => m.levelId === undefined)).toBe(true)
    expect(roof.every((m) => m.strataAbove === undefined)).toBe(true)
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

describe('interior-storey hvac routes in soffits (checklist M1)', () => {
  // Skeptic 2026-08-16: the ground storey's "attic" trunk rose to y 3.10 —
  // INSIDE the storey above (storey height 2.7). Interior storeys have no
  // attic: the trunk caps below the ceiling as a dropped-soffit run.
  function hvacScene() {
    const nodes = twoStoreyScene()
    nodes.z0 = {
      id: 'z0',
      type: 'zone',
      parentId: 'lvl0',
      name: 'Bedroom',
      polygon: [[0, 0], [8, 0], [8, 5], [0, 5]],
    }
    nodes.z1 = {
      id: 'z1',
      type: 'zone',
      parentId: 'lvl1',
      name: 'Bedroom',
      polygon: [[0, 0], [8, 0], [8, 5], [0, 5]],
    }
    return nodes
  }
  const hvacBones = (id: string, levelId: string) =>
    FramingNode.parse({
      id,
      parentId: levelId,
      jurisdiction: 'AUTO',
      showHvac: true,
    }) as FramingNode
  const SOFFIT_WARNING = 'interior-storey ducts run in soffits/floor webs — verify'

  test('ground storey under a walled storey: no duct member above its storey height', () => {
    const nodes = hvacScene()
    const node = hvacBones('bonesframing_h0', 'lvl0')
    nodes.bonesframing_h0 = node as unknown as Record<string, unknown>
    const result = computeLevel(nodes, node)
    const ducts = result.members.filter((m) => m.system === 'hvac' && m.role === 'duct-run')
    expect(ducts.length).toBeGreaterThan(0)
    for (const m of ducts) {
      expect(m.position[1] + m.dims[1] / 2).toBeLessThanOrEqual(2.7)
    }
    expect(result.warnings).toContain(SOFFIT_WARNING)
  })

  test('top walled storey (bare roof level above) keeps attic routing, warning-free', () => {
    const nodes = hvacScene()
    const node = hvacBones('bonesframing_h1', 'lvl1')
    nodes.bonesframing_h1 = node as unknown as Record<string, unknown>
    const result = computeLevel(nodes, node)
    const trunk = result.members.filter(
      (m) => m.system === 'hvac' && m.label?.startsWith('Trunk'),
    )
    expect(trunk.length).toBeGreaterThan(0)
    // the attic plane sits above the wall top — that's the roof level's space
    expect(Math.max(...trunk.map((m) => m.position[1] + m.dims[1] / 2))).toBeGreaterThan(2.5)
    expect(result.warnings).not.toContain(SOFFIT_WARNING)
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

describe('gable walls on slab-less levels (prod starter house, day board B 2026-08-16)', () => {
  /** Host scenes routinely mark BOTH wall faces 'interior' — these walls
   * carry no frontSide/backSide at all, so everything rides the fallback. */
  const bareWall = (
    id: string,
    level: string,
    start: [number, number],
    end: [number, number],
  ) => ({
    id,
    type: 'wall',
    parentId: level,
    start,
    end,
    thickness: 0.114,
    height: 2.5,
    children: [],
  })

  function gableScene() {
    const nodes: Record<string, Record<string, unknown>> = {
      bldg: { id: 'bldg', type: 'building', children: ['lvl0', 'lvlroof'] },
      lvl0: { id: 'lvl0', type: 'level', parentId: 'bldg', level: 0, height: 2.7 },
      lvlroof: { id: 'lvlroof', type: 'level', parentId: 'bldg', level: 1, height: 2.0 },
      // ground storey: bare perimeter + an interior partition, over a slab
      wga: bareWall('wga', 'lvl0', [0, 0], [8, 0]),
      wgb: bareWall('wgb', 'lvl0', [8, 0], [8, 5]),
      wgc: bareWall('wgc', 'lvl0', [8, 5], [0, 5]),
      wgd: bareWall('wgd', 'lvl0', [0, 5], [0, 0]),
      w_mid: bareWall('w_mid', 'lvl0', [0, 2.5], [8, 2.5]),
      slab0: {
        id: 'slab0',
        type: 'slab',
        parentId: 'lvl0',
        polygon: [
          [0, 0],
          [8, 0],
          [8, 5],
          [0, 5],
        ],
        holes: [],
        elevation: 0.05,
        thickness: 0.1,
      },
      // roof storey: gable-end walls, NO slabs, NO rooms
      wroofa: bareWall('wroofa', 'lvlroof', [0, 0], [8, 0]),
      wroofb: bareWall('wroofb', 'lvlroof', [0, 5], [8, 5]),
    }
    return nodes
  }

  test('gable wall above a slabbed ground storey frames EXTERIOR with the full layer stack', () => {
    // The prod bug: applyExteriorFallback probed THIS level's slabs — a roof
    // level has none, both sides read 'uncovered', the gable framed interior
    // (no sheathing/WRB/cladding). The probe now widens to the storey below.
    const nodes = gableScene()
    const node = bones('bonesframing_roof', 'lvlroof')
    nodes.bonesframing_roof = node as unknown as Record<string, unknown>
    const result = computeLevel(nodes, node)
    for (const wallId of ['wroofa', 'wroofb']) {
      const roles = new Set(
        result.members.filter((m) => m.sourceId === wallId).map((m) => m.role),
      )
      expect(roles.has('sheathing')).toBe(true)
      expect(roles.has('wrb')).toBe(true)
      expect(roles.has('cladding')).toBe(true)
    }
    // and the takeoff books WSP for the (framed, exterior) gable walls
    expect(result.areas.wallSheathingM2 ?? 0).toBeGreaterThan(0)
  })

  test('ground interior partition stays interior; slabbed perimeter probe unchanged', () => {
    const nodes = gableScene()
    const node = bones('bonesframing_ground', 'lvl0')
    nodes.bonesframing_ground = node as unknown as Record<string, unknown>
    const result = computeLevel(nodes, node)
    const midRoles = new Set(
      result.members.filter((m) => m.sourceId === 'w_mid').map((m) => m.role),
    )
    expect(midRoles.has('sheathing')).toBe(false)
    expect(midRoles.has('wrb')).toBe(false)
    expect(midRoles.has('cladding')).toBe(false)
    expect(midRoles.has('drywall')).toBe(true)
    const perimRoles = new Set(
      result.members.filter((m) => m.sourceId === 'wga').map((m) => m.role),
    )
    expect(perimRoles.has('sheathing')).toBe(true)
  })

  test('no flooring ANYWHERE + no rooms: every straight wall on the level is exterior (attic rule)', () => {
    const nodes = gableScene()
    delete nodes.slab0
    // lvlroof has a storey below it in the building — the attic rule applies
    const walls = extractWalls(nodes, 'lvlroof', [], true)
    expect(walls).toHaveLength(2)
    expect(walls.every((w) => w.exterior)).toBe(true)
  })

  test('a drawn zone suppresses the attic rule — ambiguous walls stay interior', () => {
    const nodes = gableScene()
    delete nodes.slab0
    nodes.zroof = {
      id: 'zroof',
      type: 'zone',
      parentId: 'lvlroof',
      name: 'Loft',
      polygon: [
        [0, 0],
        [8, 0],
        [8, 5],
      ],
      boundaryWallIds: [],
    }
    const walls = extractWalls(nodes, 'lvlroof', [], true)
    expect(walls.every((w) => !w.exterior)).toBe(true)
  })

  test('a zone whose polygon points are all malformed does NOT suppress the attic rule (extractRooms parity)', () => {
    // extractRooms pair-filters polygon points and requires >= 3 VALID
    // vertices — the hasRooms gate must apply the same validation, or a
    // malformed zone counts as a room here while extractRooms drops it.
    const nodes = gableScene()
    delete nodes.slab0
    nodes.zbad = {
      id: 'zbad',
      type: 'zone',
      parentId: 'lvlroof',
      name: 'Ghost',
      polygon: ['a', null, {}, [1]],
      boundaryWallIds: [],
    }
    const walls = extractWalls(nodes, 'lvlroof', [], true)
    expect(walls.every((w) => w.exterior)).toBe(true)
  })

  test('in-progress GROUND storey (no slabs, no rooms, nothing below): walls stay INTERIOR', () => {
    // Verify round 2026-08-16 (F2): the attic rule fired on a bare ground
    // storey — partitions framed exterior/CMU and the takeoff booked
    // sheathing the layer engine never renders. No storey below = no attic.
    const nodes = gableScene()
    delete nodes.slab0
    const walls = extractWalls(nodes, 'lvl0', [], false)
    expect(walls.length).toBeGreaterThan(0)
    expect(walls.every((w) => !w.exterior)).toBe(true)
  })
})

describe('takeoff/member consistency (checklist S4, verify round 2026-08-16)', () => {
  /** Bare walls: no frontSide/backSide — everything rides the fallback. */
  const bareWall = (
    id: string,
    level: string,
    start: [number, number],
    end: [number, number],
  ) => ({
    id,
    type: 'wall',
    parentId: level,
    start,
    end,
    thickness: 0.114,
    height: 2.5,
    children: [],
  })

  const sheathingMembers = (r: ReturnType<typeof computeLevel>) =>
    r.members.filter((m) => m.role === 'sheathing')

  test('in-progress ground storey: zero sheathing area AND zero sheathing members', () => {
    // Pre-fix this scene booked wallSheathingM2 > 0 (attic blanket marked
    // every wall exterior) while layoutWallLayers emitted NO sheathing
    // (exteriorSide had no slab/room signal) — the takeoff lied.
    const nodes: Record<string, Record<string, unknown>> = {
      bldg: { id: 'bldg', type: 'building', children: ['lvl0'] },
      lvl0: { id: 'lvl0', type: 'level', parentId: 'bldg', level: 0, height: 2.5 },
      wa: bareWall('wa', 'lvl0', [0, 0], [8, 0]),
      wb: bareWall('wb', 'lvl0', [8, 0], [8, 5]),
      w_part: bareWall('w_part', 'lvl0', [0, 2.5], [8, 2.5]),
    }
    const node = bones('bonesframing_0', 'lvl0')
    nodes.bonesframing_0 = node as unknown as Record<string, unknown>
    const result = computeLevel(nodes, node)
    expect(result.areas.wallSheathingM2 ?? 0).toBe(0)
    expect(sheathingMembers(result)).toHaveLength(0)
    // and nothing framed as CMU either — partitions are not exterior walls
    expect(result.members.filter((m) => m.role === 'block')).toHaveLength(0)
  })

  test('gable storey over a slabbed ground: sheathing area > 0 IMPLIES sheathing members > 0 (non-vacuous)', () => {
    const nodes: Record<string, Record<string, unknown>> = {
      bldg: { id: 'bldg', type: 'building', children: ['lvl0', 'lvlroof'] },
      lvl0: { id: 'lvl0', type: 'level', parentId: 'bldg', level: 0, height: 2.7 },
      lvlroof: { id: 'lvlroof', type: 'level', parentId: 'bldg', level: 1, height: 2.0 },
      slab0: {
        id: 'slab0',
        type: 'slab',
        parentId: 'lvl0',
        polygon: [
          [0, 0],
          [8, 0],
          [8, 5],
          [0, 5],
        ],
        holes: [],
        elevation: 0.05,
        thickness: 0.1,
      },
      wroofa: bareWall('wroofa', 'lvlroof', [0, 0], [8, 0]),
      wroofb: bareWall('wroofb', 'lvlroof', [0, 5], [8, 5]),
    }
    const node = bones('bonesframing_roof', 'lvlroof')
    nodes.bonesframing_roof = node as unknown as Record<string, unknown>
    const result = computeLevel(nodes, node)
    // booked area and rendered members move TOGETHER
    expect(result.areas.wallSheathingM2 ?? 0).toBeGreaterThan(0)
    expect(sheathingMembers(result).length).toBeGreaterThan(0)
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
    // F1 gate (verify round 2026-08-16): the porch's source level sits
    // BELOW the lvl1 owner — NO strataAbove, so the exploded roof stratum
    // never drops it into the ground storey; the main roof (above the
    // owner) carries the tag and takes the drop.
    expect(porch.every((m) => m.strataAbove === undefined)).toBe(true)
    expect(main.every((m) => m.strataAbove === true)).toBe(true)
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
