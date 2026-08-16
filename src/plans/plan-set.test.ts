import { describe, expect, test } from 'bun:test'
import type { Fixture, Member } from '../core/types'
import type { BuildingCharacteristics } from '../engines/characteristics'
import { buildPlanSet, planSetHtml } from './plan-set'

const member = (over: Partial<Member>): Member => ({
  system: 'floor-framing',
  role: 'joist',
  size: '2x10',
  dims: [4, 0.235, 0.038],
  length: 4,
  position: [2, -0.3, 1],
  rotation: [0, 0, 0],
  material: 'lumber',
  sourceId: 'slab_1',
  ...over,
})

const fixture = (over: Partial<Fixture>): Fixture => ({
  system: 'electrical',
  kind: 'receptacle',
  position: [1, 0.38, 0],
  rotationY: 0,
  sourceId: 'wall_1',
  ...over,
})

describe('buildPlanSet', () => {
  test('one sheet per system present + schedules; empty systems skipped', () => {
    const members = [
      member({}),
      member({ role: 'girder', size: '4x10' }),
      member({ system: 'wall-framing', role: 'stud', size: '2x4', dims: [0.038, 2.3, 0.089], rotation: [0, Math.PI / 4, 0] }),
      member({ system: 'foundation', role: 'footing', size: undefined, material: 'concrete', dims: [4, 0.2, 0.4] }),
      member({ system: 'roof-framing', role: 'rafter', dims: [3.5, 0.14, 0.038], rotation: [0, Math.PI / 2, 0.7] }),
      member({
        system: 'electrical',
        role: 'wire-run',
        size: undefined,
        material: 'copper',
        dims: [2, 0.013, 0.013],
        label: 'NM-B 12/2 w/G — SA-1',
        sourceId: 'SA-1',
      }),
    ]
    const fixtures = [
      fixture({ meta: { circuit: 'SA-1', breakerA: 20, gaugeAwg: 12 } }),
      fixture({ kind: 'switch' }),
    ]
    const sheets = buildPlanSet(members, fixtures, {
      projectName: 'Demo House',
      levelName: 'Ground Floor',
      jurisdiction: 'FL',
      date: '2026-08-14',
    })
    const titles = sheets.map((s) => s.title)
    expect(titles).toEqual([
      'Cover',
      'Foundation plan',
      'Floor framing plan',
      'Wall framing plan',
      'Roof framing plan',
      'Electrical rough-in plan',
      'South elevation (framing)',
      'North elevation (framing)',
      'East elevation (framing)',
      'West elevation (framing)',
      'Section A-A (transverse)',
      'Schedules + takeoff',
    ])
    // no plumbing/hvac members → no MEP sheet
    expect(titles).not.toContain('Plumbing + HVAC plan')
    for (const s of sheets) {
      expect(s.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
      expect(s.svg).toContain('viewBox="0 0 1056 816"')
      if (s.title === 'Cover') continue // hero layout: title + index, no chrome block
      expect(s.svg).toContain('Demo House')
      expect(s.svg).toContain('Ground Floor')
      expect(s.svg).toContain('Jurisdiction: FL')
      expect(s.svg).toContain('2026-08-14')
      expect(s.svg).toContain('Drafting aid, not engineering')
      // scale bar on drawing sheets only — the text-only schedules sheet
      // dropping it is intentional (quality C1)
      if (!s.title.startsWith('Schedules')) {
        // bar label now carries the snapped ratio: "3 m (1:75)"
        expect(s.svg).toMatch(/>\d+ m \(1:\d+\)<\/text>/)
        // north arrow on PLAN sheets only — elevations/sections have none
        if (!s.title.includes('elevation') && !s.title.startsWith('Section')) {
          expect(s.svg).toContain('>N</text>')
        }
      }
      expect(s.svg).toMatch(/SHEET \d+\/\d+/) // numbering
    }
    // electrical sheet symbolizes devices with tags
    const elec = sheets.find((s) => s.title.startsWith('Electrical'))?.svg ?? ''
    expect(elec).toContain('>R</text>')
    expect(elec).toContain('>S</text>')
    // wires carry their CIRCUIT color + the zone legend
    const { circuitColor } = require('./circuit-colors') as typeof import('./circuit-colors')
    expect(elec).toContain(circuitColor('SA-1'))
    expect(elec).toContain('SA-1')
    expect(elec).toContain('kitchen small-appliance')
    // rotated stud carries its yaw into the plan transform (−45°)
    const wall = sheets.find((s) => s.title.startsWith('Wall'))?.svg ?? ''
    expect(wall).toContain('rotate(-45.00)')
    // sloped rafter is foreshortened in plan: 3.5·cos(0.7)·scale, not full length
    const roof = sheets.find((s) => s.title.startsWith('Roof'))?.svg ?? ''
    expect(roof).toContain('rect')
    // schedules sheet lists takeoff rows
    const sched = sheets.find((s) => s.title.startsWith('Schedules'))?.svg ?? ''
    expect(sched).toContain('Material takeoff')
    expect(sched).toMatch(/2x10/)
  })

  test('engineering flags surface on the schedules sheet', () => {
    const flagged = member({ flag: 'ENGINEERED BEAM REQUIRED — exceeds prescriptive header span' })
    const sched = buildPlanSet([flagged], [], {}).find((s) => s.title.startsWith('Schedules'))
    expect(sched?.svg).toContain('ENGINEERED BEAM REQUIRED')
  })

  test('empty input → no sheets', () => {
    expect(buildPlanSet([], [])).toEqual([])
  })
})

describe('planSetHtml', () => {
  test('paginates every sheet with print CSS', () => {
    const sheets = buildPlanSet([member({})], [], { projectName: 'P' })
    const html = planSetHtml(sheets, { projectName: 'P' })
    expect(html).toContain('@page { size: letter landscape')
    expect(html).toContain('page-break-after: always')
    expect((html.match(/<section class="sheet">/g) ?? []).length).toBe(sheets.length)
    expect(html).toContain('Save as PDF')
    // self-contained: the svg markup is inlined
    expect(html).toContain('viewBox="0 0 1056 816"')
  })
})

describe('cover / elevations / section (round: standard set)', () => {
  test('cover leads with title + sheet index; elevations carry a grade line', () => {
    const members = [
      member({ system: 'wall-framing', role: 'stud', dims: [0.04, 2.4, 0.09], position: [1, 1.2, 0], rotation: [0, 0, 0] }),
      member({ system: 'roof-framing', role: 'rafter', dims: [3, 0.04, 0.09], position: [2, 0.5, 1], rotation: [0, 0, 0.5], levelId: 'lvlroof' }),
    ]
    const sheets = buildPlanSet(members, [], {
      projectName: 'Two Storey',
      levelBaseY: { lvlroof: 5.0 },
    })
    expect(sheets[0]?.title).toBe('Cover')
    expect(sheets[0]?.svg).toContain('SHEET INDEX')
    expect(sheets[0]?.svg).toContain('Two Storey')
    const south = sheets.find((s) => s.title.startsWith('South elevation'))
    expect(south).toBeDefined()
    expect(south?.svg).toContain('GRADE')
    expect(sheets.some((s) => s.title.startsWith('Section A-A'))).toBe(true)
  })
})

describe('MEP sheet — plumbing system colors + slope note (plumbing rebuild)', () => {
  // Distinct positions — identical (role, position, dims) triples would be
  // collapsed by the sheet's dedupeShapes pass.
  let pipeZ = 0
  const pipe = (sourceId: string): Member =>
    member({
      system: 'plumbing',
      role: 'pipe-run',
      size: undefined,
      material: sourceId.startsWith('dwv') ? 'pvc' : 'copper',
      dims: [2, 0.02, 0.02],
      position: [2, 0.4, (pipeZ += 0.5)],
      sourceId,
    })

  test('cold/hot/DWV runs carry their prefix colors; legend + slope note print', () => {
    const members = [pipe('cold-lav'), pipe('hot-lav'), pipe('dwv-main')]
    const fixtures = [
      fixture({
        system: 'plumbing',
        kind: 'water-meter',
        position: [0, 0.3, 0],
        sourceId: 'w_s',
      }),
    ]
    const { PLUMBING_COLORS } = require('./circuit-colors') as typeof import('./circuit-colors')
    const mep = buildPlanSet(members, fixtures, {}).find((s) => s.title.startsWith('Plumbing'))
    expect(mep).toBeDefined()
    const svg = mep?.svg ?? ''
    for (const color of Object.values(PLUMBING_COLORS)) expect(svg).toContain(color)
    // every color on the sheet appears in its legend (invariant P2)
    expect(svg).toContain('supply — cold water')
    expect(svg).toContain('supply — hot water')
    expect(svg).toContain('DWV drain / vent')
    expect(svg).toContain('DWV SLOPE 1/4 IN/FT (P3005.3)')
    // the meter tags with M and the tag is named in the legend
    expect(svg).toContain('>M</text>')
    expect(svg).toContain('water meter')
  })

  test('room-category fallback keeps the single pipe tint (no phantom legend rows)', () => {
    const mep = buildPlanSet([pipe('r_bath')], [], {}).find((s) => s.title.startsWith('Plumbing'))
    const svg = mep?.svg ?? ''
    expect(svg).toContain('supply / DWV pipe')
    expect(svg).not.toContain('supply — cold water')
    expect(svg).toContain('DWV SLOPE 1/4 IN/FT (P3005.3)') // plumbing present → note prints
  })
})

describe('BUILDING CHARACTERISTICS block on the schedules sheet', () => {
  const characteristics: BuildingCharacteristics = {
    floorAreaM2: 40,
    volumeM3: 108,
    envelopeAreaM2: 61.4,
    windowCount: 1,
    windowAreaM2: 1.8,
    doorCount: 1,
    insulation: { climateZone: '2A', wallR: 13, citation: '2021 IECC Table R402.1.3' },
    uaWPerK: 30.1,
    designHeatLossW: 662,
    coolingTonsEstimate: 0.9,
    notes: ['Design heat loss at ΔT = 22 K (winter design assumption)'],
  }

  test('prints the compact metrics block when characteristics are passed', () => {
    const sched = buildPlanSet([member({})], [], { characteristics }).find((s) =>
      s.title.startsWith('Schedules'),
    )
    const svg = sched?.svg ?? ''
    expect(svg).toContain('BUILDING CHARACTERISTICS')
    expect(svg).toContain('Floor area 40.0 m²')
    expect(svg).toContain('Volume 108.0 m³')
    expect(svg).toContain('Envelope 61.4 m²')
    expect(svg).toContain('Climate zone 2A')
    expect(svg).toContain('Wall cavity R-13')
    expect(svg).toContain('Envelope UA 30.1 W/K')
    expect(svg).toContain('Design heat loss 662 W')
    expect(svg).toContain('RULE OF THUMB')
    expect(svg).toContain('2021 IECC Table R402.1.3')
  })

  test('no characteristics option → no block', () => {
    const sched = buildPlanSet([member({})], [], {}).find((s) => s.title.startsWith('Schedules'))
    expect(sched?.svg).not.toContain('BUILDING CHARACTERISTICS')
  })

  test('coexists with flags: block stacks ABOVE the red flag list', () => {
    const flagged = member({ flag: 'ENGINEERED BEAM REQUIRED — exceeds prescriptive header span' })
    const sched = buildPlanSet([flagged], [], { characteristics }).find((s) =>
      s.title.startsWith('Schedules'),
    )
    const svg = sched?.svg ?? ''
    expect(svg).toContain('BUILDING CHARACTERISTICS')
    expect(svg).toContain('ENGINEERED BEAM REQUIRED')
    // the block's lowest line sits above the topmost flag line
    const yOf = (needle: string): number => {
      const at = svg.indexOf(needle)
      const m = /y="([\d.]+)"/.exec(svg.slice(svg.lastIndexOf('<text', at), at))
      return m ? Number(m[1]) : Number.NaN
    }
    expect(yOf('2021 IECC Table R402.1.3')).toBeLessThan(yOf('ENGINEERED BEAM REQUIRED'))
  })

  test('multi-page takeoff: block prints on the LAST schedules page only', () => {
    // enough distinct (system × size × stock length) rows to overflow one
    // schedules page — rows aggregate on that triple
    const many: Member[] = []
    const systems = ['floor-framing', 'wall-framing', 'roof-framing'] as const
    for (let i = 0; i < 400; i++) {
      const len = 0.5 + (i % 80) * 0.09
      many.push(
        member({
          system: systems[i % 3],
          role: i % 2 === 0 ? 'joist' : 'stud',
          size: (['2x4', '2x6', '2x8', '2x10', '2x12', '4x4', '4x6', '4x8'] as const)[i % 8],
          length: len,
          dims: [len, 0.235, 0.038],
          position: [i * 0.1, 0, 1],
        }),
      )
    }
    const sheets = buildPlanSet(many, [], { characteristics }).filter((s) =>
      s.title.startsWith('Schedules'),
    )
    expect(sheets.length).toBeGreaterThan(1)
    for (const [i, s] of sheets.entries()) {
      if (i === sheets.length - 1) expect(s.svg).toContain('BUILDING CHARACTERISTICS')
      else expect(s.svg).not.toContain('BUILDING CHARACTERISTICS')
    }
  })
})

describe('blueprint round-3 — poché, cut mark, legends, wrap, coverage, dowels', () => {
  const stud = (x: number, z: number): Member =>
    member({
      system: 'wall-framing',
      role: 'stud',
      size: '2x4',
      dims: [0.04, 2.4, 0.09],
      position: [x, 1.2, z],
      rotation: [0, 0, 0],
    })

  test('section poché: cut members print dark ×1.3, beyond stay light at 0.6', () => {
    // cutX = (0+4)/2 = 2 — the x=2 stud is CUT (extent contains cutX), the
    // x=1.5 stud is BEYOND (in band), x=0 / x=4 fall outside the band
    const members = [stud(0, 0), stud(2, 1), stud(4, 2), stud(1.5, 3)]
    const svg =
      buildPlanSet(members, [], {}).find((s) => s.title.startsWith('Section A-A'))?.svg ?? ''
    const cut = /<line [^>]*stroke="#222" stroke-width="([\d.]+)" stroke-linecap="round"\/>/.exec(svg)
    const beyond =
      /<line [^>]*stroke="#caa06a" stroke-width="([\d.]+)" stroke-linecap="round" opacity="0.6"\/>/.exec(svg)
    expect(cut).not.toBeNull()
    expect(beyond).not.toBeNull()
    expect(Number(cut?.[1])).toBeCloseTo(Number(beyond?.[1]) * 1.3, 0)
    // out-of-band studs are not drawn: exactly the 2 member lines
    expect([...svg.matchAll(/stroke-linecap="round"/g)]).toHaveLength(2)
  })

  test('A-A cut mark prints on the wall framing plan only, bubbled at both ends', () => {
    const members = [stud(0, 0), stud(2, 1), stud(4, 2), member({})]
    const sheets = buildPlanSet(members, [], {})
    const wall = sheets.find((s) => s.title === 'Wall framing plan')?.svg ?? ''
    expect(wall).toContain('stroke-dasharray="9 4"')
    expect([...wall.matchAll(/>A<\/text>/g)]).toHaveLength(2)
    const floor = sheets.find((s) => s.title === 'Floor framing plan')?.svg ?? ''
    expect(floor).not.toContain('stroke-dasharray="9 4"')
  })

  test('cover/elevations/section carry stroke legends for the systems each draws', () => {
    const members = [
      stud(4.8, 0),
      stud(5, 1),
      stud(5.2, 2),
      stud(0, 3),
      member({
        system: 'roof-framing',
        role: 'rafter',
        dims: [3, 0.14, 0.04],
        position: [5, 2.8, 1],
        rotation: [0, 0, 0.4],
      }),
      // vertical pipe OUT of the cut band (x=10; cutX stays 5)
      member({
        system: 'plumbing',
        role: 'pipe-run',
        size: undefined,
        material: 'pvc',
        dims: [0.05, 2, 0.05],
        position: [10, 1, 1],
      }),
    ]
    const sheets = buildPlanSet(members, [], {})
    const south = sheets.find((s) => s.title.startsWith('South elevation'))?.svg ?? ''
    expect(south).toContain('>wall framing</text>')
    expect(south).toContain('>roof framing</text>')
    expect(south).toContain('>plumbing</text>')
    expect(south).toContain('fill="#6f8fa8"')
    // the section legend lists only the systems inside the cut band
    const section = sheets.find((s) => s.title.startsWith('Section A-A'))?.svg ?? ''
    expect(section).toContain('>wall framing</text>')
    expect(section).not.toContain('>plumbing</text>')
    expect(sheets[0]?.svg ?? '').toContain('>wall framing</text>') // cover
  })

  test('long takeoff rows wrap at a word boundary — never a mid-word ellipsis', () => {
    const bolts: Member[] = []
    for (let i = 0; i < 12; i++) {
      bolts.push(
        member({
          system: 'foundation',
          role: 'anchor-bolt',
          size: undefined,
          material: 'steel',
          dims: [0.016, 0.23, 0.016],
          length: 0.23,
          position: [i * 0.8, -0.05, 0],
        }),
      )
    }
    const svg =
      buildPlanSet(bolts, [], {}).find((s) => s.title.startsWith('Schedules'))?.svg ?? ''
    // the R403.1.6 citation survives intact on the wrapped second line
    expect(svg).toContain('(R403.1.6))')
    expect(svg).not.toMatch(/R40[^)<]*…/)
    // continuation line is indented 14px into the column
    expect(svg).toContain('<text x="62"')
  })

  test('roof plan flags <60% roof coverage; full coverage stays clean', () => {
    const shell = [stud(0, 0), stud(10, 0), stud(10, 8), stud(0, 8)]
    const rafter = (dims: [number, number, number], x: number, z: number, rz = 0): Member =>
      member({ system: 'roof-framing', role: 'rafter', dims, position: [x, 2.6, z], rotation: [0, 0, rz] })
    const sheets = buildPlanSet(
      [...shell, rafter([2, 0.14, 0.04], 1, 0.5, 0.3), rafter([2, 0.14, 0.04], 1, 1.5, 0.3)],
      [],
      {},
    )
    const roof = sheets.find((s) => s.title === 'Roof framing plan')?.svg ?? ''
    expect(roof).toContain('no roof members')
    expect(roof).toContain('check roof coverage')
    // the warning also joins the schedules flag block (opts.warnings path)
    const sched = sheets.find((s) => s.title.startsWith('Schedules'))?.svg ?? ''
    expect(sched).toContain('part of the plan has no roof members')
    const clean = buildPlanSet(
      [...shell, rafter([10.2, 0.14, 0.04], 5, 0), rafter([10.2, 0.14, 0.04], 5, 8)],
      [],
      {},
    )
    expect(clean.find((s) => s.title === 'Roof framing plan')?.svg ?? '').not.toContain(
      'check roof coverage',
    )
  })

  test('foundation plan: OPEN circles for rebar dowels, FILLED dots for bolts', () => {
    const steel = (role: Member['role'], dims: [number, number, number], x: number): Member =>
      member({
        system: 'foundation',
        role,
        size: undefined,
        material: 'steel',
        dims,
        length: Math.max(...dims),
        position: [x, -0.2, 0],
      })
    const members = [
      member({ system: 'foundation', role: 'footing', size: undefined, material: 'concrete', dims: [4, 0.2, 0.4], position: [2, -0.3, 0] }),
      steel('anchor-bolt', [0.016, 0.23, 0.016], 1),
      steel('anchor-bolt', [0.016, 0.23, 0.016], 3),
      steel('rebar', [0.013, 0.55, 0.013], 1.5),
      steel('rebar', [0.013, 0.55, 0.013], 2.5),
      // horizontal continuous bar keeps its rect — only VERTICAL dowels circle
      steel('rebar', [4, 0.013, 0.013], 2),
    ]
    const svg =
      buildPlanSet(members, [], {}).find((s) => s.title === 'Foundation plan')?.svg ?? ''
    // 2 dowels drawn open + 1 legend swatch
    expect([...svg.matchAll(/r="2\.6" fill="none"/g)]).toHaveLength(3)
    // 2 bolts drawn filled + 1 legend swatch
    expect([...svg.matchAll(/r="2\.2" fill="#444"/g)]).toHaveLength(3)
    expect(svg).toContain('vertical rebar dowels — 2 pcs')
  })
})

describe('elevation orientation + section membership (blueprint round-2)', () => {
  test('east elevation puts north (−z) on screen-right; west mirrors it', () => {
    // two studs on an east wall: zNear=1, zFar=7 — standing EAST, the z=7
    // (south) stud must print LEFT of the z=1 stud
    const members = [
      member({ system: 'wall-framing', role: 'stud', dims: [0.04, 2.4, 0.09], position: [8, 1.2, 1], rotation: [0, 0, 0] }),
      member({ system: 'wall-framing', role: 'stud', dims: [0.04, 2.4, 0.09], position: [8, 1.2, 7], rotation: [0, 0, 0] }),
    ]
    const sheets = buildPlanSet(members, [], {})
    const east = sheets.find((s) => s.title.startsWith('East elevation'))
    const xs = [...(east?.svg.matchAll(/<line x1="([\d.]+)"/g) ?? [])].map((m2) => Number(m2[1]))
    expect(xs.length).toBeGreaterThanOrEqual(2)
    // both studs are vertical lines; the SECOND member (z=7) must be left
    expect(xs[1]).toBeLessThan(xs[0] as number)
  })

  test('section includes walls whose extent crosses the cut band', () => {
    // long wall plate centered away from the cut midpoint but crossing it
    const members = [
      member({ system: 'wall-framing', role: 'bottom-plate', dims: [10, 0.04, 0.09], position: [5, 0.02, 0], rotation: [0, 0, 0] }),
      member({ system: 'wall-framing', role: 'stud', dims: [0.04, 2.4, 0.09], position: [0.2, 1.2, 4], rotation: [0, 0, 0] }),
    ]
    const sheets = buildPlanSet(members, [], {})
    const section = sheets.find((s) => s.title.startsWith('Section A-A'))
    // the plate's extent crosses cutX=~2.6 even though its center (5,0) is
    // outside the band — it must be drawn (>=1 line beyond the grade line)
    const lines = [...(section?.svg.matchAll(/<line /g) ?? [])]
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })
})
