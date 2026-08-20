# Bones invariant checklist — things that must NEVER regress

Living list. Every reviewer (architect · quality · blueprint) walks this
before scoring; every item names its automated gate. When a user report or a
review round finds a new class of physical impossibility, it gets a row here
AND a gate — a checklist line without a test is a wish.

## E — Electrical

- **E1 Nothing electrical occupies a rough opening.** Wire runs detour over
  the header (or under the sill) of ANY opening crossing the drill plane —
  doors, low windows, glazing. Boxes, switches and the panel never mount
  inside an RO; anchors/junctions snap to the adjacent stud bay. Full-height
  ROs that cannot be routed around are ⚠-flagged, never silently crossed.
  Origin: prod report 2026-08-15 (wire through window, box on door).
  Gate: `src/engines/electrical.openings.test.ts`
- **E2 Every device is panel-reachable as continuous cable.** Union-find
  over wire endpoints connects the panel to every routed device — detours,
  jumpers and per-circuit planes included.
  Gate: `src/engines/electrical.connectivity.test.ts`
- **E3 Circuit colors are unique and identical in 3D and on paper.**
  Gate: `src/plans/circuit-colors.test.ts` (uniqueness pins)
- **E4 No air runs at living height.** Every horizontal wire segment lies
  along a wall centerline band, at/above the ceiling plane (joist/attic
  crossings — the disconnected-island fallback rises through the plates,
  crosses above both walls, drops back to drill height), or below grade
  (the meter→panel island fallback is buried conduit per NEC 300.5).
  Bed-height jumpers and cross-room diagonals are physically impossible
  cable paths even when they avoid ROs. Island crossings clear EVERY
  wall in the scene (a 2.5m→2.5m hop must not cross a 4m great room at
  its own ceiling); per-room light legs at their room's ceiling are
  legal. Origin: QA E1 round 2026-08-15; closed night-4 (mixed heights
  round 2). Gate: `src/engines/electrical.e4.test.ts` (airRuns invariant
  on connected + island + MIXED-HEIGHT scenes, connectivity preserved).
  cable paths even when they avoid ROs. Origin: QA E1 round 2026-08-15;
  closed night-4. Gate: `src/engines/electrical.e4.test.ts` (airRuns
  invariant on connected + island scenes, connectivity preserved).
- **E5 Moved devices stay code-legal; untouched scenes stay byte-equal.**
  Every wall device fixture (receptacle / GFCI / switch) carries a
  DETERMINISTIC `meta.deviceId` (per-wall ordinal / opening key / hallway
  room key): an unchanged scene reproduces identical ids and editing one
  wall never shuffles another wall's. Each derived device is mirrored by a
  `bones:device` node (reconciler: create at the derived anchor with
  seed == anchor, re-seat UNMOVED nodes when the derivation drifts, NEVER
  touch a moved node's anchor, drop orphans/duplicates) so any outlet is
  hoverable/draggable. A node whose anchor differs from its seed is an
  engine override that WINS over the derived spot but lands buildable:
  never inside a door/window RO (snapped clear + warning), box edge
  against a stud face — off-stud books a 'device blocking' member across
  the bay (SAT-clean vs the studs) — and heights clamp to the legal bands
  (receptacle 0.15–1.7 m, switch 0.9–2.0 m per NEC 404.8(A)). Wiring
  consumes the POST-override positions (a wire endpoint lands ON the moved
  box, E2 continuity preserved). NEC 210.52 spacing re-checks ONLY walls a
  moved receptacle left/joined — the derived layout is spacing-correct by
  construction, so untouched scenes never warn. CRITICAL regression: zero
  device nodes/overrides computes members STRICTLY byte-equal to master
  (pinned master-baseline.json) and fixtures identical except the added
  `meta.deviceId`; seeded-but-unmoved nodes stay byte-equal end-to-end.
  DRAG-COMMIT CONTRACT (night-5, D2/D3 closure): the parentFrame drag
  frames — device AND service — carry NO `onCommit`; a host move-commit is
  exactly ONE tracked write ({position: on-axis plan point}) and the
  reconcile batch converts it to the wall anchor (wallId + wallT, position
  → [0,0,0]) history-paused. The host `onCommit` branch is what patched the
  parent WALL (`resolveSupportSlabPatch` no-op) and woke the space-detection
  sync mid-commit — rewriting unclassified walls' frontSide/backSide (the
  exact fields `extractWalls` derives exterior-ness from) + zone defaults,
  partly TRACKED: one drag minted three undo entries and drifted the counts
  (night-4 D2/D3 evidence: 1255·77 → 1218·79 → Cmd+Z → 1207·74). One drag =
  one undo entry; Cmd+Z returns the box AND the wiring; Cmd+Shift+Z goes
  forward; counts never drift. Sibling host defect (D4, editor branch
  fix/outlets-hidden-wall-clicks): walls hidden by the wall-mode pass kept
  full-height invisible raycast meshes that swallowed clicks aimed at
  devices behind them — hidden walls are pointer-transparent now.
  Origin: user ask Q7 ("outlets should move like doors — against a stud or
  an extra piece of wood, per code"), built night-4; live drag closed
  night-5 (movableOutlets defaults ON since).
  Gates: `src/engines/electrical.devices.test.ts` (ids + snapping matrix) +
  `src/framing/compute.devices.test.ts` (byte-equality pin, wiring
  re-route, warning parity) + `src/device/schema.test.ts` +
  `src/device/place.test.ts` (reconciler + position→anchor normalization
  matrix) + `src/service/frame.test.ts` (onCommit-ABSENCE pin for both drag
  frames + `normalizeServiceAnchors` matrix) + the device-blocking SAT
  scenario in `src/engines/interpenetration.test.ts`.

## S — Structure

- **S1 No member interpenetrates another** outside the allowed bearing
  pairs (15-axis OBB SAT, 2 mm skin; non-finite geometry = violation).
  The SAME-WALL framing-vs-finish-cavity class is DEAD since night-4
  (cavity-fit framing): 140 pairs on default 0.15m/2x6 exteriors and the
  explicit-misfit carve-out are retired — framing geometry compresses to
  the drawn cavity (`fitAcross`) so contact replaces overlap at every
  thickness. The anchor-bolt × bottom-plate slab-on-grade class CLOSED in
  LOD-400 B5: the foundation's bolts rise through the wall engine's bottom
  plate — the (PT, R317.1) SOLE PLATE they exist to clamp (R403.1.6) — so
  the pair is allow-listed as design intent and a foundation+walls compose
  scenario pins it. KNOWN residual pre-existing classes (byte-identical to
  the pre-night-4 baseline, queued on the board): tee-stem face layers ×
  through-wall framing; anchor-bolt × STUD on slab-on-grade (the shank
  tops out 3" above the slab — 1.5" above the plate — and can land inside
  a grid stud's footprint; bolt-vs-stud layout nudging queued, surfaced by
  the B5 compose scenario); framed partition tees into full-CMU through
  walls (frameWalls never sees CMU walls for insets); stem layer×layer at
  tees.
  Gate: `src/engines/interpenetration.test.ts` scenario matrix + the
  cavity-fit thickness sweep (8 thicknesses × 3 stud configs × batts)
- **S2 Every roof family inscribes inside its footprint** (no eave-line
  overhang unless declared; rake ladders from actual member positions).
  Gate: roof-framing tests
- **S3 Foundation corners close** at any angle (oblique multiplier, butt
  claims, splice suppression) — no gaps, no bow-ties on paper.
  Gates: foundation tests + mitered-path pins in `plan-set.test.ts`
- **S4 Takeoff areas never book material the members don't render.** The
  gross sheet-goods areas (wallSheathingM2…) and the member list derive from
  the same wall classification: if the takeoff books WSP sheathing, sheathing
  members exist on the level — and an interior-only storey books zero.
  Origin: verify round 2026-08-16 — the attic blanket-exterior rule fired on
  an in-progress GROUND storey (no slabs anywhere, no rooms), partitions
  framed exterior/CMU and the takeoff booked sheathing the layer engine never
  rendered. The attic rule now requires a storey BELOW in the same building
  (`extractWalls` hasLowerStorey).
  Gate: `src/framing/compute.multistorey.test.ts` (takeoff/member consistency)
- **S5 A mixed CMU/framed wall seams on a whole course and tops out at its
  architectural height.** The override `{ construction: 'cmu', cmuHeightM }`
  splits the wall at `snapCmuHeight` (8" module, R606 coursing): bond beam as
  the CMU zone's top course, PT sill anchor-bolted to it (R403.1.6 layout,
  7" embed), shortened framed zone with its own bottom/top plates above —
  zones never share volume (S1 matrix covers the seam), openings zone per
  the seam, a CROSSING opening always flags ('opening crosses the CMU/framing
  seam — verify detail') and frames as if fully in the taller zone. At a
  shared corner, and as the STEM of a tee, the mixed wall BUTTS, never
  through-runs: both zones inset to the neighbor's near face — the retreat
  is block-width-aware at acute corners,
  (neighborThickness + blockWidth·|cosθ|)/(2·sinθ), since the CMU block is
  wider than a thin framed neighbor — with the per-junction advisory
  ('mixed wall butts at corners — verify tie detail'), so it never shares
  volume with a framed, full-CMU or mixed neighbor at those junctions.
  Reverse-direction tees and oblique tees follow the pre-existing repo-wide
  tee conventions (night-board next-session queue), not this row.
  A height absent or at/above every fitting course = byte-equal to today's
  full-height CMU. Takeoff: blocks for the zone only, PT booked on its own
  `<size> PT` row, seam bolts under Wall framing. The WRITE side holds the same line:
  the height slider on both Engineering surfaces (`cmuHeightOverride`)
  stores the plain legacy 'cmu' string at full height and the object form
  with a course-snapped height otherwise — never an unsnapped number.
  Gates: `src/engines/mixed-wall.test.ts` + mixed scenarios in
  `interpenetration.test.ts` + slider write shape / snap round-trip /
  resolver read-back in `src/panel-selection.test.ts`
- **S6 Per-wall engineering overrides plumb through EVERY consumer; defaults
  stay byte-equal.** The WallOverride object's engineering fields change the
  derived members end-to-end — `studSize` re-sizes that wall's framing dims,
  `spacingIn` its stud count, `insulation` ≠ 'none' emits pink batt members
  in the stud bays (labeled 'batt R-13 (zone 2A)' style: type + override R
  or the climate zone's code minimum) that lay out against the framing's
  OWN frameHints (trimmed runs, corner backing, opening keep-outs,
  backing-ladder bays, LOD-400 fire-row splits — SAT-clean with NO
  insulation allow-list pair), `cladding` swaps that wall's finish family
  (stucco doubles the WRB per R703.7.3); the takeoff books batts by
  area per type+R and claddings per family. A config with no overrides, an
  empty map, or an object carrying only its construction (or explicit
  insulation 'none') computes members BYTE-EQUAL to today's. The write side
  stores the MINIMAL form: field writes merge into the object
  (engineeringOverride), construction flips preserve engineering fields and
  drop cmuHeightM off-CMU (constructionOverride), the CMU height slider
  keeps sibling fields (cmuHeightWrite), and a fields-less object collapses
  to the plain legacy string. Both Engineering surfaces resolve through ONE
  `selectedWallInfo` (per-wall recipe + 'per state code' defaults flags +
  code-min hint + dimensions readout + R302.6 garage-separation note).
  Gates: `src/framing/compute.test.ts` (plumb-through + byte-equal
  regression) + `src/engines/wall-framing.test.ts` (per-wall spec) +
  `src/engines/wall-layers.test.ts` (cladding/batt members) +
  `src/engines/interpenetration.test.ts` (batt SAT scenarios) +
  `src/engines/takeoff.test.ts` (batt/cladding rows) +
  `src/panel-selection.test.ts` (resolver + write helpers)
- **S7 Batts live INSIDE the layer cavity; misfit overrides warn.** Batt
  depth caps at min(stud depth, wall thickness − 1") — the cavity the layer
  stacks leave — with a member flag ('compressed … R derated', flag not
  label so takeoff rows keep their names) when the squeeze exceeds 1/4".
  Zone-less jurisdictions label batts with the SAME assumed-zone-4 R the
  panel hint prints (one fallback, both sides). An EXPLICIT studSize
  override deeper than thickness − 1" + 2mm (the SAT-skin rounding grace —
  the textbook 2x4-in-0.114m partition never warns) draws CAVITY-FIT
  (geometry compresses to thickness − 1", the batt rule extended to
  lumber via `fitAcross`; labels/size/takeoff/cut lengths stay nominal;
  members carry one aggregated 'compressed' flag per (size, thickness)
  class) and raises a compute warning + amber studsNote on both surfaces;
  defaults never WARN — they compress with the flag only. Gates: 0.15m zone-5 SAT case in
  `interpenetration.test.ts`, INTL parity in `wall-layers.test.ts`,
  misfit note/warning in `panel-selection.test.ts`.
- **S8 Colinear dedupe preserves the duplicates' OPENINGS.** When a twin
  is dropped, its openings project onto the kept centerline and merge
  (same-center+width dedupes, off-run projections skip) — studs/layers/
  batts/devices must never run through a doorway that only the dropped
  twin carried; the card's opening count includes merged ones. Kept-only
  walls stay reference-equal. Gates: `src/framing/compute.test.ts`
  (dedupe describe block).
- **S9 The Engineering cladding choice reads in BOTH render modes.** Every
  CLADDING_OPTIONS family emits ≥ 1 member (ROLE_OF covers veneer/lamina/
  foam/drainage) with a per-family X-ray color (label-matched, pairwise
  distinct, locked to the data file's material strings), and the panel
  writes the host wall's `slots.exterior` MaterialRef (library texture or
  minted flat scene material, kept id + colinear twins via paintIds) so
  solid mode changes too. Gates: `wall-layers.test.ts` (family members),
  `src/framing/cladding-colors.test.ts` (distinct colors),
  `src/framing/cladding-paint.test.ts` (paint plans).
- **S10 Roof members respect the wired span tables; splices never book
  silently.** data/framing-tables.json is LIVE: R802.4.1 rafter spans
  (horizontal projection, SPF #2) reach the spec as `rafterSpans`, swapped
  by ground-snow band in `applyJurisdiction` exactly beside the rafterSize
  bump (<50 psf → 20-psf-live table per its low-snow note, ≥50 → 50-psf);
  ceiling joists check R802.5.1(2) limited storage. Every shape verifies
  each slope plane's projection at LOD 300+: the GABLE gets the real fix —
  a purlin row (rafter stock, plumb on edge, its downhill top corner
  MEETING the rafter underside, stopped at the end rafters' inner faces)
  plus 2x4 struts ≤ 4 ft o.c. SNAPPED onto ceiling-joist lines, feet on
  the joist top face (assumed bearing, labeled — no floating struts), and
  its rafters read 'purlin-supported @ mid-span'; shapes with no modeled
  bearing below (shed / hip commons+kings / LONG jacks on their own
  bearing run / flat joists / gambrel planes / mansard+dutch skirts /
  valley jacks) flag instead. One-piece discipline: any spanning member
  beyond 20-ft stock flags its field splice (collar ties are tension —
  they always flag); continuously-supported members (ridge boards, flat
  rims, barges, purlins, fascia) NAME their splice bearing in the label
  AT 400 (fabrication data, the rafterCutData convention — the shipped
  default detail), so the takeoff's '20 ft stock (field splice)' rows are
  never silent where users live. Unknown sizes / LOD 200 stay unchecked;
  spacing between table columns snaps UP (conservative). Compact roofs —
  every plane and joist within its table — are BYTE-EQUAL to a
  tables-emptied spec at 300 and 400, and byte-equal to the SHIPPED
  master at 300 (at 400 the splice notes are the only delta on span-legal
  members longer than 20-ft stock).
  Origin: LOD-400 audit B2 (26.5-ft one-piece rafters ×40, 12 m ceiling
  joists, zero flags). Gates: `src/engines/roof-framing.spans.test.ts`
  (repro, matrix, S1 strut bearing, byte-equality, takeoff rows),
  `src/jurisdiction/profiles.test.ts` (band swap),
  `src/engines/interpenetration.test.ts` (purlin+strut SAT, reproGable).
- **S11 Wood in concrete contact is preservative-treated and says so.**
  A bottom plate bearing on the ground-level slab is a SOLE plate in
  direct concrete contact — IRC R317.1(2): it emits material `pt-lumber`
  with the cite in its label ('PT sole plate on slab (R317.1)'), books on
  the takeoff's own `<size> PT` SKU row (never blended into the untreated
  count), and the foundation's anchor-bolt row names it ('sole plate
  anchorage (R403.1.6)' — no mudsill member exists on slab-on-grade).
  ONLY the sole plate changes: studs, headers, top/cap plates bear on
  wood and stay untreated; upper storeys (plates on framed floors) and
  mixed CMU walls (framed zone on the PT seam sill, already booked)
  are byte-equal to pre-B5. `frameWalls` carries the context as
  `FrameWallsOptions.slabBearing` → `FrameHints.slabBearing`, forwarded
  from `computeLevelUncached`'s `isGroundLevel`.
  Origin: LOD-400 audit B5 (untreated lumber on concrete across every
  ground-level plate; 'mudsill anchorage' row named a member that isn't
  there). Byte-equality reset: docs/plans/B5-EXPECTED-DIFF.md (52-code
  sweep — only plate material+label and the enumerated takeoff rows
  moved). Gates: `src/engines/wall-framing.test.ts` (material pins,
  PT-swap isolation), `src/engines/takeoff.test.ts` (PT SKU row +
  conservation, anchor-row text pin),
  `src/framing/compute.multistorey.test.ts` (storey-0 vs storey-1 split),
  `src/engines/interpenetration.test.ts` (slab-on-grade compose).

## M — Mechanical (HVAC)

- **M1 Ducts never cross plate bands; interior storeys route in soffits.**
  No duct-run member OBB enters any wall's top-plate band
  [wall.height − topPlateBandM, wall.height] (IRC R602.6 — a duct never fits
  the plate boring limits). Top storeys run the trunk at ATTIC elevation
  above the tallest plate (M1601) with ceiling-boot registers whose grille
  hangs just BELOW the ceiling plane (visible from inside, like a light);
  storeys with a WALLED storey above have no attic — the trunk caps below
  the ceiling as a dropped-soffit run and the level warns
  ('interior-storey ducts run in soffits/floor webs — verify'). Exhaust
  runs exit through stud bays below the LOWEST wall along their path (the
  exit wall's own height governs, not the room ceiling); register drop
  points are area centroids nudged inside the room and off every wall band
  (concave/L rooms).
  Origin: prod report + skeptic round 2026-08-16 (short exit wall, L-room
  register in the wall, ground-storey trunk inside the storey above,
  invisible grilles).
  Gates: `src/engines/hvac.plates.test.ts` +
  `src/framing/compute.multistorey.test.ts` (M1 soffit storey)
- **M2 The AC condenser row is sized, placed and booked honestly.** Outdoor
  units are a labeled ASSUMPTION (1 ton per 450/550/650 sqft by IECC zone
  band 1-2/3-4/5+, cited in the fixture label — Manual J/S govern per
  M1401.3), one condenser per ≤ 5 tons, tiny homes floor at 1 unit/1.5 tons.
  Every pad + cabinet sits OUTSIDE an exterior wall, ≥ 0.6 m clear between
  units, cabinet ≥ 0.3 m off the wall face (per mfr clearance + IRC M1403),
  the pad slab's inner edge clears the worst-case exterior assembly
  (face + 0.13 m — brick veneer, R703.8), and nothing fronts a door/window
  RO (the row slides along the wall to clear). Each unit's refrigerant
  line-set (Ø22 suction + Ø10 liquid) runs Manhattan-only (plan-axis-aligned
  legs) through a ~0.4 m wall penetration to the air handler — a leg that
  would cross an RO takes the alternate elbow, and a path that cannot clear
  is ⚠-flagged, never silent (E1 applied to pipe). A disconnect mounts
  within sight of each unit (NEC 440.14; ≤ 1 m at an unobstructed
  anchor, ≤ 1.5 m when the box slides clear of a fronting RO — the slide
  budget is ±1.2 m along-wall) with a whip; the dedicated
  branch circuit is NOT routed yet (deferred — electrical track owns
  panel integration; the label says 'dedicated AC-n circuit, panel-homerun by compute').
  The heat-pump service node stays authoritative for unit #1 (A4 verbatim;
  the row re-anchors to it), and the takeoff books exactly the rendered row
  (S4): condensers/pads/disconnects/whips by count, line-set by pair-lf on
  its own row — never phantom copper lf, elbow fittings or NM-B.
  Origin: night-4 user ask 2026-08-17 ("AC block" catalog item — 1/2/3+
  outdoor units by cooled volume + jurisdiction, piped and powered).
  Gate: `src/engines/hvac.condensers.test.ts`

## P — Plans (the exported document)

- **P1 One shared transform per sheet set** — same scale, same origin, so
  systems align across sheets. Gate: `plan-set.test.ts`
- **P2 Every symbol/color on a sheet appears in that sheet's legend.**
- **P3 Title block: jurisdiction + code name, date, disclaimer, SHEET n/N,
  ratio scale, north arrow.** Gate: `plan-set.test.ts` pins
- **P4 Engine warnings print verbatim in the schedules flag block** — a
  silent drop of a warning is a lie on paper.

## P — Plumbing

- **P5 Supply + DWV reach every placed fixture; drains only fall.** Every
  stub-out is cold-reachable from the service meter and hot fixtures
  hot-reachable from the water heater as continuous pipe (union-find over
  endpoints); every trap drains to the sewer exit along a strictly
  monotonic downhill path (P3005.3); no pipe crosses a rough opening
  (supply/vents detour like cable — E1 applied to plumbing); trap arms
  past Table P3105.1 and island fixtures carry flags, never silent runs.
  Origin: plumbing rebuild 2026-08-16 (placed fixtures showed almost no
  plumbing).
  Gate: `src/engines/plumbing.connectivity.test.ts`

## App

- **A1 X-ray off = the editor's own look.** No plugin layers rendered solid
  (z-fight), no stipple ghosts at eye level.
- **A2 Recompute on every graph change** — openings added AFTER the first
  compute must reroute (the prod E1 report was exactly this experience).
  The renderer derives from the live nodes prop; any memo that caches past
  an opening edit is a bug.

- **A3 Multi-storey: bones aligns with what the host DRAWS.** The host mounts each node
  inside its level group at the stacked storey elevation — members render
  level-local; anything pulled from ANOTHER level (the roof search) carries
  the storey delta (baseY mirror of core getLevelElevations). A shared roof
  is framed by exactly ONE X-ray node (highest storey of the SAME building
  wins — never skipped on the roof's own level). Level arithmetic (ground
  detection, storey-below height, roof search) never crosses buildings;
  height-less legacy levels default to the host's 2.5 m. The reference is
  the HOST-DRAWN shell (world Y of the rendered roof), not wall tops — if
  the scene data floats its roof, bones floats WITH it (demo scene carries
  roof y=2.7 inside a stacked roof level: shell draws at 5.2, verified in
  the live three.js graph). Origin: prod report 2026-08-15 (two-storey
  starter house wore its roof at ground level).
  EXPLODED EXCEPTION (day board A + F1 verify round 2026-08-16): in exploded
  level mode a foreign roof group additionally drops half an exploded slot
  (host EXPLODED_GAP 5 → −2.5; editor
  packages/viewer/src/systems/level/level-system.tsx) so floor / trusses /
  shingle shell read as three strata — ONLY for groups whose source level
  sits strictly ABOVE the owner's storey (`Member.strataAbove`, tagged by
  compute, propagated as group userData): a ground-storey porch roof foreign
  to an upper owner is NEVER offset into the storey below it. INTENDED
  F1b closed (prod report 2026-08-16): an owner ON a true attic level
  (roomless, slab-less, storey below) strata-drops its OWN roof members via
  the render-only mountLevelId tag — sheets keep drawing them owner-local.
  Gates: `src/framing/compute.multistorey.test.ts` (scenario matrix incl.
  strataAbove tagging + the own-level F1b pin) +
  `src/framing/renderer.test.ts` (offset only when strataAbove; userData
  propagation)

- **A4 Service overrides are authoritative; routing follows.** A
  `bones:service` node on the level IS the location of its system point —
  all EIGHT service types: panel / water heater / water entry / sewer exit /
  power entry / thermostat / heat pump / electric meter — and the engines
  consume it VERBATIM — wallId+wallT+heightAff resolved by wall lerp, or a
  plain position snapped to the nearest wall point — instead of
  auto-placing. Moving the panel re-anchors every homerun (E2 continuity
  still holds); moving the electric meter re-anchors the whole street →
  meter → panel service chain; moving the water meter/WH re-routes supplies
  (still continuous, P5); moving the sewer exit re-slopes the drains (still
  strictly monotonic downhill, P3005.3); moving the thermostat re-mounts it;
  moving the heat pump re-anchors pad + cabinet + lineset. Every verbatim
  wall mount forced into a door/window RO warns (panel / WH / water entry /
  thermostat / electric meter — parity, no silent RO squatters).
  Auto-placement applies ONLY when no node exists; the panel's "Place
  service points" action is idempotent per level and seeds the nodes at the
  engines' current auto spots so creation alone never moves anything.
  Origin: service-nodes plan 2026-08-16 ("drag the panel like a door — the
  wires follow").
  Gates: `src/engines/service-overrides.test.ts` (override → re-route,
  continuity + downhill re-proofs) + `src/service/place.test.ts`
  (idempotent placement at engine auto spots) +
  `src/framing/compute.test.ts` (RO-warning parity)

## Process

- New invariant ⇒ new row + new gate in the same commit.
- Reviewers cite rows by id (E1, S3…) in scorecards so rounds are diffable.
