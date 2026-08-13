'use client'

import { useRegistry, useScene } from '@pascal-app/core'
import { useEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import type { Fixture, Member } from '../core/types'
import { inches } from '../core/units'
import { computeLevel } from './compute'
import type { FramingNode } from './schema'

/**
 * The X-ray renderer: derives every member for this node's level and draws
 * them as one InstancedMesh per color bucket — a whole house is a handful of
 * draw calls. Nothing here is persisted; edit a wall and the skeleton
 * recomputes on the spot.
 */

/** Color buckets — material first, with structural roles popped for reading. */
function colorOf(member: Member): string {
  switch (member.material) {
    case 'concrete':
      return '#9aa0a5'
    case 'pt-lumber':
      return '#7d9d6a'
    case 'steel':
      return '#8b8f96'
    case 'engineered':
      return '#c39b5e'
    case 'pvc':
      return '#e9e7df'
    case 'copper':
      return '#b0723d'
    case 'duct':
      return '#aab3bb'
    default:
      break
  }
  switch (member.role) {
    case 'rebar':
      return '#8a4b2a'
    case 'wire-run':
      return '#e6c84a'
    case 'header':
      return '#c1904f'
    case 'king-stud':
    case 'trimmer':
      return '#cfa269'
    default:
      return '#dbb98b'
  }
}

const FIXTURE_COLORS: Record<string, string> = {
  'exhaust-fan': '#9fb8c8',
  receptacle: '#f2b63d',
  'receptacle-gfci': '#e88f2a',
  switch: '#7fb3e0',
  light: '#f5e08a',
  'smoke-alarm': '#e06c6c',
  panel: '#8f8f8f',
}

/** Fixtures render as small instanced boxes (device-box scale). */
function fixtureBox(fixture: Fixture): { dims: [number, number, number]; color: string } {
  const color = FIXTURE_COLORS[fixture.kind] ?? '#f2b63d'
  if (fixture.kind === 'panel') return { dims: [inches(14), inches(30), inches(4)], color }
  if (fixture.kind === 'light') return { dims: [inches(6), inches(1.5), inches(6)], color }
  return { dims: [inches(3), inches(4.5), inches(2.5)], color }
}

type Bucket = { color: string; entries: { dims: readonly [number, number, number]; position: readonly [number, number, number]; rotation: readonly [number, number, number] }[] }

export function buildGroup(members: Member[], fixtures: Fixture[], seeThrough: boolean): Group {
  const buckets = new Map<string, Bucket>()
  const push = (
    color: string,
    dims: readonly [number, number, number],
    position: readonly [number, number, number],
    rotation: readonly [number, number, number],
  ) => {
    let bucket = buckets.get(color)
    if (!bucket) {
      bucket = { color, entries: [] }
      buckets.set(color, bucket)
    }
    bucket.entries.push({ dims, position, rotation })
  }

  for (const member of members) {
    push(colorOf(member), member.dims, member.position, member.rotation)
  }
  for (const fixture of fixtures) {
    const { dims, color } = fixtureBox(fixture)
    push(color, dims, fixture.position, [0, fixture.rotationY, 0])
  }

  const group = new Group()
  const unitBox = new BoxGeometry(1, 1, 1)
  const matrix = new Matrix4()
  const quaternion = new Quaternion()
  const scale = new Vector3()
  const translation = new Vector3()
  const euler = new Euler()

  // X-ray = depth-buffer overlay: every member mesh draws AFTER the host
  // scene (renderOrder 999) with normal depth testing, and a zero-pixel
  // sentinel drawn just before them (renderOrder 998) clears the depth
  // buffer. Members therefore depth-test only against EACH OTHER — the top
  // plate hides the stud tops behind it, the footing never paints over a
  // nearer stud — while the host's walls/floors can no longer occlude the
  // skeleton. Exactly the editor's natural camera behavior, applied to the
  // members, with the X-ray effect confined to host geometry.
  if (seeThrough) {
    const sentinel = new Mesh(
      new BoxGeometry(0.0001, 0.0001, 0.0001),
      new MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }),
    )
    sentinel.frustumCulled = false
    sentinel.renderOrder = 998
    sentinel.onBeforeRender = (renderer) => renderer.clearDepth()
    group.add(sentinel)
  }

  for (const bucket of buckets.values()) {
    // Normal depth-tested draw, so members occlude each other correctly —
    // the round-2 user-reported artifacts (footing over nearer studs, far
    // stud tops reading through the top plate) came from bypassing the
    // depth test; the sentinel above handles seeing through the HOST only.
    const material = new MeshStandardMaterial({ color: bucket.color, roughness: 0.82 })
    const mesh = new InstancedMesh(unitBox, material, bucket.entries.length)
    if (seeThrough) mesh.renderOrder = 999
    bucket.entries.forEach((entry, i) => {
      euler.set(entry.rotation[0], entry.rotation[1], entry.rotation[2])
      quaternion.setFromEuler(euler)
      translation.set(entry.position[0], entry.position[1], entry.position[2])
      scale.set(
        Math.max(entry.dims[0], 0.001),
        Math.max(entry.dims[1], 0.001),
        Math.max(entry.dims[2], 0.001),
      )
      matrix.compose(translation, quaternion, scale)
      mesh.setMatrixAt(i, matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.frustumCulled = false
    group.add(mesh)
  }
  return group
}

function disposeGroup(group: Group) {
  // Geometries are shared (one unit box) except the X-ray sentinel's own —
  // dispose each UNIQUE geometry exactly once.
  const geometries = new Set<BoxGeometry>()
  for (const child of group.children) {
    const mesh = child as InstancedMesh
    mesh.dispose?.()
    ;(mesh.material as MeshStandardMaterial | undefined)?.dispose?.()
    if (mesh.geometry) geometries.add(mesh.geometry as BoxGeometry)
  }
  for (const geometry of geometries) geometry.dispose()
}

export const FramingRenderer = ({ node }: { node: FramingNode }) => {
  const ref = useRef<Group>(null!)
  useRegistry(node.id, node.type, ref)

  // Any scene edit re-derives the skeleton — that's the contract (never stale).
  const nodes = useScene((s) => s.nodes)
  const result = useMemo(
    () => computeLevel(nodes as Record<string, Record<string, unknown>>, node),
    [nodes, node],
  )

  const group = useMemo(
    () => buildGroup(result.members, result.fixtures, node.seeThrough !== false),
    [result, node.seeThrough],
  )
  useEffect(() => () => disposeGroup(group), [group])

  if (!node.visible) return null
  return (
    <group ref={ref}>
      <primitive object={group} />
    </group>
  )
}

export default FramingRenderer
