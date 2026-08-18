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
import type {
  DeviceOverrides,
  Fixture,
  Member,
  RoomSlice,
  ServiceOverrides,
  ServicePointOverride,
  WallSlice,
} from '../core/types'
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
/** Meter socket center ~55" AFF — utilities want the dial 4–6 ft above grade. */
const METER_AFF = inches(55)
/** Meter socket sits beside the panel's wall bay (enclosure half-width + working space). */
const METER_PANEL_OFFSET = 0.6

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
 *  - one service panel (a `bones:service` panel override, when present, is
 *    the authoritative spot — homeruns re-anchor there; checklist A4)
 */
export function layoutElectrical(
  walls: WallSlice[],
  rooms: RoomSlice[],
  overrides?: ServiceOverrides,
): Fixture[] {
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
    // Every wall-mounted device carries a DETERMINISTIC `meta.deviceId`
    // (movable outlets, Q7): the ordinal walks this wall's u-positions in
    // derivation order, so an unchanged scene reproduces identical ids and
    // editing ANOTHER wall never shuffles this wall's. The id keys the
    // `bones:device` override nodes (device/schema.ts).
    let ordinal = 0
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
            meta: { deviceId: `recep:${wall.id}:${ordinal}:${face.side === 1 ? 'p' : 'm'}` },
          })
        }
        ordinal += 1
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
          // Keyed by the OPENING (not an ordinal): a door switch belongs to
          // its door — adding a second door never renumbers this one.
          meta: { deviceId: `switch:${wall.id}:${opening.id}:${face.side === 1 ? 'p' : 'm'}` },
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
    let best: { wall: WallSlice; face: WallFace; u: number; d: number } | null = null
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
        if (!best || d < best.d) best = { wall, face, u, d }
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
        // One control per door-less hallway — the ROOM is the stable key.
        meta: { deviceId: `switch:${best.wall.id}:hall:${room.id}` },
      })
    }
  }

  // ---- service panel ----
  const panel = placePanel(walls, rooms, overrides?.panel)
  if (panel) fixtures.push(panel)

  // ---- electric meter: street → METER → panel is the standard chain ----
  const meter = placeElectricMeter(walls, rooms, overrides?.electricMeter)
  if (meter) fixtures.push(meter)

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

/** The garage bounding a wall — boundary list or face-midpoint containment. */
function garageBounding(wall: WallSlice, rooms: RoomSlice[]): RoomSlice | undefined {
  const garages = rooms.filter((r) => r.category === 'garage')
  return garages.find(
    (g) =>
      g.boundaryWallIds.includes(wall.id) ||
      pointInPolygon(faceOf(wall, 1).plan(wall.length / 2), g.polygon) ||
      pointInPolygon(faceOf(wall, -1).plan(wall.length / 2), g.polygon),
  )
}

/**
 * AUTO spot for the service panel — the longest garage wall, else the
 * longest exterior wall, else the longest wall, mounted at `panelMountU`.
 * Exported so the Bones panel's "Place service points" action can seed a
 * `bones:service` node exactly where the engine would auto-place.
 */
export function placePanelSpot(
  walls: WallSlice[],
  rooms: RoomSlice[],
): { wall: WallSlice; u: number; heightAff: number } | null {
  const straight = walls.filter((w) => !w.curved && w.length > 0)
  if (straight.length === 0) return null

  const longest = (candidates: WallSlice[]): WallSlice | undefined =>
    candidates.reduce<WallSlice | undefined>(
      (best, w) => (best === undefined || w.length > best.length ? w : best),
      undefined,
    )

  const garageWall = longest(straight.filter((w) => garageBounding(w, rooms) !== undefined))
  const wall = garageWall ?? longest(straight.filter((w) => w.exterior)) ?? longest(straight)
  if (!wall) return null
  // Round-12 B1: a door spanning the wall midpoint used to swallow the
  // panel — every homerun then started from inside the RO and never
  // reached its anchor. Mount in the widest door-free segment instead.
  return { wall, u: panelMountU(wall), heightAff: PANEL_AFF }
}

/**
 * A gizmo-written override position: every component finite AND off the
 * schema default [0,0,0] (within 1e-6). The default means "never moved";
 * NaN/Infinity components make the position unusable (never trust it).
 */
function movedOverridePosition(
  o: ServicePointOverride,
): readonly [number, number, number] | null {
  const p = o.position
  if (!p || p.length < 3) return null
  if (!p.every((v) => Number.isFinite(v))) return null
  return p.some((v) => Math.abs(v) > 1e-6) ? p : null
}

/** The override's usable wall: straight, non-degenerate, in this level's
 * walls list (missing/curved/foreign ids resolve to nothing). */
function overrideWall(walls: WallSlice[], o: ServicePointOverride): WallSlice | undefined {
  return o.wallId
    ? walls.find((w) => w.id === o.wallId && !w.curved && w.length >= 0.1)
    : undefined
}

const overrideT = (o: ServicePointOverride): number =>
  Math.max(0, Math.min(1, typeof o.wallT === 'number' && Number.isFinite(o.wallT) ? o.wallT : 0.5))

/**
 * Resolve a `bones:service` override to the engine's WallPoint form.
 * Precedence: a NON-default `position` (a manual inspector/MCP write —
 * editor drags of wall types commit `wallT` and reset position to the
 * default, see service/frame.ts) OUTRANKS the wall anchor and maps to the
 * nearest wall point; the default [0,0,0] means the wall anchor rules →
 * `wallId`+`wallT` verbatim (0..1 → u along the wall). An unresolvable wall
 * with a default position is NOT an override. Null = no override →
 * auto-place.
 */
export function overrideWallPoint(
  walls: WallSlice[],
  o: ServicePointOverride | undefined,
): WallPoint | null {
  if (!o) return null
  const moved = movedOverridePosition(o)
  if (moved) return nearestWallPoint(walls, [moved[0], moved[2]], Number.POSITIVE_INFINITY)
  const wall = overrideWall(walls, o)
  if (wall) return { wall, u: overrideT(o) * wall.length }
  return null
}

/**
 * Resolve a `bones:service` override to a PLAN point, with the same
 * precedence as `overrideWallPoint`: a moved `position` wins (verbatim —
 * floor consumers like the sewer exit take it as-is), else the wall lerp,
 * else null (no override → auto-place).
 */
export function overridePlanPoint(
  walls: WallSlice[],
  o: ServicePointOverride | undefined,
): readonly [number, number] | null {
  if (!o) return null
  const moved = movedOverridePosition(o)
  if (moved) return [moved[0], moved[2]]
  const wall = overrideWall(walls, o)
  if (wall) {
    const t = overrideT(o)
    return [
      wall.start[0] + wall.dir[0] * wall.length * t,
      wall.start[1] + wall.dir[1] * wall.length * t,
    ]
  }
  return null
}

function placePanel(
  walls: WallSlice[],
  rooms: RoomSlice[],
  override?: ServicePointOverride,
): Fixture | null {
  // A service node is the authoritative spot; auto-placement only when absent.
  const forced = overrideWallPoint(walls, override)
  const spot = forced
    ? { wall: forced.wall, u: forced.u, heightAff: override?.heightAff ?? PANEL_AFF }
    : placePanelSpot(walls, rooms)
  if (!spot) return null
  const { wall, u: mountU } = spot

  // Face into the garage when we have one, else the resolved interior face.
  let face = interiorFaces(wall, rooms)[0] ?? faceOf(wall, 1)
  const garage = garageBounding(wall, rooms)
  if (garage) {
    for (const side of [1, -1] as const) {
      const f = faceOf(wall, side)
      if (pointInPolygon(f.plan(wall.length / 2), garage.polygon)) face = f
    }
  }

  const [x, z] = face.plan(mountU)
  return {
    system: 'electrical',
    kind: 'panel',
    position: [x, spot.heightAff, z],
    rotationY: face.rotationY,
    sourceId: wall.id,
    label: `Service panel (${rules.circuits.minServiceAmps}A min per NEC 230.79(C))`,
    meta: { minServiceAmps: rules.circuits.minServiceAmps },
  }
}

/**
 * AUTO spot for the electric meter: the EXTERIOR face nearest the panel —
 * on the panel's own wall at `panelMountU ± 0.6 m` when that wall is
 * exterior, else the nearest exterior wall point to the panel mount (a
 * garage-divider panel still meters on the shell). RO-clear across the
 * socket height. Exported so the Bones panel's "Place service points"
 * action seeds a `bones:service` electric-meter node exactly where the
 * engine auto-places.
 */
export function placeElectricMeterSpot(
  walls: WallSlice[],
  rooms: RoomSlice[],
): { wall: WallSlice; u: number; heightAff: number } | null {
  const panelSpot = placePanelSpot(walls, rooms)
  if (!panelSpot) return null
  let wall = panelSpot.wall
  let u = panelSpot.u
  if (wall.exterior) {
    // Beside the panel bay, not on top of it — the service conductors stay
    // short and the panel's working space stays clear.
    u =
      u + METER_PANEL_OFFSET <= wall.length - 0.2
        ? u + METER_PANEL_OFFSET
        : Math.max(0.2, u - METER_PANEL_OFFSET)
  } else {
    const exterior = walls.filter((w) => w.exterior && !w.curved && w.length >= 0.1)
    if (exterior.length === 0) return null
    const p = wallPlan({ wall, u })
    const near = nearestWallPoint(exterior, p, Number.POSITIVE_INFINITY)
    if (!near) return null
    wall = near.wall
    u = near.u
  }
  u = clearOfOpenings(wall, u, METER_AFF - 0.25, METER_AFF + 0.25)
  return { wall, u, heightAff: METER_AFF }
}

/** The meter fixture on the EXTERIOR face of its wall — the override
 * (`bones:service` electric-meter node) is authoritative, auto otherwise. */
function placeElectricMeter(
  walls: WallSlice[],
  rooms: RoomSlice[],
  override?: ServicePointOverride,
): Fixture | null {
  const forced = overrideWallPoint(walls, override)
  const spot = forced
    ? { wall: forced.wall, u: forced.u, heightAff: override?.heightAff ?? METER_AFF }
    : placeElectricMeterSpot(walls, rooms)
  if (!spot) return null
  // Exterior face = the opposite of the resolved interior face; when no
  // room data resolves a side, +normal is the interior guess → use −.
  const inFace = interiorFaces(spot.wall, rooms)[0] ?? faceOf(spot.wall, 1)
  const face = faceOf(spot.wall, inFace.side === 1 ? -1 : 1)
  const [x, z] = face.plan(spot.u)
  return {
    system: 'electrical',
    kind: 'electric-meter',
    position: [x, spot.heightAff, z],
    rotationY: face.rotationY,
    sourceId: spot.wall.id,
    label: 'Electric meter — service entrance (NEC 230.66)',
  }
}

// ---------------------------------------------------------------------------
// Movable devices (Q7): `bones:device` overrides with code-aware snapping
// ---------------------------------------------------------------------------

/** Single-gang device box ≈ 3" wide × 4.5" tall — the footprint the RO and
 * stud snapping work with (matches the renderer's fixtureBox dims). */
export const DEVICE_BOX_W = inches(3)
const DEVICE_BOX_HALF_H = inches(2.25)
/** Legal mounting bands (device CENTER, m AFF). Receptacles: 15" convention /
 * ADA reach floor up to 1.7 m; switches: 0.9 m up to NEC 404.8(A)'s 6'7"
 * grip-center maximum (2.0 m). A dragged height clamps into its band. */
export const RECEPTACLE_HEIGHT_BAND: readonly [number, number] = [0.15, 1.7]
export const SWITCH_HEIGHT_BAND: readonly [number, number] = [0.9, 2.0]

/** Wall-framing verticals a device box can mount beside. */
const MOUNTABLE_VERTICALS: ReadonlySet<Member['role']> = new Set([
  'stud',
  'king-stud',
  'trimmer',
  'cripple',
])
/** Horizontal in-wall rows that already give a mid-bay box wood to mount to —
 * an off-stud box over one of these books NO extra device blocking. */
const MOUNT_ROWS: ReadonlySet<Member['role']> = new Set(['blocking', 'backing', 'fire-blocking'])

/**
 * The wall a device fixture mounts on: receptacles carry their wall id in
 * `sourceId`; door switches carry the OPENING id (resolve the wall holding
 * it); hallway switches carry the ROOM id (nearest wall axis). Exported for
 * the `bones:device` reconciler (device/derive.ts) — node seeding and the
 * engine must agree on every device's wall.
 */
export function deviceWallOf(fixture: Fixture, walls: WallSlice[]): WallSlice | null {
  const own = walls.find((w) => w.id === fixture.sourceId)
  if (own) return own
  const byOpening = walls.find((w) => w.openings.some((o) => o.id === fixture.sourceId))
  if (byOpening) return byOpening
  let best: WallSlice | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const wall of walls) {
    if (wall.curved || wall.length < 0.1) continue
    const u = wallU(wall, fixture.position)
    const q = wallPlan({ wall, u })
    const d = Math.hypot(q[0] - fixture.position[0], q[1] - fixture.position[2])
    if (d < bestDist) {
      bestDist = d
      best = wall
    }
  }
  return best
}

/** Clamped along-wall coordinate of a level-space position. */
function wallU(wall: WallSlice, p: readonly [number, number, number]): number {
  const raw = (p[0] - wall.start[0]) * wall.dir[0] + (p[2] - wall.start[1]) * wall.dir[1]
  return Math.max(0, Math.min(wall.length, raw))
}

/** Signed cross-wall offset of a position (+ = the wall's +normal face). */
function wallSideOffset(wall: WallSlice, p: readonly [number, number, number]): number {
  return -(p[0] - wall.start[0]) * wall.dir[1] + (p[2] - wall.start[1]) * wall.dir[0]
}

/** Snap `u` so the whole BOX (± width/2, + 1" trim breath) clears every rough
 * opening crossing [y0, y1] — like `clearOfOpenings`, but edge-aware: a box
 * whose CENTER sits just outside the RO still overlaps it. Iterates because
 * the snapped spot can graze a neighboring span. */
function snapBoxClearOfRo(wall: WallSlice, u: number, y0: number, y1: number): number {
  const margin = DEVICE_BOX_W / 2 + inches(1)
  let out = u
  for (let pass = 0; pass < 4; pass++) {
    const spans = openingSpans(wall, y0, y1)
    const hit = spans.find((s) => out > s.lo - margin && out < s.hi + margin)
    if (!hit) return out
    const lo = Math.max(margin, hit.lo - margin)
    const hi = Math.min(wall.length - margin, hit.hi + margin)
    out = out - hit.lo < hit.hi - out ? lo : hi
  }
  return out
}

type WallVertical = {
  u: number
  halfT: number
  w: number
  size?: Member['size']
  y0: number
  y1: number
}
type WallRow = { u0: number; u1: number; y0: number; y1: number }

/** Index the wall-framing members a box interacts with, per wall id. */
function indexWallFraming(
  members: Member[],
  walls: WallSlice[],
): { verticals: Map<string, WallVertical[]>; rows: Map<string, WallRow[]> } {
  const byId = new Map(walls.map((w) => [w.id, w]))
  const verticals = new Map<string, WallVertical[]>()
  const rows = new Map<string, WallRow[]>()
  for (const m of members) {
    if (m.system !== 'wall-framing') continue
    const wall = byId.get(m.sourceId)
    if (!wall) continue
    const u = wallU(wall, m.position)
    if (MOUNTABLE_VERTICALS.has(m.role)) {
      const list = verticals.get(wall.id) ?? []
      list.push({
        u,
        halfT: m.dims[0] / 2,
        w: m.dims[2],
        size: m.size,
        y0: m.position[1] - m.dims[1] / 2,
        y1: m.position[1] + m.dims[1] / 2,
      })
      verticals.set(wall.id, list)
    } else if (MOUNT_ROWS.has(m.role)) {
      const list = rows.get(wall.id) ?? []
      list.push({
        u0: u - m.dims[0] / 2,
        u1: u + m.dims[0] / 2,
        y0: m.position[1] - m.dims[1] / 2,
        y1: m.position[1] + m.dims[1] / 2,
      })
      rows.set(wall.id, list)
    }
  }
  for (const list of verticals.values()) list.sort((a, b) => a.u - b.u)
  return { verticals, rows }
}

/** The wall's o.c. rhythm read back from its actual verticals (median clear
 * gap — trimmer packs and doubled studs filtered). 16" when unreadable. */
function bayRhythm(verts: WallVertical[]): number {
  const gaps: number[] = []
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i] as WallVertical
    const b = verts[i + 1] as WallVertical
    const gap = b.u - a.u
    if (gap > 0.09) gaps.push(gap)
  }
  if (gaps.length === 0) return inches(16)
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] ?? inches(16)
}

export type AppliedDeviceOverrides = {
  fixtures: Fixture[]
  /** Extra wall-framing members the moves needed (device blocking). */
  members: Member[]
  warnings: string[]
}

/**
 * Apply `bones:device` overrides to the derived device fixtures — the
 * movable-outlets contract (Q7): the override WINS over the derived spot
 * (position-wins precedence like `overrideWallPoint`), but never lands
 * somewhere unbuildable. In order:
 *  (a) RO rule: the box never sits inside a door/window rough opening —
 *      snapped out with a warning (serviceOverrideRoWarning parity);
 *  (b) STUD rule: boxes mount BESIDE a stud — wallT snaps so the box edge
 *      lands against the nearest vertical's face (studs/kings/trimmers/
 *      cripples covering the box's height band); when the nearest usable
 *      face is farther than half a bay, the position is KEPT and a
 *      horizontal 2x 'device blocking' member spans the bay at box height
 *      (skipped when an existing blocking/backing/fire row already crosses
 *      there — the box mounts to that instead);
 *  (c) HEIGHT clamp: receptacles [0.15, 1.7] m, switches [0.9, 2.0] m
 *      (NEC 404.8(A)) — clamped with a note.
 * After the moves, NEC 210.52(A) receptacle spacing is re-checked on every
 * wall a moved receptacle left or joined — the derived layout is
 * spacing-correct by construction, so untouched walls never warn.
 * With no overrides the input `fixtures` array is returned UNCHANGED
 * (reference-equal — the byte-equality guarantee).
 */
export function applyDeviceOverrides(
  fixtures: Fixture[],
  walls: WallSlice[],
  rooms: RoomSlice[],
  framingMembers: Member[],
  overrides: DeviceOverrides | undefined,
): AppliedDeviceOverrides {
  if (!overrides || overrides.size === 0) return { fixtures, members: [], warnings: [] }

  const out = [...fixtures]
  const members: Member[] = []
  const warnings: string[] = []
  const { verticals, rows } = indexWallFraming(framingMembers, walls)
  const spacingWalls = new Set<string>()

  // Deterministic application order (Map insertion order is the caller's):
  // sort by deviceId so duplicate work (shared blocking rows) is stable.
  const entries = [...overrides.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [deviceId, override] of entries) {
    const idx = out.findIndex((f) => f.meta?.deviceId === deviceId)
    if (idx < 0) continue // orphan override — the id no longer derives
    const fixture = out[idx] as Fixture
    const isSwitch = fixture.kind === 'switch'
    const derivedWall = deviceWallOf(fixture, walls)

    // ---- resolve the target wall + raw u (position-wins precedence) ----
    let wall: WallSlice | null = null
    let u = 0
    const moved = movedOverridePosition(override)
    if (moved) {
      const wp = nearestWallPoint(walls, [moved[0], moved[2]])
      if (wp) {
        wall = wp.wall
        u = wp.u
      }
    } else {
      wall = overrideWall(walls, override) ?? derivedWall
      if (wall) {
        const t =
          typeof override.wallT === 'number' && Number.isFinite(override.wallT)
            ? Math.max(0, Math.min(1, override.wallT))
            : wallU(wall, fixture.position) / Math.max(wall.length, 1e-9)
        u = t * wall.length
      }
    }
    if (!wall) continue // nothing usable to mount on — keep the derived spot

    // ---- (c) height clamp — applied first so the RO band is the real one ----
    const band = isSwitch ? SWITCH_HEIGHT_BAND : RECEPTACLE_HEIGHT_BAND
    const rawH =
      typeof override.heightAff === 'number' && Number.isFinite(override.heightAff)
        ? override.heightAff
        : fixture.position[1]
    const h = Math.max(band[0], Math.min(band[1], rawH))
    if (Math.abs(h - rawH) > 1e-9) {
      warnings.push(
        `device “${deviceId}”: mount height clamped to ${h.toFixed(2)} m — ` +
          (isSwitch
            ? `switches live in [${band[0]}, ${band[1]}] m (NEC 404.8(A) 6'7" max)`
            : `receptacles live in [${band[0]}, ${band[1]}] m`),
      )
    }
    const y0 = h - DEVICE_BOX_HALF_H
    const y1 = h + DEVICE_BOX_HALF_H

    // ---- (a) never inside a rough opening — snap out + warn ----
    const roSnapped = snapBoxClearOfRo(wall, u, y0, y1)
    if (Math.abs(roSnapped - u) > 1e-9) {
      warnings.push(
        `device “${deviceId}” sits in a door/window rough opening — snapped clear`,
      )
      u = roSnapped
    }

    // ---- (b) stud rule: the box edge mounts against a stud face ----
    const spans = openingSpans(wall, y0, y1)
    const boxHalf = DEVICE_BOX_W / 2
    const verts = (verticals.get(wall.id) ?? []).filter(
      (v) => v.y0 <= y0 + 0.02 && v.y1 >= y1 - 0.02,
    )
    if (verts.length > 0) {
      let bestC: number | null = null
      for (const v of verts) {
        for (const side of [-1, 1] as const) {
          const c = v.u + side * (v.halfT + boxHalf)
          if (c < boxHalf + 0.01 || c > wall.length - boxHalf - 0.01) continue
          // the box must clear every RO span and every other vertical
          if (spans.some((s) => c + boxHalf > s.lo && c - boxHalf < s.hi)) continue
          if (
            verts.some(
              (o) => c + boxHalf > o.u - o.halfT + 1e-6 && c - boxHalf < o.u + o.halfT - 1e-6,
            )
          ) {
            continue
          }
          if (bestC === null || Math.abs(c - u) < Math.abs(bestC - u)) bestC = c
        }
      }
      // Half a bay of the wall's o.c. rhythm — capped at a 24" bay so a
      // degenerate sparse rhythm still books blocking instead of teleporting
      // the box across a meters-wide gap.
      const halfBay = Math.min(bayRhythm(verts), inches(24)) / 2 + 1e-6
      if (bestC !== null && Math.abs(bestC - u) <= halfBay) {
        u = bestC
      } else {
        // Off-stud: keep the user's spot and make the mount PHYSICAL — a
        // flat 2x block between the bay's studs at box height (unless an
        // existing row already crosses the box there).
        const left = [...verts].reverse().find((v) => v.u < u)
        const right = verts.find((v) => v.u > u)
        const rowList = rows.get(wall.id) ?? []
        const covered = rowList.some(
          (r) => u > r.u0 - 1e-6 && u < r.u1 + 1e-6 && r.y0 < y1 && r.y1 > y0,
        )
        if (left && right && !covered) {
          const blockLen = right.u - right.halfT - (left.u + left.halfT)
          if (blockLen >= inches(3)) {
            const mid = (left.u + left.halfT + (right.u - right.halfT)) / 2
            const p = wallPlan({ wall, u: mid })
            const t = left.halfT * 2
            const block: Member = {
              system: 'wall-framing',
              role: 'blocking',
              size: left.size,
              dims: [blockLen, t, left.w],
              length: blockLen,
              position: [p[0], h, p[1]],
              rotation: [0, Math.atan2(-wall.dir[1], wall.dir[0]), 0],
              material: 'lumber',
              sourceId: wall.id,
              label: 'device blocking — box off-stud',
            }
            members.push(block)
            // later devices in the same bay mount to THIS block
            rowList.push({ u0: left.u + left.halfT, u1: right.u - right.halfT, y0: h - t / 2, y1: h + t / 2 })
            rows.set(wall.id, rowList)
          }
        }
      }
    }

    // ---- re-mount the fixture on its (possibly new) wall face ----
    let side: 1 | -1
    if (derivedWall && wall.id === derivedWall.id) {
      side = wallSideOffset(wall, fixture.position) >= 0 ? 1 : -1
    } else {
      side = (interiorFaces(wall, rooms)[0] ?? faceOf(wall, 1)).side
    }
    const face = faceOf(wall, side)
    const [x, z] = face.plan(u)
    // Receptacles key their wall in sourceId — a cross-wall move re-keys it
    // so the device manifest (deviceWallOf) mounts the node where the box
    // stands. Switches keep their OPENING/room key: a moved switch still
    // controls the same light.
    const sourceId = !isSwitch && derivedWall && wall.id !== derivedWall.id ? wall.id : fixture.sourceId
    out[idx] = { ...fixture, position: [x, h, z], rotationY: face.rotationY, sourceId }

    if (!isSwitch) {
      if (derivedWall) spacingWalls.add(derivedWall.id)
      spacingWalls.add(wall.id)
    }
  }

  // ---- NEC 210.52(A) spacing advisory on the walls the moves touched ----
  for (const wallId of [...spacingWalls].sort()) {
    const wall = walls.find((w) => w.id === wallId)
    if (!wall || wall.curved || wall.length < 0.1) continue
    let violated = false
    for (const side of [1, -1] as const) {
      // receptacle u-positions on this wall FACE (moved arrivals included)
      const us = out
        .filter((f) => f.kind === 'receptacle' || f.kind === 'receptacle-gfci')
        .filter((f) => {
          const off = wallSideOffset(wall, f.position)
          if (Math.sign(off) !== side) return false
          if (Math.abs(off) > wall.thickness / 2 + FACE_OFFSET + 0.05) return false
          const raw =
            (f.position[0] - wall.start[0]) * wall.dir[0] +
            (f.position[2] - wall.start[1]) * wall.dir[1]
          return raw > -0.05 && raw < wall.length + 0.05
        })
        .map((f) => wallU(wall, f.position))
        .sort((a, b) => a - b)
      // Only faces that had receptacles derive receptacles — an exterior
      // wall's outside face never counts.
      if (us.length === 0 && wall.exterior) continue
      for (const seg of usableSegments(wall)) {
        const inSeg = us.filter((v) => v >= seg.a - 1e-6 && v <= seg.b + 1e-6)
        let maxDist: number
        if (inSeg.length === 0) {
          maxDist = seg.b - seg.a // a usable space with NO receptacle left
        } else {
          maxDist = Math.max(
            (inSeg[0] as number) - seg.a,
            seg.b - (inSeg[inSeg.length - 1] as number),
          )
          for (let i = 0; i + 1 < inSeg.length; i++) {
            maxDist = Math.max(maxDist, ((inSeg[i + 1] as number) - (inSeg[i] as number)) / 2)
          }
        }
        if (maxDist > MAX_FROM_BREAK + 1e-9) violated = true
      }
    }
    if (violated) {
      warnings.push(
        `wall ${wall.id}: receptacle spacing exceeds NEC 210.52 (moved outlet leaves a >12ft gap)`,
      )
    }
  }

  return { fixtures: out, members, warnings }
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

export type WallPoint = { wall: WallSlice; u: number }
/** One junction on a wall: at `u`, you can hop onto `to.wall` at `to.u`. */
type Junction = { u: number; to: WallPoint }

/** Plan point of a wall-centerline coordinate. */
export const wallPlan = (p: WallPoint): Pt => [
  p.wall.start[0] + p.wall.dir[0] * p.u,
  p.wall.start[1] + p.wall.dir[1] * p.u,
]

/** Vertical zone the drill-height planes occupy (8 circuit steps + sheath). */
const RUN_ZONE_TOP = WIRE_RUN_Y + 8 * 0.012 + inches(2)

/** Snap a wall coordinate out of any rough opening crossing [y0, y1] —
 * cable can't drop through a doorway OR a window; it lands in the first
 * stud bay past the king studs. */
export function clearOfOpenings(wall: WallSlice, u: number, y0 = 0, y1 = RUN_ZONE_TOP): number {
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
export function nearestWallPoint(walls: WallSlice[], p: Pt, yTop = RUN_ZONE_TOP): WallPoint | null {
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
export function wallPath(
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

/** Emits one straight cable segment; `note` lands in the member label. */
type SegmentEmitter = (
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  note?: string,
) => void

/**
 * One drill-height leg along a wall — DETOURING around ANY rough opening
 * whose vertical RO crosses the drill plane (doors always; windows when
 * the sill drops below drill height — prod report: wires bored straight
 * through low windows). Route: rise inside the king-stud bay, cross above
 * the header, drop back — or duck UNDER the sill when there's no wall
 * above (full-height glazing with a stub sill). Shared by the branch
 * circuits AND the service feed (E1 applies to every cable).
 */
function emitWallLegWith(
  emit: SegmentEmitter,
  wall: WallSlice,
  u0: number,
  u1: number,
  runY: number,
): void {
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
      emit(at(cursor, runY), at(far, runY), ' (⚠ crosses full-height opening — verify)')
      cursor = far
      continue
    }
    emit(at(cursor, runY), at(near, runY))
    emit(at(near, runY), at(near, detourY))
    emit(at(near, detourY), at(far, detourY))
    emit(at(far, detourY), at(far, runY))
    cursor = far
  }
  emit(at(cursor, runY), at(u1, runY))
}

/**
 * Wall-following legs between two anchors at `runY`, bridging junction gaps
 * — false when the walls are disconnected (caller picks its fallback).
 * Round-12 B2/M1: junctions accepted within JUNCTION_TOL (or snapped out of
 * a door RO) leave the two walls' legs ending at DIFFERENT plan points;
 * every inter-leg gap is bridged explicitly — a run is continuous cable,
 * not adjacent segments.
 */
function emitWallPathWith(
  emit: SegmentEmitter,
  graph: Map<string, Junction[]>,
  from: WallPoint,
  to: WallPoint,
  runY: number,
): boolean {
  const legs = wallPath(graph, from, to)
  if (!legs) return false
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i] as { wall: WallSlice; u0: number; u1: number }
    emitWallLegWith(emit, leg.wall, leg.u0, leg.u1, runY)
    const next = legs[i + 1]
    if (next) {
      const a = wallPlan({ wall: leg.wall, u: leg.u1 })
      const b = wallPlan({ wall: next.wall, u: next.u0 })
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.02) {
        emit([a[0], runY, a[1]], [b[0], runY, b[1]], ' (junction jumper)')
      }
    }
  }
  return true
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

  /** Wall-following legs between two anchors at drill height (shared
   * emitWallPathWith — RO detours + junction jumpers). */
  const routeHop = (
    circuit: string,
    gauge: number,
    from: WallPoint,
    to: WallPoint,
    runY: number = WIRE_RUN_Y,
  ): void => {
    const emit: SegmentEmitter = (a, b, note = '') => emitWire(circuit, gauge, a, b, note)
    if (emitWallPathWith(emit, graph, from, to, runY)) return
    // Disconnected wall islands: a bed-height run through open room air is
    // a physically impossible cable path (checklist E4) — a real pull
    // crosses through the CEILING/joist space: rise up the source wall
    // through its plates, two Manhattan legs above both walls' top plates,
    // drop back down the target wall to drill height.
    const a = wallPlan(from)
    const b = wallPlan(to)
    const yCross = Math.max(from.wall.height, to.wall.height) + 0.05
    const note = ' (ceiling crossing — no wall path)'
    const seg = (p: readonly [number, number, number], q: readonly [number, number, number]) => {
      if (Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 0.01) return
      emitWire(circuit, gauge, p, q, note)
    }
    seg([a[0], runY, a[1]], [a[0], yCross, a[1]])
    seg([a[0], yCross, a[1]], [b[0], yCross, a[1]])
    seg([b[0], yCross, a[1]], [b[0], yCross, b[1]])
    seg([b[0], yCross, b[1]], [b[0], runY, b[1]])
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
        // No walls at all — degenerate scene: still no bed-height air runs
        // (E4): cross at a nominal ceiling height, drop at the device.
        const yC = 2.4
        const note = ' (ceiling crossing — no walls)'
        emitWire(circuit, gauge, [cursorPlan[0], runY, cursorPlan[1]], [cursorPlan[0], yC, cursorPlan[1]], note)
        emitWire(circuit, gauge, [cursorPlan[0], yC, cursorPlan[1]], [x, yC, cursorPlan[1]], note)
        emitWire(circuit, gauge, [x, yC, cursorPlan[1]], [x, yC, z], note)
        emitWire(circuit, gauge, [x, yC, z], [x, y, z])
        cursorPlan = [x, z]
      }
    }
  }

  // ---- service entrance: street lateral → METER → panel feed ----
  members.push(...routeServiceCable(fixtures, walls, graph))

  return members
}

/** Underground service lateral depth (NEC 300.5 direct-buried ≈ 18–24"). */
const SERVICE_LATERAL_Y = -0.45
/** SE cable drawn heavy (2 AWG Cu look) so the service chain reads at house scale. */
const SERVICE_SECTION = 0.035
/** Map-edge proxy: the street corridor runs this far outside the walls' bbox. */
const STREET_EDGE_MARGIN = 4
/** The meter→panel feed's service plane along the walls — one step above
 * the branch circuits' 8 stapled drill planes, inside the RO-cleared zone. */
const SERVICE_FEED_Y = WIRE_RUN_Y + 9 * 0.012

/**
 * True when the straight segment a→b passes through any rough opening's
 * wall-body volume (sampled every 5 cm — the E1 harness geometry). Used to
 * ⚠-flag the service legs that cannot detour (laterals, socket/enclosure
 * bridges) instead of crossing silently.
 */
export function segmentCrossesRo(
  walls: WallSlice[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): boolean {
  type Box = { min: [number, number, number]; max: [number, number, number] }
  const boxes: Box[] = []
  for (const w of walls) {
    if (w.curved) continue
    const latX = Math.abs(-w.dir[1]) * (w.thickness / 2 + 0.01)
    const latZ = Math.abs(w.dir[0]) * (w.thickness / 2 + 0.01)
    for (const o of w.openings) {
      const lo = Math.max(0, o.u - o.roughWidth / 2)
      const hi = Math.min(w.length, o.u + o.roughWidth / 2)
      if (hi <= lo) continue
      const p = wallPlan({ wall: w, u: lo })
      const q = wallPlan({ wall: w, u: hi })
      boxes.push({
        min: [Math.min(p[0], q[0]) - latX, o.sillHeight, Math.min(p[1], q[1]) - latZ],
        max: [
          Math.max(p[0], q[0]) + latX,
          o.sillHeight + o.roughHeight,
          Math.max(p[1], q[1]) + latZ,
        ],
      })
    }
  }
  if (boxes.length === 0) return false
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.05))
  for (let i = 0; i <= steps; i++) {
    const px = a[0] + ((b[0] - a[0]) * i) / steps
    const py = a[1] + ((b[1] - a[1]) * i) / steps
    const pz = a[2] + ((b[2] - a[2]) * i) / steps
    if (
      boxes.some(
        (bx) =>
          px > bx.min[0] &&
          px < bx.max[0] &&
          py > bx.min[1] &&
          py < bx.max[1] &&
          pz > bx.min[2] &&
          pz < bx.max[2],
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * The standard residential chain is street → METER on the house side →
 * panel. Route it as real geometry: an underground lateral from the nearest
 * map-edge point to below the meter, a riser up the exterior face into the
 * socket, then the meter→panel feed ALONG THE WALLS at a service plane —
 * wall-graph legs with the standard RO detours, exactly like the branch
 * circuits (skeptic 2026-08-16: the old straight Manhattan feed pierced a
 * garage-door RO at socket height and flew 3.6 m through room air after a
 * panel drag). Legs that cannot detour (laterals, socket/enclosure bridges)
 * are sampled against the RO boxes and ⚠-flagged when crossing. The meter
 * fixture is the anchor — a moved `bones:service` electric-meter node
 * re-anchors the whole chain (checklist A4). Exported for the gates.
 */
export function routeServiceCable(
  fixtures: Fixture[],
  walls: WallSlice[],
  graph: Map<string, Junction[]> = buildWallGraph(walls),
): Member[] {
  const members: Member[] = []
  const meter = fixtures.find((f) => f.kind === 'electric-meter')
  const panel = fixtures.find((f) => f.kind === 'panel')
  if (!meter || !panel) return members

  const heavy = (
    from: readonly [number, number, number],
    to: readonly [number, number, number],
    note: string,
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
      dims: vertical
        ? [SERVICE_SECTION, len, SERVICE_SECTION]
        : [len, SERVICE_SECTION, SERVICE_SECTION],
      length: len,
      position: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2],
      rotation: [0, vertical ? 0 : Math.atan2(-dz, dx), 0],
      material: 'copper',
      sourceId: 'service-entrance',
      label: `Service entrance 2 AWG Cu — ${note}`,
    })
  }
  /** Straight leg that can't detour: flag it when it crosses an RO box. */
  const flagged = (
    from: readonly [number, number, number],
    to: readonly [number, number, number],
    note: string,
  ): void =>
    heavy(
      from,
      to,
      segmentCrossesRo(walls, from, to) ? `${note} (⚠ crosses rough opening — verify)` : note,
    )

  // Nearest map-edge point: the walls' plan bbox pushed out by the street
  // margin, then the closest point on that ring to the meter.
  let minX = meter.position[0]
  let maxX = meter.position[0]
  let minZ = meter.position[2]
  let maxZ = meter.position[2]
  for (const w of walls) {
    for (const p of [w.start, w.end]) {
      minX = Math.min(minX, p[0])
      maxX = Math.max(maxX, p[0])
      minZ = Math.min(minZ, p[1])
      maxZ = Math.max(maxZ, p[1])
    }
  }
  const [mx, my, mz] = meter.position
  const edges: [number, number][] = [
    [minX - STREET_EDGE_MARGIN, mz],
    [maxX + STREET_EDGE_MARGIN, mz],
    [mx, minZ - STREET_EDGE_MARGIN],
    [mx, maxZ + STREET_EDGE_MARGIN],
  ]
  const street = edges.reduce((best, e) =>
    Math.hypot(e[0] - mx, e[1] - mz) < Math.hypot(best[0] - mx, best[1] - mz) ? e : best,
  )

  // Underground lateral (Manhattan), then the riser up into the socket —
  // sampled against the RO boxes (a meter dragged under full-height glazing
  // gets a flag, never a silent crossing).
  flagged([street[0], SERVICE_LATERAL_Y, street[1]], [mx, SERVICE_LATERAL_Y, street[1]], 'street lateral (NEC 300.5)')
  flagged([mx, SERVICE_LATERAL_Y, street[1]], [mx, SERVICE_LATERAL_Y, mz], 'street lateral (NEC 300.5)')
  flagged([mx, SERVICE_LATERAL_Y, mz], [mx, my, mz], 'riser to meter')

  // Meter → panel feed (NEC 230.66/230.70): socket → wall centerline, down
  // the stud bay to the service plane, wall-graph legs (RO detours + junction
  // jumpers), back up the panel's bay and into the enclosure.
  const [px, py, pz] = panel.position
  const meterAnchor = nearestWallPoint(walls, [mx, mz], my + 0.25)
  const panelAnchor = nearestWallPoint(walls, [px, pz], py + inches(15))
  const feedEmit: SegmentEmitter = (a, b, note = '') => heavy(a, b, `meter → panel feed${note}`)
  const routed =
    meterAnchor !== null &&
    panelAnchor !== null &&
    wallPath(graph, meterAnchor, panelAnchor) !== null
  if (routed && meterAnchor && panelAnchor) {
    const ma = wallPlan(meterAnchor)
    const pa = wallPlan(panelAnchor)
    flagged([mx, my, mz], [ma[0], my, ma[1]], 'meter → panel feed')
    heavy([ma[0], my, ma[1]], [ma[0], SERVICE_FEED_Y, ma[1]], 'meter → panel feed')
    emitWallPathWith(feedEmit, graph, meterAnchor, panelAnchor, SERVICE_FEED_Y)
    heavy([pa[0], SERVICE_FEED_Y, pa[1]], [pa[0], py, pa[1]], 'meter → panel feed')
    flagged([pa[0], py, pa[1]], [px, py, pz], 'meter → panel feed')
  } else {
    // Disconnected islands / degenerate scenes: a feeder between
    // disconnected structures is BURIED conduit (NEC 300.5), not a
    // panel-height air run (E4) — drop below grade at the meter, cross at
    // lateral depth, rise into the panel.
    const fnote = 'meter → panel feed (⚠ buried crossing — no wall path)'
    heavy([mx, my, mz], [mx, SERVICE_LATERAL_Y, mz], fnote)
    heavy([mx, SERVICE_LATERAL_Y, mz], [px, SERVICE_LATERAL_Y, mz], fnote)
    heavy([px, SERVICE_LATERAL_Y, mz], [px, SERVICE_LATERAL_Y, pz], fnote)
    heavy([px, SERVICE_LATERAL_Y, pz], [px, py, pz], fnote)
  }
  return members
}
