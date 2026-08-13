import { describe, expect, test } from 'bun:test'
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
  test('10,000 members + 500 fixtures across every role/material stay under 48 draw calls', () => {
    // X-ray renders TWO passes per bucket (solid + ghost) — still O(buckets).
    const group = buildGroup(synthesizeMembers(10_000), synthesizeFixtures(500), true)
    expect(group.children.length).toBeLessThanOrEqual(48)
    expect(group.children.length).toBeGreaterThan(4) // sanity: buckets exist
    // Each pass carries the full population — nothing dropped.
    const instances = group.children.reduce(
      (sum, child) => sum + ((child as { count?: number }).count ?? 0),
      0,
    )
    expect(instances).toBe(2 * 10_500)
    // Without X-ray there is a single pass with half the meshes.
    const solidOnly = buildGroup(synthesizeMembers(10_000), synthesizeFixtures(500), false)
    expect(solidOnly.children.length).toBe(group.children.length / 2)
  })

  test('bucket count saturates — growing the population adds zero draw calls', () => {
    // 5k already hits every (material, role-color) combination the synthetic
    // mix can produce; doubling the members must not add a single mesh.
    const saturated = buildGroup(synthesizeMembers(5_000), [], true).children.length
    const doubled = buildGroup(synthesizeMembers(10_000), [], true).children.length
    expect(doubled).toBe(saturated)
  })

  test('X-ray keeps a depth-tested solid pass — occlusion order stays correct', () => {
    // Round-2 user-reported bug: a single depthTest:false pass let the
    // foundation paint over nearer studs. The solid pass must depth-test;
    // only the faint ghost pass may ignore depth (and never write it).
    const group = buildGroup(synthesizeMembers(100), [], true)
    type MeshLike = { material: { depthTest: boolean; depthWrite: boolean; opacity: number; transparent: boolean }; renderOrder: number }
    const meshes = group.children as unknown as MeshLike[]
    const solids = meshes.filter((m) => m.material.depthTest)
    const ghosts = meshes.filter((m) => !m.material.depthTest)
    expect(solids.length).toBe(ghosts.length)
    expect(solids.length).toBeGreaterThan(0)
    for (const s of solids) {
      expect(s.material.transparent).toBe(false)
      expect(s.renderOrder).toBe(0)
    }
    for (const g of ghosts) {
      expect(g.material.depthWrite).toBe(false)
      expect(g.material.opacity).toBeLessThan(0.5)
      expect(g.renderOrder).toBe(999)
    }
    // no ghosts at all when X-ray is off
    const off = buildGroup(synthesizeMembers(100), [], false)
    for (const m of off.children as unknown as MeshLike[]) {
      expect(m.material.depthTest).toBe(true)
    }
  })
})
