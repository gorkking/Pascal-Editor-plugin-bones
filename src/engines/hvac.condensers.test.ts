import { describe, expect, test } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
import type { Fixture, Member, OpeningSlice, RoomSlice, WallSlice } from '../core/types'
import {
  MAX_TONS_PER_CONDENSER,
  condenserPlan,
  condenserSqftPerTon,
  layoutHvac,
  placeHeatPumpSpot,
} from './hvac'
import { computeTakeoff } from './takeoff'

/**
 * GATES (night-4 user ask — AC condenser blocks): the outdoor unit row.
 *  1. unit count scales with conditioned floor area (1 / 2 / 3+), per-unit
 *     tonnage never exceeds 5 (residential condensers top out there);
 *  2. hot climate zones (1-2) size at 1 ton/450 sqft, cold (5+) at 650 —
 *     the divisor is read from wall-assemblies stateClimateZone and CITED
 *     in the fixture label (an uncited assumption is a lie);
 *  3. every pad/cabinet sits OUTSIDE the exterior wall, ≥ 0.6 m clear of
 *     its neighbors, never in front of a door/window RO (slides along the
 *     wall to clear);
 *  4. each unit's line-set reaches the air handler (endpoint tolerance)
 *     through a WALL PENETRATION at ~0.4 m — Manhattan segments only (every
 *     leg plan-axis-aligned), no diagonal air runs;
 *  5. a disconnect lands within sight (≤ 1 m) of each unit (NEC 440.14);
 *  6. takeoff rows mirror the rendered counts (checklist S4);
 *  7. the heat-pump service override MOVES unit #1 verbatim and the row
 *     re-anchors to it (checklist A4);
 *  8. a small scene with no override keeps the pre-existing single-unit
 *     anchor (placeHeatPumpSpot) — the legacy behavior generalized, not
 *     duplicated.
 */

const LOD400 = { ...DEFAULT_SPEC, detail: '400' as const }

function opening(id: string, u: number, roughWidth: number, kind: 'door' | 'window' = 'door'): OpeningSlice {
  return {
    id,
    kind,
    u,
    width: roughWidth - 0.05,
    height: kind === 'door' ? 2.03 : 1.2,
    sillHeight: kind === 'door' ? 0 : 0.9,
    roughWidth,
    roughHeight: kind === 'door' ? 2.1 : 1.3,
  }
}

function wall(
  id: string,
  start: [number, number],
  end: [number, number],
  exterior = false,
  openings: OpeningSlice[] = [],
): WallSlice {
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  return {
    id,
    start,
    end,
    length,
    dir: [dx / length, dz / length],
    thickness: 0.2,
    height: 2.7,
    exterior,
    openings,
    curved: false,
  }
}

function room(
  id: string,
  name: string,
  category: RoomSlice['category'],
  polygon: [number, number][],
): RoomSlice {
  return { id, name, category, polygon, boundaryWallIds: [], ceilingHeight: 2.5 }
}

/** W×D rectangular shell: laundry (equipment room) in the SW corner, the
 * rest habitable — conditioned area = W×D exactly. */
function shell(W: number, D: number, southOpenings: OpeningSlice[] = []) {
  const walls = [
    wall('w_south', [0, 0], [W, 0], true, southOpenings),
    wall('w_north', [0, D], [W, D], true),
    wall('w_west', [0, 0], [0, D], true),
    wall('w_east', [W, 0], [W, D], true),
  ]
  const rooms = [
    room('r_laundry', 'Laundry', 'laundry', [[0, 0], [3, 0], [3, 3], [0, 3]]),
    room('r_living', 'Living', 'other', [[3, 0], [W, 0], [W, D], [3, D]]),
    room('r_bed', 'Bedroom', 'bedroom', [[0, 3], [3, 3], [3, D], [0, D]]),
  ]
  return { walls, rooms }
}

const condensersOf = (fixtures: Fixture[]): Fixture[] =>
  fixtures.filter((f) => f.kind === 'equipment' && f.meta?.equipment === 'condenser')

const padsOf = (members: Member[]): Member[] =>
  members.filter((m) => m.system === 'hvac' && m.role === 'equipment' && m.material === 'concrete')

const cabinetsOf = (members: Member[]): Member[] =>
  members.filter((m) => m.system === 'hvac' && m.role === 'equipment' && m.material === 'steel')

type Endpoint = { x: number; y: number; z: number }

/** Horizontal duct()/vertical ductDrop() member endpoints (world x/y/z). */
function endpointsOf(m: Member): [Endpoint, Endpoint] {
  if (m.rotation[1] === 0 && m.dims[1] === m.length) {
    // vertical drop — plan point fixed, y spans the length
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

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

describe('condenser sizing — area + climate zone (assumption, Manual J/S govern)', () => {
  test('unit count scales with floor area: small 1, ~2800 sqft 2, huge 3', () => {
    // 10×8 m = 861 sqft → 2.0 tons → 1 unit
    expect(condenserPlan(80).count).toBe(1)
    // 26×10 m = 2799 sqft → 5.5 tons → 2 units
    expect(condenserPlan(260).count).toBe(2)
    // 40×14 m = 6028 sqft → 11 tons → 3 units
    expect(condenserPlan(560).count).toBe(3)
  })

  test('tiny homes floor at 1 unit / 1.5 tons', () => {
    const tiny = condenserPlan(20) // 215 sqft
    expect(tiny.count).toBe(1)
    expect(tiny.totalTons).toBe(1.5)
    expect(tiny.unitTons).toBe(1.5)
  })

  test('per-unit tonnage never exceeds 5 across a wide area sweep', () => {
    for (let area = 20; area <= 1600; area += 20) {
      const plan = condenserPlan(area)
      expect(plan.unitTons).toBeLessThanOrEqual(MAX_TONS_PER_CONDENSER)
      expect(plan.count).toBe(Math.max(1, Math.ceil(plan.totalTons / MAX_TONS_PER_CONDENSER)))
    }
  })

  test('hot states (zone 1-2) size at 450 sqft/ton, cold (5+) at 650, mid at 550', () => {
    expect(condenserSqftPerTon('FL').divisor).toBe(450) // 2A
    expect(condenserSqftPerTon('AZ').divisor).toBe(450) // 2B
    expect(condenserSqftPerTon('MO').divisor).toBe(550) // 4A
    expect(condenserSqftPerTon('MN').divisor).toBe(650) // 6A
    expect(condenserSqftPerTon('INTL').divisor).toBe(550) // zone-less → mid
    expect(condenserSqftPerTon(undefined).divisor).toBe(550)
    // Same house, different jurisdictions: FL genuinely buys more cooling.
    expect(condenserPlan(260, 'FL').totalTons).toBeGreaterThan(condenserPlan(260, 'MN').totalTons)
    expect(condenserPlan(260, 'FL').count).toBe(2)
    expect(condenserPlan(260, 'MN').count).toBe(1)
  })

  test('fixture label CITES the divisor + zone the sizing used', () => {
    const { walls, rooms } = shell(26, 10)
    const fl = condensersOf(layoutHvac(walls, rooms, LOD400, undefined, { stateCode: 'FL' }).fixtures)
    expect(fl.length).toBe(2)
    expect(fl[0]?.label).toContain('assumed 1 ton/450 sqft')
    expect(fl[0]?.label).toContain('zone 2A')
    const intl = condensersOf(layoutHvac(walls, rooms, LOD400).fixtures)
    expect(intl[0]?.label).toContain('assumed 1 ton/550 sqft')
  })
})

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe('condenser row placement — outside, clear, spaced (IRC M1403 + mfr clearance)', () => {
  test('every pad + cabinet sits OUTSIDE the shell, on a 3-unit house', () => {
    const { walls, rooms } = shell(40, 14)
    const { members, fixtures } = layoutHvac(walls, rooms, LOD400)
    const units = condensersOf(fixtures)
    expect(units.length).toBe(3)
    expect(padsOf(members).length).toBe(3)
    expect(cabinetsOf(members).length).toBe(3)
    for (const box of [...padsOf(members), ...cabinetsOf(members)]) {
      const inside =
        box.position[0] > 0 && box.position[0] < 40 && box.position[2] > 0 && box.position[2] < 14
      expect(inside).toBe(false)
    }
  })

  test('units keep ≥ 0.6 m clear between cabinets and ≥ 0.3 m off the wall face', () => {
    const { walls, rooms } = shell(26, 10)
    const { members } = layoutHvac(walls, rooms, LOD400)
    const cabs = cabinetsOf(members)
    expect(cabs.length).toBe(2)
    for (let i = 0; i < cabs.length; i++) {
      for (let j = i + 1; j < cabs.length; j++) {
        const a = cabs[i] as Member
        const b = cabs[j] as Member
        const dist = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2])
        // center pitch − cabinet width = clear air between the boxes
        expect(dist - 0.9).toBeGreaterThanOrEqual(0.6 - 1e-9)
      }
      // row is on the south wall (z = 0, thickness 0.2): face at z = −0.1;
      // cabinet near edge = center + depth/2
      const cab = cabs[i] as Member
      expect(-(cab.position[2] + 0.35 / 2) - 0.1).toBeGreaterThanOrEqual(0.3 - 1e-9)
    }
  })

  test('a pad never fronts a door/window RO — the row slides along the wall to clear', () => {
    // Door RO right where the auto anchor would land (u≈1.5 on w_south).
    const { walls, rooms } = shell(26, 10, [opening('d1', 1.6, 0.9)])
    const { members } = layoutHvac(walls, rooms, LOD400)
    const pads = padsOf(members)
    expect(pads.length).toBe(2)
    for (const pad of pads) {
      // pads stay on the south row (outside, z<0) …
      expect(pad.position[2]).toBeLessThan(0)
      // … and clear of the RO span [1.15, 2.05] by half a pad
      expect(Math.abs(pad.position[0] - 1.6)).toBeGreaterThanOrEqual(0.9 / 2 + 0.95 / 2 - 1e-9)
    }
  })

  test('a direction that runs off the wall grows the row the other way', () => {
    // Anchor the row near a wall END: override at the far-west end of the
    // south wall — unit #2 cannot step west, so it must step EAST.
    const { walls, rooms } = shell(26, 10)
    const { fixtures } = layoutHvac(walls, rooms, LOD400, {
      heatPump: { position: [0.2, 0, -0.7] },
    })
    const units = condensersOf(fixtures)
    expect(units.length).toBe(2)
    expect(units[0]?.position[0]).toBeCloseTo(0.2, 6)
    expect(units[1]?.position[0]).toBeGreaterThan(0.2)
  })
})

// ---------------------------------------------------------------------------
// Line-set + disconnect
// ---------------------------------------------------------------------------

describe('line-set — Manhattan wall penetration to the air handler; disconnect within sight', () => {
  const { walls, rooms } = shell(26, 10)
  const { members, fixtures } = layoutHvac(walls, rooms, LOD400)
  const handler = fixtures.find((f) => f.label?.includes('Air handler')) as Fixture
  const units = condensersOf(fixtures)

  test('each unit has a suction+liquid pair whose run reaches the air handler', () => {
    expect(units.length).toBe(2)
    for (let n = 1; n <= units.length; n++) {
      const legs = members.filter((m) => m.sourceId === `lineset-${n}` && m.role === 'pipe-run')
      const suction = legs.filter((m) => m.label?.includes('suction'))
      const liquid = legs.filter((m) => m.label?.includes('liquid'))
      expect(suction.length).toBeGreaterThan(0)
      expect(liquid.length).toBeGreaterThan(0)
      // endpoint lands at the handler plan point
      const reaches = suction.some((m) =>
        endpointsOf(m).some(
          (e) => Math.hypot(e.x - handler.position[0], e.z - handler.position[2]) < 0.06,
        ),
      )
      expect(reaches).toBe(true)
      // … and at the unit
      const unit = units[n - 1] as Fixture
      const atUnit = suction.some((m) =>
        endpointsOf(m).some(
          (e) => Math.hypot(e.x - unit.position[0], e.z - unit.position[2]) < 0.06,
        ),
      )
      expect(atUnit).toBe(true)
    }
  })

  test('every line-set leg is plan-axis-aligned (Manhattan — no diagonal air runs)', () => {
    const legs = members.filter((m) => m.sourceId.startsWith('lineset-'))
    expect(legs.length).toBeGreaterThan(0)
    for (const m of legs) {
      const quarter = m.rotation[1] / (Math.PI / 2)
      expect(Math.abs(quarter - Math.round(quarter))).toBeLessThan(1e-9)
    }
  })

  test('the run penetrates the wall at ~0.4 m — outside leg to the wall plane, inside leg onward', () => {
    // Row lives on the south wall (z = 0). The through-wall pair: one leg
    // arrives at the centerline from OUTSIDE, another leaves it INSIDE.
    const suction = members.filter(
      (m) => m.sourceId.startsWith('lineset-') && m.label?.includes('suction'),
    )
    const arrivesFromOutside = suction.some((m) => {
      const [a, b] = endpointsOf(m)
      const zs = [a.z, b.z].sort((p, q) => p - q)
      return Math.abs((zs[1] as number) - 0) < 1e-6 && (zs[0] as number) < -0.3
    })
    const continuesInside = suction.some((m) => {
      const [a, b] = endpointsOf(m)
      const zs = [a.z, b.z].sort((p, q) => p - q)
      return Math.abs((zs[0] as number) - 0) < 1e-6 && (zs[1] as number) > 0.3
    })
    expect(arrivesFromOutside).toBe(true)
    expect(continuesInside).toBe(true)
    for (const m of suction) expect(m.position[1]).toBeCloseTo(0.42, 6)
  })

  test('a door RO on the default elbow path reroutes the line-set (E1 for pipe)', () => {
    // Force unit #1 to (8, −0.7): the default path runs pen(8,0) → (1.5,0)
    // ALONG the south wall band — straight through the door RO at u=5. The
    // alternate elbow (inward first, then across) clears it.
    const withDoor = shell(26, 10, [opening('d_mid', 5, 0.9)])
    const out = layoutHvac(withDoor.walls, withDoor.rooms, DEFAULT_SPEC, {
      heatPump: { position: [8, 0, -0.7] },
    })
    const suction = out.members.filter(
      (m) => m.sourceId === 'lineset-1' && m.label?.includes('suction'),
    )
    expect(suction.length).toBeGreaterThan(0)
    // no leg runs along the wall band across the door (both endpoints z≈0
    // spanning x=5) …
    const crossesDoorInWall = suction.some((m) => {
      const [a, b] = endpointsOf(m)
      const spansDoor = Math.min(a.x, b.x) < 4.5 && Math.max(a.x, b.x) > 5.5
      return spansDoor && Math.abs(a.z) < 0.11 && Math.abs(b.z) < 0.11
    })
    expect(crossesDoorInWall).toBe(false)
    // … the rerouted run still reaches the handler, unflagged
    for (const m of suction) expect(m.flag).toBeUndefined()
    const reaches = suction.some((m) =>
      endpointsOf(m).some((e) => Math.hypot(e.x - 1.5, e.z - 1.5) < 0.06),
    )
    expect(reaches).toBe(true)
  })

  test('a run that CANNOT clear an RO is ⚠-flagged, never silent', () => {
    // Interior wall with a door dead between the penetration and the air
    // handler at the same x — both elbows produce the same blocked path.
    const blocked = shell(26, 10)
    blocked.walls.push(
      wall('w_block', [0, 1.0], [3, 1.0], false, [opening('d_block', 1.5, 0.9)]),
    )
    const out = layoutHvac(blocked.walls, blocked.rooms, LOD400)
    const legs = out.members.filter((m) => m.sourceId === 'lineset-1')
    expect(legs.length).toBeGreaterThan(0)
    expect(legs.some((m) => m.flag?.includes('lineset crosses a door/window RO'))).toBe(true)
  })

  test('a disconnect mounts within 1 m of each unit, one per unit (NEC 440.14)', () => {
    const disconnects = fixtures.filter((f) => f.kind === 'disconnect')
    expect(disconnects.length).toBe(units.length)
    for (let n = 1; n <= units.length; n++) {
      const disc = disconnects.find((f) => f.meta?.unit === n) as Fixture
      const unit = units[n - 1] as Fixture
      expect(disc).toBeDefined()
      const dist = Math.hypot(
        disc.position[0] - unit.position[0],
        disc.position[1] - unit.position[1],
        disc.position[2] - unit.position[2],
      )
      expect(dist).toBeLessThanOrEqual(1.0)
      expect(disc.label).toContain('dedicated circuit — routed separately')
    }
    // + a whip per unit (liquid-tight conduit, never NM-B)
    const whips = new Set(
      members.filter((m) => m.sourceId.startsWith('ac-whip-')).map((m) => m.sourceId),
    )
    expect(whips.size).toBe(units.length)
  })
})

// ---------------------------------------------------------------------------
// Overrides (checklist A4) + legacy anchor
// ---------------------------------------------------------------------------

describe('heat-pump override moves unit #1 and the row follows (A4)', () => {
  test('unit #1 lands VERBATIM on the node; the rest re-anchor to its wall', () => {
    const { walls, rooms } = shell(26, 10)
    const moved = layoutHvac(walls, rooms, DEFAULT_SPEC, { heatPump: { position: [28, 0, 3] } })
    const units = condensersOf(moved.fixtures)
    expect(units.length).toBe(2) // override triggers the row at ANY LOD
    expect(units[0]?.position[0]).toBeCloseTo(28, 6)
    expect(units[0]?.position[2]).toBeCloseTo(3, 6)
    // row re-anchors to the EAST wall (x = 26): unit #2 keeps the anchor's
    // stand-off and steps along z at pad + clearance pitch
    expect(units[1]?.position[0]).toBeCloseTo(28, 6)
    expect(Math.abs((units[1]?.position[2] ?? 0) - 3)).toBeCloseTo(0.95 + 0.6, 6)
    // line-set #1 re-anchors with it
    const legs = moved.members.filter((m) => m.sourceId === 'lineset-1')
    expect(legs.length).toBeGreaterThan(0)
    const reaches = legs.some((m) =>
      endpointsOf(m).some((e) => Math.hypot(e.x - 28, e.z - 3) < 0.06),
    )
    expect(reaches).toBe(true)
  })

  test('no override, small scene → single unit at the legacy auto anchor', () => {
    const { walls, rooms } = shell(10, 8)
    const spot = placeHeatPumpSpot(walls, rooms)
    const { fixtures } = layoutHvac(walls, rooms, LOD400)
    const units = condensersOf(fixtures)
    expect(units.length).toBe(1)
    expect(units[0]?.position[0]).toBeCloseTo(spot?.[0] ?? Number.NaN, 12)
    expect(units[0]?.position[2]).toBeCloseTo(spot?.[1] ?? Number.NaN, 12)
    // LOD 300 without an override still emits NO outdoor row (legacy gating)
    const at300 = layoutHvac(walls, rooms)
    expect(condensersOf(at300.fixtures).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Takeoff (checklist S4 — book exactly what renders)
// ---------------------------------------------------------------------------

describe('takeoff — condenser rows mirror the rendered members/fixtures (S4)', () => {
  const { walls, rooms } = shell(26, 10)
  const { members, fixtures } = layoutHvac(walls, rooms, LOD400)
  const rows = computeTakeoff(members, fixtures)
  const find = (item: string) => rows.find((r) => r.item === item)

  test('AC condensers / pads / disconnects / whips count the rendered units', () => {
    const n = condensersOf(fixtures).length
    expect(n).toBe(2)
    expect(find('AC condensers')?.quantity).toBe(n)
    expect(find('AC condensers')?.detail).toContain('tons total')
    expect(find('Condenser pads')?.quantity).toBe(padsOf(members).length)
    expect(find('AC disconnects')?.quantity).toBe(n)
    expect(find('Condenser whips')?.quantity).toBe(n)
  })

  test('line-set books by pair length on its own row — never copper lf or elbows', () => {
    const suctionM = members
      .filter((m) => m.sourceId.startsWith('lineset-') && m.label?.includes('suction'))
      .reduce((sum, m) => sum + m.length, 0)
    const row = find('Refrigerant line-set')
    expect(row).toBeDefined()
    expect(row?.quantity).toBeCloseTo(Math.round(suctionM * 3.28084 * 10) / 10, 1)
    // no phantom plumbing-style copper rows or fittings out of the line-set
    const hvacCopper = rows.filter((r) => r.section === 'HVAC' && r.item.startsWith('Copper'))
    expect(hvacCopper).toHaveLength(0)
    // whips never leak into NM-B lineal feet (they are conduit kits)
    const nm = rows.filter((r) => r.item.startsWith('NM-B'))
    expect(nm).toHaveLength(0)
  })

  test('condensers leave the generic Mechanical equipment row to the air handler', () => {
    expect(find('Mechanical equipment')?.quantity).toBe(1)
  })
})
