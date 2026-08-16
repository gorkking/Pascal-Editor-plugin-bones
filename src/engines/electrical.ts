/**
 * Electrical layout engine — NEC 210.52 receptacle geometry plus the
 * layout-computable slice of 210.70 (switches/lights), 210.8 (GFCI zones),
 * IRC R314 (smoke alarms) and a service panel. Pure function:
 * (WallSlice[], RoomSlice[]) → Fixture[] — no Members, no store access.
 *
 * Numeric rules come from data/electrical-rules.json (NEC 2023 basis; see
 * docs/research/electrical.md for the full derivation and edition deltas).
 *
 * Geometry follows the wall-framing convention: a wall runs +X in its local
 * frame from `start` along `dir = [dx, dz]`; the +v cross-wall axis maps to
 * level [-dz, dx] and yaw = atan2(-dz, dx). Devices are offset to a wall FACE
 * (half thickness + a device-box proud) and rotated so their local +Z — the
 * renderer's box depth axis — points away from the wall.
 */

import rules from '../../data/electrical-rules.json'
import type { Fixture, Member, RoomSlice, WallSlice } from '../core/types'
import { feet, inches } from '../core/units'

// ---- rule constants (data/electrical-rules.json) --------------------------

/** NEC 210.52(A)(1): max 12 ft between receptacles along the floor line. */
const MAX_SPACING = feet(rules.receptacles.wallSpacingMaxFt)
/** NEC 210.52(A)(1): no floor-line point > 6 ft from a receptacle → first one within 6 ft of every break. */
const MAX_FROM_BREAK = feet(rules.receptacles.maxFromOpeningFt)
/** NEC 210.52(A)(2)(1): only wall spaces >= 2 ft wide count. */
const MIN_SEGMENT = feet(rules.receptacles.minWallWidthFt)
/** 15" AFF — convention + ANSI A117.1 min reach, not NEC (see heightAffNote). */
const RECEPTACLE_AFF = inches(rules.receptacles.heightAffIn)
/** 48" AFF — convention + ANSI A117.1 max reach, not NEC. */
const SWITCH_AFF = inches(rules.switches.heightAffIn)
/** Device box sits proud of the framing face by the finish layer (~5/8" drywall). */
const FACE_OFFSET = inches(0.75)
/** Practice: switch box centered ~8" past the door casing on the latch side. */
const SWITCH_LATCH_OFFSET = inches(8)
/** Panel center at 60" AFF — keeps the top breaker under NEC 240.24(A)'s 6'-7" handle limit. */
const PANEL_AFF = inches(60)

/**
 * NEC 210.8(A) GFCI locations we can resolve from RoomSlice.category alone:
 * bathrooms (A)(1), garages (A)(2), kitchens (A)(6) — ALL kitchen receptacles
 * under NEC 2023 — and laundry areas (A)(10).
 */
const GFCI_CATEGORIES: ReadonlySet<RoomSlice['category']> = new Set([
  'kitchen',
  'bathroom',
  'garage',
  'laundry',
])

// ---- small 2D helpers ------------------------------------------------------

type Pt = readonly [number, number]
type Polygon = readonly Pt[]

/**
 * Even-odd ray-cast point-in-polygon (ray toward +X). Good enough for room
 * zones: face points sit ~3" inside a room, never on an edge.
 */
export function pointInPolygon(p: Pt, polygon: Polygon): boolean {
  const [px, pz] = p
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i] ?? [0, 0]
    const [xj, zj] = polygon[j] ?? [0, 0]
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/** Area centroid of a simple polygon; falls back to the vertex mean when degenerate. */
export function polygonCentroid(polygon: Polygon): Pt {
  let area = 0
  let cx = 0
  let cz = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i] ?? [0, 0]
    const [xj, zj] = polygon[j] ?? [0, 0]
    const cross = xj * zi - xi * zj
    area += cross
    cx += (xi + xj) * cross
    cz += (zi + zj) * cross
  }
  if (Math.abs(area) < 1e-9) {
    let mx = 0
    let mz = 0
    for (const [x, z] of polygon) {
      mx += x
      mz += z
    }
    const n = Math.max(1, polygon.length)
    return [mx / n, mz / n]
  }
  return [cx / (3 * area), cz / (3 * area)]
}

// ---- wall faces ------------------------------------------------------------

/** One mountable face of a wall: outward normal side `+1` (the +v axis, level [-dz, dx]) or `-1`. */
type WallFace = {
  side: 1 | -1
  /** Y rotation mapping a device's local +Z onto the face's outward normal. */
  rotationY: number
  /** Floor-plan point of a device on this face at distance `u` along the wall. */
  plan: (u: number) => Pt
}

function faceOf(wall: WallSlice, side: 1 | -1): WallFace {
  const [dx, dz] = wall.dir
  const [sx, sz] = wall.start
  // Outward normal: rotating local +Z by yaw = atan2(-dz, dx) gives [-dz, dx]
  // (the wall-framing +v axis); the -1 face is its negation.
  const nx = -dz * side
  const nz = dx * side
  const off = wall.thickness / 2 + FACE_OFFSET
  return {
    side,
    // Ry(θ) maps +Z → [sin θ, 0, cos θ]; we want +Z → [nx, 0, nz].
    rotationY: Math.atan2(nx, nz),
    plan: (u) => [sx + dx * u + nx * off, sz + dz * u + nz * off],
  }
}

/**
 * Faces that get devices. Interior walls serve rooms on BOTH sides. Exterior
 * walls get devices on the interior face only — resolved by testing which
 * face's midpoint falls inside a room polygon.
 * ASSUMPTION: face choice is made once at the wall midpoint; walls whose
 * interior side flips mid-run (rare) would need per-segment resolution.
 */
function interiorFaces(wall: WallSlice, rooms: RoomSlice[]): WallFace[] {
  const plus = faceOf(wall, 1)
  const minus = faceOf(wall, -1)
  if (!wall.exterior) return [plus, minus]
  const mid = wall.length / 2
  const inRoom = (f: WallFace) => rooms.some((r) => pointInPolygon(f.plan(mid), r.polygon))
  if (inRoom(plus)) return [plus]
  if (inRoom(minus)) return [minus]
  // No room data covers this wall — fall back to the +normal side.
  return [plus]
}

// ---- rough-opening geometry --------------------------------------------------

type RoSpan = { lo: number; hi: number; sillY: number; topY: number }

/**
 * Horizontal RO intervals of every opening whose vertical rough opening
 * crosses [y0, y1]. Cable, boxes and panels can't occupy ANY rough opening —
 * doors, windows, fixed glazing alike. Adjacent spans merge (a mulled window
 * pair or door+sidelite detours once, not twice).
 */
export function openingSpans(wall: WallSlice, y0: number, y1: number): RoSpan[] {
  const spans = wall.openings
    .filter((o) => o.sillHeight < y1 && o.sillHeight + o.roughHeight > y0)
    .map((o) => ({
      lo: Math.max(0, o.u - o.roughWidth / 2),
      hi: Math.min(wall.length, o.u + o.roughWidth / 2),
      sillY: o.sillHeight,
      topY: o.sillHeight + o.roughHeight,
    }))
    .filter((s) => s.hi > s.lo)
    .sort((a, b) => a.lo - b.lo)
  const merged: RoSpan[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.lo <= last.hi + inches(4)) {
      last.hi = Math.max(last.hi, s.hi)
      last.sillY = Math.min(last.sillY, s.sillY)
      last.topY = Math.max(last.topY, s.topY)
    } else merged.push({ ...s })
  }
  return merged
}

// ---- receptacle walk (NEC 210.52(A)) ----------------------------------------

type Segment = { a: number; b: number }

/**
 * Usable wall spaces along the floor line: DOORWAYS break the wall line
 * [210.52(A)(2)(1)] but windows do NOT — fixed glass counts as wall space
 * [210.52(A)(2)(2)], so receptacles land under windows. We break at the rough
 * opening (framing hole ≈ finished doorway + casing).
 * // LOD 400: NEC 2023 also breaks at stationary appliances and counterless
 * // fixed cabinets — needs furniture/casework data the scene doesn't carry yet.
 */
export function usableSegments(wall: WallSlice): Segment[] {
  const breaks: Segment[] = []
  // A box also can't mount in glass: any opening whose RO drops below the
  // top of a receptacle box (floor-to-ceiling glazing, low picture windows,
  // sliders) breaks the wall space exactly like a doorway.
  const boxTopY = RECEPTACLE_AFF + inches(4)
  for (const opening of wall.openings) {
    if (opening.kind !== 'door' && opening.sillHeight >= boxTopY) continue
    const a = Math.max(0, opening.u - opening.roughWidth / 2)
    const b = Math.min(wall.length, opening.u + opening.roughWidth / 2)
    if (b > a) breaks.push({ a, b })
  }
  breaks.sort((p, q) => p.a - q.a)

  const segments: Segment[] = []
  let cursor = 0
  for (const brk of breaks) {
    if (brk.a > cursor) segments.push({ a: cursor, b: brk.a })
    cursor = Math.max(cursor, brk.b)
  }
  if (cursor < wall.length) segments.push({ a: cursor, b: wall.length })
  // 210.52(A)(2)(1): wall spaces narrower than 2 ft don't require receptacles.
  return segments.filter((s) => s.b - s.a >= MIN_SEGMENT)
}

/**
 * Receptacle u-positions inside one wall space so no floor-line point is more
 * than 6 ft from a receptacle [210.52(A)(1)]: n = ceil(L / 12ft) devices on
 * even centers — the pitch L/n is <= 12 ft and each end overhang L/2n <= 6 ft,
 * so both the 12 ft run rule and the 6 ft from-every-break rule hold.
 */
export function receptaclePositions(segment: Segment): number[] {
  const length = segment.b - segment.a
  const count = Math.max(1, Math.ceil(length / MAX_SPACING))
  const pitch = length / count
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(segment.a + pitch * (i + 0.5))
  return out
}

// ---- engine ------------------------------------------------------------------

/**
 * Lay out the electrical fixtures for one level.
 *  - receptacles per 210.52(A) on every wall face that serves a room
 *  - GFCI marking per 210.8(A) room zones
 *  - a switch at each door's latch side (210.70(A)(1) + universal practice)
 *  - a ceiling light per room (210.70(A)(1))
 *  - smoke alarms per IRC R314 (each bedroom + hallway outside sleeping areas)
 *  - one service panel
 */
export function layoutElectrical(walls: WallSlice[], rooms: RoomSlice[]): Fixture[] {
  const fixtures: Fixture[] = []
  const wetRooms = rooms.filter((r) => GFCI_CATEGORIES.has(r.category))

  for (const wall of walls) {
    // Curved walls are flagged upstream (matches wall framing) — skip in v1.
    if (wall.curved) continue
    const faces = interiorFaces(wall, rooms)

    // ---- receptacles: the 6ft/12ft walk (NEC 210.52(A)) ----
    // ASSUMPTION: every wall is treated as bounding a habitable room
    // requiring the 6 ft rule; 210.52 technically scopes this to
    // kitchen/living/bed/etc. — over-placing is the safe drafting default.
    // LOD 400: wall spaces should WRAP inside corners (two 5 ft walls meeting
    // in a corner are one 10 ft space); walking per-wall over-counts slightly.
    for (const segment of usableSegments(wall)) {
      for (const u of receptaclePositions(segment)) {
        for (const face of faces) {
          const [x, z] = face.plan(u)
          // NEC 210.8(A): device lands in a kitchen/bath/garage/laundry zone → GFCI.
          // LOD 400: add the within-6-ft-of-sink/tub test [210.8(A)(7)/(9)]
          // once fixture (sink) positions are extracted from the scene.
          const gfci = wetRooms.some((r) => pointInPolygon([x, z], r.polygon))
          fixtures.push({
            system: 'electrical',
            kind: gfci ? 'receptacle-gfci' : 'receptacle',
            position: [x, RECEPTACLE_AFF, z],
            rotationY: face.rotationY,
            sourceId: wall.id,
          })
        }
      }
    }

    // ---- switches: one per door at the latch side (210.70(A)(1) practice) ----
    for (const opening of wall.openings) {
      if (opening.kind !== 'door') continue
      const halfRo = opening.roughWidth / 2
      // ASSUMPTION: the scene doesn't carry door swing/hinge data, so the
      // latch defaults to the +u side of the opening; flip when the box
      // would run past the wall end.
      let u = opening.u + halfRo + SWITCH_LATCH_OFFSET
      if (u > wall.length - inches(1)) u = opening.u - halfRo - SWITCH_LATCH_OFFSET
      // A window butted against the latch side would swallow the box —
      // nudge out of any RO crossing switch height (prod report: boxes
      // rendering on top of doors/windows).
      u = clearOfOpenings(wall, u, SWITCH_AFF - inches(6), SWITCH_AFF + inches(6))
      // No wall left for a box: the door consumes the whole wall, or the
      // opening data runs past the wall end (degenerate scene) — never place
      // a switch off the end of its wall.
      if (u < inches(1) || u > wall.length - inches(1)) continue
      for (const face of faces) {
        const [x, z] = face.plan(u)
        fixtures.push({
          system: 'electrical',
          kind: 'switch',
          position: [x, SWITCH_AFF, z],
          rotationY: face.rotationY,
          sourceId: opening.id,
          label: 'Switch (48" AFF, latch side)',
        })
      }
    }
  }

  // ---- lights: one switched lighting outlet per habitable room (210.70(A)(1)) ----
  for (const room of rooms) {
    const [cx, cz] = polygonCentroid(room.polygon)
    fixtures.push({
      system: 'electrical',
      kind: 'light',
      position: [cx, room.ceilingHeight, cz],
      rotationY: 0,
      sourceId: room.id,
      label: `Light — ${room.name || room.category}`,
    })
    // LOD 400: hallways and stairways (>= 6 risers) need 3-way switching with
    // a switch at each entry/floor level [210.70(A)(2)(3)] — model switch legs
    // once the stair graph is available.

    // ---- smoke alarms: one in each sleeping room (IRC R314.3) ----
    if (room.category === 'bedroom') {
      fixtures.push({
        system: 'electrical',
        kind: 'smoke-alarm',
        // ASSUMPTION: nudged 12" off the centroid so it doesn't z-fight the
        // room light; R314 only requires "in the room", ceiling mount typical.
        position: [cx + inches(12), room.ceilingHeight, cz],
        rotationY: 0,
        sourceId: room.id,
        label: `Smoke alarm — ${room.name || 'bedroom'}`,
      })
    }
  }

  // ---- smoke alarm outside the sleeping area (IRC R314.3): hallway proxy ----
  const hallway = rooms.find((r) => r.category === 'hallway')
  if (hallway) {
    const [hx, hz] = polygonCentroid(hallway.polygon)
    fixtures.push({
      system: 'electrical',
      kind: 'smoke-alarm',
      position: [hx, hallway.ceilingHeight, hz],
      rotationY: 0,
      sourceId: hallway.id,
      label: 'Smoke alarm — outside sleeping area (R314)',
    })
    // LOD 400: R314.3.3 cooking-appliance clearances (20 ft ionization / 6 ft
    // photoelectric) + one alarm per story; CO alarm per R315 near bedrooms.
  }

  // ---- door-less hallways still need a switched light (210.70(A)(2)) ----
  // The per-door pass above only serves rooms with doors; a hallway drawn
  // without door openings would get a light but no control.
  for (const room of rooms) {
    if (room.category !== 'hallway') continue
    const hasSwitch = fixtures.some(
      (f) => f.kind === 'switch' && pointInPolygon([f.position[0], f.position[2]], room.polygon),
    )
    if (hasSwitch) continue
    const [hx, hz] = polygonCentroid(room.polygon)
    let best: { face: WallFace; u: number; d: number } | null = null
    for (const wall of walls) {
      if (wall.curved) continue
      for (const face of interiorFaces(wall, rooms)) {
        const [ax, az] = wall.start
        const u = Math.max(
          inches(4),
          Math.min(wall.length - inches(4), (hx - ax) * wall.dir[0] + (hz - az) * wall.dir[1]),
        )
        const [px, pz] = face.plan(u)
        if (!pointInPolygon([px, pz], room.polygon)) continue
        const d = Math.hypot(px - hx, pz - hz)
        if (!best || d < best.d) best = { face, u, d }
      }
    }
    if (best) {
      const [x, z] = best.face.plan(best.u)
      fixtures.push({
        system: 'electrical',
        kind: 'switch',
        position: [x, SWITCH_AFF, z],
        rotationY: best.face.rotationY,
        sourceId: room.id,
        label: 'Switch — hallway lighting (210.70(A)(2))',
      })
    }
  }

  // ---- service panel ----
  const panel = placePanel(walls, rooms)
  if (panel) fixtures.push(panel)

  // ---- circuiting (NEC 210.11/210.12/220.12) + 3-way switching ----
  assignCircuits(fixtures, rooms)

  return fixtures
}

/**
 * Service panel: garages are the customary spot (surface-mount, unfinished
 * wall) — pick the longest wall bounding a garage; otherwise the longest
 * exterior wall. Mounted at the wall-face midpoint, center 60" AFF.
 * // LOD 400: enforce NEC 110.26 working clearance (30" wide x 36" deep) and
 * // 240.24(D)/(E) (not in bathrooms / over steps) against the room geometry.
 */
/**
 * Mount coordinate for the panel on its wall: the midpoint when clear, else
 * the center of the WIDEST opening-free segment (panels need 30in of working
 * space — NEC 110.26 — and can never live inside a rough opening; a window
 * crossing the enclosure's height counts exactly like a door).
 */
export function panelMountU(wall: WallSlice): number {
  const mid = wall.length / 2
  // Enclosure ≈ 30in tall centered at 60in AFF — and ~16in WIDE, so the
  // rough opening must clear the box EDGE, not just its centerline, plus
  // working clearance off the casing (prod report: a door overlapping the
  // wall midpoint by a sliver left the panel jammed against the jamb).
  const PANEL_HALF_W = inches(8)
  const CLEARANCE = inches(6)
  const inflate = PANEL_HALF_W + CLEARANCE
  const doors = openingSpans(wall, PANEL_AFF - inches(15), PANEL_AFF + inches(15)).map(
    (s) => [Math.max(0, s.lo - inflate), Math.min(wall.length, s.hi + inflate)] as const,
  )
  if (!doors.some(([lo, hi]) => mid > lo && mid < hi)) return mid
  let bestLo = 0
  let bestLen = -1
  let cursor = 0
  for (const [lo, hi] of doors) {
    if (lo - cursor > bestLen) {
      bestLen = lo - cursor
      bestLo = cursor
    }
    cursor = Math.max(cursor, hi)
  }
  if (wall.length - cursor > bestLen) {
    bestLen = wall.length - cursor
    bestLo = cursor
  }
  return bestLo + bestLen / 2
}

function placePanel(walls: WallSlice[], rooms: RoomSlice[]): Fixture | null {
  const straight = walls.filter((w) => !w.curved && w.length > 0)
  if (straight.length === 0) return null

  const garages = rooms.filter((r) => r.category === 'garage')
  const boundsGarage = (wall: WallSlice): RoomSlice | undefined =>
    garages.find(
      (g) =>
        g.boundaryWallIds.includes(wall.id) ||
        pointInPolygon(faceOf(wall, 1).plan(wall.length / 2), g.polygon) ||
        pointInPolygon(faceOf(wall, -1).plan(wall.length / 2), g.polygon),
    )

  const longest = (candidates: WallSlice[]): WallSlice | undefined =>
    candidates.reduce<WallSlice | undefined>(
      (best, w) => (best === undefined || w.length > best.length ? w : best),
      undefined,
    )

  const garageWall = longest(straight.filter((w) => boundsGarage(w) !== undefined))
  const wall = garageWall ?? longest(straight.filter((w) => w.exterior)) ?? longest(straight)
  if (!wall) return null

  // Face into the garage when we have one, else the resolved interior face.
  let face = interiorFaces(wall, rooms)[0] ?? faceOf(wall, 1)
  const garage = boundsGarage(wall)
  if (garage) {
    for (const side of [1, -1] as const) {
      const f = faceOf(wall, side)
      if (pointInPolygon(f.plan(wall.length / 2), garage.polygon)) face = f
    }
  }

  // Round-12 B1: a door spanning the wall midpoint used to swallow the
  // panel — every homerun then started from inside the RO and never
  // reached its anchor. Mount in the widest door-free segment instead.
  const mountU = panelMountU(wall)
  const [x, z] = face.plan(mountU)
  return {
    system: 'electrical',
    kind: 'panel',
    position: [x, PANEL_AFF, z],
    rotationY: face.rotationY,
    sourceId: wall.id,
    label: `Service panel (${rules.circuits.minServiceAmps}A min per NEC 230.79(C))`,
    meta: { minServiceAmps: rules.circuits.minServiceAmps },
  }
}

// ---------------------------------------------------------------------------
// Circuiting (NEC 210.11 required circuits, 210.12 AFCI, 220.12/220.14 loads)
// ---------------------------------------------------------------------------

/** 220.14(I): 180 VA per receptacle strap. */
const RECEPTACLE_VA = 180
/** 220.12: general lighting load, 3 VA per square foot. */
const LIGHTING_VA_PER_SQFT = 3
const SQFT_PER_M2 = 10.7639
/** 15A × 120V × 80% continuous ≈ 1440 VA → 8 general receptacles per circuit. */
const MAX_GENERAL_DEVICES = 8
/** Lighting circuits sized to ~1200 VA of 220.12 floor load. */
const MAX_LIGHTING_VA = 1200

/** Unsigned area of a simple polygon (m²). */
export function polygonArea(polygon: Polygon): number {
  let area = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i] ?? [0, 0]
    const [xj, zj] = polygon[j] ?? [0, 0]
    area += xj * zi - xi * zj
  }
  return Math.abs(area / 2)
}

/**
 * Assign every fixture to a branch circuit, stored flat in `fixture.meta`
 * ({circuit, breakerA, gaugeAwg, va, afci, gfci}):
 *  - kitchen receptacles alternate across the TWO 20A small-appliance
 *    circuits 210.11(C)(1) requires (SA-1/SA-2, 12 AWG);
 *  - bathroom (C)(3), laundry (C)(2) and garage (210.52(G)(1), 2023) get
 *    their dedicated 20A circuits;
 *  - remaining receptacles fill 15A general circuits 8 straps at a time;
 *  - lights/smoke alarms ride room lighting circuits packed to ~1200 VA of
 *    the 3 VA/ft² load, switches join the room they stand in;
 *  - AFCI marks follow 210.12(A) (kitchens/laundry/living areas — not
 *    bathrooms or garages, which carry the GFCI mark instead).
 * Then rooms holding 2+ switches get them relabeled as a 3-way group
 * (210.70(A)(2)(3) practice for multi-entry rooms and hallways).
 */
export function assignCircuits(fixtures: Fixture[], rooms: RoomSlice[]): void {
  const tag = (
    fixture: Fixture,
    circuit: string,
    breakerA: number,
    gaugeAwg: number,
    va: number,
    flags: { afci?: boolean; gfci?: boolean } = {},
  ): void => {
    fixture.meta = {
      ...fixture.meta,
      circuit,
      breakerA,
      gaugeAwg,
      va,
      ...(flags.afci ? { afci: true } : {}),
      ...(flags.gfci ? { gfci: true } : {}),
    }
  }
  const roomAt = (p: Pt): RoomSlice | undefined =>
    rooms.find((r) => pointInPolygon(p, r.polygon))

  // Lighting circuits: pack rooms in order until ~1200 VA of 220.12 load.
  const lightingOf = new Map<string, { circuit: string; va: number }>()
  let ltgIndex = 1
  let ltgVa = 0
  for (const room of rooms) {
    const va = Math.max(60, Math.round(polygonArea(room.polygon) * SQFT_PER_M2 * LIGHTING_VA_PER_SQFT))
    if (ltgVa > 0 && ltgVa + va > MAX_LIGHTING_VA) {
      ltgIndex += 1
      ltgVa = 0
    }
    ltgVa += va
    lightingOf.set(room.id, { circuit: `LTG-${ltgIndex}`, va })
  }
  const lightingFallback = { circuit: 'LTG-1', va: 60 }

  let kitchenFlip = 0
  let generalIndex = 1
  let generalCount = 0
  for (const fixture of fixtures) {
    const plan: Pt = [fixture.position[0], fixture.position[2]]
    const room = roomAt(plan)
    if (fixture.kind === 'receptacle' || fixture.kind === 'receptacle-gfci') {
      switch (room?.category) {
        case 'kitchen':
          // both required SABCs get used — straps alternate 210.11(C)(1)
          tag(fixture, `SA-${1 + (kitchenFlip++ % 2)}`, 20, 12, RECEPTACLE_VA, { afci: true, gfci: true })
          break
        case 'bathroom':
          tag(fixture, 'BA-1', 20, 12, RECEPTACLE_VA, { gfci: true })
          break
        case 'laundry':
          tag(fixture, 'LA-1', 20, 12, RECEPTACLE_VA, { afci: true, gfci: true })
          break
        case 'garage':
          tag(fixture, 'GA-1', 20, 12, RECEPTACLE_VA, { gfci: true })
          break
        default: {
          if (generalCount >= MAX_GENERAL_DEVICES) {
            generalIndex += 1
            generalCount = 0
          }
          generalCount += 1
          tag(fixture, `GEN-${generalIndex}`, 15, 14, RECEPTACLE_VA, { afci: true })
        }
      }
    } else if (fixture.kind === 'light' || fixture.kind === 'smoke-alarm') {
      const home = rooms.find((r) => r.id === fixture.sourceId)
      const lighting = (home && lightingOf.get(home.id)) ?? (room && lightingOf.get(room.id)) ?? lightingFallback
      tag(fixture, lighting.circuit, 15, 14, fixture.kind === 'light' ? lighting.va : 5, { afci: true })
    } else if (fixture.kind === 'switch') {
      const lighting = (room && lightingOf.get(room.id)) ?? lightingFallback
      tag(fixture, lighting.circuit, 15, 14, 0, { afci: true })
    }
  }

  // 3-way groups: a room whose interior holds 2+ switches (2+ doors, or a
  // hallway) needs each entry to control the light.
  for (const room of rooms) {
    const entries = fixtures.filter(
      (f) => f.kind === 'switch' && pointInPolygon([f.position[0], f.position[2]], room.polygon),
    )
    if (entries.length < 2) continue
    for (const s of entries) {
      s.meta = { ...s.meta, threeWay: true }
      s.label = `Switch (3-way — ${room.name || room.category}, ${entries.length} entries)`
    }
  }

  const panel = fixtures.find((f) => f.kind === 'panel')
  if (panel) {
    const circuits = new Set<string>()
    for (const f of fixtures) {
      if (typeof f.meta?.circuit === 'string') circuits.add(f.meta.circuit)
    }
    panel.meta = { ...panel.meta, circuits: circuits.size }
  }
}

export type CircuitRow = {
  circuit: string
  breakerA: number
  gaugeAwg: number
  devices: number
  va: number
  afci: boolean
  gfci: boolean
}

/** Panel schedule: one row per circuit, dedicated circuits first. */
export function circuitSchedule(fixtures: Fixture[]): CircuitRow[] {
  const rows = new Map<string, CircuitRow>()
  for (const f of fixtures) {
    const circuit = f.meta?.circuit
    if (typeof circuit !== 'string') continue
    const row = rows.get(circuit) ?? {
      circuit,
      breakerA: Number(f.meta?.breakerA ?? 15),
      gaugeAwg: Number(f.meta?.gaugeAwg ?? 14),
      devices: 0,
      va: 0,
      afci: false,
      gfci: false,
    }
    row.devices += 1
    row.va += Number(f.meta?.va ?? 0)
    row.afci = row.afci || f.meta?.afci === true
    row.gfci = row.gfci || f.meta?.gfci === true || f.kind === 'receptacle-gfci'
    rows.set(circuit, row)
  }
  const order = ['SA', 'BA', 'LA', 'GA', 'GEN', 'LTG']
  return [...rows.values()].sort((a, b) => {
    const pa = order.indexOf(a.circuit.split('-')[0] ?? '')
    const pb = order.indexOf(b.circuit.split('-')[0] ?? '')
    if (pa !== pb) return pa - pb
    return a.circuit.localeCompare(b.circuit, undefined, { numeric: true })
  })
}

// ---------------------------------------------------------------------------
// Wire routing (LOD 400): homeruns + branch chains following the WALLS
// ---------------------------------------------------------------------------

/** Horizontal runs bore through the studs at ~18" AFF (receptacle line). */
const WIRE_RUN_Y = inches(18)
/** Rendered NM sheath section — oversized so runs read at house scale. */
const WIRE_SECTION = inches(0.5)
/** Two wall ends within this distance share a junction (corner/tee). */
const JUNCTION_TOL = 0.25

type WallPoint = { wall: WallSlice; u: number }
/** One junction on a wall: at `u`, you can hop onto `to.wall` at `to.u`. */
type Junction = { u: number; to: WallPoint }

/** Plan point of a wall-centerline coordinate. */
const wallPlan = (p: WallPoint): Pt => [
  p.wall.start[0] + p.wall.dir[0] * p.u,
  p.wall.start[1] + p.wall.dir[1] * p.u,
]

/** Vertical zone the drill-height planes occupy (8 circuit steps + sheath). */
const RUN_ZONE_TOP = WIRE_RUN_Y + 8 * 0.012 + inches(2)

/** Snap a wall coordinate out of any rough opening crossing [y0, y1] —
 * cable can't drop through a doorway OR a window; it lands in the first
 * stud bay past the king studs. */
function clearOfOpenings(wall: WallSlice, u: number, y0 = 0, y1 = RUN_ZONE_TOP): number {
  // Box edge + casing clearance, not just the point: 4in keeps a device
  // visibly off the RO trim (prod report: box kissing the door edge).
  const margin = inches(4)
  for (const s of openingSpans(wall, y0, y1)) {
    if (u > s.lo && u < s.hi) {
      const snapLo = Math.max(margin, s.lo - margin)
      const snapHi = Math.min(wall.length - margin, s.hi + margin)
      return u - s.lo < s.hi - u ? snapLo : snapHi
    }
  }
  return u
}

/** Nearest wall-centerline point to a plan position (never inside a rough
 * opening that the anchor's vertical leg [0, yTop] would cross). */
function nearestWallPoint(walls: WallSlice[], p: Pt, yTop = RUN_ZONE_TOP): WallPoint | null {
  let best: WallPoint | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const wall of walls) {
    if (wall.curved || wall.length < 0.1) continue
    const [ax, az] = wall.start
    const raw = Math.max(0, Math.min(wall.length, (p[0] - ax) * wall.dir[0] + (p[1] - az) * wall.dir[1]))
    const u = clearOfOpenings(wall, raw, 0, Math.max(yTop, RUN_ZONE_TOP))
    const q = wallPlan({ wall, u })
    const d = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (d < bestDist) {
      bestDist = d
      best = { wall, u }
    }
  }
  return best
}

/**
 * The wall graph: every wall endpoint that lands on another wall (corner or
 * tee, within JUNCTION_TOL) becomes a two-way junction. Wiring travels only
 * along wall centerlines and hops walls at junctions.
 */
export function buildWallGraph(walls: WallSlice[]): Map<string, Junction[]> {
  const graph = new Map<string, Junction[]>()
  const add = (from: WallPoint, to: WallPoint) => {
    const list = graph.get(from.wall.id) ?? []
    list.push({ u: from.u, to })
    graph.set(from.wall.id, list)
  }
  const usable = walls.filter((w) => !w.curved && w.length >= 0.1)
  for (const wall of usable) {
    for (const endU of [0, wall.length]) {
      const p = wallPlan({ wall, u: endU })
      for (const other of usable) {
        if (other.id === wall.id) continue
        const [ax, az] = other.start
        const proj = Math.max(
          0,
          Math.min(other.length, (p[0] - ax) * other.dir[0] + (p[1] - az) * other.dir[1]),
        )
        const q = wallPlan({ wall: other, u: proj })
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) > JUNCTION_TOL) continue
        // A tee landing inside a rough opening would end a drill leg in the
        // doorway/window — snap the junction into the adjacent stud bay.
        const safeProj = clearOfOpenings(other, proj)
        add({ wall, u: endU }, { wall: other, u: safeProj })
        add({ wall: other, u: safeProj }, { wall, u: endU })
      }
    }
  }
  return graph
}

/**
 * BFS a leg list from one wall point to another, travelling only along
 * walls: [{wall, u0, u1}, …]. Null when the walls are disconnected.
 */
function wallPath(
  graph: Map<string, Junction[]>,
  from: WallPoint,
  to: WallPoint,
): { wall: WallSlice; u0: number; u1: number }[] | null {
  if (from.wall.id === to.wall.id) return [{ wall: from.wall, u0: from.u, u1: to.u }]
  type Visit = { point: WallPoint; prev: Visit | null; enteredAt: number }
  const visited = new Set<string>([from.wall.id])
  let frontier: Visit[] = [{ point: from, prev: null, enteredAt: from.u }]
  for (let hop = 0; hop < 32 && frontier.length > 0; hop++) {
    const next: Visit[] = []
    for (const visit of frontier) {
      for (const junction of graph.get(visit.point.wall.id) ?? []) {
        const targetId = junction.to.wall.id
        if (visited.has(targetId)) continue
        visited.add(targetId)
        const arrival: Visit = {
          point: junction.to,
          prev: { ...visit, point: { wall: visit.point.wall, u: junction.u } },
          enteredAt: junction.to.u,
        }
        if (targetId === to.wall.id) {
          // reconstruct: walk back through the junctions
          const legs: { wall: WallSlice; u0: number; u1: number }[] = [
            { wall: to.wall, u0: arrival.enteredAt, u1: to.u },
          ]
          let cursor: Visit | null = arrival.prev
          while (cursor) {
            legs.unshift({ wall: cursor.point.wall, u0: cursor.enteredAt, u1: cursor.point.u })
            cursor = cursor.prev
          }
          return legs
        }
        next.push(arrival)
      }
    }
    frontier = next
  }
  return null
}

/**
 * Route every circuit as geometry that FOLLOWS THE WALLS: one homerun drop
 * at the panel, then a greedy nearest-neighbor chain through the circuit's
 * devices — each hop travels along wall centerlines at drill height,
 * hopping walls at corner/tee junctions, with a vertical leg at the
 * device's wall anchor. Ceiling devices (lights, smoke alarms) rise at
 * their nearest wall and cross the CEILING in two Manhattan legs (through
 * the joist bays). Disconnected islands fall back to Manhattan air legs,
 * flagged in the label. Lengths by gauge feed the takeoff's NM lines.
 */
export function routeWiring(fixtures: Fixture[], walls: WallSlice[] = []): Member[] {
  const members: Member[] = []
  const panel = fixtures.find((f) => f.kind === 'panel')
  if (!panel) return members
  const graph = buildWallGraph(walls)

  const byCircuit = new Map<string, Fixture[]>()
  for (const f of fixtures) {
    if (f === panel) continue
    const circuit = f.meta?.circuit
    if (typeof circuit !== 'string') continue
    const list = byCircuit.get(circuit) ?? []
    list.push(f)
    byCircuit.set(circuit, list)
  }

  const emitWire = (
    circuit: string,
    gauge: number,
    from: readonly [number, number, number],
    to: readonly [number, number, number],
    note = '',
  ): void => {
    const dx = to[0] - from[0]
    const dy = to[1] - from[1]
    const dz = to[2] - from[2]
    const len = Math.hypot(dx, dy, dz)
    if (len < 0.02) return
    const vertical = Math.abs(dy) > Math.hypot(dx, dz)
    members.push({
      system: 'electrical',
      role: 'wire-run',
      dims: vertical ? [WIRE_SECTION, len, WIRE_SECTION] : [len, WIRE_SECTION, WIRE_SECTION],
      length: len,
      position: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2],
      rotation: [0, vertical ? 0 : Math.atan2(-dz, dx), 0],
      material: 'copper',
      sourceId: circuit,
      label: `NM-B ${gauge}/2 w/G — ${circuit}${note}`,
    })
  }

  /**
   * One drill-height leg along a wall — DETOURING around ANY rough opening
   * whose vertical RO crosses the drill plane (doors always; windows when
   * the sill drops below drill height — prod report: wires bored straight
   * through low windows). Route: rise inside the king-stud bay, cross above
   * the header, drop back — or duck UNDER the sill when there's no wall
   * above (full-height glazing with a stub sill).
   */
  const emitWallLeg = (
    circuit: string,
    gauge: number,
    wall: WallSlice,
    u0: number,
    u1: number,
    runY: number = WIRE_RUN_Y,
  ): void => {
    const dir = Math.sign(u1 - u0) || 1
    const legLo = Math.min(u0, u1)
    const legHi = Math.max(u0, u1)
    const crossed = openingSpans(wall, runY - 0.02, runY + 0.02)
      .filter((s) => s.lo < legHi && s.hi > legLo)
      .sort((a, b) => (a.lo - b.lo) * dir)
    const at = (u: number, y: number): [number, number, number] => {
      const p = wallPlan({ wall, u })
      return [p[0], y, p[1]]
    }
    const clamp = (u: number) => Math.max(legLo, Math.min(legHi, u))
    let cursor = u0
    for (const s of crossed) {
      const near = clamp(dir > 0 ? s.lo : s.hi)
      const far = clamp(dir > 0 ? s.hi : s.lo)
      // The crossing band itself must be clear too — a transom above a door
      // sits exactly where the over-the-header path would run.
      const blockedAt = (yy: number) =>
        openingSpans(wall, yy - 0.02, yy + 0.02).some((o) => o.lo < s.hi && o.hi > s.lo)
      let detourY: number | null = null
      for (let yy = s.topY + inches(4); yy <= wall.height - 0.05; yy += inches(4)) {
        if (!blockedAt(yy)) {
          detourY = yy
          break
        }
      }
      if (detourY === null) {
        for (let yy = s.sillY - inches(4); yy >= 0.04; yy -= inches(4)) {
          if (!blockedAt(yy)) {
            detourY = yy
            break
          }
        }
      }
      if (detourY === null) {
        // RO spans floor to ceiling — nowhere inside this wall to route.
        emitWire(circuit, gauge, at(cursor, runY), at(far, runY), ' (⚠ crosses full-height opening — verify)')
        cursor = far
        continue
      }
      emitWire(circuit, gauge, at(cursor, runY), at(near, runY))
      emitWire(circuit, gauge, at(near, runY), at(near, detourY))
      emitWire(circuit, gauge, at(near, detourY), at(far, detourY))
      emitWire(circuit, gauge, at(far, detourY), at(far, runY))
      cursor = far
    }
    emitWire(circuit, gauge, at(cursor, runY), at(u1, runY))
  }

  /** Wall-following legs between two anchors at drill height. */
  const routeHop = (
    circuit: string,
    gauge: number,
    from: WallPoint,
    to: WallPoint,
    runY: number = WIRE_RUN_Y,
  ): void => {
    const legs = wallPath(graph, from, to)
    if (legs) {
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i] as { wall: WallSlice; u0: number; u1: number }
        emitWallLeg(circuit, gauge, leg.wall, leg.u0, leg.u1, runY)
        // Round-12 B2/M1: junctions accepted within JUNCTION_TOL (or
        // snapped out of a door RO) leave the two walls' legs ending at
        // DIFFERENT plan points. Bridge every inter-leg gap explicitly —
        // a circuit is continuous cable, not adjacent segments.
        const next = legs[i + 1]
        if (next) {
          const a = wallPlan({ wall: leg.wall, u: leg.u1 })
          const b = wallPlan({ wall: next.wall, u: next.u0 })
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.02) {
            emitWire(circuit, gauge, [a[0], runY, a[1]], [b[0], runY, b[1]], ' (junction jumper)')
          }
        }
      }
      return
    }
    // Disconnected wall islands: Manhattan air legs, called out in the label.
    const a = wallPlan(from)
    const b = wallPlan(to)
    emitWire(circuit, gauge, [a[0], runY, a[1]], [b[0], runY, a[1]], ' (air run — no wall path)')
    emitWire(circuit, gauge, [b[0], runY, a[1]], [b[0], runY, b[1]], ' (air run — no wall path)')
  }

  const panelPlan: Pt = [panel.position[0], panel.position[2]]
  // The homerun drop spans drill height up to the panel — its anchor must
  // clear any RO in that whole vertical band.
  const panelAnchor = nearestWallPoint(walls, panelPlan, panel.position[1] + inches(15))
  let circuitIndex = 0
  for (const [circuit, devices] of byCircuit) {
    const gauge = Number(devices[0]?.meta?.gaugeAwg ?? 14)
    // Cables staple side by side, not inside each other: each circuit's
    // drill-height plane steps 12mm so the homerun spine reads as parallel
    // colored runs instead of 108 coincident segments (quality round-2).
    const runY = WIRE_RUN_Y + (circuitIndex++ % 8) * 0.012
    // homerun drop from the panel to drill height at its wall anchor
    const start = panelAnchor ?? null
    if (start) {
      const sp = wallPlan(start)
      // Round-12 B1/M8: the cable ENTERS the panel enclosure — bridge from
      // the panel's face-mounted position to the centerline anchor before
      // dropping to drill height. Without it every homerun floated
      // thickness/2 + FACE_OFFSET away from the panel.
      emitWire(
        circuit,
        gauge,
        [panel.position[0], panel.position[1], panel.position[2]],
        [sp[0], panel.position[1], sp[1]],
      )
      emitWire(circuit, gauge, [sp[0], panel.position[1], sp[1]], [sp[0], runY, sp[1]])
    }
    const remaining = [...devices]
    let cursor: WallPoint | null = start
    let cursorPlan: Pt = start ? wallPlan(start) : panelPlan
    while (remaining.length > 0) {
      let best = 0
      let bestDist = Number.POSITIVE_INFINITY
      for (let i = 0; i < remaining.length; i++) {
        const d = remaining[i] as Fixture
        const dist =
          Math.abs(d.position[0] - cursorPlan[0]) + Math.abs(d.position[2] - cursorPlan[1])
        if (dist < bestDist) {
          bestDist = dist
          best = i
        }
      }
      const device = remaining.splice(best, 1)[0] as Fixture
      const [x, y, z] = device.position
      const ceilingDevice = device.kind === 'light' || device.kind === 'smoke-alarm'
      // Ceiling devices rise the full wall height inside a stud bay; wall
      // devices rise to their box — either way the bay must be RO-free for
      // the whole vertical leg (prod report: risers through windows).
      const anchor = nearestWallPoint(
        walls,
        [x, z],
        ceilingDevice ? Number.POSITIVE_INFINITY : Math.max(RUN_ZONE_TOP, y + inches(6)),
      )
      if (anchor && cursor) {
        routeHop(circuit, gauge, cursor, anchor, runY)
        const ap = wallPlan(anchor)
        if (ceilingDevice) {
          // rise inside the wall, then cross the ceiling through joist bays
          emitWire(circuit, gauge, [ap[0], runY, ap[1]], [ap[0], y, ap[1]])
          emitWire(circuit, gauge, [ap[0], y, ap[1]], [x, y, ap[1]])
          emitWire(circuit, gauge, [x, y, ap[1]], [x, y, z])
        } else {
          // drop/rise at the device's stud bay…
          emitWire(circuit, gauge, [ap[0], runY, ap[1]], [ap[0], y, ap[1]])
          // …then the box stub: centerline → the face-mounted box (round-12
          // M8 — no wire ever reached a box; the ~2.7in jog was implied).
          emitWire(circuit, gauge, [ap[0], y, ap[1]], [x, y, z])
        }
        cursor = anchor
        cursorPlan = ap
      } else {
        // No walls at all — degenerate scene: straight legs to the device.
        emitWire(circuit, gauge, [cursorPlan[0], runY, cursorPlan[1]], [x, runY, cursorPlan[1]], ' (air run — no wall path)')
        emitWire(circuit, gauge, [x, runY, cursorPlan[1]], [x, runY, z], ' (air run — no wall path)')
        emitWire(circuit, gauge, [x, WIRE_RUN_Y, z], [x, y, z])
        cursorPlan = [x, z]
      }
    }
  }
  return members
}
