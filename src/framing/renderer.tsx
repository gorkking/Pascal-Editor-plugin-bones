'use client'

import {
  pauseSceneHistory,
  resumeSceneHistory,
  sceneRegistry,
  useLiveNodeOverrides,
  useRegistry,
  useScene,
} from '@pascal-app/core'
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BoxGeometry,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import type { Fixture, Member } from '../core/types'
import { inches } from '../core/units'
import { reconcileDeviceNodes } from '../device/place'
import { circuitColor, hvacDuctColor, plumbingPipeColor } from '../plans/circuit-colors'
import { normalizeServiceAnchors } from '../service/normalize'
import { planServiceSeeding } from '../service/place'
import { computeLevel } from './compute'
import { effectiveNodesFor, throttleTrailing } from './live'
import { effectiveViewMode, type FramingNode, type ViewMode } from './schema'

/**
 * The X-ray renderer: derives every member for this node's level and draws
 * them as one InstancedMesh per color bucket — a whole house is a handful of
 * draw calls. Nothing here is persisted; edit a wall and the skeleton
 * recomputes on the spot.
 */

/** Color buckets — material first, with structural roles popped for reading. */
export function colorOf(member: Member): string {
  // Wires color by CIRCUIT (sourceId carries the circuit id) so a run reads
  // as its zone in the building exactly like on the exported plan.
  if (member.system === 'electrical' && member.role === 'wire-run') {
    return circuitColor(member.sourceId)
  }
  // Plumbing runs color by SYSTEM (sourceId prefix): cold blue, hot red,
  // DWV slate — identical to the exported MEP sheet. The room-category
  // fallback's room-sourced runs keep their material colors below. HVAC
  // refrigerant line-sets join the same convention (suction cold-blue,
  // liquid warm-red); hvac condensate keeps its material color (null).
  if (
    (member.system === 'plumbing' || member.system === 'hvac') &&
    member.role === 'pipe-run'
  ) {
    const pipe = plumbingPipeColor(member.sourceId)
    if (pipe) return pipe
  }
  // RETURN-air duct reads darker than supply tin (B19c) — same 3D/paper
  // contract as the circuit and plumbing colors.
  if (member.system === 'hvac' && member.role === 'duct-run') {
    const tone = hvacDuctColor(member.sourceId)
    if (tone) return tone
  }
  switch (member.role) {
    case 'drywall':
      return '#ece7de'
    case 'sheathing':
      return '#c8a262'
    case 'wrb':
      return '#4f7d8c'
    case 'cladding': {
      // Distinct per-family colors so the Engineering panel's finish choice
      // reads in the X-ray (user report: stucco vs vinyl looked identical).
      const l = (member.label ?? '').toLowerCase()
      if (l.includes('brick')) return '#9e4a3a'
      if (l.includes('stucco') || l.includes('plaster')) return '#d6cdb8'
      if (l.includes('vinyl')) return '#b9c6d1'
      if (l.includes('fiber cement')) return '#a9b3a4'
      if (l.includes('wood')) return '#a67848'
      if (l.includes('eps') || l.includes('base coat') || l.includes('finish')) return '#e3dccb'
      return '#aebfc7'
    }
    case 'insulation':
      return '#e8b4c8' // pink batts (board spec, full wall engineering panel)
    default:
      break
  }
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
  'receptacle-wr-gfci': '#c96a2e',
  switch: '#7fb3e0',
  light: '#f5e08a',
  'smoke-alarm': '#e06c6c',
  'co-alarm': '#e0a34f',
  panel: '#8f8f8f',
}

/** Fixtures render as small instanced boxes (device-box scale). */
function fixtureBox(fixture: Fixture): { dims: [number, number, number]; color: string } {
  const color = FIXTURE_COLORS[fixture.kind] ?? '#f2b63d'
  if (fixture.kind === 'panel') return { dims: [inches(14), inches(30), inches(4)], color }
  if (fixture.kind === 'light') return { dims: [inches(6), inches(1.5), inches(6)], color }
  return { dims: [inches(3), inches(4.5), inches(2.5)], color }
}

/**
 * Below-floor stratum predicate (user round 2026-08-20: "I shouldn't be able
 * to see the crawl space at all [in X-ray]" + the dedicated basement mode).
 * System-based for the two systems that live under the floor plane by
 * definition — foundation (footings, stemwalls, slab, vapor, anchor bolts,
 * rebar) and floor-framing (joists/girders under the subfloor — the
 * crawl-space ceiling) — plus a y-extent rule for buried runs of any other
 * system: top of the box below the floor line (same 0.02 m tolerance the old
 * buried-DWV ghost used). Everything at or above grade stays 'above': an
 * outdoor condenser pad (hvac, sitting ON grade) is outside, not under the
 * house.
 */
export const BURIED_TOP_Y = 0.02
export function isBelowFloor(member: Member): boolean {
  if (member.system === 'foundation' || member.system === 'floor-framing') return true
  return member.position[1] + member.dims[1] / 2 < BURIED_TOP_Y
}

/**
 * Fixture kinds a FINISHED house shows (viewMode 'off'): the wall/ceiling
 * surface devices — outlet & switch plates, lights, smoke alarms, the
 * panel's door face, thermostat, registers/returns, exhaust fans — and the
 * standing appliances/meters (water heater, air handler, meters, condenser
 * disconnect). Rough-in-only kinds hide: stub-outs (in-wall), cleanouts and
 * the vent-stack marker read as construction, not as a finished surface.
 */
const SURFACE_FIXTURE_KINDS: ReadonlySet<Fixture['kind']> = new Set([
  'receptacle',
  'receptacle-gfci',
  'receptacle-wr-gfci', // outdoor WR box behind its in-use cover IS the finished surface
  'switch',
  'light',
  'smoke-alarm',
  'co-alarm', // B13: a CO alarm is a visible ceiling device like a smoke alarm
  'panel',
  'thermostat',
  'register',
  'return',
  'exhaust-fan',
  'water-heater',
  'equipment',
  'water-meter',
  'electric-meter',
  'disconnect',
] as Fixture['kind'][])

/** Basement mode: below-floor overlay strength — near-solid so foundation /
 * drainage / buried pipes read crisply through the floor and the shell. */
export const BELOW_GHOST_OPACITY = 0.9
/** Basement mode: the slab/vapor PLANE FIELDS' overlay strength — reduced
 * (still clearly concrete) and depth-silent, so the under-slab drainage
 * network reads THROUGH the slab field instead of only peeking out at the
 * edges (browser QA round 3: 'you get to see what's under your house…
 * the drainage' was only partially met with the field at 0.9). */
export const SLAB_FIELD_OPACITY = 0.5
/** Basement mode: buried MEP runs draw AFTER the slab field in the overlay
 * pass (renderOrder beats transparent distance-sorting), so with the field
 * writing no depth the network composites crisply on top of it. */
export const THROUGH_RENDER_ORDER = 1
/** Basement mode: the above-floor house shell — barely visible, enough to
 * orient ("super transparent on top" — user round 2026-08-20). */
export const FAINT_OPACITY = 0.08

/** Per-bucket render treatment (derived from view mode + stratum):
 * 'solid' one opaque depth-tested mesh; 'faint' one barely-visible
 * transparent mesh (basement's above-floor orientation shell); and the
 * three below-floor basement variants, all opaque-solid on the scene layer
 * plus an overlay copy that differs per class:
 *  - 'ghosted'         structural stratum (footings, stemwalls, joists…):
 *                      strong (0.9), depth-writing, renderOrder 0;
 *  - 'ghosted-field'   the slab / vapor plane fields: reduced opacity,
 *                      depthWrite OFF, renderOrder 0 — a translucent
 *                      concrete veil that can never hide what's under it;
 *  - 'ghosted-through' buried MEP runs + their fixtures (the drainage
 *                      network, cleanout risers): strong, depth-writing
 *                      (self-occlusion stays physical), renderOrder 1 —
 *                      drawn after the field, reading through it. */
type BucketTreatment = 'solid' | 'ghosted' | 'ghosted-field' | 'ghosted-through' | 'faint'

type Bucket = {
  color: string
  /** Source wall id for face-carrying buckets — the cull exemption key. */
  sourceId?: string
  entries: {
    dims: readonly [number, number, number]
    position: readonly [number, number, number]
    rotation: readonly [number, number, number]
  }[]
  /** Assembly-layer face normal — the dollhouse cut hides camera-facing buckets. */
  face?: readonly [number, number]
  treatment: BucketTreatment
}

/** Main group (the node's own level) + one group per FOREIGN source level
 * (cross-level roofs). Foreign groups hold level-LOCAL geometry and get
 * mounted into that level's Object3D by the renderer so the host's
 * stacked / exploded / solo level transforms apply natively. */
export type BuiltGroups = { group: Group; foreign: Map<string, Group> }

export function buildGroups(
  members: Member[],
  fixtures: Fixture[],
  mode: ViewMode,
): BuiltGroups {
  const foreign = new Map<string, Group>()
  const own: Member[] = []
  const byLevel = new Map<string, Member[]>()
  for (const m of members) {
    // mountLevelId = render-only mount (own-level roof strata); the sheets
    // never lift it — only the renderer groups on it.
    const mount = m.levelId ?? m.mountLevelId
    if (mount) {
      const list = byLevel.get(mount) ?? []
      list.push(m)
      byLevel.set(mount, list)
    } else own.push(m)
  }
  const group = buildGroup(own, fixtures, mode)
  for (const [levelId, list] of byLevel) {
    const g = buildGroup(list, [], mode)
    g.name = `bones-foreign-${levelId}`
    // Source level strictly ABOVE the owner (compute tags the members) —
    // only these groups take the exploded roof stratum drop below.
    g.userData.strataAbove = list.some((m) => m.strataAbove === true)
    foreign.set(levelId, g)
  }
  return { group, foreign }
}

/**
 * Per-mode member/fixture treatment (user round 2026-08-20 — the OFF /
 * X-RAY / BASEMENT tri-state):
 *
 *  - 'off' — the FINISHED house. NO members at all: framing, wires, pipes,
 *    ducts and foundation live inside walls/floors and a finished home
 *    shows none of them (the host's own skins are the walls — also kills
 *    the old drywall-face z-fight). Only the finished-SURFACE fixtures
 *    render: outlet/switch plates, lights, smoke alarms, the panel face…
 *    (SURFACE_FIXTURE_KINDS), so the level still reads like a real home.
 *  - 'xray' — the engineering X-ray: assembly layers + the dollhouse cut as
 *    before, but the BELOW-FLOOR stratum (isBelowFloor) is depth-tested
 *    only — the old foundation/buried-DWV overlay ghosts are GONE, so the
 *    crawl space no longer reads through the floor ("I shouldn't be able
 *    to see it at all"); it is still visible via real sightlines from
 *    outside/under. This retires the 2026-08-16 'crawl-space at a glance'
 *    ghosts in favor of the dedicated basement mode.
 *  - 'basement' — under the house: below-floor members render fully (solid
 *    scene copy) PLUS an overlay copy so foundation/drainage read through
 *    the floor and the shell from any angle; everything above the floor
 *    collapses to a barely-visible transparent shell (FAINT_OPACITY) for
 *    orientation only. No dollhouse cull (the shell is already faint).
 *    Within the stratum (browser QA round 3: the DWV network must read
 *    THROUGH the slab, not just at its edges): slab/vapor plane FIELDS get
 *    the translucent depth-silent 'ghosted-field' veil, buried MEP runs +
 *    fixtures get 'ghosted-through' (drawn after the field), structure
 *    keeps the strong 'ghosted' copy.
 */
export function buildGroup(members: Member[], fixtures: Fixture[], mode: ViewMode): Group {
  const buckets = new Map<string, Bucket>()
  const push = (
    key: string,
    color: string,
    dims: readonly [number, number, number],
    position: readonly [number, number, number],
    rotation: readonly [number, number, number],
    face: readonly [number, number] | undefined,
    treatment: BucketTreatment,
    sourceId?: string,
  ) => {
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { color, entries: [], face, treatment, sourceId }
      buckets.set(key, bucket)
    }
    bucket.entries.push({ dims, position, rotation })
  }

  if (mode !== 'off') {
    for (const member of members) {
      const color = colorOf(member)
      if (mode === 'basement') {
        // Stratum split: below-floor is the star (solid + overlay ghost),
        // the house above fades to the faint orientation shell. Within the
        // stratum the slab/vapor FIELDS turn into a translucent veil and
        // the buried MEP network draws through them (QA round 3).
        if (isBelowFloor(member)) {
          const field = member.role === 'slab' || member.role === 'vapor-retarder'
          const run =
            member.system === 'plumbing' ||
            member.system === 'hvac' ||
            member.system === 'electrical'
          const treatment: BucketTreatment = field
            ? 'ghosted-field'
            : run
              ? 'ghosted-through'
              : 'ghosted'
          push(`${color}|${treatment}`, color, member.dims, member.position, member.rotation, undefined, treatment)
        } else {
          push(`${color}|faint`, color, member.dims, member.position, member.rotation, undefined, 'faint')
        }
        continue
      }
      // mode === 'xray'
      if (member.face) {
        // Assembly layers: bucket PER FACE NORMAL (quantized) AND per source
        // wall, so the dollhouse cut can hide camera-facing stacks as whole
        // meshes while the SELECTED wall's stacks stay visible (night-4:
        // picking a cladding was invisible from every straight-on view).
        const key = `${color}|${member.face[0].toFixed(2)},${member.face[1].toFixed(2)}|${member.sourceId}`
        push(key, color, member.dims, member.position, member.rotation, member.face, 'solid', member.sourceId)
        continue
      }
      // Everything — below-floor included — is depth-tested only: wall/roof/
      // MEP members read through the OPENED near faces of the dollhouse cut
      // (ghosting them made every wall look transparent, round-13), and the
      // under-floor stratum stays hidden behind real geometry by design.
      push(`${color}|solid`, color, member.dims, member.position, member.rotation, undefined, 'solid')
    }
  }
  for (const fixture of fixtures) {
    // Finished house: only the surface devices; basement: stratum-split
    // like members (advisory 2026-08-21 — a buried cleanout riser joins the
    // ghosted star content instead of fading into the shell); X-ray: solid.
    if (mode === 'off' && !SURFACE_FIXTURE_KINDS.has(fixture.kind)) continue
    const { dims, color } = fixtureBox(fixture)
    const below = fixture.position[1] + dims[1] / 2 < BURIED_TOP_Y
    // A buried fixture rides the RUN treatment (a cleanout riser belongs to
    // the drainage network it serves — it must read through the slab too).
    const treatment: BucketTreatment =
      mode === 'basement' ? (below ? 'ghosted-through' : 'faint') : 'solid'
    push(`${color}|fixture|${treatment}`, color, dims, fixture.position, [0, fixture.rotationY, 0], undefined, treatment)
  }

  const group = new Group()
  const unitBox = new BoxGeometry(1, 1, 1)
  const matrix = new Matrix4()
  const quaternion = new Quaternion()
  const scale = new Vector3()
  const translation = new Vector3()
  const euler = new Euler()

  // 'ghosted' buckets (basement mode's below-floor stratum) = TWO passes
  // (round-11 regression: overlay-only members painted over a TREE standing
  // in front of the house — the host's overlay pass composites over the
  // finished scene with no scene-depth test).
  //
  //  - A SOLID copy on the SCENE layer (0): normal depth against the whole
  //    scene, so anything nearer the camera — a tree, a neighboring house —
  //    occludes it exactly like real geometry. Under the floor it is
  //    hidden, which is fine: that is what the ghost is for.
  //  - A GHOST copy on the host OVERLAY layer (1): the editor's
  //    post-processing pipeline (packages/viewer post-processing.tsx)
  //    renders that layer into its own freshly cleared depth buffer and
  //    composites it on top by alpha. The ghost therefore shows THROUGH
  //    floors/walls/occluders (near member still hides far member — the
  //    round-2 requirement). Basement mode runs structure + buried runs
  //    STRONG (0.9) and the slab/vapor fields as a depth-silent 0.5 veil
  //    the runs draw through: the under-floor content is the star.
  //
  // Every in-scene depth trick failed on this pipeline and is pinned in
  // tests: renderer.clearDepth() poisoned the WebGPU pass; an inverted
  // depth-wipe box never landed its depthWrite; transparent-list membership
  // lost to the host's MRT scene pass on camera change.
  //
  // Degraded-but-visible fallback: when post-processing is off (WebGL2
  // fallback, ?disable=postFx) the camera mask still includes layer 1, so
  // both copies render in the main pass with shared depth — no see-through,
  // but nothing disappears.
  const OVERLAY_LAYER = 1

  for (const bucket of buckets.values()) {
    // Normal depth-tested draws, so members occlude each other correctly —
    // the round-2 user-reported artifacts (footing over nearer studs, far
    // stud tops reading through the top plate) came from bypassing the
    // depth test. 'faint' buckets (basement's above-floor shell) skip the
    // depth WRITE so the barely-visible shell never occludes the solid
    // below-floor content behind it.
    const faint = bucket.treatment === 'faint'
    const solid = new InstancedMesh(
      unitBox,
      new MeshStandardMaterial({
        color: bucket.color,
        roughness: 0.82,
        ...(faint ? { transparent: true, opacity: FAINT_OPACITY, depthWrite: false } : {}),
      }),
      bucket.entries.length,
    )
    if (bucket.face) solid.userData.face = bucket.face
    if (bucket.sourceId) solid.userData.sourceId = bucket.sourceId
    const meshes = [solid]
    if (
      bucket.treatment === 'ghosted' ||
      bucket.treatment === 'ghosted-field' ||
      bucket.treatment === 'ghosted-through'
    ) {
      const field = bucket.treatment === 'ghosted-field'
      const ghostMaterial = new MeshStandardMaterial({
        color: bucket.color,
        roughness: 0.82,
        transparent: true,
        // The slab/vapor veil stays clearly concrete but translucent; the
        // structure and the buried network keep the strong copy.
        opacity: field ? SLAB_FIELD_OPACITY : BELOW_GHOST_OPACITY,
      })
      // Self-occlusion inside the overlay pass needs the depth write that
      // transparent materials normally skip — EXCEPT the plane fields: a
      // depth-writing slab hid the whole under-slab drainage run in the
      // overlay pass (QA round 3, 51-basement-34-sw.png — pipes only
      // peeked out at the edges). The field writes no depth; the runs
      // draw after it (renderOrder) and composite through.
      ghostMaterial.depthWrite = !field
      const ghost = new InstancedMesh(unitBox, ghostMaterial, bucket.entries.length)
      ghost.layers.set(OVERLAY_LAYER)
      if (bucket.treatment === 'ghosted-through') ghost.renderOrder = THROUGH_RENDER_ORDER
      meshes.push(ghost)
    }
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
      for (const mesh of meshes) mesh.setMatrixAt(i, matrix)
    })
    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = mesh === solid && !faint
      mesh.receiveShadow = mesh === solid && !faint
      mesh.frustumCulled = false
      // The X-ray is a pure VISUAL: framing meshes must never intercept
      // the host's event raycast. R3F recurses through the level wrapper
      // groups, so without this every bucket (even invisible culled ones)
      // landed in event.intersections at the wall's own depth and starved
      // the hidden-wall selection gate — hovering a stud highlighted the
      // furniture behind the wall (F2 QA round). Devices stay clickable:
      // outlets are separate bones:device HOST nodes, not these meshes.
      mesh.raycast = () => {}
      group.add(mesh)
    }
  }
  return group
}

/** Exploded-view stratum for a foreign roof group (day board A): drop the
 * bones roof HALF an exploded slot below the roof shell so floor / trusses /
 * shingle shell read as three ~equal strata — but ONLY for groups whose
 * source level sits strictly ABOVE the owner's storey — or the owner sits ON
 * a true attic level (render-only mountLevelId) — (`strataAbove`, tagged
 * by compute): a ground-storey porch roof foreign to an upper owner drops
 * INTO the storey below it otherwise (verify round 2026-08-16, F1). Intended
 * limitation (checklist A3): an owner ON the roof level frames that roof as
 * own-level members — no foreign group, no stratum in exploded view.
 * DRIFT PIN: half a slot = EXPLODED_GAP / 2; the host constant lives at
 * editor packages/viewer/src/systems/level/level-system.tsx
 * (`const EXPLODED_GAP = 5`) — if that value moves, this one follows.
 * Foreign groups are level-LOCAL — the offset composes with the host's own
 * level lerp in every mode. `undefined` levelMode (viewer store not
 * resolved yet) reads as stacked. */
export function explodedRoofOffset(
  levelMode: string | undefined,
  strataAbove: boolean,
): number {
  return levelMode === 'exploded' && strataAbove ? -2.5 : 0
}

function disposeGroup(group: Group) {
  // All meshes share one unit-box geometry — dispose each UNIQUE geometry
  // exactly once.
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
  const viewDir = useRef(new Vector3())
  // Cached useViewer store handle (resolved by the dynamic import below) —
  // useFrame can't await, so attachForeign reads levelMode through this ref;
  // null until the import lands = treat as stacked.
  const viewerStore = useRef<{
    getState: () => { levelMode?: string; selection?: { selectedIds?: readonly string[] } }
  } | null>(null)
  useRegistry(node.id, node.type, ref)

  // Any scene edit re-derives the skeleton — that's the contract (never stale).
  const nodes = useScene((s) => s.nodes)
  const result = useMemo(
    () => computeLevel(nodes as Record<string, Record<string, unknown>>, node),
    [nodes, node],
  )

  // LIVE-DRAG reactivity (night-6, user report: framing froze while a door
  // slid): the host's move/placement tools ride transient node overrides
  // and only commit on drop — fold them in and recompute at ~10Hz so
  // kings/trimmers/headers/wires FOLLOW the gesture. Falls back to the
  // memoized committed result the instant the overrides clear.
  const [liveResult, setLiveResult] = useState<ReturnType<typeof computeLevel> | null>(null)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  useEffect(() => {
    let disposed = false
    const recompute = () => {
      if (disposed) return
      const overrides = useLiveNodeOverrides.getState().overrides
      const effective = effectiveNodesFor(
        nodesRef.current as Record<string, Record<string, unknown>>,
        overrides,
      )
      setLiveResult(effective ? computeLevel(effective, node) : null)
    }
    const throttled = throttleTrailing(recompute, 100)
    const unsub = useLiveNodeOverrides.subscribe(() => throttled.run())
    return () => {
      disposed = true
      throttled.cancel()
      unsub()
    }
  }, [node])
  // A committed write (drop, or any config edit mid-drag) invalidates the
  // live snapshot IMMEDIATELY — waiting for the trailing null left `active`
  // one edit behind the store at the commit render (verify night-6).
  useEffect(() => {
    setLiveResult(null)
  }, [nodes, node])
  const active = liveResult ?? result

  // Movable outlets (Q7): mirror every derived wall device into a
  // `bones:device` node so ANY receptacle/switch is hoverable and draggable —
  // create missing nodes at the derived spots, normalize drag-committed
  // positions into wall anchors, re-seat unmoved ones when the derivation
  // drifts, drop orphans; nodes the user moved are never re-seated
  // (device/place.ts). The same batch normalizes drag-committed
  // `bones:service` positions (service/normalize.ts) — the parentFrame drags
  // carry NO onCommit (night-5 D2/D3: the host onCommit branch's wall patch
  // woke the space-detection sync mid-commit), so the anchor conversion for
  // both kinds lives here. Derived maintenance, not a user edit: history
  // pauses around the batch so reconcile writes never pollute undo, and the
  // whole plan lands in ONE applyNodeChanges. Converges in one pass (the
  // re-run on the resulting nodes change plans zero ops). Bails in read-only
  // hosts (community viewer) — no scene writes on view, like cladding-paint.
  useEffect(() => {
    if (node.visible === false) return
    const levelId = node.parentId
    if (!levelId) return
    const state = useScene.getState() as unknown as {
      readOnly?: boolean
      nodes: Record<string, Record<string, unknown>>
      applyNodeChanges: (changes: {
        create?: { node: unknown; parentId?: unknown }[]
        update?: { id: unknown; data: Record<string, unknown> }[]
        delete?: unknown[]
      }) => void
    }
    if (state.readOnly) return
    // Plan against the FRESH store state, not this render's snapshot: with
    // two X-rays on one level, the second effect would otherwise re-plan
    // the first one's creates from a stale snapshot and mint duplicates
    // (the dedupe would heal it, but with churn).
    //
    // Service anchor normalization runs regardless of the outlets flag —
    // service points ship enabled and their drags need the same one-entry
    // commit. Device reconciliation rides the movableOutlets flag (default
    // ON since night-5; the per-node opt-out stays available). ABSENT ≠ off:
    // stored scenes predating the flag never re-parse through the schema on
    // load, so the node object simply lacks the key — only an explicit
    // `false` (inspector toggle / MCP) disables (night-5 final round: a
    // `=== true` guard left a default-path scene with ZERO device nodes).
    const serviceUpdates = normalizeServiceAnchors(state.nodes, levelId)
    const devicesOn = node.movableOutlets !== false && node.showElectrical !== false
    const plan = devicesOn
      ? reconcileDeviceNodes(state.nodes, levelId, result.devices)
      : { create: [], update: [], remove: [] }
    // Service auto-heal (user round 2026-08-20: automatic service points,
    // no button): a pre-automation scene — framing node without the
    // `servicesSeeded` latch — seeds ONCE on the next render, right here in
    // the derived-maintenance batch (history-paused, like device seeding:
    // undo never replays it). The latch (written in the SAME batch) plus
    // the adopt-existing rule in planServiceSeeding guarantee a service
    // point the user deletes is never resurrected. Read the FRESH framing
    // node — a paused-batch latch write doesn't bump this effect's deps in
    // every host, and a stale prop must not double-seed.
    const freshFraming =
      (state.nodes[node.id as string] as { id: string; servicesSeeded?: unknown } | undefined) ??
      (node as { id: string; servicesSeeded?: unknown })
    const seeding = planServiceSeeding(state.nodes, levelId, freshFraming)
    const create = [...plan.create, ...seeding.create] as unknown[]
    const update = [...plan.update, ...serviceUpdates, ...seeding.update]
    if (create.length + update.length + plan.remove.length === 0) return
    pauseSceneHistory(useScene)
    try {
      state.applyNodeChanges({
        create: create.map((n) => ({ node: n, parentId: levelId })),
        update: update.map((u) => ({ id: u.id, data: u.data })),
        delete: plan.remove,
      })
    } finally {
      resumeSceneHistory(useScene)
    }
  }, [nodes, node, result])

  // OFF / X-RAY / BASEMENT — one field drives every treatment below
  // (legacy seeThrough nodes resolve through effectiveViewMode).
  const mode = effectiveViewMode(node)
  const built = useMemo(
    () => buildGroups(active.members, active.fixtures, mode),
    // `active` (NOT `result`): during a drag only the override store moves,
    // so a committed-only dep froze the scene graph — the whole feature was
    // visually inert (verify night-6 blocker).
    [active, mode],
  )
  const group = built.group
  useEffect(() => {
    return () => {
      disposeGroup(built.group)
      for (const g of built.foreign.values()) {
        g.parent?.remove(g)
        disposeGroup(g)
      }
    }
  }, [built])

  // Cross-level members (the roof on its own storey) mount into THEIR
  // level's Object3D so the host's stacked/exploded/solo level transforms
  // and visibility apply natively — a baked storey offset was only right
  // in stacked view (prod 2026-08-15 round 3). The level object may
  // register after us, so (re)attach lazily in the frame loop below.
  const attachForeign = () => {
    // Exploded stratum: in exploded level mode a foreign roof group ABOVE
    // the owner drops half a slot below the roof shell (floor / trusses /
    // shell = three strata). Below-owner groups (a ground-storey porch
    // roof), any other mode, or the viewer store not resolved yet: flush.
    const levelMode = viewerStore.current?.getState().levelMode
    for (const [levelId, g] of built.foreign) {
      const levelObj = sceneRegistry.nodes.get(levelId as Parameters<typeof sceneRegistry.nodes.get>[0])
      if (levelObj && g.parent !== levelObj) levelObj.add(g)
      g.position.y = explodedRoofOffset(levelMode, g.userData.strataAbove === true)
      // Imperative children don't unmount with the JSX — mirror the node's
      // visibility by hand (hiding the X-ray must hide the foreign roofs).
      g.visible = node.visible !== false
    }
  }

  // Wall-mode note: the auto-switch to 'down' (Low) used to live HERE as
  // mount-time magic with a restore-on-unmount — unreliable by construction
  // (it rode the renderer lifecycle behind two async hops, a second X-rayed
  // level recorded nothing so removing the first snapped walls back to
  // full/cutaway under a live X-ray, and remounts re-imposed 'down' over a
  // manual choice). It now lives in src/activation.ts, scoped to the actual
  // user actions: activate → 'down' once; viewMode off / panel Remove →
  // restore; everything in between is the user's. This effect only caches
  // the viewer store HANDLE for the frame loop (exploded roof stratum) —
  // dynamic import because the viewer package drags browser-only deps that
  // must never evaluate under bun test (it only runs in the host).
  useEffect(() => {
    import('@pascal-app/viewer').then(({ useViewer }) => {
      viewerStore.current = useViewer as unknown as {
        getState: () => { levelMode?: string }
      }
    })
  }, [])

  // Dollhouse cut (round 13): assembly-layer buckets carry their face
  // normal — hide the stacks whose face points TOWARD the camera so you
  // look INTO the cavity and see the far side's drywall as the backdrop.
  // The wall is never transparent; the near face is simply removed.
  useFrame(({ camera }) => {
    attachForeign()
    // The dollhouse cut is an X-ray affordance: 'off' has no face buckets
    // at all, 'basement' keeps its faint shell intact from every angle.
    if (mode !== 'xray') return
    const dir = camera.getWorldDirection(viewDir.current)
    // The SELECTED wall is exempt from the cut: the user is inspecting it
    // (Engineering card flow), so its full stack — cladding included —
    // must read from any angle. Everything else keeps the dollhouse cut.
    // Selections resolve through the colinear-dedupe map: members carry
    // the KEPT twin's sourceId, so selecting a dropped duplicate must
    // exempt its twin (verify night-4 F5).
    const selectedRaw = viewerStore.current?.getState().selection?.selectedIds
    const selected = selectedRaw?.map((id) => active.duplicateOf[id] ?? id)
    const cullChildren = (children: readonly { userData: unknown; visible: boolean }[]) => {
      for (const child of children) {
        const face = (child.userData as { face?: readonly [number, number] }).face
        if (!face) continue
        const sourceId = (child.userData as { sourceId?: string }).sourceId
        if (sourceId && selected && selected.includes(sourceId)) {
          child.visible = true
          continue
        }
        // face normal · view direction > 0 → face points away → keep it
        child.visible = face[0] * dir.x + face[1] * dir.z > 0.02
      }
    }
    cullChildren(group.children)
    // Foreign groups (cross-level roofs, gable-wall layers) carry face
    // buckets too — they were never culled NOR exemption-checked, leaving
    // gable finishes permanently opaque from every angle (night-5 queue).
    for (const [, g] of built.foreign) cullChildren(g.children)
  })

  if (!node.visible) return null
  return (
    <group ref={ref}>
      <primitive object={group} />
    </group>
  )
}

export default FramingRenderer
