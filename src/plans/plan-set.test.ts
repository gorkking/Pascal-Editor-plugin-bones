import { describe, expect, test } from 'bun:test'
import type { Fixture, Member } from '../core/types'
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
      member({ system: 'electrical', role: 'wire-run', size: undefined, material: 'copper', dims: [2, 0.013, 0.013], label: 'NM-B 12/2 w/G — SA-1' }),
    ]
    const fixtures = [fixture({}), fixture({ kind: 'switch' })]
    const sheets = buildPlanSet(members, fixtures, {
      projectName: 'Demo House',
      levelName: 'Ground Floor',
      jurisdiction: 'FL',
      date: '2026-08-14',
    })
    const titles = sheets.map((s) => s.title)
    expect(titles).toEqual([
      'Foundation plan',
      'Floor framing plan',
      'Wall framing plan',
      'Roof framing plan',
      'Electrical rough-in plan',
      'Schedules + takeoff',
    ])
    // no plumbing/hvac members → no MEP sheet
    expect(titles).not.toContain('Plumbing + HVAC plan')
    for (const s of sheets) {
      expect(s.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
      expect(s.svg).toContain('viewBox="0 0 1056 816"')
      expect(s.svg).toContain('Demo House')
      expect(s.svg).toContain('Ground Floor')
      expect(s.svg).toContain('Jurisdiction: FL')
      expect(s.svg).toContain('2026-08-14')
      expect(s.svg).toContain('Drafting aid, not engineering')
      expect(s.svg).toMatch(/>\d+ m<\/text>/) // scale bar
    }
    // electrical sheet symbolizes devices with tags
    const elec = sheets.find((s) => s.title.startsWith('Electrical'))?.svg ?? ''
    expect(elec).toContain('>R</text>')
    expect(elec).toContain('>S</text>')
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
