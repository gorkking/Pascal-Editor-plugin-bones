/**
 * Floor framing engine — pure function: SlabSlices + FramingSpec → the
 * platform that carries the floor:
 *
 *   joists at o.c. spacing spanning the SHORT direction, depth picked from
 *   the span table (IRC R502.3.1-flavored, SPF #2 40/10 L/360 values in
 *   spec.joistSpans) · rim joists around the perimeter · a dropped girder +
 *   posts when the span table runs out · one row of mid-span blocking.
 *
 * Geometry: joists are clipped to the slab polygon with a scanline — each
 * joist line is intersected with the polygon edges and laid in the resulting
 * even-odd segments, so L-shaped floors and notches frame correctly.
 * Vertical placement hangs the platform UNDER the slab's walking surface:
 * joist tops at (slab.elevation − slab.thickness).
 */

import { LUMBER_CROSS_SECTIONS, type LumberSize } from '../lumber'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Member, SlabSlice, WallSlice } from '../core/types'
import { feet, inches } from '../core/units'

const EPS = 1e-9
/** Ignore clipped joist segments shorter than this — unbuildable slivers. */
const MIN_SEGMENT = inches(6)
/** Posts under a dropped girder land in the storey below; modeled at a
 * schematic fixed height. // LOD 400: read the real storey height below. */
const POST_HEIGHT = 2.4
const POST_SPACING = feet(8)

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
    // Coordinates: run = along the joist, cross = the scan position.
    const [runA, crossA] = axis === 'x' ? [a[0], a[1]] : [a[1], a[0]]
    const [runB, crossB] = axis === 'x' ? [b[0], b[1]] : [b[1], b[0]]
    const dCross = crossB - crossA
    if (Math.abs(dCross) < EPS) continue // edge parallel to the scan line
    const t = (c - crossA) / dCross
    // Half-open [0,1) so a scan through a vertex counts one crossing, not two.
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

/** Frame one slab. */
function frameSlab(slab: SlabSlice, spec: FramingSpec): Member[] {
  const members: Member[] = []
  const polygon = slab.polygon
  if (polygon.length < 3) return members
  const box = bounds(polygon)
  const spanX = box.maxX - box.minX
  const spanZ = box.maxZ - box.minZ
  if (spanX < MIN_SEGMENT || spanZ < MIN_SEGMENT) return members

  // Joists SPAN the short direction (shorter sticks, stiffer floor) and are
  // laid out along the long one — standard platform practice.
  const runAxis: 'x' | 'z' = spanX <= spanZ ? 'x' : 'z'
  const clearSpan = Math.min(spanX, spanZ)
  const layoutLength = Math.max(spanX, spanZ)
  const layoutStart = runAxis === 'x' ? box.minZ : box.minX

  // Size from the span table. When even the deepest joist can't make it,
  // drop a girder at mid-span (halving the joist span) and re-pick.
  // ASSUMPTION: one uniform joist depth per slab — crews order one depth.
  let size = joistSizeFor(clearSpan, spec)
  let needsGirder = false
  if (!size) {
    needsGirder = true
    size = joistSizeFor(clearSpan / 2, spec) ?? spec.joistSizes[spec.joistSizes.length - 1] ?? '2x12'
  }
  const [t, depth] = LUMBER_CROSS_SECTIONS[size]
  const topY = slab.elevation - slab.thickness
  const centerY = topY - depth / 2

  // Yaw: joists along X need no rotation; along Z rotate the +X box onto +Z.
  const runYaw = runAxis === 'x' ? 0 : -Math.PI / 2
  const placeRun = (runCenter: number, cross: number): [number, number, number] =>
    runAxis === 'x' ? [runCenter, centerY, cross] : [cross, centerY, runCenter]

  // ---- joists (polygon-clipped rows) ----
  // Rows at o.c. spacing, inset half a joist at both extremes so end rows
  // double as rim backing. // LOD 400: holes in `slab.holes` (stairwells)
  // should split rows with headers + doubled trimmers around the opening.
  const rows: number[] = []
  for (let c = layoutStart + t / 2; c <= layoutStart + layoutLength - t / 2 + EPS; c += spec.joistSpacing) {
    rows.push(c)
  }
  const lastRow = layoutStart + layoutLength - t / 2
  if ((rows[rows.length - 1] ?? Number.NEGATIVE_INFINITY) < lastRow - t) rows.push(lastRow)

  const spanMids: [number, number][] = []
  for (const c of rows) {
    for (const [s, e] of polygonSpans(polygon, runAxis, c)) {
      const len = e - s
      members.push({
        system: 'floor-framing',
        role: 'joist',
        size,
        dims: [len, depth, t],
        length: len,
        position: placeRun((s + e) / 2, c),
        rotation: [0, runYaw, 0],
        material: 'lumber',
        sourceId: slab.id,
        label: needsGirder ? `Joist ${size} (girder-assisted span)` : `Joist ${size}`,
      })
      spanMids.push([(s + e) / 2, c])
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
    members.push({
      system: 'floor-framing',
      role: 'rim-joist',
      size,
      dims: [len, depth, t],
      length: len,
      position: [a[0] + dx / 2, centerY, a[1] + dz / 2],
      rotation: [0, yaw, 0],
      material: 'lumber',
      sourceId: slab.id,
      label: `Rim joist ${size}`,
    })
  }

  // ---- girder + posts when the table ran out ----
  if (needsGirder) {
    const girderCross = clearSpan / 2 + (runAxis === 'x' ? box.minX : box.minZ)
    // The girder runs PERPENDICULAR to the joists, under their mid-span.
    const girderSpans = polygonSpans(polygon, runAxis === 'x' ? 'z' : 'x', girderCross)
    const [gt, gd] = LUMBER_CROSS_SECTIONS['4x10']
    const girderYaw = runAxis === 'x' ? -Math.PI / 2 : 0
    for (const [s, e] of girderSpans) {
      const len = e - s
      const girderCenterY = topY - depth - gd / 2 // dropped under the joists
      members.push({
        system: 'floor-framing',
        role: 'girder',
        size: '4x10',
        dims: [len, gd, gt],
        length: len,
        position:
          runAxis === 'x' ? [girderCross, girderCenterY, (s + e) / 2] : [(s + e) / 2, girderCenterY, girderCross],
        rotation: [0, girderYaw, 0],
        material: 'engineered',
        sourceId: slab.id,
        label: 'Girder 4x10 @ mid-span',
        flag: 'Girder sized schematically — verify with span/load design',
      })
      // Posts every 8 ft under the girder, descending to the storey below.
      const [pt, pw] = LUMBER_CROSS_SECTIONS['4x4']
      for (let p = s + POST_SPACING / 2; p < e; p += POST_SPACING) {
        members.push({
          system: 'floor-framing',
          role: 'post',
          size: '4x4',
          dims: [pt, POST_HEIGHT, pw],
          length: POST_HEIGHT,
          position:
            runAxis === 'x'
              ? [girderCross, girderCenterY - gd / 2 - POST_HEIGHT / 2, p]
              : [p, girderCenterY - gd / 2 - POST_HEIGHT / 2, girderCross],
          rotation: [0, 0, 0],
          material: 'lumber',
          sourceId: slab.id,
          label: 'Post 4x4 (to storey below, schematic)',
        })
      }
    }
  }

  // ---- one row of mid-span blocking between adjacent joist rows ----
  // IRC R502.7-flavored lateral restraint; visually reads as the classic
  // staggered blocking line. Blocks bridge the o.c. gap minus one joist.
  const blockLen = spec.joistSpacing - t
  if (blockLen > inches(3)) {
    const mid = (runAxis === 'x' ? box.minX : box.minZ) + clearSpan / 2
    for (let i = 0; i + 1 < rows.length; i++) {
      const cross = ((rows[i] as number) + (rows[i + 1] as number)) / 2
      // Only block where the slab actually spans the midline.
      const inside = polygonSpans(polygon, runAxis, cross).some(([s, e]) => mid > s && mid < e)
      if (!inside) continue
      members.push({
        system: 'floor-framing',
        role: 'blocking',
        size,
        dims: [blockLen, depth, t],
        length: blockLen,
        position: placeRun(mid, cross),
        // Blocking runs ACROSS the joists (same direction as the layout axis).
        rotation: [0, runYaw + Math.PI / 2, 0],
        material: 'lumber',
        sourceId: slab.id,
        label: 'Blocking',
      })
    }
  }

  return members
}

/**
 * Frame every slab on a level. `walls` are the level's walls (for doubled
 * joists under parallel bearing partitions — LOD 350) and
 * `storeyBelowHeight` is the storey the girder posts descend into.
 */
export function frameFloor(
  slabs: SlabSlice[],
  _walls: WallSlice[] = [],
  spec: FramingSpec = DEFAULT_SPEC,
  _storeyBelowHeight: number = POST_HEIGHT,
): Member[] {
  const members: Member[] = []
  for (const slab of slabs) {
    members.push(...frameSlab(slab, spec))
  }
  return members
}
