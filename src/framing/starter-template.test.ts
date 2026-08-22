import { describe, expect, test } from 'bun:test'
import { classifyRoom } from '../core/wall-model'
import type { Fixture, Member } from '../core/types'
import { buildServicePointNodes } from '../service/place'
import { computeLevel } from './compute'
import { FramingNode } from './schema'

/**
 * STARTER-TEMPLATE PINNED GATE (prod report 2026-08-22: "I don't see the
 * heat pump standing outside the house like it used to be").
 *
 * The editor's starter templates (private-editor editor/packages/mcp/src/
 * templates — garden-house is `create_house_from_brief`'s default) ship
 * walls with BOTH faces 'unknown', zones, and NO slab. That scene shape
 * defeated the exterior-wall election end-to-end:
 *
 *  1. applyExteriorFallback (core/wall-model.ts) probes SLAB coverage; with
 *     zero slabs every wall read 'uncovered on both sides' → the whole
 *     shell framed INTERIOR (the `slabs.length === 0 && !hasRooms` blanket
 *     branch is gated off by the zones);
 *  2. placeHeatPumpSpot → nearestExteriorExit → null → the condenser-always
 *     fallback anchor: pad + cabinet ⚠-flagged at the tie-break wall, NO
 *     disconnect, AIR-RUN line-set, no outdoor receptacles (B14), no
 *     sheathing/WRB/cladding — and no heat-pump service point seeded;
 *  3. the outdoor 'Back garden' zone classified 'other' → HABITABLE: a
 *     supply register floated in the yard and the garden's 72 m² inflated
 *     the tonnage (3.5 t for a 96 m² house).
 *
 * The fix: probeSlabsFor treats INDOOR zone polygons as declared floor
 * coverage when the building has no flooring anywhere (outdoor zones never
 * count), and the HVAC engine serves indoor rooms only ('outdoor' room
 * category). These gates pin the healed compose ON THE ACTUAL TEMPLATE
 * SHAPE at the computeLevel level — the 1500-compose condenser-always
 * invariant (hvac.condensers.test.ts) stays green through the whole story
 * because it feeds layoutHvac PRE-CLASSIFIED WallSlices and can never see
 * an election failure; this file covers exactly the class it misses.
 */

// ---------------------------------------------------------------------------
// Fixtures — faithful to the editor templates' node shapes (faces 'unknown',
// openings' u in position[0], zones without boundaryWallIds, no slab).
// ---------------------------------------------------------------------------

const HOUSE_W = 6 // half-width (12 m total), matches garden-house
const HOUSE_D = 4 // half-depth (8 m total)
const GARDEN_DEPTH = 6

function wall(
  id: string,
  start: [number, number],
  end: [number, number],
  children: string[] = [],
): Record<string, unknown> {
  return {
    id,
    type: 'wall',
    parentId: 'level_0',
    start,
    end,
    thickness: 0.15,
    height: 2.7,
    frontSide: 'unknown',
    backSide: 'unknown',
    children,
  }
}

function door(id: string, u: number, width = 1.0): Record<string, unknown> {
  return { id, type: 'door', position: [u, 1.05, 0], width, height: 2.1 }
}

function win(id: string, u: number, width = 1.2): Record<string, unknown> {
  return { id, type: 'window', position: [u, 1.2, 0], width, height: 1.2 }
}

function zone(
  id: string,
  name: string,
  polygon: [number, number][],
): Record<string, unknown> {
  return { id, type: 'zone', parentId: 'level_0', name, polygon }
}

/** The garden-house starter template: 12×8 shell, indoor living zone,
 * OUTDOOR back-garden zone to the north, privacy fences, no slab. */
function starterTemplateScene(): Record<string, Record<string, unknown>> {
  const fence = (id: string, start: [number, number], end: [number, number]) => ({
    id,
    type: 'fence',
    parentId: 'level_0',
    start,
    end,
    height: 1.8,
    thickness: 0.08,
  })
  return {
    site_g: { id: 'site_g', type: 'site', children: ['building_g'] },
    building_g: {
      id: 'building_g',
      type: 'building',
      parentId: 'site_g',
      children: ['level_0'],
    },
    level_0: {
      id: 'level_0',
      type: 'level',
      parentId: 'building_g',
      level: 0,
      height: 2.7,
    },
    door_front: door('door_front', 2),
    door_garden: door('door_garden', 3, 1.6),
    window_s1: win('window_s1', 8),
    window_e: win('window_e', 4, 1.0),
    window_w: win('window_w', 4, 1.0),
    wall_n: wall('wall_n', [-HOUSE_W, -HOUSE_D], [HOUSE_W, -HOUSE_D], ['door_garden']),
    wall_e: wall('wall_e', [HOUSE_W, -HOUSE_D], [HOUSE_W, HOUSE_D], ['window_e']),
    wall_s: wall('wall_s', [HOUSE_W, HOUSE_D], [-HOUSE_W, HOUSE_D], ['door_front', 'window_s1']),
    wall_w: wall('wall_w', [-HOUSE_W, HOUSE_D], [-HOUSE_W, -HOUSE_D], ['window_w']),
    zone_living: zone('zone_living', 'Living', [
      [-HOUSE_W, -HOUSE_D],
      [HOUSE_W, -HOUSE_D],
      [HOUSE_W, HOUSE_D],
      [-HOUSE_W, HOUSE_D],
    ]),
    zone_garden: zone('zone_garden', 'Back garden', [
      [-HOUSE_W, -HOUSE_D - GARDEN_DEPTH],
      [HOUSE_W, -HOUSE_D - GARDEN_DEPTH],
      [HOUSE_W, -HOUSE_D],
      [-HOUSE_W, -HOUSE_D],
    ]),
    fence_n: fence('fence_n', [-HOUSE_W, -HOUSE_D - GARDEN_DEPTH], [HOUSE_W, -HOUSE_D - GARDEN_DEPTH]),
    fence_e: fence('fence_e', [HOUSE_W, -HOUSE_D - GARDEN_DEPTH], [HOUSE_W, -HOUSE_D]),
    fence_w: fence('fence_w', [-HOUSE_W, -HOUSE_D], [-HOUSE_W, -HOUSE_D - GARDEN_DEPTH]),
  }
}

/** The all-indoor no-slab class (two-bedroom / empty-studio shape): 10×8
 * shell + partition, two indoor zones, faces 'unknown', no slab. */
function indoorNoSlabScene(): Record<string, Record<string, unknown>> {
  return {
    level_0: { id: 'level_0', type: 'level', level: 0, height: 2.7 },
    door_front: door('door_front', 2),
    wall_n: wall('wall_n', [-5, -4], [5, -4]),
    wall_e: wall('wall_e', [5, -4], [5, 4]),
    wall_s: wall('wall_s', [5, 4], [-5, 4], ['door_front']),
    wall_w: wall('wall_w', [-5, 4], [-5, -4]),
    wall_part: wall('wall_part', [0, -4], [0, 4]),
    zone_living: zone('zone_living', 'Living / Kitchen', [
      [-5, -4],
      [0, -4],
      [0, 4],
      [-5, 4],
    ]),
    zone_bed: zone('zone_bed', 'Bedroom 1', [
      [0, -4],
      [5, -4],
      [5, 4],
      [0, 4],
    ]),
  }
}

function config(): FramingNode {
  return FramingNode.parse({
    id: 'bonesframing_starter',
    parentId: 'level_0',
    jurisdiction: 'INTL',
    detail: '400',
    studSpacingIn: 16,
    showWalls: true,
    showFloor: true,
    showRoof: true,
    showFoundation: true,
    showElectrical: true,
    showPlumbing: true,
    showHvac: true,
  })
}

// ---------------------------------------------------------------------------
// Shared helpers (chainConnects mirrors hvac.lineset.test.ts — E2 union-find)
// ---------------------------------------------------------------------------

const condensersOf = (fixtures: Fixture[]): Fixture[] =>
  fixtures.filter((f) => f.kind === 'equipment' && f.meta?.equipment === 'condenser')

const padsOf = (members: Member[]): Member[] =>
  members.filter((m) => m.label?.startsWith('Condenser pad'))

const cabinetsOf = (members: Member[]): Member[] =>
  members.filter((m) => m.label?.includes('outdoor unit'))

type Endpoint = { x: number; y: number; z: number }

function endpointsOf(m: Member): [Endpoint, Endpoint] {
  if (m.rotation[1] === 0 && m.dims[1] === m.length) {
    return [
      { x: m.position[0], y: m.position[1] - m.length / 2, z: m.position[2] },
      { x: m.position[0], y: m.position[1] + m.length / 2, z: m.position[2] },
    ]
  }
  const yaw = m.rotation[1]
  const hx = (m.dims[0] / 2) * Math.cos(yaw)
  const hz = -(m.dims[0] / 2) * Math.sin(yaw)
  return [
    { x: m.position[0] - hx, y: m.position[1], z: m.position[2] - hz },
    { x: m.position[0] + hx, y: m.position[1], z: m.position[2] + hz },
  ]
}

const TOL = 0.06

function chainConnects(
  members: Member[],
  from: readonly [number, number],
  to: readonly [number, number],
): boolean {
  const pts: Endpoint[] = []
  const owner: number[] = []
  members.forEach((m, i) => {
    for (const e of endpointsOf(m)) {
      pts.push(e)
      owner.push(i)
    }
  })
  const parent = pts.map((_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r] as number
    let c = i
    while (parent[c] !== c) {
      const nxt = parent[c] as number
      parent[c] = r
      c = nxt
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i] as Endpoint
      const b = pts[j] as Endpoint
      if (owner[i] === owner[j]) {
        union(i, j)
        continue
      }
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < TOL) union(i, j)
    }
  }
  const at = (p: readonly [number, number]): number => {
    let best = -1
    let bestD = Number.POSITIVE_INFINITY
    for (let i = 0; i < pts.length; i++) {
      const e = pts[i] as Endpoint
      const d = Math.hypot(e.x - p[0], e.z - p[1])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return bestD < TOL ? best : -1
  }
  const i0 = at(from)
  const i1 = at(to)
  return i0 >= 0 && i1 >= 0 && find(i0) === find(i1)
}

/** Plan distance from p to the segment a→b. */
function segDist(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const abx = b[0] - a[0]
  const abz = b[1] - a[1]
  const len2 = abx * abx + abz * abz
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / len2)) : 0
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + abz * t))
}

const inRect = (p: readonly [number, number], x0: number, x1: number, z0: number, z1: number) =>
  p[0] > x0 && p[0] < x1 && p[1] > z0 && p[1] < z1

// ---------------------------------------------------------------------------
// 0. Room classification — outdoor names
// ---------------------------------------------------------------------------

describe('classifyRoom — outdoor zones', () => {
  test('garden/patio/yard names classify outdoor; indoor names untouched', () => {
    for (const name of [
      'Back garden',
      'Garden',
      'Front yard',
      'Patio',
      'Terrace',
      'Terrasse',
      'Roof deck',
      'Porch',
      'Balcony',
      'Lanai',
      'Jardin',
      'Outdoor kitchen', // open air beats the kitchen pattern — never ducted
    ]) {
      expect(classifyRoom(name)).toBe('outdoor')
    }
    expect(classifyRoom('Kitchen')).toBe('kitchen')
    expect(classifyRoom('Living / Kitchen')).toBe('kitchen')
    expect(classifyRoom('Bathroom')).toBe('bathroom')
    expect(classifyRoom('Bedroom 1')).toBe('bedroom')
    expect(classifyRoom('Hall')).toBe('hallway')
    expect(classifyRoom('Living')).toBe('other')
  })
})

// ---------------------------------------------------------------------------
// 1. The starter template composes a REAL outdoor unit (the pinned gate)
// ---------------------------------------------------------------------------

describe('starter template (garden-house shape) — the heat pump stands outside', () => {
  const result = computeLevel(starterTemplateScene(), config())

  test('election: the whole shell frames EXTERIOR from indoor-zone coverage', () => {
    const byId = new Map(result.walls.map((w) => [w.id, w]))
    for (const id of ['wall_n', 'wall_e', 'wall_s', 'wall_w']) {
      expect(byId.get(id)?.exterior).toBe(true)
    }
    // the failure mode's tell-tale warnings are gone
    expect(result.warnings.some((w) => w.includes('no exterior wall'))).toBe(false)
    expect(result.warnings.some((w) => w.includes('AC disconnect + whip not mounted'))).toBe(
      false,
    )
  })

  test('exactly one condenser, UNFLAGGED, on a pad with its cabinet', () => {
    const units = condensersOf(result.fixtures)
    expect(units.length).toBe(1)
    const pads = padsOf(result.members)
    const cabinets = cabinetsOf(result.members)
    expect(pads.length).toBe(1)
    expect(cabinets.length).toBe(1)
    for (const m of [...pads, ...cabinets]) {
      expect(m.flag ?? '').not.toContain('verify condenser placement')
    }
  })

  test('the unit stands OUTSIDE the footprint, clear of every wall, near the house', () => {
    const unit = condensersOf(result.fixtures)[0] as Fixture
    const plan: [number, number] = [unit.position[0], unit.position[2]]
    // outside the wall-centerline rectangle…
    expect(inRect(plan, -HOUSE_W, HOUSE_W, -HOUSE_D, HOUSE_D)).toBe(false)
    // …but standing BY the house (a few meters at most), not lost on the site
    expect(inRect(plan, -HOUSE_W - 3, HOUSE_W + 3, -HOUSE_D - 3, HOUSE_D + 3)).toBe(true)
    // clear of every wall centerline per the mfr-clearance convention
    // (wall t/2 + 0.3 m + cabinet depth/2 ≈ 0.55 — gate at 0.5)
    for (const w of result.walls) {
      expect(segDist(plan, w.start, w.end)).toBeGreaterThan(0.5)
    }
  })

  test('NEC 440.14: disconnect within sight (≤ 1 m plan) + whip present', () => {
    const unit = condensersOf(result.fixtures)[0] as Fixture
    const disconnects = result.fixtures.filter((f) => f.kind === 'disconnect')
    expect(disconnects.length).toBe(1)
    const d = disconnects[0] as Fixture
    expect(
      Math.hypot(d.position[0] - unit.position[0], d.position[2] - unit.position[2]),
    ).toBeLessThanOrEqual(1)
    expect(result.members.some((m) => m.sourceId.startsWith('ac-whip-'))).toBe(true)
  })

  test('E2 line-set continuity: both pipes chain condenser → air handler, no AIR RUN', () => {
    const unit = condensersOf(result.fixtures)[0] as Fixture
    const handler = result.fixtures.find((f) => f.label?.includes('Air handler')) as Fixture
    expect(handler).toBeDefined()
    for (const pipe of ['lineset-suction-1', 'lineset-liquid-1']) {
      const legs = result.members.filter((m) => m.sourceId === pipe)
      expect(legs.length).toBeGreaterThan(0)
      expect(legs.every((m) => !m.flag?.includes('AIR RUN'))).toBe(true)
      expect(
        chainConnects(
          legs,
          [unit.position[0], unit.position[2]],
          [handler.position[0], handler.position[2]],
        ),
      ).toBe(true)
    }
  })

  test('the garden is OPEN AIR: no HVAC service lands in the outdoor zone', () => {
    // garden rect: z ∈ [-10, -4], x ∈ [-6, 6]
    const inGarden = (f: Fixture) =>
      inRect([f.position[0], f.position[2]], -HOUSE_W, HOUSE_W, -HOUSE_D - GARDEN_DEPTH, -HOUSE_D)
    for (const f of result.fixtures.filter((f) => f.system === 'hvac')) {
      // the outdoor UNIT + its disconnect legitimately stand outside;
      // conditioned-air fixtures must not
      if (f.kind === 'equipment' || f.kind === 'disconnect') continue
      expect(inGarden(f)).toBe(false)
    }
    // no HVAC fixture may SOURCE from the outdoor zone (the garden register
    // class). Electrical still hangs a general ceiling light off the garden
    // zone — same family, different engine, queued as residual (out of this
    // fix's scope); the gate here pins the HVAC contract.
    expect(
      result.fixtures.some((f) => f.system === 'hvac' && f.sourceId === 'zone_garden'),
    ).toBe(false)
    // no supply duct reaches into the garden (register drops died with the
    // habitable-garden bug — a boot at z < -4 would be open-air tin)
    for (const m of result.members.filter((m) => m.system === 'hvac' && m.role === 'duct-run')) {
      expect(m.position[2]).toBeGreaterThan(-HOUSE_D)
    }
  })

  test('tonnage sizes from INDOOR area only (96 m², not 168 m² with the garden)', () => {
    const handler = result.fixtures.find((f) => f.label?.includes('Air handler')) as Fixture
    expect(handler.meta?.conditionedSqft).toBe(Math.round(96 * 10.7639))
    const unit = condensersOf(result.fixtures)[0] as Fixture
    expect(unit.meta?.totalTons).toBe(2)
  })

  test('A4 seeding parity: the heat-pump service point seeds outside the footprint', () => {
    const seeded = buildServicePointNodes(starterTemplateScene(), 'level_0')
    const hp = seeded.find((n) => n.serviceType === 'heat-pump')
    expect(hp).toBeDefined()
    const p = hp?.position as [number, number, number]
    expect(inRect([p[0], p[2]], -HOUSE_W, HOUSE_W, -HOUSE_D, HOUSE_D)).toBe(false)
  })

  test('cross-feature seam guard: B14 outdoor receptacles + meter compose here too', () => {
    // the same election starves outdoor receptacles and the meter-anchored
    // machinery — pin them so a future election change can't silently
    // re-open the whole class
    expect(result.fixtures.filter((f) => f.kind === 'receptacle-wr-gfci').length).toBe(2)
    expect(result.fixtures.some((f) => f.kind === 'electric-meter')).toBe(true)
    expect(
      result.warnings.some((w) => w.includes('outdoor receptacles')),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. The all-indoor no-slab class (two-bedroom / empty-studio shape)
// ---------------------------------------------------------------------------

describe('all-indoor zones without a slab (two-bedroom / studio templates)', () => {
  const result = computeLevel(indoorNoSlabScene(), config())

  test('perimeter frames exterior, the partition stays interior', () => {
    const byId = new Map(result.walls.map((w) => [w.id, w]))
    for (const id of ['wall_n', 'wall_e', 'wall_s', 'wall_w']) {
      expect(byId.get(id)?.exterior).toBe(true)
    }
    expect(byId.get('wall_part')?.exterior).toBe(false)
  })

  test('one unflagged condenser outside the footprint, disconnect mounted', () => {
    const units = condensersOf(result.fixtures)
    expect(units.length).toBe(1)
    const unit = units[0] as Fixture
    expect(inRect([unit.position[0], unit.position[2]], -5, 5, -4, 4)).toBe(false)
    for (const m of [...padsOf(result.members), ...cabinetsOf(result.members)]) {
      expect(m.flag ?? '').not.toContain('verify condenser placement')
    }
    expect(result.fixtures.filter((f) => f.kind === 'disconnect').length).toBe(1)
    expect(result.warnings.some((w) => w.includes('no exterior wall'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Outdoor-only level — honesty guard (no AH ⇒ no unit, nothing invented)
// ---------------------------------------------------------------------------

describe('outdoor-only level (a garden with fences, no house)', () => {
  test('no air handler is invented, so no condenser either — and no crash', () => {
    const nodes: Record<string, Record<string, unknown>> = {
      level_0: { id: 'level_0', type: 'level', level: 0, height: 2.7 },
      zone_garden: zone('zone_garden', 'Garden', [
        [-6, -6],
        [6, -6],
        [6, 6],
        [-6, 6],
      ]),
    }
    const result = computeLevel(nodes, config())
    expect(result.fixtures.some((f) => f.label?.includes('Air handler'))).toBe(false)
    expect(condensersOf(result.fixtures).length).toBe(0)
  })
})
