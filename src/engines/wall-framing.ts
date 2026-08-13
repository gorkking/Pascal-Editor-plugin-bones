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
/** RO width beyond which each side gets a second trimmer (jack). */
const DOUBLE_TRIMMER_SPAN = feet(6)
/** Fire blocking required over 10 ft of concealed stud cavity (IRC R302.11). */
const FIRE_BLOCK_HEIGHT = feet(10)
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
 * Cross-wall fabrication hints computed by `frameWalls` for one wall.
 * All distances in meters, u measured from the wall's `start`.
 */
export type FrameHints = {
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
  const len = wall.length
  const H = wall.height

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
      flag,
    })
  }

  // ---- plates ----
  // Splice call-out: plate stock tops out at 20 ft — longer runs are built
  // from spliced sticks (min 24" lap on the double top plate, R602.3.2).
  const spliceNote =
    len > PLATE_STOCK ? ` — spliced @ ${Math.floor(len / PLATE_STOCK) * 20}ft stock, min 24" lap` : ''
  const plateDims: [number, number, number] = [len, t, w]
  emit('bottom-plate', studSize, plateDims, len / 2, t / 2, len, `Bottom plate${spliceNote}`)
  emit('top-plate', studSize, plateDims, len / 2, H - t / 2, len, `Top plate${spliceNote}`)
  if (spec.topPlateCount === 2) {
    // Cap plate: corner hints extend it over the abutting wall's top plate
    // (or pull it short so the neighbor's cap can lap over this one).
    const startDelta = hints.capStartDelta ?? 0
    const endDelta = hints.capEndDelta ?? 0
    const capLen = Math.max(0.1, len + startDelta + endDelta)
    // Start edge sits at -startDelta, end edge at len + endDelta.
    const capMid = (-startDelta + len + endDelta) / 2
    emit(
      'cap-plate',
      studSize,
      [capLen, t, w],
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

  const studDims: [number, number, number] = [t, studHeight, w]
  const halfT = t / 2

  // ---- opening frames (kings / trimmers / header / sill / cripples) ----
  type KeepOut = { min: number; max: number }
  const keepOuts: KeepOut[] = []

  for (const opening of wall.openings) {
    const ro = Math.min(opening.roughWidth, len - 4 * t)
    if (ro <= 0) continue
    // Openings past 6 ft bear on DOUBLE trimmers (jack studs) per side —
    // header reactions grow with span (R602.7.5 jack stud requirements).
    const trimmersPerSide = ro > DOUBLE_TRIMMER_SPAN ? 2 : 1
    const frameSide = trimmersPerSide * t
    const u = Math.min(Math.max(opening.u, ro / 2 + frameSide + t), len - ro / 2 - frameSide - t)
    const [roBottom, roTopRaw] = roughExtent(opening)
    const roTop = Math.min(roTopRaw, studTop - t) // leave room for the header

    // Header: bears on the trimmers, so it spans RO + trimmer packs.
    const headerSize = headerFor(spec, ro)
    const [ht, hw] = LUMBER_CROSS_SECTIONS[headerSize]
    const headerLength = ro + 2 * frameSide
    const headerDepth = Math.min(hw, studTop - roTop)
    const headerY = roTop + headerDepth / 2
    const engineered = ro > spec.engineeredHeaderSpan
    emit(
      'header',
      headerSize,
      [headerLength, headerDepth, Math.min(ht, wall.thickness)],
      u,
      headerY,
      headerLength,
      `Header ${headerSize} over ${opening.kind}`,
      engineered ? 'ENGINEERED BEAM REQUIRED — exceeds prescriptive header span' : undefined,
    )

    // Trimmers (jack studs): floor plate → header bottom, tight to the RO.
    const trimmerHeight = roTop - studBottom
    const trimmerDims: [number, number, number] = [t, trimmerHeight, w]
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
      const crippleDims: [number, number, number] = [t, crippleTopHeight, w]
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
      emit('sill', studSize, [ro, t, w], u, sillY, ro, 'Rough sill')
      const crippleBottomHeight = roBottom - t - studBottom
      if (crippleBottomHeight > t) {
        const crippleDims: [number, number, number] = [t, crippleBottomHeight, w]
        const cus = new Set<number>()
        for (const cu of studPositions(len, spec.studSpacing, halfT)) {
          if (Math.abs(cu - u) < ro / 2 - halfT) cus.add(cu)
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
  const studUs = studPositions(len, spec.studSpacing, halfT)
  for (const su of studUs) {
    if (keepOuts.some((k) => su > k.min && su < k.max)) continue
    emit('stud', studSize, studDims, su, studBottom + studHeight / 2, studHeight)
  }

  // ---- cross-wall extras (California corner backing studs) ----
  for (const extra of hints.extraStuds ?? []) {
    const eu = Math.min(Math.max(extra.u, halfT), len - halfT)
    emit('stud', studSize, studDims, eu, studBottom + studHeight / 2, studHeight, extra.label)
  }

  // ---- partition backing at tees (ladder blocking, flat 2x) ----
  for (const tee of hints.backing ?? []) {
    // A flat block spanning the stud bay around the tee: wide face out so
    // drywall on BOTH sides of the abutting partition has something to bite.
    const bay = spec.studSpacing - t
    const bu = Math.min(Math.max(tee.u, bay / 2 + t), len - bay / 2 - t)
    for (const y of tee.heights) {
      if (y > studTop - t) continue
      emit(
        'backing',
        studSize,
        [bay, t, w],
        bu,
        y,
        bay,
        'Partition backing (ladder)',
      )
    }
  }

  // ---- fire blocking (LOD 400): cap concealed cavities at 10 ft ----
  if (spec.detail === '400' && studTop > FIRE_BLOCK_HEIGHT + t) {
    const bay = spec.studSpacing - t
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
        [blockLen, t, w],
        mid,
        FIRE_BLOCK_HEIGHT,
        blockLen,
        'Fire blocking @ 10ft (R302.11)',
      )
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

type Tee = { through: WallSlice; u: number }

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
        tees.push({ through, u: proj })
      }
    }
  }
  return tees
}

/**
 * Frame a SET of walls with cross-wall fabrication:
 *  - California corner backing stud in the through wall (3-stud corner),
 *  - alternating cap-plate laps (through cap extends over the butting
 *    wall's top plate; butting cap pulls short of the through wall),
 *  - partition backing (ladder blocking) at tees.
 */
export function frameWalls(walls: WallSlice[], spec: FramingSpec = DEFAULT_SPEC): Member[] {
  const hints = new Map<string, FrameHints>()
  const hintFor = (wall: WallSlice): FrameHints => {
    let h = hints.get(wall.id)
    if (!h) {
      h = {}
      hints.set(wall.id, h)
    }
    return h
  }

  for (const corner of detectCorners(walls)) {
    const { through, butting, throughEnd, buttingEnd } = corner
    const [tt] = LUMBER_CROSS_SECTIONS[studSizeFor(through, spec)]
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
    // butting wall's cap pulls short by half the through thickness so the
    // two caps butt instead of colliding — the lap alternates by construction.
    const extend = butting.thickness / 2
    const shorten = -through.thickness / 2
    if (throughEnd === 'start') throughHints.capStartDelta = (throughHints.capStartDelta ?? 0) + extend
    else throughHints.capEndDelta = (throughHints.capEndDelta ?? 0) + extend
    const buttingHints = hintFor(butting)
    if (buttingEnd === 'start') buttingHints.capStartDelta = (buttingHints.capStartDelta ?? 0) + shorten
    else buttingHints.capEndDelta = (buttingHints.capEndDelta ?? 0) + shorten
  }

  // Partition backing at tees (skip when it duplicates a corner).
  for (const tee of detectTees(walls)) {
    const h = hintFor(tee.through)
    h.backing = h.backing ?? []
    h.backing.push({ u: tee.u, heights: [0.6, 1.2, 1.8] })
  }

  const members: Member[] = []
  for (const wall of walls) {
    members.push(...frameWall(wall, spec, hints.get(wall.id) ?? {}))
  }
  return members
}
