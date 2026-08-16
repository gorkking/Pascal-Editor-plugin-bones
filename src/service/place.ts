import {
  extractPlacedFixtures,
  extractRooms,
  extractSlabs,
  extractWalls,
} from '../core/wall-model'
import { placePanelSpot } from '../engines/electrical'
import { placeMeterSpot, placeSewerExit, placeWhSpot } from '../engines/plumbing'
import { ServiceNode, type ServiceType } from './schema'

/**
 * The "Place service points" panel action, as a pure function: build the
 * `bones:service` nodes to create on `levelId` — one per type, seeded at the
 * ENGINES' current auto positions (panelMountU garage rule, plumbing's
 * meter/WH/sewer-exit spots), so nothing moves until the user drags one.
 * Idempotent: types that already have a node on this level are skipped.
 */
export function buildServicePointNodes(
  nodes: Record<string, Record<string, unknown>>,
  levelId: string,
): ServiceNode[] {
  const existing = new Set<string>()
  for (const node of Object.values(nodes)) {
    if (node.type === 'bones:service' && node.parentId === levelId && node.visible !== false) {
      existing.add(String(node.serviceType))
    }
  }

  const slabs = extractSlabs(nodes, levelId)
  const walls = extractWalls(nodes, levelId, slabs)
  const rooms = extractRooms(nodes, levelId)
  const placed = extractPlacedFixtures(nodes, levelId)

  const out: ServiceNode[] = []
  const wallPoint = (
    serviceType: ServiceType,
    spot: { wall: { id: string; length: number }; u: number; heightAff: number } | null,
  ) => {
    if (existing.has(serviceType) || !spot || spot.wall.length <= 0) return
    out.push(
      ServiceNode.parse({
        serviceType,
        wallId: spot.wall.id,
        wallT: Math.max(0, Math.min(1, spot.u / spot.wall.length)),
        heightAff: spot.heightAff,
      }),
    )
  }

  const panelSpot = placePanelSpot(walls, rooms)
  wallPoint('panel', panelSpot)
  // Power entry: the service drop lands at the panel's wall bay, near the
  // top of the wall (weatherhead height) — routing to it is a later task.
  wallPoint(
    'power-entry',
    panelSpot
      ? { ...panelSpot, heightAff: Math.max(0.5, panelSpot.wall.height - 0.3) }
      : null,
  )
  wallPoint('water-heater', placeWhSpot(walls, rooms))
  wallPoint('water-entry', placeMeterSpot(walls))

  if (!existing.has('sewer-exit')) {
    const exit = placeSewerExit(walls, rooms, placed)
    if (exit) {
      out.push(ServiceNode.parse({ serviceType: 'sewer-exit', position: [exit[0], 0, exit[1]] }))
    }
  }

  return out
}
