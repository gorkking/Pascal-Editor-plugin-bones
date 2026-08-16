/**
 * Per-element drawer, stage 1 — pure selection → wall-engineering resolver.
 * The panel's SelectedWallCard calls `selectedWallInfo` with the host
 * selection and the level's ComputeResult and gets back everything the card
 * prints: name, exterior/interior, resolved construction, the framed
 * stud recipe and the climate-zone insulation the wall is entitled to.
 * Pure (no React, no stores) so the whole path is testable headlessly.
 */

import { extractLevels, extractSlabs, extractWalls } from './core/wall-model'
import { studSizeFor } from './engines/wall-framing'
import { type ComputeResult, wallConstruction } from './framing/compute'
import type { FramingNode, WallConstruction } from './framing/schema'
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
  /** The explicit per-wall override, if one is stored on the framing node. */
  override: WallConstruction | undefined
  /** What the wall is built from — '2x6 studs @ 16" o.c.', the CMU module,
   * or the skip notice. Always printable. */
  assembly: string
  /** 'R-13 cavity · IECC zone 2A' — exterior framed walls only (interior
   * partitions and CMU have no prescriptive cavity batt), null otherwise. */
  insulation: string | null
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

  // Same probe-slab widening computeLevel uses so the exterior verdict here
  // matches the engines: this level's slabs, else the nearest LOWER storey
  // with flooring in the same building (gable walls on slab-less roof
  // levels read exterior, not interior).
  const slabs = extractSlabs(nodes, levelId)
  let probeSlabs = slabs
  if (slabs.length === 0) {
    const allLevels = extractLevels(nodes)
    const myBuilding = allLevels.find((l) => l.id === levelId)?.buildingId ?? null
    const levels = allLevels.filter((l) => l.buildingId === myBuilding)
    for (let i = levels.findIndex((l) => l.id === levelId) - 1; i >= 0; i--) {
      const lowerId = levels[i]?.id
      if (!lowerId) continue
      const lower = extractSlabs(nodes, lowerId)
      if (lower.length > 0) {
        probeSlabs = lower
        break
      }
    }
  }
  const wall = extractWalls(nodes, levelId, probeSlabs).find((w) => w.id === id)
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

  const name = typeof node.name === 'string' ? node.name.trim() : ''
  const label = name !== '' ? name : `Wall ${id.length > 10 ? `…${id.slice(-6)}` : id}`

  return {
    wallId: wall.id,
    label,
    exterior: wall.exterior,
    curved: wall.curved,
    construction,
    override,
    assembly,
    insulation,
  }
}

/**
 * The update payload for a per-wall construction change — merge, never
 * replace, so one wall's edit can't drop another's override.
 */
export function wallOverridePatch(
  framingNode: Pick<FramingNode, 'wallOverrides'>,
  wallId: string,
  construction: WallConstruction,
): { wallOverrides: Record<string, WallConstruction> } {
  return { wallOverrides: { ...framingNode.wallOverrides, [wallId]: construction } }
}
