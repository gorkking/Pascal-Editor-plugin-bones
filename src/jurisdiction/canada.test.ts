import { describe, expect, it } from 'bun:test'
import adoptionData from '../../data/jurisdictions-adoption.json'
import climateData from '../../data/jurisdictions-climate.json'
import { DEFAULT_SPEC } from '../core/spec'
import { INCH } from '../core/units'
import { applyJurisdiction, jurisdictionOptions, profileFor } from './profiles'

/**
 * Canada rides the same data path as the US states: two JSON rows merged by
 * `profileFor`, then mapped onto the FramingSpec by `applyJurisdiction`. These
 * tests pin the parts that would silently regress — a missing data row
 * degrades to the INTL fallback rather than throwing, so "it still renders"
 * is not evidence that a province actually landed.
 */

const CANADA = [
  'CA-ON-S',
  'CA-ON-E',
  'CA-ON-N',
  'CA-BC',
  'CA-AB',
  'CA-SK',
  'CA-MB',
  'CA-QC',
  'CA-NB',
  'CA-NS',
  'CA-PE',
  'CA-NL',
  'CA-YT',
  'CA-NT',
  'CA-NU',
  'CA-GEN',
] as const

const footingInches = (code: string): number =>
  applyJurisdiction(DEFAULT_SPEC, profileFor(code)).footingDepth / INCH

describe('Canadian jurisdictions', () => {
  it('every province resolves to real data, not the INTL fallback', () => {
    for (const code of CANADA) {
      const p = profileFor(code)
      // The fallback returns `{...INTL_PROFILE, code, name: code}` — so a name
      // equal to the bare code means the data row is missing.
      expect(p.name).not.toBe(code)
      expect(p.name.startsWith('Canada')).toBe(true)
      expect(p.residentialCode).not.toBe('IRC (edition unverified)')
    }
  })

  it('cites the National Building Code, not the IRC', () => {
    expect(profileFor('CA-SK').residentialCode).toContain('National Building Code')
    expect(profileFor('CA-ON-S').residentialCode).toContain('Ontario Building Code')
    expect(profileFor('CA-QC').residentialCode).toContain('2015')
  })

  it('no Canadian code collides with a US state code', () => {
    const codes = jurisdictionOptions().map((o) => o.code)
    expect(new Set(codes).size).toBe(codes.length)
    // The obvious trap: bare 'CA' is California and must stay California.
    expect(profileFor('CA').name).toBe('California')
  })

  it('southern Ontario frames like the GTA: shallow-ish frost, no ties, 2x6 rafters', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, profileFor('CA-ON-S'))
    expect(footingInches('CA-ON-S')).toBeCloseTo(47, 5)
    expect(spec.hurricaneTies).toBe(false)
    expect(spec.seismicHoldDowns).toBe(false)
    expect(spec.rafterSize).toBe(DEFAULT_SPEC.rafterSize)
  })

  it('the Ottawa Valley digs deeper and bumps the rafter for snow', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, profileFor('CA-ON-E'))
    expect(footingInches('CA-ON-E')).toBeCloseTo(71, 5)
    expect(spec.rafterSize).toBe('2x8')
  })

  it('prairie frost depths exceed every US state', () => {
    // The reason Canada needed real rows instead of a US proxy: the deepest
    // US frost line in the data is 60in, and Saskatchewan runs deeper.
    expect(footingInches('CA-SK')).toBeCloseTo(84, 5)
    expect(footingInches('CA-MB')).toBeCloseTo(78, 5)
    expect(footingInches('CA-SK')).toBeGreaterThan(footingInches('ND'))
  })

  it('coastal BC turns on seismic hold-downs and tightens anchor bolts', () => {
    const spec = applyJurisdiction(DEFAULT_SPEC, profileFor('CA-BC'))
    expect(spec.seismicHoldDowns).toBe(true)
    expect(spec.anchorBoltSpacing).toBeCloseTo(4 * 12 * INCH, 5)
  })

  it('Atlantic Canada gets uplift ties, the interior does not', () => {
    expect(applyJurisdiction(DEFAULT_SPEC, profileFor('CA-NS')).hurricaneTies).toBe(true)
    expect(applyJurisdiction(DEFAULT_SPEC, profileFor('CA-NL')).hurricaneTies).toBe(true)
    expect(applyJurisdiction(DEFAULT_SPEC, profileFor('CA-SK')).hurricaneTies).toBe(false)
  })

  it('exterior walls stay framed everywhere in Canada', () => {
    for (const code of CANADA) {
      expect(profileFor(code).exteriorWallDefault).toBe('framed')
    }
  })

  it('permafrost territories carry an explicit warning in their notes', () => {
    for (const code of ['CA-YT', 'CA-NT', 'CA-NU']) {
      expect(profileFor(code).notes.join(' ')).toContain('PERMAFROST')
    }
  })

  it('the dropdown still leads with INTL and now carries Canada', () => {
    const options = jurisdictionOptions()
    expect(options[0]?.code).toBe('INTL')
    expect(options.filter((o) => o.code.startsWith('CA-')).length).toBe(CANADA.length)
  })

  it('the CA-* codes group as ONE contiguous dropdown block, right after California', () => {
    // The ISO-style 'CA-' prefix is the grouping mechanism: the options
    // sort by code, so every Canadian entry must land in one unbroken run
    // ('CA-' < 'CO' in ASCII) — a stray code spelling would scatter it.
    const codes = jurisdictionOptions().map((o) => o.code)
    const first = codes.findIndex((c) => c.startsWith('CA-'))
    const last = codes.length - 1 - [...codes].reverse().findIndex((c) => c.startsWith('CA-'))
    expect(first).toBeGreaterThan(0)
    expect(last - first + 1).toBe(CANADA.length)
    for (let i = first; i <= last; i++) expect(codes[i]?.startsWith('CA-')).toBe(true)
    expect(codes[first - 1]).toBe('CA') // California immediately precedes the block
  })
})

// ---------------------------------------------------------------------------
// Citation completeness — the CA data gate (the LGS citation-gate style):
// every Canadian row must carry its code source, its unit-conversion
// documentation, and the not-site-specific caveat. A row is data, and data
// without its citation is a wish.
// ---------------------------------------------------------------------------

type CaAdoptionRow = {
  /** IRC edition year for adopting states; null for non-IRC codes (WI, CA-*). */
  ircBase: number | null
  residentialCode: string
  note?: string
}
type CaClimateRow = {
  frostLineIn: number
  frostLineNote: string
  groundSnowLoadPsf: number
  snowNote: string
  caveat?: string
}

const adoptionRows = (adoptionData as { states: Record<string, CaAdoptionRow> }).states
const climateRows = (climateData as { states: Record<string, CaClimateRow> }).states
const CA_CODES = Object.keys(adoptionRows).filter((c) => c.startsWith('CA-'))

const KPA_TO_PSF = 20.885
const MM_PER_IN = 25.4
/** First figure of a (possibly ranged) `<n>[-<m>] <unit>` mention. */
const firstFigure = (text: string, unit: string): number | null => {
  const m = new RegExp(`(\\d+(?:\\.\\d+)?)(?:\\s*[-–]\\s*\\d+(?:\\.\\d+)?)?\\s*${unit}`).exec(text)
  return m ? Number(m[1]) : null
}
/** Every figure adjacent to a `<unit>` mention, range ends included. */
const allFigures = (text: string, unit: string): number[] =>
  [...text.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)(?:\\s*[-–]\\s*(\\d+(?:\\.\\d+)?))?\\s*${unit}`, 'g'))]
    .flatMap((m) => [Number(m[1]), ...(m[2] ? [Number(m[2])] : [])])

describe('citation completeness — the CA data gate', () => {
  it('there are exactly 16 CA rows, present in BOTH data files', () => {
    expect(CA_CODES.sort()).toEqual([...CANADA].sort())
    for (const code of CA_CODES) expect(climateRows[code], code).toBeDefined()
  })

  it('every CA adoption row: ircBase null + an NBC-based code + the verbatim inference-engine note', () => {
    for (const code of CA_CODES) {
      const row = adoptionRows[code] as CaAdoptionRow
      // Canada is NOT an IRC jurisdiction (the Wisconsin-UDC precedent) —
      // and the note tells inference engines so, verbatim, including the
      // NBC 9.23.13 bracing difference (noted, deliberately NOT implemented).
      expect(row.ircBase, code).toBeNull()
      expect(/NBC|National Building Code/.test(row.residentialCode), code).toBe(true)
      expect(row.note ?? '', code).toContain('NOT an IRC adoption')
      expect(row.note ?? '', code).toContain('NBC Division B Part 9')
      expect(row.note ?? '', code).toContain(
        'NBC 9.23.13 selects lateral bracing from Sa(0.2) and hourly wind pressure',
      )
    }
  })

  it("Quebec carries its one-cycle-behind flag: NBC 2015 base, on the row AND in the note", () => {
    const qc = adoptionRows['CA-QC'] as CaAdoptionRow
    expect(qc.residentialCode).toContain('NBC 2015')
    expect(qc.note).toContain('NBC 2015')
    expect(qc.note).toContain('not NBC 2020')
  })

  it('every CA climate row carries the typical-not-site-specific caveat with its NBC source', () => {
    for (const code of CA_CODES) {
      const caveat = (climateRows[code] as CaClimateRow).caveat ?? ''
      expect(caveat, code).toContain('Canadian entry')
      expect(caveat, code).toContain('typical provincial values')
      expect(caveat, code).toContain('NBC 2020 Division B Appendix C')
      expect(caveat, code).toContain('authority having jurisdiction')
    }
  })

  it('the data-file disclaimer states the CA conversion factors (kPa→psf 20.885, 25.4 mm/in)', () => {
    const disclaimer = (climateData as { disclaimer: string }).disclaimer
    expect(disclaimer).toContain('20.885')
    expect(disclaimer).toContain('25.4 mm')
  })

  it('per-row snow conversion is documented AND arithmetically honest (kPa → psf at 20.885)', () => {
    for (const code of CA_CODES) {
      const row = climateRows[code] as CaClimateRow
      // Canadian codes state ground snow as Ss in kPa — every row documents
      // the source unit…
      expect(row.snowNote, code).toContain('kPa')
      const kpa = firstFigure(row.snowNote, 'kPa')
      const psf = firstFigure(row.snowNote, 'psf')
      if (psf !== null) {
        // …and the printed psf pair reproduces the stated factor (±0.75
        // absorbs the note's integer rounding, nothing more).
        expect(Math.abs((kpa as number) * KPA_TO_PSF - psf), code).toBeLessThanOrEqual(0.75)
        // the row's schema value lives inside the documented range
        const figures = allFigures(row.snowNote, 'psf')
        expect(row.groundSnowLoadPsf, code).toBeGreaterThanOrEqual(Math.min(...figures) - 1)
        expect(row.groundSnowLoadPsf, code).toBeLessThanOrEqual(Math.max(...figures) + 1)
      } else {
        // the only pair-less row is the national placeholder — and it says so
        expect(code).toBe('CA-GEN')
        expect(row.snowNote).toContain('placeholder')
      }
    }
  })

  it('per-row frost conversion is documented (mm, with honest inches where paired) or PERMAFROST-flagged', () => {
    for (const code of CA_CODES) {
      const row = climateRows[code] as CaClimateRow
      const note = row.frostLineNote
      // Permafrost territories replace the spread-footing figure with the
      // explicit warning — a meaningless depth must never read as sited data.
      if (note.includes('PERMAFROST')) continue
      expect(note, code).toContain('mm')
      const mm = firstFigure(note, 'mm')
      const inch = firstFigure(note, 'in')
      if (inch !== null) {
        expect(Math.abs((mm as number) / MM_PER_IN - inch), code).toBeLessThanOrEqual(1)
        const inches = allFigures(note, 'in')
        expect(row.frostLineIn, code).toBeGreaterThanOrEqual(Math.min(...inches) - 1)
        expect(row.frostLineIn, code).toBeLessThanOrEqual(Math.max(...inches) + 1)
      }
    }
    // the PERMAFROST escape hatch is exactly the three territories — a
    // province may never use it to dodge the conversion documentation
    const flagged = CA_CODES.filter((c) =>
      (climateRows[c] as CaClimateRow).frostLineNote.includes('PERMAFROST'),
    )
    expect(flagged.sort()).toEqual(['CA-NT', 'CA-NU', 'CA-YT'])
  })
})
