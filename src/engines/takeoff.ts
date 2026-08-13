/**
 * Takeoff engine — the prior framing tools signature move: quantities are counted
 * from the ACTUAL members the other engines generated, never re-estimated
 * from areas or wall lengths. If the 3D X-ray shows 14 studs, the takeoff
 * says 14 studs. Pure function: `(Member[], Fixture[]) → TakeoffRow[]`,
 * plus CSV / Markdown serializers for the panel's copy buttons.
 *
 * Estimating conventions implemented (the way a lumber desk actually quotes):
 *  - LUMBER  — pieces per (nominal size × stock length). Each cut length is
 *    rounded UP to the shortest stock stick that yields it (8/10/12/14/16/20
 *    ft — the lengths every yard carries). Board feet use NOMINAL inches
 *    (a "2x4" is billed as 2×4 even though it dresses to 1.5×3.5 — industry
 *    pricing convention: bd-ft = w_nom × h_nom × L_ft / 12).
 *  - CONCRETE — cubic yards, the ready-mix ordering unit (1 m³ = 1.30795 yd³).
 *  - CMU      — counted each; unit masonry is bought by the block, not by
 *    volume, so blocks are EXCLUDED from the poured-concrete yardage.
 *  - STEEL    — connector hardware each (anchor bolts per IRC R403.1.6,
 *    hold-downs at braced-wall ends, hurricane ties per IRC R802.11).
 *  - FLAGS    — every engine-raised flag ("ENGINEERED BEAM REQUIRED…")
 *    surfaces as its own line so it cannot be missed in the export.
 *  - FIXTURES — devices each (NEC 210.52 receptacles, 210.8 GFCI, R314
 *    smoke alarms, supply registers…).
 */

import type { Fixture, FixtureKind, Member } from '../core/types'
import { toFeet } from '../core/units'
import { LUMBER_SIZES, type LumberSize } from '../lumber'

export type TakeoffRow = {
  item: string
  detail: string
  quantity: number
  unit: string
}

// ---------------------------------------------------------------------------
// Lumber stock
// ---------------------------------------------------------------------------

/** Stock stick lengths (ft) every yard carries — even 2-ft increments. */
const STOCK_LENGTHS_FT = [8, 10, 12, 14, 16, 20] as const
const MAX_STOCK_FT = 20

/**
 * Float guard when comparing metric cut lengths against imperial stock:
 * an 8-ft plate computed as feet(8) must land in 8-ft stock, not 10-ft.
 * 1e-4 ft ≈ 0.03 mm — far below framing tolerance.
 */
const LEN_EPS_FT = 1e-4

/** 1 m³ in cubic yards — ready-mix is ordered by the yard. */
const M3_TO_YD3 = 1.30795

/**
 * Only wood materials belong in the lumber section. Concrete lintels and
 * steel hardware are counted in their own sections even if a future engine
 * ever tags them with a nominal size.
 */
const WOOD_MATERIALS = new Set<Member['material']>(['lumber', 'pt-lumber', 'engineered'])

type StockPick = { stockFt: number; pieces: number; splice: boolean }

/**
 * Round one cut length UP to purchasable stock. Cuts longer than the longest
 * stick (20 ft) cannot be bought in one piece — they take ceil(L/20) sticks
 * and a field splice (lapped/scabbed per practice; flagged in the detail).
 */
function stockFor(cutLengthM: number): StockPick {
  const cutFt = toFeet(cutLengthM)
  for (const stockFt of STOCK_LENGTHS_FT) {
    if (cutFt <= stockFt + LEN_EPS_FT) return { stockFt, pieces: 1, splice: false }
  }
  // ASSUMPTION: over-length runs are split into 20-ft sticks; real crews
  // would optimize splice locations over supports. // LOD 400: cutting-stock
  // optimization (nest multiple short cuts into one stick, waste factor).
  return {
    stockFt: MAX_STOCK_FT,
    pieces: Math.ceil((cutFt - LEN_EPS_FT) / MAX_STOCK_FT),
    splice: true,
  }
}

/** Nominal inches from the size key: '2x10' → [2, 10]. */
function nominalOf(size: LumberSize): [number, number] {
  const parts = size.split('x')
  return [Number(parts[0] ?? 0), Number(parts[1] ?? 0)]
}

/** Board feet per lineal foot of a nominal size: 2x4 → 2·4/12 = 2/3 bd-ft/ft. */
function boardFeetPerFoot(size: LumberSize): number {
  const [w, h] = nominalOf(size)
  return (w * h) / 12
}

const round1 = (n: number): number => Math.round(n * 10) / 10

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Display name + the code/practice each device count answers to. */
const FIXTURE_ROWS: Record<FixtureKind, { item: string; detail: string }> = {
  receptacle: { item: 'Receptacles', detail: 'NEC 210.52 spacing' },
  'receptacle-gfci': { item: 'GFCI receptacles', detail: 'NEC 210.8 wet locations' },
  switch: { item: 'Switches', detail: 'wall controls' },
  light: { item: 'Lights', detail: 'ceiling/wall luminaires' },
  'smoke-alarm': { item: 'Smoke alarms', detail: 'IRC R314' },
  panel: { item: 'Electrical panels', detail: 'load center' },
  'stub-out': { item: 'Plumbing stub-outs', detail: 'supply/drain' },
  'vent-stack': { item: 'Vent stacks', detail: 'DWV through-roof' },
  register: { item: 'Supply registers', detail: 'conditioned air' },
  return: { item: 'Return grilles', detail: 'return air path' },
  equipment: { item: 'Mechanical equipment', detail: 'AHU / condenser' },
  'water-heater': { item: 'Water heaters', detail: 'tank/tankless' },
  cleanout: { item: 'Cleanouts', detail: 'IRC P3005.2' },
  thermostat: { item: 'Thermostats', detail: 'zone control' },
}

/** Stable panel ordering for fixture rows (matches FixtureKind declaration). */
const FIXTURE_ORDER: readonly FixtureKind[] = [
  'receptacle',
  'receptacle-gfci',
  'switch',
  'light',
  'smoke-alarm',
  'panel',
  'stub-out',
  'vent-stack',
  'register',
  'return',
  'equipment',
  'water-heater',
  'cleanout',
  'thermostat',
]

// ---------------------------------------------------------------------------
// The takeoff
// ---------------------------------------------------------------------------

export function computeTakeoff(members: Member[], fixtures: Fixture[]): TakeoffRow[] {
  const rows: TakeoffRow[] = []

  // ---- LUMBER: pieces per (size × stock length) + board feet per size ----
  const bySize = new Map<LumberSize, Member[]>()
  for (const m of members) {
    if (!m.size || !WOOD_MATERIALS.has(m.material)) continue
    const bucket = bySize.get(m.size)
    if (bucket) bucket.push(m)
    else bySize.set(m.size, [m])
  }

  // Iterate the catalog order so rows read 2x4 → 2x6 → … → 6x6.
  for (const size of LUMBER_SIZES) {
    const pieces = bySize.get(size)
    if (!pieces) continue

    // Tally sticks per stock length (splice sticks kept as their own line so
    // the note survives the grouping), and accumulate purchased board feet.
    const plain = new Map<number, number>() // stockFt → sticks
    const spliced = new Map<number, number>() // stockFt → sticks (over-length)
    let boardFeet = 0
    const bfPerFt = boardFeetPerFoot(size)
    for (const member of pieces) {
      const pick = stockFor(member.length)
      const tally = pick.splice ? spliced : plain
      tally.set(pick.stockFt, (tally.get(pick.stockFt) ?? 0) + pick.pieces)
      // Board feet are billed on the PURCHASED stick, not the cut — you pay
      // for the drop. bd-ft = nominal w × h × stock ft / 12, per stick.
      boardFeet += pick.pieces * pick.stockFt * bfPerFt
    }

    for (const stockFt of [...plain.keys()].sort((a, b) => a - b)) {
      rows.push({
        item: size,
        detail: `${stockFt} ft stock`,
        quantity: plain.get(stockFt) ?? 0,
        unit: 'pcs',
      })
    }
    for (const stockFt of [...spliced.keys()].sort((a, b) => a - b)) {
      rows.push({
        item: size,
        detail: `${stockFt} ft stock (field splice — run exceeds 20 ft)`,
        quantity: spliced.get(stockFt) ?? 0,
        unit: 'pcs',
      })
    }
    rows.push({ item: size, detail: 'board feet', quantity: round1(boardFeet), unit: 'bd-ft' })
    // LOD 400: split PT (mudsills) vs SPF vs engineered into separate lines —
    // they price very differently; add a waste factor (5–10% typical).
  }

  // ---- CONCRETE: poured volume in yd³ + CMU blocks each ----
  // ASSUMPTION: role 'block' members are unit masonry (CMU), bought by the
  // piece — excluded from the poured yardage so nothing double-counts.
  let concreteM3 = 0
  let blockCount = 0
  for (const m of members) {
    if (m.material !== 'concrete') continue
    if (m.role === 'block') {
      blockCount += 1
      continue
    }
    concreteM3 += m.dims[0] * m.dims[1] * m.dims[2]
  }
  if (concreteM3 > 0) {
    // Ready-mix trucks batch to 0.1 yd³; never show a real pour as 0.0.
    const yd3 = Math.max(0.1, round1(concreteM3 * M3_TO_YD3))
    rows.push({ item: 'Concrete', detail: 'footings/stem/lintels', quantity: yd3, unit: 'yd³' })
    // LOD 400: split by role (footings vs stemwall vs lintels) and add a
    // rebar tonnage line from the reinforcing members.
  }
  if (blockCount > 0) {
    rows.push({ item: 'CMU block', detail: '8x8x16 running bond', quantity: blockCount, unit: 'pcs' })
  }

  // ---- STEEL: connector hardware, counted each ----
  // Anchor bolts (IRC R403.1.6: ≤6' o.c., ≤12" from plate ends, ≥2 per plate)
  // and hold-downs carry their own roles; hurricane ties have no dedicated
  // role, so they are matched by label (roof engine labels them).
  const anchorBolts = members.filter((m) => m.role === 'anchor-bolt').length
  const holdDowns = members.filter((m) => m.role === 'hold-down').length
  const hurricaneTies = members.filter((m) => /hurricane/i.test(m.label ?? '')).length
  if (anchorBolts > 0) {
    rows.push({ item: 'Anchor bolts', detail: 'mudsill anchorage (R403.1.6)', quantity: anchorBolts, unit: 'pcs' })
  }
  if (holdDowns > 0) {
    rows.push({ item: 'Hold-downs', detail: 'braced wall ends (seismic)', quantity: holdDowns, unit: 'pcs' })
  }
  if (hurricaneTies > 0) {
    rows.push({ item: 'Hurricane ties', detail: 'rafter/plate uplift (R802.11)', quantity: hurricaneTies, unit: 'pcs' })
  }

  // ---- FLAGS: every engine warning becomes a visible line ----
  // First-seen order keeps flags stable against member reordering within a run.
  const flagCounts = new Map<string, number>()
  for (const m of members) {
    if (m.flag) flagCounts.set(m.flag, (flagCounts.get(m.flag) ?? 0) + 1)
  }
  for (const [flag, count] of flagCounts) {
    rows.push({ item: 'FLAG', detail: flag, quantity: count, unit: 'ea' })
  }

  // ---- FIXTURES: devices each, one row per kind present ----
  const kindCounts = new Map<FixtureKind, number>()
  for (const f of fixtures) {
    kindCounts.set(f.kind, (kindCounts.get(f.kind) ?? 0) + 1)
  }
  for (const kind of FIXTURE_ORDER) {
    const count = kindCounts.get(kind)
    if (!count) continue
    const { item, detail } = FIXTURE_ROWS[kind]
    rows.push({ item, detail, quantity: count, unit: 'pcs' })
  }

  // LOD 400: linear feet of pipe/duct from the MEP run members (role
  // 'pipe-run'/'duct-run'/'vent-stack'), sheathing/drywall areas, nail counts.
  return rows
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/** RFC 4180 field escape: quote when a comma/quote/newline appears. */
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function takeoffCsv(rows: TakeoffRow[]): string {
  return [
    'item,detail,quantity,unit',
    ...rows.map((r) => [csvField(r.item), csvField(r.detail), String(r.quantity), csvField(r.unit)].join(',')),
  ].join('\n')
}

/** Escape the pipe so flag text can't break the table. */
const mdCell = (value: string): string => value.replace(/\|/g, '\\|')

/** GitHub-flavored pipe table — pasteable into an estimate doc or PR. */
export function takeoffMarkdown(rows: TakeoffRow[]): string {
  return [
    '| Item | Detail | Quantity | Unit |',
    '| --- | --- | ---: | --- |',
    ...rows.map((r) => `| ${mdCell(r.item)} | ${mdCell(r.detail)} | ${r.quantity} | ${mdCell(r.unit)} |`),
  ].join('\n')
}
