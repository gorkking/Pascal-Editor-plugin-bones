import { describe, expect, test } from 'bun:test'
import { baselineConfig, baselineScene } from './baseline-scene'
import { buildPlanSet } from '../plans/plan-set'
import { FramingNode } from './schema'
import { computeLevel } from './compute'

/**
 * CONDENSER HONESTY SET (prod report #2, "I don't see the heat pump"):
 * HVAC + plumbing DERIVE from rooms, so a level whose zones can't feed the
 * engines composed ZERO hvac/plumbing output while framing/electrical
 * rendered fine — with zero words. The hunt mapped the classes:
 *
 *  F1 — silent-empty compose:
 *   7a walls+slab+no-zones · 7b garage+hallway only · 7c outdoor-only ·
 *   7d zones parented to the BUILDING node · 4b/4c two-storey zone/level
 *   mismatch · roof levels → each now gets the honest class warning;
 *   healthy scenes stay silent; the warning rides result.warnings into
 *   the plan set's flags block (the standard channel).
 *
 *  F2 — upper-storey facade-height unit (hunt 4a): each level mints its
 *   condenser at LEVEL-LOCAL grade, so an upper-storey X-ray draws the
 *   "outdoor" unit at facade height. Honest warning (grade mounting via
 *   Member.levelId can't carry the row's FIXTURES — the renderer mounts
 *   foreign members only); ground-storey compose byte-equal (the E5
 *   master-baseline pin covers the bytes).
 */

const NO_ZONES_RE = /no indoor zones on this level/
const OUTDOOR_RE = /all zones on this level are outdoor/
const HABITABLE_RE = /no habitable rooms on this level/
const FLOOR_ELEV_RE = /condenser for this storey drawn at its floor elevation/
const ANY_HONESTY_RE = new RegExp(
  [NO_ZONES_RE.source, OUTDOOR_RE.source, HABITABLE_RE.source, FLOOR_ELEV_RE.source].join('|'),
)

type Nodes = Record<string, Record<string, unknown>>

const wall = (
  id: string,
  level: string,
  start: [number, number],
  end: [number, number],
): Record<string, unknown> => ({
  id,
  type: 'wall',
  parentId: level,
  start,
  end,
  thickness: 0.15,
  height: 2.5,
  frontSide: 'unknown',
  backSide: 'unknown',
  children: [],
})

const zone = (
  id: string,
  level: string,
  name: string,
  polygon: [number, number][],
): Record<string, unknown> => ({ id, type: 'zone', parentId: level, name, polygon, boundaryWallIds: [] })

const rect = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
]

/** 10×8 shell + slab on one level; zones are the test variable. */
function shellLevel(nodes: Nodes, lid: string, ordinal: number): void {
  nodes[lid] = { id: lid, type: 'level', level: ordinal, height: 2.5 }
  nodes[`${lid}_ws`] = wall(`${lid}_ws`, lid, [0, 0], [10, 0])
  nodes[`${lid}_we`] = wall(`${lid}_we`, lid, [10, 0], [10, 8])
  nodes[`${lid}_wn`] = wall(`${lid}_wn`, lid, [10, 8], [0, 8])
  nodes[`${lid}_ww`] = wall(`${lid}_ww`, lid, [0, 8], [0, 0])
  nodes[`${lid}_slab`] = {
    id: `${lid}_slab`,
    type: 'slab',
    parentId: lid,
    polygon: rect(0, 0, 10, 8),
    holes: [],
  }
}

const bones = (levelId: string, extra: Record<string, unknown> = {}): FramingNode =>
  FramingNode.parse({
    id: `bonesframing_${levelId}`,
    parentId: levelId,
    jurisdiction: 'INTL',
    ...extra,
  }) as FramingNode

// ---------------------------------------------------------------------------
// F1 — the silent-empty classes each warn; healthy scenes stay silent
// ---------------------------------------------------------------------------

describe('F1: silent-empty HVAC/plumbing levels warn (hunt 7a-7d, 4b/4c, roof level)', () => {
  test('7a — walls+slab, no zones: framing/electrical render, MEP is empty, and it SAYS so', () => {
    const nodes: Nodes = {}
    shellLevel(nodes, 'lvl0', 0)
    const result = computeLevel(nodes, bones('lvl0'))
    // the trap itself, pinned: other systems compose, MEP is empty
    expect(result.members.some((m) => m.system === 'wall-framing')).toBe(true)
    expect(result.fixtures.some((f) => f.system === 'electrical')).toBe(true)
    expect(result.members.some((m) => m.system === 'hvac' || m.system === 'plumbing')).toBe(false)
    // the honesty line — both systems in one warning
    const warning = result.warnings.find((w) => NO_ZONES_RE.test(w))
    expect(warning).toContain('HVAC + plumbing are derived from rooms')
    expect(warning).toContain('X-ray the storey that has them')
  })

  test('7b — garage + hallway zones only: the habitable-rooms class, not the no-zones one', () => {
    const nodes: Nodes = {}
    shellLevel(nodes, 'lvl0', 0)
    nodes.z_garage = zone('z_garage', 'lvl0', 'Garage', rect(0, 0, 6, 8))
    nodes.z_hall = zone('z_hall', 'lvl0', 'Hallway', rect(6, 0, 10, 8))
    const result = computeLevel(nodes, bones('lvl0'))
    const warning = result.warnings.find((w) => HABITABLE_RE.test(w))
    expect(warning).toContain('garage/hallway zones only')
    expect(warning).toContain('plumbing found no wet rooms')
    expect(result.warnings.some((w) => NO_ZONES_RE.test(w))).toBe(false)
    // mutation: a bedroom zone makes the level served — warning gone, AH in
    const served: Nodes = { ...nodes }
    served.z_bed = zone('z_bed', 'lvl0', 'Bedroom', rect(6, 0, 10, 8))
    delete served.z_hall
    const healthy = computeLevel(served, bones('lvl0'))
    expect(healthy.warnings.some((w) => ANY_HONESTY_RE.test(w) && !FLOOR_ELEV_RE.test(w))).toBe(false)
    expect(healthy.fixtures.some((f) => f.system === 'hvac')).toBe(true)
  })

  test('7c — outdoor-only zones: the day-9 delta class states WHY the unit is gone', () => {
    const nodes: Nodes = {}
    shellLevel(nodes, 'lvl0', 0)
    nodes.z_terrace = zone('z_terrace', 'lvl0', 'Terrace', rect(0, 0, 10, 8))
    const result = computeLevel(nodes, bones('lvl0'))
    expect(result.warnings.some((w) => OUTDOOR_RE.test(w))).toBe(true)
    expect(result.warnings.some((w) => NO_ZONES_RE.test(w))).toBe(false)
    // mutation: the same polygon named as a living room serves — silent + unit back
    const renamed: Nodes = { ...nodes }
    renamed.z_terrace = zone('z_terrace', 'lvl0', 'Living room', rect(0, 0, 10, 8))
    const healthy = computeLevel(renamed, bones('lvl0'))
    expect(healthy.warnings.some((w) => OUTDOOR_RE.test(w))).toBe(false)
    expect(healthy.members.some((m) => m.label?.startsWith('AC condenser'))).toBe(true)
  })

  test('7d — zones parented to the BUILDING node: extractRooms misses them, the level says so', () => {
    const nodes: Nodes = {}
    shellLevel(nodes, 'lvl0', 0)
    nodes.bldg = { id: 'bldg', type: 'building', children: ['lvl0'] }
    ;(nodes.lvl0 as Record<string, unknown>).parentId = 'bldg'
    nodes.z_living = zone('z_living', 'bldg', 'Living room', rect(0, 0, 10, 8))
    const result = computeLevel(nodes, bones('lvl0'))
    expect(result.warnings.some((w) => NO_ZONES_RE.test(w))).toBe(true)
  })

  test('4b/4c — two-storey zone/level mismatch: the zoneless storey warns, the zoned one serves', () => {
    const nodes: Nodes = {}
    nodes.bldg = { id: 'bldg', type: 'building', children: ['lvl0', 'lvl1'] }
    shellLevel(nodes, 'lvl0', 0)
    shellLevel(nodes, 'lvl1', 1)
    ;(nodes.lvl0 as Record<string, unknown>).parentId = 'bldg'
    ;(nodes.lvl1 as Record<string, unknown>).parentId = 'bldg'
    nodes.z_up = zone('z_up', 'lvl1', 'Bedroom', rect(0, 0, 10, 8))
    const ground = computeLevel(nodes, bones('lvl0'))
    expect(ground.warnings.some((w) => NO_ZONES_RE.test(w))).toBe(true)
    expect(ground.members.some((m) => m.system === 'hvac')).toBe(false)
    const upper = computeLevel(nodes, bones('lvl1'))
    expect(upper.warnings.some((w) => NO_ZONES_RE.test(w))).toBe(false)
    expect(upper.members.some((m) => m.system === 'hvac')).toBe(true)
  })

  test('roof level — an X-ray on the storey without the rooms points at the one that has them', () => {
    const nodes: Nodes = {}
    nodes.bldg = { id: 'bldg', type: 'building', children: ['lvl0', 'lvlroof'] }
    shellLevel(nodes, 'lvl0', 0)
    ;(nodes.lvl0 as Record<string, unknown>).parentId = 'bldg'
    nodes.lvlroof = { id: 'lvlroof', type: 'level', parentId: 'bldg', level: 1, height: 1.5 }
    nodes.z_living = zone('z_living', 'lvl0', 'Living room', rect(0, 0, 10, 8))
    nodes.roofseg = {
      id: 'roofseg',
      type: 'roof-segment',
      parentId: 'lvlroof',
      position: [5, 0, 4],
      rotation: 0,
      roofType: 'gable',
      width: 10.6,
      depth: 8.6,
      pitch: 30,
      thickness: 0.2,
    }
    const roof = computeLevel(nodes, bones('lvlroof'))
    expect(roof.warnings.some((w) => NO_ZONES_RE.test(w))).toBe(true)
    // no condenser on the roof level → the F2 class never fires here
    expect(roof.warnings.some((w) => FLOOR_ELEV_RE.test(w))).toBe(false)
  })

  test('toggle honesty: MEP toggled OFF is not missing hardware — no warning', () => {
    const nodes: Nodes = {}
    shellLevel(nodes, 'lvl0', 0)
    const result = computeLevel(nodes, bones('lvl0', { showHvac: false, showPlumbing: false }))
    expect(result.warnings.some((w) => ANY_HONESTY_RE.test(w))).toBe(false)
  })

  test('healthy baseline scene: none of the honesty classes fire (E5 byte pin holds separately)', () => {
    const result = computeLevel(baselineScene(), baselineConfig('INTL'))
    expect(result.warnings.some((w) => ANY_HONESTY_RE.test(w))).toBe(false)
  })

  test('compose gate: the warning reaches the plan set flags block (opts.warnings channel)', () => {
    const nodes: Nodes = {}
    shellLevel(nodes, 'lvl0', 0)
    const result = computeLevel(nodes, bones('lvl0'))
    const sheets = buildPlanSet(result.members, result.fixtures, { warnings: result.warnings })
    const sched = sheets.find((s) => s.title.startsWith('Schedules'))?.svg ?? ''
    expect(sched).toContain('no indoor zones')
  })
})

// ---------------------------------------------------------------------------
// F2 — upper-storey condenser drawn at floor elevation says so
// ---------------------------------------------------------------------------

describe('F2: upper-storey condenser at facade height warns; ground storeys unchanged (hunt 4a)', () => {
  function twoStoreyZoned(): Nodes {
    const nodes: Nodes = {}
    nodes.bldg = { id: 'bldg', type: 'building', children: ['lvl0', 'lvl1'] }
    shellLevel(nodes, 'lvl0', 0)
    shellLevel(nodes, 'lvl1', 1)
    ;(nodes.lvl0 as Record<string, unknown>).parentId = 'bldg'
    ;(nodes.lvl1 as Record<string, unknown>).parentId = 'bldg'
    nodes.z_g1 = zone('z_g1', 'lvl0', 'Living room', rect(0, 0, 6, 8))
    nodes.z_g2 = zone('z_g2', 'lvl0', 'Kitchen', rect(6, 0, 10, 8))
    nodes.z_u1 = zone('z_u1', 'lvl1', 'Bedroom', rect(0, 0, 6, 8))
    nodes.z_u2 = zone('z_u2', 'lvl1', 'Bathroom', rect(6, 0, 10, 8))
    return nodes
  }

  test('the upper storey mints a unit at LEVEL-LOCAL grade and the level says so', () => {
    const nodes = twoStoreyZoned()
    const upper = computeLevel(nodes, bones('lvl1'))
    // the trap, pinned: the cabinet sits at level-local pad height — world
    // facade elevation once the host stacks the storey
    const cabinet = upper.members.find((m) => m.label?.startsWith('AC condenser'))
    expect(cabinet).toBeDefined()
    expect(cabinet?.position[1] ?? 99).toBeLessThan(1)
    expect(cabinet?.levelId).toBeUndefined()
    expect(upper.warnings.some((w) => FLOOR_ELEV_RE.test(w))).toBe(true)
  })

  test('ground storey of the same building: no grade warning (byte-equal path)', () => {
    const nodes = twoStoreyZoned()
    const ground = computeLevel(nodes, bones('lvl0'))
    expect(ground.members.some((m) => m.label?.startsWith('AC condenser'))).toBe(true)
    expect(ground.warnings.some((w) => FLOOR_ELEV_RE.test(w))).toBe(false)
  })

  test('single-storey house: never fires', () => {
    const nodes: Nodes = {}
    shellLevel(nodes, 'lvl0', 0)
    nodes.z_living = zone('z_living', 'lvl0', 'Living room', rect(0, 0, 10, 8))
    const result = computeLevel(nodes, bones('lvl0'))
    expect(result.members.some((m) => m.label?.startsWith('AC condenser'))).toBe(true)
    expect(result.warnings.some((w) => FLOOR_ELEV_RE.test(w))).toBe(false)
  })

  test('upper storey WITHOUT a condenser (no zones) takes the F1 class, not the grade one', () => {
    const nodes = twoStoreyZoned()
    delete nodes.z_u1
    delete nodes.z_u2
    const upper = computeLevel(nodes, bones('lvl1'))
    expect(upper.warnings.some((w) => FLOOR_ELEV_RE.test(w))).toBe(false)
    expect(upper.warnings.some((w) => NO_ZONES_RE.test(w))).toBe(true)
  })
})
