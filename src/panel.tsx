'use client'

import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import { SegmentedControl, SliderControl, useEditor } from '@pascal-app/editor'
import { useViewer } from '@pascal-app/viewer'
import { useEffect, useMemo, useState } from 'react'
import { computeLevel } from './framing/compute'
import { FramingNode, type WallConstruction } from './framing/schema'
import { computeTakeoff, takeoffCsv } from './engines/takeoff'
import { guessJurisdiction } from './jurisdiction/guess'
import { jurisdictionOptions, profileFor } from './jurisdiction/profiles'
import { LUMBER_CROSS_SECTIONS, LUMBER_SIZES, type LumberSize } from './lumber'
import { useBonesStore } from './store'

const LUMBER_KIND: string = 'bones:lumber'
const FRAMING_KIND: string = 'bones:framing'

const setPluginTool = (tool: string) => {
  const setTool = useEditor.getState().setTool as (value: string) => void
  setTool(tool)
}

const METERS_PER_INCH = 0.0254
const inchesLabel = (m: number) =>
  `${(m / METERS_PER_INCH).toFixed(2).replace(/\.?0+$/, '')}"`

/**
 * The Bones panel — the control room for the engineering X-ray. One click
 * derives the construction inside the current level (framing, foundation,
 * electrical…) from the model and renders it in 3D; everything below tunes
 * the derivation. Loose lumber placement lives at the bottom.
 */
export default function BonesPanel() {
  const activeLevelId = useViewer((s) => s.selection.levelId)
  const framingNode = useScene((s) => {
    if (!activeLevelId) return undefined
    return Object.values(s.nodes).find(
      (n) => (n.type as string) === FRAMING_KIND && n.parentId === activeLevelId,
    ) as (FramingNode & { id: string }) | undefined
  })

  return (
    <div className="flex flex-col gap-4 p-4 text-sidebar-foreground">
      <header className="flex flex-col gap-1">
        <h2 className="font-semibold text-base">Bones</h2>
        <p className="text-sidebar-foreground/50 text-xs leading-relaxed">
          The engineering X-ray — see the construction inside the model: framing, foundation,
          wiring. Computed from your walls, sized to your jurisdiction.
        </p>
      </header>

      <XraySection activeLevelId={activeLevelId ?? null} framingNode={framingNode} />

      {framingNode && <WallOverrideSection framingNode={framingNode} />}
      {framingNode && <TakeoffSection framingNode={framingNode} />}

      <LumberSection />

      <footer className="-mx-4 -mb-4 sticky bottom-0 mt-1 border-sidebar-border/50 border-t bg-sidebar px-4 py-3 text-[11px] text-sidebar-foreground/50 leading-relaxed">
        Drafting aid, not engineering — verify with your local building department.
      </footer>
    </div>
  )
}

function XraySection({
  activeLevelId,
  framingNode,
}: {
  activeLevelId: string | null
  framingNode: (FramingNode & { id: string }) | undefined
}) {
  const nodes = useScene((s) => s.nodes)

  const result = useMemo(() => {
    if (!framingNode) return null
    return computeLevel(nodes as Record<string, Record<string, unknown>>, framingNode)
  }, [nodes, framingNode])

  // Client-only guess: the timezone differs between SSR and browser, which
  // would desync hydration — render a stable label first, fill in on mount.
  const [guess, setGuess] = useState<{ code: string; reason: string } | null>(null)
  useEffect(() => setGuess(guessJurisdiction()), [])
  const options = useMemo(() => jurisdictionOptions(), [])

  const toggle = (key: keyof FramingNode) => {
    if (!framingNode) return
    useScene
      .getState()
      .updateNode(framingNode.id as AnyNodeId, {
        [key]: !framingNode[key],
      } as Partial<AnyNode> as never)
  }

  if (!activeLevelId) {
    return <p className="text-sidebar-foreground/50 text-xs">Select a level to X-ray.</p>
  }

  if (!framingNode) {
    return (
      <button
        className="rounded-md border border-sidebar-ring bg-sidebar-accent px-3 py-2 text-left font-medium text-sm transition-colors hover:bg-sidebar-accent/70"
        onClick={() => {
          const node = FramingNode.parse({ jurisdiction: 'AUTO' })
          useScene.getState().createNode(node as unknown as AnyNode, activeLevelId as AnyNodeId)
        }}
        type="button"
      >
        ⚡ X-Ray this level
        <span className="block font-normal text-sidebar-foreground/50 text-xs">
          Derive framing, foundation &amp; systems from the model
        </span>
      </button>
    )
  }

  const effectiveCode = result?.jurisdiction ?? 'INTL'
  const profile = profileFor(effectiveCode)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">X-Ray</span>
        <button
          className="rounded-md border border-sidebar-border/60 px-2 py-1 text-sidebar-foreground/70 text-xs transition-colors hover:bg-sidebar-accent"
          onClick={() => useScene.getState().deleteNode(framingNode.id as AnyNodeId)}
          type="button"
        >
          Remove
        </button>
      </div>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-sidebar-foreground/60">Jurisdiction</span>
        <select
          className="rounded-md border border-sidebar-border/60 bg-sidebar-accent/40 px-2 py-1.5 text-sidebar-foreground text-xs"
          onChange={(e) =>
            useScene
              .getState()
              .updateNode(framingNode.id as AnyNodeId, {
                jurisdiction: e.target.value,
              } as Partial<AnyNode> as never)
          }
          value={framingNode.jurisdiction}
        >
          <option value="AUTO">{guess ? `Auto — ${guess.code} (${guess.reason})` : 'Auto'}</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-sidebar-foreground/40">{profile.residentialCode}</span>
      </label>

      <div className="flex gap-2">
        <div className="flex-1">
          <SegmentedControl
            onChange={(v: string) =>
              useScene
                .getState()
                .updateNode(framingNode.id as AnyNodeId, { detail: v } as Partial<AnyNode> as never)
            }
            options={[
              { label: 'Generic', value: '200' },
              { label: 'Code-sized', value: '300' },
            ]}
            value={framingNode.detail}
          />
        </div>
        <div className="w-24">
          <SegmentedControl
            onChange={(v: string) =>
              useScene
                .getState()
                .updateNode(framingNode.id as AnyNodeId, {
                  studSpacingIn: Number(v) as 16 | 24,
                } as Partial<AnyNode> as never)
            }
            options={[
              { label: '16"', value: '16' },
              { label: '24"', value: '24' },
            ]}
            value={String(framingNode.studSpacingIn)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        {(
          [
            ['showWalls', 'Wall framing'],
            ['showFloor', 'Floor'],
            ['showRoof', 'Roof'],
            ['showFoundation', 'Foundation'],
            ['showElectrical', 'Electrical'],
            ['showPlumbing', 'Plumbing'],
            ['showHvac', 'HVAC'],
            ['seeThrough', 'X-ray vision'],
          ] as const
        ).map(([key, label]) => (
          <button
            className={`rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
              framingNode[key]
                ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-foreground'
                : 'border-sidebar-border/60 bg-sidebar-accent/30 text-sidebar-foreground/60 hover:bg-sidebar-accent/60'
            }`}
            key={key}
            onClick={() => toggle(key)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {result && (
        <p className="text-[11px] text-sidebar-foreground/50">
          {result.members.length} members · {result.fixtures.length} devices
          {result.warnings.length > 0 && (
            <span className="block text-amber-500/80">{result.warnings[0]}</span>
          )}
        </p>
      )}
    </div>
  )
}

/** Per-wall construction override, bound to the current selection. */
function WallOverrideSection({
  framingNode,
}: {
  framingNode: FramingNode & { id: string }
}) {
  const selectedIds = useViewer((s) => s.selection.selectedIds)
  const selectedWall = useScene((s) => {
    const id = selectedIds?.[0]
    if (!id) return undefined
    const node = s.nodes[id as AnyNodeId]
    return node && (node.type as string) === 'wall' ? node : undefined
  })

  if (!selectedWall) return null
  const wallId = selectedWall.id as string
  const current: WallConstruction = framingNode.wallOverrides?.[wallId] ?? 'framed'

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-sidebar-border/50 bg-sidebar-accent/30 p-2.5">
      <span className="font-medium text-xs">Selected wall construction</span>
      <SegmentedControl
        onChange={(v: WallConstruction) =>
          useScene.getState().updateNode(framingNode.id as AnyNodeId, {
            wallOverrides: { ...framingNode.wallOverrides, [wallId]: v },
          } as Partial<AnyNode> as never)
        }
        options={[
          { label: 'Framed', value: 'framed' },
          { label: 'CMU', value: 'cmu' },
          { label: 'Skip', value: 'skip' },
        ]}
        value={current}
      />
    </div>
  )
}

function TakeoffSection({ framingNode }: { framingNode: FramingNode & { id: string } }) {
  const nodes = useScene((s) => s.nodes)
  const rows = useMemo(() => {
    const result = computeLevel(nodes as Record<string, Record<string, unknown>>, framingNode)
    return computeTakeoff(result.members, result.fixtures)
  }, [nodes, framingNode])

  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="font-medium text-xs">Takeoff</span>
        <button
          className="rounded-md border border-sidebar-border/60 px-2 py-0.5 text-[10px] text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent"
          onClick={() => navigator.clipboard?.writeText(takeoffCsv(rows))}
          type="button"
        >
          Copy CSV
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.slice(0, 12).map((row) => (
          <div
            className="flex items-baseline justify-between text-[11px]"
            key={`${row.item}-${row.detail}`}
          >
            <span className="text-sidebar-foreground/70">
              {row.item}
              <span className="text-sidebar-foreground/40"> {row.detail}</span>
            </span>
            <span className="tabular-nums text-sidebar-foreground/90">
              {row.quantity} {row.unit}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Loose lumber placement (v0.1) — the manual escape hatch + debug tool. */
function LumberSection() {
  const size = useBonesStore((s) => s.size)
  const length = useBonesStore((s) => s.length)
  const orientation = useBonesStore((s) => s.orientation)
  const activeTool = useEditor((s) => s.tool)
  const count = useScene(
    (s) => Object.values(s.nodes).filter((n) => (n.type as string) === LUMBER_KIND).length,
  )
  const arming = activeTool === LUMBER_KIND

  const activate = (next: LumberSize) => {
    useBonesStore.getState().setSize(next)
    setPluginTool(LUMBER_KIND)
    useEditor.getState().setMode('build')
  }

  return (
    <details className="group">
      <summary className="flex cursor-pointer items-center justify-between font-medium text-xs">
        Loose lumber
        <span className="rounded-full bg-sidebar-accent px-2 py-0.5 text-[10px] text-sidebar-foreground/60">
          {count}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-[11px] text-sidebar-foreground/50">
          {arming ? 'Click the ground to place. Esc to stop.' : 'Pick a size, click the ground.'}
        </p>
        <div className="grid grid-cols-4 gap-1.5">
          {LUMBER_SIZES.map((s) => {
            const [t, w] = LUMBER_CROSS_SECTIONS[s]
            const selected = arming && s === size
            return (
              <button
                className={`rounded-md border px-1 py-1.5 text-xs transition-colors ${
                  selected
                    ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-foreground'
                    : 'border-sidebar-border/60 bg-sidebar-accent/40 text-sidebar-foreground/80 hover:bg-sidebar-accent'
                }`}
                key={s}
                onClick={() => activate(s)}
                title={`Actual ${inchesLabel(t)} × ${inchesLabel(w)}`}
                type="button"
              >
                {s}
              </button>
            )
          })}
        </div>
        <SegmentedControl
          onChange={useBonesStore.getState().setOrientation}
          options={[
            { label: 'Stud', value: 'stud' },
            { label: 'Flat', value: 'flat' },
            { label: 'Edge', value: 'edge' },
          ]}
          value={orientation}
        />
        <SliderControl
          label="Length"
          max={7.4}
          min={0.1}
          onChange={useBonesStore.getState().setLength}
          precision={2}
          restoreOnCommit={false}
          step={0.05}
          unit="m"
          value={length}
        />
      </div>
    </details>
  )
}
