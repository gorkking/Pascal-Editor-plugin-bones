/**
 * Scene → engine model extraction. The ONLY place Bones reads Pascal node
 * shapes; engines stay pure. Wall child openings follow the host convention
 * verified against the door floor-plan renderer: `position[0]` is the opening
 * CENTER measured along the wall from `start`; doors sit on the floor,
 * windows carry their center height in `position[1]`.
 */

import { inches } from './units'
import type { OpeningSlice, RoomSlice, SlabSlice, WallSlice } from './types'

// Minimal structural views of the host nodes we read — kept local so the
// extractor compiles against any @pascal-app/core >=0.9 without depending on
// exact exported TS types.
type AnyRecord = Record<string, unknown>
type NodesRecord = Record<string, AnyRecord>

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const pair = (v: unknown): readonly [number, number] | null =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number'
    ? [v[0], v[1]]
    : null

/** Default wall height used across Pascal when a wall doesn't set one. */
const DEFAULT_WALL_HEIGHT = 2.5
const DEFAULT_WALL_THICKNESS = 0.1

function extractOpening(node: AnyRecord): OpeningSlice | null {
  const type = node.type
  if (type !== 'door' && type !== 'window') return null
  const pos = Array.isArray(node.position) ? (node.position as number[]) : [0, 0, 0]
  const width = num(node.width, type === 'door' ? 0.9 : 1.5)
  const height = num(node.height, type === 'door' ? 2.1 : 1.5)
  const centerY = num(pos[1], type === 'door' ? height / 2 : 1.5)
  const sillHeight = type === 'door' ? 0 : Math.max(0, centerY - height / 2)
  const roughWidth = num(node.roughOpeningWidth, width + inches(1.5))
  const roughHeight = num(node.roughOpeningHeight, height + inches(1.5))
  return {
    id: String(node.id ?? ''),
    kind: type,
    u: num(pos[0], 0),
    width,
    height,
    sillHeight,
    roughWidth,
    roughHeight,
  }
}

/** Extract every straight wall on `levelId` with its openings. */
export function extractWalls(nodes: NodesRecord, levelId: string): WallSlice[] {
  const walls: WallSlice[] = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'wall' || node.parentId !== levelId) continue
    if (node.visible === false) continue
    const start = pair(node.start)
    const end = pair(node.end)
    if (!start || !end) continue
    const dx = end[0] - start[0]
    const dz = end[1] - start[1]
    const length = Math.hypot(dx, dz)
    if (length < 0.05) continue
    const curved = Math.abs(num(node.curveOffset, 0)) > 1e-6

    const openings: OpeningSlice[] = []
    const childIds = Array.isArray(node.children) ? (node.children as string[]) : []
    for (const childId of childIds) {
      const child = nodes[childId]
      if (!child) continue
      const opening = extractOpening(child)
      if (opening) openings.push(opening)
    }
    openings.sort((a, b) => a.u - b.u)

    const front = node.frontSide
    const back = node.backSide
    const exterior = front === 'exterior' || back === 'exterior'

    walls.push({
      id: String(node.id ?? ''),
      start,
      end,
      length,
      dir: [dx / length, dz / length],
      thickness: num(node.thickness, DEFAULT_WALL_THICKNESS),
      height: num(node.height, DEFAULT_WALL_HEIGHT),
      exterior,
      openings,
      curved,
    })
  }
  return walls
}

/** Extract slabs on `levelId` for floor framing / foundation outlines. */
export function extractSlabs(nodes: NodesRecord, levelId: string): SlabSlice[] {
  const slabs: SlabSlice[] = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'slab' || node.parentId !== levelId) continue
    if (node.visible === false) continue
    const polygon = Array.isArray(node.polygon)
      ? (node.polygon as unknown[]).map(pair).filter((p): p is [number, number] => p !== null)
      : []
    if (polygon.length < 3) continue
    const holes = Array.isArray(node.holes)
      ? (node.holes as unknown[][]).map((h) =>
          (h as unknown[]).map(pair).filter((p): p is [number, number] => p !== null),
        )
      : []
    slabs.push({
      id: String(node.id ?? ''),
      polygon,
      holes,
      elevation: num(node.elevation, 0.05),
      thickness: num(node.thickness, 0.05),
    })
  }
  return slabs
}

/** Ordered level ids (bottom → top) with their storey heights. */
export function extractLevels(
  nodes: NodesRecord,
): { id: string; level: number; height: number }[] {
  const levels: { id: string; level: number; height: number }[] = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'level') continue
    levels.push({
      id: String(node.id ?? ''),
      level: num(node.level, 0),
      height: num(node.height, 2.7),
    })
  }
  return levels.sort((a, b) => a.level - b.level)
}

const ROOM_PATTERNS: [RegExp, RoomSlice['category']][] = [
  [/kitchen|cuisine/i, 'kitchen'],
  [/bath|wc|toilet|powder|salle de bain/i, 'bathroom'],
  [/bed|chambre|master|primary/i, 'bedroom'],
  [/garage/i, 'garage'],
  [/laundry|utility|buanderie/i, 'laundry'],
  [/hall|corridor|couloir/i, 'hallway'],
]

/** Classify a zone name into the room categories the MEP engines key on. */
export function classifyRoom(name: string): RoomSlice['category'] {
  for (const [pattern, category] of ROOM_PATTERNS) {
    if (pattern.test(name)) return category
  }
  return 'other'
}

/** Extract named rooms (zones) on `levelId`. */
export function extractRooms(nodes: NodesRecord, levelId: string): RoomSlice[] {
  const rooms: RoomSlice[] = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'zone' || node.parentId !== levelId) continue
    const polygon = Array.isArray(node.polygon)
      ? (node.polygon as unknown[]).map(pair).filter((p): p is [number, number] => p !== null)
      : []
    if (polygon.length < 3) continue
    const name = typeof node.name === 'string' ? node.name : ''
    rooms.push({
      id: String(node.id ?? ''),
      name,
      category: classifyRoom(name),
      polygon,
      boundaryWallIds: Array.isArray(node.boundaryWallIds)
        ? (node.boundaryWallIds as string[])
        : [],
      ceilingHeight: num(node.ceilingHeight, 2.7),
    })
  }
  return rooms
}
