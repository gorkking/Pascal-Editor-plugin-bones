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
- **E4 No air jumpers through open rooms.** (OPEN — QA E1 round, 2026-08-15)
  Straight diagonal wires flying through room air (bed-height jumpers,
  cross-living-room diagonals) are physically impossible cable paths even
  when they avoid ROs. Likely E2 connectivity jumpers rendered literally —
  route them along wall/ceiling Manhattan paths. Gate: TODO with the fix.

## S — Structure

- **S1 No member interpenetrates another** outside the allowed bearing
  pairs (15-axis OBB SAT, 2 mm skin; non-finite geometry = violation).
  Gate: `src/engines/interpenetration.test.ts` scenario matrix
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
  limitation: an owner ON the roof level frames that roof as own-level
  members (no foreign group), so it gets no stratum drop in exploded view.
  Gates: `src/framing/compute.multistorey.test.ts` (scenario matrix incl.
  strataAbove tagging + the own-level F1b pin) +
  `src/framing/renderer.test.ts` (offset only when strataAbove; userData
  propagation)

- **A4 Service overrides are authoritative; routing follows.** A
  `bones:service` node on the level IS the location of its system point
  (panel / water heater / water entry / sewer exit): the engines consume it
  VERBATIM — wallId+wallT+heightAff resolved by wall lerp, or a plain
  position snapped to the nearest wall point — instead of auto-placing.
  Moving the panel re-anchors every homerun (E2 continuity still holds);
  moving the meter/WH re-routes supplies (still continuous, P5); moving the
  sewer exit re-slopes the drains (still strictly monotonic downhill,
  P3005.3). Auto-placement applies ONLY when no node exists; the panel's
  "Place service points" action is idempotent per level and seeds the nodes
  at the engines' current auto spots so creation alone never moves anything.
  Origin: service-nodes plan 2026-08-16 ("drag the panel like a door — the
  wires follow").
  Gates: `src/engines/service-overrides.test.ts` (override → re-route,
  continuity + downhill re-proofs) + `src/service/place.test.ts`
  (idempotent placement at engine auto spots)

## Process

- New invariant ⇒ new row + new gate in the same commit.
- Reviewers cite rows by id (E1, S3…) in scorecards so rounds are diffable.
