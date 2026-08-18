import { BaseNode, nodeType, objectId } from '@pascal-app/core'
import { z } from 'zod'

/**
 * The `bones:framing` config node — the ONLY thing Bones persists for
 * inference. One per level ("X-Ray" creates it; removing it clears the view).
 * Members are derived from the level's walls/slabs/roofs at render time and
 * never stored, so the skeleton can't drift out of sync with the model.
 */

export const WallConstruction = z.enum(['framed', 'cmu', 'skip'])
export type WallConstruction = z.infer<typeof WallConstruction>

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
  showElectrical: z.boolean().default(false),
  showPlumbing: z.boolean().default(false),
  showHvac: z.boolean().default(false),
  /** Movable outlets (Q7) — EXPERIMENTAL, default OFF: the bones:device
   * reconciler seeds draggable nodes for every derived receptacle/switch.
   * Ships dormant until the live drag-commit/undo host-integration defects
   * are closed (night-4 batch visual round D2/D3/D4). */
  movableOutlets: z.boolean().default(false),
  /** Fade the architectural shell: 0 = skeleton only (future host affordance). */
  xray: z.number().min(0).max(1).default(1),
  /** X-ray vision: draw the skeleton through walls/finishes (depth-test off). */
  seeThrough: z.boolean().default(true),
  /** Per-wall construction overrides, keyed by wall id. */
  wallOverrides: z.record(z.string(), WallOverride).default({}),
}).describe(
  `Bones framing config (engineering X-ray) — one per level.
  - jurisdiction: US state code ('CA'), 'INTL', or 'AUTO' (guessed from the browser locale/timezone)
  - detail: '200' generic members, '300' jurisdiction/code-sized, '400' fabrication (connections, routing, fastener data)
  - studSpacingIn: stud spacing on-center in inches (16 or 24)
  - show*: per-system visibility (walls, floor, roof, foundation, electrical, plumbing, hvac)
  - wallOverrides: per-wall construction override — 'framed' (lumber), 'cmu' (concrete block), 'skip', or the object form { construction, cmuHeightM?, studSize?, spacingIn?, insulation?, insulationR?, cladding? }: cmuHeightM makes a mixed wall (CMU up to a course-snapped height, framed above); studSize ('2x4'|'2x6') + spacingIn (16|24) re-size the framing; insulation ('none'|'batt'|'blown'|'spray-foam') + insulationR fill the stud bays with labeled batts; cladding picks the exterior finish (vinyl|fiberCement|stucco|brickVeneer|wood|eifs)
  All framing members are derived live from the level's walls/openings/slabs/roofs; deleting this node removes the X-ray without touching the model.`,
)

export type FramingNode = z.infer<typeof FramingNode>
