import { describe, expect, test } from 'bun:test'
import { Mesh } from 'three'
import type { Fixture, Member, MemberMaterial, MemberRole } from '../core/types'
import { buildGroup } from './renderer'

/**
 * The rubric's rendering gate: draw calls stay O(color buckets), never
 * O(member count). One InstancedMesh per color — a 10,000-member house must
 * render in a bounded handful of meshes.
 */

const ROLES: MemberRole[] = [
  'bottom-plate', 'top-plate', 'cap-plate', 'stud', 'king-stud', 'trimmer', 'header',
  'sill', 'cripple', 'blocking', 'joist', 'rim-joist', 'girder', 'post', 'rafter',
  'ridge', 'hip', 'valley', 'ceiling-joist', 'collar-tie', 'mudsill', 'stemwall',
  'footing', 'slab-edge', 'anchor-bolt', 'hold-down', 'block', 'lintel', 'bond-beam',
  'pipe-run', 'vent-stack', 'duct-run', 'wire-run', 'rebar', 'hanger', 'plate-washer',
  'jack-rafter', 'outlooker', 'fascia', 'fire-blocking', 'backing',
]
const MATERIALS: MemberMaterial[] = [
  'lumber', 'pt-lumber', 'engineered', 'concrete', 'steel', 'pvc', 'copper', 'duct',
]

function synthesizeMembers(count: number): Member[] {
  const members: Member[] = []
  for (let i = 0; i < count; i++) {
    members.push({
      system: 'wall-framing',
      role: ROLES[i % ROLES.length] as MemberRole,
      dims: [0.04, 2, 0.09],
      length: 2,
      position: [i * 0.1, 1, 0],
      rotation: [0, (i % 8) * (Math.PI / 4), 0],
      material: MATERIALS[i % MATERIALS.length] as MemberMaterial,
      sourceId: `w${i % 20}`,
    })
  }
  return members
}

const FIXTURE_KINDS: Fixture['kind'][] = [
  'receptacle', 'receptacle-gfci', 'switch', 'light', 'smoke-alarm', 'panel',
  'stub-out', 'vent-stack', 'register', 'return', 'equipment', 'water-heater',
  'cleanout', 'thermostat', 'exhaust-fan',
]

function synthesizeFixtures(count: number): Fixture[] {
  return Array.from({ length: count }, (_, i) => ({
    system: 'electrical' as const,
    kind: FIXTURE_KINDS[i % FIXTURE_KINDS.length] as Fixture['kind'],
    position: [i * 0.2, 0.4, 0] as const,
    rotationY: 0,
    sourceId: `w${i % 20}`,
  }))
}

describe('instanced rendering gate (rubric: UI/UX/Performance)', () => {
  test('10,000 members + 500 fixtures across every role/material stay under 50 draw calls', () => {
    // X-ray: TWO InstancedMeshes per color bucket (solid scene copy + ghost
    // overlay copy) — still O(buckets), never O(members).
    const group = buildGroup(synthesizeMembers(10_000), synthesizeFixtures(500), true)
    expect(group.children.length).toBeLessThanOrEqual(50)
    expect(group.children.length).toBeGreaterThan(8) // sanity: buckets exist
    // Round 13: ghosts exist ONLY for below-grade systems (foundation,
    // floor framing) — the dollhouse cut reveals everything else through
    // the opened near faces. The synthetic mix is wall-framing, so every
    // instance is a single solid copy.
    const instances = group.children.reduce(
      (sum, child) =>
        sum +
        ((child as { isInstancedMesh?: boolean; count?: number }).isInstancedMesh
          ? ((child as { count?: number }).count ?? 0)
          : 0),
      0,
    )
    expect(instances).toBe(10_500)
    // Solid mode: identical census for an above-grade population.
    const solidOnly = buildGroup(synthesizeMembers(10_000), synthesizeFixtures(500), false)
    expect(solidOnly.children.length).toBe(group.children.length)
  })

  test('bucket count saturates — growing the population adds zero draw calls', () => {
    // 5k already hits every (material, role-color) combination the synthetic
    // mix can produce; doubling the members must not add a single mesh.
    const saturated = buildGroup(synthesizeMembers(5_000), [], true).children.length
    const doubled = buildGroup(synthesizeMembers(10_000), [], true).children.length
    expect(doubled).toBe(saturated)
  })

  test('X-ray = solid scene copy + ghost overlay copy — always depth-tested, no render hacks', () => {
    // Round-2 user reports: with depth tricks on the members themselves, a
    // footing painted over nearer studs, then far stud tops read through the
    // top plate. Members must occlude each other naturally in BOTH modes.
    //
    // Round-11 regression: overlay-ONLY members painted over a tree standing
    // in front of the house (the overlay pass composites over the finished
    // scene with no scene-depth test). The X-ray is therefore two copies:
    //  - SOLID on the scene layer (0): occluded by trees like real geometry;
    //  - GHOST on the host overlay layer (1) at partial opacity: shows
    //    through walls, blends invisibly where the solid copy already shows.
    // Everything else was tried against the WebGPU pipeline and failed —
    // clearDepth() poisoned the pass, an inverted depth-wipe box never
    // landed its depthWrite, transparent-list membership lost to the MRT
    // scene pass. No sentinel meshes: layers + opacity only.
    type MeshLike = {
      isInstancedMesh?: boolean
      castShadow: boolean
      layers: { mask: number }
      material: {
        depthTest: boolean
        depthWrite: boolean
        transparent: boolean
        opacity: number
        colorWrite: boolean
      }
      renderOrder: number
      onBeforeRender?: { toString(): string }
    }
    const OVERLAY_MASK = 1 << 1 // host OVERLAY_LAYER = 1
    const SCENE_MASK = 1 << 0 // default layer 0
    // Below-grade members ghost; above-grade members are dollhouse-solid.
    const belowGrade = synthesizeMembers(100).map((m) => ({
      ...m,
      system: 'foundation' as const,
    }))
    const xray = buildGroup(belowGrade, [], true)
    const meshes = xray.children as unknown as MeshLike[]
    const solids = meshes.filter((m) => m.layers.mask === SCENE_MASK)
    const ghosts = meshes.filter((m) => m.layers.mask === OVERLAY_MASK)
    expect(solids.length).toBeGreaterThan(0)
    expect(ghosts.length).toBe(solids.length) // one ghost per below-grade bucket
    // Above-grade (wall framing) buckets never ghost — the near faces OPEN.
    const aboveGrade = buildGroup(synthesizeMembers(100), [], true)
    const aboveGhosts = (aboveGrade.children as unknown as MeshLike[]).filter(
      (m) => m.layers.mask === OVERLAY_MASK,
    )
    expect(aboveGhosts).toHaveLength(0)
    // Assembly layers carry their face normal for the dollhouse cut.
    const layered = buildGroup(
      [
        {
          ...synthesizeMembers(1)[0]!,
          role: 'drywall' as const,
          face: [0, 1] as const,
        },
      ],
      [],
      true,
    )
    const faceMesh = layered.children[0] as unknown as { userData: { face?: readonly [number, number] } }
    expect(faceMesh.userData.face).toEqual([0, 1])
    for (const m of meshes) {
      expect(m.isInstancedMesh).toBe(true) // members only — no sentinels
      expect(m.material.depthTest).toBe(true) // natural near-hides-far
      expect(m.material.depthWrite).toBe(true) // member-vs-member occlusion
      expect(m.material.colorWrite).toBe(true)
      expect(m.renderOrder).toBe(0) // gizmos/handles keep drawing above
      // no custom render hooks — WebGPU-safe
      expect(m.onBeforeRender?.toString()).toBe(new Mesh().onBeforeRender.toString())
    }
    for (const m of solids) {
      expect(m.material.transparent).toBe(false) // plain opaque draw
      expect(m.castShadow).toBe(true)
    }
    for (const m of ghosts) {
      expect(m.material.transparent).toBe(true) // partial-opacity ghost
      expect(m.material.opacity).toBeGreaterThan(0.2)
      expect(m.material.opacity).toBeLessThan(0.8)
      expect(m.castShadow).toBe(false) // one shadow per member, not two
    }
    // X-ray off: members are ordinary scene-layer geometry, no ghosts —
    // and assembly layers DON'T render at all (they z-fight the host's
    // visible wall skin; the host grey is the drywall look in solid mode).
    const off = buildGroup(synthesizeMembers(100), [], false)
    for (const m of off.children as unknown as MeshLike[]) {
      expect(m.isInstancedMesh).toBe(true)
      expect(m.layers.mask).toBe(SCENE_MASK)
      expect(m.material.depthTest).toBe(true)
      expect(m.material.transparent).toBe(false)
      expect(m.renderOrder).toBe(0)
    }
    const offLayers = buildGroup(
      [
        {
          ...synthesizeMembers(1)[0]!,
          role: 'drywall' as const,
          face: [0, 1] as const,
        },
      ],
      [],
      false,
    )
    expect(offLayers.children).toHaveLength(0)
  })
})

describe('buildGroups — cross-level members split into foreign level groups', () => {
  test('tagged members land in a per-level group, untagged in the main group', () => {
    const { buildGroups } = require('./renderer') as typeof import('./renderer')
    const stud = {
      system: 'wall-framing' as const,
      role: 'stud' as const,
      dims: [0.04, 2.4, 0.09] as const,
      length: 2.4,
      position: [1, 1.2, 0] as const,
      rotation: [0, 0, 0] as const,
      material: 'lumber' as const,
      sourceId: 'w1',
    }
    const rafter = { ...stud, system: 'roof-framing' as const, role: 'rafter' as const, levelId: 'lvlroof' }
    const { group, foreign } = buildGroups([stud, rafter], [], true)
    expect(foreign.size).toBe(1)
    expect(foreign.get('lvlroof')?.name).toBe('bones-foreign-lvlroof')
    // main group holds only the stud's instanced mesh, foreign only the rafter's
    expect(group.children.length).toBeGreaterThan(0)
    expect((foreign.get('lvlroof')?.children.length ?? 0)).toBeGreaterThan(0)
  })
})

describe('exploded roof stratum (day board A, 2026-08-16)', () => {
  test('explodedRoofOffset: half an exploded slot (EXPLODED_GAP 5 → 2.5) below in exploded mode, flush otherwise', () => {
    const { explodedRoofOffset } = require('./renderer') as typeof import('./renderer')
    expect(explodedRoofOffset('exploded')).toBe(-2.5)
    expect(explodedRoofOffset('stacked')).toBe(0)
    expect(explodedRoofOffset('solo')).toBe(0)
    // viewer store not resolved yet (dynamic import pending) = stacked
    expect(explodedRoofOffset(undefined)).toBe(0)
  })

  test('buildGroups foreign groups start flush at y 0 — the offset is frame-loop applied', () => {
    const { buildGroups } = require('./renderer') as typeof import('./renderer')
    const rafter = {
      system: 'roof-framing' as const,
      role: 'rafter' as const,
      dims: [0.04, 0.2, 3] as const,
      length: 3,
      position: [1, 1.2, 0] as const,
      rotation: [0.5, 0, 0] as const,
      material: 'lumber' as const,
      sourceId: 'roofseg',
      levelId: 'lvlroof',
    }
    const { foreign } = buildGroups([rafter], [], true)
    expect(foreign.get('lvlroof')?.position.y).toBe(0)
  })
})

describe('under-slab plumbing ghosts through the floor (user ask 2026-08-16)', () => {
  test('buried DWV buckets are ghosted; above-floor supply stays solid', () => {
    const { buildGroup } = require('./renderer') as typeof import('./renderer')
    const buried = {
      system: 'plumbing' as const,
      role: 'pipe-run' as const,
      dims: [2, 0.08, 0.08] as const,
      length: 2,
      position: [1, -0.25, 0] as const,
      rotation: [0, 0, 0] as const,
      material: 'pvc' as const,
      sourceId: 'dwv-main',
    }
    const supply = { ...buried, position: [1, 0.28, 0] as const, sourceId: 'cold-x' }
    const group = buildGroup([buried, supply], [], true)
    // ghosted buckets emit TWO meshes (solid + overlay ghost); solid-only one
    const meshCounts = group.children.length
    expect(meshCounts).toBeGreaterThanOrEqual(3)
  })
})
