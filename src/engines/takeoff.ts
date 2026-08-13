/**
 * Takeoff engine — STUB, implementation landing tonight. Contract: count the
 * ACTUAL generated members (never re-estimate): group lumber by nominal size,
 * round cut lengths up to stock (8/10/12/14/16/20 ft), sum board feet
 * (dressed w×h×L/144 in imperial), and emit rows sorted by size; concrete in
 * cubic yards; fixtures by kind. Plus a `formatTakeoff` for the panel and a
 * CSV serializer.
 */

import type { Fixture, Member } from '../core/types'

export type TakeoffRow = {
  item: string
  detail: string
  quantity: number
  unit: string
}

export function computeTakeoff(members: Member[], fixtures: Fixture[]): TakeoffRow[] {
  const lumber = members.filter((m) => m.material === 'lumber' || m.material === 'pt-lumber')
  const rows: TakeoffRow[] = []
  if (lumber.length > 0) {
    rows.push({ item: 'Lumber members', detail: 'all sizes', quantity: lumber.length, unit: 'pcs' })
  }
  if (fixtures.length > 0) {
    rows.push({ item: 'Electrical devices', detail: 'all kinds', quantity: fixtures.length, unit: 'pcs' })
  }
  return rows
}

export function takeoffCsv(rows: TakeoffRow[]): string {
  return ['item,detail,quantity,unit', ...rows.map((r) => `${r.item},${r.detail},${r.quantity},${r.unit}`)].join('\n')
}
