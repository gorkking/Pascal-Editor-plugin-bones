/**
 * Plumbing engine — STUB, implementation landing tonight. Contract (dataset
 * in data/mep-rules.json, doc in docs/research/mep.md): identify wet rooms
 * (kitchen/bathroom/laundry from RoomSlice.category), pick a wet wall per wet
 * room (nearest boundary wall), and emit:
 *  - a 3" DWV vent stack (Member role 'vent-stack', material 'pvc') from
 *    floor through the wet wall, plus horizontal drain runs (role 'pipe-run')
 *    at floor level connecting wet rooms toward the stack,
 *  - supply runs (role 'pipe-run', material 'copper' — or pvc/PEX) alongside,
 *  - Fixtures: 'stub-out' at each wet-room wall (toilet/lav/sink rough-in
 *    heights from the dataset), a 'water-heater' in garage/laundry, a
 *    'cleanout' at the stack base.
 */

import type { FramingSpec } from '../core/spec'
import type { Fixture, Member, RoomSlice, WallSlice } from '../core/types'

export function layoutPlumbing(
  _walls: WallSlice[],
  _rooms: RoomSlice[],
  _spec: FramingSpec,
): { members: Member[]; fixtures: Fixture[] } {
  return { members: [], fixtures: [] }
}
