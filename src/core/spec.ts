/**
 * FramingSpec — the resolved parameter set the engines run with. Built by
 * merging: engine defaults ← jurisdiction profile (state) ← user overrides
 * (the `bones:framing` config node). Everything in meters unless suffixed.
 */

import type { LumberSize } from '../lumber'
import { feet, inches } from './units'

export type HeaderRule = { maxSpan: number; size: LumberSize }

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
  ceilingJoistSpacing: number
  ceilingJoistSize: LumberSize
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
  ceilingJoistSpacing: inches(16),
  ceilingJoistSize: '2x6',
  footingDepth: inches(12),
  footingWidth: inches(16),
  stemwallThickness: inches(8),
  anchorBoltSpacing: feet(6),
  anchorBoltEndDistance: inches(12),
  seismicHoldDowns: false,
  hurricaneTies: false,
}

/** Pick a header size for a clear span using the spec's rules. */
export function headerFor(spec: FramingSpec, clearSpan: number): LumberSize {
  for (const rule of spec.headerRules) {
    if (clearSpan <= rule.maxSpan) return rule.size
  }
  return spec.headerRules[spec.headerRules.length - 1]?.size ?? '4x12'
}
