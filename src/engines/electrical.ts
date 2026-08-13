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
import type { Fixture, RoomSlice, WallSlice } from '../core/types'
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
  for (const opening of wall.openings) {
    if (opening.kind !== 'door') continue
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

  // ---- service panel ----
  const panel = placePanel(walls, rooms)
  if (panel) fixtures.push(panel)

  return fixtures
}

/**
 * Service panel: garages are the customary spot (surface-mount, unfinished
 * wall) — pick the longest wall bounding a garage; otherwise the longest
 * exterior wall. Mounted at the wall-face midpoint, center 60" AFF.
 * // LOD 400: enforce NEC 110.26 working clearance (30" wide x 36" deep) and
 * // 240.24(D)/(E) (not in bathrooms / over steps) against the room geometry.
 */
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

  const [x, z] = face.plan(wall.length / 2)
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

// LOD 400: kitchen countertop run per 210.52(C) (24"/48" rule, island future-
// provision box per NEC 2023), bathroom basin receptacle per 210.52(D),
// outdoor front/back receptacles per 210.52(E), and AFCI/circuit grouping
// (210.12 / 210.11(C)) for the takeoff — all need counter/basin/site data.
