import { emitter, sceneRegistry, useScene } from '@pascal-app/core'
import { Raycaster, Vector2 } from 'three'

/**
 * TEMPORARY night-5 instrumentation (feat/outlets-live-ux) — exposes the host
 * scene store + event bus + a raycast picker on window so a scratch
 * Playwright session can trace the exact writes/events a live move-commit
 * produces (D2/D3/D4 root-causing). Stripped before the branch ships; never
 * imported under bun test.
 */

type Trace = {
  t: number
  kind: string
  detail: unknown
}

declare global {
  interface Window {
    __bones?: {
      useScene: typeof useScene
      emitter: typeof emitter
      trace: Trace[]
      mark: (label: string) => void
      reset: () => void
      pick: (clientX: number, clientY: number) => unknown
      setViewer: (store: unknown) => void
    }
  }
}

function nodeDiff(
  prev: Record<string, Record<string, unknown>>,
  next: Record<string, Record<string, unknown>>,
) {
  const out: Record<string, unknown> = {}
  for (const id of Object.keys(next)) {
    const a = prev[id]
    const b = next[id]
    if (a === b) continue
    if (!a) {
      out[id] = { CREATED: { type: b?.type, parentId: b?.parentId } }
      continue
    }
    const fields: Record<string, unknown> = {}
    for (const key of new Set([...Object.keys(a), ...Object.keys(b ?? {})])) {
      const av = a[key]
      const bv = b?.[key]
      if (JSON.stringify(av) !== JSON.stringify(bv)) {
        fields[key] = { from: av, to: bv }
      }
    }
    if (Object.keys(fields).length > 0) out[id] = fields
  }
  for (const id of Object.keys(prev)) {
    if (!(id in next)) out[id] = { DELETED: { type: prev[id]?.type } }
  }
  return out
}

/** Noisy per-frame events are counted, not logged. */
const NOISY = /:(move|enter|leave)$/

export function installBonesTrace(): void {
  if (typeof window === 'undefined' || window.__bones) return
  const trace: Trace[] = []
  const push = (kind: string, detail: unknown) => {
    trace.push({ t: Date.now(), kind, detail })
    if (trace.length > 8000) trace.splice(0, 2000)
  }
  const noisyCounts = new Map<string, number>()

  useScene.subscribe((state, prevState) => {
    const s = state as unknown as { nodes: Record<string, Record<string, unknown>> }
    const p = prevState as unknown as { nodes: Record<string, Record<string, unknown>> }
    if (s.nodes === p.nodes) return
    const temporal = (
      useScene as unknown as {
        temporal: { getState: () => { pastStates: unknown[]; isTracking?: boolean } }
      }
    ).temporal.getState()
    push('scene:set', {
      diff: nodeDiff(p.nodes, s.nodes),
      pastStates: temporal.pastStates.length,
      tracking: (temporal as { isTracking?: boolean }).isTracking,
    })
  })

  // Wildcard event log (mitt '*') — every bus event, noisy ones as counts.
  ;(emitter as unknown as { on: (k: '*', h: (type: string, e: unknown) => void) => void }).on(
    '*',
    (type, e) => {
      if (NOISY.test(type)) {
        noisyCounts.set(type, (noisyCounts.get(type) ?? 0) + 1)
        return
      }
      const nodeId = (e as { node?: { id?: string } } | undefined)?.node?.id ?? null
      push(`event:${type}`, nodeId)
    },
  )

  /** Raycast from a client pixel through the full scene graph; report the
   * ordered hits with their owning registry node ids. */
  const pick = (clientX: number, clientY: number) => {
    const getControls = (
      window as unknown as {
        __pascalCameraControls?: () => {
          camera?: { updateMatrixWorld: (f: boolean) => void }
        } | null
      }
    ).__pascalCameraControls
    const controls = getControls?.()
    const camera = controls?.camera as unknown as Parameters<Raycaster['setFromCamera']>[1]
    if (!camera) return { error: 'no camera' }
    const canvas = document.querySelector('canvas')
    if (!canvas) return { error: 'no canvas' }
    const rect = canvas.getBoundingClientRect()
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    // Root scene: climb from any registered object.
    const registryNodes = (
      sceneRegistry as unknown as { nodes: Map<string, { parent?: unknown }> }
    ).nodes
    let root: { parent?: unknown } | null = null
    for (const obj of registryNodes.values()) {
      let o = obj as { parent?: unknown } | null
      while (o?.parent) o = o.parent as { parent?: unknown }
      if (o) {
        root = o
        break
      }
    }
    if (!root) return { error: 'no scene root' }
    const owner = new Map<unknown, string>()
    for (const [id, obj] of registryNodes.entries()) owner.set(obj, id)
    const ray = new Raycaster()
    ;(camera as { updateMatrixWorld: (f: boolean) => void }).updateMatrixWorld(true)
    ray.setFromCamera(ndc, camera)
    const hits = ray.intersectObject(root as never, true)
    return hits.slice(0, 12).map((h) => {
      let nodeId: string | null = null
      let o: { parent?: unknown } | null = h.object as unknown as { parent?: unknown }
      while (o) {
        const id = owner.get(o)
        if (id) {
          nodeId = id
          break
        }
        o = (o.parent as { parent?: unknown } | undefined) ?? null
      }
      const object = h.object as unknown as {
        name?: string
        type?: string
        visible?: boolean
        raycast?: unknown
      }
      const nodeType = nodeId
        ? ((useScene.getState().nodes as Record<string, { type?: string }>)[nodeId]?.type ?? null)
        : null
      return {
        distance: Number(h.distance.toFixed(3)),
        object: `${object.type}:${object.name || ''}`,
        visible: object.visible !== false,
        nodeId,
        nodeType,
      }
    })
  }

  window.__bones = {
    useScene,
    emitter,
    trace,
    mark: (label: string) =>
      push('mark', { label, noisy: Object.fromEntries(noisyCounts.entries()) }),
    reset: () => {
      trace.splice(0, trace.length)
      noisyCounts.clear()
    },
    pick,
    setViewer: (store: unknown) => {
      const s = store as {
        subscribe: (fn: (v: { selection?: { selectedIds?: string[] } }) => void) => void
        getState: () => { selection?: { selectedIds?: string[] } }
      }
      let prev = JSON.stringify(s.getState().selection?.selectedIds ?? [])
      s.subscribe((v) => {
        const cur = JSON.stringify(v.selection?.selectedIds ?? [])
        if (cur !== prev) {
          prev = cur
          push('selection', cur)
        }
      })
    },
  }
}
