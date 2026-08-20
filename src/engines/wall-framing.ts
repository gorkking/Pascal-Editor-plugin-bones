/**
 * Wall framing engine — the heart of Bones. Pure functions: WallSlices +
 * FramingSpec → the US platform-framing member set:
 *
 *   bottom plate · top plate(s) · common studs at o.c. spacing · per opening:
 *   king studs, trimmers (doubled past 6 ft), header (sized by span), sill,
 *   cripples · and across walls: California corner assemblies, partition
 *   backing at tees, alternating cap-plate laps · at LOD 400: fire blocking
 *   over 10 ft plates and plate-splice call-outs.
 *
 * Geometry convention: the wall frame has X along the wall (from `start`),
 * Y up, Z across the thickness. Every member is an axis-aligned box in that
 * frame — verticals are just taller-than-wide boxes — so the whole wall
 * shares one Y rotation (`yaw`) when mapped into level space.
 *
 * Cross-wall fabrication (corners/tees/laps) lives in `frameWalls`, which
 * computes per-wall FrameHints and hands them to `frameWall`. `frameWall`
 * alone still frames a standalone wall correctly (hints default to none).
 */

import { LUMBER_CROSS_SECTIONS, type LumberSize } from '../lumber'
import { DEFAULT_SPEC, type FramingSpec, headerFor } from '../core/spec'
import type { Member, OpeningSlice, WallSlice } from '../core/types'
import { feet, formatIn, inches } from '../core/units'

const EPS = 1e-6
/** RO width beyond which each side gets a second trimmer (jack). Exported so
 * the layer engine's insulation batts clear the same opening-frame span. */
export const DOUBLE_TRIMMER_SPAN = feet(6)
/** Fire blocking required over 10 ft of concealed stud cavity (IRC R302.11).
 * Exported so batts split around the same rows. */
export const FIRE_BLOCK_HEIGHT = feet(10)
/** Stock plate length — splices called out past this (min 24" lap, R602.3.2). */
const PLATE_STOCK = feet(20)

type WallFrame = {
  wall: WallSlice
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
    wall,
    yaw,
    place: (u, y, v = 0) => [sx + dx * u - dz * v, y, sz + dz * u + dx * v],
  }
}

/** Stud size for a wall: thick walls (>= threshold) frame with 2x6. */
export function studSizeFor(wall: WallSlice, spec: FramingSpec): LumberSize {
  return wall.thickness >= spec.thickWallThreshold ? spec.exteriorStudSize : spec.interiorStudSize
}

/**
 * Across-wall geometry depth that FITS the drawn wall: caps at the finish
 * cavity (thickness − 1") when the nominal depth overshoots by more than
 * the 2mm SAT-skin grace (the textbook 0.114m/2x4 partition stays
 * byte-equal). The stud-family analog of the S7 batt cap — members keep
 * their nominal size/label/takeoff identity; only the drawn geometry
 * compresses, landing the stud face exactly on the layer engine's
 * stackOrigin (night-4 Cavity-Fit design: 140 default-scene S1 pairs → 0).
 */
export function fitAcross(nominalDepth: number, wall: WallSlice): number {
  const cavity = wall.thickness - inches(1)
  return nominalDepth - cavity > 0.002 ? cavity : nominalDepth
}

/**
 * Per-wall engineering override the framing consumes — a projection of the
 * resolved WallOverride object (framing/compute.ts): stud size pins BOTH
 * spec sizes so the thickness heuristic can't argue, spacing replaces the
 * config's o.c. rhythm. Absent fields keep the spec untouched.
 */
export type WallFramingOverride = { studSize?: '2x4' | '2x6'; spacingIn?: 16 | 24 }

/**
 * The spec one wall frames with: the shared spec, unless the wall carries a
 * studSize/spacingIn override. Returns the SAME object when nothing is
 * overridden, so the default path stays byte-equal (and memo-friendly).
 */
export function specForWall(spec: FramingSpec, override?: WallFramingOverride): FramingSpec {
  if (!override || (override.studSize === undefined && override.spacingIn === undefined)) {
    return spec
  }
  return {
    ...spec,
    ...(override.studSize !== undefined
      ? { interiorStudSize: override.studSize, exteriorStudSize: override.studSize }
      : {}),
    ...(override.spacingIn !== undefined ? { studSpacing: inches(override.spacingIn) } : {}),
  }
}

/**
 * Cross-wall fabrication hints computed by `frameWalls` for one wall.
 * All distances in meters, u measured from the wall's `start`.
 */
export type FrameHints = {
  /**
   * Trim the whole framing RUN (plates + stud layout) at an end: a butting
   * wall's frame stops at the through wall's near FACE instead of running
   * to the centerline corner point (round-10 gate). Meters, ≥ 0.
   */
  startInset?: number
  endInset?: number
  /** Cap-plate length delta at the start end (+ extends past, − shortens). */
  capStartDelta?: number
  /** Cap-plate length delta at the end end. */
  capEndDelta?: number
  /** Extra full-height studs (California corner backing …). */
  extraStuds?: { u: number; label: string }[]
  /** Partition-backing ladder rows: flat blocks at `heights` centered on `u`. */
  backing?: { u: number; heights: number[] }[]
}

type Emit = (
  role: Member['role'],
  size: LumberSize,
  dims: [number, number, number],
  centerU: number,
  centerY: number,
  length: number,
  label?: string,
  flag?: string,
) => void

/** Rough-opening vertical extent [bottom, top] above the subfloor. */
function roughExtent(opening: OpeningSlice): [number, number] {
  if (opening.kind === 'door') return [0, opening.roughHeight]
  return [opening.sillHeight, opening.sillHeight + opening.roughHeight]
}

/**
 * Frame one wall. Returns [] for curved walls (v1 — flagged upstream).
 */
export function frameWall(
  wall: WallSlice,
  spec: FramingSpec = DEFAULT_SPEC,
  hints: FrameHints = {},
): Member[] {
  if (wall.curved) return []
  const members: Member[] = []
  const { yaw, place } = frameOf(wall)
  const studSize = studSizeFor(wall, spec)
  const [t, w] = LUMBER_CROSS_SECTIONS[studSize] // t = 1.5", w = 3.5"/5.5"
  // Cavity-fit: geometry compresses to what the drawn wall holds (labels,
  // takeoff and cut lengths stay nominal). One exact flag string per
  // (size, thickness) class so Takeoff → Flags aggregates with a count.
  const wFit = fitAcross(w, wall)
  const compressionFlag =
    wFit < w
      ? `${studSize} framing compressed to ${formatIn(wFit)} — ${wall.thickness.toFixed(3)}m drawn wall holds ${formatIn(wFit)} + finishes; deepen to ${(w + inches(1)).toFixed(3)}m for full-depth ${studSize}`
      : undefined
  const len = wall.length
  const H = wall.height

  // Trimmed framing run: [u0, u1] — the centerline span minus corner/tee
  // insets, so a butting wall's plates and end stud stop at the through
  // wall's face.
  const u0 = Math.max(0, hints.startInset ?? 0)
  const u1 = Math.max(u0 + 4 * t, len - Math.max(0, hints.endInset ?? 0))
  const runLen = u1 - u0

  const emit: Emit = (role, size, dims, centerU, centerY, length, label, flag) => {
    members.push({
      system: 'wall-framing',
      role,
      size,
      dims,
      length,
      position: place(centerU, centerY),
      rotation: [0, yaw, 0],
      material: 'lumber',
      sourceId: wall.id,
      label,
      // Member-specific flags (engineered header, RO clamp) win; every
      // other member on a compressed wall carries the aggregate flag.
      flag: flag ?? compressionFlag,
    })
  }

  // ---- plates ----
  // Splice call-out: plate stock tops out at 20 ft — longer runs are built
  // from spliced sticks (min 24" lap on the double top plate, R602.3.2).
  // Splice call-out arithmetic (round-10): a run needs ceil(len/stock)
  // sticks and one fewer splices — the old floor()*20 read "40ft stock" on
  // a 40ft+ wall.
  const sticks = Math.ceil(runLen / PLATE_STOCK)
  const spliceNote =
    sticks > 1
      ? ` — spliced from ${sticks}× 20ft stock (${sticks - 1} splice${sticks > 2 ? 's' : ''}, min 24" lap)`
      : ''
  const plateDims: [number, number, number] = [runLen, t, wFit]
  const runMid = (u0 + u1) / 2
  emit('bottom-plate', studSize, plateDims, runMid, t / 2, runLen, `Bottom plate${spliceNote}`)
  emit('top-plate', studSize, plateDims, runMid, H - t / 2, runLen, `Top plate${spliceNote}`)
  if (spec.topPlateCount === 2) {
    // Cap plate: corner hints extend it over the abutting wall's top plate
    // (or pull it short so the neighbor's cap can lap over this one).
    const startDelta = hints.capStartDelta ?? 0
    const endDelta = hints.capEndDelta ?? 0
    const capLen = Math.max(0.1, runLen + startDelta + endDelta)
    // Start edge sits at u0 - startDelta, end edge at u1 + endDelta.
    const capMid = (u0 - startDelta + u1 + endDelta) / 2
    emit(
      'cap-plate',
      studSize,
      [capLen, t, wFit],
      capMid,
      H - t - t / 2,
      capLen,
      `Cap plate${spliceNote}${startDelta > 0 || endDelta > 0 ? ' — laps corner' : ''}`,
    )
  }

  const studBottom = t
  const studTop = H - (spec.topPlateCount === 2 ? 2 * t : t)
  const studHeight = studTop - studBottom
  if (studHeight <= t) return members // degenerate pony wall — plates only

  const studDims: [number, number, number] = [t, studHeight, wFit]
  const halfT = t / 2

  // ---- opening frames (kings / trimmers / header / sill / cripples) ----
  type KeepOut = { min: number; max: number }
  const keepOuts: KeepOut[] = []

  for (const opening of wall.openings) {
    const ro = Math.min(opening.roughWidth, runLen - 4 * t)
    if (ro <= 0) continue
    // Openings past 6 ft bear on DOUBLE trimmers (jack studs) per side —
    // header reactions grow with span (R602.7.5 jack stud requirements).
    const trimmersPerSide = ro > DOUBLE_TRIMMER_SPAN ? 2 : 1
    const frameSide = trimmersPerSide * t
    const u = Math.min(
      Math.max(opening.u, u0 + ro / 2 + frameSide + t),
      u1 - ro / 2 - frameSide - t,
    )
    // The drawn opening doesn't fit where it was placed — the frame slid it
    // to clear the wall end / corner. Surface that instead of silently
    // moving the RO (round-10).
    const roClampFlag =
      Math.abs(u - opening.u) > 0.005
        ? `RO shifted ${((u - opening.u) * 100).toFixed(1)}cm to fit the framed run — verify the drawn position`
        : undefined
    const [roBottom, roTopRaw] = roughExtent(opening)
    const roTop = Math.min(roTopRaw, studTop - t) // leave room for the header
    // The vertical clamp fact (LOD-400 audit B1): a drawn RO taller than
    // the framed run fits gets its head pulled DOWN. Folded into the depth
    // flag below — whenever the head clamps, the header depth also
    // collapses (min(hw, t)), so a separate branch was dead code (verify
    // night-6: zero prints across a 115-case sweep).
    const roHeadClampCm = roTopRaw - roTop > 0.005 ? (roTopRaw - roTop) * 100 : 0

    // Header: bears on the trimmers, so it spans RO + trimmer packs.
    const headerSize = headerFor(spec, ro)
    const [ht, hw] = LUMBER_CROSS_SECTIONS[headerSize]
    const headerLength = ro + 2 * frameSide
    const headerDepth = Math.min(hw, studTop - roTop)
    const headerY = roTop + headerDepth / 2
    const engineered = ro > spec.engineeredHeaderSpan
    // LOD-400 audit B1 (blocker): when the RO crowds the plates the header
    // collapsed to a 1.5" sliver while the takeoff booked the full 4x8 —
    // booked-but-absent. The geometry stays honest; the flag says what a
    // builder must do about it (the over-SPAN case has its own flag).
    const headerDepthFlag =
      headerDepth < hw - 0.005
        ? `header ${headerSize} does not fit between the RO and the plates ` +
          `(${(headerDepth / 0.0254).toFixed(1)}" of ${(hw / 0.0254).toFixed(1)}")` +
          (roHeadClampCm > 0 ? ` — RO head lowered ${roHeadClampCm.toFixed(1)}cm` : '') +
          ` — raise the wall, lower the opening, or use an engineered flat header`
        : undefined
    // COMPOSE the applicable truths (verify night-6: single-slot precedence
    // silenced round-10's roClampFlag whenever depth collapsed, and an
    // ENGINEERED span hid the depth collapse while the takeoff booked the
    // full stick — a warning silently dropped is a lie on paper, P4).
    const headerFlagParts = [
      engineered ? 'ENGINEERED BEAM REQUIRED — exceeds prescriptive header span' : undefined,
      headerDepthFlag,
      roClampFlag,
    ].filter((f): f is string => f !== undefined)
    emit(
      'header',
      headerSize,
      [headerLength, headerDepth, fitAcross(Math.min(ht, wall.thickness), wall)],
      u,
      headerY,
      headerLength,
      `Header ${headerSize} over ${opening.kind}`,
      headerFlagParts.length > 0 ? headerFlagParts.join(' | ') : undefined,
    )

    // Trimmers (jack studs): floor plate → header bottom, tight to the RO.
    const trimmerHeight = roTop - studBottom
    const trimmerDims: [number, number, number] = [t, trimmerHeight, wFit]
    for (const side of [-1, 1] as const) {
      for (let k = 0; k < trimmersPerSide; k++) {
        emit(
          'trimmer',
          studSize,
          trimmerDims,
          u + side * (ro / 2 + halfT + k * t),
          studBottom + trimmerHeight / 2,
          trimmerHeight,
          trimmersPerSide === 2 ? 'Trimmer (doubled — RO > 6 ft)' : undefined,
        )
      }
    }

    // King studs: full height, outside the trimmer pack.
    for (const side of [-1, 1] as const) {
      emit(
        'king-stud',
        studSize,
        studDims,
        u + side * (ro / 2 + frameSide + halfT),
        studBottom + studHeight / 2,
        studHeight,
      )
    }

    // Cripples above the header, continuing the common-stud rhythm.
    const crippleTopHeight = studTop - (roTop + headerDepth)
    if (crippleTopHeight > t) {
      const crippleDims: [number, number, number] = [t, crippleTopHeight, wFit]
      for (const cu of studPositions(len, spec.studSpacing, halfT)) {
        if (Math.abs(cu - u) < ro / 2 - halfT) {
          emit(
            'cripple',
            studSize,
            crippleDims,
            cu,
            roTop + headerDepth + crippleTopHeight / 2,
            crippleTopHeight,
          )
        }
      }
    }

    // Windows: rough sill + cripples below it.
    if (opening.kind === 'window' && roBottom > studBottom + t) {
      const sillY = roBottom - t / 2
      emit('sill', studSize, [ro, t, wFit], u, sillY, ro, 'Rough sill')
      const crippleBottomHeight = roBottom - t - studBottom
      if (crippleBottomHeight > t) {
        const crippleDims: [number, number, number] = [t, crippleBottomHeight, wFit]
        const cus = new Set<number>()
        for (const cu of studPositions(runLen, spec.studSpacing, halfT)) {
          if (Math.abs(cu + u0 - u) < ro / 2 - halfT) cus.add(cu + u0)
        }
        cus.add(u - ro / 2 + halfT)
        cus.add(u + ro / 2 - halfT)
        for (const cu of cus) {
          emit(
            'cripple',
            studSize,
            crippleDims,
            cu,
            studBottom + crippleBottomHeight / 2,
            crippleBottomHeight,
          )
        }
      }
    }

    keepOuts.push({
      min: u - ro / 2 - frameSide - t + EPS,
      max: u + ro / 2 + frameSide + t - EPS,
    })
  }

  // ---- common studs at o.c. spacing (ends always get a stud) ----
  const studUs = studPositions(runLen, spec.studSpacing, halfT).map((su) => su + u0)
  for (const su of studUs) {
    if (keepOuts.some((k) => su > k.min && su < k.max)) continue
    emit('stud', studSize, studDims, su, studBottom + studHeight / 2, studHeight)
  }

  // ---- cross-wall extras (California corner backing studs) ----
  for (const extra of hints.extraStuds ?? []) {
    const eu = Math.min(Math.max(extra.u, u0 + halfT), u1 - halfT)
    emit('stud', studSize, studDims, eu, studBottom + studHeight / 2, studHeight, extra.label)
  }

  // ---- partition backing at tees (ladder blocking, flat 2x) ----
  for (const tee of hints.backing ?? []) {
    // Flat blocks CLIPPED to the actual stud bay around the tee (round-10:
    // a nominal-bay block swallowed the grid stud inside it). Wide face out
    // so drywall on both sides of the abutting partition has bite.
    const uu = Math.min(Math.max(tee.u, u0 + t), u1 - t)
    const left = Math.max(u0 + halfT, ...studUs.filter((su) => su < uu - EPS))
    const right = Math.min(u1 - halfT, ...studUs.filter((su) => su > uu + EPS))
    const blockLen = right - left - t
    if (blockLen < inches(3)) continue
    const bu = (left + right) / 2
    for (const y of tee.heights) {
      if (y > studTop - t) continue
      emit(
        'backing',
        studSize,
        [blockLen, t, wFit],
        bu,
        y,
        blockLen,
        'Partition backing (ladder)',
      )
    }
  }

  // ---- fire blocking (LOD 400): cap concealed cavities every ≤10 ft ----
  // R302.11(2): max 10 ft vertical intervals — a 22 ft balloon wall needs
  // TWO rows, not one (round-10).
  if (spec.detail === '400') {
    const bay = spec.studSpacing - t
    for (let rowY = FIRE_BLOCK_HEIGHT; rowY < studTop - t; rowY += FIRE_BLOCK_HEIGHT) {
      for (let i = 0; i + 1 < studUs.length; i++) {
        const a = studUs[i] as number
        const b = studUs[i + 1] as number
        const mid = (a + b) / 2
        if (keepOuts.some((k) => mid > k.min && mid < k.max)) continue
        const blockLen = Math.min(bay, b - a - t)
        if (blockLen < inches(3)) continue
        emit(
          'fire-blocking',
          studSize,
          [blockLen, t, wFit],
          mid,
          rowY,
          blockLen,
          'Fire blocking @ 10ft (R302.11)',
        )
      }
    }
  }

  return members
}

/**
 * Common-stud center positions: layout on o.c. centers from the wall start,
 * clamped inside the wall, with a guaranteed end stud and NO bay wider than
 * the o.c. spacing — a grid stud that collides with the end stud is pulled
 * adjacent to it rather than dropped (the round-1 reviewer proved dropping
 * it opened a 25.5" bay at 24" o.c.).
 */
export function studPositions(length: number, spacing: number, halfT: number): number[] {
  const out: number[] = []
  const endU = length - halfT
  for (let u = halfT; u < endU - EPS; u += spacing) out.push(u)
  out.push(endU)
  // Resolve collisions at the end: if the last grid stud sits within one stud
  // thickness of the end stud, snug it against the end stud instead of
  // dropping it — the bay before it stays <= spacing.
  if (out.length >= 2) {
    const last = out[out.length - 1] as number
    const prev = out[out.length - 2] as number
    if (last - prev <= 2 * halfT + EPS) {
      const snug = last - 2 * halfT
      // Only keep the snugged stud if it still clears the stud before it.
      const before = out.length >= 3 ? (out[out.length - 3] as number) : Number.NEGATIVE_INFINITY
      if (snug - before > 2 * halfT) out[out.length - 2] = snug
      else out.splice(out.length - 2, 1)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Cross-wall fabrication: corners, tees, cap laps
// ---------------------------------------------------------------------------

type Corner = {
  through: WallSlice
  butting: WallSlice
  /** Which end of each wall meets the corner. */
  throughEnd: 'start' | 'end'
  buttingEnd: 'start' | 'end'
}

const endPoint = (wall: WallSlice, which: 'start' | 'end'): readonly [number, number] =>
  which === 'start' ? wall.start : wall.end

/**
 * Detect L-corners: two walls whose endpoints coincide (within the larger
 * wall thickness). The LONGER wall runs through the corner (tie: lower id) —
 * a deterministic, testable convention.
 */
export function detectCorners(walls: WallSlice[]): Corner[] {
  const corners: Corner[] = []
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i] as WallSlice
      const b = walls[j] as WallSlice
      const tol = Math.max(a.thickness, b.thickness) * 0.75
      for (const ea of ['start', 'end'] as const) {
        for (const eb of ['start', 'end'] as const) {
          const pa = endPoint(a, ea)
          const pb = endPoint(b, eb)
          if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > tol) continue
          // Parallel walls butting end-to-end are a splice, not a corner.
          const cross = Math.abs(a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0])
          if (cross < 0.3) continue
          const aThrough = a.length > b.length || (a.length === b.length && a.id <= b.id)
          corners.push({
            through: aThrough ? a : b,
            butting: aThrough ? b : a,
            throughEnd: aThrough ? ea : eb,
            buttingEnd: aThrough ? eb : ea,
          })
        }
      }
    }
  }
  return corners
}

type Tee = { through: WallSlice; u: number; stem: WallSlice; stemEnd: 'start' | 'end' }

/**
 * Detect T-joints: a wall endpoint landing on another wall's run (not near
 * its ends). The through wall receives partition backing there.
 */
export function detectTees(walls: WallSlice[]): Tee[] {
  const tees: Tee[] = []
  for (const partition of walls) {
    for (const which of ['start', 'end'] as const) {
      const p = endPoint(partition, which)
      for (const through of walls) {
        if (through.id === partition.id) continue
        // Parallelism filter (mirrors detectCorners' splice guard): a
        // back-to-back PARALLEL wall offset by ~a thickness is a drawing
        // artifact, not a tee — without this it registered with sinθ≈0,
        // hit the 0.2 floor and silently ate 0.57m of run per end
        // (night-5 skeptic d2, NEW regression class).
        const cross = Math.abs(
          partition.dir[0] * through.dir[1] - partition.dir[1] * through.dir[0],
        )
        if (cross < 0.3) continue
        const [ax, az] = through.start
        const proj =
          (p[0] - ax) * through.dir[0] + (p[1] - az) * through.dir[1]
        if (proj < through.thickness || proj > through.length - through.thickness) continue
        const foot: [number, number] = [
          ax + through.dir[0] * proj,
          az + through.dir[1] * proj,
        ]
        const dist = Math.hypot(p[0] - foot[0], p[1] - foot[1])
        if (dist > (through.thickness + partition.thickness) / 2 + EPS) continue
        tees.push({ through, u: proj, stem: partition, stemEnd: which })
      }
    }
  }
  return tees
}

/**
 * Cross-wall fabrication hints for a SET of walls — the corner/tee pass
 * frameWalls runs before framing each wall. Exported so the layer engine's
 * insulation batts can lay out against the SAME trimmed runs and backing
 * bays the studs actually occupy (wall-layers.ts) instead of re-deriving a
 * diverging approximation. Per-wall studSize overrides feed the corner
 * arithmetic exactly like the framing pass.
 */
export function frameHints(
  walls: WallSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
  overrides?: ReadonlyMap<string, WallFramingOverride>,
): Map<string, FrameHints> {
  const hints = new Map<string, FrameHints>()
  const hintFor = (wall: WallSlice): FrameHints => {
    let h = hints.get(wall.id)
    if (!h) {
      h = {}
      hints.set(wall.id, h)
    }
    return h
  }
  const wallSpec = (wall: WallSlice): FramingSpec => specForWall(spec, overrides?.get(wall.id))

  for (const corner of detectCorners(walls)) {
    const { through, butting, throughEnd, buttingEnd } = corner
    const [tt] = LUMBER_CROSS_SECTIONS[studSizeFor(through, wallSpec(through))]
    // California 3-stud corner: the through wall's end stud + the butting
    // wall's end stud + ONE backing stud in the through wall, set past the
    // butting wall's far face so interior drywall has backing.
    const setback = butting.thickness + tt / 2
    const throughHints = hintFor(through)
    throughHints.extraStuds = throughHints.extraStuds ?? []
    throughHints.extraStuds.push({
      u: throughEnd === 'start' ? setback : through.length - setback,
      label: 'California corner backing',
    })
    // Cap-plate lap: the through wall's cap runs OVER the butting wall's top
    // plate (extend by half the butting thickness past the corner); the
    // butting wall's cap pulls short so the two caps butt instead of
    // colliding. The pull-back clears whichever is wider — the through
    // wall's drawn thickness or its CAP PLATE width (a 2x4 cap is 3.5" wide,
    // so walls drawn thinner than that would otherwise still collide —
    // round-2 advisory).
    const [, throughCapW] = LUMBER_CROSS_SECTIONS[studSizeFor(through, wallSpec(through))]
    // Oblique multiplier (round-14, ported from foundation): perpendicular
    // corners give k = 1; at 20–60° the square-cut run must retreat
    // (1+|cosθ|)/sinθ half-thicknesses to clear the through wall's sloped
    // face, and the cap lap extends the same factor. Capped at 4.
    const crossD = Math.abs(
      through.dir[0] * butting.dir[1] - through.dir[1] * butting.dir[0],
    )
    const dotD = Math.abs(through.dir[0] * butting.dir[0] + through.dir[1] * butting.dir[1])
    const k = crossD < 0.1 ? 1 : Math.min(4, (1 + dotD) / crossD)
    const extend = (k * butting.thickness) / 2
    // The butting RUN already stops at the through face (startInset below);
    // the cap only needs the EXCESS when the through cap is wider than the
    // through wall itself (thin drawn walls — round-2 advisory).
    const shorten = -Math.max(0, (k * (throughCapW - through.thickness)) / 2)
    if (throughEnd === 'start') throughHints.capStartDelta = (throughHints.capStartDelta ?? 0) + extend
    else throughHints.capEndDelta = (throughHints.capEndDelta ?? 0) + extend
    const buttingHints = hintFor(butting)
    if (buttingEnd === 'start') buttingHints.capStartDelta = (buttingHints.capStartDelta ?? 0) + shorten
    else buttingHints.capEndDelta = (buttingHints.capEndDelta ?? 0) + shorten
    // The butting wall's PLATES and end stud stop at the through wall's
    // near face — k half-thicknesses back from the centerline corner
    // (round-10 gate; round-14 obliques).
    const inset = (k * through.thickness) / 2
    if (buttingEnd === 'start') buttingHints.startInset = Math.max(buttingHints.startInset ?? 0, inset)
    else buttingHints.endInset = Math.max(buttingHints.endInset ?? 0, inset)
  }

  // Partition backing at tees (skip when it duplicates a corner) — and the
  // partition's own frame stops at the through wall's face, exactly like a
  // corner butt.
  for (const tee of detectTees(walls)) {
    const h = hintFor(tee.through)
    h.backing = h.backing ?? []
    h.backing.push({ u: tee.u, heights: [0.6, 1.2, 1.8] })
    const stemHints = hintFor(tee.stem)
    // WIDTH-AWARE oblique retreat (the S5 mixed-wall formula): the stem's
    // own width w reaches (w/2)·|cosθ| past its centerline along the
    // through wall, so clearing the through face takes
    // (t + w·|cosθ|)/(2·sinθ) along the stem — plain t/2 left oblique
    // stems interpenetrating (night-board queue; 45° repro showed plates
    // and end studs still inside the through body at (t/2)/sinθ too).
    // sinθ floors at 0.2 (≈11°): shallower tees are degenerate drawings.
    const cosTheta = Math.abs(
      tee.stem.dir[0] * tee.through.dir[0] + tee.stem.dir[1] * tee.through.dir[1],
    )
    const sinTheta = Math.max(
      0.2,
      Math.abs(tee.stem.dir[0] * tee.through.dir[1] - tee.stem.dir[1] * tee.through.dir[0]),
    )
    const inset =
      (tee.through.thickness + tee.stem.thickness * cosTheta) / (2 * sinTheta)
    if (tee.stemEnd === 'start') stemHints.startInset = Math.max(stemHints.startInset ?? 0, inset)
    else stemHints.endInset = Math.max(stemHints.endInset ?? 0, inset)
  }

  return hints
}

/**
 * Frame a SET of walls with cross-wall fabrication:
 *  - California corner assembly stud in the through wall (3-stud corner),
 *  - alternating cap-plate laps (through cap extends over the butting
 *    wall's top plate; butting cap pulls short of the through wall),
 *  - partition backing (ladder blocking) at tees.
 * `overrides` (per wall id) re-sizes a wall's studs/spacing — the resolved
 * per-wall engineering from the framing config; absent = the shared spec.
 */
export function frameWalls(
  walls: WallSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
  overrides?: ReadonlyMap<string, WallFramingOverride>,
): Member[] {
  const hints = frameHints(walls, spec, overrides)
  const members: Member[] = []
  for (const wall of walls) {
    members.push(
      ...frameWall(wall, specForWall(spec, overrides?.get(wall.id)), hints.get(wall.id) ?? {}),
    )
  }
  return members
}
