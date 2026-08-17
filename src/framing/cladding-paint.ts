import {
  type AnyNode,
  type AnyNodeId,
  generateSceneMaterialId,
  type SceneMaterial,
  toSceneMaterialRef,
  useScene,
} from '@pascal-app/core'
import type { WallCladding } from './schema'

/**
 * Solid-mode half of the cladding choice: the Bones members only render in
 * X-ray, so picking "stucco" must ALSO repaint the host-drawn wall skin.
 * The host's unified surface model is `node.slots[side] = MaterialRef`
 * (`library:<id>` or `scene:<id>`) — the paint tool writes exactly that
 * field, so writing it here gets rendering, caching, undo, persistence and
 * GLB export for free. No host changes needed.
 */

/**
 * Exterior face-band slots fall back to the whole-face `exterior` ref only
 * when they carry no ref of their own — clearing them makes a banded wall
 * repaint uniformly instead of keeping stale bands over the new finish.
 */
const EXTERIOR_BAND_SLOTS = ['lowerExterior', 'middleExterior', 'upperExterior', 'topExterior']

/**
 * Families with a real texture set in the host material library. The library
 * has no siding/clapboard textures at all (vinyl, fiber cement, wood lap),
 * so those mint flat scene materials below instead.
 */
const LIBRARY_REF: Partial<Record<WallCladding, string>> = {
  stucco: 'library:concrete-stucco',
  brickVeneer: 'library:flooring-rusticbrick',
  eifs: 'library:concrete-plaster',
}

/**
 * Flat finishes for the texture-less families — colors match the X-ray
 * member palette (framing/renderer colorOf) so solid and X-ray agree.
 */
export const FLAT_FINISH: Partial<
  Record<WallCladding, { name: string; color: string; roughness: number }>
> = {
  vinyl: { name: 'Vinyl siding', color: '#b9c6d1', roughness: 0.45 },
  fiberCement: { name: 'Fiber cement siding', color: '#a9b3a4', roughness: 0.8 },
  wood: { name: 'Wood siding', color: '#a67848', roughness: 0.75 },
}

type MaterialsLike = Record<string, { id: string; name: string; material: unknown }>

export type CladdingPaintPlan = {
  /** Full replacement slots record for the wall node (interior untouched). */
  slots: Record<string, string>
  /** Scene material to create WITH the slot write (one undo step) — set only
   * when a flat family has no byte-identical material to reuse. */
  mint?: SceneMaterial
}

const flatMaterial = (def: { color: string; roughness: number }) => ({
  preset: 'custom' as const,
  properties: {
    color: def.color,
    roughness: def.roughness,
    metalness: 0,
    opacity: 1,
    transparent: false,
    side: 'front' as const,
  },
})

/**
 * Pure planner: given the chosen family and the wall's current slots, return
 * the next slots record (+ a material to mint when needed). Mirrors the host
 * paint tool's find-or-mint so repeated picks reuse one scene material.
 */
export function claddingPaintPlan(
  cladding: WallCladding,
  slots: Record<string, string> | undefined,
  materials: MaterialsLike,
): CladdingPaintPlan | null {
  const next: Record<string, string> = { ...(slots ?? {}) }
  for (const band of EXTERIOR_BAND_SLOTS) delete next[band]

  const libraryRef = LIBRARY_REF[cladding]
  if (libraryRef) {
    next.exterior = libraryRef
    return { slots: next }
  }

  const flat = FLAT_FINISH[cladding]
  if (!flat) return null
  const material = flatMaterial(flat)
  const wanted = JSON.stringify(material)
  const existing = Object.values(materials).find((m) => JSON.stringify(m.material) === wanted)
  if (existing) {
    next.exterior = toSceneMaterialRef(existing.id)
    return { slots: next }
  }
  const id = generateSceneMaterialId()
  next.exterior = toSceneMaterialRef(id)
  return { slots: next, mint: { id, name: flat.name, material } }
}

/**
 * Apply the plan to every host wall node in the colinear group (paintIds
 * from selectedWallInfo — the kept wall plus its dedupe twins, so a merged
 * run repaints without a seam). Interior slots are never touched.
 */
export function paintWallExterior(paintIds: readonly string[], cladding: WallCladding): void {
  const state = useScene.getState()
  for (const wallId of paintIds) {
    const node = state.nodes[wallId as AnyNodeId] as
      | (AnyNode & { slots?: Record<string, string> })
      | undefined
    if (!node) continue
    const plan = claddingPaintPlan(
      cladding,
      node.slots,
      useScene.getState().materials as MaterialsLike,
    )
    if (!plan) continue
    if (plan.mint) {
      // Material + slot ref land in ONE set — one history entry, one undo
      // removes both (same contract as the host's commitSlotPaint).
      const mint = plan.mint
      useScene.setState((s) => {
        if (s.readOnly) return s
        const live = s.nodes[wallId as AnyNodeId] as
          | (AnyNode & { slots?: Record<string, string> })
          | undefined
        if (!live) return s
        return {
          materials: { ...s.materials, [mint.id]: mint },
          nodes: { ...s.nodes, [wallId]: { ...live, slots: plan.slots } as AnyNode },
        }
      })
      useScene.getState().markDirty(wallId as AnyNodeId)
      continue
    }
    useScene
      .getState()
      .updateNode(wallId as AnyNodeId, { slots: plan.slots } as Partial<AnyNode> as never)
  }
}
