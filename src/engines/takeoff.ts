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
 * Fastening connections per member role, straight from the R602.3(1) data.
 * Roles with several real connections carry several entries — a joist is
 * end-nailed at the rim (16d) AND toe-nailed at its bearing (10d), a rafter
 * takes 16d at the ridge and 10d toe-nails at the plate — so the per-gauge
 * pounds match the schedule instead of over-weighting one nail type.
 */
type Connection = { nail: NailType; count?: number; perFt?: number }
const ROLE_CONNECTIONS: Partial<Record<Member['role'], Connection[]>> = {
  stud: [{ nail: '16d-common', count: 4 }], // 2 per end (stud-to-plate-end)
  'king-stud': [{ nail: '16d-common', count: 4 }],
  cripple: [{ nail: '16d-common', count: 4 }], // cripple-to-plate
  trimmer: [{ nail: '16d-common', perFt: 1.5 }], // trimmer-to-king
  'bottom-plate': [{ nail: '16d-common', perFt: 0.75 }],
  'top-plate': [{ nail: '16d-common', perFt: 0.75 }], // doubleTopPlate-run
  'cap-plate': [{ nail: '16d-common', perFt: 0.75 }],
  header: [{ nail: '16d-common', count: 8 }], // header-to-king, 4 per end
  sill: [{ nail: '16d-common', count: 4 }], // sill-to-trimmer
  'fire-blocking': [{ nail: '16d-common', count: 4 }],
  backing: [{ nail: '10d-common', count: 4 }],
  blocking: [{ nail: '10d-common', count: 4 }], // blocking-to-joist
  joist: [
    { nail: '16d-common', count: 3 }, // joist-to-rim end nails
    { nail: '10d-common', count: 3 }, // joist-to-plate toe-nails
  ],
  'rim-joist': [{ nail: '10d-common', count: 3 }], // joist-to-plate-toe
  rafter: [
    { nail: '16d-common', count: 3 }, // rafter-to-ridge
    { nail: '10d-common', count: 3 }, // rafter-to-plate-toe
  ],
  'jack-rafter': [
    { nail: '16d-common', count: 3 }, // cheek to hip/valley
    { nail: '10d-common', count: 3 }, // plate toe
  ],
  'collar-tie': [{ nail: '10d-common', count: 6 }], // 3 per end
  'ceiling-joist': [{ nail: '10d-common', count: 6 }], // bearing + lap
  outlooker: [{ nail: '10d-common', count: 4 }],
  fascia: [{ nail: '16d-common', perFt: 0.75 }],
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

  // Framing nails from the member counts (per-role connection list).
  for (const m of members) {
    if (!WOOD_MATERIALS.has(m.material)) continue
    for (const conn of ROLE_CONNECTIONS[m.role] ?? []) {
      addNails(conn.nail, conn.count ?? Math.ceil((conn.perFt ?? 0) * toFeet(m.length)))
    }
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
  // Foundation pours split by ELEMENT (footing / stemwall / slab edge /
  // other) so each can be ordered and formed separately; other systems'
  // pours (CMU lintels, bond beams) stay pooled per section.
  const FOUNDATION_POUR: Partial<Record<Member['role'], string>> = {
    footing: 'footings',
    stemwall: 'stemwalls',
    'slab-edge': 'slab edge',
  }
  const concretePours = new Map<string, { section: string; detail: string; m3: number }>()
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
    const detail =
      section === 'Foundation'
        ? (FOUNDATION_POUR[m.role] ?? 'other pours')
        : 'lintels/beams'
    const key = `${section}|${detail}`
    const pour = concretePours.get(key) ?? { section, detail, m3: 0 }
    pour.m3 += m.dims[0] * m.dims[1] * m.dims[2]
    concretePours.set(key, pour)
  }
  for (const pour of concretePours.values()) {
    if (pour.m3 <= 0) continue
    // Ready-mix trucks batch to 0.1 yd³; never show a real pour as 0.0.
    push(pour.section, 'Concrete', pour.detail, Math.max(0.1, round1(pour.m3 * M3_TO_YD3)), 'yd³')
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

  // ---- MEP fittings (LOD 400): elbows at each bend, boots, collars ----
  // Every direction change between consecutive legs of one routed chain is a
  // fitting. Chains are identified by sourceId (the engines route per room /
  // per circuit); a chain of n legs carries n−1 bends. ESTIMATE by
  // construction — couplings on straight >20ft sticks are not counted.
  const fittingChains = new Map<string, { section: string; item: string; legs: number }>()
  for (const m of members) {
    if (m.role === 'pipe-run') {
      const sizeIn = Math.round((Math.min(m.dims[1], m.dims[2]) / 0.0254) * 8) / 8
      const materialName = m.material === 'copper' ? 'Copper' : m.material === 'pvc' ? 'PVC' : 'Pipe'
      const key = `${m.system}|${materialName}|${sizeIn}|${m.sourceId}`
      const chain = fittingChains.get(key) ?? {
        section: SECTION_OF[m.system],
        item: `${materialName} ${sizeIn}" fittings`,
        legs: 0,
      }
      chain.legs += 1
      fittingChains.set(key, chain)
    } else if (m.role === 'duct-run') {
      const w = Math.round(m.dims[2] / 0.0254)
      const h = Math.round(m.dims[1] / 0.0254)
      const item = w === h ? `Duct ${w}" fittings` : `Duct ${w}×${h}" fittings`
      const key = `${m.system}|${item}|${m.sourceId}`
      const chain = fittingChains.get(key) ?? { section: SECTION_OF[m.system], item, legs: 0 }
      chain.legs += 1
      fittingChains.set(key, chain)
    }
  }
  const fittingRows = new Map<string, { section: string; item: string; count: number }>()
  for (const chain of fittingChains.values()) {
    const bends = Math.max(0, chain.legs - 1)
    if (bends === 0) continue
    const key = `${chain.section}|${chain.item}`
    const row = fittingRows.get(key) ?? { section: chain.section, item: chain.item, count: 0 }
    row.count += bends
    fittingRows.set(key, row)
  }
  for (const row of fittingRows.values()) {
    push(row.section, row.item, 'elbows at bends (est.)', row.count, 'pcs')
  }
  // Register boots (one per supply register) + takeoff collars (one per
  // branch tap = per distinct round-duct chain) — counted from fixtures and
  // chain topology, never labels.
  const registerCount = fixtures.filter((f) => f.kind === 'register').length
  if (registerCount > 0) {
    push('HVAC', 'Register boots', 'one per supply register', registerCount, 'pcs')
    const branchChains = new Set<string>()
    for (const m of members) {
      if (m.role !== 'duct-run') continue
      const w = Math.round(m.dims[2] / 0.0254)
      const h = Math.round(m.dims[1] / 0.0254)
      if (w === h) branchChains.add(m.sourceId) // round duct = branch run
    }
    if (branchChains.size > 0) {
      push('HVAC', 'Takeoff collars', 'one per trunk branch tap', branchChains.size, 'pcs')
    }
    // Trunk reducers: the trunk steps its cross-section down after each
    // takeoff — every distinct rectangular size beyond the first within one
    // trunk chain is a reducer fitting (round-3 advisory: never counted).
    const trunkSizes = new Map<string, Set<string>>()
    for (const m of members) {
      if (m.role !== 'duct-run') continue
      const w = Math.round(m.dims[2] / 0.0254)
      const h = Math.round(m.dims[1] / 0.0254)
      if (w === h) continue // round branch, not trunk
      const sizes = trunkSizes.get(m.sourceId) ?? new Set<string>()
      sizes.add(`${w}x${h}`)
      trunkSizes.set(m.sourceId, sizes)
    }
    let reducers = 0
    for (const sizes of trunkSizes.values()) reducers += Math.max(0, sizes.size - 1)
    if (reducers > 0) {
      push('HVAC', 'Trunk reducers', 'one per step-down in a trunk chain', reducers, 'pcs')
    }
  }

  // ---- Electrical boxes by type (LOD 400) — derived from fixture kinds ----
  const gangBoxes = fixtures.filter(
    (f) => f.kind === 'receptacle' || f.kind === 'receptacle-gfci' || f.kind === 'switch',
  ).length
  const ceilingBoxes = fixtures.filter(
    (f) => f.kind === 'light' || f.kind === 'smoke-alarm',
  ).length
  const panelCans = fixtures.filter((f) => f.kind === 'panel').length
  if (gangBoxes > 0) push('Electrical', 'Device boxes (1-gang)', 'receptacles + switches', gangBoxes, 'pcs')
  if (ceilingBoxes > 0) push('Electrical', 'Ceiling boxes', 'lights + smoke alarms', ceilingBoxes, 'pcs')
  if (panelCans > 0) push('Electrical', 'Panel cans', 'load center enclosures', panelCans, 'pcs')

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
