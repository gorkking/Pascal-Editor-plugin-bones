# Bones night board — 2026-08-16 (living file: update on every land/verdict)

## How I work (the loop) — for any fresh context picking this up
1. Implement in small green increments (bunx tsc --noEmit + bun test after
   each; commit + push per green stage; NEVER pipe test output through
   tail/grep in a && chain — it masks the exit code).
2. Every change goes through the ADVERSARIAL LOOP before prod:
   - code skeptic agent: tries to REFUTE with scratch bun tests (repo root,
     imports source, deletes after). FAIL = concrete failing scenario.
   - visual QA agent: builds a scene via POST /api/scenes (see
     /tmp/qa-*/build_scene(s).py patterns; host has a scene-wipe bug — GET
     after POST, re-PUT if 0 nodes), ONE Playwright session
     (executablePath ~/Library/Caches/ms-playwright/chromium_headless_shell-1228/...,
     run from ~/Documents/GitHub/private-editor), screenshots, judges.
   - blueprint examiner for anything touching plan-set (review/BLUEPRINTS.md).
   - Fix every FAIL + add a GATE test per defect, then RE-VERIFY (resume the
     same skeptic via SendMessage — context intact).
3. Reviewers walk review/CHECKLIST.md (invariant rows E/S/P/A + P5); new
   invariant ⇒ new row + gate in the same commit.
4. Localhost: pin sha in ~/Documents/GitHub/private-editor/editor/apps/editor/package.json,
   bun install, restart dev server on :3002 (kill listener, PORT=3002 nohup
   bun run dev from apps/editor). NEVER restart while a visual agent is mid-session.
5. Prod chain (when loop green, standing authorization): editor repo PR from
   ~/Documents/GitHub/private-editor/editor (branch off origin/main, pin bump
   apps/editor/package.json + bun.lock; gh pr create/merge after CI) → then
   private-editor PR (apps/community pin + editor submodule gitlink via
   `git -C editor checkout <editor-main-sha>`; CI incl. E2E ~8min; merge).
   Restore feat/plugin-bones + stash after.
6. HARD RULE: never mention PlanCrafters/Steven Tibbs anywhere public.
   Attribute inspiration to IRC/NEC building codes only.

## Task #17 blueprint round-3 flags — LANDED (2026-08-16, a152cf9)
- All six examiner flags fixed + gated in plan-set.test.ts (565 tests at
  land): (1) section poché — cut members dark #222 ×1.3 width, beyond at
  0.6 opacity; (2) A-A cut mark on the wall plan (dashed line + 'A'
  bubbles at the shared sectionCutX helper); (3) stroke legends on
  cover/elevations/section (per-sheet systems only); (4) takeoff rows wrap
  at word boundaries — pagination counts LINES, wrapped row costs 2;
  (5) roof-coverage <60% flag on the roof legend + schedules flags;
  (6) rebar dowels OPEN circles vs anchor-bolt FILLED dots + legend keys.
- NOT done from the old queue wording: elevations stay 1-per-sheet (the
  2-per-sheet pairing wasn't in the round-3 brief).

## Task #18a flexible connectors — LANDED (2026-08-16, 5fdb510)
- Off-wall placed fixtures (>6cm from stub) get a 3-segment braided-hose
  arc stub → fixture connection (toilet inlet 0.2m, lav tails 0.3m); cold
  always, hot beside it; sourceId conn-<id>, no new roles. Islands keep
  flagged air runs; flush fixtures get nothing. Gated in
  plumbing.connectivity.test.ts incl. meter→conn reachability. 569 tests.
- NOT shipped to prod yet — needs the adversarial loop (skeptic + visual +
  blueprint examiner re-read) before a pin bump.

## Task #19 service nodes FIX BATCH — LANDED (2026-08-16, bdfdd7e)
- Adversarial review round on bones:service, 8 defects fixed + gated
  (558 tests): (1) RO-collision warnings for panel/WH/water-entry overrides
  in computeLevel (NEC 110.26); (2) gizmo precedence — non-default
  `position` outranks wallId+wallT in resolveServicePlacement +
  overrideWallPoint/PlanPoint (wall types snap to nearest wall); (3)
  missing/curved/foreign wallId + default position = NO override — engines
  auto-place, renderer draws a selectable stub only; (4) NaN guards on
  wallT/heightAff/position/rotation; (5) panel button counts DISTINCT
  visible service types (placedServiceTypes); (6) duplicate same-type
  nodes: lowest id wins + 'duplicate service point (…) — extra node
  ignored' warning; (7) sign texture disposed via useEffect cleanup; (8)
  exterior sign plate rotated 180° (was mirrored).
- extractServiceOverrides now returns { overrides, duplicates } (only
  caller: computeLevel).

## Task #19 service nodes CORE — LANDED (2026-08-16)
- bones:service kind (panel/water-heater/water-entry/sewer-exit/power-entry)
  + renderer (equipment box + canvas sign plates, wallId+wallT+heightAff
  lerp, position fallback) + 'Place service points' panel action
  (idempotent, seeds at engine auto spots) + engine overrides (verbatim;
  routing follows) — checklist row A4 + gates
  (service-overrides.test.ts, place.test.ts, schema.test.ts). 533 tests.
- NOT built (by design): drag interactions (host gizmo/inspector wallT
  slider is the move path), movable outlets (separate task), street-point
  unification (Q6 answer pending), power-entry routing (node places at the
  panel wall weatherhead; no engine consumer yet).

## State right now (POST-SHIP 2, ~03:30)
- SERVICE POINTS SHIPPED: plugin e8d15ea via editor#661 + private-editor#356
  (main 13296c84). Two verify rounds, 8 defects fixed+gated, visual PASS,
  closing skeptic PASS. 559 tests. Localhost = prod sha.
- Morning review file updated with service-points test steps + residuals.
- Residual tickets (non-blockers, from closing pass): renderer visual snap
  can draw a dragged box inside an RO while wiring routes clear (renderer/
  engine divergence, needs snap parity); RO warning band = device CENTER
  ±2cm, not full device height (tall tank under a sill can overlap
  unflagged); wallT slider inert after a gizmo drag until position reset
  (documented, maybe surface in inspector help).
- Remaining queue: per-element drawer stage 1, movable outlets (Q7),
  street point (Q6), electrical jumper RO analog (E4/#12), insulation
  batts toggle. (#17 round-3 flags + 18a connectors LANDED — see above;
  both still need the adversarial loop before any prod pin bump.)

## Older state (POST-SHIP 1, ~01:40)
- PROD SHIPPED: plugin 9f5a43f via editor #660 + private-editor #355
  (main 3aac52d6). Plumbing loop CLOSED after 6 rounds / 14 defect classes
  (final skeptic PASS). Localhost:3002 = prod sha.
- Morning review file written: ~/Downloads/bones-morning-review.txt
  (update it if more ships tonight).
- Task #18 complete except flexible connectors (queue item below).
- Next: #19 service nodes core (impl agent), then blueprint round-3 flags,
  then connectors. Electrical jumper analog of the RO fix: queued (#12/E4).

## Older state (verify round 4)
- Plumbing verify: rounds 1-4 done, 12 defects found+fixed+gated total.
  Round-5 CLOSING skeptic pass running on 6a2f5e4 (agent ad147b8f670d56e12
  — resume via SendMessage). PASS ⇒ ship prod batch immediately.
- Under-slab DWV ghost (task 18b) DONE at e59f17b. Flexible connectors
  (18a) still open — touches plumbing.ts, was blocked on skeptic.

## State at board creation
- Plugin master 711c401, 508 tests green. Localhost :3002 pinned c592fa7
  (STALE — re-pin to 711c401 before visual work).
- Prod: bones 4cd28a0 + editor fb221460 (lerp fix). NOT yet in prod:
  blueprint round-2 fixes, plumbing rebuild (stages 1-4 + 7 verify fixes),
  characteristics drawer/sheet. SHIP THIS BATCH after plumbing re-verify #3.
- Two re-verify defects (riser colinearity D2b, short-garage D1b) fixed at
  711c401 — needs ONE more skeptic pass (resume agent ad147b8f670d56e12) on
  those two fixes only, then ship prod batch.

## Queue (small tasks, knock down one by one)
1. [BLOCKING PROD] Skeptic re-verify #3 of D1b/D2b at 711c401 → prod chain.
2. Task #18 leftovers: (a) flexible connectors — curved supply line from
   wall stub to fixture when not flush (braided-hose arc, chrome); (b)
   under-slab visibility — DWV members y<0 render on the ghost/overlay pass
   like below-grade foundation ('crawl-space at a glance' — user asked 2x).
3. Task #19 service nodes (docs/plans/service-nodes.md + additions):
   lightning-bolt icon on the panel, similar icon for WH; ONE street
   connection point at a map edge feeding power+water+sewer entries (all
   draggable); movable outlets/switches (per-device overrides on
   FramingNode, snap to stud-bay edges from framed studs, mid-bay auto-adds
   blocking + advisory, RO exclusion, wires re-route). Keep it SIMPLE per
   user ('weeds of detail complexify — not needed').
4. NEW user idea (design answer owed): per-element engineering drawer —
   when a wall is selected in Pascal, its little context menu gains the
   Bones hammer icon; clicking opens THAT element's engineering: 2x4/2x6,
   framed/CMU ('this one is cinder blocks'), insulation on/off/type.
   Bones ALREADY has per-wall overrides (FramingNode.wallOverrides +
   panel WallOverrideSection) — this is about surfacing them on the
   element selection UI. Scout: does the host let plugins contribute to
   the item/wall selection menu (packages/editor selection menu code)? If
   not, fallback: selecting a wall while Bones panel is open scrolls/
   highlights that wall's override row (cheap, no host changes).
5. Task #17 round-3 blueprint flags: section poché + A-A cut mark on plans,
   stroke legends on cover/elevations/section, pair elevations 2-per-sheet,
   rebar dowel symbol vs anchor bolts, takeoff row word-wrap, 'wing has no
   roof' printed flag.
6. Task #12 (old): electrical round-12 phases 1-3 (staples/nail plates,
   switch legs, smoke 14/3 interconnect); MEP wall-relative routing for
   HVAC; E4 air-jumpers row (Manhattan-route the connectivity jumpers).
7. Insulation batts toggle (from old task #13 scope, still unbuilt):
   showInsulation → pink batts in stud bays from insulationByClimateZone.
8. MORNING REVIEW FILE (write LAST, ~/Downloads/bones-morning-review.txt):
   what shipped + exact test steps per feature + questions (alpha chip
   keep/kill? street-point UX? per-element drawer mock ok?) + PR links.

## Key repo facts (save re-discovery)
- Engines pure; extraction in src/core/wall-model.ts (extractWalls/Slabs/
  Rooms/Levels(baseY,buildingId)/PlacedFixtures).
- Electrical exports reused by plumbing: buildWallGraph, openingSpans,
  clearOfOpenings, nearestWallPoint, panelMountU, wallPath, wallPlan.
- Cross-level members: Member.levelId tag + renderer buildGroups foreign
  mounting into level Object3D via sceneRegistry (checklist A3).
- Plan set: 12 sheets (cover/plans/elevations/section/schedules); shared
  SetTransform for plans, fitSegs family ratio for elevations.
- Host quirks: scene-wipe desync (GET returns empty during live session —
  host bug, reported); LevelSystem lerp fixed in editor fb221460.
- Demo scene fc866f2f271b: roof level ordinal 1 h=0.35, roof group y=2.7
  INSIDE it (host draws shell at baseY+y — scene data floats the roof).
