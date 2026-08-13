/**
 * CMU (concrete masonry unit) wall engine — STUB, implementation landing
 * tonight. Contract: running-bond 8x8x16 block coursing for the wall body,
 * precast lintels over openings, filled/vertical-rebar cells at corners and
 * jambs (LOD 300). Emits `Member`s with material 'concrete'.
 */

import type { FramingSpec } from '../core/spec'
import type { Member, WallSlice } from '../core/types'

export function cmuWall(_wall: WallSlice, _spec: FramingSpec): Member[] {
  return []
}
