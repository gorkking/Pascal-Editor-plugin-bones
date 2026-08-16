# Bones day board — 2026-08-16 — DAY COMPLETE (shipped ~17:30)

## Day batch SHIPPED: plugin eace4e8 via editor#665+#666 + private-editor#358
(prod main 9131aedc, E2E green post-merge). 585→668 tests. Five verify
rounds; ~18 confirmed defects fixed+gated today. All four morning items +
hover bug + electric meter live.

## ACTIVE: mixed wall construction (user ask 2026-08-16 evening)
A wall is not all-wood or all-block: CMU bottom + framed top (knee/stem
wall pattern). Spec:
- Schema: FramingNode.wallOverrides values grow from 'framed'|'cmu'|'skip'
  to also accept { construction: 'cmu', cmuHeightM?: number } (zod union,
  back-compat; absent height = full-height CMU as today).
- Engines: split wall vertically at cmuHeightM SNAPPED to whole courses
  (8in block = 0.203m course): cmu() builds courses+bond beam to the seam;
  wall-framing builds a PT sill plate ON the bond beam (anchor bolts at
  the seam per R403.1.6 spacing) + studs/plates above (shortened height).
  Openings entirely above/below the seam: normal king/trimmer or CMU
  lintel logic in their zone. Openings CROSSING the seam: flag
  ('opening crosses the CMU/framing seam — verify detail'), frame as if
  fully in the taller zone. Layers v1: unchanged per-wall (note).
- UI: Engineering section (wall card + sidebar) — selecting CMU reveals a
  height control: slider snapped to course multiples with a % readout,
  default 100%. Writes the override object.
- Takeoff: block count for the CMU zone only; studs shortened; PT sill +
  bolts booked. Gates: member composition of a 50% split (courses below,
  sill at seam, studs above, no overlap via SAT), crossing-opening flag,
  full-height unchanged vs today, takeoff deltas.

## Next-session queue
- User's Q1-Q8 answers (morning review file) still pending — gate street
  point (Q6), movable outlets (Q7), drawer stage 2 host menu (Q8).
- FUTURE WORK section below: gas, internet, per-utility arrival mode.
- Examiner non-mechanical advisories (slab-less gabled WH outside wall).
- E4 air jumpers (electrical Manhattan re-route) — oldest open row.
- Electrical jumper RO analog audit; connector RO sampling halving.
- Round-12 electrical phases 1-3 (staples/nail plates, switch legs, 14/3).

# Bones day board — 2026-08-16 (morning directives; night board below)

## Today's four items (user, verbatim intent) — 6h+ loop directive
A. EXPLODED ROOF LAYER: exploded view should read floor / trusses / shingle
   shell as ~equal strata. Impl: renderer attachForeign offsets the foreign
   roof group position.y −= EXPLODED_GAP/2 (2.5) when useViewer levelMode
   === 'exploded' (cache getState after the existing dynamic import; reset
   to 0 otherwise). Visual gate: exploded screenshot, three strata.
B. GABLE EXTERIOR (prod bug): roof-level gable walls frame as INTERIOR —
   applyExteriorFallback probes slabs and roof levels have none, so no
   sheathing/WRB/cladding. Fix in wall-model/compute: when a level has no
   slabs, probe against the union of slab polygons from LOWER levels of the
   same building (plan projection; extractSlabs per lower level id); if
   still nothing, walls on a level with zero rooms+slabs = exterior. Gates:
   gable wall on slab-less level above a slabbed level → exterior true →
   layers emitted; interior partition below stays interior.
C-USER REPORT (prod, 2026-08-16): hovering a window outlines it; hovering
   the electric/water boxes does NOTHING. Selection works (QA verified),
   hover outline does not. Scout said 'should already work' — it does not
   in reality. Suspect: selection-manager builds its hover subscription
   list from getSelectableKinds() at MOUNT, before async plugin kinds
   register (built-ins hardcoded → windows outline). C implementation MUST
   (1) verify the subscription timing hypothesis in the running editor,
   (2) fix — likely a small HOST PR (re-subscribe on registry change or
   lazy kind lookup at event time), (3) visual gate: hover over panel/WH
   → cyan outline appears, same as a window.
C-SCOUT DIGEST (implementation map, full detail in session transcript):
   - Hover/select/outline: ALREADY WORKING for bones:service (selectable
     capability + useNodeEvents spread + useRegistry — host outline pass
     keys on those three). Move cursor free via capabilities.movable.
   - DRAG: implement capabilities.movable.parentFrame (MovableParentFrame,
     core registry/types.ts:1919-1966: resolveParent/localToPlan/
     planToLocal/magneticSnap/onCommit) — the generic MoveRegistryNodeTool
     then does door-style slide: plan cursor → wall-local, live preview
     via useLiveNodeOverrides (service renderer already merges overrides),
     ONE updateNode on commit. planToLocal projects onto the wall axis →
     write wallT; onCommit ALSO zeroes position (fixes the 'wallT dead
     after gizmo drag' quirk). Floor types keep plain moves. magneticSnap:
     clamp 0..1. No @pascal-app/nodes vendoring needed.
   - Recompute on updateNode confirmed (new nodes identity every call).
   - WAIT for D+E agent to finish src/service/* before implementing.
C. SERVICE-POINT DRAG UX: hover highlight + drag-along-wall like doors.
   Scout FIRST (Explore agent): how the host door/window drag works
   (packages/editor tools + useNodeEvents + live overrides), whether plugin
   renderers can register pointer handlers the same way (lumber
   placement.tsx already does host interaction). Then: onPointerOver
   emissive highlight; drag = raycast to the wall plane → live wallT
   preview → updateNode commit on release → engines recompute (free).
D. HVAC: (1) thermostat + heat-pump added to bones:service serviceType
   enum + auto spots in 'Place service points' (thermostat: hallway/living
   interior wall 52in AFF near the return; heat-pump: exterior pad outside
   the wall nearest the air handler, lineset stub through wall) + hvac
   engine consumes overrides; (2) DUCT CODE FIX: trunk/branches route at
   ATTIC elevation (above wall.height + ceiling-joist depth), supply boots
   drop through the CEILING as ceiling registers (like light fixtures);
   never intersect the top-plate band [wall.height−0.09, wall.height] of
   any wall (research anchors: IRC R602.6 top-plate notching >50% needs a
   28ga tie = ducts don't pass through plates; E/M1601 duct installation;
   practice = attic trunk + ceiling boots). New gate: no duct member OBB
   crosses any wall's plate band; register fixtures at ceiling plane.
E. ELECTRIC METER (user, same morning): standard chain = street input →
   METER on the house side → panel. Add serviceType 'electric-meter':
   auto spot on the exterior face nearest the panel (outside), heavy
   service cable street-edge → meter → panel feed; movable like the rest.
   (Water meter already exists; sewer exit exists.)

## FUTURE WORK — utility services exploration (user notes, do NOT build yet)
- GAS: street line → gas meter on the house side → runs to WH/range/
  furnace. Not all houses have gas — needs a per-project toggle. Yellow
  CSST/black-iron runs, shutoff at the meter, appliance stubs.
- INTERNET: street cable (aerial or underground) → entry point → modem +
  router placement (movable), maybe structured-wiring panel. Cat6/coax runs.
- PER-UTILITY ARRIVAL MODE: electricity + internet can arrive OVERHEAD
  (weatherhead/drop from a pole) or UNDERGROUND (lateral) — each utility
  independently editable; drains always toward the street (no choice).
- SHARED STREET CORRIDOR: all services arrive near one street-side zone as
  parallel-but-individually-editable runs (ties into Q6 street point).

Batching: A+B one agent (small), D+E one agent (engine+service), C scout
then implement. Loop after each; ship in 1-2 prod batches today.

# Bones night board — 2026-08-16 (living file: update on every land/verdict)

## Consolidated 8-defect fix batch — LANDED (2026-08-16, af6df36→0d4a51c)
- All 8 skeptic/visual-confirmed defects fixed + gated, 666 tests:
  (1) E1 service cable — meter→panel feed rides the WALL GRAPH at a service
  plane (shared emitWallLegWith/emitWallPathWith detours); laterals/riser/
  bridges RO-sampled + ⚠-flagged; (2) bath exhaust y keys off the LOWEST
  wall along the path (exit wall's own plate band); (3) registers at the
  shoelace AREA centroid nudged inside the room + off wall bands (L-room);
  (4) interior storeys (walled level above) cap the trunk at ceiling−0.35
  as a soffit run + warning, top storeys keep attic; (5) register grille at
  ceiling−0.04 / boot to −0.05 (visible from inside); (6) RO-warning parity
  for thermostat + electric-meter overrides; (7) selectedWallInfo runs
  compute's dedupe (exported dedupeColinearWalls) — duplicates resolve to
  the KEPT twin, overrides target its id, card prints a duplicateNote;
  (8) checklist row M1 + A4 refreshed to 8 service types; plan-set EM tag +
  legend, SE-cable legend row, characteristics notes WRAP (fixCheck2 items
  1-3 folded in).
- fixCheck2 leftovers QUEUED (not mechanical): slab-less gabled advisories
  (WH auto-spot 0.6m outside the south wall, no water-meter fixture, MEP
  legend merges coincident supply/DWV rows); carried minors: plan-sheet
  upper-right bias, elevation depth cue, per-opening header tags.
- NOT prod-shipped (per brief: no prod pins, no editor) — adversarial loop
  before any pin bump.

## Item C LANDED (2026-08-16 ~09:55) — hover fix (host PR) + door-style drag
- PART 1 (hover bug): hypothesis CONFIRMED by source read — prod
  (apps/community) discovers plugins via DYNAMIC imports, so kinds register
  AFTER the selection managers snapshot getSelectableKinds() into their
  emitter subscriptions (deps never re-run); dev (apps/editor) imports
  statically → registered pre-mount → why localhost never reproduced it.
  Click had the same latent staleness (any mode/movingNode change re-ran
  the effects, masking it). Registry had NO change notification at all.
- HOST FIX: editor PR #665 (branch fix/plugin-kind-hover, b05a4a91, NOT
  merged): registry version + onRegistryChange in core, useRegistryVersion()
  hook, added to the dep arrays of all 6 kind-snapshot effects (5 editor
  SelectionManager + 1 viewer). Gates in core registry.test.ts. 1007/604/101
  pass, tsc clean.
- PART 2 (drag): plugin c2ac419 — capabilities.movable.parentFrame
  (src/service/frame.ts) for WALL_MOUNTED_TYPES: planToLocal projects the
  cursor onto the wall axis (clamp 0..1), localToPlan idempotent, live
  preview via the position override (renderer merge + nearest-wall snap =
  zero extra wiring), onCommit ONE update {wallId, wallT, position:[0,0,0]}
  — the 'wallT inert after gizmo drag' quirk is RETIRED (comments updated).
  cursorAttached:true (drag origin independent of the [0,0,0] sentinel).
  Floor types keep plain moves. 12 gates in frame.test.ts; 624 tests.
- VISUAL PASS (/tmp/qa-c-dragux, scene 74c2ce0b8791 on :3002 pinned
  c2ac419 + host branch): a7 window outline, a4 panel outline, a5 WH
  outline (same rim); b1→b4 (panel rides the wall mid-drag, green box)
  →b6/b9 (new spot, feeder + circuit drops re-routed). Post-session API:
  wallT 0.52→0.2, position [0,0,0], wallId unchanged.
- Scene gotchas hit: scenes API GET returns 0 nodes during a live session
  (desync — verify post-session or via inspector DOM); this scene's panel
  spawns inside a window RO → select it via the SIGN PLATE (x≈0.18 proud).
- NOT prod-shipped: host PR #665 awaits review/merge; plugin pin bump
  ships through the normal chain afterwards.

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

## Round-3 fixCheck NARROW FIX PASS — LANDED (2026-08-16, after d59d2f2)
- Examiner fixCheck at d59d2f2 (scorecard fixCheckVerdict REVISE-narrow):
  3 remaining items fixed + gated, 585 tests:
- (1) P4 width-aware label de-collision (plan-set.ts electrical): labels
  collide as RECTS (chars × 6.5px @ 8px bold, ~10px tall) vs labels AND
  device bubbles; spiral with growing radius (8 tries), then fall back to
  the circuit's 2nd/3rd-longest run — bubble-parked anchors get NUDGED
  labels now, never silently dropped (gabled GEN-2). Gates: 4 coincident
  anchors → pairwise rect separation ≥ label width, one label per circuit;
  bubble-anchor circuit prints clear of the bubble.
- (2) N3 filled-rect cut poché (sectionSheet): every band member prints as
  0.6-opacity beyond linework; the plane∩member slice is an explicit dark
  rect (#222) — width ≈ thickness/|planUx| capped at the projected extent,
  height ≈ vertical extent at the cut, centered where the plane crosses
  the axis; foundation rects keep the dash convention on the OUTLINE.
  End-on members visible again (old zero-length butt caps drew nothing);
  oblique members never whole-member dark. Gates: end-on CMU + footing →
  3 visible rects incl. dashed outline; 20°-oblique 8m plate → dark ≤0.7m
  (measured vs a 5m stud ruler); wall-along-plane gate stays green.
- (3) C5 flag-list wrap (schedulesSheets): '… +N more flags' truncation
  REMOVED — flagRows = flags.length, the last-page reserve grows (pages
  grow when the cap overflows) so EVERY flag prints; characteristics
  block anchor tracks the taller list. Gates: 7 flags all print, none
  truncated; char block stacks above flag #1; takeoff rows stay clear.
- NOT prod-shipped: same as the parent batch — adversarial loop (examiner
  re-read) before any pin bump.

## Round-3 scorecard FIX BATCH — LANDED (2026-08-16, 5ea5913 + f1e42f7)
- Scorecard review/scorecards/blueprint-round-3.json (verdict REVISE) items
  fixed + gated, 580 tests:
- Connectors (5ea5913): (1) P5d — connectorArc segments sampled through
  pointInAnyRO, OPENING flag on RO crossings (repro: lav in the door RO =
  6 unflagged crossings); (2) per-hose ids conn-cold-<id>/conn-hot-<id>,
  takeoff books 'Braided supply connector — N pcs' excluded from copper lf
  AND fitting bends (gate: off-wall fixtures add zero copper lf/elbows);
  (3) >0.6m hose → 'connector too long' flag; plumbingPipeColor maps
  conn-cold-/conn-hot- to blue/red (3D + MEP legend).
- Plan set (f1e42f7): N3 FAIL — sectionCutX slides off along-plane walls
  (±0.3m steps, A-A mark follows), poché only axis-crossing members
  (<60° to plane normal), parallel in-band = beyond 0.6, below-grade cut
  keeps dashes; C1 — roof coverage now a ~1m grid over the wall bbox
  (>25% unroofed cells warns; pinned vs synthetic demo wing that beat the
  bbox proxy at 0.64); P4 — circuit labels spiral-nudge apart (≥12px gate)
  + skip on device-bubble anchors; C5 — floorAreaM2==0 prints 'n/a — no
  floor slabs (see flags)' in drawer + sheet; N2 cheap part — butt caps on
  all elevation/section member strokes.
- NOT prod-shipped: needs the adversarial loop (skeptic + examiner re-read)
  before any pin bump.

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

## State right now (~06:30 — NIGHT COMPLETE, three batches shipped)
- BATCH 3 SHIPPED: plugin 45d4ad4 via editor#662 + private-editor#357
  (prod main 59b5fa02). 585 tests green. Localhost = prod sha.
- Morning review file final: ~/Downloads/bones-morning-review.txt.
- Night totals: 3 prod ships, 434→585 tests, ~30 skeptic-confirmed
  defects fixed+gated across plumbing (6 rounds), service nodes (2),
  blueprints (3 examiner rounds), view modes, multi-storey.
- Next session queue: user's Q1-Q8 answers from the review file, examiner
  cosmetics (P1 pagination, N2 depth/datums, C4 rafter note), per-element
  drawer stage 1, movable outlets (Q7), street point (Q6), electrical
  jumper RO analog (E4/#12), insulation batts toggle, connector RO
  sampling halving (skeptic future note).

## Older (~05:30 → final fix pass LANDED green)
- Connector skeptic: PASS (loop closed; ~2% predicate-halo grazes = 0.0mm
  physical penetration, future sampling refinement noted).
- Examiner fix-check: N3 FAIL→FLAG (sections legible), C1+C5+N2 CLOSED;
  narrow REVISE on 3 items → FINAL FIX PASS LANDED (see 'NARROW FIX PASS'
  section above): width-aware label de-collision, filled-rect cut poché,
  flag-list wrap — all gated, 585 tests / 0 fail. The fix agent itself
  did NOT ship (its brief: no prod pins, no editor) — the green-landing
  ship steps below are the orchestrator's.
- ON ITS GREEN LANDING: ship the round-3 batch through the prod chain
  (editor PR pin bump → merge → private-editor PR pin+submodule → merge),
  update ~/Downloads/bones-morning-review.txt (add: round-3 sheet polish +
  braided connectors shipped; note examiner's remaining P1 pagination +
  N2 datum/depth items as next round), pin localhost, mark task #17 done.
- Examiner's morning queue: P1 pagination balance (3 sheets ~2/3 empty),
  N2 depth cues + T.O. PLATE/RIDGE/GRADE datums, C4 rafter o.c. note.

## Older (~04:30 hold)
- Blueprint examiner round 3: REVISE — all round-2 items closed, but FAIL
  N3 (section poché recolors whole members; cutX on a wall axis = black
  sheet) + flags (roof-coverage bbox proxy misses the demo wing, electrical
  label stacking, char zeros on slab-less, caps, pagination).
- Connector skeptic: FAIL — connectors cross ROs unflagged (P5d) + takeoff
  books them as phantom copper lf + elbows (hot/cold share sourceId).
- FIX AGENT RUNNING (8 items, exact remedies in its brief) → on green:
  re-verify (examiner N3/C1/P4 re-check + connector skeptic re-run via
  workflow resume wf_cb4ae7d1-089 or fresh focused agents) → THEN ship
  the round-3 batch (1bb6982+fixes) through the prod chain.
- DO NOT ship 1bb6982 as-is. Prod remains at e8d15ea (main 13296c84) — the
  two shipped batches are unaffected (all their loops closed PASS).

## Older (POST-SHIP 2, ~03:30)
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
