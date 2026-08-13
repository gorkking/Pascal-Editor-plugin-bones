/**
 * Electrical layout engine — STUB, implementation landing tonight. Contract
 * (NEC 210.52 geometry, dataset in data/electrical-rules.json): walk each
 * wall's floor line; doorways break the wall line; no point along a usable
 * wall segment (>= 2ft) may be more than 6ft from a receptacle (i.e. 12ft
 * max between, 6ft max from each break); receptacles at 15" AFF; a switch
 * at the latch side of every door at 48" AFF; GFCI marking near wet zones.
 * Emits `Fixture`s (system 'electrical').
 */

import type { Fixture, WallSlice } from '../core/types'

export function layoutElectrical(_walls: WallSlice[]): Fixture[] {
  return []
}
