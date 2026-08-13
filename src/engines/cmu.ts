/**
 * CMU (concrete masonry unit) wall engine — Florida-style exterior block
 * wall. Pure function: one WallSlice + FramingSpec → the running-bond block
 * coursing that REPLACES stud framing for that wall (system stays
 * 'wall-framing' so visibility/color toggles treat it as the wall system):
 *
 *   8x8x16 blocks in running bond · half-block starters on odd courses ·
 *   first/last blocks cut to the wall length · blocks cut tight to opening
 *   jambs · precast lintel over each opening (8" bearing per side) · a
 *   grouted + reinforced bond beam as the top course · grouted vertical
 *   cells (with rebar) at both wall ends.
 *
 * Real-world basis:
 *  - Standard CMU is nominally 8"h × 16"l × 8"d; actual faces are 3/8" less
 *    (7-5/8" × 15-5/8") so units + mortar joints hit the 8"/16" module
 *    (ASTM C90). We model that literally: nominal grid, blocks shrunk 3/8"
 *    in length/height so the mortar joints read visually WITHOUT emitting
 *    thousands of mortar members.
 *  - Running bond (head joints offset half a unit each course) is the
 *    prescriptive masonry pattern (TMS 402 / IRC R606).
 *  - Reinforced bond beam at the top of the wall — the Florida "tie beam"
 *    (FBC/ACI 530 high-wind practice): top course grouted solid with
 *    horizontal rebar to collect uplift/diaphragm loads.
 *  - Precast concrete lintels over openings with ≥8" bearing each side
 *    (manufacturer minimum, FBC R606.10 / ACI 530 bearing practice).
 *  - Vertical reinforcing in grouted cells at wall ends/corners
 *    (IRC R606.12 / FBC wind provisions). Roles stay 'block' so the takeoff
 *    counts them as purchasable units; the label marks them as grouted so a
 *    grout/rebar line can be derived. // LOD 400: grout jamb cells at
 *    openings and intermediate cells at 48" o.c. per design wind speed.
 *
 * Geometry convention copied from wall-framing.ts: wall-local frame with X
 * along the wall from `start`, Y up, Z across the thickness; every member is
 * an axis-aligned box in that frame and shares one Y rotation (`yaw`).
 */

import type { FramingSpec } from '../core/spec'
import type { Member, WallSlice } from '../core/types'
import { inches } from '../core/units'

const EPS = 1e-6

// ---------------------------------------------------------------------------
// The 8" module (exported so tests + takeoff refinements share one truth)
// ---------------------------------------------------------------------------

/** Nominal course height — 8" block + bed joint (ASTM C90 module). */
export const COURSE_HEIGHT = inches(8) // 0.2032 m
/** Nominal block length — 16" block + head joint. */
export const BLOCK_LENGTH = inches(16) // 0.4064 m
/** Actual (manufactured) block depth — 7-5/8" for a nominal 8" unit. */
export const BLOCK_DEPTH_ACTUAL = inches(7.625)
/** Standard mortar joint — 3/8". Blocks shrink by this so joints read in 3D. */
export const MORTAR_JOINT = inches(0.375)
/** Precast lintel: nominal 8" tall (one course), bears 8" past each jamb. */
export const LINTEL_HEIGHT = inches(8)
export const LINTEL_BEARING = inches(8)

/**
 * Smallest piece a mason will cut and lay. Slivers below this are dropped
 * rather than rendered as unbuildable chips.
 * ASSUMPTION: 2" minimum piece; a real crew would shift head joints or thicken
 * a jamb joint instead of leaving the tiny gap this drop creates.
 */
const MIN_PIECE = inches(2)

// ---------------------------------------------------------------------------
// Wall frame (same yaw/place math as wall-framing.ts)
// ---------------------------------------------------------------------------

type WallFrame = {
  yaw: number
  /** Map wall-local (u, y, v) → level-local position. */
  place: (u: number, y: number, v?: number) => [number, number, number]
}

function frameOf(wall: WallSlice): WallFrame {
  const [dx, dz] = wall.dir
  const [sx, sz] = wall.start
  // Rotating a +X-aligned box by yaw about Y maps +X → [cos, 0, -sin];
  // we need +X → [dx, 0, dz], hence yaw = atan2(-dz, dx).
  const yaw = Math.atan2(-dz, dx)
  return {
    yaw,
    place: (u, y, v = 0) => [sx + dx * u - dz * v, y, sz + dz * u + dx * v],
  }
}

// ---------------------------------------------------------------------------
// Coursing math (exported for direct unit testing, like studPositions)
// ---------------------------------------------------------------------------

/** A block's raw extent [a, b] along the wall, BEFORE the mortar shrink. */
export type BlockInterval = { a: number; b: number }

/**
 * Block layout for one course: full 16" units from the start, with the first
 * unit halved on odd courses (running bond) and the last unit cut to the wall
 * length. Pieces shorter than MIN_PIECE are dropped.
 */
export function courseIntervals(length: number, oddCourse: boolean): BlockInterval[] {
  const out: BlockInterval[] = []
  let u = 0
  if (oddCourse) {
    // Running bond: odd courses start with a half block so every head joint
    // lands mid-unit on the course below (TMS 402 running-bond definition).
    const b = Math.min(BLOCK_LENGTH / 2, length)
    if (b - u >= MIN_PIECE - EPS) out.push({ a: u, b })
    u = b
  }
  while (u < length - EPS) {
    const b = Math.min(u + BLOCK_LENGTH, length) // last block cut to fit
    if (b - u >= MIN_PIECE - EPS) out.push({ a: u, b })
    u = b
  }
  return out
}

/** Axis-aligned keep-out rectangle in wall-local (u, y) space. */
type KeepOut = { u0: number; u1: number; y0: number; y1: number }

/**
 * Cut one block interval around every keep-out: pieces fully inside vanish,
 * straddling blocks are cut tight to the jamb (the cut face lands exactly on
 * the rough-opening line; the rendered face sits half a mortar joint inside).
 */
function subtractKeepOuts(piece: BlockInterval, cuts: BlockInterval[]): BlockInterval[] {
  let pieces = [piece]
  for (const cut of cuts) {
    const next: BlockInterval[] = []
    for (const p of pieces) {
      if (cut.b <= p.a + EPS || cut.a >= p.b - EPS) {
        next.push(p) // no overlap
        continue
      }
      if (cut.a > p.a + EPS) next.push({ a: p.a, b: cut.a }) // left jamb piece
      if (cut.b < p.b - EPS) next.push({ a: cut.b, b: p.b }) // right jamb piece
    }
    pieces = next
  }
  return pieces
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Lay up one CMU wall. Returns [] for curved walls (v1 — flagged upstream)
 * and for walls shorter than a single course.
 *
 * The top course is ALWAYS the bond beam: body coursing stops at the last
 * full course below `wall.height`, and that final full course is emitted as
 * the grouted bond beam ("tie beam") so the wall never exceeds its
 * architectural height.
 */
export function cmuWall(wall: WallSlice, _spec: FramingSpec): Member[] {
  if (wall.curved) return []
  const members: Member[] = []
  const { yaw, place } = frameOf(wall)
  const len = wall.length

  // Block depth: full 8" nominal walls get the actual 7-5/8" unit; thinner
  // architectural walls clamp to the drawn thickness (4"/6" units exist).
  const depth = Math.min(wall.thickness, BLOCK_DEPTH_ACTUAL)

  // Whole courses that fit under the wall height (EPS guards an exact-fit
  // height like 8'-0" from float-rounding down to 11 courses).
  const totalCourses = Math.floor(wall.height / COURSE_HEIGHT + EPS)
  if (totalCourses < 1) return [] // shorter than one course — nothing to lay
  const bodyCourses = totalCourses - 1 // top course is the bond beam
  const bondBeamBottom = bodyCourses * COURSE_HEIGHT

  const emit = (
    role: Member['role'],
    interval: BlockInterval,
    cellBottom: number,
    cellHeight: number,
    label?: string,
  ): void => {
    // Shrink 3/8" in length and height, centered in the nominal cell, so a
    // half-joint of visual gap surrounds every unit (reads as mortar).
    const dims: [number, number, number] = [
      interval.b - interval.a - MORTAR_JOINT,
      cellHeight - MORTAR_JOINT,
      depth,
    ]
    members.push({
      system: 'wall-framing', // CMU replaces the wall's framing system
      role,
      // size intentionally undefined — unit masonry, not dimensional lumber
      dims,
      length: Math.max(dims[0], dims[1]), // cut length = the unit's long dim
      position: place((interval.a + interval.b) / 2, cellBottom + cellHeight / 2),
      rotation: [0, yaw, 0],
      material: 'concrete',
      sourceId: wall.id,
      label,
    })
  }

  // ---- openings: keep-outs + precast lintels ----
  const keepOuts: KeepOut[] = []
  for (const opening of wall.openings) {
    // Rough opening rectangle in wall-local (u, y). Doors carry sillHeight 0,
    // so [sill, sill + roughHeight] covers both kinds.
    const u0 = opening.u - opening.roughWidth / 2
    const u1 = opening.u + opening.roughWidth / 2
    const roBottom = opening.sillHeight
    const roTop = opening.sillHeight + opening.roughHeight
    keepOuts.push({ u0, u1, y0: roBottom, y1: roTop })
    // ASSUMPTION: blocks are removed per whole course cell the RO touches —
    // CMU openings are laid to the 8" module in practice, so partial-height
    // (notched) units are not modeled. // LOD 400: snap RO head/sill to
    // coursing and emit sash/jamb blocks.

    // Precast lintel directly above the RO: 8" tall, bearing 8" onto the
    // blockwork past each jamb (FBC R606.10 / precast manufacturer minimum).
    const la = Math.max(0, u0 - LINTEL_BEARING) // clamp bearing inside the wall
    const lb = Math.min(len, u1 + LINTEL_BEARING)
    // Where the head is within one course of the top of the wall, the bond
    // beam doubles as the lintel (standard FL tie-beam-over-door detail) —
    // cap the lintel at the bond beam and skip it entirely if nothing is left.
    const lintelTop = Math.min(roTop + LINTEL_HEIGHT, bondBeamBottom)
    const lintelHeight = lintelTop - roTop
    if (lintelHeight >= MIN_PIECE && lb - la >= MIN_PIECE) {
      emit(
        'lintel',
        // One precast piece, so its emitted length is the TRUE length
        // (RO + 2×8" bearing): pad half a joint each side to cancel the unit
        // mortar shrink — its end faces then meet the jamb blocks' rendered
        // faces exactly across a half-joint, like a mortared butt joint.
        { a: la - MORTAR_JOINT / 2, b: lb + MORTAR_JOINT / 2 },
        roTop,
        lintelHeight,
        `precast lintel over ${opening.kind} — 8" bearing`,
      )
      // Blocks butt the lintel ends — cut coursing around its rectangle too.
      keepOuts.push({ u0: la, u1: lb, y0: roTop, y1: lintelTop })
    }
  }

  // ---- body coursing: running bond, cut at openings ----
  for (let c = 0; c < bodyCourses; c++) {
    const y0 = c * COURSE_HEIGHT
    const y1 = y0 + COURSE_HEIGHT
    // Keep-outs that touch this course cell vertically.
    const cuts: BlockInterval[] = []
    for (const k of keepOuts) {
      if (k.y0 < y1 - EPS && k.y1 > y0 + EPS) cuts.push({ a: k.u0, b: k.u1 })
    }
    for (const unit of courseIntervals(len, c % 2 === 1)) {
      for (const piece of subtractKeepOuts(unit, cuts)) {
        if (piece.b - piece.a < MIN_PIECE - EPS) continue
        // End cells run vertical rebar and grout solid (IRC R606.12 wind
        // reinforcing at ends/corners) — label so takeoff can count them.
        const grouted = piece.a < EPS || piece.b > len - EPS
        emit('block', piece, y0, COURSE_HEIGHT, grouted ? 'grouted cell + vertical rebar' : undefined)
      }
    }
  }

  // ---- bond beam: the top course, grouted solid with horizontal rebar ----
  // One continuous member (not unit blocks): once grouted, the tie beam acts
  // as a monolithic reinforced element, and the takeoff prices it as poured
  // concrete rather than unit masonry. Runs over openings — it is the
  // structural head where lintels merge into it.
  // ASSUMPTION: continuous across the full wall even over a full-height
  // opening. // LOD 400: interrupt at openings taller than the bond beam
  // bottom and splice rebar per FBC tie-beam details.
  emit(
    'bond-beam',
    // Padded half a joint each side so the emitted box spans exactly `len`
    // after the mortar shrink — a poured beam has no head joints to show.
    { a: -MORTAR_JOINT / 2, b: len + MORTAR_JOINT / 2 },
    bondBeamBottom,
    COURSE_HEIGHT,
    'bond beam — grouted + rebar',
  )

  return members
}
