/**
 * Roof framing engine — pure functions: Pascal roof-segment nodes → rafters,
 * ridge, hips, ceiling joists, collar ties (+ hurricane ties in high-wind
 * jurisdictions).
 *
 * Host geometry (verified against `roof-segment.ts` / `getSegmentSlopeFrame`
 * in @pascal-app/core):
 *  - a segment is a footprint `width` (local X) × `depth` (local Z) centered
 *    on its `position`, rotated by `rotation` (Y radians); segments nest
 *    under a `roof` group node (own position + Y rotation) which parents to
 *    the level;
 *  - `pitch` is in DEGREES; the primary slope run for a gable is `depth / 2`
 *    (slopes face ±Z, ridge runs along X at z = 0), a shed runs the full
 *    `depth` (single plane), a hip runs `min(width, depth) / 2`;
 *  - eaves sit at `wallHeight` above the segment origin (the knee wall) and
 *    the peak at `wallHeight + run·tan(pitch)`; `overhang` extends past the
 *    footprint along the slope.
 *
 * Rotation convention (matches wall-framing / three.js): a Member's euler
 * [0, ψ, θ] applies Rz(θ) THEN Ry(ψ) to the +X-aligned box — Rz tilts the
 * box to the pitch in the XY plane, Ry yaws it into the slope's downhill
 * direction. Verified numerically in the tests by rotating (1,0,0).
 */

import { LUMBER_CROSS_SECTIONS, type LumberSize } from '../lumber'
import { DEFAULT_SPEC, type FramingSpec, tableSpanFor } from '../core/spec'
import type { Member, WallSlice } from '../core/types'
import { feet, formatIn, inches } from '../core/units'

const EPS = 1e-6

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>
type NodesRecord = Record<string, AnyRecord>

export type RoofSegmentSlice = {
  id: string
  roofType: string
  /** Level-local footprint center (X, Z) and origin height (Y). */
  position: readonly [number, number, number]
  /** Total level-local yaw (roof group + segment), radians. */
  yaw: number
  width: number
  depth: number
  /** Radians (schema stores degrees — converted here). */
  pitch: number
  overhang: number
  wallHeight: number
  // Shape ratios for the multi-face types — host schema fields with the
  // ROOF_SHAPE_DEFAULTS values (roof-segment.ts in @pascal-app/core).
  gambrelLowerWidthRatio?: number
  gambrelLowerHeightRatio?: number
  mansardSteepWidthRatio?: number
  mansardSteepHeightRatio?: number
  dutchHipWidthRatio?: number
  dutchHipHeightRatio?: number
  dutchWaistLengthRatio?: number
}

/** Host defaults for the shape ratios (ROOF_SHAPE_DEFAULTS in @pascal-app/core). */
export const SHAPE_DEFAULTS = {
  gambrelLowerWidthRatio: 0.5,
  gambrelLowerHeightRatio: 0.6,
  mansardSteepWidthRatio: 0.15,
  mansardSteepHeightRatio: 0.7,
  dutchHipWidthRatio: 0.25,
  dutchHipHeightRatio: 0.5,
  dutchWaistLengthRatio: 0.98,
} as const

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * Find every roof-segment whose ancestor chain reaches `levelId`, composing
 * the roof group's transform into the slice. Walks parentId links so it
 * tolerates intermediate grouping nodes.
 */
export function extractRoofs(nodes: NodesRecord, levelId: string): RoofSegmentSlice[] {
  const slices: RoofSegmentSlice[] = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'roof-segment') continue
    if (node.visible === false) continue

    // Walk up: collect roof-group transforms, stop at the level.
    let px = 0
    let py = 0
    let pz = 0
    const segPos = Array.isArray(node.position) ? (node.position as number[]) : [0, 0, 0]
    px = num(segPos[0], 0)
    py = num(segPos[1], 0)
    pz = num(segPos[2], 0)
    let yaw = num(node.rotation, 0)

    let parentId = typeof node.parentId === 'string' ? node.parentId : null
    let reachedLevel = false
    for (let hop = 0; hop < 6 && parentId; hop++) {
      if (parentId === levelId) {
        reachedLevel = true
        break
      }
      const parent = nodes[parentId]
      if (!parent) break
      // Another LEVEL in the chain means this segment belongs elsewhere —
      // walking through it would double-extract the segment from two levels
      // (re-verify advisory: 2x members, one copy at the wrong elevation).
      if (parent.type === 'level') break
      if (parent.type === 'roof') {
        // Compose: p' = roofPos + Ry(roofRot)·p ; yaw' = roofRot + yaw.
        const rot = num(parent.rotation, 0)
        const rp = Array.isArray(parent.position) ? (parent.position as number[]) : [0, 0, 0]
        const cos = Math.cos(rot)
        const sin = Math.sin(rot)
        // three Y-rotation: +X → (cos, 0, -sin), +Z → (sin, 0, cos)
        const nx = px * cos + pz * sin
        const nz = -px * sin + pz * cos
        px = nx + num(rp[0], 0)
        py += num(rp[1], 0)
        pz = nz + num(rp[2], 0)
        yaw += rot
      }
      parentId = typeof parent.parentId === 'string' ? parent.parentId : null
    }
    if (!reachedLevel) continue

    slices.push({
      id: String(node.id ?? ''),
      roofType: typeof node.roofType === 'string' ? node.roofType : 'gable',
      position: [px, py, pz],
      yaw,
      width: num(node.width, 8),
      depth: num(node.depth, 6),
      pitch: (num(node.pitch, 40) * Math.PI) / 180,
      overhang: num(node.overhang, 0.3),
      wallHeight: num(node.wallHeight, 0.5),
      gambrelLowerWidthRatio: num(node.gambrelLowerWidthRatio, SHAPE_DEFAULTS.gambrelLowerWidthRatio),
      gambrelLowerHeightRatio: num(node.gambrelLowerHeightRatio, SHAPE_DEFAULTS.gambrelLowerHeightRatio),
      mansardSteepWidthRatio: num(node.mansardSteepWidthRatio, SHAPE_DEFAULTS.mansardSteepWidthRatio),
      mansardSteepHeightRatio: num(node.mansardSteepHeightRatio, SHAPE_DEFAULTS.mansardSteepHeightRatio),
      dutchHipWidthRatio: num(node.dutchHipWidthRatio, SHAPE_DEFAULTS.dutchHipWidthRatio),
      dutchHipHeightRatio: num(node.dutchHipHeightRatio, SHAPE_DEFAULTS.dutchHipHeightRatio),
      dutchWaistLengthRatio: num(node.dutchWaistLengthRatio, SHAPE_DEFAULTS.dutchWaistLengthRatio),
    })
  }
  return slices
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Ridge stock: one size deeper than the rafters (practice: R802.3 ridge ≥ rafter cut depth). */
function ridgeSizeFor(rafterSize: LumberSize): LumberSize {
  switch (rafterSize) {
    case '2x4':
      return '2x6'
    case '2x6':
      return '2x8'
    case '2x8':
      return '2x10'
    default:
      return '2x12'
  }
}

/** Layout positions along an axis at o.c. spacing with guaranteed ends. */
function layout(from: number, to: number, spacing: number, halfT: number): number[] {
  const out: number[] = []
  const end = to - halfT
  for (let u = from + halfT; u < end - EPS; u += spacing) out.push(u)
  out.push(end)
  return out.filter((u, i, all) => i === all.length - 1 || (all[i + 1] ?? 0) - u > 2 * halfT - EPS)
}

/**
 * Frame every roof segment. `_walls` reserved for LOD 400 bearing checks
 * (rafters bearing on actual top plates instead of the segment eave line).
 */
export function frameRoofs(
  roofs: RoofSegmentSlice[],
  _walls: WallSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
): Member[] {
  const members: Member[] = []
  for (const roof of roofs) {
    if (roof.roofType === 'gable') frameGable(roof, spec, members)
    else if (roof.roofType === 'shed') frameShed(roof, spec, members)
    else if (roof.roofType === 'hip') frameHip(roof, spec, members)
    else if (roof.roofType === 'flat') frameFlat(roof, spec, members)
    else if (roof.roofType === 'gambrel') frameGambrel(roof, spec, members)
    else if (roof.roofType === 'mansard') frameMansard(roof, spec, members)
    else if (roof.roofType === 'dutch') frameDutch(roof, spec, members)
  }
  // Valleys where two gable segments cross (LOD 350).
  if (spec.detail !== '200') {
    const valleys = detectValleys(roofs)
    for (const valley of valleys) emitValley(valley, spec, members)
    // B6: a valley MINOR's deck plane keeps running past the valley line
    // (the detector's stated overlay-framing assumption — its rafters
    // already overlay the main roof). Cheap honesty over expensive
    // clipping: the panels carry the trim note instead of a carved hole.
    const minors = new Set(valleys.map((v) => v.minorId))
    if (minors.size > 0) {
      for (const m of members) {
        if ((m.role === 'sheathing' || m.role === 'wrb') && minors.has(m.sourceId)) {
          m.label = `${m.label} — valley overlay: trim to the valley line on site`
        }
      }
    }
  }
  return members
}

type Emit = (
  role: Member['role'],
  size: LumberSize | undefined,
  dims: [number, number, number],
  segPos: [number, number, number],
  extraYaw: number,
  tilt: number,
  length: number,
  material: Member['material'],
  label?: string,
  roll?: number,
  flag?: string,
) => void

/**
 * XYZ euler equal to Ry(yaw)·Rx(roll) — a member yawed about world Y and
 * ROLLED about its own long (+X) axis. The [0, ψ, θ] convention can't
 * express roll (Rz pitches the axis instead of spinning the section);
 * decomposition follows three's Euler XYZ extraction.
 */
export function eulerYawRoll(yaw: number, roll: number): [number, number, number] {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cr = Math.cos(roll)
  const sr = Math.sin(roll)
  return [
    Math.atan2(sr, cy * cr),
    Math.asin(Math.max(-1, Math.min(1, sy * cr))),
    Math.atan2(-sy * sr, cy),
  ]
}

/** Shared emitter: segment-local point → level space via the segment yaw. */
function emitter(roof: RoofSegmentSlice, members: Member[]): Emit {
  const cos = Math.cos(roof.yaw)
  const sin = Math.sin(roof.yaw)
  return (role, size, dims, segPos, extraYaw, tilt, length, material, label, roll, flag) => {
    const [x, y, z] = segPos
    // three Y-rotation of the segment-local offset: +X → (cos, 0, -sin).
    const wx = x * cos + z * sin
    const wz = -x * sin + z * cos
    members.push({
      system: 'roof-framing',
      role,
      size,
      dims,
      length,
      position: [roof.position[0] + wx, roof.position[1] + y, roof.position[2] + wz],
      rotation: roll ? eulerYawRoll(roof.yaw + extraYaw, roll) : [0, roof.yaw + extraYaw, tilt],
      material,
      sourceId: roof.id,
      label,
      flag,
    })
  }
}

/** Outlooker spacing up the rake (4 ft o.c. is the conventional maximum). */
const OUTLOOKER_SPACING = 1.2
/** Rake overhangs below this need no outlookers — the sheathing cantilevers. */
const MIN_RAKE_OVERHANG = 0.15
/** Sub-fascia stock. */
const FASCIA_SIZE: LumberSize = '2x6'
/** Finish fascia board — 1x8 (3/4" × 7-1/4" actual), face-nailed over the sub. */
const FINISH_FASCIA_SIZE: LumberSize = '1x8'

/**
 * One eave edge = a 2x6 sub-fascia + a 1x8 FINISH fascia proud of its face
 * (rubric 400 'fascia + sub-fascia members'). `alongXAxis` names the edge
 * direction; `cross` is the signed eave-line coordinate on the other axis —
 * the finish board sits |sub/2 + finish/2| further OUT along that sign.
 */
function fasciaPair(
  emit: Emit,
  alongXAxis: boolean,
  length: number,
  along: number,
  cross: number,
  y: number,
  note = '',
) {
  const [fT, fD] = LUMBER_CROSS_SECTIONS[FASCIA_SIZE]
  const yaw = alongXAxis ? 0 : -Math.PI / 2
  const at = (c: number): [number, number, number] => (alongXAxis ? [along, y, c] : [c, y, along])
  // `cross` is the tail plumb-cut plane — the sub-fascia face-nails to it,
  // so its CENTER sits half a thickness outside (round-10 gate: centering
  // it on the cut buried the tails inside the board).
  const subCross = cross + Math.sign(cross) * (fT / 2)
  emit(
    'fascia',
    FASCIA_SIZE,
    [length, fD, fT],
    at(subCross),
    yaw,
    0,
    length,
    'lumber',
    `Sub-fascia ${FASCIA_SIZE}${note}`,
  )
  const [nT, nD] = LUMBER_CROSS_SECTIONS[FINISH_FASCIA_SIZE]
  const out = Math.sign(cross) * (fT / 2 + nT / 2)
  emit(
    'fascia',
    FINISH_FASCIA_SIZE,
    [length, nD, nT],
    at(subCross + out),
    yaw,
    0,
    length,
    'lumber',
    `Fascia 1x8 (finish, over sub-fascia)${note}`,
  )
}

/**
 * LOD 400 fabrication data for a common rafter: plumb-cut angle at the ridge,
 * birdsmouth seat and HAP — the height above plate that survives after the
 * seat cut (drives fascia lines).
 *
 * The seat wants the full 3½" plate, but R802.7.1 caps the notch: the
 * heel's vertical bite (seat × tanθ) must not exceed d/4 of the rafter.
 * Above ~21° on a 2x6 (or ~27° on a 2x8) the cap governs and the seat
 * narrows — a fixed 3½" seat over-notched every steep roof.
 */
export function birdsmouthSeat(theta: number, rafterDepth: number): number {
  const full = inches(3.5)
  const tan = Math.tan(theta)
  if (tan <= 0) return full
  return Math.min(full, rafterDepth / 4 / tan)
}

function rafterCutData(spec: FramingSpec, theta: number, rafterDepth: number): string {
  if (spec.detail !== '400') return ''
  const deg = Math.round((theta * 180) / Math.PI)
  const seat = birdsmouthSeat(theta, rafterDepth)
  const plumbDepth = rafterDepth / Math.cos(theta)
  const hap = plumbDepth - seat * Math.tan(theta)
  return ` — plumb cut ${deg}°, birdsmouth seat ${formatIn(seat)}, HAP ${formatIn(hap)}`
}

// ---------------------------------------------------------------------------
// Span discipline (LOD-400 audit B2) — R802.4.1 rafters / R802.5.1 supports
// ---------------------------------------------------------------------------

/** Longest one-piece stock stick the takeoff can buy (20 ft). A structural
 * rafter/joist beyond this is a FIELD SPLICE — not a prescriptive member
 * unless the splice lands over a real bearing (purlin row). */
const MAX_ONE_PIECE = feet(20)
/** R802.5.1: purlin struts ≤ 4 ft o.c. to bearing. */
const STRUT_SPACING = 1.2
const STRUT_SIZE: LumberSize = '2x4'

const fmtM = (v: number) => `${v.toFixed(2)} m`
const ocIn = (spacing: number) => `${Math.round(spacing / inches(1))}"`

/** Allowable rafter span (horizontal projection, m) for the spec, or
 * undefined when unchecked (LOD 200, or no tabulated row for the size). */
function rafterAllowable(spec: FramingSpec): number | undefined {
  if (spec.detail === '200') return undefined
  return tableSpanFor(spec.rafterSpans, spec.rafterSize, spec.rafterSpacing)
}

/** Over-span flag for one slope plane's rafters (shapes without a purlin fix). */
function rafterOverSpanFlag(
  spec: FramingSpec,
  run: number,
  allowable: number,
  what = 'Rafter',
): string {
  return (
    `${what} over prescriptive span — ${fmtM(run)} horizontal projection > ` +
    `${fmtM(allowable)} allowable (${spec.rafterSize} @ ${ocIn(spec.rafterSpacing)} o.c., ` +
    `SPF #2, R802.4.1) — purlin + 2x4 struts to bearing or engineered member required (R802.5.1)`
  )
}

/** One-piece stock flag: a spliced structural member without a bearing under
 * the splice is not a prescriptive member (the takeoff otherwise books
 * '20 ft stock (field splice)' silently). */
function onePieceFlag(what: string, cutLength: number): string | undefined {
  if (cutLength <= MAX_ONE_PIECE + EPS) return undefined
  return (
    `${what} ${fmtM(cutLength)} exceeds 20 ft one-piece stock — field splice needs ` +
    `bearing at the joint (purlin/wall) or an engineered member (R802.4.1)`
  )
}

/** Flag for one slope: over-span first, then the one-piece check. */
function slopeRafterFlag(
  spec: FramingSpec,
  run: number,
  cutLength: number,
  what = 'Rafter',
): string | undefined {
  if (spec.detail === '200') return undefined
  const allowable = rafterAllowable(spec)
  if (allowable !== undefined && run > allowable + EPS) {
    return rafterOverSpanFlag(spec, run, allowable, what)
  }
  return onePieceFlag(what, cutLength)
}

/** Label suffix for CONTINUOUSLY-SUPPORTED members that exceed one-piece
 * stock (ridge boards between rafter pairs, rims on joist ends, barges on
 * outlookers, purlins on struts): their field splice lands over real
 * support, so the takeoff's '20 ft stock (field splice)' row books with the
 * bearing named instead of silently. Spanning members use the FLAG instead.
 * FABRICATION data → 400 only, exactly like rafterCutData (plumb cuts/HAP):
 * at 300 these members stay byte-equal to the shipped output. */
function splicedNote(spec: FramingSpec, length: number, over: string): string {
  if (spec.detail !== '400') return ''
  return length > MAX_ONE_PIECE + EPS ? ` — spliced over ${over}` : ''
}

/** Ceiling-joist span flag (R802.5.1) — the joist is emitted ONE PIECE with
 * bearing modeled only at the eave walls, so `span` is its full length. */
function ceilingJoistFlag(spec: FramingSpec, span: number): string | undefined {
  if (spec.detail === '200') return undefined
  const allowable = tableSpanFor(spec.ceilingJoistSpans, spec.ceilingJoistSize, spec.ceilingJoistSpacing)
  if (allowable !== undefined && span > allowable + EPS) {
    return (
      `Ceiling joist over prescriptive span — ${fmtM(span)} > ${fmtM(allowable)} allowable ` +
      `(${spec.ceilingJoistSize} @ ${ocIn(spec.ceilingJoistSpacing)} o.c., SPF #2, ` +
      `R802.5.1(2) limited storage) — lap over interior bearing or engineered member required`
    )
  }
  return onePieceFlag('Ceiling joist', span)
}

// ---------------------------------------------------------------------------
// Roof deck (LOD-400 B6) — R803.2 sheathing on the rafter planes
// ---------------------------------------------------------------------------

/** 7/16" WSP roof deck (R803.2, fastened per Table R602.3(1)). */
const ROOF_DECK_T = inches(7 / 16)
/** Strip height (plan run) when tiling TAPERED planes (hip/skirt). Each
 * strip takes its width at its UPHILL edge so it stays inside the hip/arris
 * lines — the under-tile per hip edge is ≈ run·strip·taper/cosθ, so the
 * strip pitch bounds the loss (~8% on a default hip at 0.4 m — stated on
 * the members' labels; the takeoff books what renders, S4). */
const DECK_STRIP = 0.4
/** Panel clearance off hip/arris lines (strips stay inside the plane). */
const DECK_CLEAR = 0.02
/** Minimum panel dimension worth emitting. */
const DECK_MIN = 0.1

/** Edge gap at a panel's UP/DOWNHILL plan edges: the square-cut end faces
 * tilt with the plane, so their corners reach (t/2)·sinθ past the plan edge
 * — the gap keeps them clear of the mirrored panel at a ridge/kink and of
 * the fascia band at the eave (the ridge-vent / drip-edge seams). */
const deckGap = (theta: number): number => (ROOF_DECK_T / 2) * Math.sin(theta) + 0.002

const DECK_LABEL =
  'Roof sheathing 7/16" WSP — 8d @ 6"/12" edges/field (R803.2, Table R602.3(1))'

/** Underlayment membrane drawn thickness — the wall-layers WRB convention
 * (a thin box; real felt has no structural thickness). */
const UNDERLAYMENT_T = 0.002
/** The TOP membrane carries the assumption-label contract: the covering
 * itself (shingles/metal/tile) stays HOST cosmetic and is never booked. */
const UNDERLAYMENT_LABEL =
  'Roof underlayment — one layer felt/synthetic (R905.1.1); covering by finish schedule — not booked'

/**
 * One deck panel on a slope plane. Geometry in the SEGMENT frame: the
 * plane's eave (level) direction runs along X when `alongXAxis` (downhill =
 * ±Z via `side`), else along Z (downhill = ±X). `zTop`→`zBot` is the
 * panel's PLAN band on the downhill axis measured from the segment center
 * (zTop uphill of zBot; negative allowed — the shed's high edge crosses the
 * center); `yTop` is the RAFTER-CENTERLINE plane height at `zTop` (falling
 * at tanθ downhill); `u0`→`u1` bound the panel along the eave axis. The
 * deck rides the rafter TOP faces — `rafterDepth/2 + t/2` up the plane
 * normal (the outlooker roll convention), SLID up-slope so the panel's plan
 * extents equal [zTop, zBot] exactly: callers own the edge gaps (deckGap)
 * that keep the tilted end faces clear of ridges, kinks and the fascia
 * band, while adjacent strips in one plane meet edge-to-edge (coplanar
 * exact contact — the stud-on-plate convention, zero shared volume).
 */
function deckPlane(
  emit: Emit,
  spec: FramingSpec,
  opts: {
    theta: number
    side: 1 | -1
    alongXAxis: boolean
    u0: number
    u1: number
    zTop: number
    zBot: number
    yTop: number
    rafterDepth: number
    note?: string
  },
) {
  if (spec.detail === '200') return
  const { theta, side, alongXAxis, u0, u1, zTop, zBot, yTop, rafterDepth, note = '' } = opts
  const cosT = Math.cos(theta)
  const len = u1 - u0
  const slopeW = (zBot - zTop) / cosT
  if (len < DECK_MIN || slopeW < DECK_MIN) return
  const along = (u0 + u1) / 2
  const zm = (zTop + zBot) / 2
  const ym = yTop - (zm - zTop) * Math.tan(theta)
  // Roll spins the box about its long (+X) axis so its local +Y aligns with
  // the plane normal — the outlooker convention. Along-Z panels yaw −π/2
  // first (local +X → +Z, local +Z → −X), which flips the roll sign.
  const roll = alongXAxis ? side * theta : -side * theta
  const yaw = alongXAxis ? 0 : -Math.PI / 2
  // Normal offset + in-plane slide back to the band: vertically that is
  // up/cosθ (the dropped-gable olT/cosθ convention) with the plan center
  // staying at zm — the panel covers [zTop, zBot] exactly. The membrane
  // stacks 1:1 ON the deck, one thickness further up the normal — the
  // wall-layers emitStack pattern (each layer advances its own thickness).
  const cross = side * zm
  const layer = (
    role: Member['role'],
    up: number,
    t: number,
    material: Member['material'],
    label: string,
  ) => {
    const y = ym + up / cosT
    emit(
      role,
      undefined,
      [len, t, slopeW],
      alongXAxis ? [along, y, cross] : [cross, y, along],
      yaw,
      0,
      len,
      material,
      label,
      roll,
    )
  }
  layer('sheathing', rafterDepth / 2 + ROOF_DECK_T / 2, ROOF_DECK_T, 'engineered', DECK_LABEL + note)
  layer(
    'wrb',
    rafterDepth / 2 + ROOF_DECK_T + UNDERLAYMENT_T / 2,
    UNDERLAYMENT_T,
    'lumber',
    UNDERLAYMENT_LABEL + note,
  )
}

/** Steel hurricane tie block at a rafter bearing (IRC R802.11 uplift path). */
function tieAt(emit: Emit, x: number, z: number, y: number) {
  emit(
    'blocking',
    undefined,
    [inches(1.5), inches(3), inches(3)],
    [x, y, z],
    0,
    0,
    inches(3),
    'steel',
    'hurricane tie',
  )
}

function frameGable(roof: RoofSegmentSlice, spec: FramingSpec, members: Member[]) {
  const emit = emitter(roof, members)
  const [t, rd] = LUMBER_CROSS_SECTIONS[spec.rafterSize]
  const halfT = t / 2
  const theta = roof.pitch
  const tan = Math.tan(theta)
  const cosT = Math.cos(theta)
  const run = roof.depth / 2
  const rise = run * tan
  const eaveY = roof.wallHeight
  const ridgeY = eaveY + rise
  // Rafters bear on the ridge FACES: each plumb cut stops half the ridge
  // thickness short of the centerline (round-10 gate: centerline rafters
  // buried themselves in the ridge AND in the opposite slope's rafters).
  const [ridgeT] = LUMBER_CROSS_SECTIONS[ridgeSizeFor(spec.rafterSize)]
  const ridgeFaceZ = ridgeT / 2
  const ridgeFaceY = ridgeY - ridgeFaceZ * tan

  // ---- rafters, both slopes ----
  // Slope length: overhung eave tip to the ridge face, along the slope.
  // Both ends are PLUMB cuts; a square-ended box's corners overshoot each
  // cut plane by (rd/2)·tanθ, so the box is inscribed — pulled back that
  // much per end (centers stay on the face→tip midpoint).
  const plumbInset = (rd / 2) * tan
  const slopeLen = run / cosT + roof.overhang - ridgeFaceZ / cosT - 2 * plumbInset
  const cuts = rafterCutData(spec, theta, rd)
  const xs = layout(-roof.width / 2, roof.width / 2, spec.rafterSpacing, halfT)

  // ---- span discipline (R802.4.1): mid-span purlin fix, or the honest flag ----
  // Ceiling-joist stock decides the strut bearing plane (they exist in every
  // gable — the rafter ties of R802.4.2), so it is resolved up here.
  const [cjT, cjD] = LUMBER_CROSS_SECTIONS[spec.ceilingJoistSize]
  const allowable = rafterAllowable(spec)
  const overSpan = allowable !== undefined && run > allowable + EPS
  // Purlin line at half the run: the rafter UNDERSIDE there (centerline lies
  // on the tip→ridge-face slope line; the bottom face sits rd/(2cosθ) below
  // it measured vertically), purlin plumb on edge right under, struts to the
  // ceiling joists. A plumb purlin meets the SLOPED underside at its DOWNHILL
  // top corner — the top face drops (t/2)·tanθ below the plane at the line so
  // the corner touches instead of burying itself (SAT gate; shimmed on site).
  const purlinZ = run / 2
  const purlinYUnder = ridgeFaceY - (purlinZ - ridgeFaceZ) * tan - rd / (2 * cosT)
  const purlinTop = purlinYUnder - (t / 2) * tan
  const strutTop = purlinTop - rd // purlin stock = rafter stock, on edge
  const strutBot = eaveY + cjD // ceiling-joist top face
  // The purlin fix only holds when the HALVED projection fits the table AND
  // the struts have real height down to the ceiling-joist bearing (S1: no
  // floating struts) AND the roof is wide enough for a real purlin between
  // the end rafters — otherwise keep the flag instead of fake support.
  const purlinFix =
    overSpan &&
    run / 2 <= (allowable ?? 0) + EPS &&
    strutTop - strutBot >= inches(3) &&
    (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0) - t > 0.3
  const rafterFlag =
    overSpan && !purlinFix
      ? rafterOverSpanFlag(spec, run, allowable as number)
      : purlinFix
        ? undefined
        : spec.detail === '200'
          ? undefined
          : onePieceFlag('Rafter', slopeLen)
  const purlinNote = purlinFix
    ? ` — purlin-supported @ mid-span (R802.5.1)${
        slopeLen > MAX_ONE_PIECE + EPS ? '; splice over purlin bearing' : ''
      }`
    : ''

  // Rake detail (below) lays flat outlookers OVER the gable-end rafters —
  // those two rafters DROP by the outlooker thickness so the ladder passes
  // (the conventional dropped-gable detail; round-10 gate).
  const [olT, olW] = LUMBER_CROSS_SECTIONS['2x4']
  const hasRake = spec.detail !== '200' && roof.overhang >= MIN_RAKE_OVERHANG
  const dropped = new Set(hasRake ? [xs[0], xs[xs.length - 1]] : [])
  for (const x of xs) {
    for (const side of [1, -1] as const) {
      // Center of the rafter: midpoint of the slope segment from the
      // overhung eave tip to the ridge face, measured in the segment frame.
      const tipZ = side * (run + roof.overhang * cosT)
      const tipY = eaveY - roof.overhang * Math.sin(theta)
      const midZ = (tipZ + side * ridgeFaceZ) / 2
      // Dropped-gable detail: the top surface sits one outlooker thickness
      // below the roof plane ALONG THE NORMAL — vertically that's olT/cosθ.
      const midY = (tipY + ridgeFaceY) / 2 - (dropped.has(x) ? olT / cosT : 0)
      // Euler [0, ψ, θ]: Rz(θ) lifts +X in the XY plane, Ry(ψ) yaws it into
      // the slope. +Z side rises toward -Z ⇒ ψ = +π/2; -Z side ⇒ ψ = -π/2.
      emit(
        'rafter',
        spec.rafterSize,
        [slopeLen, rd, t],
        [x, midY, midZ],
        (side * Math.PI) / 2,
        theta,
        slopeLen,
        'lumber',
        `Rafter ${spec.rafterSize}${cuts}${purlinNote}`,
        undefined,
        rafterFlag,
      )
      if (spec.hurricaneTies) tieAt(emit, x, side * run, eaveY)
    }
  }

  // ---- rake framing: barge rafters + outlookers over the gable ends ----
  // The roof plane cantilevers `overhang` past the end walls along X; a
  // barge (verge) rafter carries the rake edge, held by flat 2x4 outlookers
  // laid over a dropped end rafter, cantilevering 2:1 back to the first
  // interior rafter (conventional rake detail — R802 has no prescriptive
  // table for it).
  if (hasRake) {
    for (const sx of [1, -1] as const) {
      // The ladder spans from the FIRST INTERIOR rafter's inner-side face to
      // the barge's inner face. Derived from the ACTUAL xs positions —
      // layout() snugs the last grid rafter beside the dropped end rafter on
      // wide roofs, and the nominal-spacing ladder impaled it (round-14).
      const ordered = sx === 1 ? [...xs].sort((a, b) => a - b) : [...xs].sort((a, b) => b - a)
      const inner = ordered[ordered.length - 2] ?? ordered[ordered.length - 1] ?? 0
      const bargeX = sx * (roof.width / 2 + roof.overhang)
      const innerFace = inner + sx * halfT
      const outerFace = bargeX - sx * halfT
      const olLen = Math.abs(outerFace - innerFace)
      const olCx = (innerFace + outerFace) / 2
      // barge rafters, both slopes, at the rake line
      for (const side of [1, -1] as const) {
        const tipZ = side * (run + roof.overhang * cosT)
        const tipY = eaveY - roof.overhang * Math.sin(theta)
        emit(
          'rafter',
          spec.rafterSize,
          [slopeLen, rd, t],
          [
            sx * (roof.width / 2 + roof.overhang),
            (tipY + ridgeFaceY) / 2,
            (tipZ + side * ridgeFaceZ) / 2,
          ],
          (side * Math.PI) / 2,
          theta,
          slopeLen,
          'lumber',
          `Barge rafter ${spec.rafterSize} (rake)${splicedNote(spec, slopeLen, 'outlooker bearings')}`,
        )
      }
      // outlookers ladder up both slopes at 4' o.c.
      const cx = olCx
      for (const side of [1, -1] as const) {
        for (let z = OUTLOOKER_SPACING / 2; z < run - EPS; z += OUTLOOKER_SPACING) {
          // Flat 2x4 lying IN the roof plane (rolled about its long axis) —
          // a horizontal box crossed the sloped plane within its own width
          // (round-10 gate). The SHEATHING plane is the rafter TOP — rd/2
          // above the centerline plane along the normal (0, cosθ, side·sinθ);
          // the outlooker hangs half its thickness under that.
          const up = rd / 2 - olT / 2
          const y = ridgeY - z * tan + up * cosT
          const zc = side * z + side * up * Math.sin(theta)
          emit(
            'outlooker',
            '2x4',
            [olLen, olT, olW],
            [cx, y, zc],
            0,
            0,
            olLen,
            'lumber',
            'Outlooker 2x4 flat @ 4ft (rake)',
            side * theta,
          )
        }
      }
    }
  }

  // ---- fascia (sub + finish) along both eave tips (LOD 400) ----
  if (spec.detail === '400') {
    const [, fD] = LUMBER_CROSS_SECTIONS[FASCIA_SIZE]
    const fasciaLen = roof.width + 2 * roof.overhang
    const fasciaY = eaveY - roof.overhang * Math.sin(theta) + fD / 2
    for (const side of [1, -1] as const) {
      fasciaPair(emit, true, fasciaLen, 0, side * (run + roof.overhang * cosT), fasciaY, splicedNote(spec, fasciaLen, 'rafter tails (scarf joints)'))
    }
  }

  // ---- ridge board along X at the peak ----
  const ridgeSize = ridgeSizeFor(spec.rafterSize)
  const [rt, rdd] = LUMBER_CROSS_SECTIONS[ridgeSize]
  const ridgeLen = roof.width + 2 * roof.overhang
  emit(
    'ridge',
    ridgeSize,
    [ridgeLen, rdd, rt],
    [0, ridgeY - rdd / 2, 0],
    0,
    0,
    ridgeLen,
    'lumber',
    `Ridge ${ridgeSize}${spec.detail === '400' ? ` — rafter plumb cuts ${Math.round((theta * 180) / Math.PI)}°` : ''}${splicedNote(spec, ridgeLen, 'rafter pairs (ridge board)')}`,
  )

  // ---- deck on both slope planes (LOD-400 B6, R803.2) ----
  // Full rectangles ridge line → eave tip; the rake overhang widens the
  // plane past the barges when the ladder is framed. The panel's normal
  // offset (rafter top + half deck) leaves the conventional vent gap at
  // the ridge instead of crossing the centerline.
  for (const side of [1, -1] as const) {
    deckPlane(emit, spec, {
      theta,
      side,
      alongXAxis: true,
      u0: hasRake ? -(roof.width / 2 + roof.overhang) : -roof.width / 2,
      u1: hasRake ? roof.width / 2 + roof.overhang : roof.width / 2,
      zTop: deckGap(theta),
      zBot: run + roof.overhang * cosT - deckGap(theta),
      yTop: ridgeY - deckGap(theta) * tan,
      rafterDepth: rd,
    })
  }

  // ---- ceiling joists across the depth at the eave line ----
  // Running parallel to the rafter span, they double as the RAFTER TIES of
  // R802.4.2 (thrust) — distinct from the collar ties below (uplift, upper
  // third, R802.4.6). The 400 label spells that distinction out.
  // (cjT/cjD hoisted above — the purlin struts bear on these joists.)
  // A joist landing on a rafter plane sisters BESIDE it (framers face-nail
  // ties to the rafter side) — snapped toward the roof center so the end
  // joists never leave the footprint (round-10 gate).
  const besideRafter = (x0: number, half: number): number => {
    const clash = xs.find((rx) => Math.abs(rx - x0) < halfT + half - EPS)
    if (clash === undefined) return x0
    return clash + (clash >= 0 ? -1 : 1) * (halfT + half)
  }
  const cjFlag = ceilingJoistFlag(spec, roof.depth)
  const cjStations = layout(-roof.width / 2, roof.width / 2, spec.ceilingJoistSpacing, cjT / 2).map(
    (x0) => besideRafter(x0, cjT / 2),
  )
  // B6: the deck rides the rafter-TOP plane, and near the eave a square
  // joist END would poke through it — real ends are field-clipped to the
  // rafter slope (the R802.4.2 tie still reaches the plate), so the box
  // INSCRIBES inside the clip exactly like the rafters' plumb-cut boxes.
  // Span/flag math stays on the FULL depth (the buy length). LOD 200 has
  // no deck and keeps the schematic full box.
  const cjClip =
    spec.detail === '200' || tan <= EPS
      ? 0
      : Math.max(0, (cjD - rd / (2 * cosT)) / tan + 0.002)
  const cjLen = roof.depth - 2 * cjClip
  for (const x of cjStations) {
    if (cjLen < 0.3) break
    // +X box yawed onto +Z: ψ = -π/2 (three: +X → (cosψ, 0, -sinψ)).
    emit(
      'ceiling-joist',
      spec.ceilingJoistSize,
      [cjLen, cjD, cjT],
      [x, eaveY + cjD / 2, 0],
      -Math.PI / 2,
      0,
      cjLen,
      'lumber',
      `Ceiling joist ${spec.ceilingJoistSize}${spec.detail === '400' ? ' — rafter tie (R802.4.2), ends clipped to the roof slope' : ''}`,
      undefined,
      cjFlag,
    )
  }

  // ---- mid-span purlin + 2x4 struts (R802.5.1) when the table ran out ----
  // Purlin stock = rafter stock, on edge under the rafters at half the run;
  // struts ≤ 4 ft o.c. drop to the CEILING JOISTS (the only modeled bearing
  // below — labeled as the assumption). The purlin stops at the end rafters'
  // INNER faces: the dropped gable-end rafters sit an outlooker thickness
  // lower, and a full-width purlin would clip them.
  if (purlinFix) {
    const first = xs[0] ?? -roof.width / 2
    const last = xs[xs.length - 1] ?? roof.width / 2
    const purlinLen = last - first - t
    if (purlinLen > 0.3) {
      const cx = (first + last) / 2
      const [sT, sW] = LUMBER_CROSS_SECTIONS[STRUT_SIZE]
      const strutLen = strutTop - strutBot
      // Strut stations at ≤ 4 ft o.c. along the purlin, each SNAPPED onto the
      // nearest ceiling joist so the foot lands on real wood (S1).
      const stations = new Set<number>()
      for (let sx = first + t / 2 + STRUT_SPACING / 2; sx < last - t / 2; sx += STRUT_SPACING) {
        let best = cjStations[0] ?? sx
        for (const cj of cjStations) if (Math.abs(cj - sx) < Math.abs(best - sx)) best = cj
        if (best >= first + t / 2 - EPS && best <= last - t / 2 + EPS) stations.add(best)
      }
      for (const side of [1, -1] as const) {
        emit(
          'ridge',
          spec.rafterSize,
          [purlinLen, rd, t],
          [cx, purlinTop - rd / 2, side * purlinZ],
          0,
          0,
          purlinLen,
          'lumber',
          `Purlin ${spec.rafterSize} @ mid-span under rafters (R802.5.1) — halves the ${fmtM(run)} projection${splicedNote(spec, purlinLen, 'struts')}`,
        )
        for (const sx of stations) {
          emit(
            'post',
            STRUT_SIZE,
            [sT, strutLen, sW],
            [sx, (strutTop + strutBot) / 2, side * purlinZ],
            0,
            0,
            strutLen,
            'lumber',
            `Purlin strut ${STRUT_SIZE} @ ≤4 ft o.c. — bears on ceiling joists (assumed bearing, R802.5.1)`,
          )
        }
      }
    }
  }

  // ---- collar ties in the upper third, every other rafter pair ----
  // R802.4.6: collar ties in the upper third of the attic space, 4' o.c. max
  // (every other rafter at 24" o.c.).
  // Upper third — but never INTO the ridge: at ≤12° pitch the upper-third
  // line sits above the ridge's bottom face (round-14). Clamp beneath it.
  const [, ctDepth] = LUMBER_CROSS_SECTIONS['2x4']
  const ridgeBottom = ridgeY - rdd
  const collarY = Math.min(eaveY + (2 / 3) * rise, ridgeBottom - ctDepth / 2 - 0.005)
  const collarLen = (2 * (ridgeY - collarY)) / tan
  if (collarLen > 0.3 && collarY > eaveY + 0.2) {
    const [ctT, ctD] = LUMBER_CROSS_SECTIONS['2x4']
    xs.forEach((x, i) => {
      if (i % 2 !== 0) return
      // Face-nailed to the rafter side (toward the roof center) — a tie ON
      // the rafter plane interpenetrates both slopes' rafters.
      const cx = x + (x >= 0 ? -1 : 1) * (halfT + ctT / 2)
      emit(
        'collar-tie',
        '2x4',
        [collarLen, ctD, ctT],
        [cx, collarY, 0],
        -Math.PI / 2,
        0,
        collarLen,
        'lumber',
        'Collar tie 2x4',
        undefined,
        // a TENSION member cannot field-splice — over-stock ties flag
        spec.detail === '200' ? undefined : onePieceFlag('Collar tie', collarLen),
      )
    })
  }
}

function frameShed(roof: RoofSegmentSlice, spec: FramingSpec, members: Member[]) {
  const emit = emitter(roof, members)
  const [t, rd] = LUMBER_CROSS_SECTIONS[spec.rafterSize]
  const theta = roof.pitch
  const cosT = Math.cos(theta)
  // Single plane over the whole depth, rising toward +Z's opposite: the host
  // shed rises across the full depth (run = depth).
  const slopeLen = roof.depth / cosT + 2 * roof.overhang
  const lowY = roof.wallHeight
  const midY = lowY + (roof.depth / 2) * Math.tan(theta)
  // Span discipline: the shed's horizontal projection is the FULL depth and
  // no ceiling joists exist below to strut a purlin to — flag only (S1).
  const shedFlag = slopeRafterFlag(spec, roof.depth, slopeLen)
  for (const x of layout(-roof.width / 2, roof.width / 2, spec.rafterSpacing, t / 2)) {
    emit(
      'rafter',
      spec.rafterSize,
      [slopeLen, rd, t],
      [x, midY, 0],
      Math.PI / 2,
      theta,
      slopeLen,
      'lumber',
      `Rafter ${spec.rafterSize} (shed)`,
      undefined,
      shedFlag,
    )
    if (spec.hurricaneTies) {
      tieAt(emit, x, roof.depth / 2, lowY)
      tieAt(emit, x, -roof.depth / 2, lowY + roof.depth * Math.tan(theta))
    }
  }

  // ---- deck over the single plane (B6): high tip → low tip, both
  // overhangs included (slopeLen spans them, plan extension o·cosθ each).
  deckPlane(emit, spec, {
    theta,
    side: 1,
    alongXAxis: true,
    u0: -roof.width / 2,
    u1: roof.width / 2,
    zTop: -roof.depth / 2 - roof.overhang * cosT + deckGap(theta),
    zBot: roof.depth / 2 + roof.overhang * cosT - deckGap(theta),
    yTop: midY + (roof.depth / 2 + roof.overhang * cosT - deckGap(theta)) * Math.tan(theta),
    rafterDepth: rd,
  })
}

function frameHip(roof: RoofSegmentSlice, spec: FramingSpec, members: Member[]) {
  const emit = emitter(roof, members)
  const [t, rd] = LUMBER_CROSS_SECTIONS[spec.rafterSize]
  const halfT = t / 2
  const theta = roof.pitch
  const tan = Math.tan(theta)
  const cosT = Math.cos(theta)
  const run = Math.min(roof.width, roof.depth) / 2
  const rise = run * tan
  const eaveY = roof.wallHeight
  const ridgeY = eaveY + rise
  // Ridge shrinks by the hip run at each end, along the LONG axis.
  const alongX = roof.width >= roof.depth
  const longHalf = Math.max(roof.width, roof.depth) / 2
  const ridgeHalf = Math.max(0, longHalf - run)

  // ---- ridge ----
  if (ridgeHalf > 0.05) {
    const ridgeSize = ridgeSizeFor(spec.rafterSize)
    const [rt, rdd] = LUMBER_CROSS_SECTIONS[ridgeSize]
    emit(
      'ridge',
      ridgeSize,
      [ridgeHalf * 2, rdd, rt],
      [0, ridgeY - rdd / 2, 0],
      alongX ? 0 : -Math.PI / 2,
      0,
      ridgeHalf * 2,
      'lumber',
      `Ridge ${ridgeSize} (hip)${
        spec.detail === '400'
          ? ` — rafter plumb cuts ${Math.round((theta * 180) / Math.PI)}°`
          : ''
      }${splicedNote(spec, ridgeHalf * 2, 'rafter pairs (ridge board)')}`,
    )
  }

  // ---- hip members to the four corners ----
  // Each hip runs from a ridge end down to its footprint corner: horizontal
  // run = run·√2 (45° plan diagonal), drop = rise.
  const hipTilt = Math.atan2(rise, run * Math.SQRT2)
  // The hip's top cut bears on the ridge END, not inside it: pull the upper
  // end down-slope until the box clears the ridge body (half ridge thickness
  // + half hip thickness in plan, diagonal at 45°) plus the plumb-cut inset
  // of the square-ended box (round-10 gate).
  const [hipRidgeT] = LUMBER_CROSS_SECTIONS[ridgeSizeFor(spec.rafterSize)]
  const hipInset = Math.SQRT2 * (hipRidgeT / 2 + t / 2) + (rd / 2) * Math.tan(hipTilt)
  const hipLen = Math.hypot(run * Math.SQRT2, rise) - hipInset
  // Hips carry jacks — table spans are a rafter concept, but a field-spliced
  // hip is no more a structural member than a spliced common (one-piece check).
  const hipFlag = spec.detail === '200' ? undefined : onePieceFlag('Hip', hipLen)
  for (const se of [1, -1] as const) {
    for (const sc of [1, -1] as const) {
      // Ridge end (segment frame) and its corner.
      const end: [number, number] = alongX ? [se * ridgeHalf, 0] : [0, se * ridgeHalf]
      const corner: [number, number] = [
        alongX ? se * (ridgeHalf + run) : sc * run,
        alongX ? sc * run : se * (ridgeHalf + run),
      ]
      const dx = corner[0] - end[0]
      const dz = corner[1] - end[1]
      const planLen = Math.hypot(dx, dz)
      // Slide the START point down the diagonal by the inset's plan component.
      const slide = (hipInset * Math.cos(hipTilt)) / planLen
      const start: [number, number] = [end[0] + dx * slide, end[1] + dz * slide]
      const startY = ridgeY - hipInset * Math.sin(hipTilt)
      const yawTo = Math.atan2(-dz, dx) // +X box onto the plan diagonal
      emit(
        'hip',
        spec.rafterSize,
        [hipLen, rd, t],
        [(start[0] + corner[0]) / 2, (startY + eaveY) / 2, (start[1] + corner[1]) / 2],
        yawTo + Math.PI, // point downhill (from ridge end toward the corner)
        hipTilt,
        hipLen,
        'lumber',
        `Hip ${spec.rafterSize}${
          spec.detail === '400'
            ? ` — plumb ${Math.round((hipTilt * 180) / Math.PI)}°, side cuts 45°`
            : ''
        }`,
        undefined,
        hipFlag,
      )
    }
  }

  // ---- common rafters on the two long planes, between the hips ----
  const commonCuts = rafterCutData(spec, theta, rd)
  // Same ridge-face bearing + inscribed plumb cuts as the gable commons.
  const cRidgeFace = hipRidgeT / 2
  const cPlumbInset = (rd / 2) * tan
  const commonSlopeLen = run / cosT + roof.overhang - cRidgeFace / cosT - 2 * cPlumbInset
  const commonFaceY = ridgeY - cRidgeFace * tan
  // Span discipline: hip commons/kings project `run` horizontally. No
  // ceiling joists are modeled under a hip (LOD-400 audit batch 7), so
  // struts have nothing real to bear on — flag only (S1).
  const commonFlag = slopeRafterFlag(spec, run, commonSlopeLen)
  const commons = layout(-ridgeHalf, ridgeHalf, spec.rafterSpacing, halfT)
  for (const u of commons) {
    for (const side of [1, -1] as const) {
      const tipPlan = run + roof.overhang * cosT
      const x = alongX ? u : side * ((tipPlan + cRidgeFace) / 2)
      const z = alongX ? side * ((tipPlan + cRidgeFace) / 2) : u
      // Rising axis must point from the ±X eave tip toward the ridge at x=0:
      // +X side ⇒ horizontal −X ⇒ ψ = π; −X side ⇒ ψ = 0.
      const psi = alongX ? (side * Math.PI) / 2 : side === 1 ? Math.PI : 0
      emit(
        'rafter',
        spec.rafterSize,
        [commonSlopeLen, rd, t],
        [x, (eaveY - roof.overhang * Math.sin(theta) + commonFaceY) / 2, z],
        psi,
        theta,
        commonSlopeLen,
        'lumber',
        `Rafter ${spec.rafterSize} (hip common)${commonCuts}`,
        undefined,
        commonFlag,
      )
      if (spec.hurricaneTies) {
        tieAt(emit, alongX ? u : side * run, alongX ? side * run : u, eaveY)
      }
    }
  }

  // ---- jack rafters on the four triangular planes (LOD 350) ----
  // Side planes: past each ridge end the trapezoid tapers — jacks at o.c.
  // shorten from the full common run down to nothing at the corner, each
  // landing on the hip (plan line |cross| = |long| − ridgeHalf).
  // End planes: mirrored — jacks run along the LONG axis from the end eave
  // to the hip, with a full-run king common on the plane's centerline.
  if (spec.detail !== '200') {
    const cuts = rafterCutData(spec, theta, rd)
    const jackLabel = (jackRun: number) =>
      `Jack rafter ${spec.rafterSize}${
        spec.detail === '400'
          ? ` — ${formatIn(jackRun / cosT)} slope, cheek 45°`
          : ''
      }${cuts}`
    // A jack's cheek bears on the hip's SIDE FACE, not its centerline: in
    // plan the 45° hip face sits √2·t/2 before the line, the jack's own
    // half-thickness adds t/2, and the square-ended box needs its plumb
    // inset — all pulled off the top of the run (round-10 gate).
    const jackSetback = (Math.SQRT2 * t) / 2 + t / 2 + (rd / 2) * Math.sin(theta)
    const emitSloped = (
      role: Member['role'],
      long: number,
      cross: number,
      longIsX: boolean,
      psi: number,
      jackRun: number,
      label: string,
    ) => {
      // Member from eave tip (cross extent run + overhang·cosT) up to the
      // hip bearing (cross extent = run − jackRun + setback).
      const bearingRun = jackRun - jackSetback
      if (bearingRun / cosT + roof.overhang < 0.2) return
      // Tail plumb cut: inscribe the square-ended box like the gable commons.
      const tailPlan = (rd / 2) * Math.sin(theta)
      const tipCross = run + roof.overhang * cosT - tailPlan
      const topCross = run - bearingRun
      const midCross = ((tipCross + topCross) / 2) * Math.sign(cross)
      const tipY = eaveY - roof.overhang * Math.sin(theta) + tailPlan * tan
      const topY = eaveY + bearingRun * tan
      const len = bearingRun / cosT + roof.overhang - (rd / 2) * tan
      emit(
        role,
        spec.rafterSize,
        [len, rd, t],
        longIsX ? [long, (tipY + topY) / 2, midCross] : [midCross, (tipY + topY) / 2, long],
        psi,
        theta,
        len,
        'lumber',
        label,
        undefined,
        // a near-full-length jack is the same span class as a common —
        // checked on its OWN bearing run (short corner jacks stay quiet)
        slopeRafterFlag(spec, bearingRun, len, 'Jack rafter'),
      )
    }
    for (const se of [1, -1] as const) {
      // side-plane jacks: stations past the ridge end toward the corner
      for (let d = spec.rafterSpacing; d < run - halfT; d += spec.rafterSpacing) {
        const jackRun = run - d
        for (const sc of [1, -1] as const) {
          const long = se * (ridgeHalf + d)
          const psi = alongX ? (sc * Math.PI) / 2 : sc === 1 ? Math.PI : 0
          emitSloped('jack-rafter', long, sc, alongX, psi, jackRun, jackLabel(jackRun))
          // Uplift path applies to every bearing rafter — jacks included
          // (round-2 advisory: hip jacks had no ties in high-wind specs).
          if (spec.hurricaneTies) {
            tieAt(emit, alongX ? long : sc * run, alongX ? sc * run : long, eaveY)
          }
        }
      }
      // end-plane: king common on the centerline runs the full hip run…
      {
        const psi = alongX ? (se === 1 ? Math.PI : 0) : (se * Math.PI) / 2
        const tipCross = run + roof.overhang * cosT
        const tipY = eaveY - roof.overhang * Math.sin(theta)
        // The king's top bears where the two HIPS converge, not on ridge
        // end-grain alone: pull back like a jack cheek (half hip thickness
        // at 45° + the plumb inset) — at 60° pitch the un-set-back king
        // buried its top corner in both hips (round-14).
        const kingSetback = (Math.SQRT2 * t) / 2 + (rd / 2) * Math.sin(theta)
        const midLong = se * (ridgeHalf + kingSetback + (tipCross - kingSetback) / 2)
        // Inscribed: both ends are plumb cuts (hip junction + tail).
        const len = (run - kingSetback) / cosT + roof.overhang - 2 * cPlumbInset
        // Center height at the box's own top cut (ridgeY − setback·tanθ),
        // NOT the apex — averaging tipY with the full apex floated the box
        // ~t·sinθ·√2/2 proud of the slope plane along its normal while the
        // plan center honored the setback (latent round-14 residue the B6
        // deck exposed: king × deck SAT hits on every hip).
        const kingMidY = (tipY + ridgeY - kingSetback * tan) / 2
        emit(
          'rafter',
          spec.rafterSize,
          [len, rd, t],
          alongX ? [midLong, kingMidY, 0] : [0, kingMidY, midLong],
          psi,
          theta,
          len,
          'lumber',
          `King common ${spec.rafterSize} (hip end)${cuts}`,
          undefined,
          slopeRafterFlag(spec, run, len),
        )
        if (spec.hurricaneTies) {
          tieAt(
            emit,
            alongX ? se * (ridgeHalf + run) : 0,
            alongX ? 0 : se * (ridgeHalf + run),
            eaveY,
          )
        }
      }
      // …and jacks step down each side of it
      for (let v = spec.rafterSpacing; v < run - halfT; v += spec.rafterSpacing) {
        const jackRun = run - v
        for (const sv of [1, -1] as const) {
          // On the end plane the RUN direction is the long axis: reuse
          // emitSloped with axes swapped (long ↔ cross).
          const psi = alongX ? (se === 1 ? Math.PI : 0) : (se * Math.PI) / 2
          const bearingRun = jackRun - jackSetback
          if (bearingRun / cosT + roof.overhang < 0.2) continue
          const tailPlan = (rd / 2) * Math.sin(theta)
          const tipCross = ridgeHalf + run + roof.overhang * cosT - tailPlan
          const topCross = ridgeHalf + v + jackSetback
          const midLong = (se * (tipCross + topCross)) / 2
          const tipY = eaveY - roof.overhang * Math.sin(theta) + tailPlan * tan
          const topY = eaveY + bearingRun * tan
          const len = bearingRun / cosT + roof.overhang - (rd / 2) * tan
          emit(
            'jack-rafter',
            spec.rafterSize,
            [len, rd, t],
            alongX ? [midLong, (tipY + topY) / 2, sv * v] : [sv * v, (tipY + topY) / 2, midLong],
            psi,
            theta,
            len,
            'lumber',
            jackLabel(jackRun),
            undefined,
            slopeRafterFlag(spec, bearingRun, len, 'Jack rafter'),
          )
          if (spec.hurricaneTies) {
            tieAt(
              emit,
              alongX ? se * (ridgeHalf + run) : sv * v,
              alongX ? sv * v : se * (ridgeHalf + run),
              eaveY,
            )
          }
        }
      }
    }
  }

  // ---- deck on the four planes (B6): strip-tiled tapered planes ----
  // Long planes: trapezoid ridge (2·ridgeHalf) → eave; end planes: triangle
  // off each ridge END. Strips stay INSIDE the 45° hip lines (each band's
  // width taken at its UPHILL edge − clearance) — conservative under-tile
  // at the hips, stated on the label.
  if (spec.detail !== '200') {
    const deckR = run + roof.overhang * cosT
    const gap = deckGap(theta)
    const hipNote = ' — tapered plane strip-tiled; trimmed at hips (slight under-tile)'
    for (let z0 = 0; z0 < deckR - EPS; z0 += DECK_STRIP) {
      const z1 = Math.min(z0 + DECK_STRIP, deckR)
      // ridge/eave seams: first strip clears the mirrored plane, last
      // strip clears the fascia band (in-plane strip joints stay exact).
      const zt = Math.max(z0, gap)
      const zb = Math.min(z1, deckR - gap)
      const hwLong = ridgeHalf + z0 - DECK_CLEAR
      const hwEnd = z0 - DECK_CLEAR
      for (const side of [1, -1] as const) {
        deckPlane(emit, spec, {
          theta,
          side,
          alongXAxis: alongX,
          u0: -hwLong,
          u1: hwLong,
          zTop: zt,
          zBot: zb,
          yTop: ridgeY - zt * tan,
          rafterDepth: rd,
          note: hipNote,
        })
        deckPlane(emit, spec, {
          theta,
          side,
          alongXAxis: !alongX,
          u0: -hwEnd,
          u1: hwEnd,
          zTop: ridgeHalf + zt,
          zBot: ridgeHalf + zb,
          yTop: ridgeY - zt * tan,
          rafterDepth: rd,
          note: hipNote,
        })
      }
    }
  }

  // ---- fascia (sub + finish) around all four eaves (LOD 400) ----
  if (spec.detail === '400') {
    const [, fD] = LUMBER_CROSS_SECTIONS[FASCIA_SIZE]
    const tipOut = roof.overhang * cosT
    const fasciaY = eaveY - roof.overhang * Math.sin(theta) + fD / 2
    const halfW = roof.width / 2 + tipOut
    const halfD = roof.depth / 2 + tipOut
    for (const side of [1, -1] as const) {
      fasciaPair(emit, true, 2 * halfW, 0, side * halfD, fasciaY, splicedNote(spec, 2 * halfW, 'rafter tails (scarf joints)'))
      fasciaPair(emit, false, 2 * halfD, 0, side * halfW, fasciaY, splicedNote(spec, 2 * halfD, 'rafter tails (scarf joints)'))
    }
  }
}

// ---------------------------------------------------------------------------
// Flat / gambrel / mansard / dutch (round-1 gap: these emitted nothing)
// ---------------------------------------------------------------------------

/**
 * Flat roof — joist-style platform with a rim, per the rubric ("flat =
 * joist-style with rim"). The host deck extends `overhang` past the footprint
 * on every side (cosθ = 1), so the platform covers footprint + overhang.
 * ASSUMPTION: the drainage slope (min ¼:12, R903.4) is built with tapered
 * insulation above the deck, not by sloping the joists — labels call it out.
 */
function frameFlat(roof: RoofSegmentSlice, spec: FramingSpec, members: Member[]) {
  const emit = emitter(roof, members)
  const [t, rd] = LUMBER_CROSS_SECTIONS[spec.rafterSize]
  const halfW = roof.width / 2 + roof.overhang
  const halfD = roof.depth / 2 + roof.overhang
  const centerY = roof.wallHeight + rd / 2 // resting on the plates, deck above
  const spansX = halfW <= halfD // joists span the SHORT axis
  // Joists stop at the rim INNER faces; the station band also pulls in one
  // thickness so end joists don't share the perpendicular rims' volume
  // (round-14: 36 joist×rim interpenetrations).
  const span = 2 * Math.min(halfW, halfD) - 2 * t
  const stationHalf = Math.max(halfW, halfD) - t
  // Span discipline: a dead-level joist's horizontal projection IS its
  // length. No mid-span bearing is modeled — flag only (S1).
  const flatFlag = slopeRafterFlag(spec, span, span, 'Flat roof joist')
  for (const u of layout(-stationHalf, stationHalf, spec.rafterSpacing, t / 2)) {
    emit(
      'rafter',
      spec.rafterSize,
      [span, rd, t],
      spansX ? [0, centerY, u] : [u, centerY, 0],
      spansX ? 0 : -Math.PI / 2,
      0,
      span,
      'lumber',
      `Flat roof joist ${spec.rafterSize} — slope to drains with tapered insulation (¼:12 min, R903.4)`,
      undefined,
      flatFlag,
    )
  }
  // Long-axis rims run full; short-axis rims BUTT between them.
  const longIsX = halfW >= halfD
  const rimLabel = (len: number) => `Rim / fascia (flat roof)${splicedNote(spec, len, 'joist ends')}`
  for (const side of [1, -1] as const) {
    if (longIsX) {
      emit('rim-joist', spec.rafterSize, [2 * halfW, rd, t], [0, centerY, side * halfD], 0, 0, 2 * halfW, 'lumber', rimLabel(2 * halfW))
      emit('rim-joist', spec.rafterSize, [2 * halfD - 2 * t, rd, t], [side * halfW, centerY, 0], -Math.PI / 2, 0, 2 * halfD - 2 * t, 'lumber', rimLabel(2 * halfD - 2 * t))
    } else {
      emit('rim-joist', spec.rafterSize, [2 * halfW - 2 * t, rd, t], [0, centerY, side * halfD], 0, 0, 2 * halfW - 2 * t, 'lumber', rimLabel(2 * halfW - 2 * t))
      emit('rim-joist', spec.rafterSize, [2 * halfD, rd, t], [side * halfW, centerY, 0], -Math.PI / 2, 0, 2 * halfD, 'lumber', rimLabel(2 * halfD))
    }
  }

  // ---- deck over the whole platform (B6) — dead level on the joist tops;
  // drainage stays the tapered-insulation assumption the joists carry.
  deckPlane(emit, spec, {
    theta: 0,
    side: 1,
    alongXAxis: true,
    u0: -halfW,
    u1: halfW,
    zTop: -halfD,
    zBot: halfD,
    yTop: centerY,
    rafterDepth: rd,
  })
}

/**
 * Gambrel — two planes per side meeting at a purlin. Host geometry: the
 * steep LOWER face carries the schema `pitch` and spans
 * `(depth/2)·gambrelLowerWidthRatio` horizontally, rising
 * `gambrelLowerHeightRatio` of the way to the peak; the shallow upper face
 * finishes the run to the ridge (getPrimarySlopeRun/-RiseFraction in
 * @pascal-app/core).
 */
function frameGambrel(roof: RoofSegmentSlice, spec: FramingSpec, members: Member[]) {
  const emit = emitter(roof, members)
  const [t, rd] = LUMBER_CROSS_SECTIONS[spec.rafterSize]
  const halfT = t / 2
  const theta = roof.pitch
  const tan = Math.tan(theta)
  const cosT = Math.cos(theta)
  const wr = roof.gambrelLowerWidthRatio ?? SHAPE_DEFAULTS.gambrelLowerWidthRatio
  const hr = roof.gambrelLowerHeightRatio ?? SHAPE_DEFAULTS.gambrelLowerHeightRatio
  const run = roof.depth / 2
  const lowerRun = run * wr
  const lowerRise = lowerRun * tan
  const activeRh = lowerRise / hr
  const upperRise = activeRh - lowerRise
  const upperRun = run - lowerRun
  const phi = Math.atan2(upperRise, upperRun)
  const eaveY = roof.wallHeight
  const breakY = eaveY + lowerRise
  const ridgeY = eaveY + activeRh
  const breakZ = upperRun // kink plan line: |z| = run − lowerRun
  const lowerLen = lowerRun / cosT + roof.overhang
  const upperLen = Math.hypot(upperRun, upperRise)
  const cuts = rafterCutData(spec, theta, rd)
  const phiDeg = Math.round((phi * 180) / Math.PI)

  // Purlin/ridge stock decides the bearing faces (round-14: lower and
  // upper planes shared 59mm at every kink and both buried in the ridge).
  const [gRt] = LUMBER_CROSS_SECTIONS[ridgeSizeFor(spec.rafterSize)]
  const lowerInset = (rd / 2) * tan // plumb-cut inscribing, lower plane
  const tanPhi = Math.tan(phi)
  const upperInset = (rd / 2) * tanPhi
  // lower top stops at the purlin face; upper spans purlin face → ridge face
  const lowerTopZ = breakZ + gRt / 2
  const lowerTopY = breakY - (gRt / 2) * tan
  const lowerLen2 = (run + roof.overhang * cosT - lowerTopZ) / cosT - 2 * lowerInset
  const upperLoZ = breakZ - gRt / 2
  const upperLoY = breakY + (gRt / 2) * tanPhi
  const upperHiZ = gRt / 2
  const upperHiY = ridgeY - (gRt / 2) * tanPhi
  const upperLen2 = Math.hypot(upperLoZ - upperHiZ, upperHiY - upperLoY) - 2 * upperInset

  // Span discipline per PLANE: the lower rafters bear eave → break purlin,
  // the uppers purlin → ridge, so each plane's horizontal projection is
  // checked on its own (the break purlins below are real bearing).
  const lowerFlag = slopeRafterFlag(spec, lowerRun, lowerLen2)
  const upperFlag = slopeRafterFlag(spec, upperRun, upperLen2)

  const xs = layout(-roof.width / 2, roof.width / 2, spec.rafterSpacing, halfT)
  for (const x of xs) {
    for (const side of [1, -1] as const) {
      const tipZ = side * (run + roof.overhang * cosT)
      const tipY = eaveY - roof.overhang * Math.sin(theta)
      emit(
        'rafter',
        spec.rafterSize,
        [lowerLen2, rd, t],
        [x, (tipY + lowerTopY) / 2, (tipZ + side * lowerTopZ) / 2],
        (side * Math.PI) / 2,
        theta,
        lowerLen2,
        'lumber',
        `Rafter ${spec.rafterSize} (gambrel lower)${cuts}`,
        undefined,
        lowerFlag,
      )
      emit(
        'rafter',
        spec.rafterSize,
        [upperLen2, rd, t],
        [x, (upperLoY + upperHiY) / 2, (side * (upperLoZ + upperHiZ)) / 2],
        (side * Math.PI) / 2,
        phi,
        upperLen2,
        'lumber',
        `Rafter ${spec.rafterSize} (gambrel upper${spec.detail === '400' ? ` — plumb ${phiDeg}°` : ''})`,
        undefined,
        upperFlag,
      )
      if (spec.hurricaneTies) tieAt(emit, x, side * run, eaveY)
    }
  }

  // ---- deck on all four planes (B6): lower steep + upper shallow per side.
  // The centerline planes extrapolate to the break (breakZ, breakY) and the
  // ridge apex (0, ridgeY); at the convex kink the normal offsets open a
  // gap exactly like the ridge vent gap.
  for (const side of [1, -1] as const) {
    deckPlane(emit, spec, {
      theta,
      side,
      alongXAxis: true,
      u0: -roof.width / 2,
      u1: roof.width / 2,
      zTop: breakZ + deckGap(theta),
      zBot: run + roof.overhang * cosT - deckGap(theta),
      yTop: breakY - deckGap(theta) * tan,
      rafterDepth: rd,
    })
    deckPlane(emit, spec, {
      theta: phi,
      side,
      alongXAxis: true,
      u0: -roof.width / 2,
      u1: roof.width / 2,
      zTop: deckGap(phi),
      zBot: breakZ - deckGap(phi),
      yTop: ridgeY - deckGap(phi) * tanPhi,
      rafterDepth: rd,
    })
  }

  // ridge + a purlin under each kink (the classic gambrel joint support)
  const ridgeSize = ridgeSizeFor(spec.rafterSize)
  const [rt, rdd] = LUMBER_CROSS_SECTIONS[ridgeSize]
  const ridgeLen = roof.width + 2 * roof.overhang
  emit('ridge', ridgeSize, [ridgeLen, rdd, rt], [0, ridgeY - rdd / 2, 0], 0, 0, ridgeLen, 'lumber', `Ridge ${ridgeSize}${splicedNote(spec, ridgeLen, 'rafter pairs (ridge board)')}`)
  for (const side of [1, -1] as const) {
    emit(
      'ridge',
      ridgeSize,
      [roof.width, rdd, rt],
      [0, breakY - rdd / 2, side * breakZ],
      0,
      0,
      roof.width,
      'lumber',
      `Purlin ${ridgeSize} @ gambrel break${splicedNote(spec, roof.width, 'rafter joints — verify strut support (R802.5.1)')}`,
    )
  }

  // ceiling joists at the eave + collar ties in the upper third
  const [cjT, cjD] = LUMBER_CROSS_SECTIONS[spec.ceilingJoistSize]
  const cjFlag = ceilingJoistFlag(spec, roof.depth)
  // B6: end boxes inscribe inside the field clip to the STEEP lower plane
  // (the gable convention above) — the deck rides the rafter tops.
  const cjClip =
    spec.detail === '200' || tan <= EPS
      ? 0
      : Math.max(0, (cjD - rd / (2 * cosT)) / tan + 0.002)
  const cjLen = roof.depth - 2 * cjClip
  for (const x0 of layout(-roof.width / 2, roof.width / 2, spec.ceilingJoistSpacing, cjT / 2)) {
    if (cjLen < 0.3) break
    // sister BESIDE a coincident rafter plane, toward the center (round-14)
    const clash = xs.find((rx) => Math.abs(rx - x0) < halfT + cjT / 2 - EPS)
    const x = clash === undefined ? x0 : clash + (clash >= 0 ? -1 : 1) * (halfT + cjT / 2)
    emit('ceiling-joist', spec.ceilingJoistSize, [cjLen, cjD, cjT], [x, eaveY + cjD / 2, 0], -Math.PI / 2, 0, cjLen, 'lumber', `Ceiling joist ${spec.ceilingJoistSize}${spec.detail === '400' ? ' — rafter tie (R802.4.2), ends clipped to the roof slope' : ''}`, undefined, cjFlag)
  }
  const collarY = eaveY + (2 / 3) * activeRh
  if (collarY > breakY) {
    const collarLen = (2 * (ridgeY - collarY) * upperRun) / upperRise
    if (collarLen > 0.3) {
      const [ctT, ctD] = LUMBER_CROSS_SECTIONS['2x4']
      xs.forEach((x, i) => {
        if (i % 2 !== 0) return
        // face-nailed beside the rafter, toward the roof center (round-14)
        const cx = x + (x >= 0 ? -1 : 1) * (halfT + ctT / 2)
        emit('collar-tie', '2x4', [collarLen, ctD, ctT], [cx, collarY, 0], -Math.PI / 2, 0, collarLen, 'lumber', 'Collar tie 2x4', undefined, spec.detail === '200' ? undefined : onePieceFlag('Collar tie', collarLen))
      })
    }
  }

  // fascia (sub + finish) at the two lower eave tips (LOD 400)
  if (spec.detail === '400') {
    const [, fD] = LUMBER_CROSS_SECTIONS[FASCIA_SIZE]
    const fasciaY = eaveY - roof.overhang * Math.sin(theta) + fD / 2
    for (const side of [1, -1] as const) {
      fasciaPair(emit, true, ridgeLen, 0, side * (run + roof.overhang * cosT), fasciaY, splicedNote(spec, ridgeLen, 'rafter tails (scarf joints)'))
    }
  }
}

/** Shared steep-skirt framing for mansard/dutch: perimeter rafters + arris hips. */
function frameSkirt(
  roof: RoofSegmentSlice,
  spec: FramingSpec,
  members: Member[],
  opts: {
    /** Horizontal skirt run on the ±Z (long-face) sides. */
    sideRun: number
    /** Horizontal skirt run on the ±X (end-face) sides. */
    endRun: number
    /** Vertical rise of the skirt. */
    rise: number
    label: string
  },
) {
  const emit = emitter(roof, members)
  const [t, rd] = LUMBER_CROSS_SECTIONS[spec.rafterSize]
  const halfT = t / 2
  const eaveY = roof.wallHeight
  const { sideRun, endRun, rise, label } = opts
  const sideTheta = Math.atan2(rise, sideRun)
  const endTheta = Math.atan2(rise, endRun)

  const face = (
    stations: number[],
    stationIsX: boolean,
    half: number,
    runH: number,
    theta: number,
  ) => {
    const cosT = Math.cos(theta)
    // Inscribed like the hip family (round-14): the tail plumb cut pulls
    // (rd/2)·tanθ in, and the TOP bears short of the arris junction by the
    // jack-style cheek setback so band-edge rafters, the perpendicular
    // face's rafters and the arris hips never share the corner volume.
    const topSetback = (Math.SQRT2 * t) / 2 + (rd / 2) * Math.sin(theta)
    const tailInset = (rd / 2) * Math.tan(theta)
    const len = (runH - topSetback) / cosT + roof.overhang - 2 * tailInset
    if (len < 0.2) return
    // Span discipline: skirt planes project `runH` horizontally; nothing is
    // modeled to strut a purlin to inside a skirt — flag only (S1).
    const faceFlag = slopeRafterFlag(spec, runH, len)
    const tipOut = half + roof.overhang * cosT
    const topOut = half - runH + topSetback
    const tipY = eaveY - roof.overhang * Math.sin(theta)
    const topY = eaveY + rise - topSetback * Math.tan(theta)
    for (const u of stations) {
      for (const side of [1, -1] as const) {
        const cross = (side * (tipOut + topOut)) / 2
        const psi = stationIsX ? (side * Math.PI) / 2 : side === 1 ? Math.PI : 0
        emit(
          'rafter',
          spec.rafterSize,
          [len, rd, t],
          stationIsX ? [u, (tipY + topY) / 2, cross] : [cross, (tipY + topY) / 2, u],
          psi,
          theta,
          len,
          'lumber',
          `${label} ${spec.rafterSize}${rafterCutData(spec, theta, rd)}`,
          undefined,
          faceFlag,
        )
        if (spec.hurricaneTies) tieAt(emit, stationIsX ? u : side * half, stationIsX ? side * half : u, eaveY)
      }
    }
  }

  // long faces (slopes facing ±Z), stations along X between the arris lines
  // — bands pull one thickness in so edge stations clear the arris tops.
  face(
    layout(-(roof.width / 2 - endRun - t), roof.width / 2 - endRun - t, spec.rafterSpacing, halfT),
    true,
    roof.depth / 2,
    sideRun,
    sideTheta,
  )
  // end faces (slopes facing ±X), stations along Z
  face(
    layout(-(roof.depth / 2 - sideRun - t), roof.depth / 2 - sideRun - t, spec.rafterSpacing, halfT),
    false,
    roof.width / 2,
    endRun,
    endTheta,
  )

  // ---- deck on the four skirt planes (B6): the hip strip pattern with the
  // arris plan slope crossRun/runH (mansard/dutch arrises aren't 45° when
  // endRun ≠ sideRun). Strips stay inside the arris lines — conservative
  // under-tile, stated on the label.
  if (spec.detail !== '200') {
    const skirtNote =
      ' — tapered plane strip-tiled; trimmed at arris hips (slight under-tile)'
    const deckFace = (
      stationIsX: boolean,
      half: number,
      runH: number,
      crossRun: number,
      crossHalf: number,
      theta: number,
    ) => {
      if (runH <= EPS) return
      const cosT = Math.cos(theta)
      const gap = deckGap(theta)
      const zTopEdge = half - runH
      const deckR = half + roof.overhang * cosT
      for (let z0 = zTopEdge; z0 < deckR - EPS; z0 += DECK_STRIP) {
        const z1 = Math.min(z0 + DECK_STRIP, deckR)
        // seams: top strip clears the inner shape's deck at the knuckle,
        // bottom strip clears the fascia band.
        const zt = Math.max(z0, zTopEdge + gap)
        const zb = Math.min(z1, deckR - gap)
        const hw = crossHalf - crossRun + (z0 - zTopEdge) * (crossRun / runH) - DECK_CLEAR
        for (const side of [1, -1] as const) {
          deckPlane(emit, spec, {
            theta,
            side,
            alongXAxis: stationIsX,
            u0: -hw,
            u1: hw,
            zTop: zt,
            zBot: zb,
            yTop: eaveY + rise - (zt - zTopEdge) * Math.tan(theta),
            rafterDepth: rd,
            note: skirtNote,
          })
        }
      }
    }
    deckFace(true, roof.depth / 2, sideRun, endRun, roof.width / 2, sideTheta)
    deckFace(false, roof.width / 2, endRun, sideRun, roof.depth / 2, endTheta)
  }

  // four arris hips: footprint corner → top corner of the skirt, inscribed
  // between their plumb cuts (round-14)
  const hipPlan = Math.hypot(endRun, sideRun)
  const hipTilt = Math.atan2(rise, hipPlan)
  const hipInset = (rd / 2) * Math.tan(hipTilt)
  const hipLen = Math.hypot(hipPlan, rise) - 2 * hipInset
  for (const sx of [1, -1] as const) {
    for (const sz of [1, -1] as const) {
      const corner: [number, number] = [sx * (roof.width / 2), sz * (roof.depth / 2)]
      const top: [number, number] = [sx * (roof.width / 2 - endRun), sz * (roof.depth / 2 - sideRun)]
      const yawTo = Math.atan2(-(corner[1] - top[1]), corner[0] - top[0])
      emit(
        'hip',
        spec.rafterSize,
        [hipLen, rd, t],
        [(corner[0] + top[0]) / 2, eaveY + rise / 2, (corner[1] + top[1]) / 2],
        yawTo + Math.PI,
        hipTilt,
        hipLen,
        'lumber',
        `Hip ${spec.rafterSize} (${label.toLowerCase()} arris)`,
      )
    }
  }
}

/** Inner sections reuse the primary shapes without doubling 400 trim/ties. */
function innerSpec(spec: FramingSpec): FramingSpec {
  return { ...spec, hurricaneTies: false, detail: spec.detail === '200' ? '200' : '300' }
}

/**
 * Mansard — steep skirt on all four sides (run = min(width,depth)·
 * mansardSteepWidthRatio at the schema pitch, rising mansardSteepHeightRatio
 * of the peak height), finished with a shallow hip over the inset rectangle.
 */
function frameMansard(roof: RoofSegmentSlice, spec: FramingSpec, members: Member[]) {
  const swr = roof.mansardSteepWidthRatio ?? SHAPE_DEFAULTS.mansardSteepWidthRatio
  const shr = roof.mansardSteepHeightRatio ?? SHAPE_DEFAULTS.mansardSteepHeightRatio
  const minSpan = Math.min(roof.width, roof.depth)
  const inset = minSpan * swr
  const skirtRise = inset * Math.tan(roof.pitch)
  const activeRh = skirtRise / shr
  const upperRise = activeRh - skirtRise

  frameSkirt(roof, spec, members, {
    sideRun: inset,
    endRun: inset,
    rise: skirtRise,
    label: 'Mansard skirt',
  })

  // upper deck: a shallow hip over the inset rectangle
  const innerRun = minSpan / 2 - inset
  if (innerRun > 0.2 && upperRise > EPS) {
    frameHip(
      {
        ...roof,
        width: roof.width - 2 * inset,
        depth: roof.depth - 2 * inset,
        pitch: Math.atan2(upperRise, innerRun),
        overhang: 0,
        wallHeight: roof.wallHeight + skirtRise,
      },
      innerSpec(spec),
      members,
    )
  }

  // perimeter fascia — sub + finish (LOD 400)
  if (spec.detail === '400') {
    const emit = emitter(roof, members)
    const [, fD] = LUMBER_CROSS_SECTIONS[FASCIA_SIZE]
    const tipOut = roof.overhang * Math.cos(roof.pitch)
    const fasciaY = roof.wallHeight - roof.overhang * Math.sin(roof.pitch) + fD / 2
    const halfW = roof.width / 2 + tipOut
    const halfD = roof.depth / 2 + tipOut
    for (const side of [1, -1] as const) {
      fasciaPair(emit, true, 2 * halfW, 0, side * halfD, fasciaY, splicedNote(spec, 2 * halfW, 'rafter tails (scarf joints)'))
      fasciaPair(emit, false, 2 * halfD, 0, side * halfW, fasciaY, splicedNote(spec, 2 * halfD, 'rafter tails (scarf joints)'))
    }
  }
}

/**
 * Dutch gable — a hip skirt rising dutchHipHeightRatio of the peak height
 * (inset = min(width,depth)·dutchHipWidthRatio), topped by a gablet over the
 * waist rectangle (getDutchRoofMetrics in @pascal-app/core; the gablet barge
 * rake is treated as 0 — the waist end-walls carry the gablet).
 */
function frameDutch(roof: RoofSegmentSlice, spec: FramingSpec, members: Member[]) {
  const dwr = roof.dutchHipWidthRatio ?? SHAPE_DEFAULTS.dutchHipWidthRatio
  const dhr = roof.dutchHipHeightRatio ?? SHAPE_DEFAULTS.dutchHipHeightRatio
  const waistRatio = roof.dutchWaistLengthRatio ?? SHAPE_DEFAULTS.dutchWaistLengthRatio
  const alongX = roof.width >= roof.depth
  const minSpan = Math.min(roof.width, roof.depth)
  const maxSpan = Math.max(roof.width, roof.depth)
  const inset = minSpan * dwr
  const skirtRise = inset * Math.tan(roof.pitch)
  const activeRh = skirtRise / dhr
  const upperRise = activeRh - skirtRise
  const waistHalfLong = Math.max(0, (maxSpan / 2 - inset) * waistRatio)
  const waistHalfShort = Math.max(0, minSpan / 2 - inset)
  const endRun = maxSpan / 2 - waistHalfLong

  frameSkirt(roof, spec, members, {
    sideRun: alongX ? inset : endRun,
    endRun: alongX ? endRun : inset,
    rise: skirtRise,
    label: 'Dutch skirt',
  })

  // gablet over the waist rectangle
  if (waistHalfLong > 0.2 && waistHalfShort > 0.1 && upperRise > EPS) {
    const gablet: RoofSegmentSlice = {
      ...roof,
      yaw: alongX ? roof.yaw : roof.yaw + Math.PI / 2,
      width: 2 * waistHalfLong,
      depth: 2 * waistHalfShort,
      pitch: Math.atan2(upperRise, waistHalfShort),
      overhang: 0,
      wallHeight: roof.wallHeight + skirtRise,
    }
    frameGable(gablet, innerSpec(spec), members)
  }

  // perimeter fascia — sub + finish (LOD 400)
  if (spec.detail === '400') {
    const emit = emitter(roof, members)
    const [, fD] = LUMBER_CROSS_SECTIONS[FASCIA_SIZE]
    const tipOut = roof.overhang * Math.cos(roof.pitch)
    const fasciaY = roof.wallHeight - roof.overhang * Math.sin(roof.pitch) + fD / 2
    const halfW = roof.width / 2 + tipOut
    const halfD = roof.depth / 2 + tipOut
    for (const side of [1, -1] as const) {
      fasciaPair(emit, true, 2 * halfW, 0, side * halfD, fasciaY, splicedNote(spec, 2 * halfW, 'rafter tails (scarf joints)'))
      fasciaPair(emit, false, 2 * halfD, 0, side * halfW, fasciaY, splicedNote(spec, 2 * halfD, 'rafter tails (scarf joints)'))
    }
  }
}

// ---------------------------------------------------------------------------
// Valleys — two gable segments crossing at right angles (LOD 350)
// ---------------------------------------------------------------------------

export type ValleyLine = {
  major: RoofSegmentSlice
  /** The penetrating segment's id — its deck overlays the major (B6 note). */
  minorId: string
  /** Eave foot of the valley, in the MAJOR segment's frame. */
  foot: readonly [number, number, number]
  /** Apex where the minor ridge pierces the major slope (major frame). */
  apex: readonly [number, number, number]
}

/**
 * Detect valley lines between pairs of GABLE segments whose ridges cross at
 * right angles with matching eave heights — the classic L/T roof join. The
 * valley is the intersection of the two slope planes: it rises from the
 * point where the minor's eave meets the major's eave edge to the point
 * where the minor's ridge pierces the major's slope. ASSUMPTIONS: hip/shed
 * joins and skewed (non-perpendicular) crossings are not detected; the
 * penetrating segment's rafters overlay the main roof (overlay framing).
 */
export function detectValleys(roofs: RoofSegmentSlice[]): ValleyLine[] {
  const out: ValleyLine[] = []
  for (const major of roofs) {
    if (major.roofType !== 'gable') continue
    for (const minor of roofs) {
      if (minor === major || minor.roofType !== 'gable') continue
      const rel = minor.yaw - major.yaw
      if (Math.abs(Math.abs(Math.sin(rel)) - 1) > 0.01) continue // ⊥ only
      const eaveMajor = major.position[1] + major.wallHeight
      const eaveMinor = minor.position[1] + minor.wallHeight
      if (Math.abs(eaveMajor - eaveMinor) > 0.05) continue
      // minor center in the major's segment frame (inverse of the emitter Ry)
      const dxl = minor.position[0] - major.position[0]
      const dzl = minor.position[2] - major.position[2]
      const cos = Math.cos(major.yaw)
      const sin = Math.sin(major.yaw)
      const cx = dxl * cos - dzl * sin
      const cz = dxl * sin + dzl * cos
      const run1 = major.depth / 2
      const rise1 = run1 * Math.tan(major.pitch)
      const r2 = minor.depth / 2 // minor slope run — maps onto the major X axis
      const rise2 = r2 * Math.tan(minor.pitch)
      if (rise2 > rise1 + EPS) continue // minor tops out above the major ridge
      const halfAlong = minor.width / 2 // minor ridge half-length, on major Z
      const near = Math.abs(cz) - halfAlong
      if (near >= run1 - EPS) continue // never reaches the major slope
      if (Math.abs(cz) + halfAlong <= run1 + EPS) continue // fully buried
      if (Math.abs(cx) + r2 > major.width / 2 + EPS) continue // past the gable end
      const sz = cz >= 0 ? 1 : -1
      const zApex = run1 - rise2 / Math.tan(major.pitch)
      for (const s of [1, -1] as const) {
        out.push({
          major,
          minorId: minor.id,
          foot: [cx + s * r2, major.wallHeight, sz * run1],
          apex: [cx, major.wallHeight + rise2, sz * zApex],
        })
      }
    }
  }
  return out
}

/** Emit one valley member (one size deeper than the rafters — it carries jacks). */
function emitValley(valley: ValleyLine, spec: FramingSpec, members: Member[]) {
  const emit = emitter(valley.major, members)
  const size = ridgeSizeFor(spec.rafterSize)
  const [t, rd] = LUMBER_CROSS_SECTIONS[size]
  const { foot, apex } = valley
  const ux = apex[0] - foot[0]
  const uy = apex[1] - foot[1]
  const uz = apex[2] - foot[2]
  const plan = Math.hypot(ux, uz)
  const len = Math.hypot(plan, uy)
  if (len < 0.2) return
  const psi = Math.atan2(-uz, ux) // +X toward the uphill direction
  const tilt = Math.atan2(uy, plan)
  emit(
    'valley',
    size,
    [len, rd, t],
    [(foot[0] + apex[0]) / 2, (foot[1] + apex[1]) / 2, (foot[2] + apex[2]) / 2],
    psi,
    tilt,
    len,
    'lumber',
    `Valley ${size}${
      spec.detail === '400'
        ? ` — plumb ${Math.round((tilt * 180) / Math.PI)}°, cheek cuts 45°`
        : ''
    }`,
    undefined,
    spec.detail === '200' ? undefined : onePieceFlag('Valley', len),
  )

  // ---- valley jacks (LOD 400 completion of the 350 valley line) ----
  // The penetrating wing's rafters shorten onto the valley (California-
  // valley practice): at each o.c. station along the wing ridge (the major's
  // Z axis here), a jack runs on the WING's slope from its ridge line down
  // to the valley, with a cheek cut where it lands.
  const [jt, jd] = LUMBER_CROSS_SECTIONS[spec.rafterSize]
  const s = Math.sign(foot[0] - apex[0]) // which side of the wing ridge
  const r2 = Math.abs(foot[0] - apex[0]) // wing slope run (along major X)
  const rise2 = apex[1] - foot[1]
  const theta2 = Math.atan2(rise2, r2)
  const zSpan = foot[2] - apex[2] // signed: apex → eave foot along major Z
  const cx = apex[0]
  for (let dz = spec.rafterSpacing; Math.abs(dz) < Math.abs(zSpan) - jt; dz += spec.rafterSpacing) {
    const z = apex[2] + Math.sign(zSpan) * dz
    // valley point at this station: linear from apex (run 0) to foot (run r2)
    const frac = Math.abs(dz / zSpan)
    const jackRun = r2 * frac
    if (jackRun < 0.15) continue
    const xv = cx + s * jackRun
    const yv = apex[1] - jackRun * Math.tan(theta2)
    const jackLen = Math.hypot(jackRun, apex[1] - yv)
    emit(
      'jack-rafter',
      spec.rafterSize,
      [jackLen, jd, jt],
      [(cx + xv) / 2, (apex[1] + yv) / 2, z],
      s === 1 ? Math.PI : 0, // +X (uphill) points toward the wing ridge
      theta2,
      jackLen,
      'lumber',
      `Valley jack ${spec.rafterSize}${spec.detail === '400' ? ' — cheek 45° at the valley' : ''}`,
      undefined,
      slopeRafterFlag(spec, jackRun, jackLen, 'Valley jack'),
    )
  }
}
