/**
 * Foundation engine — STUB, implementation landing tonight. Contract: under
 * every exterior wall on the ground level emit a concrete slab-edge/footing
 * run (width/depth from spec — frost-driven), a P.T. mudsill (material
 * 'pt-lumber') between concrete and framing, anchor bolts at
 * spec.anchorBoltSpacing (within spec.anchorBoltEndDistance of ends, min 2
 * per plate), and hold-downs at wall ends when spec.seismicHoldDowns.
 * Emits `Member`s (system 'foundation').
 */

import type { FramingSpec } from '../core/spec'
import type { Member, SlabSlice, WallSlice } from '../core/types'

export function buildFoundation(
  _walls: WallSlice[],
  _slabs: SlabSlice[],
  _spec: FramingSpec,
): Member[] {
  return []
}
