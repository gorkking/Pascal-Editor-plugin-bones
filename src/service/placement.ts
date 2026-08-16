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

export type ServicePlacement = {
  /** Level-local position of the equipment center. */
  position: readonly [number, number, number]
  rotationY: number
  /** Wall thickness at the anchor (sign offset) — 0 when floor-placed. */
  wallThickness: number
  wallMounted: boolean
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const pair = (v: unknown): readonly [number, number] | null =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
    ? [v[0], v[1]]
    : null

/**
 * Resolve where a service node stands: wall lerp (`wallId`+`wallT`, height
 * `heightAff`) when anchored to a live wall, else the stored `position`.
 */
export function resolveServicePlacement(
  nodes: Record<string, Record<string, unknown>>,
  node: Pick<ServiceNode, 'serviceType' | 'wallId' | 'wallT' | 'heightAff' | 'position' | 'rotation'>,
): ServicePlacement {
  const body = SERVICE_BODY[node.serviceType]
  const wall = node.wallId ? nodes[node.wallId] : undefined
  const start = wall ? pair(wall.start) : null
  const end = wall ? pair(wall.end) : null
  if (wall && start && end && typeof node.wallT === 'number') {
    const t = Math.max(0, Math.min(1, node.wallT))
    const x = start[0] + (end[0] - start[0]) * t
    const z = start[1] + (end[1] - start[1]) * t
    const dx = end[0] - start[0]
    const dz = end[1] - start[1]
    const len = Math.hypot(dx, dz) || 1
    // Local +Z points along the wall's +normal [-dz, dx] (engine convention).
    const rotationY = Math.atan2(-dz / len, dx / len)
    return {
      position: [x, node.heightAff ?? body.defaultAff, z],
      rotationY,
      wallThickness: num(wall.thickness, 0.1),
      wallMounted: true,
    }
  }
  const [px, , pz] = node.position
  return {
    position: [px, node.heightAff ?? body.defaultAff, pz],
    rotationY: node.rotation[1] ?? 0,
    wallThickness: 0,
    wallMounted: false,
  }
}
