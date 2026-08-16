import { BaseNode, nodeType, objectId } from '@pascal-app/core'
import { z } from 'zod'

/**
 * The `bones:service` node — a draggable building/utility interface point
 * (docs/plans/service-nodes.md). One kind, discriminated by `serviceType`:
 * electric panel, water heater, water entry (meter + main shut-off), sewer
 * exit and power entry. The node's position IS the truth: engines consume it
 * as an override and re-route wires/pipes to wherever it stands; when no node
 * exists they auto-place exactly as before.
 *
 * Wall-mounted types mirror the host item wall contract (`wallId` + `wallT`
 * 0..1 along the wall + `heightAff`) so host tools can slide them along a
 * wall. `position` is the level-local spot for floor-placed types (sewer
 * exit) AND the standard gizmo's write target: once moved off the default
 * [0,0,0] it OUTRANKS the wall anchor (wall types snap to the nearest wall),
 * so a drag is never a silent no-op.
 */

export const SERVICE_TYPES = [
  'panel',
  'water-heater',
  'water-entry',
  'sewer-exit',
  'power-entry',
] as const

export const ServiceType = z.enum(SERVICE_TYPES)
export type ServiceType = z.infer<typeof ServiceType>

export const ServiceNode = BaseNode.extend({
  id: objectId('bonesservice'),
  type: nodeType('bones:service'),
  serviceType: ServiceType,
  /** Wall the point mounts on (host wall node id) — wall-mounted types. */
  wallId: z.string().optional(),
  /** Normalized coordinate along the wall from `start` (0..1). */
  wallT: z.number().min(0).max(1).optional(),
  /** Mount height above finished floor, meters (device center). */
  heightAff: z.number().optional(),
  /** Level-local position — the fallback when not wall-anchored. */
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
}).describe(
  `Bones service point — a building/utility interface the systems route to.
  - serviceType: panel (electric service panel) | water-heater | water-entry (meter + shut-off) | sewer-exit | power-entry
  - wallId + wallT (0..1 along the wall) + heightAff: wall-mounted anchor; move it and wires/pipes re-route
  - position: level-local spot for floor-placed types (sewer exit); once moved off [0,0,0] (gizmo drag) it outranks the wall anchor
  Engines treat an existing node as authoritative; delete it to return to auto-placement.`,
)

export type ServiceNode = z.infer<typeof ServiceNode>

/** Display label for each service type (sign plates + inspector). */
export const SERVICE_LABEL: Record<ServiceType, string> = {
  panel: 'Electric panel',
  'water-heater': 'Water heater',
  'water-entry': 'Water entry',
  'sewer-exit': 'Sewer exit',
  'power-entry': 'Power entry',
}
