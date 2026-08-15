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

## P — Plans (the exported document)

- **P1 One shared transform per sheet set** — same scale, same origin, so
  systems align across sheets. Gate: `plan-set.test.ts`
- **P2 Every symbol/color on a sheet appears in that sheet's legend.**
- **P3 Title block: jurisdiction + code name, date, disclaimer, SHEET n/N,
  ratio scale, north arrow.** Gate: `plan-set.test.ts` pins
- **P4 Engine warnings print verbatim in the schedules flag block** — a
  silent drop of a warning is a lie on paper.

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
  Gate: `src/framing/compute.multistorey.test.ts` (10 scenarios)

## Process

- New invariant ⇒ new row + new gate in the same commit.
- Reviewers cite rows by id (E1, S3…) in scorecards so rounds are diffable.
