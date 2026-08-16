/**
 * Scene → engine model extraction. The ONLY place Bones reads Pascal node
 * shapes; engines stay pure. Wall child openings follow the host convention
 * verified against the door floor-plan renderer: `position[0]` is the opening
 * CENTER measured along the wall from `start`; doors sit on the floor,
 * windows carry their center height in `position[1]`.
 */

import { inches } from './units'
import type {
  OpeningSlice,
  RoomSlice,
  ServiceOverrides,
  ServicePointOverride,
  SlabSlice,
  WallSlice,
} from './types'

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
/**
 * Geometric exterior fallback (quality round-1 A1): hosts routinely leave
 * BOTH faces 'interior', which killed sheathing/WRB/cladding, stemwall
 * hardware, and put devices on the wrong side. When no wall in the level
 * declares an exterior face, infer: probe one wall-thickness past each
 * face at the midpoint — a face with NO other wall's segment and no slab
 * coverage within the footprint faces outdoors.
 */
function applyExteriorFallback(walls: WallSlice[], slabs: { polygon: readonly (readonly [number, number])[] }[]): void {
  if (walls.some((w) => w.exterior)) return
  const inPoly = (p: readonly [number, number], poly: readonly (readonly [number, number])[]): boolean => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i] as readonly [number, number]
      const [xj, zj] = poly[j] as readonly [number, number]
      if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside
    }
    return inside
  }
  const covered = (p: readonly [number, number]): boolean =>
    slabs.some((sl) => inPoly(p, sl.polygon))
  for (const wall of walls) {
    if (wall.curved) continue
    const mid: [number, number] = [
      wall.start[0] + (wall.dir[0] * wall.length) / 2,
      wall.start[1] + (wall.dir[1] * wall.length) / 2,
    ]
    const probeDist = wall.thickness / 2 + 0.2
    let exposedSides = 0
    for (const side of [1, -1] as const) {
      const n: [number, number] = [-wall.dir[1] * side, wall.dir[0] * side]
      const p: [number, number] = [mid[0] + n[0] * probeDist, mid[1] + n[1] * probeDist]
      if (!covered(p)) exposedSides++
    }
    // exactly one exposed side = a perimeter wall
    if (exposedSides === 1) (wall as { exterior: boolean }).exterior = true
  }
}

export function extractWalls(
  nodes: NodesRecord,
  levelId: string,
  slabs: { polygon: readonly (readonly [number, number])[] }[] = [],
): WallSlice[] {
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
  applyExteriorFallback(walls, slabs)
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


// ---------------------------------------------------------------------------
// Placed sanitary fixtures — the items the USER dropped (toilet, shower…)
// are the plumbing demand points; room-category guessing is the fallback.
// ---------------------------------------------------------------------------

export type PlacedFixtureSlice = {
  id: string
  kind: 'toilet' | 'lavatory' | 'shower' | 'bathtub' | 'clothes-washer' | 'kitchen-sink'
  /** Level-local plan position of the item center. */
  plan: readonly [number, number]
  yaw: number
  /** Needs a hot-water supply (toilets are cold-only). */
  hot: boolean
  /** Drainage fixture units (IRC P3004.1). */
  dfu: number
  /** Trap/drain size, inches (IRC P3201.7). */
  drainIn: number
}

/** asset.id → sanitary profile. Kitchen counter blocks carry the sink. */
const SANITARY_ASSETS: Record<string, Omit<PlacedFixtureSlice, 'id' | 'plan' | 'yaw'>> = {
  toilet: { kind: 'toilet', hot: false, dfu: 3, drainIn: 3 },
  'bathroom-sink': { kind: 'lavatory', hot: true, dfu: 1, drainIn: 1.25 },
  'shower-square': { kind: 'shower', hot: true, dfu: 2, drainIn: 2 },
  'shower-angle': { kind: 'shower', hot: true, dfu: 2, drainIn: 2 },
  bathtub: { kind: 'bathtub', hot: true, dfu: 2, drainIn: 1.5 },
  'washing-machine': { kind: 'clothes-washer', hot: true, dfu: 2, drainIn: 2 },
  kitchen: { kind: 'kitchen-sink', hot: true, dfu: 2, drainIn: 1.5 },
  'kitchen-counter': { kind: 'kitchen-sink', hot: true, dfu: 2, drainIn: 1.5 },
}

export function extractPlacedFixtures(nodes: NodesRecord, levelId: string): PlacedFixtureSlice[] {
  const out: PlacedFixtureSlice[] = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'item' || node.parentId !== levelId) continue
    if (node.visible === false) continue
    const asset = node.asset as { id?: string } | undefined
    const profile = asset?.id ? SANITARY_ASSETS[asset.id] : undefined
    if (!profile) continue
    const pos = Array.isArray(node.position) ? (node.position as number[]) : [0, 0, 0]
    const rot = Array.isArray(node.rotation) ? (node.rotation as number[]) : [0, 0, 0]
    out.push({
      id: String(node.id ?? ''),
      plan: [num(pos[0], 0), num(pos[2], 0)],
      yaw: num(rot[1], 0),
      ...profile,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Service points — bones:service nodes are AUTHORITATIVE engine overrides
// (checklist A4): where one exists, the engine routes to it, verbatim.
// ---------------------------------------------------------------------------

/** serviceType → the engines' override slot. */
const SERVICE_OVERRIDE_KEY: Record<string, keyof ServiceOverrides> = {
  panel: 'panel',
  'water-heater': 'waterHeater',
  'water-entry': 'waterEntry',
  'sewer-exit': 'sewerExit',
  'power-entry': 'powerEntry',
}

/** Collect the service overrides on `levelId` (first node per type wins). */
export function extractServiceOverrides(nodes: NodesRecord, levelId: string): ServiceOverrides {
  const out: ServiceOverrides = {}
  for (const node of Object.values(nodes)) {
    if (node.type !== 'bones:service' || node.parentId !== levelId) continue
    if (node.visible === false) continue
    const key = SERVICE_OVERRIDE_KEY[String(node.serviceType)]
    if (!key || out[key]) continue
    const override: ServicePointOverride = {}
    if (typeof node.wallId === 'string' && node.wallId.length > 0) override.wallId = node.wallId
    if (typeof node.wallT === 'number' && Number.isFinite(node.wallT)) override.wallT = node.wallT
    if (typeof node.heightAff === 'number' && Number.isFinite(node.heightAff)) {
      override.heightAff = node.heightAff
    }
    const pos = Array.isArray(node.position) ? (node.position as number[]) : null
    if (pos && pos.length >= 3) {
      override.position = [num(pos[0], 0), num(pos[1], 0), num(pos[2], 0)]
    }
    out[key] = override
  }
  return out
}

/** Ordered level ids (bottom → top) with their storey heights. */
export type LevelSlice = {
  id: string
  level: number
  height: number
  /** Level-floor world Y — mirrors the host's storey stacking exactly
   * (core getLevelElevations): per building, ordinal order, each floor
   * sits on the one below plus its own explicit baseElevation offset. */
  baseY: number
  /** Owning building — level arithmetic (ground detection, storey-below
   * height, roof search/ownership) never crosses buildings. */
  buildingId: string | null
}

export function extractLevels(nodes: NodesRecord): LevelSlice[] {
  type Entry = LevelSlice & { baseElevation: number; buildingId: string | null }
  const buildings = Object.values(nodes).filter((n) => n.type === 'building')
  const entries: Entry[] = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'level') continue
    const id = String(node.id ?? '')
    const parentId = typeof node.parentId === 'string' ? node.parentId : null
    let buildingId = parentId && nodes[parentId]?.type === 'building' ? parentId : null
    if (!buildingId) {
      // Legacy scenes list levels only in the building's children array.
      const owner = buildings.find(
        (b) => Array.isArray(b.children) && (b.children as string[]).includes(id),
      )
      buildingId = owner ? String(owner.id ?? '') : null
    }
    entries.push({
      id,
      level: num(node.level, 0),
      // host core DEFAULT_LEVEL_HEIGHT — a 2.7 fallback desyncs baseY on
      // legacy height-less levels (verify round: 0.2 m float per storey)
      height: num(node.height, 2.5),
      baseElevation: num(node.baseElevation, 0),
      buildingId,
      baseY: 0,
    })
  }
  const cumulative = new Map<string | null, number>()
  const sorted = entries.sort((a, b) => a.level - b.level)
  for (const e of sorted) {
    e.baseY = (cumulative.get(e.buildingId) ?? 0) + e.baseElevation
    cumulative.set(e.buildingId, e.baseY + e.height)
  }
  return sorted.map(({ id, level, height, baseY, buildingId }) => ({ id, level, height, baseY, buildingId }))
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
