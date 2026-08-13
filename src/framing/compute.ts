/**
 * The assembly point: scene nodes + one `bones:framing` config node → every
 * derived Member/Fixture for that level. Pure (no React, no stores) so the
 * whole inference pipeline is testable headlessly; the renderer just calls
 * this and instances the result.
 */

import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Fixture, Member, WallSlice } from '../core/types'
import { inches } from '../core/units'
import { extractLevels, extractRooms, extractSlabs, extractWalls } from '../core/wall-model'
import { cmuWalls } from '../engines/cmu'
import { layoutElectrical, routeWiring } from '../engines/electrical'
import { layoutHvac } from '../engines/hvac'
import { layoutPlumbing } from '../engines/plumbing'
import { buildFoundation } from '../engines/foundation'
import { frameFloor } from '../engines/floor-framing'
import { frameRoofs, extractRoofs } from '../engines/roof-framing'
import { frameWalls } from '../engines/wall-framing'
import { applyJurisdiction, profileFor } from '../jurisdiction/profiles'
import { resolveJurisdiction } from '../jurisdiction/guess'
import type { TakeoffAreas } from '../engines/takeoff'
import type { FramingNode, WallConstruction } from './schema'

export type ComputeResult = {
  members: Member[]
  fixtures: Fixture[]
  warnings: string[]
  /** Resolved jurisdiction code actually used ('AUTO' → guessed). */
  jurisdiction: string
  spec: FramingSpec
  /** Gross sheet-goods areas for the takeoff (walls/slabs aren't returned). */
  areas: TakeoffAreas
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
      areas: {},
    }
  }

  const { code } = resolveJurisdiction(config.jurisdiction)
  const profile = profileFor(code)
  let spec: FramingSpec = {
    ...DEFAULT_SPEC,
    detail: config.detail,
    studSpacing: inches(config.studSpacingIn),
  }
  // 400 (fabrication) builds ON TOP of the code-sized pass — jurisdiction applies to both.
  if (config.detail !== '200') spec = applyJurisdiction(spec, profile)

  const walls = extractWalls(nodes, levelId)
  const slabs = extractSlabs(nodes, levelId)
  const rooms = extractRooms(nodes, levelId)
  const levels = extractLevels(nodes)
  const levelIndex = levels.findIndex((l) => l.id === levelId)
  const isGroundLevel = levelIndex <= 0

  const members: Member[] = []
  const fixtures: Fixture[] = []

  // A wall overridden to 'skip' is excluded from EVERY system — no framing,
  // no foundation under it, no devices on it. It's "not real construction".
  const activeWalls = walls.filter(
    (wall) => wallConstruction(wall, config, profile.exteriorWallDefault) !== 'skip',
  )
  // Rooms must not reference skipped walls either: plumbing anchors its wet
  // wall (and electrical its garage panel) through `boundaryWallIds`, and a
  // dangling id would starve the engines' nearest-wall fallbacks.
  const activeWallIds = new Set(activeWalls.map((wall) => wall.id))
  const activeRooms = rooms.map((room) =>
    room.boundaryWallIds.every((id) => activeWallIds.has(id))
      ? room
      : { ...room, boundaryWallIds: room.boundaryWallIds.filter((id) => activeWallIds.has(id)) },
  )

  if (config.showWalls) {
    // Route walls as GROUPS so cross-wall fabrication (corner assemblies,
    // partition backing, CMU corner interlock) can see its neighbors.
    const framed: WallSlice[] = []
    const masonry: WallSlice[] = []
    for (const wall of activeWalls) {
      if (wall.curved) {
        warnings.push(`Curved wall skipped (framing for curved walls lands later)`)
        continue
      }
      const construction = wallConstruction(wall, config, profile.exteriorWallDefault)
      if (construction === 'cmu') masonry.push(wall)
      else framed.push(wall)
    }
    members.push(...frameWalls(framed, spec))
    members.push(...cmuWalls(masonry, spec))
  }

  if (config.showFloor && !isGroundLevel) {
    const storeyBelowHeight = levels[levelIndex - 1]?.height ?? 2.4
    members.push(...frameFloor(slabs, activeWalls, spec, storeyBelowHeight))
  }

  if (config.showRoof) {
    const roofs = extractRoofs(nodes, levelId)
    members.push(...frameRoofs(roofs, activeWalls, spec))
  }

  if (config.showFoundation && isGroundLevel) {
    members.push(...buildFoundation(activeWalls, slabs, spec))
  }

  if (config.showElectrical) {
    const electrical = layoutElectrical(activeWalls, activeRooms)
    fixtures.push(...electrical)
    // LOD 400: homerun + branch wiring as geometry, converging on the panel.
    if (spec.detail === '400') members.push(...routeWiring(electrical))
  }

  if (config.showPlumbing) {
    const plumbing = layoutPlumbing(activeWalls, activeRooms, spec)
    members.push(...plumbing.members)
    fixtures.push(...plumbing.fixtures)
  }

  if (config.showHvac) {
    const hvac = layoutHvac(activeWalls, activeRooms, spec)
    members.push(...hvac.members)
    fixtures.push(...hvac.fixtures)
  }

  // ---- gross sheet-goods areas for the takeoff ----
  // Sheets are bought gross (openings are cut out of a full sheet), so the
  // areas are simple length × height / polygon sums over the ACTIVE walls.
  const areas: TakeoffAreas = { wallSheathingM2: 0, subfloorM2: 0, drywallM2: 0 }
  for (const wall of activeWalls) {
    if (wall.curved) continue
    const construction = wallConstruction(wall, config, profile.exteriorWallDefault)
    const faceArea = wall.length * wall.height
    // WSP sheathing wraps FRAMED exterior walls only (CMU gets stucco/furring).
    if (wall.exterior && construction === 'framed') {
      areas.wallSheathingM2 = (areas.wallSheathingM2 ?? 0) + faceArea
    }
    // Drywall: both faces of interior walls, the inside face of exterior ones.
    areas.drywallM2 = (areas.drywallM2 ?? 0) + faceArea * (wall.exterior ? 1 : 2)
  }
  if (!isGroundLevel) {
    for (const slab of slabs) {
      let area = 0
      const ring = (poly: readonly (readonly [number, number])[]): number => {
        let sum = 0
        for (let i = 0; i < poly.length; i++) {
          const [x1, z1] = poly[i] as readonly [number, number]
          const [x2, z2] = poly[(i + 1) % poly.length] as readonly [number, number]
          sum += x1 * z2 - x2 * z1
        }
        return Math.abs(sum) / 2
      }
      area += ring(slab.polygon)
      for (const hole of slab.holes) area -= ring(hole)
      areas.subfloorM2 = (areas.subfloorM2 ?? 0) + Math.max(0, area)
    }
  }

  return { members, fixtures, warnings, jurisdiction: code, spec, areas }
}
