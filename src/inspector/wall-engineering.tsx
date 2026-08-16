'use client'

import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import { useMemo } from 'react'
import { computeLevel } from '../framing/compute'
import { FramingNode, type WallConstruction } from '../framing/schema'
import { selectedWallInfo, wallOverridePatch } from '../panel-selection'

const FRAMING_KIND: string = 'bones:framing'

/**
 * Local mirror of the host editor's SegmentedControl (same classes) — the
 * `@pascal-app/editor` barrel drags viewer-side modules that can't load
 * headless, and this lazy chunk shouldn't depend on it for three buttons.
 */
function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: { label: string; value: T }[]
}) {
  return (
    <div className="flex h-9 w-full items-center rounded-lg border border-border/50 bg-[#2C2C2E] p-[3px]">
      {options.map((option) => {
        const isSelected = value === option.value
        return (
          <button
            className={`relative flex h-full flex-1 items-center justify-center rounded-md font-medium text-xs transition-all duration-200 ${
              isSelected
                ? 'bg-[#3e3e3e] text-foreground shadow-sm ring-1 ring-border/50'
                : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
            }`}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            <span className="relative z-10 flex items-center gap-1.5">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * The selected node as the host inspector-extension slot hands it over — we
 * only need identity + parent level; everything else re-derives from the
 * scene so the section stays live as the model is edited.
 */
type SelectedNodeLike = { id: string; parentId?: string | null }

/**
 * "Engineering" section for the wall's floating inspector card — the same
 * per-wall engineering the sidebar's SelectedWallCard prints, surfaced on
 * the element itself: exterior/interior, framed/CMU/skip (writes the
 * per-wall override), the stud recipe and the climate-zone insulation.
 * All resolution goes through the gated `selectedWallInfo` (shared probe +
 * colinear dedupe), so this card and the sidebar can never disagree.
 */
export default function WallEngineering({ node }: { node: SelectedNodeLike }) {
  const levelId = (node.parentId ?? null) as string | null
  const framingNode = useScene((s) => {
    if (!levelId) return undefined
    return Object.values(s.nodes).find(
      (n) => (n.type as string) === FRAMING_KIND && n.parentId === levelId,
    ) as (FramingNode & { id: string }) | undefined
  })
  const nodes = useScene((s) => s.nodes)
  // computeLevel is memoized per (nodes, config) — when the renderer or the
  // sidebar panel already derived this level, this is a cache hit.
  const result = useMemo(() => {
    if (!framingNode) return null
    return computeLevel(nodes as Record<string, Record<string, unknown>>, framingNode)
  }, [nodes, framingNode])
  const info = useMemo(
    () =>
      selectedWallInfo(
        nodes as Record<string, Record<string, unknown>>,
        { levelId, selectedIds: [node.id] },
        framingNode,
        result,
      ),
    [nodes, levelId, node.id, framingNode, result],
  )

  if (!levelId) return null

  if (!framingNode) {
    return (
      <button
        className="rounded-md border border-border/60 bg-accent/40 px-3 py-2 text-left font-medium text-foreground text-xs transition-colors hover:bg-accent"
        onClick={() => {
          const created = FramingNode.parse({ jurisdiction: 'AUTO' })
          useScene.getState().createNode(created as unknown as AnyNode, levelId as AnyNodeId)
        }}
        type="button"
      >
        ⚡ X-Ray this level
        <span className="block font-normal text-[10px] text-muted-foreground">
          Derive framing, foundation &amp; systems to see this wall's engineering
        </span>
      </button>
    )
  }

  if (!info) {
    return (
      <p className="text-muted-foreground text-xs leading-relaxed">
        No engineering for this wall — it may be hidden or degenerate.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-foreground text-xs" title={info.wallId}>
          {info.label}
        </span>
        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[10px] text-muted-foreground">
          {info.exterior ? 'Exterior' : 'Interior'}
        </span>
      </div>
      <SegmentedControl
        onChange={(v: WallConstruction) =>
          useScene
            .getState()
            .updateNode(
              framingNode.id as AnyNodeId,
              wallOverridePatch(framingNode, info.wallId, v) as Partial<AnyNode> as never,
            )
        }
        options={[
          { label: 'Framed', value: 'framed' },
          { label: 'CMU', value: 'cmu' },
          { label: 'Skip', value: 'skip' },
        ]}
        value={info.construction}
      />
      <div className="text-[11px] text-muted-foreground leading-relaxed">
        <span className="block">{info.assembly}</span>
        {info.insulation && <span className="block">{info.insulation}</span>}
        {info.duplicateNote && (
          <span className="block text-amber-500/80">{info.duplicateNote}</span>
        )}
        {info.curved && (
          <span className="block text-amber-500/80">Curved — framing lands later</span>
        )}
      </div>
    </div>
  )
}
