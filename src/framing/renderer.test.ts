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
  test('10,000 members + 500 fixtures across every role/material stay under 25 draw calls', () => {
    // One InstancedMesh per color bucket + the X-ray depth-clear sentinel.
    const group = buildGroup(synthesizeMembers(10_000), synthesizeFixtures(500), true)
    expect(group.children.length).toBeLessThanOrEqual(25)
    expect(group.children.length).toBeGreaterThan(4) // sanity: buckets exist
    // Instance counts add up to the full population — nothing dropped.
    // (The sentinel is a plain Mesh, not an instanced batch — excluded.)
    const instances = group.children.reduce(
      (sum, child) =>
        sum +
        ((child as { isInstancedMesh?: boolean; count?: number }).isInstancedMesh
          ? ((child as { count?: number }).count ?? 0)
          : 0),
      0,
    )
    expect(instances).toBe(10_500)
    // Without X-ray the sentinel disappears — nothing else changes.
    const solidOnly = buildGroup(synthesizeMembers(10_000), synthesizeFixtures(500), false)
    expect(solidOnly.children.length).toBe(group.children.length - 1)
  })

  test('bucket count saturates — growing the population adds zero draw calls', () => {
    // 5k already hits every (material, role-color) combination the synthetic
    // mix can produce; doubling the members must not add a single mesh.
    const saturated = buildGroup(synthesizeMembers(5_000), [], true).children.length
    const doubled = buildGroup(synthesizeMembers(10_000), [], true).children.length
    expect(doubled).toBe(saturated)
  })

  test('members ALWAYS depth-test — X-ray clears host depth via a sentinel instead', () => {
    // Round-2 user reports: with depth tricks on the members themselves, a
    // footing painted over nearer studs, then far stud tops read through the
    // top plate. Members must occlude each other naturally in BOTH modes;
    // the X-ray effect lives in one depth-clearing sentinel drawn before
    // them (renderOrder 998 vs 999), which only defeats HOST occlusion.
    type MeshLike = {
      isInstancedMesh?: boolean
      material: { depthTest: boolean; depthWrite: boolean; transparent: boolean; colorWrite: boolean }
      renderOrder: number
      onBeforeRender?: unknown
    }
    const xray = buildGroup(synthesizeMembers(100), [], true)
    const meshes = xray.children as unknown as MeshLike[]
    const memberMeshes = meshes.filter((m) => m.isInstancedMesh)
    const sentinels = meshes.filter((m) => !m.isInstancedMesh)
    expect(memberMeshes.length).toBeGreaterThan(0)
    for (const m of memberMeshes) {
      expect(m.material.depthTest).toBe(true) // natural near-hides-far
      expect(m.material.transparent).toBe(false)
      expect(m.renderOrder).toBe(999) // drawn after the host scene
    }
    expect(sentinels).toHaveLength(1)
    const sentinel = sentinels[0] as MeshLike
    expect(sentinel.renderOrder).toBe(998) // clears depth BEFORE the members
    expect(sentinel.material.colorWrite).toBe(false) // draws no pixels
    expect(typeof sentinel.onBeforeRender).toBe('function')
    // X-ray off: no sentinel, members depth-test in the normal pass order
    const off = buildGroup(synthesizeMembers(100), [], false)
    for (const m of off.children as unknown as MeshLike[]) {
      expect(m.isInstancedMesh).toBe(true)
      expect(m.material.depthTest).toBe(true)
      expect(m.renderOrder).toBe(0)
    }
  })
})
