import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SPEC,
  RAFTER_SPANS_SNOW20,
  RAFTER_SPANS_SNOW50,
  tableSpanFor,
} from '../core/spec'
import { inches, feet } from '../core/units'
import { applyJurisdiction, INTL_PROFILE, jurisdictionOptions, profileFor } from './profiles'

describe('profileFor', () => {
  test('INTL and AUTO fall back to the generic profile', () => {
    expect(profileFor('INTL')).toBe(INTL_PROFILE)
    expect(profileFor('AUTO')).toBe(INTL_PROFILE)
  })

  test('unknown code degrades gracefully', () => {
    const p = profileFor('ZZ')
    expect(p.code).toBe('ZZ')
    expect(p.exteriorWallDefault).toBe('framed')
  })

  test('Florida defaults exterior walls to CMU; others stay framed', () => {
    expect(profileFor('FL').exteriorWallDefault).toBe('cmu')
    expect(profileFor('NY').exteriorWallDefault).toBe('framed')
    expect(profileFor('CA').exteriorWallDefault).toBe('framed')
  })

  test('adoption dataset feeds the residential code label', () => {
    // NY moved to the 2024-IRC-based 2025 RCNYS (researched 2026-08).
    expect(profileFor('NY').residentialCode).toContain('2025')
  })
})

describe('jurisdictionOptions', () => {
  test('offers INTL first, then every researched state', () => {
    const options = jurisdictionOptions()
    expect(options[0]?.code).toBe('INTL')
    expect(options.length).toBeGreaterThanOrEqual(52) // INTL + 50 states + DC
    expect(options.some((o) => o.code === 'CA')).toBe(true)
  })
})

describe('applyJurisdiction', () => {
  test('footings never get shallower than 12 inches', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, frostLineIn: 6 })
    expect(spec.footingDepth).toBeCloseTo(inches(12), 5)
  })

  test('deep frost drives deep footings', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, frostLineIn: 60 })
    expect(spec.footingDepth).toBeCloseTo(inches(60), 5)
  })

  test('seismic hold-downs tighten anchor spacing to 4 ft', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, seismicHoldDowns: true })
    expect(spec.seismicHoldDowns).toBe(true)
    expect(spec.anchorBoltSpacing).toBeCloseTo(feet(4), 5)
  })

  test('high wind adds hurricane ties', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, ultimateWindMph: 150 })
    expect(spec.hurricaneTies).toBe(true)
  })

  test('heavy snow bumps rafter stock', () => {
    const at50 = applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, groundSnowLoadPsf: 50 })
    const at70 = applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, groundSnowLoadPsf: 70 })
    expect(at50.rafterSize).toBe('2x8')
    expect(at70.rafterSize).toBe('2x10')
  })

  test('snow band swaps the rafter SPAN TABLE together with the stock size (B2)', () => {
    const at30 = applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, groundSnowLoadPsf: 30 })
    expect(at30.rafterSpans).toBe(RAFTER_SPANS_SNOW20)
    const at50 = applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, groundSnowLoadPsf: 50 })
    expect(at50.rafterSpans).toBe(RAFTER_SPANS_SNOW50)
    // numeric plumb-through at the sized stock: 2x8 @ 24" = 10-1 → 10.0 ft
    // (R802.4.1(5)) vs 14-10 → 14.8 ft in the low-snow band
    expect(tableSpanFor(at50.rafterSpans, at50.rafterSize, at50.rafterSpacing)).toBeCloseTo(
      feet(10.0),
      6,
    )
    expect(tableSpanFor(at30.rafterSpans, '2x8', at30.rafterSpacing)).toBeCloseTo(feet(14.8), 6)
    // real state profiles land in the right band: VT researches at 60 psf,
    // TX at 5 — the ceiling-joist table is snow-independent
    expect(applyJurisdiction(DEFAULT_SPEC, profileFor('VT')).rafterSpans).toBe(RAFTER_SPANS_SNOW50)
    expect(applyJurisdiction(DEFAULT_SPEC, profileFor('TX')).rafterSpans).toBe(RAFTER_SPANS_SNOW20)
    expect(applyJurisdiction(DEFAULT_SPEC, profileFor('VT')).ceilingJoistSpans).toBe(
      DEFAULT_SPEC.ceilingJoistSpans,
    )
  })

  test('pure — never mutates the input spec', () => {
    const before = { ...DEFAULT_SPEC }
    applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, frostLineIn: 60 })
    expect(DEFAULT_SPEC).toEqual(before)
  })
})
