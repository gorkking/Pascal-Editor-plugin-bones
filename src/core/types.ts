/**
 * The shared vocabulary of every Bones inference engine.
 *
 * Engines are PURE functions: `(model slice, spec) → Member[] | Fixture[]`.
 * No React, no Three.js, no store access — testable with plain objects.
 * Renderers turn Members into instanced meshes; nothing here is persisted.
 */

import type { LumberSize } from '../lumber'

/** Which subsystem produced a member/fixture — drives visibility + color. */
export type BonesSystem =
  | 'wall-framing'
  | 'floor-framing'
  | 'roof-framing'
  | 'foundation'
  | 'electrical'
  | 'plumbing'
  | 'hvac'

/** Structural role of a framing member — drives takeoff grouping + hover labels. */
export type MemberRole =
  // wall framing
  | 'bottom-plate'
  | 'top-plate'
  | 'cap-plate'
  | 'stud'
  | 'king-stud'
  | 'trimmer'
  | 'header'
  | 'sill'
  | 'cripple'
  | 'blocking'
  // floor framing
  | 'joist'
  | 'rim-joist'
  | 'girder'
  | 'post'
  // roof framing
  | 'rafter'
  | 'ridge'
  | 'hip'
  | 'valley'
  | 'ceiling-joist'
  | 'collar-tie'
  // foundation
  | 'mudsill'
  | 'stemwall'
  | 'footing'
  | 'slab-edge'
  | 'anchor-bolt'
  | 'hold-down'
  // cmu
  | 'block'
  | 'lintel'
  | 'bond-beam'
  // mep runs
  | 'pipe-run'
  | 'vent-stack'
  | 'duct-run'
  | 'wire-run'
  // fabrication (LOD 350/400)
  | 'rebar'
  | 'hanger'
  | 'plate-washer'
  | 'jack-rafter'
  | 'outlooker'
  | 'fascia'
  | 'fire-blocking'
  | 'backing'
  // wall assembly layers (round 13)
  | 'drywall'
  | 'sheathing'
  | 'wrb'
  | 'cladding'
  | 'insulation'

export type MemberMaterial =
  | 'lumber'
  | 'pt-lumber'
  | 'engineered'
  | 'concrete'
  | 'steel'
  | 'pvc'
  | 'copper'
  | 'duct'

/**
 * One physical piece the engines generated, in LEVEL-LOCAL coordinates.
 * Geometry is a box of size `dims` (member-local XYZ, meters) centered at
 * `position`, rotated by `rotation` (XYZ euler, radians). `length` is the
 * lumber cut length for takeoffs (usually the largest dim). `sourceId` ties
 * the member back to the wall/slab/roof/opening that produced it (hover →
 * highlight, takeoff by source, incremental recompute).
 */
export type Member = {
  system: BonesSystem
  role: MemberRole
  /** Nominal lumber size when applicable — keyed for takeoff. */
  size?: LumberSize
  /** Box size in the member's local frame, meters. */
  dims: readonly [number, number, number]
  /** Cut length for takeoff, meters. */
  length: number
  position: readonly [number, number, number]
  rotation: readonly [number, number, number]
  material: MemberMaterial
  sourceId: string
  /** Optional human label ("Header 4x8 over D101"). */
  label?: string
  /** Set when the prescriptive tables run out (engineered beam required). */
  flag?: string
  /** Level whose transform this member follows when it belongs to ANOTHER
   * storey than its X-ray node (cross-level roofs). Position is LOCAL to
   * that level; the renderer mounts these into the level's own Object3D so
   * the host's stacked/exploded/solo moves apply natively. Unset = the
   * node's own level. */
  levelId?: string
  /**
   * Informational note that is NOT a problem (e.g. "sized schematically —
   * verify with span/load design"). Kept apart from `flag` so advisory
   * text never masks real validation errors (round-10: girders born with a
   * schematic-sizing flag made the end-bearing check dead code).
   */
  advisory?: string
  /**
   * Masonry unit whose cell is grouted solid (vertical rebar, R606.12).
   * Dedicated field so the grout takeoff never keys off label strings.
   */
  grouted?: boolean
  /**
   * Outward plan normal of the wall FACE a finish layer belongs to —
   * drives the dollhouse cut (camera-facing layers hide). Only assembly
   * layers carry it.
   */
  face?: readonly [number, number]
}

/** Electrical / plumbing / HVAC device the engines placed. */
export type FixtureKind =
  | 'receptacle'
  | 'receptacle-gfci'
  | 'switch'
  | 'light'
  | 'smoke-alarm'
  | 'panel'
  | 'stub-out'
  | 'vent-stack'
  | 'register'
  | 'return'
  | 'equipment'
  | 'water-heater'
  | 'cleanout'
  | 'thermostat'
  | 'exhaust-fan'

export type Fixture = {
  system: BonesSystem
  kind: FixtureKind
  /** Level-local position of the fixture center. */
  position: readonly [number, number, number]
  /** Y rotation so the device faces out of its wall. */
  rotationY: number
  sourceId: string
  label?: string
  meta?: Record<string, string | number | boolean>
}

/** A door/window opening extracted from a wall's children, wall-local. */
export type OpeningSlice = {
  id: string
  kind: 'door' | 'window'
  /** Center distance along the wall from `start`, meters. */
  u: number
  width: number
  height: number
  /** Bottom of the opening above the floor (0 for doors). */
  sillHeight: number
  /** Rough opening — width the framing must clear. */
  roughWidth: number
  roughHeight: number
}

/**
 * Everything the engines need to know about one wall, extracted once from the
 * scene (see `wall-model.ts`) so engines never touch the store.
 */
export type WallSlice = {
  id: string
  start: readonly [number, number]
  end: readonly [number, number]
  length: number
  /** Unit direction start→end. */
  dir: readonly [number, number]
  thickness: number
  height: number
  /** True when either face is marked exterior (or unknown-but-boundary). */
  exterior: boolean
  openings: OpeningSlice[]
  /** Curved walls are framed segment-wise later; v1 flags them. */
  curved: boolean
}

/** A slab outline for floor framing / foundation, level-local. */
export type SlabSlice = {
  id: string
  polygon: readonly (readonly [number, number])[]
  holes: readonly (readonly (readonly [number, number])[])[]
  elevation: number
  thickness: number
}

/** A named room (Pascal zone) — drives GFCI, wet walls, registers. */
export type RoomSlice = {
  id: string
  name: string
  /** Classified from the name: kitchen/bathroom/bedroom/garage/laundry/other. */
  category: 'kitchen' | 'bathroom' | 'bedroom' | 'garage' | 'laundry' | 'hallway' | 'other'
  polygon: readonly (readonly [number, number])[]
  boundaryWallIds: readonly string[]
  ceilingHeight: number
}

/** Bounding info for a roof segment plane set (v1 roof model). */
export type RoofSlice = {
  id: string
  type: 'hip' | 'gable' | 'shed' | 'gambrel' | 'dutch' | 'mansard' | 'flat'
  position: readonly [number, number, number]
  rotationY: number
  width: number
  depth: number
  pitch: number
  overhang: Record<string, number>
}
