import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * Sidebar composition gates (user round 2026-08-20) — the panel drags the
 * host editor/viewer barrels, which cannot evaluate under bun test, so these
 * are source-level assertions on the component tree (the sanctioned
 * grep-level form for this harness):
 *  - Change B: the "Place service points" button is GONE from the sidebar;
 *  - Change C: the per-wall engineering card is GONE from the sidebar and
 *    lives only on the floating inspector extension (full option parity);
 *  - Change A/D: activation + the tri-state view control are wired through
 *    the click-scoped activation module — no mount-time wall-mode magic.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('sidebar panel composition (source gates)', () => {
  const panel = read('./panel.tsx')

  test('Change B: no service-points section or placement button', () => {
    expect(panel).not.toContain('ServicePointsSection')
    expect(panel).not.toContain('Place service points')
    expect(panel).not.toContain('buildServicePointNodes')
  })

  test('Change C: no per-wall engineering card in the sidebar', () => {
    expect(panel).not.toContain('SelectedWallCard')
    expect(panel).not.toContain('selectedWallInfo')
    expect(panel).not.toContain('Exterior finish')
  })

  test('Change A: create/remove ride the click-scoped activation module', () => {
    expect(panel).toContain('activateXray(')
    expect(panel).toContain('removeXray(')
    expect(panel).not.toContain('setWallMode') // no direct wall-mode writes
  })

  test('Change D/E: the tri-state view control replaces the seeThrough toggle', () => {
    expect(panel).toContain('setXrayViewMode(')
    expect(panel).toContain("value: 'off'")
    expect(panel).toContain("value: 'xray'")
    expect(panel).toContain("value: 'basement'")
    expect(panel).not.toContain('seeThrough') // legacy toggle fully retired
    expect(panel).not.toContain('X-ray vision')
  })

  // Day-9 round: 'Basement' misleads on upper storeys (the mode shows the
  // floor framing below THIS storey) — the LABEL becomes 'Subfloor'.
  // INTENDED-CHANGE: the persisted schema value 'basement' does NOT migrate
  // (the `value: 'basement'` pin above still holds).
  test("day-9 rename: the third view-mode option reads 'Subfloor', value stays 'basement'", () => {
    expect(panel).toContain("{ label: 'Subfloor', value: 'basement' }")
    expect(panel).not.toContain("label: 'Basement'")
  })
})

test('C5: the plan-set export passes the gross-fallback areas (one source of truth)', () => {
  const src = readFileSync(new URL('./panel.tsx', import.meta.url), 'utf8')
  expect(src).toContain('areas: result.areas')
})

describe('jurisdiction notes reach the PANEL (the CA territories\u2019 PERMAFROST channel)', () => {
  const panel = read('./panel.tsx')

  test('the picker receives AND renders profile.notes \u2014 the channel exists end-to-end', () => {
    // profileFor builds `Frost: \u2026` / `Snow: \u2026` strings (incl. the
    // territories' PERMAFROST warning) into profile.notes; before 2026-08-24
    // NOTHING rendered them \u2014 the warning lived only in the data file.
    // Source gate (the sanctioned grep-level form for this harness): the
    // call site passes them and the component prints them.
    expect(panel).toContain('notes={profile.notes}')
    expect(panel).toContain('{notes.join(' + "' \u00b7 '" + ')}')
  })
})

describe('day-9 declutter: warnings + flags fold away, the summary stays', () => {
  const panel = read('./panel.tsx')

  test('warnings render through the pure grouping helper — no raw dump on the rail', () => {
    expect(panel).toContain("from './panel-warnings'")
    expect(panel).toContain('groupWarnings(')
    expect(panel).toContain('warningCount(')
    // the old always-expanded verbatim dump is gone
    expect(panel).not.toContain('new Set(result.warnings)')
  })

  test('the warnings drawer is COLLAPSED by default (no open attribute anywhere static)', () => {
    // the panel's only <details open…> is the takeoff's computed one — the
    // warnings drawer (and every other section drawer) mounts closed
    expect(panel).toContain('Warnings')
    expect(panel).not.toContain('<details open')
    const opens = panel.match(/<details[^>]*\bopen=/g) ?? []
    expect(opens).toHaveLength(1) // TakeoffSection's index-0 expression only
  })

  test('takeoff Flags start collapsed too — no force-open special case', () => {
    expect(panel).toContain("open={index === 0 && section !== 'Flags'}")
    expect(panel).not.toContain("open={index === 0 || section === 'Flags'}")
  })

  test('the compact summary line stays always visible outside the drawer', () => {
    expect(panel).toContain('{result.members.length} members · {result.fixtures.length} devices')
  })
})

describe('floating inspector keeps the FULL wall engineering surface', () => {
  const card = read('./inspector/wall-engineering.tsx')

  test('every option the sidebar card used to carry', () => {
    // construction override
    for (const needle of ["value: 'framed'", "value: 'cmu'", "value: 'skip'"]) {
      expect(card).toContain(needle)
    }
    // CMU height slider
    expect(card).toContain('Block height')
    // studs: size + spacing
    for (const needle of ["value: '2x4'", "value: '2x6'", 'spacingIn']) {
      expect(card).toContain(needle)
    }
    // insulation + exterior finish
    expect(card).toContain('INSULATION_OPTIONS')
    expect(card).toContain('Exterior finish')
    expect(card).toContain('CLADDING_OPTIONS')
    expect(card).toContain('paintWallExterior')
  })

  test('its X-Ray call to action uses the same coherent activation', () => {
    expect(card).toContain('activateXray(')
  })
})

describe('renderer: wall-mode mount magic is gone (Change A root-cause fix)', () => {
  test('no setWallMode anywhere in the renderer', () => {
    expect(read('./framing/renderer.tsx')).not.toContain('setWallMode')
  })
})
