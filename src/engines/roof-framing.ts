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
import { inches } from '../core/units'

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
}

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
    // gambrel / dutch / mansard / flat: LOD 400 — upstream shows a warning
    // via the panel count staying put; we simply emit nothing.
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
) => void

/** Shared emitter: segment-local point → level space via the segment yaw. */
function emitter(roof: RoofSegmentSlice, members: Member[]): Emit {
  const cos = Math.cos(roof.yaw)
  const sin = Math.sin(roof.yaw)
  return (role, size, dims, segPos, extraYaw, tilt, length, material, label) => {
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
      rotation: [0, roof.yaw + extraYaw, tilt],
      material,
      sourceId: roof.id,
      label,
    })
  }
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

  // ---- rafters, both slopes ----
  // Slope length includes the overhang measured along the slope.
  const slopeLen = run / cosT + roof.overhang
  const xs = layout(-roof.width / 2, roof.width / 2, spec.rafterSpacing, halfT)
  for (const x of xs) {
    for (const side of [1, -1] as const) {
      // Center of the rafter: midpoint of the slope segment from the
      // overhung eave tip to the ridge, measured in the segment frame.
      const tipZ = side * (run + roof.overhang * cosT)
      const tipY = eaveY - roof.overhang * Math.sin(theta)
      const midZ = (tipZ + 0) / 2
      const midY = (tipY + ridgeY) / 2
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
        `Rafter ${spec.rafterSize}`,
      )
      if (spec.hurricaneTies) tieAt(emit, x, side * run, eaveY)
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
    `Ridge ${ridgeSize}`,
  )

  // ---- ceiling joists across the depth at the eave line ----
  const [cjT, cjD] = LUMBER_CROSS_SECTIONS[spec.ceilingJoistSize]
  for (const x of layout(-roof.width / 2, roof.width / 2, spec.ceilingJoistSpacing, cjT / 2)) {
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
      `Ceiling joist ${spec.ceilingJoistSize}`,
    )
  }

  // ---- collar ties in the upper third, every other rafter pair ----
  // R802.4.6: collar ties in the upper third of the attic space, 4' o.c. max
  // (every other rafter at 24" o.c.).
  const collarY = eaveY + (2 / 3) * rise
  const collarLen = (2 * (ridgeY - collarY)) / tan
  if (collarLen > 0.3) {
    const [ctT, ctD] = LUMBER_CROSS_SECTIONS['2x4']
    xs.forEach((x, i) => {
      if (i % 2 !== 0) return
      emit(
        'collar-tie',
        '2x4',
        [collarLen, ctD, ctT],
        [x, collarY, 0],
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
      `Ridge ${ridgeSize} (hip)`,
    )
  }

  // ---- hip members to the four corners ----
  // Each hip runs from a ridge end down to its footprint corner: horizontal
  // run = run·√2 (45° plan diagonal), drop = rise.
  const hipLen = Math.hypot(run * Math.SQRT2, rise)
  const hipTilt = Math.atan2(rise, run * Math.SQRT2)
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
      const yawTo = Math.atan2(-dz, dx) // +X box onto the plan diagonal
      emit(
        'hip',
        spec.rafterSize,
        [hipLen, rd, t],
        [(end[0] + corner[0]) / 2, (ridgeY + eaveY) / 2, (end[1] + corner[1]) / 2],
        yawTo + Math.PI, // point downhill (from ridge end toward the corner)
        hipTilt,
        hipLen,
        'lumber',
        `Hip ${spec.rafterSize}`,
      )
    }
  }

  // ---- common rafters on the two long planes, between the hips ----
  const commonSlopeLen = run / cosT + roof.overhang
  const commons = layout(-ridgeHalf, ridgeHalf, spec.rafterSpacing, halfT)
  for (const u of commons) {
    for (const side of [1, -1] as const) {
      const x = alongX ? u : side * ((run + roof.overhang * cosT) / 2)
      const z = alongX ? side * ((run + roof.overhang * cosT) / 2) : u
      const psi = alongX ? (side * Math.PI) / 2 : side === 1 ? 0 : Math.PI
      emit(
        'rafter',
        spec.rafterSize,
        [commonSlopeLen, rd, t],
        [x, (eaveY - roof.overhang * Math.sin(theta) + ridgeY) / 2, z],
        psi,
        theta,
        commonSlopeLen,
        'lumber',
        `Rafter ${spec.rafterSize} (hip common)`,
      )
      if (spec.hurricaneTies) {
        tieAt(emit, alongX ? u : side * run, alongX ? side * run : u, eaveY)
      }
    }
  }
  // // LOD 400: jack rafters on the hip end planes + valley handling when
  // // segments intersect.
}
