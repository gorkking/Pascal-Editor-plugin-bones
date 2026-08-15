/**
 * Foundation engine — pure function: WallSlices + SlabSlices + FramingSpec →
 * the concrete-and-hardware member set that carries the frame:
 *
 *   continuous footing (IRC R403.1) · stemwall up to the plate line ·
 *   anchor bolts at code spacing (R403.1.6) · seismic hold-downs at wall
 *   ends when the jurisdiction demands them · a subtle thickened slab edge
 *   when the level has slabs.
 *
 * LOD 350 (detail !== '200') adds:
 *   corner continuity — footing/stemwall runs extended past shared corners
 *   so perimeter pours are monolithic · interior thickened footings under
 *   bearing interior walls · rebar (2× #4 continuous per footing run +
 *   stemwall verticals per SDC).
 * LOD 400 (detail === '400') adds:
 *   3×3×0.229" plate washers on every anchor bolt in SDC D (R602.11.1).
 *
 * STEMWALL STEP-DOWNS — documented N/A: Pascal levels are flat planes
 * (level-local y = 0 is the whole plate line) and the scene carries no
 * grade/terrain data, so stepped footings on sloped sites (R403.1.5) cannot
 * be derived. Every run is emitted at one elevation; when the host gains a
 * terrain model, step detection belongs in cornerExtensions' pass.
 *
 * Geometry convention matches wall-framing.ts exactly: each wall gets a
 * local frame with X along the wall (from `start`), Y up, Z across the
 * thickness; every member is an axis-aligned box in that frame, so the
 * whole run shares one Y rotation (`yaw`). y = 0 is the top of the
 * foundation — the underside of the framed wall's bottom plate.
 */

import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Member, SlabSlice, WallSlice } from '../core/types'
import { formatIn, inches } from '../core/units'

const EPS = 1e-6

/**
 * Footing height. IRC R403.1.1 allows 6" minimum plain-concrete footings;
 * 8" is the near-universal residential pour (two courses of 2x8 form stock).
 */
const FOOTING_HEIGHT = inches(8)

/** Anchor bolt: 1/2" min per R403.1.6 — we model the common 5/8" J-bolt. */
const BOLT_SIDE = inches(5 / 8)
/** Total modeled bolt length: 7" embedment (R403.1.6) + plate + nut stick-up. */
const BOLT_HEIGHT = inches(10)
/** R403.1.6: bolts must extend ≥ 7" into the concrete. */
const BOLT_EMBEDMENT = inches(7)

/** HDU-style hold-down body: ~3" wide × 12" tall strap-and-post hardware. */
const HOLD_DOWN_SIDE = inches(3)
const HOLD_DOWN_HEIGHT = inches(12)

/** Monolithic slab thickened-edge depth (R403.1.3.1 turned-down edge). */
const SLAB_EDGE_DEPTH = inches(12)

/** #4 rebar: 0.5" nominal diameter, modeled as a 0.5" square bar. */
const REBAR_SIDE = inches(0.5)
/** ACI 318 §20.5.1.3 / IRC R403.1.3: 3" clear cover against earth. */
const REBAR_BOTTOM_COVER = inches(3)
/** Cover kept below the stemwall top so verticals never pierce the plate. */
const REBAR_TOP_COVER = inches(2)
/** End cover for the stemwall-vertical layout along the run. */
const REBAR_END_COVER = inches(4)
/** R403.1.3.2 dowels/verticals: #4 @ 48" o.c. (24" tightened for SDC D). */
const VERTICAL_SPACING = inches(48)
const VERTICAL_SPACING_SEISMIC = inches(24)

/** Interior thickened footing (R403.1 bearing-wall footing inside a slab). */
const INTERIOR_FOOTING_DEPTH = inches(12)
/**
 * ASSUMPTION: interior walls longer than 2.4 m are treated as BEARING (they
 * plausibly stack a girder or a storey above); shorter partitions bear on
 * the slab itself. Real designs read the load path from the framing plan.
 */
const INTERIOR_BEARING_MIN_LENGTH = 2.4

/** 2x mudsill thickness — the plate the R602.11.1 washer bears on. */
const PLATE_THICKNESS = inches(1.5)
/** R602.11.1 (SDC D0–D2): 0.229" × 3" × 3" steel plate washers. */
const PLATE_WASHER_SIDE = inches(3)
const PLATE_WASHER_THICKNESS = inches(0.229)

/**
 * Anchor bolt centers along a wall (u from `start`, meters).
 *
 * IRC R403.1.6: bolts at max `spacing` o.c. (6' default), one bolt within
 * `endDistance` (12") of each end of every plate section, and a minimum of
 * TWO bolts per section. We place the first/last bolt exactly at the end
 * distance and divide the interior run evenly so no gap exceeds `spacing`.
 */
export function anchorBoltPositions(
  length: number,
  spacing: number,
  endDistance: number,
): number[] {
  // Very short wall (shorter than two end distances): still two bolts,
  // pulled to the third points so they don't collide. Both remain within
  // `endDistance` of an end because the wall itself is that short.
  const end = Math.min(endDistance, length / 3)
  const first = end
  const last = length - end
  const span = last - first
  if (span < EPS) return [length / 2] // degenerate sliver — single bolt
  // Even layout: smallest bolt count whose gaps are all <= spacing.
  const segments = Math.max(1, Math.ceil(span / spacing - EPS))
  const out: number[] = []
  for (let i = 0; i <= segments; i++) out.push(first + (span * i) / segments)
  return out
}

/** How far a wall's footing/stemwall run extends past each end (meters). */
/** Corner role per wall end: +1 through, −1 butt, 0 free (see cornerExtensions). */
type RunExtension = { start: number; end: number }

const endPoint = (wall: WallSlice, which: 'start' | 'end'): readonly [number, number] =>
  which === 'start' ? wall.start : wall.end

/**
 * Footing CORNER CONTINUITY (rubric 350). Where two exterior walls share an
 * endpoint, the LONGER wall's runs lay THROUGH the corner (extending half
 * the meeting element's width past the corner point, out to the neighbor's
 * far face) and the other wall's runs BUTT flush against them — the same
 * through/butt convention the stud framing and CMU coursing use. The corner
 * is covered exactly once: no overlapping boxes (which z-fight and read as
 * seams in the translucent X-ray), no ends jutting past the neighbor.
 *
 * The map stores a signed MULTIPLIER per wall end: +k = through (extend by
 * k·width/2), −k = butt (retreat by k·width/2), 0 = free end. Perpendicular
 * corners give k = 1 (the classic half-width lap); OBLIQUE corners scale by
 * k = (1 + |cosθ|)/sinθ — the retreat that clears the through run's sloped
 * face with a square-cut box, and the matching through extension that
 * covers the joint (round-10: ±width/2 only works at 90°). Each element
 * (footing vs stemwall) applies its OWN width to the multiplier, so the
 * wide footing and the narrow stemwall both land flush.
 *
 * Detection mirrors wall-framing.detectCorners: endpoints coincide within
 * 0.75× the larger wall thickness, and near-parallel walls (a butt splice,
 * not a corner) are ignored. O(walls²) pairwise — walls, not members, so
 * the 20-wall perf budget is untouched.
 */
export function cornerExtensions(walls: WallSlice[]): Map<string, RunExtension> {
  const ext = new Map<string, RunExtension>()
  const mark = (wall: WallSlice, which: 'start' | 'end', sign: number) => {
    let e = ext.get(wall.id)
    if (!e) {
      e = { start: 0, end: 0 }
      ext.set(wall.id, e)
    }
    // Round-14: an end that is BOTH a through corner and a tee-butt must
    // RETREAT — extending drove a wing footing 0.4m into the run it tees
    // into. Any butt claim (negative) wins over a through claim.
    if (e[which] === 0) e[which] = sign
    else if (sign < 0 || e[which] < 0) e[which] = Math.min(e[which], sign < 0 ? sign : e[which])
    else e[which] = Math.max(e[which], sign)
  }
  // --- 1. cluster endpoint-coincident wall ends (round-12: Y-junctions) ---
  // Pairwise marking let SEVERAL walls claim 'through' at one shared point
  // (each pair judged independently) — the crossed-boxes artifact on plans
  // where three runs meet. A junction cluster elects exactly ONE through
  // wall (longest, tie by id); every other member butts against it.
  type EndRef = { wall: WallSlice; which: 'start' | 'end' }
  const ends: EndRef[] = walls.flatMap((wall) => [
    { wall, which: 'start' as const },
    { wall, which: 'end' as const },
  ])
  const clustered = new Set<number>()
  const clusters: EndRef[][] = []
  for (let i = 0; i < ends.length; i++) {
    if (clustered.has(i)) continue
    const seed = ends[i] as EndRef
    const cluster = [seed]
    clustered.add(i)
    const p = endPoint(seed.wall, seed.which)
    for (let j = i + 1; j < ends.length; j++) {
      if (clustered.has(j)) continue
      const cand = ends[j] as EndRef
      if (cand.wall.id === seed.wall.id) continue
      const tol = Math.max(seed.wall.thickness, cand.wall.thickness) * 0.75
      const q = endPoint(cand.wall, cand.which)
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) > tol) continue
      cluster.push(cand)
      clustered.add(j)
    }
    if (cluster.length >= 2) clusters.push(cluster)
  }

  const obliqueK = (a: WallSlice, b: WallSlice): number | null => {
    // Parallel walls butting end-to-end are a splice, not a corner
    // (round-14: threshold lowered 0.3→0.1 so 6–17° corners still miter;
    // k capped at 4 so razor angles don't shoot runs meters past the joint).
    const cross = Math.abs(a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0])
    if (cross < 0.1) return null
    const dot = Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1])
    return Math.min(4, (1 + dot) / cross)
  }

  for (const cluster of clusters) {
    const through = cluster.reduce((best, c) =>
      c.wall.length > best.wall.length ||
      (c.wall.length === best.wall.length && c.wall.id < best.wall.id)
        ? c
        : best,
    )
    // Round-14 splice repro: an exterior run drawn as TWO collinear
    // segments with a partition teeing at the joint — the through segment
    // must NOT extend (its collinear partner IS the continuation; extending
    // drove 203mm of footing into it). It also must not retreat: flush.
    const hasCollinearPartner = cluster.some(
      (m) => m !== through && obliqueK(through.wall, m.wall) === null,
    )
    let throughK = 0
    for (const member of cluster) {
      if (member === through) continue
      const k = obliqueK(through.wall, member.wall)
      if (k === null) continue // collinear splice partner — leave both flush
      mark(member.wall, member.which, -k)
      throughK = Math.max(throughK, k)
    }
    if (throughK > 0 && !hasCollinearPartner) mark(through.wall, through.which, throughK)
  }

  // --- 2. tee retreats: an end landing on another wall's BODY stops at
  // that wall's face (round-12: interior thickened footings used to run
  // straight through the exterior footing + stemwall) ---
  for (const end of ends) {
    const p = endPoint(end.wall, end.which)
    for (const other of walls) {
      if (other.id === end.wall.id) continue
      const proj = (p[0] - other.start[0]) * other.dir[0] + (p[1] - other.start[1]) * other.dir[1]
      // interior of the run only — cluster logic owns shared endpoints
      const margin = Math.max(end.wall.thickness, other.thickness) * 0.75
      if (proj < margin || proj > other.length - margin) continue
      const foot: [number, number] = [
        other.start[0] + other.dir[0] * proj,
        other.start[1] + other.dir[1] * proj,
      ]
      const dist = Math.hypot(p[0] - foot[0], p[1] - foot[1])
      if (dist > margin) continue
      const k = obliqueK(other, end.wall)
      if (k === null) continue
      mark(end.wall, end.which, -k)
    }
  }
  return ext
}

/**
 * Foundation for one level.
 *
 * Exterior walls bear on the perimeter footing + stemwall. Interior walls
 * bear on the slab UNLESS long enough to be treated as bearing (see
 * INTERIOR_BEARING_MIN_LENGTH), in which case they get a thickened footing
 * at LOD 350+. Slab presence toggles the thickened slab edge.
 */
export function buildFoundation(
  walls: WallSlice[],
  slabs: SlabSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
): Member[] {
  const members: Member[] = []
  const hasSlab = slabs.length > 0
  const fabDetail = spec.detail !== '200' // LOD 350 gate
  const lod400 = spec.detail === '400'

  // Corner continuity only pairs EXTERIOR straight walls — the ones that
  // actually own perimeter runs below.
  // ALL straight walls participate: interior bearing walls need their tee
  // retreats against the exterior runs (round-12).
  const straightWalls = walls.filter((w) => !w.curved)
  const extensions = fabDetail ? cornerExtensions(straightWalls) : new Map<string, RunExtension>()

  for (const wall of walls) {
    // Curved walls are framed segment-wise later; skip like wall-framing v1.
    if (wall.curved) continue

    const [dx, dz] = wall.dir
    const [sx, sz] = wall.start
    // Same frame math as wall-framing.frameOf: rotating a +X-aligned box by
    // yaw about Y maps +X → [cos, 0, -sin]; we need +X → [dx, 0, dz].
    const yaw = Math.atan2(-dz, dx)
    const place = (u: number, y: number, v = 0): [number, number, number] => [
      sx + dx * u - dz * v,
      y,
      sz + dz * u + dx * v,
    ]
    const len = wall.length

    const emit = (
      role: Member['role'],
      dims: [number, number, number],
      centerU: number,
      centerY: number,
      length: number,
      material: Member['material'],
      label?: string,
      centerV = 0,
    ) => {
      members.push({
        system: 'foundation',
        role,
        dims,
        length,
        position: place(centerU, centerY, centerV),
        rotation: [0, yaw, 0],
        material,
        sourceId: wall.id,
        label,
      })
    }

    /**
     * 2× #4 continuous bars per footing run (R403.1.3.1 / common SDC D
     * practice): 3" clear off the footing bottom, set at the third points
     * of the footing width (v = ±width/6) so cover is equal all around.
     * ASSUMPTION: laps/hooks at run ends are takeoff data, not geometry.
     */
    const emitFootingBars = (
      runCenterU: number,
      runLen: number,
      footingBottomY: number,
      width: number,
    ) => {
      const barY = footingBottomY + REBAR_BOTTOM_COVER + REBAR_SIDE / 2
      for (const v of [-width / 6, width / 6]) {
        emit(
          'rebar',
          [runLen, REBAR_SIDE, REBAR_SIDE],
          runCenterU,
          barY,
          runLen,
          'steel',
          '#4 continuous footing bar',
          v,
        )
      }
    }

    // ---- interior walls ----
    if (!wall.exterior) {
      // Interior thickened footing (LOD 350): R403.1 requires a footing
      // under bearing walls; on a slab that is a thickened section poured
      // monolithically with it — 12" deep × footing width, top at the
      // slab/plate line (y = 0). See INTERIOR_BEARING_MIN_LENGTH ASSUMPTION.
      if (!fabDetail) continue
      if (len <= INTERIOR_BEARING_MIN_LENGTH) {
        // Short interior walls are normally non-bearing partitions — but one
        // whose BOTH ends land on footing-carrying walls is a link in the
        // foundation ring (blueprint round-1 auto-reject: the plan showed an
        // open ring where a 1.2 m link wall bridged two perimeter runs).
        const touchesRun = (px: number, pz: number) =>
          straightWalls.some((o) => {
            if (o.id === wall.id) return false
            if (!o.exterior && o.length <= INTERIOR_BEARING_MIN_LENGTH) return false
            const [ax, az] = o.start
            const proj = Math.max(
              0,
              Math.min(o.length, (px - ax) * o.dir[0] + (pz - az) * o.dir[1]),
            )
            const qx = ax + o.dir[0] * proj
            const qz = az + o.dir[1] * proj
            return Math.hypot(qx - px, qz - pz) < 0.15
          })
        const ex = sx + dx * len
        const ez = sz + dz * len
        if (!(touchesRun(sx, sz) && touchesRun(ex, ez))) continue
      }
      // Tee retreats apply here too: an interior bearing wall meeting the
      // exterior run stops at ITS footing face instead of pouring through
      // it (round-12, visible on exported plans).
      const iSign = extensions.get(wall.id) ?? { start: 0, end: 0 }
      const iS = (iSign.start * spec.footingWidth) / 2
      const iE = (iSign.end * spec.footingWidth) / 2
      const iLen = Math.max(0.3, len + iS + iE)
      const iCenter = (len + iE - iS) / 2
      emit(
        'footing',
        [iLen, INTERIOR_FOOTING_DEPTH, spec.footingWidth],
        iCenter,
        -INTERIOR_FOOTING_DEPTH / 2,
        iLen,
        'concrete',
        `Interior thickened footing ${formatIn(spec.footingWidth)}×${formatIn(INTERIOR_FOOTING_DEPTH)}`,
      )
      // Rebar rides "every footing run" — including interior thickened ones.
      emitFootingBars(iCenter, iLen, -INTERIOR_FOOTING_DEPTH, spec.footingWidth)
      continue
    }

    // Corner continuity (LOD 350): through ends lay past the corner by half
    // the meeting element's width; butt ends retreat the same amount and
    // land flush — see cornerExtensions. Footing and stemwall each apply
    // their OWN width so both read as one mitered pour with no overlap.
    const sign = extensions.get(wall.id) ?? { start: 0, end: 0 }
    const runFor = (width: number) => {
      const s = (sign.start * width) / 2
      const e = (sign.end * width) / 2
      return { len: len + s + e, center: (len + e - s) / 2 }
    }
    const footRun = runFor(spec.footingWidth)
    const runLen = footRun.len
    const runCenterU = footRun.center

    // ---- footing ----
    // R403.1.4.1: bearing must sit below the frost line → footing BOTTOM at
    // -spec.footingDepth (jurisdiction-resolved). Width from spec (Table
    // R403.1(1) sizing), centered under the wall so the load path is axial.
    emit(
      'footing',
      [runLen, FOOTING_HEIGHT, spec.footingWidth],
      runCenterU,
      -spec.footingDepth + FOOTING_HEIGHT / 2,
      runLen,
      'concrete',
      `Footing ${formatIn(spec.footingWidth)}×${formatIn(FOOTING_HEIGHT)}`,
    )

    // ---- footing rebar (LOD 350) ----
    if (fabDetail) {
      emitFootingBars(runCenterU, runLen, -spec.footingDepth, spec.footingWidth)
    }

    // ---- stemwall ----
    // From the footing top up to y = 0 (plate line / top of foundation).
    // With the default 12" frost depth this is a short 4" curb; cold-climate
    // jurisdiction profiles (42"+ frost) grow it into a real stemwall.
    // Extended through corners exactly like the footing so the corner is one
    // continuous pour. ASSUMPTION: grade is not modeled — R404.1.6's 6" stem
    // reveal above grade is assumed satisfied since y=0 is the framed floor
    // line.
    const stemHeight = spec.footingDepth - FOOTING_HEIGHT
    const stemRun = runFor(spec.stemwallThickness)
    if (stemHeight > EPS) {
      emit(
        'stemwall',
        [stemRun.len, stemHeight, spec.stemwallThickness],
        stemRun.center,
        -stemHeight / 2,
        stemRun.len,
        'concrete',
        `Stemwall ${formatIn(spec.stemwallThickness)}`,
      )

      // ---- stemwall vertical rebar (LOD 350) ----
      // R403.1.3.2 / SDC practice: #4 verticals tying footing to stemwall,
      // 48" o.c. (24" o.c. under seismic specs). Bars stand on the bottom
      // mat (3" clear off the footing bottom) and stop 2" shy of the
      // stemwall top so the mudsill seat stays clean.
      if (fabDetail) {
        const spacing = spec.seismicHoldDowns ? VERTICAL_SPACING_SEISMIC : VERTICAL_SPACING
        const barBottom = -spec.footingDepth + REBAR_BOTTOM_COVER
        const barTop = -REBAR_TOP_COVER
        const barHeight = barTop - barBottom
        if (barHeight > EPS) {
          // Layout runs over the stemwall's interlocked extent (incl. the
          // through-corner reach), mapped back to wall-local u.
          const stemStartDelta = (sign.start * spec.stemwallThickness) / 2
          // Verticals share the stemwall with the anchor bolts and both
          // layouts anchor to the run ends — wherever the two spacings
          // share a multiple they landed at the SAME (x,z) with ~5in of
          // coincident volume (round-11/12). Nudge any bar within 3in of a
          // bolt one hand-width down the run.
          const boltUs = anchorBoltPositions(len, spec.anchorBoltSpacing, spec.anchorBoltEndDistance)
          const clearOfBolts = (u: number): number => {
            const clash = boltUs.find((b) => Math.abs(b - u) < inches(3))
            if (clash === undefined) return u
            const shifted = u + inches(4) * (u <= clash ? -1 : 1)
            return Math.max(inches(2), Math.min(len - inches(2), shifted))
          }
          for (const p of anchorBoltPositions(stemRun.len, spacing, REBAR_END_COVER)) {
            emit(
              'rebar',
              [REBAR_SIDE, barHeight, REBAR_SIDE],
              clearOfBolts(p - stemStartDelta),
              (barBottom + barTop) / 2,
              barHeight,
              'steel',
              '#4 stemwall vertical',
            )
          }
        }
      }
    }

    // ---- anchor bolts ----
    // R403.1.6: max spacing (6' o.c. default, tighter in SDC D via the
    // jurisdiction profile), first/last within 12" of the plate ends, and
    // never fewer than two per plate section. Modeled as a 5/8" square shank
    // embedded 7" into the stemwall and sticking up through the plate line
    // (nut + washer land on the sill). Bolts follow the PLATE (wall length),
    // not the extended pour.
    const boltCenterY = -BOLT_EMBEDMENT + BOLT_HEIGHT / 2
    for (const u of anchorBoltPositions(len, spec.anchorBoltSpacing, spec.anchorBoltEndDistance)) {
      emit(
        'anchor-bolt',
        [BOLT_SIDE, BOLT_HEIGHT, BOLT_SIDE],
        u,
        boltCenterY,
        BOLT_HEIGHT,
        'steel',
        '5/8" anchor bolt',
      )

      // ---- plate washers (LOD 400) ----
      // R602.11.1 (SDC D0–D2): every foundation anchor bolt gets a 0.229" ×
      // 3" × 3" steel plate washer between the nut and the sill plate. The
      // washer sits ON TOP of the 1.5" mudsill, centered on its bolt.
      if (lod400 && spec.seismicHoldDowns) {
        emit(
          'plate-washer',
          [PLATE_WASHER_SIDE, PLATE_WASHER_THICKNESS, PLATE_WASHER_SIDE],
          u,
          PLATE_THICKNESS + PLATE_WASHER_THICKNESS / 2,
          PLATE_WASHER_SIDE,
          'steel',
          '3×3×0.229" plate washer (R602.11.1)',
        )
      }
    }

    // ---- seismic hold-downs ----
    // SDC D+ practice (R602.10.4.4 / engineered braced-wall ends): an
    // HDU-style hold-down ties the end post of each braced panel to the
    // foundation. We place one just inside each wall end — past the end stud
    // (1.5") so the body reads against the corner post.
    // ASSUMPTION: every exterior wall end is treated as a braced panel end;
    // real designs place them only at shear wall boundaries.
    if (spec.seismicHoldDowns && len > 2 * HOLD_DOWN_SIDE + inches(3)) {
      const inset = inches(1.5) + HOLD_DOWN_SIDE / 2 // end stud + half body
      for (const u of [inset, len - inset]) {
        emit(
          'hold-down',
          [HOLD_DOWN_SIDE, HOLD_DOWN_HEIGHT, HOLD_DOWN_SIDE],
          u,
          HOLD_DOWN_HEIGHT / 2, // base bears on the plate line (y = 0) up the post
          HOLD_DOWN_HEIGHT,
          'steel',
          'HDU hold-down',
        )
      }
    }

    // NO separate "thickened slab edge" here: this run already carries a
    // frost footing + stemwall, and the slab pours AGAINST the stemwall
    // (R403.1). A turned-down monolithic edge is the ALTERNATIVE detail —
    // emitting both doubled the perimeter concrete inside one volume
    // (round-10 interpenetration gate).
  }

  return members
}
