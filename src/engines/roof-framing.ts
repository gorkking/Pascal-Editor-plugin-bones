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
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Member, WallSlice } from '../core/types'
import { formatIn, inches } from '../core/units'

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
    for (const valley of detectValleys(roofs)) emitValley(valley, spec, members)
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
  return (role, size, dims, segPos, extraYaw, tilt, length, material, label, roll) => {
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
    `Sub-fascia ${FASCIA_SIZE}`,
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
    'Fascia 1x8 (finish, over sub-fascia)',
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
        `Rafter ${spec.rafterSize}${cuts}`,
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
          `Barge rafter ${spec.rafterSize} (rake)`,
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
      fasciaPair(emit, true, fasciaLen, 0, side * (run + roof.overhang * cosT), fasciaY)
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
    `Ridge ${ridgeSize}${spec.detail === '400' ? ` — rafter plumb cuts ${Math.round((theta * 180) / Math.PI)}°` : ''}`,
  )

  // ---- ceiling joists across the depth at the eave line ----
  // Running parallel to the rafter span, they double as the RAFTER TIES of
  // R802.4.2 (thrust) — distinct from the collar ties below (uplift, upper
  // third, R802.4.6). The 400 label spells that distinction out.
  const [cjT, cjD] = LUMBER_CROSS_SECTIONS[spec.ceilingJoistSize]
  // A joist landing on a rafter plane sisters BESIDE it (framers face-nail
  // ties to the rafter side) — snapped toward the roof center so the end
  // joists never leave the footprint (round-10 gate).
  const besideRafter = (x0: number, half: number): number => {
    const clash = xs.find((rx) => Math.abs(rx - x0) < halfT + half - EPS)
    if (clash === undefined) return x0
    return clash + (clash >= 0 ? -1 : 1) * (halfT + half)
  }
  for (const x0 of layout(-roof.width / 2, roof.width / 2, spec.ceilingJoistSpacing, cjT / 2)) {
    const x = besideRafter(x0, cjT / 2)
    // +X box yawed onto +Z: ψ = -π/2 (three: +X → (cosψ, 0, -sinψ)).
    emit(
      'ceiling-joist',
      spec.ceilingJoistSize,
      [roof.depth, cjD, cjT],
      [x, eaveY + cjD / 2, 0],
      -Math.PI / 2,
      0,
      roof.depth,
      'lumber',
      `Ceiling joist ${spec.ceilingJoistSize}${spec.detail === '400' ? ' — rafter tie (R802.4.2)' : ''}`,
    )
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
    )
    if (spec.hurricaneTies) {
      tieAt(emit, x, roof.depth / 2, lowY)
      tieAt(emit, x, -roof.depth / 2, lowY + roof.depth * Math.tan(theta))
    }
  }
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
      }`,
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
        emit(
          'rafter',
          spec.rafterSize,
          [len, rd, t],
          alongX ? [midLong, (tipY + ridgeY) / 2, 0] : [0, (tipY + ridgeY) / 2, midLong],
          psi,
          theta,
          len,
          'lumber',
          `King common ${spec.rafterSize} (hip end)${cuts}`,
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

  // ---- fascia (sub + finish) around all four eaves (LOD 400) ----
  if (spec.detail === '400') {
    const [, fD] = LUMBER_CROSS_SECTIONS[FASCIA_SIZE]
    const tipOut = roof.overhang * cosT
    const fasciaY = eaveY - roof.overhang * Math.sin(theta) + fD / 2
    const halfW = roof.width / 2 + tipOut
    const halfD = roof.depth / 2 + tipOut
    for (const side of [1, -1] as const) {
      fasciaPair(emit, true, 2 * halfW, 0, side * halfD, fasciaY)
      fasciaPair(emit, false, 2 * halfD, 0, side * halfW, fasciaY)
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
    )
  }
  // Long-axis rims run full; short-axis rims BUTT between them.
  const longIsX = halfW >= halfD
  for (const side of [1, -1] as const) {
    if (longIsX) {
      emit('rim-joist', spec.rafterSize, [2 * halfW, rd, t], [0, centerY, side * halfD], 0, 0, 2 * halfW, 'lumber', 'Rim / fascia (flat roof)')
      emit('rim-joist', spec.rafterSize, [2 * halfD - 2 * t, rd, t], [side * halfW, centerY, 0], -Math.PI / 2, 0, 2 * halfD - 2 * t, 'lumber', 'Rim / fascia (flat roof)')
    } else {
      emit('rim-joist', spec.rafterSize, [2 * halfW - 2 * t, rd, t], [0, centerY, side * halfD], 0, 0, 2 * halfW - 2 * t, 'lumber', 'Rim / fascia (flat roof)')
      emit('rim-joist', spec.rafterSize, [2 * halfD, rd, t], [side * halfW, centerY, 0], -Math.PI / 2, 0, 2 * halfD, 'lumber', 'Rim / fascia (flat roof)')
    }
  }
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
      )
      if (spec.hurricaneTies) tieAt(emit, x, side * run, eaveY)
    }
  }

  // ridge + a purlin under each kink (the classic gambrel joint support)
  const ridgeSize = ridgeSizeFor(spec.rafterSize)
  const [rt, rdd] = LUMBER_CROSS_SECTIONS[ridgeSize]
  const ridgeLen = roof.width + 2 * roof.overhang
  emit('ridge', ridgeSize, [ridgeLen, rdd, rt], [0, ridgeY - rdd / 2, 0], 0, 0, ridgeLen, 'lumber', `Ridge ${ridgeSize}`)
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
      `Purlin ${ridgeSize} @ gambrel break`,
    )
  }

  // ceiling joists at the eave + collar ties in the upper third
  const [cjT, cjD] = LUMBER_CROSS_SECTIONS[spec.ceilingJoistSize]
  for (const x0 of layout(-roof.width / 2, roof.width / 2, spec.ceilingJoistSpacing, cjT / 2)) {
    // sister BESIDE a coincident rafter plane, toward the center (round-14)
    const clash = xs.find((rx) => Math.abs(rx - x0) < halfT + cjT / 2 - EPS)
    const x = clash === undefined ? x0 : clash + (clash >= 0 ? -1 : 1) * (halfT + cjT / 2)
    emit('ceiling-joist', spec.ceilingJoistSize, [roof.depth, cjD, cjT], [x, eaveY + cjD / 2, 0], -Math.PI / 2, 0, roof.depth, 'lumber', `Ceiling joist ${spec.ceilingJoistSize}${spec.detail === '400' ? ' — rafter tie (R802.4.2)' : ''}`)
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
        emit('collar-tie', '2x4', [collarLen, ctD, ctT], [cx, collarY, 0], -Math.PI / 2, 0, collarLen, 'lumber', 'Collar tie 2x4')
      })
    }
  }

  // fascia (sub + finish) at the two lower eave tips (LOD 400)
  if (spec.detail === '400') {
    const [, fD] = LUMBER_CROSS_SECTIONS[FASCIA_SIZE]
    const fasciaY = eaveY - roof.overhang * Math.sin(theta) + fD / 2
    for (const side of [1, -1] as const) {
      fasciaPair(emit, true, ridgeLen, 0, side * (run + roof.overhang * cosT), fasciaY)
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
      fasciaPair(emit, true, 2 * halfW, 0, side * halfD, fasciaY)
      fasciaPair(emit, false, 2 * halfD, 0, side * halfW, fasciaY)
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
      fasciaPair(emit, true, 2 * halfW, 0, side * halfD, fasciaY)
      fasciaPair(emit, false, 2 * halfD, 0, side * halfW, fasciaY)
    }
  }
}

// ---------------------------------------------------------------------------
// Valleys — two gable segments crossing at right angles (LOD 350)
// ---------------------------------------------------------------------------

export type ValleyLine = {
  major: RoofSegmentSlice
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
    )
  }
}
