import { describe, expect, test } from 'bun:test'
import type { Fixture, FixtureKind, Member } from '../core/types'
import { feet } from '../core/units'
import type { LumberSize } from '../lumber'
import { computeTakeoff, takeoffCsv, takeoffMarkdown, type TakeoffRow } from './takeoff'

// ---------------------------------------------------------------------------
// Synthetic builders — the takeoff only reads size/length/material/role/
// label/flag/dims, so geometry fields can stay trivial.
// ---------------------------------------------------------------------------

function mem(overrides: Partial<Member> & { length?: number } = {}): Member {
  return {
    system: 'wall-framing',
    role: 'stud',
    size: '2x4',
    dims: [0.038, 2.4, 0.089],
    length: 2.4,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    material: 'lumber',
    sourceId: 'wall_1',
    ...overrides,
  }
}

function lumber(size: LumberSize, lengthM: number, overrides: Partial<Member> = {}): Member {
  return mem({ size, length: lengthM, ...overrides })
}

function concrete(dims: [number, number, number], overrides: Partial<Member> = {}): Member {
  return mem({
    system: 'foundation',
    role: 'footing',
    size: undefined,
    material: 'concrete',
    dims,
    length: dims[0],
    ...overrides,
  })
}

function fixture(kind: FixtureKind, overrides: Partial<Fixture> = {}): Fixture {
  return {
    system: 'electrical',
    kind,
    position: [0, 0.3, 0],
    rotationY: 0,
    sourceId: 'wall_1',
    ...overrides,
  }
}

const find = (rows: TakeoffRow[], item: string, detail?: string): TakeoffRow | undefined =>
  rows.find((r) => r.item === item && (detail === undefined || r.detail === detail))

// ---------------------------------------------------------------------------
// Lumber: stock rounding
// ---------------------------------------------------------------------------

describe('lumber stock rounding', () => {
  test('2.5 m stud (8.2 ft) rounds UP to 10 ft stock, not 8', () => {
    const rows = computeTakeoff([lumber('2x4', 2.5)], [])
    expect(find(rows, '2x4', '10 ft stock')).toEqual({
      section: 'Wall framing',
      item: '2x4',
      detail: '10 ft stock',
      quantity: 1,
      unit: 'pcs',
    })
    expect(find(rows, '2x4', '8 ft stock')).toBeUndefined()
  })

  test('an exactly-8-ft cut buys 8 ft stock (no float creep to 10)', () => {
    const rows = computeTakeoff([lumber('2x4', feet(8))], [])
    expect(find(rows, '2x4', '8 ft stock')?.quantity).toBe(1)
  })

  test('an exactly-20-ft cut buys one 20 ft stick, no splice', () => {
    const rows = computeTakeoff([lumber('2x12', feet(20))], [])
    expect(find(rows, '2x12', '20 ft stock')?.quantity).toBe(1)
    expect(rows.some((r) => r.detail.includes('splice'))).toBe(false)
  })

  test('a 22-ft girder exceeds stock: two 20-ft sticks, detail notes field splice', () => {
    const rows = computeTakeoff([lumber('2x12', feet(22), { role: 'girder' })], [])
    const splice = rows.find((r) => r.item === '2x12' && r.detail.includes('field splice'))
    expect(splice).toBeDefined()
    expect(splice?.detail).toContain('20 ft stock')
    expect(splice?.quantity).toBe(2)
    expect(splice?.unit).toBe('pcs')
  })

  test('same size groups across stock lengths; different lengths stay separate rows', () => {
    const rows = computeTakeoff(
      [
        lumber('2x4', 2.3), // 7.5 ft → 8 ft
        lumber('2x4', 2.3), // 7.5 ft → 8 ft
        lumber('2x4', 2.3), // 7.5 ft → 8 ft
        lumber('2x4', 4.0, { role: 'top-plate' }), // 13.1 ft → 14 ft
        lumber('2x4', 4.0, { role: 'bottom-plate' }), // 13.1 ft → 14 ft
      ],
      [],
    )
    expect(find(rows, '2x4', '8 ft stock')?.quantity).toBe(3)
    expect(find(rows, '2x4', '14 ft stock')?.quantity).toBe(2)
  })

  test('every stock boundary rounds up correctly', () => {
    const cuts: Array<[number, string]> = [
      [feet(8.01), '10 ft stock'],
      [feet(10.01), '12 ft stock'],
      [feet(12.01), '14 ft stock'],
      [feet(14.01), '16 ft stock'],
      [feet(16.01), '20 ft stock'],
    ]
    for (const [len, expected] of cuts) {
      const rows = computeTakeoff([lumber('2x6', len)], [])
      expect(find(rows, '2x6', expected)?.quantity).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Lumber: board feet (NOMINAL inches on the PURCHASED stick)
// ---------------------------------------------------------------------------

describe('board feet', () => {
  test('2x6 stud at 8 ft stock: 2·6/12 × 8 = 8 bd-ft exactly', () => {
    const rows = computeTakeoff([lumber('2x6', 2.4)], []) // 7.87 ft → 8 ft stock
    expect(find(rows, '2x6', 'board feet')).toEqual({
      section: 'Wall framing',
      item: '2x6',
      detail: 'board feet',
      quantity: 8,
      unit: 'bd-ft',
    })
  })

  test('three 2x4 at 10 ft stock: 3 × (2·4/12) × 10 = 20 bd-ft', () => {
    const studs = [lumber('2x4', 2.5), lumber('2x4', 2.5), lumber('2x4', 2.5)]
    const rows = computeTakeoff(studs, [])
    expect(find(rows, '2x4', 'board feet')?.quantity).toBe(20)
  })

  test('4x10 header at 12 ft stock: 4·10/12 × 12 = 40 bd-ft (nominal, not dressed)', () => {
    const rows = computeTakeoff([lumber('4x10', feet(11), { role: 'header' })], [])
    expect(find(rows, '4x10', 'board feet')?.quantity).toBe(40)
  })

  test('spliced runs bill both purchased sticks: 22 ft 2x12 → 2 × 20 ft = 80 bd-ft', () => {
    const rows = computeTakeoff([lumber('2x12', feet(22))], [])
    // 2 sticks × 20 ft × (2·12/12 = 2 bd-ft/ft) = 80
    expect(find(rows, '2x12', 'board feet')?.quantity).toBe(80)
  })

  test('mixed stock lengths accumulate into one bd-ft row per size', () => {
    const rows = computeTakeoff([lumber('2x4', 2.3), lumber('2x4', 2.5)], []) // 8 ft + 10 ft
    // (2·4/12) × (8 + 10) = 12 bd-ft
    expect(find(rows, '2x4', 'board feet')?.quantity).toBe(12)
    expect(rows.filter((r) => r.item === '2x4' && r.detail === 'board feet')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Lumber: ordering + filtering
// ---------------------------------------------------------------------------

describe('lumber row ordering', () => {
  test('sizes order 2x4 → 2x6 → 4x8 regardless of member order', () => {
    const rows = computeTakeoff(
      [lumber('4x8', 1.2, { role: 'header' }), lumber('2x4', 2.4), lumber('2x6', 2.4)],
      [],
    )
    const sizeOrder = rows.filter((r) => r.detail === 'board feet').map((r) => r.item)
    expect(sizeOrder).toEqual(['2x4', '2x6', '4x8'])
  })

  test('within a size: stock rows ascend, board-feet row comes last', () => {
    const rows = computeTakeoff([lumber('2x4', 2.5), lumber('2x4', 2.3)], []).filter(
      (r) => r.item === '2x4',
    )
    expect(rows.map((r) => r.detail)).toEqual(['8 ft stock', '10 ft stock', 'board feet'])
  })

  test('pressure-treated mudsills count as lumber ON THEIR OWN PT row; steel and concrete never do', () => {
    const rows = computeTakeoff(
      [
        lumber('2x6', 2.3, { material: 'pt-lumber', role: 'mudsill', system: 'foundation' }),
        mem({ material: 'steel', role: 'anchor-bolt', size: undefined, length: 0.25 }),
        concrete([1, 0.3, 0.4]),
      ],
      [],
    )
    // PT is a different SKU — never blended into the untreated count.
    expect(find(rows, '2x6 PT', '8 ft stock (pressure-treated)')?.quantity).toBe(1)
    expect(find(rows, '2x6', '8 ft stock')).toBeUndefined()
    // exactly one lumber size section (one board-feet row)
    expect(rows.filter((r) => r.detail === 'board feet')).toHaveLength(1)
  })

  test('PT and untreated sticks of one size book side by side, PT after untreated', () => {
    const rows = computeTakeoff(
      [
        lumber('2x6', 2.3),
        lumber('2x6', 2.3, { material: 'pt-lumber', role: 'mudsill' }),
      ],
      [],
    )
    expect(find(rows, '2x6', '8 ft stock')?.quantity).toBe(1)
    expect(find(rows, '2x6 PT', '8 ft stock (pressure-treated)')?.quantity).toBe(1)
    const items = rows.filter((r) => r.detail.startsWith('8 ft stock')).map((r) => r.item)
    expect(items).toEqual(['2x6', '2x6 PT'])
    expect(rows.filter((r) => r.detail === 'board feet')).toHaveLength(2)
  })

  test('members without a nominal size are not lumber rows', () => {
    const rows = computeTakeoff([mem({ size: undefined, material: 'pvc', role: 'pipe-run' })], [])
    expect(rows.filter((r) => r.detail === 'board feet')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Concrete + CMU
// ---------------------------------------------------------------------------

describe('concrete', () => {
  test('sums member volumes and converts m³ → yd³ at 1.30795, 1 decimal', () => {
    // two footing runs of exactly 1 m³ each → 2 m³ = 2.6159 yd³ → 2.6
    const rows = computeTakeoff([concrete([2, 0.5, 1]), concrete([2, 0.5, 1])], [])
    expect(find(rows, 'Concrete')).toEqual({
      section: 'Foundation',
      item: 'Concrete',
      detail: 'footings',
      quantity: 2.6,
      unit: 'yd³',
    })
  })

  test('foundation pours split by ELEMENT: footing / stemwall / slab edge', () => {
    const rows = computeTakeoff(
      [
        concrete([2, 0.5, 1]), // footing, 1 m³
        concrete([2, 0.4, 0.5], { role: 'stemwall' }), // 0.4 m³
        concrete([2, 0.3, 0.3], { role: 'slab-edge' }), // 0.18 m³
      ],
      [],
    )
    expect(find(rows, 'Concrete', 'footings')?.quantity).toBeCloseTo(1.3, 5)
    expect(find(rows, 'Concrete', 'stemwalls')?.quantity).toBeCloseTo(0.5, 5)
    expect(find(rows, 'Concrete', 'slab edge')?.quantity).toBeCloseTo(0.2, 5)
    for (const detail of ['footings', 'stemwalls', 'slab edge']) {
      expect(find(rows, 'Concrete', detail)?.section).toBe('Foundation')
    }
  })

  test('CMU blocks are counted each and excluded from the poured yardage', () => {
    const block = concrete([0.406, 0.203, 0.203], { role: 'block' })
    const rows = computeTakeoff([block, block, block], [])
    expect(find(rows, 'CMU block')?.quantity).toBe(3)
    expect(find(rows, 'CMU block')?.unit).toBe('pcs')
    expect(find(rows, 'Concrete')).toBeUndefined() // blocks alone pour nothing
  })

  test('non-foundation pours (CMU lintels) pool per their own section', () => {
    const rows = computeTakeoff(
      [
        concrete([2, 0.5, 1]), // foundation footing
        concrete([1.2, 0.19, 0.19], { role: 'lintel', system: 'wall-framing' }),
      ],
      [],
    )
    expect(find(rows, 'Concrete', 'footings')?.section).toBe('Foundation')
    const lintelRow = find(rows, 'Concrete', 'lintels/beams')
    expect(lintelRow?.section).toBe('Wall framing')
    expect(lintelRow?.quantity).toBe(0.1) // 0.0433 m³ floors at the 0.1 yd³ batch
  })

  test('a real but tiny pour never rounds to 0.0 yd³', () => {
    const rows = computeTakeoff([concrete([0.3, 0.19, 0.19], { role: 'lintel' })], [])
    expect(find(rows, 'Concrete')?.quantity).toBe(0.1)
  })
})

// ---------------------------------------------------------------------------
// Steel hardware
// ---------------------------------------------------------------------------

describe('steel hardware', () => {
  const bolt = mem({ role: 'anchor-bolt', material: 'steel', size: undefined, length: 0.25 })
  const hd = mem({ role: 'hold-down', material: 'steel', size: undefined, length: 0.35 })
  const tie = mem({
    system: 'roof-framing',
    role: 'blocking',
    material: 'steel',
    size: undefined,
    length: 0.1,
  })

  test('anchor bolts, hold-downs, and hurricane ties (role+material+system) count each', () => {
    const rows = computeTakeoff([bolt, bolt, bolt, bolt, bolt, hd, hd, tie, tie, tie], [])
    expect(find(rows, 'Anchor bolts')?.quantity).toBe(5)
    expect(find(rows, 'Hold-downs')?.quantity).toBe(2)
    expect(find(rows, 'Hurricane ties')?.quantity).toBe(3)
    for (const item of ['Anchor bolts', 'Hold-downs', 'Hurricane ties']) {
      expect(find(rows, item)?.unit).toBe('pcs')
    }
  })

  test('anchor bolts split per system: foundation mudsill vs mixed-wall seam sill', () => {
    const foundationBolt = mem({
      system: 'foundation',
      role: 'anchor-bolt',
      material: 'steel',
      size: undefined,
      length: 0.25,
    })
    const rows = computeTakeoff([bolt, bolt, foundationBolt, foundationBolt, foundationBolt], [])
    const seam = rows.find((r) => r.item === 'Anchor bolts' && r.section === 'Wall framing')
    const mudsill = rows.find((r) => r.item === 'Anchor bolts' && r.section === 'Foundation')
    expect(seam?.quantity).toBe(2)
    expect(seam?.detail).toBe('seam sill to bond beam (R403.1.6)')
    expect(mudsill?.quantity).toBe(3)
    expect(mudsill?.detail).toBe('mudsill anchorage (R403.1.6)')
  })

  test('hardware rows are omitted when absent', () => {
    const rows = computeTakeoff([lumber('2x4', 2.4)], [])
    expect(find(rows, 'Anchor bolts')).toBeUndefined()
    expect(find(rows, 'Hold-downs')).toBeUndefined()
    expect(find(rows, 'Hurricane ties')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

describe('flags', () => {
  test('one FLAG row per distinct flag text, quantity = occurrences', () => {
    const engineered = 'ENGINEERED BEAM REQUIRED — exceeds prescriptive header span'
    const rows = computeTakeoff(
      [
        lumber('4x12', 3.2, { role: 'header', flag: engineered }),
        lumber('4x12', 3.4, { role: 'header', flag: engineered }),
        lumber('2x4', 2.4, { flag: 'Curved wall approximated' }),
      ],
      [],
    )
    const flagRows = rows.filter((r) => r.item === 'FLAG')
    expect(flagRows).toHaveLength(2)
    expect(find(rows, 'FLAG', engineered)?.quantity).toBe(2)
    expect(find(rows, 'FLAG', 'Curved wall approximated')?.quantity).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe('fixtures', () => {
  test('one row per kind present, counted', () => {
    const rows = computeTakeoff(
      [],
      [
        fixture('receptacle'),
        fixture('receptacle'),
        fixture('receptacle'),
        fixture('receptacle-gfci'),
        fixture('receptacle-gfci'),
        fixture('switch'),
        fixture('light'),
        fixture('light'),
        fixture('smoke-alarm'),
        fixture('register', { system: 'hvac' }),
        fixture('register', { system: 'hvac' }),
      ],
    )
    expect(find(rows, 'Receptacles')?.quantity).toBe(3)
    expect(find(rows, 'GFCI receptacles')?.quantity).toBe(2)
    expect(find(rows, 'Switches')?.quantity).toBe(1)
    expect(find(rows, 'Lights')?.quantity).toBe(2)
    expect(find(rows, 'Smoke alarms')?.quantity).toBe(1)
    expect(find(rows, 'Supply registers')?.quantity).toBe(2)
    expect(rows.every((r) => r.unit === 'pcs')).toBe(true)
  })

  test('absent kinds emit no row', () => {
    const rows = computeTakeoff([], [fixture('receptacle')])
    expect(find(rows, 'Switches')).toBeUndefined()
    // one device row + its 1-gang box row
    expect(rows).toHaveLength(2)
    expect(find(rows, 'Device boxes (1-gang)')?.quantity).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Empty input + serializers
// ---------------------------------------------------------------------------

describe('computeTakeoff — empty', () => {
  test('no members, no fixtures → no rows', () => {
    expect(computeTakeoff([], [])).toEqual([])
  })
})

describe('takeoffCsv', () => {
  test('header + plain rows serialize unquoted', () => {
    const csv = takeoffCsv([
      { section: 'Wall framing', item: '2x4', detail: '8 ft stock', quantity: 3, unit: 'pcs' },
    ])
    expect(csv).toBe('section,item,detail,quantity,unit\nWall framing,2x4,8 ft stock,3,pcs')
  })

  test('commas in detail are quoted (flag text with commas survives)', () => {
    const csv = takeoffCsv([
      {
        section: 'Flags',
        item: 'FLAG',
        detail: 'Span exceeds table, engineer required',
        quantity: 1,
        unit: 'ea',
      },
    ])
    expect(csv.split('\n')[1]).toBe('Flags,FLAG,"Span exceeds table, engineer required",1,ea')
  })

  test('double quotes inside a field are doubled per RFC 4180', () => {
    const csv = takeoffCsv([
      { section: 'Flags', item: 'FLAG', detail: 'Header over "D101", verify', quantity: 1, unit: 'ea' },
    ])
    expect(csv.split('\n')[1]).toBe('Flags,FLAG,"Header over ""D101"", verify",1,ea')
  })

  test('end-to-end: computeTakeoff rows round-trip into parseable CSV lines', () => {
    const rows = computeTakeoff([lumber('2x4', 2.5)], [fixture('receptacle')])
    const lines = takeoffCsv(rows).split('\n')
    expect(lines[0]).toBe('section,item,detail,quantity,unit')
    expect(lines).toContain('Wall framing,2x4,10 ft stock,1,pcs')
    expect(lines).toContain('Electrical,Receptacles,NEC 210.52 spacing,1,pcs')
  })
})

describe('takeoffMarkdown', () => {
  test('emits a pipe table with header, alignment row, and one line per row', () => {
    const md = takeoffMarkdown([
      { section: 'Wall framing', item: '2x4', detail: '10 ft stock', quantity: 4, unit: 'pcs' },
      { section: 'Wall framing', item: '2x4', detail: 'board feet', quantity: 26.7, unit: 'bd-ft' },
    ])
    const lines = md.split('\n')
    expect(lines[0]).toBe('| Section | Item | Detail | Quantity | Unit |')
    expect(lines[1]).toBe('| --- | --- | --- | ---: | --- |')
    expect(lines[2]).toBe('| Wall framing | 2x4 | 10 ft stock | 4 | pcs |')
    expect(lines[3]).toBe('| Wall framing | 2x4 | board feet | 26.7 | bd-ft |')
  })

  test('pipes inside detail text are escaped so the table cannot break', () => {
    const md = takeoffMarkdown([
      { section: 'Flags', item: 'FLAG', detail: 'a|b', quantity: 1, unit: 'ea' },
    ])
    expect(md.split('\n')[2]).toBe('| Flags | FLAG | a\\|b | 1 | ea |')
  })
})

// ---------------------------------------------------------------------------
// Round-1 fabrication features (sections, sheets, fasteners, MEP lf, cut list)
// ---------------------------------------------------------------------------

import { cutList, cutListCsv } from './takeoff'

describe('per-system sections', () => {
  test('every row carries a section; lumber splits by originating system', () => {
    const rows = computeTakeoff(
      [
        lumber('2x4', 2.4), // wall-framing
        lumber('2x10', 3.5, { system: 'floor-framing', role: 'joist' }),
        lumber('2x6', 4.0, { system: 'roof-framing', role: 'rafter' }),
        concrete([2, 0.5, 1]), // foundation
      ],
      [fixture('receptacle')],
    )
    for (const r of rows) expect(r.section.length).toBeGreaterThan(0)
    expect(find(rows, '2x4', 'board feet')?.section).toBe('Wall framing')
    expect(find(rows, '2x10', 'board feet')?.section).toBe('Floor')
    expect(find(rows, '2x6', 'board feet')?.section).toBe('Roof')
    expect(find(rows, 'Concrete')?.section).toBe('Foundation')
    expect(find(rows, 'Receptacles')?.section).toBe('Electrical')
    // sections come out in canonical order
    const order = rows.map((r) => r.section)
    const wall = order.indexOf('Wall framing')
    const roof = order.indexOf('Roof')
    const elec = order.indexOf('Electrical')
    expect(wall).toBeLessThan(roof)
    expect(roof).toBeLessThan(elec)
  })

  test('CSV keeps the section as the first column', () => {
    const rows = computeTakeoff([lumber('2x4', 2.4)], [])
    const lines = takeoffCsv(rows).split('\n')
    expect(lines[1]?.startsWith('Wall framing,')).toBe(true)
  })
})

describe('sheet goods from gross areas', () => {
  test('wall sheathing / subfloor / drywall sheets = ceil(area / 32 ft²)', () => {
    // 60 m² ≈ 645.8 ft² → 21 sheets; 30 m² → 11; 90 m² → 31
    const rows = computeTakeoff([], [], {
      wallSheathingM2: 60,
      subfloorM2: 30,
      drywallM2: 90,
    })
    expect(find(rows, 'Wall sheathing 7/16" WSP')?.quantity).toBe(Math.ceil(60 / (32 / 10.7639)))
    expect(find(rows, 'Subfloor 3/4" T&G')?.quantity).toBe(Math.ceil(30 / (32 / 10.7639)))
    expect(find(rows, 'Drywall 1/2"')?.quantity).toBe(Math.ceil(90 / (32 / 10.7639)))
    for (const item of ['Wall sheathing 7/16" WSP', 'Subfloor 3/4" T&G', 'Drywall 1/2"']) {
      expect(find(rows, item)?.section).toBe('Sheathing')
      expect(find(rows, item)?.unit).toBe('sheets')
    }
  })

  test('no areas → no sheathing section', () => {
    const rows = computeTakeoff([lumber('2x4', 2.4)], [])
    expect(rows.some((r) => r.section === 'Sheathing')).toBe(false)
  })
})

describe('hardware by role (no label regex)', () => {
  test('joist hangers and plate washers get their own lines', () => {
    const hanger = mem({
      system: 'floor-framing',
      role: 'hanger',
      material: 'steel',
      size: undefined,
      length: 0.08,
    })
    const washer = mem({
      system: 'foundation',
      role: 'plate-washer',
      material: 'steel',
      size: undefined,
      length: 0.08,
    })
    const rows = computeTakeoff([hanger, hanger, hanger, washer, washer], [])
    expect(find(rows, 'Joist hangers')?.quantity).toBe(3)
    expect(find(rows, 'Joist hangers')?.section).toBe('Floor')
    expect(find(rows, 'Plate washers 3x3')?.quantity).toBe(2)
    expect(find(rows, 'Plate washers 3x3')?.section).toBe('Foundation')
  })

  test('steel blocking outside the roof system is NOT a hurricane tie', () => {
    const fireStop = mem({ role: 'blocking', material: 'steel', size: undefined })
    const rows = computeTakeoff([fireStop], [])
    expect(find(rows, 'Hurricane ties')).toBeUndefined()
  })
})

describe('fastener schedule (R602.3(1) data × member counts)', () => {
  test('studs drive 16d pounds: 100 studs × 4 nails / 44 per lb ≈ 9.1 lbs', () => {
    const studs = Array.from({ length: 100 }, () => lumber('2x4', 2.4))
    const rows = computeTakeoff(studs, [])
    const nails = find(rows, 'Nails 16d common')
    expect(nails?.section).toBe('Fasteners')
    expect(nails?.unit).toBe('lbs')
    expect(nails?.quantity).toBeCloseTo(round((100 * 4) / 44), 5)
    expect(nails?.detail).toContain('400 nails')
  })

  test('sheathing sheets add 8d nails; hangers add 10d', () => {
    const hanger = mem({
      system: 'floor-framing',
      role: 'hanger',
      material: 'steel',
      size: undefined,
    })
    const rows = computeTakeoff([hanger], [], { wallSheathingM2: 10 })
    expect(find(rows, 'Nails 8d common')).toBeDefined() // 4 sheets × 44
    expect(find(rows, 'Nails 10d common')?.detail).toContain('10 nails')
  })

  function round(n: number): number {
    return Math.max(0.5, Math.round(n * 10) / 10)
  }
})

describe('MEP linear feet + rebar/grout/mortar', () => {
  test('pipe by size and material, duct by section, wire by gauge', () => {
    const pipe = mem({
      system: 'plumbing',
      role: 'pipe-run',
      material: 'pvc',
      size: undefined,
      dims: [3.048, 0.0762, 0.0762], // 10 ft of 3"
      length: 3.048,
    })
    const supply = mem({
      system: 'plumbing',
      role: 'pipe-run',
      material: 'copper',
      size: undefined,
      dims: [1.524, 0.0127, 0.0127], // 5 ft of ½"
      length: 1.524,
    })
    const trunk = mem({
      system: 'hvac',
      role: 'duct-run',
      material: 'duct',
      size: undefined,
      dims: [6.096, 0.2032, 0.3556], // 20 ft of 14×8
      length: 6.096,
    })
    const wire = mem({
      system: 'electrical',
      role: 'wire-run',
      material: 'copper',
      size: undefined,
      dims: [3.048, 0.0127, 0.0127],
      length: 3.048,
      label: 'NM-B 12/2 w/G — SA-1',
    })
    // Square-section members: a step-down TRUNK stays rectangular sheet
    // metal ('Trunk…' label contract); an unlabeled branch of equal sides
    // is round flex (round-10: shape alone can't tell 8×8 square from 8" ø).
    const squareTrunk = mem({
      system: 'hvac',
      role: 'duct-run',
      material: 'duct',
      size: undefined,
      dims: [3.048, 0.2032, 0.2032], // 10 ft of 8×8
      length: 3.048,
      label: 'Trunk 8"×8"',
    })
    const roundBranch = mem({
      system: 'hvac',
      role: 'duct-run',
      material: 'duct',
      size: undefined,
      dims: [1.524, 0.1524, 0.1524], // 5 ft of 6" round
      length: 1.524,
      label: 'Supply branch — bedroom',
    })
    const rows = computeTakeoff([pipe, supply, trunk, wire, squareTrunk, roundBranch], [])
    expect(find(rows, 'PVC 3"')?.quantity).toBeCloseTo(10, 1)
    expect(find(rows, 'PVC 3"')?.section).toBe('Plumbing')
    expect(find(rows, 'Copper 0.5"')?.quantity).toBeCloseTo(5, 1)
    expect(find(rows, 'Duct 14×8"')?.quantity).toBeCloseTo(20, 1)
    expect(find(rows, 'Duct 14×8"')?.section).toBe('HVAC')
    expect(find(rows, 'Duct 8×8"')?.quantity).toBeCloseTo(10, 1)
    expect(find(rows, 'Duct 8" round')).toBeUndefined()
    expect(find(rows, 'Duct 6" round')?.quantity).toBeCloseTo(5, 1)
    expect(find(rows, 'NM-B 12/2 w/G')?.quantity).toBeCloseTo(10, 1)
    expect(find(rows, 'NM-B 12/2 w/G')?.section).toBe('Electrical')
    for (const item of ['PVC 3"', 'Copper 0.5"', 'Duct 14×8"', 'NM-B 12/2 w/G']) {
      expect(find(rows, item)?.unit).toBe('lf')
    }
  })

  test('rebar linear feet by system; grout + mortar from the block counts', () => {
    const bar = mem({
      system: 'wall-framing',
      role: 'rebar',
      material: 'steel',
      size: undefined,
      dims: [0.0159, 2.1336, 0.0159],
      length: 2.1336, // 7 ft
    })
    const block = concrete([0.397, 0.194, 0.194], { system: 'wall-framing', role: 'block' })
    const grouted = concrete([0.397, 0.194, 0.194], {
      system: 'wall-framing',
      role: 'block',
      label: 'grouted cell + vertical rebar',
      grouted: true,
    })
    // Label-only decoy: grout must key off the dedicated `grouted` field,
    // never off label strings (round-10: label coupling broke on rewording).
    const decoy = concrete([0.397, 0.194, 0.194], {
      system: 'wall-framing',
      role: 'block',
      label: 'mentions grouted but is not',
    })
    const rows = computeTakeoff([bar, bar, block, grouted, decoy], [])
    const rebar = find(rows, 'Rebar')
    expect(rebar?.quantity).toBeCloseTo(14, 1)
    expect(rebar?.section).toBe('Wall framing')
    expect(find(rows, 'Mortar (Type S)')?.quantity).toBe(1) // 3 blocks → 1 bag
    expect(find(rows, 'Grout')?.detail).toContain('1 reinforced cells')
    // Numeric pin: 1 cell × 0.0085 m³ × 1.30795 yd³/m³ = 0.011 → floors at 0.1.
    expect(find(rows, 'Grout')?.quantity).toBe(0.1)
    expect(find(rows, 'Grout')?.unit).toBe('yd³')
    // 100 cells: 100 × 0.0085 × 1.30795 = 1.11175 → rounds to 1.1 yd³.
    const many = computeTakeoff(Array.from({ length: 100 }, () => grouted), [])
    expect(find(many, 'Grout')?.quantity).toBeCloseTo(1.1, 5)
  })
})

describe('electrical circuit rows', () => {
  test('circuit meta on fixtures becomes panel-schedule rows', () => {
    const rec = (circuit: string, extra: Record<string, string | number | boolean> = {}) =>
      fixture('receptacle', {
        meta: { circuit, breakerA: 20, gaugeAwg: 12, va: 180, gfci: true, ...extra },
      })
    const rows = computeTakeoff([], [rec('SA-1'), rec('SA-1'), rec('SA-2')])
    const sa1 = find(rows, 'Circuit SA-1')
    expect(sa1?.quantity).toBe(2)
    expect(sa1?.unit).toBe('devices')
    expect(sa1?.detail).toContain('20A / 12 AWG / 360 VA')
    expect(sa1?.detail).toContain('GFCI')
    expect(sa1?.section).toBe('Electrical')
    expect(find(rows, 'Circuit SA-2')?.quantity).toBe(1)
  })
})

describe('cutList — every wood member, exact lengths, grouped', () => {
  test('groups identical (system, size, role, length) and formats ft-in', () => {
    const rows = cutList([
      lumber('2x4', 2.4384), // 8'-0" stud
      lumber('2x4', 2.4384),
      lumber('2x4', 2.4384, { role: 'king-stud' }),
      lumber('2x10', 3.5, { system: 'floor-framing', role: 'joist' }),
      mem({ material: 'steel', role: 'anchor-bolt', size: undefined }), // not wood
    ])
    const studs = rows.find((r) => r.role === 'stud')
    expect(studs?.qty).toBe(2)
    expect(studs?.lengthLabel).toContain("8'")
    expect(rows.find((r) => r.role === 'king-stud')?.qty).toBe(1)
    expect(rows.find((r) => r.role === 'joist')?.section).toBe('Floor')
    expect(rows).toHaveLength(3)
  })

  test('cutListCsv serializes with a header', () => {
    const csv = cutListCsv(cutList([lumber('2x4', 2.4384)]))
    expect(csv.split('\n')[0]).toBe('section,size,role,length,qty')
    expect(csv.split('\n')[1]).toContain('Wall framing,2x4,stud')
  })
})

// ---------------------------------------------------------------------------
// Round-2 fabrication gaps (fittings, boxes, split nail gauges)
// ---------------------------------------------------------------------------

describe('MEP fittings — elbows at each bend, boots, collars', () => {
  const pipeLeg = (sourceId: string, i: number) =>
    mem({
      system: 'plumbing' as const,
      role: 'pipe-run' as const,
      material: 'pvc' as const,
      size: undefined,
      dims: [1 + i * 0.1, 0.0508, 0.0508], // 2" pipe legs
      length: 1 + i * 0.1,
      sourceId,
    })

  test('a chain of n pipe legs yields n−1 elbows, grouped by size', () => {
    // room A routes in 3 legs (2 bends), room B in 2 legs (1 bend)
    const rows = computeTakeoff(
      [pipeLeg('r_a', 0), pipeLeg('r_a', 1), pipeLeg('r_a', 2), pipeLeg('r_b', 0), pipeLeg('r_b', 1)],
      [],
    )
    const elbows = find(rows, 'PVC 2" fittings')
    expect(elbows?.quantity).toBe(3) // 2 + 1
    expect(elbows?.unit).toBe('pcs')
    expect(elbows?.section).toBe('Plumbing')
    expect(elbows?.detail).toContain('elbows')
  })

  test('single straight legs produce no fitting row', () => {
    const rows = computeTakeoff([pipeLeg('r_a', 0)], [])
    expect(find(rows, 'PVC 2" fittings')).toBeUndefined()
  })

  test('duct bends, register boots, and takeoff collars are counted', () => {
    const trunkLeg = (i: number) =>
      mem({
        system: 'hvac' as const,
        role: 'duct-run' as const,
        material: 'duct' as const,
        size: undefined,
        dims: [2, 0.2032, 0.3556], // 14×8
        length: 2,
        sourceId: 'r_equip',
        label: 'Trunk 14×8" — 1000 cfm',
      })
    const branchLeg = (room: string) =>
      mem({
        system: 'hvac' as const,
        role: 'duct-run' as const,
        material: 'duct' as const,
        size: undefined,
        dims: [1.5, 0.1524, 0.1524], // 6" round
        length: 1.5,
        sourceId: room,
        label: '6" branch — 120 cfm',
      })
    const rows = computeTakeoff(
      [trunkLeg(0), trunkLeg(1), branchLeg('r_bed'), branchLeg('r_kitchen')],
      [
        fixture('register', { system: 'hvac', sourceId: 'r_bed' }),
        fixture('register', { system: 'hvac', sourceId: 'r_kitchen' }),
      ],
    )
    expect(find(rows, 'Duct 14×8" fittings')?.quantity).toBe(1) // 2 trunk legs → 1 bend
    expect(find(rows, 'Register boots')?.quantity).toBe(2)
    expect(find(rows, 'Takeoff collars')?.quantity).toBe(2) // 2 branch chains
    expect(find(rows, 'Register boots')?.section).toBe('HVAC')
  })
})

describe('electrical boxes by type', () => {
  test('gang boxes, ceiling boxes, and panel cans from fixture kinds', () => {
    const rows = computeTakeoff(
      [],
      [
        fixture('receptacle'),
        fixture('receptacle-gfci'),
        fixture('switch'),
        fixture('light'),
        fixture('smoke-alarm'),
        fixture('panel'),
      ],
    )
    expect(find(rows, 'Device boxes (1-gang)')?.quantity).toBe(3)
    expect(find(rows, 'Ceiling boxes')?.quantity).toBe(2)
    expect(find(rows, 'Panel cans')?.quantity).toBe(1)
    for (const item of ['Device boxes (1-gang)', 'Ceiling boxes', 'Panel cans']) {
      expect(find(rows, item)?.section).toBe('Electrical')
    }
  })
})

describe('fastener gauges split per the R602.3(1) schedule', () => {
  test('a joist books 16d rim nails AND 10d toe-nails (pinning test)', () => {
    const joist = lumber('2x10', 3.5, { system: 'floor-framing', role: 'joist' })
    const rows = computeTakeoff([joist], [])
    expect(find(rows, 'Nails 16d common')?.detail).toContain('3 nails')
    expect(find(rows, 'Nails 10d common')?.detail).toContain('3 nails')
  })

  test('a rafter books 16d at the ridge AND 10d at the plate — never 6×16d', () => {
    const rafter = lumber('2x6', 4.2, { system: 'roof-framing', role: 'rafter' })
    const rows = computeTakeoff([rafter], [])
    expect(find(rows, 'Nails 16d common')?.detail).toContain('3 nails')
    expect(find(rows, 'Nails 10d common')?.detail).toContain('3 nails')
  })
})

describe('trunk reducers pinned (round-4/5: label-contract classification)', () => {
  test('a stepped trunk books one reducer per size change — even at the square 8" tail', () => {
    const trunkLeg = (w: number) =>
      mem({
        system: 'hvac' as const,
        role: 'duct-run' as const,
        material: 'duct' as const,
        size: undefined,
        dims: [2, 0.2032, w * 0.0254],
        length: 2,
        sourceId: 'r_equip',
        label: `Trunk ${w}×8" — cfm`,
      })
    const rows = computeTakeoff(
      // 14×8 → 12×8 → 8×8: the square tail is STILL a trunk (round-5 —
      // shape-based classification misread it as a round branch)
      [trunkLeg(14), trunkLeg(12), trunkLeg(8)],
      [fixture('register', { system: 'hvac' })],
    )
    expect(find(rows, 'Trunk reducers')?.quantity).toBe(2)
    expect(find(rows, 'Trunk reducers')?.section).toBe('HVAC')
  })
})
