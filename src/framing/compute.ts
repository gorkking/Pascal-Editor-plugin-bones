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
import { layoutWallLayers } from '../engines/wall-layers'
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

// 1-deep memo: the panel and the 3D renderer both derive from the same
// store snapshot on every scene edit — identical (nodes, config) references
// return the cached result, halving per-edit compute (round-2 advisory).
// Pascal's stores hand out immutable snapshots, so reference equality is a
// safe cache key; any new snapshot recomputes.
let memoNodes: Record<string, Record<string, unknown>> | null = null
let memoConfig: FramingNode | null = null
let memoResult: ComputeResult | null = null

export function computeLevel(
  nodes: Record<string, Record<string, unknown>>,
  config: FramingNode,
): ComputeResult {
  if (memoResult !== null && nodes === memoNodes && config === memoConfig) return memoResult
  const result = computeLevelUncached(nodes, config)
  memoNodes = nodes
  memoConfig = config
  memoResult = result
  return result
}

function computeLevelUncached(
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

  const slabs = extractSlabs(nodes, levelId)
  // Slabs feed the exterior fallback: hosts often mark BOTH wall faces
  // 'interior' (quality round-1 A1) — flooring says which side is in.
  const rawWalls = extractWalls(nodes, levelId, slabs)
  // Duplicate colinear walls (host scenes routinely carry overlapping
  // segments) framed TWICE: z-fighting studs, doubled plates, ~20% phantom
  // lumber in the takeoff (quality round-1 A5). Keep the longer of any
  // near-coincident pair and say so.
  const walls: typeof rawWalls = []
  const dropped: string[] = []
  for (const w of [...rawWalls].sort((a, b) => b.length - a.length)) {
    const dup = walls.find((kept) => {
      if (Math.abs(kept.thickness - w.thickness) > 0.03) return false
      const cross = Math.abs(kept.dir[0] * w.dir[1] - kept.dir[1] * w.dir[0])
      if (cross > 0.05) return false
      // both endpoints of w lie on kept's centerline band
      const on = (p: readonly [number, number]): boolean => {
        const dx = p[0] - kept.start[0]
        const dz = p[1] - kept.start[1]
        const along = dx * kept.dir[0] + dz * kept.dir[1]
        const off = Math.abs(-dx * kept.dir[1] + dz * kept.dir[0])
        return along > -0.05 && along < kept.length + 0.05 && off < kept.thickness / 2
      }
      return on(w.start) && on(w.end)
    })
    if (dup) dropped.push(w.id)
    else walls.push(w)
  }
  if (dropped.length > 0) {
    warnings.push(
      `${dropped.length} duplicate overlapping wall${dropped.length > 1 ? 's' : ''} skipped (framed once, not twice)`,
    )
  }
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
    // Assembly layers (round 13): drywall / sheathing / WRB / cladding per
    // face, jurisdiction-defaulted cladding + climate labels. The renderer's
    // dollhouse cut hides the camera-facing stacks.
    members.push(...layoutWallLayers(framed, activeRooms, spec, code, slabs))
    members.push(...cmuWalls(masonry, spec))
  }

  // Rooms with no flooring at all deserve a call-out regardless of level
  // (quality round-2: a phantom room had no slab and nothing said so).
  if (slabs.length > 0) {
    const inPoly = (p: readonly [number, number], poly: readonly (readonly [number, number])[]): boolean => {
      let inside = false
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i] as readonly [number, number]
        const [xj, zj] = poly[j] as readonly [number, number]
        if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside
      }
      return inside
    }
    for (const room of activeRooms) {
      const c = room.polygon.reduce<[number, number]>(
        (acc, p) => [acc[0] + p[0] / room.polygon.length, acc[1] + p[1] / room.polygon.length],
        [0, 0],
      )
      // Sample the centroid AND points nudged toward vertices: a centroid
      // landing exactly on a slab corner ray-casts as covered
      // (quality round-3 — the warning never fired).
      const samples: [number, number][] = [c]
      for (const v of room.polygon.slice(0, 4)) {
        samples.push([c[0] + (v[0] - c[0]) * 0.5, c[1] + (v[1] - c[1]) * 0.5])
      }
      const covered = samples.filter((pt) => slabs.some((sl) => inPoly(pt, sl.polygon))).length
      if (covered <= samples.length / 2) {
        warnings.push(`Room "${room.name}" has no floor slab under it`)
      }
    }
  }

  if (config.showFloor) {
    if (isGroundLevel) {
      // Ground floors are slab-on-grade here — the FOUNDATION owns that
      // geometry. Say so instead of silently doing nothing (quality A4:
      // the toggle looked dead), and call out rooms with no slab at all.
      if (slabs.length === 0) {
        warnings.push('No floor slabs on this level — rooms have no floor to derive')
      } else {
        warnings.push('Ground floor is slab-on-grade — see Foundation for the slab and footings')
      }
    } else {
      const storeyBelowHeight = levels[levelIndex - 1]?.height ?? 2.4
      members.push(...frameFloor(slabs, activeWalls, spec, storeyBelowHeight))
    }
  }

  if (config.showRoof) {
    // Roof segments usually live on their OWN level above this one — search
    // this level first, then the nearest OTHER level, preferring levels
    // above (quality A4: the Roof toggle was dead unless the bones node sat
    // on the roof level itself).
    let roofs = extractRoofs(nodes, levelId)
    let roofLevel = levels[levelIndex]
    if (roofs.length === 0) {
      const myOrdinal = levels[levelIndex]?.level ?? 0
      const candidates = levels
        .filter((l) => l.id !== levelId)
        .sort((a, b) => {
          const aAbove = a.level > myOrdinal ? 0 : 1
          const bAbove = b.level > myOrdinal ? 0 : 1
          if (aAbove !== bAbove) return aAbove - bAbove
          return Math.abs(a.level - myOrdinal) - Math.abs(b.level - myOrdinal)
        })
      for (const other of candidates) {
        const found = extractRoofs(nodes, other.id)
        if (found.length > 0) {
          roofs = found
          roofLevel = other
          break
        }
      }
    }
    if (roofs.length > 0 && roofLevel && roofLevel.id !== levelId) {
      // A shared roof is framed by exactly ONE X-ray — the node on the
      // highest storey (two nodes framing it would z-fight duplicate
      // trusses). Everyone else says where to look.
      const rivals = Object.values(nodes).filter(
        (n) =>
          n.type === config.type &&
          n.showRoof !== false &&
          typeof n.parentId === 'string' &&
          levels.some((l) => l.id === n.parentId),
      )
      const ordinalOf = (n: Record<string, unknown>) =>
        levels.find((l) => l.id === n.parentId)?.level ?? Number.NEGATIVE_INFINITY
      const owner = rivals.reduce((best, n) => {
        const a = ordinalOf(n)
        const b = ordinalOf(best)
        if (a > b) return n
        if (a === b && String(n.id) < String(best.id)) return n
        return best
      }, rivals[0] ?? {})
      if (owner && String(owner.id) !== String(config.id)) {
        roofs = []
        warnings.push('Roof is framed by the X-ray on the storey above')
      }
    }
    // Members come out roof-LEVEL-local; this node renders inside ITS OWN
    // level's group. Shift by the storey elevation delta so trusses land at
    // the true roof height, not on this floor (prod 2026-08-15: a two-storey
    // house wore its roof at ground level).
    const dy = (roofLevel?.baseY ?? 0) - (levels[levelIndex]?.baseY ?? 0)
    const framed = frameRoofs(roofs, activeWalls, spec)
    members.push(
      ...(dy === 0
        ? framed
        : framed.map((m) => ({
            ...m,
            position: [m.position[0], m.position[1] + dy, m.position[2]] as const,
          }))),
    )
  }

  if (config.showFoundation && isGroundLevel) {
    members.push(...buildFoundation(activeWalls, slabs, spec))
  }

  if (config.showElectrical) {
    const electrical = layoutElectrical(activeWalls, activeRooms)
    fixtures.push(...electrical)
    // LOD 400: homerun + branch wiring following the walls to the panel.
    if (spec.detail === '400') members.push(...routeWiring(electrical, activeWalls))
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
