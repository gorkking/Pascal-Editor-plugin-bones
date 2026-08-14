/**
 * Floor framing engine — pure function: SlabSlices (+ the level's walls) +
 * FramingSpec → the platform that carries the floor:
 *
 *   joists at o.c. spacing spanning the SHORT direction, depth from the span
 *   table (IRC R502.3.1-flavored) · rim joists on every perimeter edge · a
 *   FLUSH girder + posts when the table runs out, interrupted joists hung on
 *   hangers · stairwell holes framed with doubled headers + doubled trimmer
 *   joists · sistered joists under parallel bearing walls · mid-span
 *   blocking · LOD 400 bearing validation.
 *
 * Geometry: joist rows are clipped to the slab polygon with an even-odd
 * scanline, then further split at the girder line and hole extents. The
 * platform hangs UNDER the slab walking surface: member tops at
 * (slab.elevation − slab.thickness).
 */

import { LUMBER_CROSS_SECTIONS, type LumberSize } from '../lumber'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Member, SlabSlice, WallSlice } from '../core/types'
import { feet, inches } from '../core/units'

const EPS = 1e-9
/** Ignore clipped joist segments shorter than this — unbuildable slivers. */
const MIN_SEGMENT = inches(6)
const POST_SPACING = feet(8)
/** Walls at least this long are treated as bearing (// ASSUMPTION). */
const BEARING_WALL_MIN = 1.5
/** R502.6: joists need >= 1.5in of bearing on wood. */
const BEARING_TOLERANCE = inches(1.5)

type Pt = readonly [number, number]

/** Axis-aligned bounds of a polygon. */
function bounds(polygon: readonly Pt[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const [x, z] of polygon) {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  return { minX, maxX, minZ, maxZ }
}

/** Even-odd ray-cast point-in-polygon (ray toward +X). */
function pointInPoly(p: Pt, polygon: readonly Pt[]): boolean {
  const [px, pz] = p
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i] ?? [0, 0]
    const [xj, zj] = polygon[j] ?? [0, 0]
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

/**
 * Even-odd scanline: intersect the line {across = c} with the polygon and
 * return sorted [start, end] spans along the run axis. `axis` names the RUN
 * axis of the joist: 'x' means the joist runs along X and c is a Z value.
 */
export function polygonSpans(
  polygon: readonly Pt[],
  axis: 'x' | 'z',
  c: number,
): [number, number][] {
  const crossings: number[] = []
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Pt
    const b = polygon[(i + 1) % polygon.length] as Pt
    const [runA, crossA] = axis === 'x' ? [a[0], a[1]] : [a[1], a[0]]
    const [runB, crossB] = axis === 'x' ? [b[0], b[1]] : [b[1], b[0]]
    const dCross = crossB - crossA
    if (Math.abs(dCross) < EPS) continue
    const t = (c - crossA) / dCross
    if (t >= 0 && t < 1) crossings.push(runA + t * (runB - runA))
  }
  crossings.sort((p, q) => p - q)
  const spans: [number, number][] = []
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const s = crossings[i] as number
    const e = crossings[i + 1] as number
    if (e - s > MIN_SEGMENT) spans.push([s, e])
  }
  return spans
}

/** First size whose table span carries `span`; null when the table runs out. */
export function joistSizeFor(span: number, spec: FramingSpec): LumberSize | null {
  for (const size of spec.joistSizes) {
    const allowable = spec.joistSpans[size]
    if (allowable !== undefined && span <= allowable + EPS) return size
  }
  return null
}

/** Subtract an interval from a list of spans. */
function subtractInterval(spans: [number, number][], cut: [number, number]): [number, number][] {
  const out: [number, number][] = []
  for (const [s, e] of spans) {
    if (cut[1] <= s + EPS || cut[0] >= e - EPS) {
      out.push([s, e])
      continue
    }
    if (cut[0] > s + MIN_SEGMENT) out.push([s, cut[0]])
    if (cut[1] < e - MIN_SEGMENT) out.push([cut[1], e])
  }
  return out
}

type HoleFrame = {
  /** Hole extent along the run axis (headers sit just outside this). */
  run: [number, number]
  /** Hole extent along the cross axis (trimmers sit just outside this). */
  cross: [number, number]
}

/** Frame one slab. */
function frameSlab(
  slab: SlabSlice,
  walls: WallSlice[],
  spec: FramingSpec,
  storeyBelowHeight: number,
): Member[] {
  const members: Member[] = []
  const polygon = slab.polygon
  if (polygon.length < 3) return members
  const box = bounds(polygon)
  const spanX = box.maxX - box.minX
  const spanZ = box.maxZ - box.minZ
  if (spanX < MIN_SEGMENT || spanZ < MIN_SEGMENT) return members

  // Joists SPAN the short direction; laid out along the long one.
  const runAxis: 'x' | 'z' = spanX <= spanZ ? 'x' : 'z'
  const clearSpan = Math.min(spanX, spanZ)
  const layoutLength = Math.max(spanX, spanZ)
  const layoutStart = runAxis === 'x' ? box.minZ : box.minX
  const runStart = runAxis === 'x' ? box.minX : box.minZ

  // Size from the span table; girder at mid-span when it runs out.
  let size = joistSizeFor(clearSpan, spec)
  let needsGirder = false
  if (!size) {
    needsGirder = true
    size = joistSizeFor(clearSpan / 2, spec) ?? spec.joistSizes[spec.joistSizes.length - 1] ?? '2x12'
  }
  const [t, depth] = LUMBER_CROSS_SECTIONS[size]
  const topY = slab.elevation - slab.thickness
  const centerY = topY - depth / 2

  const runYaw = runAxis === 'x' ? 0 : -Math.PI / 2
  const crossYaw = runAxis === 'x' ? -Math.PI / 2 : 0
  const placeRun = (runCenter: number, cross: number, y = centerY): [number, number, number] =>
    runAxis === 'x' ? [runCenter, y, cross] : [cross, y, runCenter]

  const emit = (
    role: Member['role'],
    memberSize: LumberSize | undefined,
    dims: [number, number, number],
    position: [number, number, number],
    yaw: number,
    length: number,
    material: Member['material'],
    label?: string,
    flag?: string,
  ) => {
    members.push({
      system: 'floor-framing',
      role,
      size: memberSize,
      dims,
      length,
      position,
      rotation: [0, yaw, 0],
      material,
      sourceId: slab.id,
      label,
      flag,
    })
  }

  // ---- girder line (flush) ----
  const [gt, gd] = LUMBER_CROSS_SECTIONS['4x10']
  const girderCross = runStart + clearSpan / 2
  const girderCut: [number, number] = [girderCross - gt / 2, girderCross + gt / 2]

  // ---- stairwell holes → framing extents ----
  // ASSUMPTION: holes are treated by their bounding box (stair openings are
  // rectangular in practice). // LOD 400+: arbitrary hole outlines.
  const holeFrames: HoleFrame[] = []
  for (const hole of slab.holes) {
    if (hole.length < 3) continue
    const hb = bounds(hole as Pt[])
    holeFrames.push({
      run: runAxis === 'x' ? [hb.minX, hb.maxX] : [hb.minZ, hb.maxZ],
      cross: runAxis === 'x' ? [hb.minZ, hb.maxZ] : [hb.minX, hb.maxX],
    })
  }

  // ---- girder PRESENCE (round-6): where along the cross axis the girder
  // actually exists — its polygon spans minus any hole straddling its line.
  // Every consumer (rows, sisters, trimmers, validator) asks this FIRST, so
  // nothing is ever cut back to a girder face where no girder runs (the
  // round-6 L-shape counterexample: wing rows floated 44.5mm off the notch
  // rim, hung on an absent girder).
  let girderPresence: [number, number][] = []
  if (needsGirder) {
    girderPresence = polygonSpans(polygon, runAxis === 'x' ? 'z' : 'x', girderCross)
    for (const hole of holeFrames) {
      if (hole.run[0] < girderCross + gt / 2 && hole.run[1] > girderCross - gt / 2) {
        girderPresence = subtractInterval(girderPresence, hole.cross)
      }
    }
  }
  const girderAt = (c: number): boolean =>
    girderPresence.some(([gs, ge]) => c >= gs - EPS && c <= ge + EPS)

  // ---- joist rows ----
  const rows: number[] = []
  for (let c = layoutStart + t / 2; c <= layoutStart + layoutLength - t / 2 + EPS; c += spec.joistSpacing) {
    rows.push(c)
  }
  const lastRow = layoutStart + layoutLength - t / 2
  if ((rows[rows.length - 1] ?? Number.NEGATIVE_INFINITY) < lastRow - t) rows.push(lastRow)

  const emitJoist = (s: number, e: number, cross: number, label?: string) => {
    const len = e - s
    if (len < MIN_SEGMENT) return
    emit('joist', size, [len, depth, t], placeRun((s + e) / 2, cross), runYaw, len, 'lumber', label)
  }

  const emitHanger = (runPos: number, cross: number, host: string) => {
    emit(
      'hanger',
      undefined,
      runAxis === 'x' ? [inches(0.75), depth, inches(3)] : [inches(3), depth, inches(0.75)],
      placeRun(runPos, cross),
      0,
      inches(3),
      'steel',
      `Joist hanger (LUS) @ ${host}`,
    )
  }

  /** Split one row's spans at holes (its cross band) then at the girder —
   * ONLY where the girder is actually present — hanging every real cut.
   * Shared by common rows, sisters, and stair trimmers so all three agree
   * (round-6: trimmers used to pass straight through the girder body, and
   * hole-band rows hung orphan girder hangers before the hole removed
   * their joists). `splitHoles` is off for trimmers — they run continuous
   * past their opening; that is their job. */
  const splitRow = (
    c: number,
    spansIn: [number, number][],
    splitHoles: boolean,
  ): [number, number][] => {
    let spans = spansIn
    if (splitHoles) {
      for (const hole of holeFrames) {
        if (c > hole.cross[0] - t / 2 && c < hole.cross[1] + t / 2) {
          const before = spans
          spans = subtractInterval(spans, hole.run)
          for (const [s, e] of before) {
            // Sliver guard: no hanger for a cut whose piece was dropped.
            if (s < hole.run[0] - MIN_SEGMENT && e > hole.run[0] + EPS)
              emitHanger(hole.run[0], c, 'stair header')
            if (e > hole.run[1] + MIN_SEGMENT && s < hole.run[1] - EPS)
              emitHanger(hole.run[1], c, 'stair header')
          }
        }
      }
    }
    if (needsGirder && girderAt(c)) {
      const before = spans
      spans = subtractInterval(spans, girderCut)
      for (const [s, e] of before) {
        if (s < girderCut[0] - MIN_SEGMENT && e > girderCut[1] + MIN_SEGMENT) {
          emitHanger(girderCut[0], c, 'girder')
          emitHanger(girderCut[1], c, 'girder')
        }
      }
    }
    return spans
  }

  for (const c of rows) {
    const spans = splitRow(c, polygonSpans(polygon, runAxis, c), true)
    for (const [s, e] of spans) emitJoist(s, e, c)
  }

  // ---- stairwell headers (doubled) + trimmer joists (doubled) ----
  // Standard stair-opening framing (R502.10): doubled headers across the
  // joist direction at both ends of the hole, carried by doubled trimmer
  // joists running alongside the opening.
  if (spec.detail !== '200') {
    const trimmerLines = new Set<string>()
    for (const hole of holeFrames) {
      const headerLen = hole.cross[1] - hole.cross[0] + 4 * t // bears on the trimmer pairs
      const headerCenterCross = (hole.cross[0] + hole.cross[1]) / 2
      for (const runEnd of [hole.run[0], hole.run[1]]) {
        for (const ply of [0, 1]) {
          const offset = (runEnd === hole.run[0] ? -1 : 1) * (t / 2 + ply * t)
          // Plies must land inside the SLAB POLYGON — the round-5 bbox
          // clamp let an L-shape push a ply into the notch (round-6).
          const plyRun = runEnd + offset
          if (plyRun < runStart + t / 2 - EPS || plyRun > runStart + clearSpan - t / 2 + EPS) {
            continue
          }
          const plyPoint: Pt =
            runAxis === 'x' ? [plyRun, headerCenterCross] : [headerCenterCross, plyRun]
          if (!pointInPoly(plyPoint, polygon)) continue
          emit(
            'header',
            size,
            runAxis === 'x' ? [inches(0.1) + t, depth, headerLen] : [headerLen, depth, inches(0.1) + t],
            placeRun(runEnd + offset, headerCenterCross),
            crossYaw,
            headerLen,
            'lumber',
            'Stair header (doubled, R502.10)',
          )
        }
      }
      for (const crossSide of [hole.cross[0], hole.cross[1]]) {
        for (const ply of [0, 1]) {
          const offset = (crossSide === hole.cross[0] ? -1 : 1) * (t / 2 + ply * t)
          const cc = crossSide + offset
          // Twin holes sharing a cross band would emit coincident plies —
          // one trimmer per line (round-6 dedupe).
          const key = cc.toFixed(6)
          if (trimmerLines.has(key)) continue
          trimmerLines.add(key)
          // Trimmers run continuous past their opening (that is their job)
          // but split at the girder like every other member (round-6: plies
          // used to pass straight through the 4x10 body).
          for (const [s, e] of splitRow(cc, polygonSpans(polygon, runAxis, cc), false)) {
            emitJoist(s, e, cc, 'Stair trimmer (doubled)')
          }
        }
      }
    }
  }

  // ---- sistered joists under parallel bearing walls ----
  // ASSUMPTION: interior walls >= 1.5m running parallel (±10°) to the joists
  // are bearing — real designs check the load path; we sister under all.
  // Each sister EXTENDS past the wall to the nearest bearing on both sides
  // (polygon edge, girder face, or stair header) — a sister clipped to the
  // wall run would end unsupported mid-span, which the LOD-400 checker
  // below rightly flags (round-2 counterexample).
  if (spec.detail !== '200') {
    const runDir: Pt = runAxis === 'x' ? [1, 0] : [0, 1]
    for (const wall of walls) {
      if (wall.length < BEARING_WALL_MIN) continue
      const dot = Math.abs(wall.dir[0] * runDir[0] + wall.dir[1] * runDir[1])
      if (dot < Math.cos((10 * Math.PI) / 180)) continue
      const wallCross =
        runAxis === 'x' ? (wall.start[1] + wall.end[1]) / 2 : (wall.start[0] + wall.end[0]) / 2
      const wallRun: [number, number] = [
        Math.min(
          runAxis === 'x' ? wall.start[0] : wall.start[1],
          runAxis === 'x' ? wall.end[0] : wall.end[1],
        ),
        Math.max(
          runAxis === 'x' ? wall.start[0] : wall.start[1],
          runAxis === 'x' ? wall.end[0] : wall.end[1],
        ),
      ]
      const sisterCross = wallCross + t // one thickness beside the wall line
      for (const [s, e] of polygonSpans(polygon, runAxis, sisterCross)) {
        if (wallRun[1] < s + EPS || wallRun[0] > e - EPS) continue // wall outside this span
        // Bearing coordinates available along this row. A stair hole's
        // headers only exist inside the hole's CROSS band — a hole elsewhere
        // in the slab is no bearing for this sister (round-3 counterexample:
        // a sister clipped to a distant hole's run coordinate hung mid-air).
        const supports = [s, e]
        if (needsGirder && girderAt(sisterCross)) supports.push(girderCut[0], girderCut[1])
        for (const hole of holeFrames) {
          if (sisterCross > hole.cross[0] - t && sisterCross < hole.cross[1] + t) {
            supports.push(hole.run[0], hole.run[1])
          }
        }
        const starts = supports.filter((u) => u <= wallRun[0] + EPS)
        const ends = supports.filter((u) => u >= wallRun[1] - EPS)
        const cs = starts.length > 0 ? Math.max(...starts) : s
        const ce = ends.length > 0 ? Math.min(...ends) : e
        // Split at the girder AND at stair holes like any row; hang the cut
        // ends. Round-4 counterexample: a bearing wall flanking a stairwell
        // put an unsplit sister straight across the opening — both ends
        // bore, so the validator was structurally blind to it.
        let sisterSpans: [number, number][] = [[cs, ce]]
        if (needsGirder) {
          if (cs < girderCut[0] - EPS && ce > girderCut[1] + EPS) {
            emitHanger(girderCut[0], sisterCross, 'girder')
            emitHanger(girderCut[1], sisterCross, 'girder')
          }
          sisterSpans = subtractInterval(sisterSpans, girderCut)
        }
        for (const hole of holeFrames) {
          // Band matches the SUPPORT band (±t) — a narrower split band left
          // a ~19 mm window where the sister clipped to the header faces
          // without hangers (round-5 finding).
          if (sisterCross > hole.cross[0] - t && sisterCross < hole.cross[1] + t) {
            const before = sisterSpans
            sisterSpans = subtractInterval(sisterSpans, hole.run)
            for (const [ss, se] of before) {
              // Hang only ends whose surviving piece is buildable — a
              // dropped sliver must not leave an orphan hanger behind.
              if (ss < hole.run[0] - MIN_SEGMENT && se > hole.run[0] + EPS) {
                emitHanger(hole.run[0], sisterCross, 'stair header')
              }
              if (se > hole.run[1] + MIN_SEGMENT && ss < hole.run[1] - EPS) {
                emitHanger(hole.run[1], sisterCross, 'stair header')
              }
            }
          }
        }
        for (const [ss, se] of sisterSpans) {
          if (se - ss > MIN_SEGMENT) {
            emitJoist(ss, se, sisterCross, `Sistered joist under bearing wall ${wall.id}`)
          }
        }
      }
    }
  }

  // ---- rim joists around the perimeter ----
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as Pt
    const b = polygon[(i + 1) % polygon.length] as Pt
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const len = Math.hypot(dx, dz)
    if (len < MIN_SEGMENT) continue
    const yaw = Math.atan2(-dz, dx)
    emit(
      'rim-joist',
      size,
      [len, depth, t],
      [a[0] + dx / 2, centerY, a[1] + dz / 2],
      yaw,
      len,
      'lumber',
      `Rim joist ${size}`,
    )
  }

  // ---- flush girder + posts ----
  if (needsGirder) {
    // Presence already carved holes out (round-5 blocker); hang the cut
    // ends that face a stair opening on the stair trimmers.
    for (const hole of holeFrames) {
      if (hole.run[0] < girderCross + gt / 2 && hole.run[1] > girderCross - gt / 2) {
        for (const [s, e] of girderPresence) {
          if (Math.abs(e - hole.cross[0]) < EPS * 10 && e - s > MIN_SEGMENT) {
            emitHanger(girderCross, hole.cross[0], 'stair trimmers (girder)')
          }
          if (Math.abs(s - hole.cross[1]) < EPS * 10 && e - s > MIN_SEGMENT) {
            emitHanger(girderCross, hole.cross[1], 'stair trimmers (girder)')
          }
        }
      }
    }
    for (const [s, e] of girderPresence) {
      const len = e - s
      // FLUSH: girder top aligns with joist tops; interrupted joists hang on
      // its faces (hangers emitted with the rows above).
      const girderCenterY = topY - gd / 2
      emit(
        'girder',
        '4x10',
        runAxis === 'x' ? [gt, gd, len] : [len, gd, gt],
        placeRun(girderCross, (s + e) / 2, girderCenterY),
        crossYaw,
        len,
        'engineered',
        'Girder 4x10 (flush, joists hung)',
        'Girder sized schematically — verify with span/load design',
      )
      const [pt, pw] = LUMBER_CROSS_SECTIONS['4x4']
      for (let p = s + POST_SPACING / 2; p < e; p += POST_SPACING) {
        emit(
          'post',
          '4x4',
          [pt, storeyBelowHeight, pw],
          placeRun(girderCross, p, girderCenterY - gd / 2 - storeyBelowHeight / 2),
          0,
          storeyBelowHeight,
          'lumber',
          'Post 4x4 (to storey below)',
        )
      }
    }
  }

  // ---- one row of mid-span blocking between adjacent joist rows ----
  // With a girder, the mid-span line IS the girder line — blocking there
  // would sit embedded inside the 4x10 body (round-6 finding); the girder
  // itself provides the lateral restraint blocking exists for.
  const blockLen = spec.joistSpacing - t
  if (blockLen > inches(3) && !needsGirder) {
    const mid = runStart + clearSpan / 2
    for (let i = 0; i + 1 < rows.length; i++) {
      const cross = ((rows[i] as number) + (rows[i + 1] as number)) / 2
      const inside = polygonSpans(polygon, runAxis, cross).some(([s, e]) => mid > s && mid < e)
      if (!inside) continue
      // Skip blocking that would land inside a stairwell hole.
      const inHole = holeFrames.some(
        (h) => cross > h.cross[0] && cross < h.cross[1] && mid > h.run[0] && mid < h.run[1],
      )
      if (inHole) continue
      emit(
        'blocking',
        size,
        [blockLen, depth, t],
        placeRun(mid, cross),
        runYaw + Math.PI / 2,
        blockLen,
        'lumber',
        'Blocking',
      )
    }
  }

  // ---- LOD 400: bearing validation ----
  if (spec.detail === '400') {
    const bearings: BearingLine[] = []
    for (const [gs, ge] of girderPresence) {
      // The girder only bears where it EXISTS (round-6: wing rows cut at an
      // absent girder passed silently with extent-less bearing lines).
      bearings.push({ u: girderCut[0], cross: [gs, ge] }, { u: girderCut[1], cross: [gs, ge] })
    }
    for (const hole of holeFrames) {
      bearings.push({ u: hole.run[0], cross: hole.cross }, { u: hole.run[1], cross: hole.cross })
    }
    validateJoistBearing(members, polygon, runAxis, bearings, holeFrames)
  }

  return members
}

/**
 * A bearing line along the run axis. Stair-header bearings only exist
 * inside the hole's cross band (`cross`); girder faces bear everywhere.
 */
export type BearingLine = { u: number; cross?: readonly [number, number] }

/**
 * LOD 400 bearing checker (R502.6): every joist end must land on a bearing
 * structure — a polygon edge (rim), a girder face, or a stair-header face
 * WITHIN the hole's cross band — within 1.5" tolerance; anything else gets
 * flagged. Exported so the flag path itself stays testable with an injected
 * bad joist (a checker whose only test asserts silence is no checker at all
 * — round-2 finding; the cross-band condition is the round-3 finding).
 */
export function validateJoistBearing(
  members: Member[],
  polygon: readonly (readonly [number, number])[],
  runAxis: 'x' | 'z',
  bearings: BearingLine[],
  holes: { run: readonly [number, number]; cross: readonly [number, number] }[] = [],
): void {
  for (const m of members) {
    if (m.role !== 'joist') continue
    const half = m.dims[0] / 2
    const center = runAxis === 'x' ? (m.position[0] as number) : (m.position[2] as number)
    const cross = runAxis === 'x' ? (m.position[2] as number) : (m.position[0] as number)
    for (const end of [center - half, center + half]) {
      const onPolygon = polygonSpans(polygon, runAxis, cross).some(
        ([s, e]) => Math.abs(end - s) < BEARING_TOLERANCE || Math.abs(end - e) < BEARING_TOLERANCE,
      )
      const onStructure = bearings.some(
        (b) =>
          Math.abs(end - b.u) < BEARING_TOLERANCE + inches(0.1) &&
          (b.cross === undefined ||
            (cross > b.cross[0] - BEARING_TOLERANCE && cross < b.cross[1] + BEARING_TOLERANCE)),
      )
      if (!onPolygon && !onStructure) {
        m.flag = `Unsupported joist end @ ${end.toFixed(2)}m — needs bearing (R502.6)`
      }
    }
    // A joist BODY may never intrude into a floor opening — well-supported
    // ends do not excuse spanning (or poking into) the stairwell. Round-4
    // pinned the full-crossing case; round-5 showed a PARTIAL overlap (one
    // end at a header face, body over the opening) slipped through — the
    // check is now intrusion-based, tolerating only the 1.5" bearing seat.
    for (const hole of holes) {
      const inBand = cross > hole.cross[0] + BEARING_TOLERANCE && cross < hole.cross[1] - BEARING_TOLERANCE
      const intrusion =
        Math.min(center + half, hole.run[1] - BEARING_TOLERANCE) -
        Math.max(center - half, hole.run[0] + BEARING_TOLERANCE)
      if (inBand && intrusion > inches(0.5)) {
        m.flag = `Joist crosses a floor opening @ ${hole.run[0].toFixed(2)}–${hole.run[1].toFixed(2)}m — split and hang on headers (R502.10)`
      }
    }
  }

  // Girders run PERPENDICULAR to the joists — same opening rule, axes
  // swapped: the girder's line must not pass through a hole's run extent
  // while its body overlaps the hole's cross extent (round-5 blocker).
  for (const m of members) {
    if (m.role !== 'girder') continue
    const half = m.length / 2
    const center = runAxis === 'x' ? (m.position[2] as number) : (m.position[0] as number)
    const line = runAxis === 'x' ? (m.position[0] as number) : (m.position[2] as number)
    for (const hole of holes) {
      const lineInHole = line > hole.run[0] + BEARING_TOLERANCE && line < hole.run[1] - BEARING_TOLERANCE
      const intrusion =
        Math.min(center + half, hole.cross[1] - BEARING_TOLERANCE) -
        Math.max(center - half, hole.cross[0] + BEARING_TOLERANCE)
      if (lineInHole && intrusion > inches(0.5)) {
        m.flag = `Girder crosses a floor opening @ ${hole.cross[0].toFixed(2)}–${hole.cross[1].toFixed(2)}m — interrupt at the stair framing (R502.10)`
      }
    }
  }
}

/**
 * Frame every slab on a level. `walls` sister joists under parallel bearing
 * partitions; `storeyBelowHeight` sizes the girder posts.
 */
export function frameFloor(
  slabs: SlabSlice[],
  walls: WallSlice[] = [],
  spec: FramingSpec = DEFAULT_SPEC,
  storeyBelowHeight = 2.4,
): Member[] {
  const members: Member[] = []
  for (const slab of slabs) {
    members.push(...frameSlab(slab, walls, spec, storeyBelowHeight))
  }
  return members
}
