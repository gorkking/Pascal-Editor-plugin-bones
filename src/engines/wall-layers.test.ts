import { describe, expect, test } from 'bun:test'
import { DEFAULT_SPEC } from '../core/spec'
import type { RoomSlice, WallSlice } from '../core/types'
import { exteriorSide, layoutWallLayers } from './wall-layers'

const spec400 = { ...DEFAULT_SPEC, detail: '400' as const }

function wall(overrides: Partial<WallSlice> = {}): WallSlice {
  const start = overrides.start ?? [0, 0]
  const end = overrides.end ?? [6, 0]
  const dx = (end[0] ?? 0) - (start[0] ?? 0)
  const dz = (end[1] ?? 0) - (start[1] ?? 0)
  const length = Math.hypot(dx, dz)
  return {
    id: 'wall_L',
    start,
    end,
    dir: [dx / length, dz / length],
    length,
    thickness: 0.114,
    height: 2.44,
    exterior: true,
    openings: [],
    curved: false,
    ...overrides,
  }
}

/** Room ABOVE the default wall (z ∈ [0, 4]) — interior is side +1. */
const roomAbove: RoomSlice = {
  id: 'room_a',
  name: 'living',
  category: 'other',
  polygon: [
    [0, 0],
    [6, 0],
    [6, 4],
    [0, 4],
  ],
  boundaryWallIds: ['wall_L'],
  ceilingHeight: 2.7,
}

describe('exteriorSide', () => {
  test('room on +1 side → exterior faces −1; interior walls → null', () => {
    expect(exteriorSide(wall(), [roomAbove])).toBe(-1)
    expect(exteriorSide(wall({ exterior: false }), [roomAbove])).toBe(null)
    // rooms on both sides → ambiguous → null
    const roomBelow: RoomSlice = { ...roomAbove, id: 'room_b', polygon: [[0, -4], [6, -4], [6, 0], [0, 0]] }
    expect(exteriorSide(wall(), [roomAbove, roomBelow])).toBe(null)
  })
})

describe('layoutWallLayers', () => {
  test('interior partition: gypsum on BOTH faces, half inch, nothing else', () => {
    const layers = layoutWallLayers([wall({ exterior: false })], [roomAbove], spec400, 'NY')
    const drywall = layers.filter((m) => m.role === 'drywall')
    expect(drywall.length).toBe(2)
    expect(layers.filter((m) => m.role === 'sheathing')).toHaveLength(0)
    expect(layers.filter((m) => m.role === 'wrb')).toHaveLength(0)
    expect(layers.filter((m) => m.role === 'cladding')).toHaveLength(0)
    for (const d of drywall) {
      expect(d.dims[2]).toBeCloseTo(0.0127, 4) // 1/2"
      expect(Math.abs(d.position[2] as number)).toBeCloseTo(0.114 / 2 + 0.0127 / 2, 5)
      expect(d.face).toBeDefined()
      expect(d.label).toContain('R702')
    }
    // opposite faces
    const zs = drywall.map((d) => d.position[2] as number)
    expect(Math.sign(zs[0] as number)).not.toBe(Math.sign(zs[1] as number))
  })

  test('exterior wall (NY→vinyl): gypsum inside; sheathing→WRB→cladding outside, stacked outward', () => {
    const layers = layoutWallLayers([wall()], [roomAbove], spec400, 'NY')
    const bySide = (side: number) => layers.filter((m) => Math.sign(m.position[2] as number) === side)
    // interior face (+1, toward the room): gypsum only
    const inside = bySide(1)
    expect(inside.every((m) => m.role === 'drywall')).toBe(true)
    // exterior face (−1): sheathing then wrb then cladding, increasing offset
    const outside = bySide(-1)
    const roleOrder = ['sheathing', 'wrb', 'cladding']
    for (const role of roleOrder) {
      expect(outside.some((m) => m.role === role)).toBe(true)
    }
    const offsetOf = (role: string) =>
      Math.abs(
        (outside.find((m) => m.role === role)?.position[2] as number) ?? 0,
      )
    expect(offsetOf('sheathing')).toBeLessThan(offsetOf('wrb'))
    expect(offsetOf('wrb')).toBeLessThan(offsetOf('cladding'))
    // sheathing is the researched 7/16" WSP
    const sheathing = outside.find((m) => m.role === 'sheathing')
    expect(sheathing?.dims[2]).toBeCloseTo(0.4375 * 0.0254, 5)
    expect(sheathing?.label).toContain('R602.3(3)')
    // WRB cites R703.2; climate note rides the stack labels
    expect(outside.find((m) => m.role === 'wrb')?.label).toContain('R703.2')
    // exterior members carry the outward face normal (−1 side → [0, −1])
    for (const m of outside) expect(m.face?.[1]).toBeCloseTo(-1, 6)
  })

  test('FL defaults to stucco with a DOUBLED WRB (R703.7.3)', () => {
    const layers = layoutWallLayers([wall()], [roomAbove], spec400, 'FL')
    const wrbs = layers.filter((m) => m.role === 'wrb')
    expect(wrbs).toHaveLength(2)
    const cladding = layers.find((m) => m.role === 'cladding')
    // FL stucco = 3-coat cement plaster (ASTM C926), 7/8" thick
    expect(cladding?.label?.toLowerCase()).toContain('cement plaster')
    expect(cladding?.dims[2]).toBeCloseTo(0.875 * 0.0254, 5)
  })

  test('openings punch through every layer (band segments, none inside the RO)', () => {
    const w = wall({
      openings: [
        {
          id: 'win_1',
          kind: 'window',
          u: 3,
          width: 1.2,
          roughWidth: 1.25,
          height: 1.2,
          roughHeight: 1.25,
          sillHeight: 0.9,
        },
      ],
    })
    const layers = layoutWallLayers([w], [roomAbove], spec400, 'NY')
    // no layer box's u-extent+y-extent sits inside the RO interior
    for (const m of layers) {
      const u = m.position[0] as number
      const y = m.position[1] as number
      const halfLen = m.dims[0] / 2
      const halfH = m.dims[1] / 2
      const insideU = u - halfLen > 3 - 1.25 / 2 + 0.001 && u + halfLen < 3 + 1.25 / 2 - 0.001
      const insideY = y - halfH > 0.9 + 0.001 && y + halfH < 0.9 + 1.25 - 0.001
      expect(insideU && insideY).toBe(false)
    }
    // under-sill and over-header bands exist
    expect(layers.some((m) => (m.position[1] as number) < 0.5)).toBe(true)
    expect(layers.some((m) => (m.position[1] as number) > 2.2)).toBe(true)
  })

  test('LOD 200 emits no layers', () => {
    expect(layoutWallLayers([wall()], [roomAbove], { ...DEFAULT_SPEC, detail: '200' }, 'NY')).toEqual([])
  })
})
