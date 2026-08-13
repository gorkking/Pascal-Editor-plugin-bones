/**
 * Roof framing engine — STUB, implementation landing tonight. Contract:
 * extract roof segments from the scene (`extractRoofs`), then for gable/shed
 * segments lay rafters at spec.rafterSpacing along each plane's fall line,
 * a ridge board at the apex, ceiling joists across the top plates, collar
 * ties between opposing rafter pairs; hip/valley members for hip roofs.
 * Emits `Member`s (system 'roof-framing').
 */

import type { FramingSpec } from '../core/spec'
import type { Member, RoofSlice, WallSlice } from '../core/types'

type AnyRecord = Record<string, unknown>

export function extractRoofs(_nodes: Record<string, AnyRecord>, _levelId: string): RoofSlice[] {
  return []
}

export function frameRoofs(
  _roofs: RoofSlice[],
  _walls: WallSlice[],
  _spec: FramingSpec,
): Member[] {
  return []
}
