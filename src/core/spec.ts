/**
 * FramingSpec — the resolved parameter set the engines run with. Built by
 * merging: engine defaults ← jurisdiction profile (state) ← user overrides
 * (the `bones:framing` config node). Everything in meters unless suffixed.
 */

import framingTables from '../../data/framing-tables.json'
import type { LumberSize } from '../lumber'
import { feet, inches } from './units'

export type HeaderRule = { maxSpan: number; size: LumberSize }

/**
 * Allowable-span table: nominal size → o.c. spacing (inches, string key as in
 * data/framing-tables.json: '12' | '16' | '24') → allowable span in METERS.
 * Rafter spans are measured on the HORIZONTAL PROJECTION (IRC convention).
 */
export type SpanTable = Partial<Record<LumberSize, Record<string, number>>>

type JsonSpanRows = Record<string, Record<string, { spanFt: number }>>

/** data/framing-tables.json rows (feet) → SpanTable (meters). */
function toSpanTable(rows: JsonSpanRows): SpanTable {
  const out: SpanTable = {}
  for (const [size, cols] of Object.entries(rows)) {
    const row: Record<string, number> = {}
    for (const [spacing, cell] of Object.entries(cols)) row[spacing] = feet(cell.spanFt)
    out[size as LumberSize] = row
  }
  return out
}

const tables = framingTables as unknown as {
  rafters: {
    groundSnow20Psf: { spans: JsonSpanRows }
    groundSnow50Psf: { spans: JsonSpanRows }
  }
  ceilingJoists: { spans: JsonSpanRows }
}

/** IRC 2021 Table R802.4.1(1) — roof live load 20 psf (the low-snow default:
 * where ground snow ≲ 30 psf the 20 psf roof live load governs, per the
 * table note). SPF #2, dead load 10 psf, L/180, horizontal projection. */
export const RAFTER_SPANS_SNOW20: SpanTable = toSpanTable(tables.rafters.groundSnow20Psf.spans)

/** IRC 2021 Table R802.4.1(5) — ground snow load 50 psf. SPF #2. */
export const RAFTER_SPANS_SNOW50: SpanTable = toSpanTable(tables.rafters.groundSnow50Psf.spans)

/** IRC 2021 Table R802.5.1(2) — ceiling joists, uninhabitable attic with
 * limited storage (20 psf live / 10 dead, L/240). SPF #2. */
export const CEILING_JOIST_SPANS: SpanTable = toSpanTable(tables.ceilingJoists.spans)

/**
 * Rafter table for a ground snow load, mirroring how `rafterSize` moves in
 * `applyJurisdiction`: < 50 psf → the 20-psf-live table (its own low-snow
 * note), ≥ 50 psf → the 50-psf table. The data ships no ≥ 70 psf column and
 * no state profile exceeds 60 psf today; 50–70 psf sites read the 50-psf
 * table (slightly long at 60 psf — verify locally, per the data disclaimer).
 */
export function rafterSpansForSnow(groundSnowLoadPsf: number): SpanTable {
  return groundSnowLoadPsf >= 50 ? RAFTER_SPANS_SNOW50 : RAFTER_SPANS_SNOW20
}

/**
 * Allowable span (m) for `size` at `spacing` (m o.c.). The spacing snaps UP
 * to the next tabulated column (wider spacing → shorter span — conservative);
 * past the last column the last column is used. `undefined` when the size has
 * no tabulated row (no prescriptive check possible).
 */
export function tableSpanFor(
  table: SpanTable,
  size: LumberSize,
  spacing: number,
): number | undefined {
  const row = table[size]
  if (!row) return undefined
  const spacingIn = spacing / inches(1)
  const keys = Object.keys(row)
    .map(Number)
    .sort((a, b) => a - b)
  const key = keys.find((k) => spacingIn <= k + 0.5) ?? keys[keys.length - 1]
  return key === undefined ? undefined : row[String(key)]
}

export type FramingSpec = {
  /** Resolved LOD: '200' generic · '300' code-sized · '400' fabrication. */
  detail: '200' | '300' | '400'
  /** Stud on-center spacing (16" default, 24" allowed). */
  studSpacing: number
  /** Double top plate by default. */
  topPlateCount: 1 | 2
  /** Interior wall stud size when wall thickness is thin. */
  interiorStudSize: LumberSize
  /** Exterior wall stud size (2x6 for thick walls / energy codes). */
  exteriorStudSize: LumberSize
  /** Wall thickness (m) at/above which studs bump to `exteriorStudSize`. */
  thickWallThreshold: number
  /** Header sizing by clear rough span — first rule whose maxSpan fits wins. */
  headerRules: HeaderRule[]
  /** Rough-opening pad added to a door/window nominal width when RO unset. */
  roughOpeningPad: number
  /** Span (m) past which a header is flagged as needing an engineered beam. */
  engineeredHeaderSpan: number
  // ---- floor ----
  joistSpacing: number
  /** Preferred joist depth ladder — engine picks first that spans. */
  joistSizes: LumberSize[]
  /** Allowable simple span (m) per size at 16" o.c. — SPF #2 40psf (IRC R502.3.1(2)). */
  joistSpans: Partial<Record<LumberSize, number>>
  // ---- roof ----
  rafterSpacing: number
  rafterSize: LumberSize
  /** Allowable rafter spans (horizontal projection, m) — R802.4.1, SPF #2.
   * Swapped by snow band in `applyJurisdiction` (rafterSpansForSnow). */
  rafterSpans: SpanTable
  ceilingJoistSpacing: number
  ceilingJoistSize: LumberSize
  /** Allowable ceiling-joist spans (m) — R802.5.1(2), SPF #2, limited storage. */
  ceilingJoistSpans: SpanTable
  // ---- foundation ----
  /** Footing depth below grade (frost-driven, jurisdiction). */
  footingDepth: number
  footingWidth: number
  stemwallThickness: number
  anchorBoltSpacing: number
  anchorBoltEndDistance: number
  /** SDC D+ → hold-downs at braced ends, tighter anchors. */
  seismicHoldDowns: boolean
  /** High-wind → hurricane ties at rafter/plate. */
  hurricaneTies: boolean
  // ---- wall bracing (R602.10, LOD-400 B9) ----
  /**
   * Declared braced-wall METHOD. v1 ships CS-WSP only (continuous
   * sheathing, wood structural panel — the assembly the layer engine
   * already builds on every exterior face); the field exists so the
   * declaration is data, not prose, and v2's panel-schedule math has a
   * knob to key on.
   */
  wallBracingMethod: 'CS-WSP'
}

export const DEFAULT_SPEC: FramingSpec = {
  detail: '300',
  studSpacing: inches(16),
  topPlateCount: 2,
  interiorStudSize: '2x4',
  exteriorStudSize: '2x6',
  thickWallThreshold: 0.13,
  headerRules: [
    { maxSpan: inches(24), size: '4x4' },
    { maxSpan: inches(36), size: '4x6' },
    { maxSpan: inches(60), size: '4x8' },
    { maxSpan: inches(84), size: '4x10' },
    { maxSpan: Number.POSITIVE_INFINITY, size: '4x12' },
  ],
  roughOpeningPad: inches(1.5),
  engineeredHeaderSpan: feet(10),
  joistSpacing: inches(16),
  joistSizes: ['2x8', '2x10', '2x12'],
  // SPF #2, 40 psf live / 10 dead, L/360, 16" o.c. — R502.3.1(2)
  joistSpans: { '2x6': feet(9.5), '2x8': feet(12.25), '2x10': feet(15), '2x12': feet(17.4) },
  rafterSpacing: inches(24),
  rafterSize: '2x6',
  rafterSpans: RAFTER_SPANS_SNOW20,
  ceilingJoistSpacing: inches(16),
  ceilingJoistSize: '2x6',
  ceilingJoistSpans: CEILING_JOIST_SPANS,
  footingDepth: inches(12),
  footingWidth: inches(16),
  stemwallThickness: inches(8),
  anchorBoltSpacing: feet(6),
  anchorBoltEndDistance: inches(12),
  seismicHoldDowns: false,
  hurricaneTies: false,
  wallBracingMethod: 'CS-WSP',
}

/** Pick a header size for a clear span using the spec's rules. */
export function headerFor(spec: FramingSpec, clearSpan: number): LumberSize {
  for (const rule of spec.headerRules) {
    if (clearSpan <= rule.maxSpan) return rule.size
  }
  return spec.headerRules[spec.headerRules.length - 1]?.size ?? '4x12'
}
