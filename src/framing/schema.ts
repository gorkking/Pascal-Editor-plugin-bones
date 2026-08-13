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

/** BIM-ish level of detail: 200 = generic members, 300 = code-sized + jurisdiction. */
export const BonesDetail = z.enum(['200', '300'])

export const FramingNode = BaseNode.extend({
  id: objectId('bonesframing'),
  type: nodeType('bones:framing'),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotation: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  /** Jurisdiction code: 2-letter US state, 'INTL', or 'AUTO' (guess from browser). */
  jurisdiction: z.string().default('AUTO'),
  /** Level of detail (see SPEC.md → LOD ladder). */
  detail: BonesDetail.default('300'),
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
  /** Fade the architectural shell: 0 = skeleton only (future host affordance). */
  xray: z.number().min(0).max(1).default(1),
  /** X-ray vision: draw the skeleton through walls/finishes (depth-test off). */
  seeThrough: z.boolean().default(true),
  /** Per-wall construction overrides, keyed by wall id. */
  wallOverrides: z.record(z.string(), WallConstruction).default({}),
}).describe(
  `Bones framing config (engineering X-ray) — one per level.
  - jurisdiction: US state code ('CA'), 'INTL', or 'AUTO' (guessed from the browser locale/timezone)
  - detail: '200' generic members, '300' jurisdiction/code-sized members
  - studSpacingIn: stud spacing on-center in inches (16 or 24)
  - show*: per-system visibility (walls, floor, roof, foundation, electrical, plumbing, hvac)
  - wallOverrides: per-wall construction override — 'framed' (lumber), 'cmu' (concrete block), 'skip'
  All framing members are derived live from the level's walls/openings/slabs/roofs; deleting this node removes the X-ray without touching the model.`,
)

export type FramingNode = z.infer<typeof FramingNode>
