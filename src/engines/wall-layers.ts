/**
 * Wall assembly layers — pure function: (WallSlice[], RoomSlice[], spec) →
 * Member[] with roles drywall / sheathing / wrb / cladding.
 *
 * The drawn wall is the FRAMING envelope; finishes stack OUTWARD from its
 * faces per data/wall-assemblies.json (researched, every layer cited):
 *  - interior partition: 1/2" gypsum on both faces (R702.3.5);
 *  - exterior wall, inside→out: 1/2" gypsum, then past the studs 7/16" WSP
 *    sheathing (Table R602.3(3)), the WRB (R703.2 — No.15 felt/housewrap,
 *    rendered 1/16" symbolic, DOUBLED under stucco per R703.7.3), and the
 *    jurisdiction's default cladding family (thickness per R703 subsection);
 *  - openings punch through every layer (band segments around the RO).
 *
 * Which face is exterior comes from the room polygons: the face whose probe
 * point sits in no room faces outdoors. Corner treatment mirrors the
 * framing run insets: a butting wall's layers stop at the through wall's
 * face, the through wall's layers run past (how drywall is actually hung).
 * Insulation batts and vapor-retarder geometry land in a later round — the
 * climate-zone R-value/class ride the labels for now.
 */

import assemblies from '../../data/wall-assemblies.json'
import { DEFAULT_SPEC, type FramingSpec } from '../core/spec'
import type { Member, MemberRole, RoomSlice, SlabSlice, WallSlice } from '../core/types'
import { inches } from '../core/units'

type Pt = readonly [number, number]

type LayerSpec = { role: string; thicknessIn: number; material: string; citation: string }
type Assemblies = {
  interior: { layers: LayerSpec[] }
  exterior: {
    sheathing: { layers: LayerSpec[] }
    wrb: { layers: LayerSpec[]; stuccoDoubleLayer?: boolean }
    claddings: Record<string, { layers: LayerSpec[] }>
    defaultCladdingByState: Record<string, string>
    stateClimateZone?: Record<string, string>
    insulationByClimateZone?: Record<string, string>
    vaporRetarderClassByZone?: Record<string, string>
  }
}
const DATA = assemblies as unknown as Assemblies

function pointInPolygon(p: Pt, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i] as readonly [number, number]
    const [xj, zj] = polygon[j] as readonly [number, number]
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Plan normal of a wall for side +1: rotate dir by -90° (matches faceOf). */
const normalOf = (wall: WallSlice, side: 1 | -1): Pt => [
  -wall.dir[1] * side,
  wall.dir[0] * side,
]

/** Which side (+1/−1) of an exterior wall faces OUTDOORS. FLOORING is the
 * automatic signal (round-13 user feedback): the side standing over a slab
 * is inside — slabs exist wherever rooms do, even before zones are drawn.
 * Room polygons are the fallback; null = ambiguous (treated as interior). */
export function exteriorSide(
  wall: WallSlice,
  rooms: RoomSlice[],
  slabs: SlabSlice[] = [],
): 1 | -1 | null {
  if (!wall.exterior) return null
  const mid: Pt = [
    wall.start[0] + (wall.dir[0] * wall.length) / 2,
    wall.start[1] + (wall.dir[1] * wall.length) / 2,
  ]
  const probeDist = wall.thickness / 2 + 0.15
  const probe = (side: 1 | -1): Pt => {
    const n = normalOf(wall, side)
    return [mid[0] + n[0] * probeDist, mid[1] + n[1] * probeDist]
  }
  const overSlab = (p: Pt): boolean => slabs.some((sl) => pointInPolygon(p, sl.polygon))
  const inRoom = (p: Pt): boolean => rooms.some((r) => pointInPolygon(p, r.polygon))
  const pPlus = probe(1)
  const pMinus = probe(-1)
  // flooring first
  const plusFloor = overSlab(pPlus)
  const minusFloor = overSlab(pMinus)
  if (plusFloor !== minusFloor) return plusFloor ? -1 : 1
  // rooms fallback
  const plusRoom = inRoom(pPlus)
  const minusRoom = inRoom(pMinus)
  if (plusRoom !== minusRoom) return plusRoom ? -1 : 1
  return null
}

/** u-intervals of the wall NOT covered by an opening whose vertical extent
 * intersects [y0, y1] — plus the over/under bands for partly-tall openings. */
type Band = { u0: number; u1: number; y0: number; y1: number }

function bandsAround(wall: WallSlice, height: number): Band[] {
  const bands: Band[] = []
  const cuts = wall.openings
    .map((o) => ({
      lo: Math.max(0, o.u - o.roughWidth / 2),
      hi: Math.min(wall.length, o.u + o.roughWidth / 2),
      yLo: o.sillHeight,
      yHi: Math.min(height, o.sillHeight + o.roughHeight),
    }))
    .sort((a, b) => a.lo - b.lo)
  let cursor = 0
  for (const cut of cuts) {
    if (cut.lo > cursor + 0.01) bands.push({ u0: cursor, u1: cut.lo, y0: 0, y1: height })
    // bands above and below the opening itself
    if (cut.yLo > 0.01) bands.push({ u0: cut.lo, u1: cut.hi, y0: 0, y1: cut.yLo })
    if (cut.yHi < height - 0.01) bands.push({ u0: cut.lo, u1: cut.hi, y0: cut.yHi, y1: height })
    cursor = Math.max(cursor, cut.hi)
  }
  if (cursor < wall.length - 0.01) bands.push({ u0: cursor, u1: wall.length, y0: 0, y1: height })
  return bands.filter((b) => b.u1 - b.u0 > 0.01 && b.y1 - b.y0 > 0.01)
}

/** Corner run insets, mirroring frameWalls: butting layers stop at the
 * through wall's face. Cheap re-derivation (endpoint coincidence). */
function runInsets(wall: WallSlice, walls: WallSlice[]): { start: number; end: number } {
  const insets = { start: 0, end: 0 }
  const ends: { which: 'start' | 'end'; p: Pt }[] = [
    { which: 'start', p: wall.start },
    { which: 'end', p: wall.end },
  ]
  for (const { which, p } of ends) {
    for (const other of walls) {
      if (other.id === wall.id || other.curved) continue
      const tol = Math.max(wall.thickness, other.thickness) * 0.75
      const dEnds = Math.min(
        Math.hypot(p[0] - other.start[0], p[1] - other.start[1]),
        Math.hypot(p[0] - other.end[0], p[1] - other.end[1]),
      )
      if (dEnds > tol) continue
      const through = other.length > wall.length || (other.length === wall.length && other.id < wall.id)
      if (through) insets[which] = Math.max(insets[which], other.thickness / 2)
    }
  }
  return insets
}

const ROLE_OF: Record<string, MemberRole> = {
  drywall: 'drywall',
  sheathing: 'sheathing',
  wrb: 'wrb',
  cladding: 'cladding',
}

export function layoutWallLayers(
  walls: WallSlice[],
  rooms: RoomSlice[],
  spec: FramingSpec = DEFAULT_SPEC,
  /** Resolved state code (drives cladding family + climate labels). */
  stateCode = 'NY',
  /** Floor slabs — the automatic inside/outside signal. */
  slabs: SlabSlice[] = [],
): Member[] {
  const members: Member[] = []
  if (spec.detail === '200') return members

  const state = stateCode
  const claddingKey = DATA.exterior.defaultCladdingByState[state] ?? 'vinyl'
  const cladding = DATA.exterior.claddings[claddingKey] ?? DATA.exterior.claddings.vinyl
  const zone = DATA.exterior.stateClimateZone?.[state]
  const rValue = zone ? DATA.exterior.insulationByClimateZone?.[zone] : undefined

  for (const wall of walls) {
    if (wall.curved || wall.length < 0.2) continue
    const inset = runInsets(wall, walls)
    const extSide = exteriorSide(wall, rooms, slabs)
    const bands = bandsAround(wall, wall.height)

    /** Emit one layer stack outward from face `side`, starting at the
     * framing face, ordered inside→out. */
    const emitStack = (side: 1 | -1, layers: LayerSpec[], noteSuffix = '') => {
      const n = normalOf(wall, side)
      let offset = wall.thickness / 2
      for (const layer of layers) {
        const t = inches(layer.thicknessIn)
        const role = ROLE_OF[layer.role]
        if (!role) continue
        const center = offset + t / 2
        for (const band of bands) {
          const len = band.u1 - band.u0 - (band.u0 < 0.02 ? inset.start : 0) - (band.u1 > wall.length - 0.02 ? inset.end : 0)
          if (len < 0.02) continue
          const u0 = band.u0 + (band.u0 < 0.02 ? inset.start : 0)
          const uMid = u0 + len / 2
          const yaw = Math.atan2(-wall.dir[1], wall.dir[0])
          members.push({
            system: 'wall-framing',
            role,
            dims: [len, band.y1 - band.y0, t],
            length: len,
            position: [
              wall.start[0] + wall.dir[0] * uMid + n[0] * center,
              (band.y0 + band.y1) / 2,
              wall.start[1] + wall.dir[1] * uMid + n[1] * center,
            ],
            rotation: [0, yaw, 0],
            material: 'lumber',
            sourceId: wall.id,
            label: `${layer.material}${noteSuffix} (${layer.citation})`,
            face: [n[0], n[1]],
          })
        }
        offset += t
      }
    }

    const gypsum = DATA.interior.layers.filter((l) => l.role === 'drywall').slice(0, 1)
    if (extSide === null) {
      // interior partition: gypsum both faces
      emitStack(1, gypsum)
      emitStack(-1, gypsum)
    } else {
      // interior face: gypsum (+ vapor retarder note by climate zone)
      const vapor = zone ? DATA.exterior.vaporRetarderClassByZone?.[zone] : undefined
      emitStack(
        (-extSide) as 1 | -1,
        gypsum,
        vapor ? ` — vapor retarder ${vapor}, R702.7` : '',
      )
      // exterior face, inside→out: sheathing → WRB (×2 under stucco) → cladding
      const wrbLayers = [...DATA.exterior.wrb.layers]
      if (claddingKey === 'stucco' && wrbLayers[0]) {
        wrbLayers.push({ ...wrbLayers[0], material: `${wrbLayers[0].material} (2nd layer under stucco)` })
      }
      emitStack(
        extSide,
        [
          ...DATA.exterior.sheathing.layers,
          ...wrbLayers,
          ...(cladding?.layers ?? []),
        ],
        rValue ? ` — cavity ${rValue} (zone ${zone})` : '',
      )
    }
  }
  return members
}
