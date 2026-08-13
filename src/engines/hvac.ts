/**
 * HVAC engine — STUB, implementation landing tonight. Contract (dataset in
 * data/mep-rules.json, doc in docs/research/mep.md): size the system from
 * conditioned floor area (rule-of-thumb sqft/ton), then:
 *  - place an 'equipment' Fixture (air handler) in garage/laundry/hallway,
 *  - run a main duct trunk (Member role 'duct-run', material 'duct') down the
 *    longest hallway/central axis at ceiling height,
 *  - branch to each habitable room with a ceiling 'register' Fixture and a
 *    round branch duct run; one central 'return' Fixture near the equipment,
 *  - a 'thermostat' Fixture on a hallway wall at 60" AFF.
 */

import type { FramingSpec } from '../core/spec'
import type { Fixture, Member, RoomSlice, WallSlice } from '../core/types'

export function layoutHvac(
  _walls: WallSlice[],
  _rooms: RoomSlice[],
  _spec: FramingSpec,
): { members: Member[]; fixtures: Fixture[] } {
  return { members: [], fixtures: [] }
}
