import { emitter, useScene } from '@pascal-app/core'

/**
 * TEMPORARY night-5 instrumentation (feat/outlets-live-ux) — exposes the host
 * scene store + event bus on window so a scratch Playwright session can trace
 * the exact writes a live move-commit produces (D2/D3/D4 root-causing).
 * Stripped before the branch ships; never imported under bun test.
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

export function installBonesTrace(): void {
  if (typeof window === 'undefined' || window.__bones) return
  const trace: Trace[] = []
  const push = (kind: string, detail: unknown) => {
    trace.push({ t: Date.now(), kind, detail })
    if (trace.length > 5000) trace.splice(0, 1000)
  }

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

  const logged = [
    'grid:click',
    'grid:pointerdown',
    'grid:pointerup',
    'bones:device:click',
    'bones:device:pointerdown',
    'bones:device:pointerup',
    'bones:service:click',
    'wall:click',
    'item:click',
    'slab:click',
    'tool:cancel',
  ]
  for (const key of logged) {
    emitter.on(key as never, ((payload: { node?: { id?: string } }) => {
      push(`event:${key}`, payload?.node?.id ?? null)
    }) as never)
  }

  window.__bones = {
    useScene,
    emitter,
    trace,
    mark: (label: string) => push('mark', label),
    reset: () => trace.splice(0, trace.length),
  }
}
