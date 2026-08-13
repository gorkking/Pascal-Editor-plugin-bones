'use client'

import { useScene } from '@pascal-app/core'
import { SegmentedControl, SliderControl, useEditor } from '@pascal-app/editor'
import { LUMBER_CROSS_SECTIONS, LUMBER_SIZES, type LumberSize } from './lumber'
import { useBonesStore } from './store'

const KIND: string = 'bones:lumber'

const setPluginTool = (tool: string) => {
  const setTool = useEditor.getState().setTool as (value: string) => void
  setTool(tool)
}

const METERS_PER_INCH = 0.0254
const inches = (m: number) => `${(m / METERS_PER_INCH).toFixed(m % 0.0254 === 0 ? 0 : 2).replace(/\.?0+$/, '')}"`

/**
 * The Bones left-rail panel. Picking a lumber size arms placement
 * (`setTool('bones:lumber')` + build mode); the sliders shape the brush. The
 * count chip reads the scene reactively — panel → store → tool → scene →
 * panel, same triangle as the Nature plugin.
 */
export default function BonesPanel() {
  const size = useBonesStore((s) => s.size)
  const length = useBonesStore((s) => s.length)
  const orientation = useBonesStore((s) => s.orientation)
  const activeTool = useEditor((s) => s.tool)
  const count = useScene(
    (s) => Object.values(s.nodes).filter((n) => (n.type as string) === KIND).length,
  )

  const arming = activeTool === KIND

  const activate = (next: LumberSize) => {
    useBonesStore.getState().setSize(next)
    setPluginTool(KIND)
    useEditor.getState().setMode('build')
  }

  return (
    <div className="flex flex-col gap-4 p-4 text-sidebar-foreground">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-base">Bones</h2>
          <span className="rounded-full bg-sidebar-accent px-2 py-0.5 text-sidebar-foreground/70 text-xs">
            {count} member{count === 1 ? '' : 's'}
          </span>
        </div>
        <p className="text-sidebar-foreground/50 text-xs">
          {arming
            ? 'Click the ground to place. Press Esc to stop.'
            : 'Pick a lumber size, then click the ground.'}
        </p>
      </header>

      <div className="grid grid-cols-4 gap-2">
        {LUMBER_SIZES.map((s) => {
          const [t, w] = LUMBER_CROSS_SECTIONS[s]
          const selected = arming && s === size
          return (
            <button
              className={`flex flex-col items-center gap-0.5 rounded-md border px-1 py-2 text-xs transition-colors ${
                selected
                  ? 'border-sidebar-ring bg-sidebar-accent text-sidebar-foreground'
                  : 'border-sidebar-border/60 bg-sidebar-accent/40 text-sidebar-foreground/80 hover:bg-sidebar-accent'
              }`}
              key={s}
              onClick={() => activate(s)}
              title={`Actual ${inches(t)} × ${inches(w)}`}
              type="button"
            >
              <span className="font-medium">{s}</span>
            </button>
          )
        })}
      </div>

      <div className="flex flex-col gap-2">
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

      <div className="flex flex-col gap-1 rounded-md border border-sidebar-border/50 bg-sidebar-accent/30 p-3">
        <span className="font-medium text-sidebar-foreground/80 text-xs">Coming next</span>
        <p className="text-[11px] text-sidebar-foreground/50 leading-relaxed">
          Framing inference — studs, plates &amp; headers generated from your walls; joists,
          rafters and foundations after that. See SPEC.md in the repo.
        </p>
      </div>

      <footer className="-mx-4 -mb-4 sticky bottom-0 mt-1 border-sidebar-border/50 border-t bg-sidebar px-4 py-3 text-[11px] text-sidebar-foreground/50 leading-relaxed">
        Bones — the structural skeleton of your Pascal house.
      </footer>
    </div>
  )
}
