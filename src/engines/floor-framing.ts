/**
 * Floor framing engine — STUB, implementation landing tonight. Contract:
 * for each slab polygon, joists at spec.joistSpacing spanning the short
 * direction (depth from spec.joistSpans vs actual span), rim joists around
 * the perimeter, a girder + posts when the span table runs out, mid-span
 * blocking rows. Emits `Member`s (system 'floor-framing').
 */

import type { FramingSpec } from '../core/spec'
import type { Member, SlabSlice } from '../core/types'

export function frameFloor(_slabs: SlabSlice[], _spec: FramingSpec): Member[] {
  return []
}
