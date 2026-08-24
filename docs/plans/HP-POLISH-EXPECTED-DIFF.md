# HP OBJECT POLISH — expected diff (feat/hp-polish, 2026-08-23)

Julien's hands-on feedback after using the shipped heat-pump object
(verbatim): "by default it's not aligned to the grid. It's like scaled and
everything. But first of all it's red. And also it's tilted. And also it
looks like I can't rotate it like a normal object or with R. … let's make
sure it's aligned normally and grayed out normally like the object would
be." Base `1a5e627`. Anything outside the classes below is a defect.

## The four items (mechanism → where)

1. **COLOR** — `prepareCondenserClone` (src/framing/condenser-asset.ts)
   retints EVERY clone mesh to `CONDENSER_SCHEMATIC_TINT = '#8b8f96'` —
   byte-equal to the steel tone the cabinet box rendered before the asset
   swap (framing/renderer `colorOf` 'steel'), roughness 0.82 like every
   bucket material; ONE module-cached material (night-8 identity doctrine),
   geometry shared, the CACHED asset's authored materials untouched.
   DECISION (stated): neutralize to the bones equipment-gray schematic
   family, NOT the host item treatment — host investigation (read-only,
   private-editor `packages/nodes/src/item/renderer.tsx`) shows the item
   renderer displays the AUTHORED GLB materials whenever viewer `textures`
   is on (the default — i.e. it would keep the red) and only collapses to a
   themed 'furnishing' clay (`createSurfaceRoleMaterial` + colorPreset) in
   monochrome mode, a theme path a plugin cannot reach. Labels/tonnage
   surfaces untouched.

2. **TILT** — every condenser unit's ASSEMBLY (cabinet + pad + fixture →
   pick proxy) sits SQUARE to its row wall: yaw = the outward wall normal
   (`Math.atan2(out)`), back to the house. Unit #1's legacy yaw was its
   equipment-room BEARING (rotY ≈ 2.99 on off-axis scenes) against a
   wall-aligned pad. THE RULE: machine placements square to the ELECTED
   wall; a verbatim user drag squares to ITS OWN row wall — the nearest
   exterior exit (A4 keeps the dragged position; orientation is derived
   truth). Only the rowless no-exterior-wall fallback keeps the legacy
   bearing (no wall to square to; already ⚠-flagged). `padRotY == rotY`
   always now (one rigid object). Disconnect (wall-face box) keeps the
   wall-square bearing; line-set/whip attach points recompute from the new
   anchor/orientation (E2 gates re-ran green).

3. **GRID SNAP** — AUTO anchors only (`condenserRow`, non-verbatim path):
   host grid convention (read-only investigation) = `snapToHalf(v) =
   round(v/step)·step` with `gridSnapStep` default **0.5 m**, options
   [0.5, 0.25, 0.1, 0.05] (private-editor `store/use-editor.tsx`,
   `placement-math.ts`). The engine snaps to the COARSEST step
   (`EDITOR_GRID_STEP_M = 0.5` — every finer host option divides it) in the
   WALL frame: ALONG = nearest multiple that stays on the wall span and
   clear of RO keepouts (no candidate → the slid spot stays, honest
   off-grid); OUTWARD = **ceil only** (away from the wall), so the 24" face
   clearance (`condenserStandoff`) is a FLOOR the snap can only raise. Pad
   label restates the basis: `≥ 24" face clearance basis`. Verbatim drags
   never snap (A4 — the host move tool already applied the user's grid
   mode).

4. **ROTATION** — additive nullable `yawOverride` on the `bones:service`
   schema, threaded `node.yawOverride → ServicePointOverride.yaw →
   layoutHvac hpYaw`, consumed for unit #1's whole assembly (cabinet + pad
   + fixture/proxy) — beats wall-square when set, verbatim at any angle;
   null/absent == wall-square (never a stored copy of the derivation). Pad
   clearance under an oblique override uses the rotated reach
   `(|sin φ|+|cos φ|)·half` (+ matching overhang slack), so the night-4 F1
   punch-through class cannot return. The basement/off placeholder body
   reads the same yaw (placement.ts) — one orientation in every mode.
   HOST INVESTIGATION (read-only): the standard gestures reach nodes via
   two DEFINITION seams — `keyboardActions.r/t` (use-keyboard.ts, checked
   before the raw `rotation[1]` fallback) and a `handles` arc-resize
   'rotate' descriptor (`getDirectRotateHandle` in direct-manipulation.ts,
   used by the ⌘-drag rotate, the 2D floorplan rotate AND the on-canvas
   gizmo the arrow renderer mounts). BOTH are wired in
   src/service/definition.ts for heat-pump nodes only (other service types
   keep the host default — an inert rotation write, pre-existing).
   **NO host follow-up needed** for the single-selection gestures. STATED
   LIMITATION: the host's multi-selection `rotateGroupSelection` writes raw
   `rotation` on every node in the group (no registry seam) — a heat pump
   inside a MULTI-select rotate keeps its assembly orientation; host
   follow-up only if group-rotate parity is ever wanted.

## Enumerated baseline classes (E5 recapture — the ONLY diffs)

Per-jurisdiction sweep (INTL + TX pinned corpus): **563 members /
47 fixtures each, counts and warnings byte-unchanged**; diff classes (all
the hvac condenser family, verified by field-level diff old→new):

- **M1 pad member** — label `(24" …)` → `(≥ 24" …)`; position
  [4.01905, ·, −1.1596] → [4.5, ·, −1.5] (along-snap + outward ceil on the
  baseline's 0.15 m walls). Rotation unchanged (pad was already
  wall-aligned).
- **M2 cabinet member** — position with the pad; rotation[1]
  2.8296 (equipment-room bearing) → **π** (wall-square on the south row).
- **M3 line-set pair** (suction + liquid) — outside stubs re-derive from
  the new anchor (dims/length/position class only).
- **M4 whip** — run re-anchors (position; the face-parallel leg lengthens
  with the stand-off), drop follows.
- **M5 AC-1 branch wiring** (`NM-B 10/2 w/G — AC-1`) — endpoints follow
  the disconnect spot (position/length class; gauge/breaker unchanged).
- **F1 condenser fixture** — position per M2; rotationY 2.8296 → π (the
  pick proxy reads this — proxy yaw == assembly yaw by construction).
- **F2 disconnect fixture** — position (along-wall foot of the snapped
  anchor); rotationY unchanged (already wall-square).

Everything else — every other engine, takeoff counts, warnings, labels —
byte-equal (the compute.devices byte gate re-pins it live).

## Blast-radius re-oracles (updated as INTENDED)

- `hvac.condensers.test.ts` — election/fence/courtyard/exhaustion pins
  moved to the snapped coordinates (−1.1846→−1.5 class, slid 6.15→6.5 with
  the keepout-aware multiple pick); seed-parity BYTE gates re-pin on the
  new geometry (post-seed == auto held without change — the seed spot
  snaps identically by construction).
- Starter template — disconnect proximity pin restated (plan reach ≤ 1.5
  with the snapped stand-off); template composes on the same machinery, no
  data-file pins existed.
- `service/place.test.ts`, `service-overrides.test.ts`,
  `compute.mep-honesty.test.ts` — seed/auto consumers now compare against
  `placeCondenserSeedSpot` (the composed anchor: slide + snap);
  `placeHeatPumpSpot` remains the raw pre-snap election (panel action
  unaffected — seeding goes through the seed spot).
- ε-anchor — THREE machine spellings recognized: raw election spot,
  today's snapped unit-#1 spot, and `unit1Presnap` (the pre-snap slid
  spot), so heat-pump nodes seeded BEFORE this round keep the elected wall
  (no disconnect flip onto fences) and their verbatim position (no silent
  move on upgrade).

## New gates (all mutation-bitten)

- `src/engines/hvac.polish.test.ts` (18) — wall-square pinned on 3
  azimuths (0/90°/33.7° off-axis) incl. absolute π pin; row-of-two both
  square; verbatim-drag rule; 24-case thickness×offset snap sweep
  (on-grid both axes + clearance ≥ 24" always); wall-frame snap on oblique
  walls; ceil-only outward; physics-beats-grid RO bail (both multiples
  blanketed → honest off-grid); verbatim never snapped; byte seed parity
  on snapped geometry; SLID legacy pre-snap seed recognition (the
  `unit1Presnap` bite); yawOverride verbatim/auto-anchor(rotate without
  moving)/absent==wall-square/oblique-pad honesty.
- `src/service/rotate.test.ts` (7) — R/T appliesTo gate; first press steps
  from the DERIVED yaw (host `steppedRotation` semantics) through the real
  `useScene` store; arc-handle shape/placement + `base − delta` sign
  convention; override reaches fixture + pick proxy; null clears to
  wall-square; placeholder body turns with the override.
- `condenser-asset.test.ts` color census — a red multi-material asset
  clones to 100% schematic tint (pinned `#8b8f96` == the steel bucket
  family), source asset untouched, module-cached material shared across
  builds, bucket material census flat.
- Schema (`schema.test.ts`) — yawOverride number/null/absent parse, junk
  rejected; compute extraction end-to-end incl. NaN/null honesty
  (`compute.test.ts`).

Mutation probes (all verified to fail the suite): retint disabled; legacy
bearing restored; grid snap disabled; hpYaw ignored; extraction dropped;
`unit1Presnap` recognition dropped; outward round-instead-of-ceil.
