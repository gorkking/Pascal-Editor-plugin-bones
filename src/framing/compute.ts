/**
 * The assembly point: scene nodes + one `bones:framing` config node → every
 * derived Member/Fixture for that level. Pure (no React, no stores) so the
 * whole inference pipeline is testable headlessly; the renderer just calls
 * this and instances the result.
 */

import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Fixture, Member, WallSlice } from '../core/types'
import { inches } from '../core/units'
import { extractLevels, extractSlabs, extractWalls } from '../core/wall-model'
import { cmuWall } from '../engines/cmu'
import { layoutElectrical } from '../engines/electrical'
import { buildFoundation } from '../engines/foundation'
import { frameFloor } from '../engines/floor-framing'
import { frameRoofs, extractRoofs } from '../engines/roof-framing'
import { frameWall } from '../engines/wall-framing'
import { applyJurisdiction, profileFor } from '../jurisdiction/profiles'
import { resolveJurisdiction } from '../jurisdiction/guess'
import type { FramingNode, WallConstruction } from './schema'

export type ComputeResult = {
  members: Member[]
  fixtures: Fixture[]
  warnings: string[]
  /** Resolved jurisdiction code actually used ('AUTO' → guessed). */
  jurisdiction: string
  spec: FramingSpec
}

/** Construction system for one wall: override → jurisdiction default → framed. */
export function wallConstruction(
  wall: WallSlice,
  config: Pick<FramingNode, 'wallOverrides'>,
  exteriorDefault: 'framed' | 'cmu',
): WallConstruction {
  const override = config.wallOverrides?.[wall.id]
  if (override) return override
  if (wall.exterior && exteriorDefault === 'cmu') return 'cmu'
  return 'framed'
}

export function computeLevel(
  nodes: Record<string, Record<string, unknown>>,
  config: FramingNode,
): ComputeResult {
  const warnings: string[] = []
  const levelId = config.parentId
  if (!levelId) {
    return {
      members: [],
      fixtures: [],
      warnings: ['Framing node has no level'],
      jurisdiction: 'INTL',
      spec: DEFAULT_SPEC,
    }
  }

  const { code } = resolveJurisdiction(config.jurisdiction)
  const profile = profileFor(code)
  let spec: FramingSpec = { ...DEFAULT_SPEC, studSpacing: inches(config.studSpacingIn) }
  if (config.detail === '300') spec = applyJurisdiction(spec, profile)

  const walls = extractWalls(nodes, levelId)
  const slabs = extractSlabs(nodes, levelId)
  const levels = extractLevels(nodes)
  const levelIndex = levels.findIndex((l) => l.id === levelId)
  const isGroundLevel = levelIndex <= 0

  const members: Member[] = []
  const fixtures: Fixture[] = []

  if (config.showWalls) {
    for (const wall of walls) {
      if (wall.curved) {
        warnings.push(`Curved wall skipped (framing for curved walls lands later)`)
        continue
      }
      const construction = wallConstruction(wall, config, profile.exteriorWallDefault)
      if (construction === 'skip') continue
      members.push(...(construction === 'cmu' ? cmuWall(wall, spec) : frameWall(wall, spec)))
    }
  }

  if (config.showFloor && !isGroundLevel) {
    members.push(...frameFloor(slabs, spec))
  }

  if (config.showRoof) {
    const roofs = extractRoofs(nodes, levelId)
    members.push(...frameRoofs(roofs, walls, spec))
  }

  if (config.showFoundation && isGroundLevel) {
    members.push(...buildFoundation(walls, slabs, spec))
  }

  if (config.showElectrical) {
    fixtures.push(...layoutElectrical(walls))
  }

  return { members, fixtures, warnings, jurisdiction: code, spec }
}
