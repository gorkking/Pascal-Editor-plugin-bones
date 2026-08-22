/**
 * Wall bracing engine (IRC R602.10) — LOD-400 B9, v1.
 *
 * What v1 DOES: identifies braced-wall LINES from the exterior wall graph,
 * declares the bracing METHOD (CS-WSP — continuous sheathing, the method the
 * walls already build: the layer engine sheathes every exterior face), and
 * says honestly what is NOT verified — the R602.10.3 required panel length
 * and the Table R602.10.5 per-panel minimums are panel-schedule math (v2).
 * Every braced wall line therefore carries an assumption flag; nothing about
 * bracing is silently assumed compliant.
 *
 * What v1 does NOT do (stated, per the assumption-label contract): required
 * bracing amount by SDC/wind/storey (R602.10.3), the CS-WSP
 * adjacent-opening-height panel-length reduction (Table R602.10.5), interior
 * braced wall lines, angled-wall corner assignment (R602.10.1.1 45° rule —
 * v1 assigns an oblique wall to its DOMINANT plan axis), masonry bracing
 * (CMU walls brace as reinforced masonry — cmu.ts's story, not CS-WSP).
 *
 * The garage narrow-return PORTAL FRAME set (R602.10.6.4) lives in
 * wall-framing.ts — the opening frame owns that geometry; this module owns
 * the thresholds so table numbers live in one place.
 */

import type { FramingSpec } from '../core/spec'
import type { WallSlice } from '../core/types'
import { feet, inches } from '../core/units'

const EPS = 1e-6

/**
 * Walls whose perpendicular offset is within this of each other brace ONE
 * line — IRC R602.10.1.1: braced wall panels may be offset up to 4 ft from
 * the braced wall line.
 */
export const BRACED_LINE_OFFSET_TOL = feet(4)

/**
 * The v1 "narrow return" threshold: a wall segment beside a wide opening
 * shorter than 48" — the Table R602.10.5 minimum braced-wall-panel length
 * for Method WSP (the baseline column). CS-WSP allows shorter panels as a
 * function of the ADJACENT CLEAR OPENING HEIGHT — that reduction is
 * panel-schedule math (v2), so v1 uses the conservative 48" baseline and
 * says so.
 */
export const BRACED_PANEL_MIN_LENGTH = feet(4)

/**
 * Openings at/above this clear span put their returns in portal-frame
 * territory: R602.10.6.4 (Method CS-PF) covers header spans from 6 ft to
 * 18 ft — under 6 ft a normal braced panel beside the opening is the
 * prescriptive answer, not a portal. 6 ft is also the engine's existing
 * doubled-trimmer threshold (DOUBLE_TRIMMER_SPAN), so "wide opening" means
 * the same thing across the wall engine.
 */
export const PORTAL_OPENING_MIN_SPAN = feet(6)

/**
 * Minimum CS-PF portal panel width — Table R602.10.5: 16" for 8-ft walls,
 * 18" at 9 ft, 20" at 10 ft. Between tabulated heights the requirement
 * snaps UP (conservative — the tableSpanFor convention): a 2.5 m (8.2 ft)
 * wall needs the 9-ft value, 18".
 */
export function portalMinPanelWidth(wallHeight: number): number {
  const extraFt = Math.max(0, Math.ceil(wallHeight / feet(1) - 8 - 1e-9))
  return inches(16 + 2 * extraFt)
}

/** One braced wall line — a colinear-ish run of exterior walls. */
export type BracedWallLine = {
  /** Plan axis the line RUNS along ('x' = east-west walls). */
  axis: 'x' | 'z'
  /** Perpendicular offset of the line (m): mean z for x-lines, mean x for z-lines. */
  offset: number
  /** Deterministic label: X1, X2… / Z1, Z2… ordered by ascending offset. */
  label: string
  wallIds: string[]
  /** Sum of member wall lengths on the line (m). */
  totalLength: number
}

/**
 * Identify braced wall lines from the wall graph (v1): EXTERIOR straight
 * walls, bucketed by dominant plan axis, clustered by perpendicular offset
 * within the R602.10.1.1 4-ft tolerance. Deterministic: clusters greedily
 * in ascending-offset order, ties by wall id.
 */
export function identifyBracedWallLines(walls: WallSlice[]): BracedWallLine[] {
  type Entry = { wall: WallSlice; offset: number }
  const byAxis: Record<'x' | 'z', Entry[]> = { x: [], z: [] }
  for (const wall of walls) {
    if (!wall.exterior || wall.curved || wall.length <= EPS) continue
    const axis: 'x' | 'z' = Math.abs(wall.dir[0]) >= Math.abs(wall.dir[1]) ? 'x' : 'z'
    const mid: [number, number] = [
      (wall.start[0] + wall.end[0]) / 2,
      (wall.start[1] + wall.end[1]) / 2,
    ]
    byAxis[axis].push({ wall, offset: axis === 'x' ? mid[1] : mid[0] })
  }
  const lines: BracedWallLine[] = []
  for (const axis of ['x', 'z'] as const) {
    const entries = byAxis[axis].sort(
      (a, b) => a.offset - b.offset || (a.wall.id < b.wall.id ? -1 : 1),
    )
    let cluster: Entry[] = []
    const flush = () => {
      if (cluster.length === 0) return
      const line: BracedWallLine = {
        axis,
        offset: cluster.reduce((s, e) => s + e.offset, 0) / cluster.length,
        label: '', // assigned after sorting below
        wallIds: cluster.map((e) => e.wall.id),
        totalLength: cluster.reduce((s, e) => s + e.wall.length, 0),
      }
      lines.push(line)
      cluster = []
    }
    for (const entry of entries) {
      const first = cluster[0]
      if (first && entry.offset - first.offset > BRACED_LINE_OFFSET_TOL) flush()
      cluster.push(entry)
    }
    flush()
  }
  // Label per axis by ascending offset: X1, X2… / Z1, Z2…
  const counters: Record<'x' | 'z', number> = { x: 0, z: 0 }
  for (const line of lines) {
    counters[line.axis] += 1
    line.label = `${line.axis.toUpperCase()}${counters[line.axis]}`
  }
  return lines
}

/**
 * Per-braced-wall-line assumption warnings (v1): declare CS-WSP as the
 * method (the walls already sheath continuously — wall-layers), state that
 * the R602.10 panel length/spacing is NOT verified from geometry. LOD 200
 * frames generically — no code claims, no bracing flags.
 */
export function bracingWarnings(walls: WallSlice[], spec: FramingSpec): string[] {
  if (spec.detail === '200') return []
  return identifyBracedWallLines(walls).map(
    (line) =>
      `braced wall line ${line.label} (${line.wallIds.length} wall${
        line.wallIds.length > 1 ? 's' : ''
      }, ${line.totalLength.toFixed(1)}m): ${spec.wallBracingMethod} continuous sheathing assumed — R602.10 panel length/spacing not verified`,
  )
}
