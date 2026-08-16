import { describe, expect, test } from 'bun:test'
import type { Fixture, OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import type { PlacedFixtureSlice } from '../core/wall-model'
import { layoutElectrical, placePanelSpot, routeWiring } from './electrical'
import { unreachableDevices } from './electrical.test-helpers'
import { layoutPlumbing, placeSewerExit } from './plumbing'
import {
  buildingDrainExit,
  checkSupply,
  drainFailures,
  levelDrains,
  stubs,
} from './plumbing.test-helpers'

/**
 * Checklist invariant A4 — service overrides are authoritative; routing
 * follows. A `bones:service` node's location replaces auto-placement
 * VERBATIM, and the routed geometry stays physical:
 *  - panel override → the panel mounts there and every homerun re-anchors
 *    (E2 continuity, proven by unreachableDevices);
 *  - water-entry / water-heater overrides → supplies re-route, still
 *    continuous meter→stubs and WH→hot stubs;
 *  - sewer-exit override → the building drain re-slopes to the new exit and
 *    every trap still drains strictly downhill (P3005.3).
 */

// ---- scene builders (connectivity-test pattern) -----------------------------

function makeWall(overrides: Partial<WallSlice> = {}): WallSlice {
  const start = overrides.start ?? [0, 0]
  const end = overrides.end ?? [4, 0]
  const dx = (end[0] ?? 0) - (start[0] ?? 0)
  const dz = (end[1] ?? 0) - (start[1] ?? 0)
  const length = Math.hypot(dx, dz)
  return {
    id: 'wall',
    start,
    end,
    dir: [dx / length, dz / length],
    length,
    thickness: 0.114,
    height: 2.5,
    exterior: true,
    openings: [],
    curved: false,
    ...overrides,
  }
}

const door = (u: number, roughWidth = 0.95): OpeningSlice => ({
  id: `door_${u}`,
  kind: 'door',
  u,
  width: roughWidth - 0.05,
  roughWidth,
  height: 2.1,
  roughHeight: 2.15,
  sillHeight: 0,
})

const room = (
  id: string,
  category: RoomSlice['category'],
  polygon: [number, number][],
  boundaryWallIds: string[] = [],
): RoomSlice => ({ id, name: category, category, polygon, boundaryWallIds, ceilingHeight: 2.5 })

const PROFILES: Record<
  PlacedFixtureSlice['kind'],
  { hot: boolean; dfu: number; drainIn: number }
> = {
  toilet: { hot: false, dfu: 3, drainIn: 3 },
  lavatory: { hot: true, dfu: 1, drainIn: 1.25 },
  shower: { hot: true, dfu: 2, drainIn: 2 },
  bathtub: { hot: true, dfu: 2, drainIn: 1.5 },
  'clothes-washer': { hot: true, dfu: 2, drainIn: 2 },
  'kitchen-sink': { hot: true, dfu: 2, drainIn: 1.5 },
}
const pf = (
  id: string,
  kind: PlacedFixtureSlice['kind'],
  plan: [number, number],
): PlacedFixtureSlice => ({ id, kind, plan, yaw: 0, ...PROFILES[kind] })

// ---- electrical: panel override ---------------------------------------------

function electricalPlan() {
  const walls = [
    makeWall({ id: 'w_s', start: [0, 0], end: [8, 0] }),
    makeWall({ id: 'w_e', start: [8, 0], end: [8, 4] }),
    makeWall({ id: 'w_n', start: [8, 4], end: [0, 4] }),
    makeWall({ id: 'w_w', start: [0, 4], end: [0, 0] }),
    makeWall({ id: 'w_div', start: [4, 0], end: [4, 4], exterior: false, openings: [door(2)] }),
  ]
  const rooms = [
    room('r_kitchen', 'kitchen', [[0, 0], [4, 0], [4, 4], [0, 4]]),
    room('r_bed', 'bedroom', [[4, 0], [8, 0], [8, 4], [4, 4]]),
  ]
  return { walls, rooms }
}

describe('A4 gate — panel override re-anchors the homeruns', () => {
  const { walls, rooms } = electricalPlan()
  const auto = layoutElectrical(walls, rooms)
  const autoPanel = auto.find((f) => f.kind === 'panel') as Fixture

  test('auto panel lands on the longest wall (the baseline to move from)', () => {
    expect(autoPanel).toBeDefined()
    const spot = placePanelSpot(walls, rooms)
    expect(spot?.wall.id).toBe('w_s')
  })

  test('wallId+wallT override mounts the panel there, verbatim', () => {
    const fixtures = layoutElectrical(walls, rooms, {
      panel: { wallId: 'w_e', wallT: 0.5, heightAff: 1.4 },
    })
    const panel = fixtures.find((f) => f.kind === 'panel') as Fixture
    expect(panel).toBeDefined()
    // On w_e at u = 2 → plan [8, 2], faced into the bedroom (x < 8).
    expect(Math.abs(panel.position[0] - 8)).toBeLessThan(0.15)
    expect(panel.position[2]).toBeCloseTo(2, 6)
    expect(panel.position[1]).toBeCloseTo(1.4, 6)
    // It actually moved off the auto wall.
    const moved = Math.hypot(
      panel.position[0] - autoPanel.position[0],
      panel.position[2] - autoPanel.position[2],
    )
    expect(moved).toBeGreaterThan(1)
    // …and EVERY device is still panel-reachable as continuous cable (E2).
    const members = routeWiring(fixtures, walls)
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('position-only override (gizmo drag) snaps to the nearest wall and stays continuous', () => {
    const fixtures = layoutElectrical(walls, rooms, {
      panel: { position: [0.2, 1.52, 3.0] },
    })
    const panel = fixtures.find((f) => f.kind === 'panel') as Fixture
    // nearest wall to (0.2, 3.0) is w_w at x=0
    expect(Math.abs(panel.position[0])).toBeLessThan(0.15)
    expect(Math.abs(panel.position[2] - 3)).toBeLessThan(0.3)
    const members = routeWiring(fixtures, walls)
    expect(unreachableDevices(members, fixtures)).toEqual([])
  })

  test('override pointing at a missing wall with no position falls back to auto', () => {
    const fixtures = layoutElectrical(walls, rooms, { panel: { wallId: 'w_gone', wallT: 0.5 } })
    const panel = fixtures.find((f) => f.kind === 'panel') as Fixture
    expect(panel.position[0]).toBeCloseTo(autoPanel.position[0], 6)
    expect(panel.position[2]).toBeCloseTo(autoPanel.position[2], 6)
  })
})

// ---- plumbing: sewer-exit / meter / WH overrides ----------------------------

/** 10×8 shell: garage west of x=5/z<5, bathroom SE, kitchen NW. */
function plumbingPlan() {
  const walls = [
    makeWall({ id: 'w_s', start: [0, 0], end: [10, 0], openings: [door(4)] }),
    makeWall({ id: 'w_e', start: [10, 0], end: [10, 8] }),
    makeWall({ id: 'w_n', start: [10, 8], end: [0, 8] }),
    makeWall({ id: 'w_w', start: [0, 8], end: [0, 0] }),
    makeWall({ id: 'w_mid', start: [5, 0], end: [5, 8], exterior: false }),
  ]
  const rooms = [
    room('r_garage', 'garage', [[0, 0], [5, 0], [5, 5], [0, 5]], ['w_w', 'w_mid']),
    room('r_bath', 'bathroom', [[5, 0], [10, 0], [10, 4], [5, 4]]),
    room('r_kitchen', 'kitchen', [[0, 5], [5, 5], [5, 8], [0, 8]]),
  ]
  const placed = [
    pf('fx_wc', 'toilet', [9.3, 1]),
    pf('fx_lav', 'lavatory', [8, 0.5]),
    pf('fx_sink', 'kitchen-sink', [1, 7.6]),
  ]
  return { walls, rooms, placed }
}

describe('A4 gate — sewer-exit override re-slopes the drains', () => {
  const { walls, rooms, placed } = plumbingPlan()
  const ids = placed.map((f) => f.id)

  test('auto exit differs from the override target (the move is real)', () => {
    const autoExit = placeSewerExit(walls, rooms, placed)
    expect(autoExit).not.toBeNull()
    const d = Math.hypot((autoExit as [number, number])[0] - 9.5, (autoExit as [number, number])[1] - 7.5)
    expect(d).toBeGreaterThan(2)
  })

  test('drains re-route to the overridden exit, strictly downhill (P3005.3)', () => {
    const { members } = layoutPlumbing(walls, rooms, undefined, placed, {
      sewerExit: { position: [9.5, 0, 7.5] },
    })
    const exit = buildingDrainExit(members)
    expect(exit).not.toBeNull()
    // The building drain's LOW end lands at the override point…
    expect(Math.hypot((exit?.x ?? 0) - 9.5, (exit?.z ?? 0) - 7.5)).toBeLessThan(0.1)
    // …every trap still reaches it walking only downhill…
    expect(drainFailures(members, ids)).toEqual([])
    // …and no drain leg lost its pitch.
    expect(levelDrains(members)).toEqual([])
  })

  test('cleanout fixture follows the exit', () => {
    const { fixtures } = layoutPlumbing(walls, rooms, undefined, placed, {
      sewerExit: { position: [9.5, 0, 7.5] },
    })
    const cleanouts = fixtures.filter((f) => f.kind === 'cleanout')
    expect(
      cleanouts.some((c) => Math.hypot(c.position[0] - 9.5, c.position[2] - 7.5) < 0.1),
    ).toBe(true)
  })

  test('wall-anchored sewer override resolves through the wall lerp', () => {
    const { members } = layoutPlumbing(walls, rooms, undefined, placed, {
      sewerExit: { wallId: 'w_n', wallT: 0.5 },
    })
    const exit = buildingDrainExit(members)
    // w_n runs [10,8] → [0,8]; t=0.5 → [5,8]
    expect(Math.hypot((exit?.x ?? 0) - 5, (exit?.z ?? 0) - 8)).toBeLessThan(0.1)
    expect(drainFailures(members, ids)).toEqual([])
  })
})

describe('A4 gate — meter + WH overrides keep the supplies continuous', () => {
  const { walls, rooms, placed } = plumbingPlan()

  test('water-entry override moves the meter; cold/hot reach every stub', () => {
    const { members, fixtures } = layoutPlumbing(walls, rooms, undefined, placed, {
      waterEntry: { wallId: 'w_e', wallT: 0.25, heightAff: 0.4 },
    })
    const meter = fixtures.find((f) => f.kind === 'water-meter') as Fixture
    // w_e runs [10,0] → [10,8]; t=0.25 → [10, 2]
    expect(meter.position[0]).toBeCloseTo(10, 6)
    expect(meter.position[2]).toBeCloseTo(2, 6)
    expect(meter.position[1]).toBeCloseTo(0.4, 6)
    checkSupply(members, fixtures)
    expect(stubs(fixtures).length).toBe(placed.length)
  })

  test('water-heater override moves the WH; hot homeruns re-anchor', () => {
    const { members, fixtures } = layoutPlumbing(walls, rooms, undefined, placed, {
      waterHeater: { wallId: 'w_mid', wallT: 0.75 },
    })
    const wh = fixtures.find((f) => f.kind === 'water-heater') as Fixture
    // w_mid runs [5,0] → [5,8]; t=0.75 → [5,6] (± the off-wall body offset)
    expect(Math.abs(wh.position[0] - 5)).toBeLessThan(0.5)
    expect(Math.abs(wh.position[2] - 6)).toBeLessThan(0.1)
    checkSupply(members, fixtures)
  })
})
