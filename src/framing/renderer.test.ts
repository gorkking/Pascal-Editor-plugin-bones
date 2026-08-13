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
  test('10,000 members + 500 fixtures across every role/material stay under 24 draw calls', () => {
    const group = buildGroup(synthesizeMembers(10_000), synthesizeFixtures(500), true)
    expect(group.children.length).toBeLessThanOrEqual(24)
    expect(group.children.length).toBeGreaterThan(4) // sanity: buckets exist
    // Instance counts add up to the full population — nothing dropped.
    const instances = group.children.reduce(
      (sum, child) => sum + ((child as { count?: number }).count ?? 0),
      0,
    )
    expect(instances).toBe(10_500)
  })

  test('bucket count saturates — growing the population adds zero draw calls', () => {
    // 5k already hits every (material, role-color) combination the synthetic
    // mix can produce; doubling the members must not add a single mesh.
    const saturated = buildGroup(synthesizeMembers(5_000), [], true).children.length
    const doubled = buildGroup(synthesizeMembers(10_000), [], true).children.length
    expect(doubled).toBe(saturated)
  })
})
