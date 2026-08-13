# Bones — Night Log (2026-08-12 → 08-13)

*The all-nighter, documented as it happened. Times US Eastern.*

## Evening — v0.1 (the proof)

- Studied Plugin API v1 via `docs/developers/plugins.mdx` + `pascalorg/plugin-trees`
  (the reference plugin) and the host wiring in the community app.
- Shipped **v0.1**: `bones:lumber` node (dimensional lumber at actual dressed
  sizes), panel, placement tool, inspector, tests. Icon generated (fal.ai
  nano-banana-pro — hammer over blueprint, Xcode-style).
- Verified end-to-end headlessly (Playwright): panel in the Plugins sidebar,
  members placed on canvas, count chip live.
- Gotcha logged: Next static image imports are `{src}` objects — export `.src`
  or the rail icon renders `[object Object]`.

## Night — the X-ray

- **Repo moved to pascalorg** (`pascalorg/plugin-bones`), package renamed
  `@pascal-app/plugin-bones`, plugin id `pascal:bones`.
- **Research fleet #1** (5 parallel agents): state code adoption (51/51, with the
  2025–26 edition transitions verified — NY 2025 RCNYS, PA/GA/CA/NH/MI/IA/ND moves),
  real 2021 IRC framing tables (headers R602.7(1), joists R502.3.1(2), rafters
  R802.4.1, studs R602.3(5), anchors R403.1.6 — each cross-checked against two
  sources; my simplified header fallback flagged unconservative past 24 ft
  building width), NEC 2023 receptacle geometry (incl. the 2023 island change),
  MEP rules of thumb. Climate agent stalled → re-run split in two + merge.
- **Core architecture** (see ARCHITECTURE.md): derived-not-persisted members;
  `bones:framing` config node per level; pure engines; instanced renderer;
  jurisdiction profiles with zero-network AUTO guess (timezone → state).
- **Wall framing engine**: plates/studs/kings/trimmers/span-sized headers/sills/
  cripples, 13 numeric tests. Verified live: 4 drawn walls → 72 members.
- **X-ray vision**: skeleton was hidden inside the drywall → depth-test-off +
  late render order = the see-through engineering view. Verified visually.
- **Product directions folded in mid-flight** (Julien):
  - Identity: *construction / actual plans / see-through / engineering access.*
  - Jurisdiction default suggested from browser (no network); dropdown override;
    INTL profile for non-US.
  - Not everything is 2x4: per-wall construction override (framed/CMU/skip),
    CMU default for Florida exteriors.
  - BIM-style LOD ladder: 200 generic → 300 code-sized → 400 details.
- **Engine fleet** (7 parallel agents, file-disjoint): floor joists (span tables,
  polygon clipping, girders), roof (rafters/ridge/hips from real roof-segment
  schema), foundation (frost footings, stemwalls, anchor bolts, hold-downs),
  electrical (NEC 210.52 walk, GFCI by room, switches, smoke alarms, panel),
  CMU coursing (running bond, lintels, bond beams), takeoff (stock rounding,
  board feet, concrete yards), plumbing + HVAC (schematic DWV/supply/ducts).

## Deep night — every system online

- Fleet round 1 landed foundation / electrical / CMU / takeoff (with their
  agents' own numeric test suites). Floor, roof, and MEP agents stalled —
  rebuilt by hand: polygon-clipped floor joists (scanline over the slab
  polygon — L-shapes frame correctly), the full roof engine against the real
  `roof-segment` schema (gable/shed/hip, rafter rotations verified by
  rotating vectors through three.js Eulers), schematic plumbing (wet-core
  clustering, through-roof vent stack) and HVAC (tonnage from conditioned
  area, trunk + branch ducts).
- Climate retry: 51-state dataset merged (N–W fully sourced; A–M
  backfilled approximations, flagged).
- **191 unit tests green**, typecheck clean.
- Live E2E in the real editor (Playwright driving the actual wall/door/
  window tools): walls + door → **105 members · devices**, takeoff showing
  2x4s by stock length, a 4x10 header sized from the actual opening,
  11.1 yd³ of concrete (NY's 48" frost line doing its job via the AUTO
  jurisdiction guess), 17 anchor bolts per R403.1.6.
- Adversarial verification pass over roof/CMU/electrical math (3 reviewer
  agents attempting refutation with runnable counter-tests).

## Known limitations (honest list)

- Curved walls skipped (panel warning). California corners not yet framed.
- Roof: gable/shed full, hip best-effort; gambrel/dutch/mansard/flat pending.
- Climate values are state-typical; site design values govern in reality.
- MEP routing is schematic (LOD 200), not joist-bay-aware.
- A hydration warning fires during scripted wall-drawing in the dev editor —
  reproduced without Bones loaded during interaction sequences; not plugin-caused
  on plain load (0 errors).
