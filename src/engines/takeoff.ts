/**
 * Takeoff engine — quantities are counted
 * from the ACTUAL members the other engines generated, never re-estimated
 * from areas or wall lengths. If the 3D X-ray shows 14 studs, the takeoff
 * says 14 studs. Pure function:
 * `(Member[], Fixture[], areas?) → TakeoffRow[]`, plus a cut-list export and
 * CSV / Markdown serializers for the panel's copy buttons.
 *
 * Every row carries a `section` — the per-system grouping the panel renders
 * as collapsible groups and the CSV keeps as its first column:
 * Wall framing / Floor / Roof / Foundation / Sheathing / Electrical /
 * Plumbing / HVAC / Fasteners / Flags.
 *
 * Estimating conventions implemented (the way a lumber desk actually quotes):
 *  - LUMBER  — pieces per (nominal size × stock length), PER SYSTEM. Each cut
 *    is rounded UP to the shortest stock stick that yields it (8/10/12/14/16/
 *    20 ft). Board feet use NOMINAL inches (bd-ft = w × h × L_ft / 12).
 *  - SHEETS  — 4x8 sheet counts from gross areas (openings are cut from the
 *    sheet, not deducted from the buy): wall sheathing (WSP), subfloor T&G,
 *    drywall.
 *  - CONCRETE — cubic yards per system (1 m³ = 1.30795 yd³); CMU counted
 *    each; grout by the grouted-cell count; mortar by the block count;
 *    rebar in linear feet.
 *  - HARDWARE — counted by dedicated ROLE (anchor bolts, hold-downs, joist
 *    hangers, plate washers) or role+material+system (hurricane ties are the
 *    roof engine's steel blocking) — never by label regex.
 *  - MEP RUNS — linear feet: pipe by size and material, duct by section,
 *    NM cable by gauge; electrical circuits from the fixtures' circuit meta.
 *  - FASTENERS — nails by type in POUNDS from data/fastening-schedule.json
 *    (IRC R602.3(1)) applied to the member counts, one connection per role.
 *  - FLAGS    — every engine-raised flag surfaces as its own line.
 */

import fastening from '../../data/fastening-schedule.json'
import type { Fixture, FixtureKind, Member } from '../core/types'
import { formatFtIn, toFeet } from '../core/units'
import { LUMBER_SIZES, type LumberSize } from '../lumber'
import { circuitSchedule } from './electrical'

export type TakeoffRow = {
  section: string
  item: string
  detail: string
  quantity: number
  unit: string
}

/** Gross sheet-goods areas, computed by `computeLevel` from the wall/slab geometry. */
export type TakeoffAreas = {
  wallSheathingM2?: number
  subfloorM2?: number
  drywallM2?: number
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const SECTION_OF: Record<Member['system'], string> = {
  'wall-framing': 'Wall framing',
  'floor-framing': 'Floor',
  'roof-framing': 'Roof',
  foundation: 'Foundation',
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  hvac: 'HVAC',
}

const SECTION_ORDER = [
  'Wall framing',
  'Floor',
  'Roof',
  'Foundation',
  'Sheathing',
  'Electrical',
  'Plumbing',
  'HVAC',
  'Fasteners',
  'Flags',
] as const

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
/** A 4x8 sheet covers 32 ft² = 2.9729 m². */
const SHEET_M2 = 32 / 10.7639
/** Grout per filled 8" CMU cell (~0.3 ft³ with the core deducted). */
const GROUT_M3_PER_CELL = 0.0085
/** Mortar: one 80-lb Type S bag lays ~20 blocks (supplier rule of thumb). */
const BLOCKS_PER_MORTAR_BAG = 20

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
  // would optimize splice locations over supports.
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
// Fasteners (IRC R602.3(1) via data/fastening-schedule.json)
// ---------------------------------------------------------------------------

type NailType = keyof typeof fastening.nails

/**
 * One representative connection per member role (the schedule's most
 * load-bearing line for that role). ASSUMPTION: roles with several real
 * connections (a joist is end-nailed AND toe-nailed) count the primary one —
 * the takeoff under-counts slightly rather than double-counting.
 */
const ROLE_CONNECTION: Partial<
  Record<Member['role'], { nail: NailType; count?: number; perFt?: number }>
> = {
  stud: { nail: '16d-common', count: 4 }, // 2 per end (stud-to-plate-end)
  'king-stud': { nail: '16d-common', count: 4 },
  cripple: { nail: '16d-common', count: 4 }, // cripple-to-plate
  trimmer: { nail: '16d-common', perFt: 1.5 }, // trimmer-to-king
  'bottom-plate': { nail: '16d-common', perFt: 0.75 },
  'top-plate': { nail: '16d-common', perFt: 0.75 }, // doubleTopPlate-run
  'cap-plate': { nail: '16d-common', perFt: 0.75 },
  header: { nail: '16d-common', count: 8 }, // header-to-king, 4 per end
  sill: { nail: '16d-common', count: 4 }, // sill-to-trimmer
  'fire-blocking': { nail: '16d-common', count: 4 },
  backing: { nail: '10d-common', count: 4 },
  blocking: { nail: '10d-common', count: 4 }, // blocking-to-joist
  joist: { nail: '16d-common', count: 3 }, // joist-to-rim
  'rim-joist': { nail: '10d-common', count: 3 }, // joist-to-plate-toe
  rafter: { nail: '16d-common', count: 6 }, // ridge (3) + plate toe (3)
  'jack-rafter': { nail: '16d-common', count: 3 },
  'collar-tie': { nail: '10d-common', count: 6 }, // 3 per end
  'ceiling-joist': { nail: '10d-common', count: 6 }, // bearing + lap
  outlooker: { nail: '10d-common', count: 4 },
  fascia: { nail: '16d-common', perFt: 0.75 },
}

/** Hardware nail loads (json `hardware` block). */
const HANGER_NAILS = fastening.hardware['joist-hanger'].nailsPer
const TIE_NAILS = fastening.hardware['hurricane-tie'].nailsPer

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
  'exhaust-fan': { item: 'Exhaust fans', detail: 'bath/dryer ventilation (M1505)' },
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
  'exhaust-fan',
]

// ---------------------------------------------------------------------------
// The takeoff
// ---------------------------------------------------------------------------

export function computeTakeoff(
  members: Member[],
  fixtures: Fixture[],
  areas: TakeoffAreas = {},
): TakeoffRow[] {
  const rows: TakeoffRow[] = []
  const push = (section: string, item: string, detail: string, quantity: number, unit: string) =>
    rows.push({ section, item, detail, quantity, unit })

  const nails = new Map<NailType, number>()
  const addNails = (type: NailType, count: number) =>
    nails.set(type, (nails.get(type) ?? 0) + count)

  // ---- LUMBER: pieces per (system × size × stock length) + board feet ----
  const bySystem = new Map<string, Map<LumberSize, Member[]>>()
  for (const m of members) {
    if (!m.size || !WOOD_MATERIALS.has(m.material)) continue
    const section = SECTION_OF[m.system]
    const sizes = bySystem.get(section) ?? new Map<LumberSize, Member[]>()
    const bucket = sizes.get(m.size)
    if (bucket) bucket.push(m)
    else sizes.set(m.size, [m])
    bySystem.set(section, sizes)
  }

  for (const section of SECTION_ORDER) {
    const bySize = bySystem.get(section)
    if (!bySize) continue
    // Iterate the catalog order so rows read 2x4 → 2x6 → … → 6x6.
    for (const size of LUMBER_SIZES) {
      const pieces = bySize.get(size)
      if (!pieces) continue
      const plain = new Map<number, number>() // stockFt → sticks
      const spliced = new Map<number, number>() // stockFt → sticks (over-length)
      let boardFeet = 0
      const bfPerFt = boardFeetPerFoot(size)
      for (const member of pieces) {
        const pick = stockFor(member.length)
        const tally = pick.splice ? spliced : plain
        tally.set(pick.stockFt, (tally.get(pick.stockFt) ?? 0) + pick.pieces)
        // Board feet are billed on the PURCHASED stick — you pay for the drop.
        boardFeet += pick.pieces * pick.stockFt * bfPerFt
      }
      for (const stockFt of [...plain.keys()].sort((a, b) => a - b)) {
        push(section, size, `${stockFt} ft stock`, plain.get(stockFt) ?? 0, 'pcs')
      }
      for (const stockFt of [...spliced.keys()].sort((a, b) => a - b)) {
        push(
          section,
          size,
          `${stockFt} ft stock (field splice — run exceeds 20 ft)`,
          spliced.get(stockFt) ?? 0,
          'pcs',
        )
      }
      push(section, size, 'board feet', round1(boardFeet), 'bd-ft')
    }
  }

  // Framing nails from the member counts (one connection per role).
  for (const m of members) {
    if (!WOOD_MATERIALS.has(m.material)) continue
    const conn = ROLE_CONNECTION[m.role]
    if (!conn) continue
    addNails(conn.nail, conn.count ?? Math.ceil((conn.perFt ?? 0) * toFeet(m.length)))
  }

  // ---- SHEATHING: 4x8 sheet counts from gross areas ----
  const wspSheets = Math.ceil((areas.wallSheathingM2 ?? 0) / SHEET_M2)
  const subfloorSheets = Math.ceil((areas.subfloorM2 ?? 0) / SHEET_M2)
  const drywallSheets = Math.ceil((areas.drywallM2 ?? 0) / SHEET_M2)
  if (wspSheets > 0) {
    push('Sheathing', 'Wall sheathing 7/16" WSP', '4x8 sheets, gross (openings cut out)', wspSheets, 'sheets')
    addNails('8d-common', wspSheets * fastening.connections['wallSheathing-sheet'].count)
  }
  if (subfloorSheets > 0) {
    push('Sheathing', 'Subfloor 3/4" T&G', '4x8 sheets, gross', subfloorSheets, 'sheets')
    addNails('8d-common', subfloorSheets * fastening.connections['subfloor-sheet'].count)
  }
  if (drywallSheets > 0) {
    push('Sheathing', 'Drywall 1/2"', '4x8 sheets, both faces of interior walls', drywallSheets, 'sheets')
  }

  // ---- CONCRETE + MASONRY per system ----
  const concreteBySection = new Map<string, number>()
  let blockCount = 0
  let groutedCells = 0
  for (const m of members) {
    if (m.material !== 'concrete') continue
    if (m.role === 'block') {
      blockCount += 1
      if (m.label?.includes('grouted')) groutedCells += 1
      continue
    }
    const section = SECTION_OF[m.system]
    concreteBySection.set(
      section,
      (concreteBySection.get(section) ?? 0) + m.dims[0] * m.dims[1] * m.dims[2],
    )
  }
  for (const section of SECTION_ORDER) {
    const m3 = concreteBySection.get(section)
    if (!m3 || m3 <= 0) continue
    // Ready-mix trucks batch to 0.1 yd³; never show a real pour as 0.0.
    push(section, 'Concrete', 'footings/stem/lintels', Math.max(0.1, round1(m3 * M3_TO_YD3)), 'yd³')
  }
  if (blockCount > 0) {
    push('Wall framing', 'CMU block', '8x8x16 running bond', blockCount, 'pcs')
    push(
      'Wall framing',
      'Mortar (Type S)',
      `~${BLOCKS_PER_MORTAR_BAG} blocks per 80-lb bag`,
      Math.ceil(blockCount / BLOCKS_PER_MORTAR_BAG),
      'bags',
    )
    if (groutedCells > 0) {
      push(
        'Wall framing',
        'Grout',
        `${groutedCells} reinforced cells (R606.12)`,
        Math.max(0.1, round1(groutedCells * GROUT_M3_PER_CELL * M3_TO_YD3)),
        'yd³',
      )
    }
  }

  // Rebar: linear feet per system (steel role 'rebar' — CMU cells, bond
  // beams, footings, stemwalls).
  const rebarBySection = new Map<string, { lf: number; pcs: number }>()
  for (const m of members) {
    if (m.role !== 'rebar') continue
    const section = SECTION_OF[m.system]
    const tally = rebarBySection.get(section) ?? { lf: 0, pcs: 0 }
    tally.lf += toFeet(m.length)
    tally.pcs += 1
    rebarBySection.set(section, tally)
  }
  for (const section of SECTION_ORDER) {
    const tally = rebarBySection.get(section)
    if (!tally) continue
    push(section, 'Rebar', `${tally.pcs} bars, laps not included`, round1(tally.lf), 'lf')
  }

  // ---- STEEL hardware: counted by ROLE (never label regex) ----
  const roleCount = (role: Member['role']): number =>
    members.filter((m) => m.role === role).length
  const anchorBolts = roleCount('anchor-bolt')
  const holdDowns = roleCount('hold-down')
  const plateWashers = roleCount('plate-washer')
  const hangers = roleCount('hanger')
  // Hurricane ties are the roof engine's steel blocking — role + material +
  // system, structural identification without parsing labels.
  const hurricaneTies = members.filter(
    (m) => m.role === 'blocking' && m.material === 'steel' && m.system === 'roof-framing',
  ).length
  if (anchorBolts > 0) {
    push('Foundation', 'Anchor bolts', 'mudsill anchorage (R403.1.6)', anchorBolts, 'pcs')
  }
  if (plateWashers > 0) {
    push('Foundation', 'Plate washers 3x3', 'SDC D₀–D₂ (R602.11.1)', plateWashers, 'pcs')
  }
  if (holdDowns > 0) {
    push('Foundation', 'Hold-downs', 'braced wall ends (seismic)', holdDowns, 'pcs')
  }
  if (hangers > 0) {
    push('Floor', 'Joist hangers', 'LUS-series @ girders/headers', hangers, 'pcs')
    addNails('10d-common', hangers * HANGER_NAILS)
  }
  if (hurricaneTies > 0) {
    push('Roof', 'Hurricane ties', 'rafter/plate uplift (R802.11)', hurricaneTies, 'pcs')
    addNails('8d-common', hurricaneTies * TIE_NAILS)
  }

  // ---- MEP runs: linear feet by size ----
  // Pipe by (material, nominal size) within its system section.
  const pipeTallies = new Map<string, { section: string; item: string; lf: number }>()
  const ductTallies = new Map<string, { section: string; item: string; lf: number }>()
  const wireTallies = new Map<string, number>()
  for (const m of members) {
    if (m.role === 'wire-run') {
      const gauge = m.label?.match(/(\d+)\/2/)?.[1] ?? '14'
      wireTallies.set(gauge, (wireTallies.get(gauge) ?? 0) + toFeet(m.length))
    } else if (m.role === 'pipe-run' || m.role === 'vent-stack') {
      const sizeIn = Math.round((Math.min(m.dims[1], m.dims[2]) / 0.0254) * 8) / 8
      const materialName = m.material === 'copper' ? 'Copper' : m.material === 'pvc' ? 'PVC' : 'Pipe'
      const key = `${m.system}|${materialName}|${sizeIn}`
      const tally = pipeTallies.get(key) ?? {
        section: SECTION_OF[m.system],
        item: `${materialName} ${sizeIn}"`,
        lf: 0,
      }
      tally.lf += toFeet(m.length)
      pipeTallies.set(key, tally)
    } else if (m.role === 'duct-run') {
      const w = Math.round(m.dims[2] / 0.0254)
      const h = Math.round(m.dims[1] / 0.0254)
      const item = w === h ? `Duct ${w}" round` : `Duct ${w}×${h}"`
      const key = `${m.system}|${item}`
      const tally = ductTallies.get(key) ?? { section: SECTION_OF[m.system], item, lf: 0 }
      tally.lf += toFeet(m.length)
      ductTallies.set(key, tally)
    }
  }
  for (const tally of pipeTallies.values()) {
    push(tally.section, tally.item, 'linear feet', round1(tally.lf), 'lf')
  }
  for (const tally of ductTallies.values()) {
    push(tally.section, tally.item, 'linear feet', round1(tally.lf), 'lf')
  }
  for (const [gauge, lf] of wireTallies) {
    push('Electrical', `NM-B ${gauge}/2 w/G`, 'homeruns + branch chains', round1(lf), 'lf')
  }

  // ---- Electrical circuits (panel schedule) ----
  for (const circuit of circuitSchedule(fixtures)) {
    const marks = [circuit.afci ? 'AFCI' : '', circuit.gfci ? 'GFCI' : ''].filter(Boolean).join('+')
    push(
      'Electrical',
      `Circuit ${circuit.circuit}`,
      `${circuit.breakerA}A / ${circuit.gaugeAwg} AWG / ${circuit.va} VA${marks ? ` / ${marks}` : ''}`,
      circuit.devices,
      'devices',
    )
  }

  // ---- FIXTURES: devices each, one row per kind, in their system section ----
  const kindCounts = new Map<FixtureKind, { count: number; section: string }>()
  for (const f of fixtures) {
    const entry = kindCounts.get(f.kind) ?? { count: 0, section: SECTION_OF[f.system] }
    entry.count += 1
    kindCounts.set(f.kind, entry)
  }
  for (const kind of FIXTURE_ORDER) {
    const entry = kindCounts.get(kind)
    if (!entry) continue
    const { item, detail } = FIXTURE_ROWS[kind]
    push(entry.section, item, detail, entry.count, 'pcs')
  }

  // ---- FASTENERS: nails by type, in pounds ----
  for (const [type, count] of nails) {
    if (count <= 0) continue
    const info = fastening.nails[type]
    push(
      'Fasteners',
      `Nails ${type.replace('-common', '')} common`,
      `${info.lengthIn}" — R602.3(1) schedule, ${count} nails`,
      Math.max(0.5, round1(count / info.perLb)),
      'lbs',
    )
  }

  // ---- FLAGS: every engine warning becomes a visible line ----
  const flagCounts = new Map<string, number>()
  for (const m of members) {
    if (m.flag) flagCounts.set(m.flag, (flagCounts.get(m.flag) ?? 0) + 1)
  }
  for (const [flag, count] of flagCounts) {
    push('Flags', 'FLAG', flag, count, 'ea')
  }

  // Stable-sort into the canonical section order.
  const order = new Map<string, number>(SECTION_ORDER.map((s, i) => [s, i]))
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const sa = order.get(a.row.section) ?? 99
      const sb = order.get(b.row.section) ?? 99
      return sa !== sb ? sa - sb : a.index - b.index
    })
    .map(({ row }) => row)
}

// ---------------------------------------------------------------------------
// Cut list (LOD 400): every wood member, size × exact cut length × qty
// ---------------------------------------------------------------------------

export type CutRow = {
  section: string
  size: LumberSize
  role: string
  /** Exact cut length in meters (grouping key, rounded to the mm). */
  lengthM: number
  /** Human length: 7'-8 5/8" style. */
  lengthLabel: string
  qty: number
}

/** Group every wood member into (system, size, role, mm-exact length) lines. */
export function cutList(members: Member[]): CutRow[] {
  const groups = new Map<string, CutRow>()
  for (const m of members) {
    if (!m.size || !WOOD_MATERIALS.has(m.material)) continue
    const lengthM = Math.round(m.length * 1000) / 1000
    const section = SECTION_OF[m.system]
    const key = `${section}|${m.size}|${m.role}|${lengthM}`
    const row = groups.get(key)
    if (row) row.qty += 1
    else {
      groups.set(key, {
        section,
        size: m.size,
        role: m.role,
        lengthM,
        lengthLabel: formatFtIn(lengthM),
        qty: 1,
      })
    }
  }
  const order = new Map<string, number>(SECTION_ORDER.map((s, i) => [s, i]))
  return [...groups.values()].sort((a, b) => {
    const sa = order.get(a.section) ?? 99
    const sb = order.get(b.section) ?? 99
    if (sa !== sb) return sa - sb
    if (a.size !== b.size) return LUMBER_SIZES.indexOf(a.size) - LUMBER_SIZES.indexOf(b.size)
    return b.lengthM - a.lengthM
  })
}

export function cutListCsv(rows: CutRow[]): string {
  return [
    'section,size,role,length,qty',
    ...rows.map((r) =>
      [csvField(r.section), r.size, csvField(r.role), csvField(r.lengthLabel), String(r.qty)].join(
        ',',
      ),
    ),
  ].join('\n')
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
    'section,item,detail,quantity,unit',
    ...rows.map((r) =>
      [csvField(r.section), csvField(r.item), csvField(r.detail), String(r.quantity), csvField(r.unit)].join(','),
    ),
  ].join('\n')
}

/** Escape the pipe so flag text can't break the table. */
const mdCell = (value: string): string => value.replace(/\|/g, '\\|')

/** GitHub-flavored pipe table — pasteable into an estimate doc or PR. */
export function takeoffMarkdown(rows: TakeoffRow[]): string {
  return [
    '| Section | Item | Detail | Quantity | Unit |',
    '| --- | --- | --- | ---: | --- |',
    ...rows.map(
      (r) =>
        `| ${mdCell(r.section)} | ${mdCell(r.item)} | ${mdCell(r.detail)} | ${r.quantity} | ${mdCell(r.unit)} |`,
    ),
  ].join('\n')
}
