import { describe, expect, test } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
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

  test('pure — never mutates the input spec', () => {
    const before = { ...DEFAULT_SPEC }
    applyJurisdiction(DEFAULT_SPEC, { ...INTL_PROFILE, frostLineIn: 60 })
    expect(DEFAULT_SPEC).toEqual(before)
  })
})
