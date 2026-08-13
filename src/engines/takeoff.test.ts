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

  test('pressure-treated mudsills count as lumber; steel and concrete never do', () => {
    const rows = computeTakeoff(
      [
        lumber('2x6', 2.3, { material: 'pt-lumber', role: 'mudsill', system: 'foundation' }),
        mem({ material: 'steel', role: 'anchor-bolt', size: undefined, length: 0.25 }),
        concrete([1, 0.3, 0.4]),
      ],
      [],
    )
    expect(find(rows, '2x6', '8 ft stock')?.quantity).toBe(1)
    // exactly one lumber size section (one board-feet row)
    expect(rows.filter((r) => r.detail === 'board feet')).toHaveLength(1)
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
      item: 'Concrete',
      detail: 'footings/stem/lintels',
      quantity: 2.6,
      unit: 'yd³',
    })
  })

  test('CMU blocks are counted each and excluded from the poured yardage', () => {
    const block = concrete([0.406, 0.203, 0.203], { role: 'block' })
    const rows = computeTakeoff([block, block, block], [])
    expect(find(rows, 'CMU block')?.quantity).toBe(3)
    expect(find(rows, 'CMU block')?.unit).toBe('pcs')
    expect(find(rows, 'Concrete')).toBeUndefined() // blocks alone pour nothing
  })

  test('lintels (concrete, non-block) contribute volume alongside footings', () => {
    const rows = computeTakeoff(
      [concrete([2, 0.5, 1]), concrete([1.2, 0.19, 0.19], { role: 'lintel' })],
      [],
    )
    // 1 + 0.04332 = 1.04332 m³ × 1.30795 = 1.3646 → 1.4
    expect(find(rows, 'Concrete')?.quantity).toBeCloseTo(1.4, 5)
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
    role: 'blocking',
    material: 'steel',
    size: undefined,
    length: 0.1,
    label: 'Hurricane tie @ rafter 3',
  })

  test('anchor bolts, hold-downs, and hurricane ties (label match) count each', () => {
    const rows = computeTakeoff([bolt, bolt, bolt, bolt, bolt, hd, hd, tie, tie, tie], [])
    expect(find(rows, 'Anchor bolts')?.quantity).toBe(5)
    expect(find(rows, 'Hold-downs')?.quantity).toBe(2)
    expect(find(rows, 'Hurricane ties')?.quantity).toBe(3)
    for (const item of ['Anchor bolts', 'Hold-downs', 'Hurricane ties']) {
      expect(find(rows, item)?.unit).toBe('pcs')
    }
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
    expect(rows).toHaveLength(1)
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
    const csv = takeoffCsv([{ item: '2x4', detail: '8 ft stock', quantity: 3, unit: 'pcs' }])
    expect(csv).toBe('item,detail,quantity,unit\n2x4,8 ft stock,3,pcs')
  })

  test('commas in detail are quoted (flag text with commas survives)', () => {
    const csv = takeoffCsv([
      { item: 'FLAG', detail: 'Span exceeds table, engineer required', quantity: 1, unit: 'ea' },
    ])
    expect(csv.split('\n')[1]).toBe('FLAG,"Span exceeds table, engineer required",1,ea')
  })

  test('double quotes inside a field are doubled per RFC 4180', () => {
    const csv = takeoffCsv([
      { item: 'FLAG', detail: 'Header over "D101", verify', quantity: 1, unit: 'ea' },
    ])
    expect(csv.split('\n')[1]).toBe('FLAG,"Header over ""D101"", verify",1,ea')
  })

  test('end-to-end: computeTakeoff rows round-trip into parseable CSV lines', () => {
    const rows = computeTakeoff([lumber('2x4', 2.5)], [fixture('receptacle')])
    const lines = takeoffCsv(rows).split('\n')
    expect(lines[0]).toBe('item,detail,quantity,unit')
    expect(lines).toContain('2x4,10 ft stock,1,pcs')
    expect(lines).toContain('Receptacles,NEC 210.52 spacing,1,pcs')
  })
})

describe('takeoffMarkdown', () => {
  test('emits a pipe table with header, alignment row, and one line per row', () => {
    const md = takeoffMarkdown([
      { item: '2x4', detail: '10 ft stock', quantity: 4, unit: 'pcs' },
      { item: '2x4', detail: 'board feet', quantity: 26.7, unit: 'bd-ft' },
    ])
    const lines = md.split('\n')
    expect(lines[0]).toBe('| Item | Detail | Quantity | Unit |')
    expect(lines[1]).toBe('| --- | --- | ---: | --- |')
    expect(lines[2]).toBe('| 2x4 | 10 ft stock | 4 | pcs |')
    expect(lines[3]).toBe('| 2x4 | board feet | 26.7 | bd-ft |')
  })

  test('pipes inside detail text are escaped so the table cannot break', () => {
    const md = takeoffMarkdown([{ item: 'FLAG', detail: 'a|b', quantity: 1, unit: 'ea' }])
    expect(md.split('\n')[2]).toBe('| FLAG | a\\|b | 1 | ea |')
  })
})
