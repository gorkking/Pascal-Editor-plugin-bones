import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial } from 'three'
import type { Member } from '../core/types'
import baseline from './master-baseline.json'
import {
  __setCondenserAssetLoaderForTests,
  AC_BLOCK_ASSET_ID,
  AC_BLOCK_GLB_URL,
  condenserAssetSnapshot,
  isCondenserCabinet,
  loadCondenserAsset,
  normalizeToUnitBox,
  prepareCondenserClone,
} from './condenser-asset'
import {
  buildGroup,
  buildGroups,
  composeEntryMatrix,
  materialCensus,
  patchGroup,
  patchGroups,
} from './renderer'

/**
 * AC-BLOCK VISUAL SWAP gates (user ask 2026-08-22: the condenser "is
 * actually a heatpump" — render the host's 'AC block' asset, keep the
 * label):
 *  - census: the cabinet leaves the box buckets exactly when a loaded
 *    asset is supplied, and stays a box (bit-for-bit the same matrices)
 *    when it isn't — headless fallback is the DEFAULT path;
 *  - matrix parity: the asset wrapper carries the EXACT instance matrix
 *    its box would (same compose, same clamp);
 *  - loader: resolve caches, reject resolves null and allows a retry —
 *    never a rejection into the renderer;
 *  - conventions: no new raycast targets, shared (never re-minted)
 *    geometry/materials, material cache untouched, patch path intact;
 *  - the MEMBER (and its 'AC condenser #N …' label) is never touched —
 *    the baseline pin plus the pure-function census below cover it.
 */

/** The real cabinet member, verbatim from the pinned master baseline. */
const CABINET: Member = {
  system: 'hvac',
  role: 'equipment',
  dims: [0.9, 0.8, 0.35],
  length: 0.9,
  position: [3.99405, 0.5016, -0.6],
  rotation: [0, 2.7764139035632196, 0],
  material: 'steel',
  sourceId: 'room-utility',
  label: 'AC condenser #1 — 2 tons outdoor unit',
}

/** Its concrete pad — same role, must NEVER swap. */
const PAD: Member = {
  system: 'hvac',
  role: 'equipment',
  dims: [0.95, 0.1016, 0.95],
  length: 0.95,
  position: [3.99405, 0.0508, -0.68],
  rotation: [0, Math.PI, 0],
  material: 'concrete',
  sourceId: 'room-utility',
  label: 'Condenser pad 4" — concrete (per mfr clearance + IRC M1403)',
}

const STUD: Member = {
  system: 'wall-framing',
  role: 'stud',
  dims: [0.04, 2.4, 0.09],
  length: 2.4,
  position: [1, 1.2, 0],
  rotation: [0, 0, 0],
  material: 'lumber',
  sourceId: 'w1',
}

/** A stand-in for the loaded GLB scene: native-ish bbox (≈ the catalog's
 * 1.06 × 0.95 × 1.06), deliberately OFF-center so normalization is proven,
 * one geometry + one material to assert sharing across clones. */
function fakeAssetScene(): { scene: Group; mesh: Mesh } {
  const mesh = new Mesh(
    new BoxGeometry(1.06, 0.95, 1.06),
    new MeshStandardMaterial({ color: '#dddddd' }),
  )
  mesh.position.set(0.53, 0.475, 0.53) // bbox NOT centered at the origin
  const scene = new Group()
  scene.add(mesh)
  return { scene, mesh }
}

function loadedAsset(): { asset: Group; mesh: Mesh } {
  const { scene, mesh } = fakeAssetScene()
  return { asset: normalizeToUnitBox(scene), mesh }
}

function instancedMeshes(group: Group): InstancedMesh[] {
  return group.children.filter((c): c is InstancedMesh => c instanceof InstancedMesh)
}

/** Wrapper groups = non-InstancedMesh children holding the asset clones. */
function assetWrappers(group: Group): Group[] {
  return group.children.filter((c): c is Group => c instanceof Group)
}

function totalInstances(group: Group): number {
  return instancedMeshes(group).reduce((n, m) => n + m.count, 0)
}

/** Instance matrices live in a Float32Array — an exact compare against the
 * f64 compose must go through fround (same numbers, storage precision). */
function fround16(elements: ArrayLike<number>): number[] {
  return Array.from(elements, (v) => Math.fround(v))
}

afterEach(() => {
  __setCondenserAssetLoaderForTests(null)
})

describe('cabinet identification (structural, no engine change)', () => {
  test('the pinned baseline: exactly the AC-condenser members match, nothing else', () => {
    // JSON widens tuples/unions to number[]/string — the shape is the
    // capture script's serialization of computeLevel's Member[] verbatim.
    const entries = Object.values(baseline as unknown as Record<string, { members: Member[] }>)
    for (const entry of entries) {
      const hits = entry.members.filter((m) => isCondenserCabinet(m))
      expect(hits.length).toBeGreaterThan(0)
      for (const hit of hits) {
        expect(hit.label ?? '').toStartWith('AC condenser #')
      }
      // The pad (and every other member) stays out.
      for (const m of entry.members) {
        if (!isCondenserCabinet(m)) {
          expect((m.label ?? '').startsWith('AC condenser #')).toBe(false)
        }
      }
    }
  })

  test('pad and framing never match', () => {
    expect(isCondenserCabinet(CABINET)).toBe(true)
    expect(isCondenserCabinet(PAD)).toBe(false)
    expect(isCondenserCabinet(STUD)).toBe(false)
  })
})

describe('normalizeToUnitBox', () => {
  test('the normalized asset bounds to a unit cube centered at the origin', () => {
    const { asset } = loadedAsset()
    const box = new Box3().setFromObject(asset)
    const eps = 1e-6
    expect(Math.abs(box.min.x + 0.5)).toBeLessThan(eps)
    expect(Math.abs(box.max.x - 0.5)).toBeLessThan(eps)
    expect(Math.abs(box.min.y + 0.5)).toBeLessThan(eps)
    expect(Math.abs(box.max.y - 0.5)).toBeLessThan(eps)
    expect(Math.abs(box.min.z + 0.5)).toBeLessThan(eps)
    expect(Math.abs(box.max.z - 0.5)).toBeLessThan(eps)
  })
})

describe('renderer census — substitution and fallback (the both-ways gate)', () => {
  test('X-ray WITHOUT an asset: the box path, exactly as today', () => {
    const group = buildGroup([CABINET, PAD, STUD], [], 'xray')
    expect(assetWrappers(group)).toHaveLength(0)
    // steel + concrete + lumber buckets, one instance each
    expect(totalInstances(group)).toBe(3)
    // the cabinet's box carries the composed member matrix
    const steel = instancedMeshes(group).find(
      (m) => (m.material as MeshStandardMaterial).color.getHexString() === '8b8f96',
    )
    expect(steel).toBeDefined()
    const got = new Matrix4()
    steel?.getMatrixAt(0, got)
    const want = composeEntryMatrix(CABINET.dims, CABINET.position, CABINET.rotation, new Matrix4())
    expect(fround16(got.elements)).toEqual(fround16(want.elements))
  })

  test('X-ray WITH the asset: the cabinet leaves the buckets and mounts as one wrapper', () => {
    const { asset, mesh } = loadedAsset()
    const group = buildGroup([CABINET, PAD, STUD], [], 'xray', asset)
    // pad + stud stay boxes; the cabinet box is GONE
    expect(totalInstances(group)).toBe(2)
    const steel = instancedMeshes(group).find(
      (m) => (m.material as MeshStandardMaterial).color.getHexString() === '8b8f96',
    )
    expect(steel).toBeUndefined()
    // exactly one wrapper, holding a CLONE that shares geometry + material
    const wrappers = assetWrappers(group)
    expect(wrappers).toHaveLength(1)
    let shared = 0
    wrappers[0]?.traverse((obj) => {
      if (obj instanceof Mesh && obj.geometry === mesh.geometry && obj.material === mesh.material) {
        shared++
      }
    })
    expect(shared).toBe(1)
  })

  test('matrix parity: the wrapper sits at the EXACT matrix the box had', () => {
    const { asset } = loadedAsset()
    const boxed = buildGroup([CABINET], [], 'xray')
    const swapped = buildGroup([CABINET], [], 'xray', asset)
    const boxMatrix = new Matrix4()
    instancedMeshes(boxed)[0]?.getMatrixAt(0, boxMatrix)
    const wrapper = assetWrappers(swapped)[0]
    expect(wrapper).toBeDefined()
    expect(wrapper?.matrixAutoUpdate).toBe(false)
    // both sides derive from composeEntryMatrix; the box side round-trips
    // through the f32 instance buffer, the wrapper keeps the exact f64
    expect(fround16(wrapper?.matrix.elements ?? [])).toEqual(fround16(boxMatrix.elements))
    const exact = composeEntryMatrix(CABINET.dims, CABINET.position, CABINET.rotation, new Matrix4())
    expect(wrapper?.matrix.elements).toEqual(exact.elements)
  })

  test("the swap is X-ray only: 'basement' keeps the faint box, 'off' draws no members", () => {
    const { asset } = loadedAsset()
    const basement = buildGroup([CABINET, PAD], [], 'basement', asset)
    expect(assetWrappers(basement)).toHaveLength(0)
    // above-grade equipment = faint shell boxes, exactly as without the asset
    expect(totalInstances(basement)).toBe(totalInstances(buildGroup([CABINET, PAD], [], 'basement')))
    const off = buildGroup([CABINET, PAD], [], 'off', asset)
    expect(assetWrappers(off)).toHaveLength(0)
    expect(totalInstances(off)).toBe(0)
  })

  test('multiple cabinets → one wrapper each, in member order', () => {
    const { asset } = loadedAsset()
    const second: Member = { ...CABINET, position: [5.5, 0.5016, -0.6], label: 'AC condenser #2' }
    const group = buildGroup([CABINET, PAD, second], [], 'xray', asset)
    const wrappers = assetWrappers(group)
    expect(wrappers).toHaveLength(2)
    const w0 = composeEntryMatrix(CABINET.dims, CABINET.position, CABINET.rotation, new Matrix4())
    expect(wrappers[0]?.matrix.elements).toEqual(w0.elements)
    const w1 = composeEntryMatrix(second.dims, second.position, second.rotation, new Matrix4())
    expect(wrappers[1]?.matrix.elements).toEqual(w1.elements)
  })

  test('no new raycast targets: every mesh in the wrapper subtree no-ops, shadows match solid buckets', () => {
    const { asset } = loadedAsset()
    const group = buildGroup([CABINET], [], 'xray', asset)
    let meshCount = 0
    group.traverse((obj) => {
      if (!(obj instanceof Mesh)) return
      meshCount++
      const intersects: unknown[] = []
      ;(obj.raycast as (r: unknown, i: unknown[]) => void)({}, intersects)
      expect(intersects).toHaveLength(0)
      expect(obj.castShadow).toBe(true)
      expect(obj.receiveShadow).toBe(true)
    })
    expect(meshCount).toBeGreaterThan(0) // non-vacuous: the clone's mesh is there
    // …and the SOURCE asset keeps its own (clone must not mutate it)
    let sourceMeshes = 0
    asset.traverse((obj) => {
      if (obj instanceof Mesh) sourceMeshes++
    })
    expect(sourceMeshes).toBe(1)
  })

  test('material cache untouched: GLB materials never enter the bucket cache, rebuilds share objects', () => {
    const { asset, mesh } = loadedAsset()
    const before = materialCensus()
    const a = buildGroup([CABINET, PAD, STUD], [], 'xray', asset)
    const b = buildGroup([CABINET, PAD, STUD], [], 'xray', asset)
    expect(materialCensus()).toBe(before)
    // both builds' clones share the SAME material instance (no re-mint)
    for (const g of [a, b]) {
      g.traverse((obj) => {
        if (obj instanceof Mesh && !(obj instanceof InstancedMesh)) {
          expect(obj.material).toBe(mesh.material)
        }
      })
    }
  })
})

describe('patch path (F2) with the asset', () => {
  test('a moved cabinet patches in place — wrapper matrix rewritten, no rebuild', () => {
    const { asset } = loadedAsset()
    const built = buildGroups([CABINET, PAD, STUD], [], 'xray', asset)
    const moved: Member = { ...CABINET, position: [4.5, 0.5016, -0.9] }
    expect(patchGroups(built, [moved, PAD, STUD], [], 'xray', asset)).toBe(true)
    const wrapper = assetWrappers(built.group)[0]
    const want = composeEntryMatrix(moved.dims, moved.position, moved.rotation, new Matrix4())
    expect(wrapper?.matrix.elements).toEqual(want.elements)
    expect(wrapper?.matrixWorldNeedsUpdate).toBe(true)
  })

  test('asset arriving (or leaving) is a STRUCTURAL change — patch refuses, rebuild takes over', () => {
    const { asset } = loadedAsset()
    const boxedBuilt = buildGroups([CABINET, PAD], [], 'xray')
    // asset just resolved → the cabinet must leave the buckets → rebuild
    expect(patchGroups(boxedBuilt, [CABINET, PAD], [], 'xray', asset)).toBe(false)
    const swappedBuilt = buildGroups([CABINET, PAD], [], 'xray', asset)
    // …and the reverse (defensive: the snapshot never un-resolves in prod)
    expect(patchGroups(swappedBuilt, [CABINET, PAD], [], 'xray')).toBe(false)
    // cabinet count change under the asset path → rebuild
    const second: Member = { ...CABINET, position: [5.5, 0.5016, -0.6] }
    expect(patchGroups(swappedBuilt, [CABINET, PAD, second], [], 'xray', asset)).toBe(false)
  })

  test('box-only scenes keep the exact old patch behavior (asset param absent)', () => {
    const built = buildGroups([STUD, PAD], [], 'xray')
    const slid: Member = { ...STUD, position: [1.4, 1.2, 0] }
    expect(patchGroups(built, [slid, PAD], [], 'xray')).toBe(true)
    expect(patchGroup(built.group, [slid], [], 'xray')).toBe(false) // bucket census shrank
  })
})

describe('the loader — never a rejection into the renderer', () => {
  test('resolve: normalized asset cached, snapshot serves the render path', async () => {
    expect(condenserAssetSnapshot()).toBeNull()
    __setCondenserAssetLoaderForTests(async () => fakeAssetScene().scene)
    const first = await loadCondenserAsset()
    expect(first).not.toBeNull()
    expect(condenserAssetSnapshot()).toBe(first)
    // cached: a second call returns the SAME object without reloading
    expect(await loadCondenserAsset()).toBe(first)
    // normalized: unit bbox
    if (first) {
      const box = new Box3().setFromObject(first)
      expect(Math.abs(box.max.x - box.min.x - 1)).toBeLessThan(1e-6)
    }
  })

  test('reject: resolves null (box fallback), then the NEXT call retries and heals', async () => {
    // One seam installation — the retry must come from loadCondenserAsset
    // clearing its own in-flight slot on failure, not from the test seam's
    // cache reset (mutation probe P7: a permanently cached failure passed a
    // two-installation version of this test).
    let calls = 0
    __setCondenserAssetLoaderForTests(async () => {
      calls++
      if (calls === 1) throw new Error('404 — asset moved')
      return fakeAssetScene().scene
    })
    expect(await loadCondenserAsset()).toBeNull()
    expect(condenserAssetSnapshot()).toBeNull()
    expect(await loadCondenserAsset()).not.toBeNull()
    expect(calls).toBe(2)
    expect(condenserAssetSnapshot()).not.toBeNull()
  })

  test('concurrent callers share one in-flight load', async () => {
    let calls = 0
    __setCondenserAssetLoaderForTests(async () => {
      calls++
      return fakeAssetScene().scene
    })
    const [a, b] = await Promise.all([loadCondenserAsset(), loadCondenserAsset()])
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })

  test('the pinned asset identity: catalog id + GLB source stay explicit', () => {
    // If the host renames/moves the "AC block" item, this is the ONE spot
    // to update — and until then the missing-asset path keeps the box.
    expect(AC_BLOCK_ASSET_ID).toBe('ac-block')
    expect(AC_BLOCK_GLB_URL).toContain('/items/system/ac-block/model.glb')
  })
})

describe('prepareCondenserClone', () => {
  test('clones share geometry/materials and carry their OWN raycast no-op', () => {
    const { asset, mesh } = loadedAsset()
    const clone = prepareCondenserClone(asset)
    let found = 0
    clone.traverse((obj) => {
      if (!(obj instanceof Mesh)) return
      found++
      expect(obj.geometry).toBe(mesh.geometry)
      expect(obj.material).toBe(mesh.material)
      expect(Object.hasOwn(obj, 'raycast')).toBe(true)
    })
    expect(found).toBe(1)
    // the source asset's meshes were NOT mutated by the clone pass
    expect(Object.hasOwn(mesh, 'raycast')).toBe(false)
  })
})
