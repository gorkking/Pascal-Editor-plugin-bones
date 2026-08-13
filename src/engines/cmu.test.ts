import { describe, expect, test } from 'bun:test'
import { Euler, Vector3 } from 'three'
import { DEFAULT_SPEC } from '../core/spec'
import type { Member, OpeningSlice, WallSlice } from '../core/types'
import { inches } from '../core/units'
import {
  BLOCK_DEPTH_ACTUAL,
  BLOCK_LENGTH,
  COURSE_HEIGHT,
  LINTEL_BEARING,
  MORTAR_JOINT,
  cmuWall,
  courseIntervals,
} from './cmu'

// The 8" module in meters — spelled out so the assertions read as numbers.
const H = COURSE_HEIGHT // 0.2032
const B = BLOCK_LENGTH // 0.4064
const M = MORTAR_JOINT // 0.009525
const PAD = inches(1.5) // rough-opening pad used by the test openings

function makeWall(overrides: Partial<WallSlice> = {}): WallSlice {
  const start = overrides.start ?? [0, 0]
  const end = overrides.end ?? [4, 0]
  const dx = end[0] - start[0]
  const dz = end[1] - start[1]
  const length = Math.hypot(dx, dz)
  return {
    id: 'wall_cmu',
    start,
    end,
    length,
    dir: [dx / length, dz / length],
    thickness: 0.2,
    height: 2.4,
    exterior: true,
    openings: [],
    curved: false,
    ...overrides,
  }
}

function window_(u: number, width = 1.2, height = 1.0, sillHeight = 0.7): OpeningSlice {
  return {
    id: 'win_cmu',
    kind: 'window',
    u,
    width,
    height,
    sillHeight,
    roughWidth: width + PAD,
    roughHeight: height + PAD,
  }
}

function door(u: number, width = 0.9, height = 2.1): OpeningSlice {
  return {
    id: 'door_cmu',
    kind: 'door',
    u,
    width,
    height,
    sillHeight: 0,
    roughWidth: width + PAD,
    roughHeight: height + PAD,
  }
}

const byRole = (members: Member[], role: string): Member[] =>
  members.filter((m) => m.role === role)

/** Blocks of one course, identified by their Y center, sorted along the wall. */
function course(members: Member[], c: number): Member[] {
  return byRole(members, 'block')
    .filter((m) => Math.abs((m.position[1] ?? 0) - (c * H + H / 2)) < 1e-6)
    .sort((a, b) => (a.position[0] ?? 0) - (b.position[0] ?? 0))
}

describe('courseIntervals — running-bond layout math', () => {
  test('even course on a 4m wall: 9 full blocks + one cut closer', () => {
    const iv = courseIntervals(4, false)
    expect(iv).toHaveLength(10)
    expect(iv[0]?.a).toBeCloseTo(0, 9)
    expect(iv[0]?.b).toBeCloseTo(B, 9)
    // interior units are all full 16" modules
    for (let i = 0; i < 9; i++) expect((iv[i]?.b ?? 0) - (iv[i]?.a ?? 0)).toBeCloseTo(B, 9)
    // closer cut to the wall length: 4 − 9·0.4064 = 0.3424
    expect(iv[9]?.b).toBeCloseTo(4, 9)
    expect((iv[9]?.b ?? 0) - (iv[9]?.a ?? 0)).toBeCloseTo(0.3424, 6)
  })

  test('odd course starts with a half block (head joints land mid-unit below)', () => {
    const iv = courseIntervals(4, true)
    expect(iv).toHaveLength(11)
    expect((iv[0]?.b ?? 0) - (iv[0]?.a ?? 0)).toBeCloseTo(B / 2, 9)
    // every joint is offset half a module from the even-course joints
    expect(iv[1]?.a).toBeCloseTo(B / 2, 9)
    expect(iv[1]?.b).toBeCloseTo(B / 2 + B, 9)
  })

  test('unlayable slivers (< 2") are dropped, not emitted as chips', () => {
    const iv = courseIntervals(B + inches(0.5), false)
    expect(iv).toHaveLength(1) // the ½" remainder is not a block
    expect(iv[0]?.b).toBeCloseTo(B, 9)
  })
})

describe('cmuWall — solid 4m × 2.4m wall', () => {
  const wall = makeWall()
  const members = cmuWall(wall, DEFAULT_SPEC)
  const blocks = byRole(members, 'block')

  test('everything is concrete unit masonry on the wall-framing system', () => {
    expect(members.length).toBeGreaterThan(0)
    for (const m of members) {
      expect(m.system).toBe('wall-framing')
      expect(m.material).toBe('concrete')
      expect(m.sourceId).toBe('wall_cmu')
    }
    for (const b of blocks) expect(b.size).toBeUndefined() // blocks are not lumber
  })

  test('10 block courses + 1 bond-beam course (11 full courses fit in 2.4m)', () => {
    // floor(2.4 / 0.2032) = 11 total courses; the top one is the bond beam.
    const yCenters = new Set(blocks.map((b) => (b.position[1] ?? 0).toFixed(6)))
    expect(yCenters.size).toBe(10)
    for (let c = 0; c < 10; c++) expect(course(members, c).length).toBeGreaterThan(0)
    expect(byRole(members, 'bond-beam')).toHaveLength(1)
  })

  test('block count is the hand-tallied 105 (5 even × 10 + 5 odd × 11)', () => {
    expect(course(members, 0)).toHaveLength(10) // 9 full + cut closer
    expect(course(members, 1)).toHaveLength(11) // half starter + 9 full + closer
    expect(blocks).toHaveLength(105)
  })

  test('running bond: odd-course head joints offset half a block', () => {
    const c0 = course(members, 0)
    const c1 = course(members, 1)
    // course 0 starts with a full block centered at 8"
    expect(c0[0]?.position[0]).toBeCloseTo(B / 2, 6)
    // course 1 starts with a HALF block centered at 4"
    expect(c1[0]?.position[0]).toBeCloseTo(B / 4, 6)
    expect(c1[0]?.dims[0]).toBeCloseTo(B / 2 - M, 6)
    // interior full blocks sit exactly half a module over the course below
    expect((c1[1]?.position[0] ?? 0) - (c0[0]?.position[0] ?? 0)).toBeCloseTo(B / 2, 6)
    // and courses two apart stack plumb (bond repeats every 2 courses)
    const c2 = course(members, 2)
    expect(c2[0]?.position[0]).toBeCloseTo(c0[0]?.position[0] ?? -1, 9)
  })

  test('blocks shrink 3/8" in length and height — the visual mortar joint', () => {
    const full = course(members, 0)[1] as Member // an interior full block
    expect(full.dims[0]).toBeCloseTo(B - M, 6) // 15.625" face
    expect(full.dims[1]).toBeCloseTo(H - M, 6) // 7.625" face
    // centered in its course cell: center Y = course line + 4"
    expect(full.position[1]).toBeCloseTo(H / 2, 6)
    // takeoff cut length = the unit's long dimension
    expect(full.length).toBeCloseTo(B - M, 6)
  })

  test('block depth clamps to min(wall thickness, 7-5/8" actual)', () => {
    // 0.2m wall → actual 8" unit depth (7-5/8")
    expect(blocks[0]?.dims[2]).toBeCloseTo(BLOCK_DEPTH_ACTUAL, 6)
    // 0.15m architectural wall → 6"-style unit clamped to the drawn thickness
    const thin = cmuWall(makeWall({ thickness: 0.15 }), DEFAULT_SPEC)
    expect(byRole(thin, 'block')[0]?.dims[2]).toBeCloseTo(0.15, 6)
  })

  test('bond beam caps the wall: top course, full length, grouted label', () => {
    const beam = byRole(members, 'bond-beam')[0] as Member
    expect(beam.label).toBe('bond beam — grouted + rebar')
    expect(beam.dims[0]).toBeCloseTo(4, 6) // continuous — no head joints
    expect(beam.position[0]).toBeCloseTo(2, 6)
    // occupies the 11th course cell: [2.032, 2.2352], center 2.1336
    expect(beam.position[1]).toBeCloseTo(10 * H + H / 2, 6)
    // nothing pokes above the architectural wall height
    expect((beam.position[1] ?? 0) + (beam.dims[1] ?? 0) / 2).toBeLessThanOrEqual(wall.height)
    // no plain block sits above the bond beam bottom
    for (const b of blocks) expect(b.position[1] ?? 0).toBeLessThan(10 * H)
  })

  test('end cells are labeled grouted + rebar (2 per course, 20 total)', () => {
    const grouted = blocks.filter((b) => b.label === 'grouted cell + vertical rebar')
    expect(grouted).toHaveLength(20)
    for (let c = 0; c < 10; c++) {
      const row = course(members, c)
      expect(row[0]?.label).toBe('grouted cell + vertical rebar')
      expect(row[row.length - 1]?.label).toBe('grouted cell + vertical rebar')
      // interior blocks stay unlabeled — takeoff counts grouted cells by label
      expect(row[1]?.label).toBeUndefined()
    }
  })
})

describe('cmuWall — window opening', () => {
  // Window 1.2 × 1.0 at u=2, sill 0.7 → RO u ∈ [1.381, 2.619], y ∈ [0.7, 1.738]
  const opening = window_(2)
  const wall = makeWall({ openings: [opening] })
  const members = cmuWall(wall, DEFAULT_SPEC)
  const blocks = byRole(members, 'block')
  const u0 = 2 - opening.roughWidth / 2
  const u1 = 2 + opening.roughWidth / 2
  const roTop = opening.sillHeight + opening.roughHeight

  test('no block invades the rough opening rectangle', () => {
    for (const b of blocks) {
      const yLo = (b.position[1] ?? 0) - H / 2 // nominal course cell
      const yHi = (b.position[1] ?? 0) + H / 2
      if (yHi <= opening.sillHeight + 1e-9 || yLo >= roTop - 1e-9) continue
      const left = (b.position[0] ?? 0) - b.dims[0] / 2
      const right = (b.position[0] ?? 0) + b.dims[0] / 2
      expect(right <= u0 + 1e-6 || left >= u1 - 1e-6).toBe(true)
    }
  })

  test('jamb blocks are cut tight: face lands half a joint off the RO line', () => {
    // course 4 cell [0.813, 1.016] is fully inside the RO band
    const row = course(members, 4)
    const leftJamb = row.filter((b) => (b.position[0] ?? 0) < u0).pop() as Member
    expect((leftJamb.position[0] ?? 0) + leftJamb.dims[0] / 2).toBeCloseTo(u0 - M / 2, 6)
    const rightJamb = row.find((b) => (b.position[0] ?? 0) > u1) as Member
    expect((rightJamb.position[0] ?? 0) - rightJamb.dims[0] / 2).toBeCloseTo(u1 + M / 2, 6)
  })

  test('fewer blocks than the solid wall, but the field is still laid', () => {
    expect(blocks.length).toBeLessThan(105)
    expect(blocks.length).toBeGreaterThan(70)
  })

  test('precast lintel: 8" tall, RO + 2×8" long, bearing 8" past each jamb', () => {
    const lintels = byRole(members, 'lintel')
    expect(lintels).toHaveLength(1)
    const lintel = lintels[0] as Member
    expect(lintel.material).toBe('concrete')
    expect(lintel.size).toBeUndefined()
    expect(lintel.dims[0]).toBeCloseTo(opening.roughWidth + 2 * LINTEL_BEARING, 6)
    expect(lintel.dims[1]).toBeCloseTo(H - M, 6) // 7-5/8" actual precast height
    expect(lintel.position[0]).toBeCloseTo(2, 6) // centered on the opening
    // sits DIRECTLY above the RO: bottom of its course cell = RO top
    expect(lintel.position[1]).toBeCloseTo(roTop + H / 2, 6)
    // bearing extents: 8" past each side of the rough opening
    expect((lintel.position[0] ?? 0) - lintel.dims[0] / 2).toBeCloseTo(u0 - LINTEL_BEARING, 6)
    expect((lintel.position[0] ?? 0) + lintel.dims[0] / 2).toBeCloseTo(u1 + LINTEL_BEARING, 6)
    expect(lintel.length).toBeCloseTo(lintel.dims[0], 9)
    expect(lintel.label).toContain('lintel')
  })

  test('blocks butt the lintel — none overlap its bearing band', () => {
    const la = u0 - LINTEL_BEARING
    const lb = u1 + LINTEL_BEARING
    for (const b of blocks) {
      const yLo = (b.position[1] ?? 0) - H / 2
      const yHi = (b.position[1] ?? 0) + H / 2
      if (yHi <= roTop + 1e-9 || yLo >= roTop + H - 1e-9) continue
      const left = (b.position[0] ?? 0) - b.dims[0] / 2
      const right = (b.position[0] ?? 0) + b.dims[0] / 2
      expect(right <= la + 1e-6 || left >= lb - 1e-6).toBe(true)
    }
  })

  test('bond beam still runs continuous over the opening', () => {
    expect(byRole(members, 'bond-beam')).toHaveLength(1)
    expect(byRole(members, 'bond-beam')[0]?.dims[0]).toBeCloseTo(4, 6)
  })
})

describe('cmuWall — door opening (head within one course of the top)', () => {
  // Door head at 2.138m in a 2.4m wall: RO top is ABOVE the bond-beam bottom
  // (2.032m), so the tie beam doubles as the lintel — the FL standard detail.
  const wall = makeWall({ openings: [door(2)] })
  const members = cmuWall(wall, DEFAULT_SPEC)

  test('no separate lintel — the bond beam is the structural head', () => {
    expect(byRole(members, 'lintel')).toHaveLength(0)
    expect(byRole(members, 'bond-beam')).toHaveLength(1)
  })

  test('door RO cuts every body course down to the floor', () => {
    const u0 = 2 - (0.9 + PAD) / 2
    const u1 = 2 + (0.9 + PAD) / 2
    for (const b of byRole(members, 'block')) {
      const left = (b.position[0] ?? 0) - b.dims[0] / 2
      const right = (b.position[0] ?? 0) + b.dims[0] / 2
      expect(right <= u0 + 1e-6 || left >= u1 - 1e-6).toBe(true)
    }
  })

  test('a taller wall restores the full-height precast lintel over the door', () => {
    const tall = cmuWall(makeWall({ height: 2.7, openings: [door(2)] }), DEFAULT_SPEC)
    const lintel = byRole(tall, 'lintel')[0] as Member
    expect(lintel.dims[1]).toBeCloseTo(H - M, 6)
    expect(lintel.position[1]).toBeCloseTo(2.1 + PAD + H / 2, 6)
  })
})

describe('cmuWall — placement and rotation follow the wall-framing convention', () => {
  test('yaw maps the +X block axis onto the wall direction', () => {
    const wall = makeWall({ start: [0, 0], end: [0, 3] }) // runs along +Z
    const members = cmuWall(wall, DEFAULT_SPEC)
    const block = members[0] as Member
    expect(block.rotation[1]).toBeCloseTo(-Math.PI / 2, 6)
    // verify with a real rotation: +X rotated by the member euler → wall dir
    const dir = new Vector3(1, 0, 0).applyEuler(new Euler(...block.rotation))
    expect(dir.x).toBeCloseTo(wall.dir[0], 6)
    expect(dir.z).toBeCloseTo(wall.dir[1], 6)
    // level-local placement: first block of course 0 centers 8" up the wall
    const first = course(members, 0)[0] as Member
    expect(first.position[0]).toBeCloseTo(0, 6)
    expect(first.position[2]).toBeCloseTo(B / 2, 6)
    expect(first.position[1]).toBeCloseTo(H / 2, 6)
  })

  test('walls starting off-origin place blocks from their start point', () => {
    const wall = makeWall({ start: [10, 5], end: [14, 5] })
    const first = course(cmuWall(wall, DEFAULT_SPEC), 0)[0] as Member
    expect(first.position[0]).toBeCloseTo(10 + B / 2, 6)
    expect(first.position[2]).toBeCloseTo(5, 6)
  })
})

describe('cmuWall — guards', () => {
  test('wall shorter than one course → empty (nothing to lay)', () => {
    expect(cmuWall(makeWall({ height: 0.15 }), DEFAULT_SPEC)).toHaveLength(0)
  })

  test('wall exactly one course tall → just the bond beam, no plain blocks', () => {
    const members = cmuWall(makeWall({ height: 0.21 }), DEFAULT_SPEC)
    expect(byRole(members, 'block')).toHaveLength(0)
    expect(byRole(members, 'bond-beam')).toHaveLength(1)
  })

  test('an exact 8ft wall does not lose its top course to float rounding', () => {
    // 2.4384 / 0.2032 must count as 12 courses: 11 block + 1 bond beam
    const members = cmuWall(makeWall({ height: 8 * 0.3048 }), DEFAULT_SPEC)
    const yCenters = new Set(
      byRole(members, 'block').map((b) => (b.position[1] ?? 0).toFixed(6)),
    )
    expect(yCenters.size).toBe(11)
    expect(byRole(members, 'bond-beam')[0]?.position[1]).toBeCloseTo(11 * H + H / 2, 6)
  })

  test('curved walls return no members (flagged upstream)', () => {
    expect(cmuWall(makeWall({ curved: true }), DEFAULT_SPEC)).toHaveLength(0)
  })
})
