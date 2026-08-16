/**
 * Per-element drawer, stage 1 — pure selection → wall-engineering resolver.
 * The panel's SelectedWallCard calls `selectedWallInfo` with the host
 * selection and the level's ComputeResult and gets back everything the card
 * prints: name, exterior/interior, resolved construction, the framed
 * stud recipe and the climate-zone insulation the wall is entitled to.
 * Pure (no React, no stores) so the whole path is testable headlessly.
 */

import { extractWalls } from './core/wall-model'
import { COURSE_HEIGHT, courseCount, snapCmuHeight } from './engines/cmu'
import { studSizeFor } from './engines/wall-framing'
import {
  type ComputeResult,
  dedupeColinearWalls,
  probeSlabsFor,
  wallConstruction,
} from './framing/compute'
import type { FramingNode, WallConstruction, WallOverride } from './framing/schema'
import { profileFor } from './jurisdiction/profiles'

const METERS_PER_INCH = 0.0254

export type SelectionLike = {
  levelId?: string | null
  selectedIds?: readonly string[] | null
}

export type SelectedWallInfo = {
  wallId: string
  /** Host node name when set, else a short id tail ("Wall …a4f2c1"). */
  label: string
  exterior: boolean
  curved: boolean
  /** Resolved construction: override → jurisdiction default → framed. */
  construction: WallConstruction
  /** The explicit per-wall override, if one is stored on the framing node —
   * a plain construction string or the mixed-wall object form. */
  override: WallOverride | undefined
  /** The wall's architectural height (m) — the CMU height slider's frame
   * of reference on both Engineering surfaces. */
  wallHeightM: number
  /** What the wall is built from — '2x6 studs @ 16" o.c.', the CMU module,
   * or the skip notice. Always printable. */
  assembly: string
  /** 'R-13 cavity · IECC zone 2A' — exterior framed walls only (interior
   * partitions and CMU have no prescriptive cavity batt), null otherwise. */
  insulation: string | null
  /** Set when the SELECTED wall is a colinear duplicate compute's dedupe
   * skips: the card shows (and `wallId` writes overrides against) the KEPT
   * twin — a duplicate's own engineering would be a lie (it is never framed)
   * and an override on its id would be inert. */
  duplicateNote: string | null
}

/**
 * Resolve the host selection to a wall on the ACTIVE level, or null.
 * Null (card hidden) when: nothing selected, the node isn't a wall, the
 * wall lives on another level, or extraction drops it (hidden/degenerate).
 */
export function selectedWallInfo(
  nodes: Record<string, Record<string, unknown>>,
  selection: SelectionLike,
  framingNode: Pick<FramingNode, 'wallOverrides'> | undefined,
  result: ComputeResult | null,
): SelectedWallInfo | null {
  if (!framingNode || !result) return null
  const levelId = selection.levelId
  if (!levelId) return null
  const id = selection.selectedIds?.[0]
  if (!id) return null
  const node = nodes[id]
  if (!node || (node.type as string) !== 'wall') return null
  if (node.parentId !== levelId) return null

  // The SHARED compute probe (probeSlabsFor) so the exterior verdict here
  // matches the engines exactly: this level's slabs, else the nearest LOWER
  // storey with flooring in the same building (gable walls on slab-less
  // roof levels read exterior, not interior), attic rule gated on a storey
  // below.
  const { probeSlabs, hasLowerStorey } = probeSlabsFor(nodes, levelId)
  // …and the SHARED colinear dedupe: a selected duplicate resolves to its
  // KEPT twin — the twin's engineering is what's actually framed, and the
  // override write must target the id the engines consume (a duplicate's
  // override is inert). Same A4 parity rule as the probe above.
  const extracted = extractWalls(nodes, levelId, probeSlabs, hasLowerStorey)
  const { walls: keptWalls, duplicateOf } = dedupeColinearWalls(extracted)
  const keptId = duplicateOf.get(id) ?? id
  const wall = keptWalls.find((w) => w.id === keptId)
  if (!wall) return null

  const override = framingNode.wallOverrides?.[wall.id]
  const construction = wallConstruction(
    wall,
    framingNode,
    profileFor(result.jurisdiction).exteriorWallDefault,
  )

  const spacingIn = Math.round(result.spec.studSpacing / METERS_PER_INCH)
  const assembly =
    construction === 'framed'
      ? `${studSizeFor(wall, result.spec)} studs @ ${spacingIn}" o.c.`
      : construction === 'cmu'
        ? '8" CMU block · running bond'
        : 'Skipped — excluded from every system'

  const ins = result.characteristics?.insulation
  const insulation =
    construction === 'framed' && wall.exterior && ins
      ? `R-${ins.wallR} cavity · IECC zone ${ins.climateZone}`
      : null

  // Label the wall whose engineering the card SHOWS — the kept twin when
  // the selection was a duplicate.
  const keptNode = nodes[wall.id] ?? node
  const name = typeof keptNode.name === 'string' ? keptNode.name.trim() : ''
  const label = name !== '' ? name : `Wall ${wall.id.length > 10 ? `…${wall.id.slice(-6)}` : wall.id}`
  const duplicateNote =
    keptId !== id
      ? `Duplicate overlapping wall — showing the framed twin (${label}); edits apply to it`
      : null

  return {
    wallId: wall.id,
    label,
    exterior: wall.exterior,
    curved: wall.curved,
    construction,
    override,
    wallHeightM: wall.height,
    assembly,
    insulation,
    duplicateNote,
  }
}

/** Seam detail note shown under a PARTIAL-height CMU slider (both surfaces). */
export const CMU_SEAM_NOTE = 'PT sill + anchor bolts at the seam — R403.1.6'

/**
 * Everything a CMU height slider needs, derived from the wall height and the
 * stored override. Full-height CMU (plain 'cmu' string, an object with no
 * height, or a jurisdiction default) reads 100%; a partial override reads
 * its course-snapped height. Null when the wall is shorter than one course —
 * there is nothing to lay, so no control renders.
 */
export type CmuHeightControl = {
  /** Course-snapped CMU-zone height the slider shows (m). */
  valueM: number
  courses: number
  totalCourses: number
  /** Slider bounds/step: 1 course → the full wall height, one course per step. */
  minM: number
  maxM: number
  stepM: number
  /** True when only the bottom portion is block — the seam note applies. */
  partial: boolean
  /** '1.02m · 5 courses · 42%' */
  readout: string
}

export function cmuHeightControl(
  wallHeightM: number,
  override: WallOverride | undefined,
): CmuHeightControl | null {
  const totalCourses = courseCount(wallHeightM)
  if (totalCourses < 1) return null
  const requested =
    typeof override === 'object' && override.cmuHeightM !== undefined
      ? override.cmuHeightM
      : wallHeightM // no stored height = full-height CMU, today's default
  const valueM = snapCmuHeight(requested, wallHeightM)
  const courses = courseCount(valueM)
  const partial = courses < totalCourses
  const percent = Math.round((100 * courses) / totalCourses)
  return {
    valueM,
    courses,
    totalCourses,
    minM: COURSE_HEIGHT,
    maxM: wallHeightM,
    stepM: COURSE_HEIGHT,
    partial,
    readout: `${valueM.toFixed(2)}m · ${courses} ${courses === 1 ? 'course' : 'courses'} · ${percent}%`,
  }
}

/**
 * The override value a CMU height-slider write stores. Full height (every
 * course that fits, or beyond) collapses to the plain legacy 'cmu' string —
 * BYTE-EQUAL to what the segmented control writes today — while a partial
 * height stores the object form with the course-snapped height, so the
 * persisted number is exactly what the engines build (S5).
 */
export function cmuHeightOverride(wallHeightM: number, requestedM: number): WallOverride {
  const snapped = snapCmuHeight(requestedM, wallHeightM)
  if (snapped <= 0 || courseCount(snapped) >= courseCount(wallHeightM)) return 'cmu'
  return { construction: 'cmu', cmuHeightM: snapped }
}

/**
 * The update payload for a per-wall construction change — merge, never
 * replace, so one wall's edit can't drop another's override.
 */
export function wallOverridePatch(
  framingNode: Pick<FramingNode, 'wallOverrides'>,
  wallId: string,
  construction: WallOverride,
): { wallOverrides: Record<string, WallOverride> } {
  return { wallOverrides: { ...framingNode.wallOverrides, [wallId]: construction } }
}
