/**
 * Foundation engine — pure function: exterior WallSlices + SlabSlices +
 * FramingSpec → the concrete-and-hardware member set that carries the frame:
 *
 *   continuous footing (IRC R403.1) · stemwall up to the plate line ·
 *   anchor bolts at code spacing (R403.1.6) · seismic hold-downs at wall
 *   ends when the jurisdiction demands them · a subtle thickened slab edge
 *   when the level has slabs.
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

/**
 * Foundation for one level: walls (only `exterior` ones bear on the
 * perimeter foundation) + slabs (presence toggles the thickened slab edge).
 *
 * Interior walls get NOTHING here — on a slab they bear on the slab itself.
 * // LOD 400: interior thickened footings under bearing walls (R403.1 —
 * // walls stacking a girder or a second floor need their own footing).
 */
export function buildFoundation(
  walls: WallSlice[],
  slabs: SlabSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
): Member[] {
  const members: Member[] = []
  const hasSlab = slabs.length > 0

  for (const wall of walls) {
    if (!wall.exterior) continue
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
    ) => {
      members.push({
        system: 'foundation',
        role,
        dims,
        length,
        position: place(centerU, centerY),
        rotation: [0, yaw, 0],
        material,
        sourceId: wall.id,
        label,
      })
    }

    // ---- footing ----
    // R403.1.4.1: bearing must sit below the frost line → footing BOTTOM at
    // -spec.footingDepth (jurisdiction-resolved). Width from spec (Table
    // R403.1(1) sizing), centered under the wall so the load path is axial.
    // ASSUMPTION: footing runs exactly the wall length; corner continuity /
    // mitering where perimeter walls meet is left to the renderer's overlap.
    // // LOD 400: extend footings past corners + rebar (2× #4 continuous).
    emit(
      'footing',
      [len, FOOTING_HEIGHT, spec.footingWidth],
      len / 2,
      -spec.footingDepth + FOOTING_HEIGHT / 2,
      len,
      'concrete',
      `Footing ${formatIn(spec.footingWidth)}×${formatIn(FOOTING_HEIGHT)}`,
    )

    // ---- stemwall ----
    // From the footing top up to y = 0 (plate line / top of foundation).
    // With the default 12" frost depth this is a short 4" curb; cold-climate
    // jurisdiction profiles (42"+ frost) grow it into a real stemwall.
    // ASSUMPTION: grade is not modeled — R404.1.6's 6" stem reveal above
    // grade is assumed satisfied since y=0 is the framed floor line.
    const stemHeight = spec.footingDepth - FOOTING_HEIGHT
    if (stemHeight > EPS) {
      emit(
        'stemwall',
        [len, stemHeight, spec.stemwallThickness],
        len / 2,
        -stemHeight / 2,
        len,
        'concrete',
        `Stemwall ${formatIn(spec.stemwallThickness)}`,
      )
    }

    // ---- anchor bolts ----
    // R403.1.6: max spacing (6' o.c. default, tighter in SDC D via the
    // jurisdiction profile), first/last within 12" of the plate ends, and
    // never fewer than two per plate section. Modeled as a 5/8" square shank
    // embedded 7" into the stemwall and sticking up through the plate line
    // (nut + washer land on the sill).
    // // LOD 400: 3"×3" plate washers required in SDC D0–D2 (R602.11.1).
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

    // ---- thickened slab edge ----
    // When the level has a slab, the perimeter pour thickens into a 12"
    // turned-down edge under the slab line (R403.1.3.1 monolithic edge).
    // Kept subtle: barely wider than the stemwall (1.5" reveal each side)
    // and tucked 1/2" below y = 0 so it never fights the slab or plates.
    // ASSUMPTION: interior side of the wall is unknown, so the haunch is
    // centered on the wall line rather than tucked inboard.
    if (hasSlab) {
      const edgeWidth = spec.stemwallThickness + inches(3)
      const edgeTop = -inches(0.5)
      emit(
        'slab-edge',
        [len, SLAB_EDGE_DEPTH, edgeWidth],
        len / 2,
        edgeTop - SLAB_EDGE_DEPTH / 2,
        len,
        'concrete',
        'Thickened slab edge',
      )
    }

    // // LOD 400: P.T. mudsill (role 'mudsill', material 'pt-lumber') with
    // // sill sealer between stemwall top and the framed bottom plate —
    // // omitted in v1 because wall-framing already seats its plate at y=0.
  }

  return members
}
