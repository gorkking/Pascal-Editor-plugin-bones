import { inches } from '../core/units'
import type { ServiceNode, ServiceType } from './schema'

/**
 * Pure placement resolution for `bones:service` nodes — shared by the 3D
 * renderer and the engine override extraction, and testable headlessly
 * (no React, no three.js).
 */

export type BodySpec = {
  /** Box dims [w, h, d] — d is the off-wall axis. */
  dims: readonly [number, number, number]
  color: string
  /** Default mount height (device CENTER, m AFF) when `heightAff` is unset. */
  defaultAff: number
  /** Sign text (the panel also gets a drawn bolt glyph). */
  sign: string
}

/** Equipment look per type — panel grey enclosure, WH per the engine's tank,
 * water entry valve box, sewer 4" stub at the floor, power cable head. */
export const SERVICE_BODY: Record<ServiceType, BodySpec> = {
  panel: { dims: [0.4, 0.6, 0.1], color: '#8f8f8f', defaultAff: inches(60), sign: 'PANEL' },
  'water-heater': { dims: [0.6, 1.5, 0.6], color: '#c7c9cc', defaultAff: 1.2, sign: 'WH' },
  'water-entry': { dims: [0.2, 0.2, 0.14], color: '#3f6fae', defaultAff: 0.3, sign: 'WATER' },
  'sewer-exit': { dims: [inches(4), 0.3, inches(4)], color: '#5b6670', defaultAff: 0.15, sign: 'SEWER' },
  'power-entry': { dims: [0.12, 0.28, 0.12], color: '#3a3a3e', defaultAff: 2.2, sign: 'POWER' },
}

/** Types that live on a wall face — a gizmo-moved `position` snaps back to
 * the nearest wall (mirroring the engines' nearestWallPoint override rule);
 * floor types (sewer exit) stand free wherever they're dropped. */
export const WALL_MOUNTED_TYPES: ReadonlySet<ServiceType> = new Set<ServiceType>([
  'panel',
  'water-heater',
  'water-entry',
  'power-entry',
])

export type ServicePlacement = {
  /** Level-local position of the equipment center. */
  position: readonly [number, number, number]
  rotationY: number
  /** Wall thickness at the anchor (sign offset) — 0 when floor-placed. */
  wallThickness: number
  wallMounted: boolean
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const num = (v: unknown, fallback: number): number => (finite(v) ? v : fallback)

const pair = (v: unknown): readonly [number, number] | null =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
    ? [v[0], v[1]]
    : null

const POS_EPS = 1e-6

/**
 * True when `position` carries a real gizmo write: every component finite AND
 * off the schema default [0,0,0] (within 1e-6). The default means "never
 * moved"; NaN/Infinity components make the position unusable (never trust it).
 */
export function isMovedPosition(
  position: readonly unknown[] | undefined,
): position is readonly [number, number, number] {
  if (!Array.isArray(position) || position.length < 3) return false
  const [x, y, z] = position as unknown[]
  if (!finite(x) || !finite(y) || !finite(z)) return false
  return Math.abs(x) > POS_EPS || Math.abs(y) > POS_EPS || Math.abs(z) > POS_EPS
}

/** The node fields placement resolution reads (parentId scopes wall lookups). */
export type ServicePlacementNode = Pick<
  ServiceNode,
  'serviceType' | 'wallId' | 'wallT' | 'heightAff' | 'position' | 'rotation'
> & { parentId?: string | null }

type WallGeom = {
  start: readonly [number, number]
  end: readonly [number, number]
  thickness: number
}

/**
 * A usable straight wall for anchoring on the node's own level. Missing,
 * non-wall, CURVED (the lerp is a chord — wrong), FOREIGN-level (positions
 * are level-local) or degenerate walls are NOT anchors → null.
 */
function usableWall(
  wall: Record<string, unknown> | undefined,
  node: ServicePlacementNode,
): WallGeom | null {
  if (!wall || wall.type !== 'wall') return null
  if (
    typeof node.parentId === 'string' &&
    typeof wall.parentId === 'string' &&
    wall.parentId !== node.parentId
  ) {
    return null
  }
  if (Math.abs(num(wall.curveOffset, 0)) > 1e-6) return null
  const start = pair(wall.start)
  const end = pair(wall.end)
  if (!start || !end) return null
  if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.1) return null
  return { start, end, thickness: num(wall.thickness, 0.1) }
}

function wallLerp(geom: WallGeom, t: number, y: number): ServicePlacement {
  const { start, end } = geom
  const x = start[0] + (end[0] - start[0]) * t
  const z = start[1] + (end[1] - start[1]) * t
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const len = Math.hypot(dx, dz) || 1
  // Local +Z points along the wall's +normal [-dz, dx] (engine convention).
  return {
    position: [x, y, z],
    rotationY: Math.atan2(-dz / len, dx / len),
    wallThickness: geom.thickness,
    wallMounted: true,
  }
}

/** Nearest point on any usable wall to plan point `p` — the renderer's analog
 * of the engines' nearestWallPoint (no opening avoidance: this is a visual
 * snap, the engines re-derive their own routed spot from the same node). */
function nearestWallSnap(
  nodes: Record<string, Record<string, unknown>>,
  node: ServicePlacementNode,
  p: readonly [number, number],
  y: number,
): ServicePlacement | null {
  let best: ServicePlacement | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const cand of Object.values(nodes)) {
    const geom = usableWall(cand, node)
    if (!geom) continue
    const dx = geom.end[0] - geom.start[0]
    const dz = geom.end[1] - geom.start[1]
    const len2 = dx * dx + dz * dz
    const t = Math.max(
      0,
      Math.min(1, ((p[0] - geom.start[0]) * dx + (p[1] - geom.start[1]) * dz) / len2),
    )
    const placement = wallLerp(geom, t, y)
    const d = Math.hypot(placement.position[0] - p[0], placement.position[2] - p[1])
    if (d < bestDist) {
      bestDist = d
      best = placement
    }
  }
  return best
}

/**
 * Resolve where a service node stands. Precedence (matches the engines'
 * `overrideWallPoint`):
 *  1. a gizmo-written `position` (non-default — see `isMovedPosition`) WINS
 *     over the wall anchor: wall types snap to the nearest wall, floor types
 *     stand free (otherwise host gizmo drags would silently no-op);
 *  2. default position → the `wallId`+`wallT` lerp (height `heightAff`);
 *  3. no usable anchor at all (missing/curved/foreign wall + never-moved
 *     position) → null: the engines auto-place and the renderer shows only
 *     a selectable stub.
 */
export function resolveServicePlacement(
  nodes: Record<string, Record<string, unknown>>,
  node: ServicePlacementNode,
): ServicePlacement | null {
  const body = SERVICE_BODY[node.serviceType]
  const y = num(node.heightAff, body.defaultAff)

  if (isMovedPosition(node.position)) {
    const [px, , pz] = node.position
    if (WALL_MOUNTED_TYPES.has(node.serviceType)) {
      const snap = nearestWallSnap(nodes, node, [px, pz], y)
      if (snap) return snap
    }
    return {
      position: [px, y, pz],
      rotationY: num(node.rotation?.[1], 0),
      wallThickness: 0,
      wallMounted: false,
    }
  }

  const wall = node.wallId ? usableWall(nodes[node.wallId], node) : null
  if (wall) {
    const t = Math.max(0, Math.min(1, num(node.wallT, 0.5)))
    return wallLerp(wall, t, y)
  }

  return null
}
