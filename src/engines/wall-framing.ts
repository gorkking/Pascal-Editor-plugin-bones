/**
 * Wall framing engine — the heart of Bones. Pure function: one WallSlice +
 * FramingSpec → the US platform-framing member set for that wall:
 *
 *   bottom plate · top plate(s) · common studs at o.c. spacing · and per
 *   opening: king studs, trimmers (jacks), header (sized by span), sill,
 *   cripples above headers and below sills.
 *
 * Geometry convention: the wall frame has X along the wall (from `start`),
 * Y up, Z across the thickness. Every member is an axis-aligned box in that
 * frame — verticals are just taller-than-wide boxes — so the whole wall
 * shares one Y rotation (`yaw`) when mapped into level space.
 */

import { LUMBER_CROSS_SECTIONS, type LumberSize } from '../lumber'
import { DEFAULT_SPEC, type FramingSpec, headerFor } from '../core/spec'
import type { Member, OpeningSlice, WallSlice } from '../core/types'

const EPS = 1e-6

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
export function frameWall(wall: WallSlice, spec: FramingSpec = DEFAULT_SPEC): Member[] {
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
  const plateDims: [number, number, number] = [len, t, w]
  emit('bottom-plate', studSize, plateDims, len / 2, t / 2, len)
  for (let i = 0; i < spec.topPlateCount; i++) {
    emit(i === 0 ? 'top-plate' : 'cap-plate', studSize, plateDims, len / 2, H - t / 2 - i * t, len)
  }

  const studBottom = t
  const studTop = H - t * spec.topPlateCount
  const studHeight = studTop - studBottom
  if (studHeight <= t) return members // degenerate pony wall — plates only

  const studDims: [number, number, number] = [t, studHeight, w]
  const halfT = t / 2

  // ---- opening frames (kings / trimmers / header / sill / cripples) ----
  // Collect keep-out intervals so common studs skip framed openings.
  type KeepOut = { min: number; max: number }
  const keepOuts: KeepOut[] = []

  for (const opening of wall.openings) {
    const ro = Math.min(opening.roughWidth, len - 4 * t)
    if (ro <= 0) continue
    const u = Math.min(Math.max(opening.u, ro / 2 + 2 * t), len - ro / 2 - 2 * t)
    const [roBottom, roTopRaw] = roughExtent(opening)
    const roTop = Math.min(roTopRaw, studTop - t) // leave room for the header

    // Header: bears on the trimmers, so it spans RO + both trimmer widths.
    const headerSize = headerFor(spec, ro)
    const [ht, hw] = LUMBER_CROSS_SECTIONS[headerSize] // ht = header thickness (3.5"), hw = depth
    const headerLength = ro + 2 * t
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
      emit(
        'trimmer',
        studSize,
        trimmerDims,
        u + side * (ro / 2 + halfT),
        studBottom + trimmerHeight / 2,
        trimmerHeight,
      )
    }

    // King studs: full height, outside the trimmers.
    for (const side of [-1, 1] as const) {
      emit(
        'king-stud',
        studSize,
        studDims,
        u + side * (ro / 2 + t + halfT),
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
        // Always support the sill ends.
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

    // Common studs stay clear of the full opening frame (kings included).
    keepOuts.push({ min: u - ro / 2 - 2 * t + EPS, max: u + ro / 2 + 2 * t - EPS })
  }

  // ---- common studs at o.c. spacing (ends always get a stud) ----
  for (const su of studPositions(len, spec.studSpacing, halfT)) {
    if (keepOuts.some((k) => su > k.min && su < k.max)) continue
    emit('stud', studSize, studDims, su, studBottom + studHeight / 2, studHeight)
  }

  return members
}

/**
 * Common-stud center positions along a wall: layout on o.c. centers from the
 * wall start, clamped inside the wall, with a guaranteed end stud.
 */
export function studPositions(length: number, spacing: number, halfT: number): number[] {
  const out: number[] = []
  const endU = length - halfT
  for (let u = halfT; u < endU - EPS; u += spacing) out.push(u)
  out.push(endU)
  // Drop a grid stud that landed within one stud thickness of the end stud.
  return out.filter((u, i, all) => i === all.length - 1 || (all[i + 1] ?? 0) - u > 2 * halfT - EPS)
}

/** Frame every wall on a level. */
export function frameWalls(walls: WallSlice[], spec: FramingSpec = DEFAULT_SPEC): Member[] {
  const members: Member[] = []
  for (const wall of walls) {
    members.push(...frameWall(wall, spec))
  }
  return members
}
