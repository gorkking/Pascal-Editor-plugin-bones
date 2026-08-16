'use client'

import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import { useMemo, useRef, useState } from 'react'
import { computeLevel } from '../framing/compute'
import { FramingNode, type WallConstruction, type WallOverride } from '../framing/schema'
import {
  CMU_SEAM_NOTE,
  cmuHeightControl,
  cmuHeightOverride,
  selectedWallInfo,
  wallOverridePatch,
} from '../panel-selection'

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

const GRIP_DOTS = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6']

/**
 * Local mirror of the host editor's SliderControl (same classes, same
 * drag-the-label + click-to-type interaction) — same barrel-avoidance reason
 * as SegmentedControl above. Trimmed to what this card needs: 4 px-per-step
 * scrubbing with an undo-safe commit (pause temporal, roll back to the drag
 * origin, resume, re-apply the final value = ONE undo step), typed entry on
 * the value; the host's wheel/arrow-key/modifier extras stay in the sidebar.
 */
function SliderControl({
  label,
  value,
  onChange,
  min,
  max,
  step,
  precision,
  unit,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step: number
  precision: number
  unit: string
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const drag = useRef<{ anchorX: number; origin: number } | null>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  const clamp = (v: number) => Math.min(Math.max(v, min), max)
  const submit = () => {
    const parsed = Number.parseFloat(text)
    if (!Number.isNaN(parsed)) onChange(clamp(parsed))
    setEditing(false)
  }
  return (
    <div className="group flex h-7 w-full select-none items-center rounded-lg px-2 transition-colors hover:bg-white/5">
      <div
        className="flex shrink-0 cursor-ew-resize items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground/80"
        onPointerDown={(e) => {
          if (editing) return
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { anchorX: e.clientX, origin: valueRef.current }
          useScene.temporal.getState().pause()
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          // 4 px per step, like the host control
          const next = clamp(drag.current.origin + ((e.clientX - drag.current.anchorX) / 4) * step)
          if (next !== valueRef.current) {
            valueRef.current = next
            onChange(next)
          }
        }}
        onPointerUp={(e) => {
          if (!drag.current) return
          const { origin } = drag.current
          const final = valueRef.current
          drag.current = null
          e.currentTarget.releasePointerCapture(e.pointerId)
          if (origin !== final) {
            onChange(origin) // roll back inside the pause, re-apply after —
            useScene.temporal.getState().resume() // the drag lands as one undo step
            onChange(final)
          } else {
            useScene.temporal.getState().resume()
          }
        }}
      >
        {/* Grip dots — 2×3 grid */}
        <div className="grid grid-cols-2 gap-[2.5px] opacity-25 transition-opacity group-hover:opacity-50">
          {GRIP_DOTS.map((k) => (
            <div className="h-[2px] w-[2px] rounded-full bg-current" key={k} />
          ))}
        </div>
        <span className="font-medium">{label}</span>
      </div>
      <div className="flex-1" />
      <div className="flex items-center text-xs">
        {editing ? (
          <>
            <input
              autoFocus
              className="w-14 bg-transparent p-0 text-right font-mono text-foreground outline-none selection:bg-primary/30"
              onBlur={submit}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                else if (e.key === 'Escape') setEditing(false)
              }}
              type="text"
              value={text}
            />
            <span className="ml-[1px] text-muted-foreground">{unit}</span>
          </>
        ) : (
          <button
            className="flex cursor-text items-center text-foreground/60 transition-colors hover:text-foreground"
            onClick={() => {
              setText(value.toFixed(precision))
              setEditing(true)
            }}
            type="button"
          >
            <span className="font-mono tabular-nums tracking-tight">
              {value.toFixed(precision)}
            </span>
            <span className="ml-[1px] text-muted-foreground">{unit}</span>
          </button>
        )}
      </div>
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

  const writeOverride = (value: WallOverride) =>
    useScene
      .getState()
      .updateNode(
        framingNode.id as AnyNodeId,
        wallOverridePatch(framingNode, info.wallId, value) as Partial<AnyNode> as never,
      )
  // CMU walls grow a height control: full height (100%) by default, drag
  // down to block only the bottom courses (knee/stem wall) — framed above.
  const cmuHeight =
    info.construction === 'cmu' ? cmuHeightControl(info.wallHeightM, info.override) : null

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
        onChange={(v: WallConstruction) => writeOverride(v)}
        options={[
          { label: 'Framed', value: 'framed' },
          { label: 'CMU', value: 'cmu' },
          { label: 'Skip', value: 'skip' },
        ]}
        value={info.construction}
      />
      {cmuHeight && (
        <div className="flex flex-col gap-0.5">
          <SliderControl
            label="Block height"
            max={cmuHeight.maxM}
            min={cmuHeight.minM}
            onChange={(v: number) => writeOverride(cmuHeightOverride(info.wallHeightM, v))}
            precision={2}
            step={cmuHeight.stepM}
            unit="m"
            value={cmuHeight.valueM}
          />
          <span className="px-2 text-[10px] text-muted-foreground tabular-nums">
            {cmuHeight.readout}
          </span>
          {cmuHeight.partial && (
            <span className="px-2 text-[10px] text-muted-foreground">{CMU_SEAM_NOTE}</span>
          )}
        </div>
      )}
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
