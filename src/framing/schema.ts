import { BaseNode, nodeType, objectId } from '@pascal-app/core'
import { z } from 'zod'

/**
 * The `bones:framing` config node — the ONLY thing Bones persists for
 * inference. One per level ("X-Ray" creates it; removing it clears the view).
 * Members are derived from the level's walls/slabs/roofs at render time and
 * never stored, so the skeleton can't drift out of sync with the model.
 */

/**
 * Per-wall construction system. 'lgs' (light-gauge / cold-formed steel, IRC
 * R603) has its own wall engine since Phase 1 of the LGS track
 * (docs/plans/LGS-PLAN.md): an 'lgs' wall frames in STEEL —
 * C-stud/track assemblies from the cited catalog
 * (data/lgs-profiles.json via src/engines/lgs-wall-framing.ts) — while its
 * sheet-goods (sheathing/drywall/WRB/cladding/batts) book and render
 * exactly like a framed wall's (`framedAssembly` below; the F1 no-half-
 * routing contract). Nothing writes the value from the inspector yet
 * (the segmented control still offers framed/CMU/skip — Phase 2), so
 * stored scenes are byte-untouched.
 */
export const WallConstruction = z.enum(['framed', 'cmu', 'lgs', 'skip'])
export type WallConstruction = z.infer<typeof WallConstruction>

/**
 * Constructions the LUMBER framing path builds. Since LGS Phase 1 this is
 * 'framed' ONLY — 'lgs' left this set in the same commit that gave it the
 * steel engine (the Phase-0 comment's promise). Consumers that mean "wall
 * with a framed ASSEMBLY (stud cavity + sheet-goods layers)" — the
 * sheathing/drywall area sites, the layer engine routing, the card's
 * engineering block — consume `framedAssembly` instead, so the F1
 * no-half-routing contract holds for both values: an 'lgs' wall books the
 * exact areas its 'framed' twin would, on steel bones.
 *
 * KEPT with zero production call sites today (round-1 F5c, deliberate):
 * this predicate IS the F1 contract's other half — its truth table is
 * pinned by the gates as the definition of "what frameWalls builds", and
 * the Phase-2 floor/roof routing (R505/R804 split the same way walls did)
 * will consume it the day a second lumber-vs-steel fork exists. Deleting
 * it would re-mint the same function under the same name one phase later.
 */
export function framesAsLumber(construction: WallConstruction): boolean {
  return construction === 'framed'
}

/**
 * Constructions that build a FRAMED ASSEMBLY — a stud cavity wrapped in the
 * sheet-goods layer stack (sheathing/WRB/cladding outside, gypsum inside,
 * optional batts). Both lumber ('framed') and cold-formed steel ('lgs')
 * walls carry the identical assembly (the fastening differs — screws per
 * IRC R603.2.5 on steel — never the sheet areas), so the takeoff area
 * sites, the layer engine and the selection card's engineering block all
 * route through THIS predicate. CMU and skipped walls stay out.
 */
export function framedAssembly(construction: WallConstruction): boolean {
  return construction === 'framed' || construction === 'lgs'
}

/** Per-wall stud size override (framed walls) — 2x4 or 2x6 only. */
export const WallStudSize = z.enum(['2x4', '2x6'])
export type WallStudSize = z.infer<typeof WallStudSize>

/** Per-wall stud spacing override, inches on-center (R602.3 rhythm). */
export const WallSpacingIn = z.union([z.literal(16), z.literal(24)])
export type WallSpacingIn = z.infer<typeof WallSpacingIn>

/** Per-wall cavity insulation type — 'none' emits no batt geometry. */
export const WallInsulation = z.enum(['none', 'batt', 'blown', 'spray-foam'])
export type WallInsulation = z.infer<typeof WallInsulation>

/** Keys of data/wall-assemblies.json exterior.claddings. */
export const WallCladding = z.enum([
  'vinyl',
  'fiberCement',
  'stucco',
  'brickVeneer',
  'wood',
  'eifs',
])
export type WallCladding = z.infer<typeof WallCladding>

/**
 * Object form of a per-wall override — the wall's full engineering identity:
 * - mixed CMU/framed construction: block coursing up to `cmuHeightM`
 *   (snapped to whole 8" courses by the engines, IRC R606 module), a bond
 *   beam + PT sill seam, stud framing above. Absent height (or one at/above
 *   the wall height) = full-height CMU, exactly like the plain 'cmu' string.
 *   `cmuHeightM` is rejected on non-CMU construction.
 * - framed engineering: `studSize`/`spacingIn` re-size the stud recipe,
 *   `insulation`/`insulationR` fill the stud bays with labeled batts
 *   (default R = the climate zone's prescriptive minimum), `cladding` picks
 *   the exterior finish family. Absent fields keep the state-code defaults —
 *   an object carrying only `construction` behaves exactly like the string.
 */
export const WallEngineeringOverride = z
  .object({
    construction: WallConstruction,
    /** Requested CMU-zone height in meters — course-snapped by the engines. */
    cmuHeightM: z.number().positive().optional(),
    studSize: WallStudSize.optional(),
    spacingIn: WallSpacingIn.optional(),
    insulation: WallInsulation.optional(),
    /** Cavity R-value; default = the climate zone's prescriptive minimum. */
    insulationR: z.number().positive().optional(),
    cladding: WallCladding.optional(),
  })
  .refine((o) => o.construction === 'cmu' || o.cmuHeightM === undefined, {
    message: 'cmuHeightM applies to CMU construction only',
  })
export type WallEngineeringOverride = z.infer<typeof WallEngineeringOverride>

/**
 * One wall's construction override: the legacy strings persist untouched
 * (back-compat), the object form adds the mixed CMU/framed split and the
 * per-wall engineering fields (studs, insulation, cladding).
 */
export const WallOverride = z.union([WallConstruction, WallEngineeringOverride])
export type WallOverride = z.infer<typeof WallOverride>

/** BIM-ish level of detail: 200 generic members · 300 code-sized (jurisdiction) ·
 * 400 fabrication (connections, routing, cut/fastener data). */
export const BonesDetail = z.enum(['200', '300', '400'])

/**
 * The X-ray's view mode — ONE field so the three states are structurally
 * exclusive (user round 2026-08-20):
 * - 'off'      — the FINISHED house: host walls closed and normal, only the
 *                finished-surface fixtures (outlets, switches, lights…) show.
 * - 'xray'     — the engineering X-ray (default at creation): assembly layers
 *                + dollhouse cut, host walls low; BELOW-FLOOR members render
 *                depth-tested only (real sightlines — never through floors).
 * - 'basement' — the under-the-house view: foundation, drainage and buried
 *                pipes read through everything; the house above fades to a
 *                barely-visible orientation shell.
 */
export const ViewMode = z.enum(['off', 'xray', 'basement'])
export type ViewMode = z.infer<typeof ViewMode>

/**
 * Resolve a framing node's view mode, tolerating legacy nodes: stored scenes
 * never re-parse through the schema on load, so pre-viewMode nodes carry only
 * the old `seeThrough` boolean (false = the old "solid" mode → 'off';
 * anything else → 'xray', the historical default).
 */
export function effectiveViewMode(node: {
  viewMode?: unknown
  seeThrough?: unknown
}): ViewMode {
  const v = node.viewMode
  if (v === 'off' || v === 'xray' || v === 'basement') return v
  return node.seeThrough === false ? 'off' : 'xray'
}

export const FramingNode = BaseNode.extend({
  id: objectId('bonesframing'),
  type: nodeType('bones:framing'),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  /** Jurisdiction code: 2-letter US state, 'INTL', or 'AUTO' (guess from browser). */
  jurisdiction: z.string().default('AUTO'),
  /** Level of detail (see SPEC.md → LOD ladder). */
  detail: BonesDetail.default('400'),
  studSpacingIn: z.union([z.literal(16), z.literal(24)]).default(16),
  // Per-system visibility. Top-level booleans so the stock inspector can
  // render them without custom UI.
  showWalls: z.boolean().default(true),
  showFloor: z.boolean().default(true),
  showRoof: z.boolean().default(true),
  showFoundation: z.boolean().default(true),
  // MEP defaults ON (user round 2026-08-20: "electrical, plumbing, and HVAC
  // should also be on by default when we X-ray a house"). Legacy nodes
  // (absent keys) keep their old behavior — stored scenes never re-parse.
  showElectrical: z.boolean().default(true),
  showPlumbing: z.boolean().default(true),
  showHvac: z.boolean().default(true),
  /** Movable outlets (Q7) — default ON since night-5: the bones:device
   * reconciler seeds draggable nodes for every derived receptacle/switch.
   * The night-4 live-drag defects are closed: D2/D3 (commit count drift +
   * broken undo) died with the no-onCommit drag frames + reconcile-batch
   * anchor normalization (device/frame.ts, device/place.ts); D4 (dead/
   * misrouted place-click through hidden walls) is fixed host-side on
   * editor branch fix/outlets-hidden-wall-clicks — ship this default
   * alongside that PR. */
  movableOutlets: z.boolean().default(true),
  /** Fade the architectural shell: 0 = skeleton only (future host affordance). */
  xray: z.number().min(0).max(1).default(1),
  /** DEPRECATED (pre-viewMode X-ray vision boolean) — still parsed so legacy
   * nodes round-trip; new code reads `effectiveViewMode` instead. */
  seeThrough: z.boolean().default(true),
  /** View mode: 'off' finished house / 'xray' engineering X-ray (default) /
   * 'basement' under-the-house view. See `ViewMode`. */
  viewMode: ViewMode.default('xray'),
  /** One-shot service-point seeding latch: set when the level's
   * `bones:service` points were auto-created (activation click or the
   * renderer's auto-heal for pre-existing scenes). Once true they are NEVER
   * auto-created again — deleting a service point is a respected user
   * choice, not something the reconciler fights. */
  servicesSeeded: z.boolean().default(false),
  /** Per-wall construction overrides, keyed by wall id. */
  wallOverrides: z.record(z.string(), WallOverride).default({}),
  /**
   * Framing system for the level: 'lumber' (default) or 'lgs' (cold-formed
   * steel, IRC R603 walls — Phase 1; floors/roofs follow in Phase 2).
   * OPTIONAL with NO zod default — absent means 'lumber' and, critically,
   * an absent field round-trips ABSENT (byte-parity for every stored
   * scene; a `.default('lumber')` would inject the key on parse). 'lgs'
   * makes it the DEFAULT construction for otherwise-framed walls
   * (`resolveWallConstruction`); explicit per-wall overrides — 'framed',
   * 'cmu', 'skip' — still win, as does a jurisdiction CMU exterior default
   * (FL).
   */
  framingSystem: z.enum(['lumber', 'lgs']).optional(),
  /**
   * Roll-forming machine key ('vendor/machine', keys of
   * data/lgs-profiles.json) constraining LGS profiles to the machine's
   * rollable set. Meaningful only with framingSystem 'lgs'; optional, no
   * default (same byte-parity rule).
   */
  lgsMachine: z.string().optional(),
}).describe(
  `Bones framing config (engineering X-ray) — one per level.
  - jurisdiction: US state code ('CA'), 'INTL', or 'AUTO' (guessed from the browser locale/timezone)
  - detail: '200' generic members, '300' jurisdiction/code-sized, '400' fabrication (connections, routing, fastener data)
  - studSpacingIn: stud spacing on-center in inches (16 or 24)
  - show*: per-system visibility (walls, floor, roof, foundation, electrical, plumbing, hvac — all default on)
  - viewMode: 'off' (finished house — walls closed, only surface fixtures show) | 'xray' (engineering X-ray, default) | 'basement' (under-the-house view: foundation/buried pipes read through a faint house shell)
  - wallOverrides: per-wall construction override — 'framed' (lumber), 'cmu' (concrete block), 'lgs' (light-gauge steel: C-stud/track members per IRC R603, sheet-goods layers book exactly like a framed wall), 'skip', or the object form { construction, cmuHeightM?, studSize?, spacingIn?, insulation?, insulationR?, cladding? }: cmuHeightM makes a mixed wall (CMU up to a course-snapped height, framed above); studSize ('2x4'|'2x6') + spacingIn (16|24) re-size the framing (on 'lgs' they pick the depth-matched steel web: 2x4→350, 2x6→550); insulation ('none'|'batt'|'blown'|'spray-foam') + insulationR fill the stud bays with labeled batts; cladding picks the exterior finish (vinyl|fiberCement|stucco|brickVeneer|wood|eifs)
  - framingSystem: 'lumber' (default when absent) | 'lgs' (cold-formed steel, IRC R603 — otherwise-framed walls frame as steel C-stud/track assemblies; explicit per-wall overrides and the FL CMU exterior default still win); lgsMachine: roll-forming machine key from data/lgs-profiles.json (e.g. 'framecad/f325it') — Phase 1 resolves profiles through it and labels the honest fallback status; can't-roll warnings land with the machine UX in Phase 2
  All framing members are derived live from the level's walls/openings/slabs/roofs; deleting this node removes the X-ray without touching the model.`,
)

export type FramingNode = z.infer<typeof FramingNode>
