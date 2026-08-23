# NIGHT-10 expected-diff manifest — electrical outdoor-zone honesty + B14 ordinal stability

Branch `feat/electrical-outdoor-honesty` (base master db7ada2, suite 1644 → 1663).
Owner: `src/engines/electrical.ts` (+ tests). `wall-model.ts` / `compute.ts`
untouched (sibling owns the classifier tonight — this branch consumes
category `'outdoor'` exactly as it exists on master).

## Scope trigger

ONLY scenes whose level carries at least one `'outdoor'`-category zone
(M4 classifier: garden/patio/yard/terrace/…) — or a multi-kitchen wall
face (class 7) — change. Everything else is byte-identical:

- full suite green with zero amendments to pre-existing scenes' pins
  (1644 baseline tests untouched);
- the E5 master-baseline byte-equality pin (`compute.devices.test.ts` ×
  `master-baseline.json`) holds — the baseline scene has no outdoor
  zones and no placed sinks;
- starter-template compose (canonical orientation): the FULL diff is
  ONE fixture line (class 1 below) — members, devices, warnings and all
  other fixtures byte-equal (probe evidence, 2026-08-23):

```
< light | Light — Back garden | [0.00,2.70,-7.00] | LTG-2
> light | Exterior light — Back garden entrance (NEC 210.70(A)(2)) | [-3.00,2.29,-4.09] | LTG-1
```

## Class 1 — outdoor ceiling lights removed; entrance lights added

`Light — <zone>` at the zone centroid × `ceilingHeight` (a ceiling
fixture floating in open air) no longer composes for any outdoor zone.
Replacement, per DECISION (basis stated): the only honest lighting the
scene can carry is NEC 210.70(A)(2)(2)'s own requirement — a
wall-mounted `Exterior light — <zone> entrance (NEC 210.70(A)(2))` on
the OUTDOOR face above each dwelling door opening into the zone
(interior latch-side switch already controls it; rides the served
indoor room's LTG circuit). A zone no dwelling door opens into gets the
level warning `outdoor zone “<name>”: open air — ceiling lighting not
modeled; exterior fixtures by site plan (no dwelling entrance adjoins
it)` instead of a fixture. Garden gates in fences are NOT dwelling
entrances (no light, no switch).

## Class 2 — smoke alarms never in outdoor zones (R314 is interior)

- Outdoor-only levels: `Smoke alarm — one per story (IRC R314.3(3))`
  no longer hangs in the yard → level warning `all zones on this level
  are outdoor — smoke alarm one per story (IRC R314.3(3)) not placed;
  alarms serve the dwelling interior (R314), verify layout`.
- Mixed levels without bedrooms/hallway: the per-story alarm elects the
  largest INDOOR room — a garden bigger than the living room used to
  win the election and float the alarm outdoors.
- The R314.3(2) bedroom-adjacent proxy never elects an outdoor zone —
  the alarm relocates to the best indoor proxy, or the existing
  proxy-fail warning fires loudly.

## Class 3 — face election is indoor-first (orientation-dependent)

On walls where an outdoor zone used to WIN the interior-face election
(the wall's +normal side faces the garden): 210.52(A) receptacles and
door switches flip from the open-air face to the INDOOR face (deviceId
face suffix flips `-p` ↔ `-m` on those walls — `bones:device` overrides
on those boxes orphan once; they anchored fixtures floating in the
yard); the meter / panel / WR boxes flip to the TRUE outside
(`exteriorFaceOf` reads an outdoor zone as the outside, including the
un-zoned-interior fallback); wire-runs re-route to the flipped faces;
switches now standing in their real room join its legitimate 3-way
group. Reversed-orientation probe (garden-house with wall_n flipped):
master put 4 receptacles + the garden-door switch IN the garden, the
meter and the front WR box INDOORS; branch relocates all of them,
members 469 → 488 (wire re-route + entrance light legs).

## Class 4 — wall-typed garden enclosures stop minting devices

A wall whose ONLY resolved side is an outdoor zone (wall-typed garden
fences / freestanding garden walls — note: type-`fence` nodes are never
extracted as electrical walls; this class is wall-typed enclosures)
gets NO interior faces: its 210.52(A) receptacles and gate-door
switches disappear. Outdoor coverage remains the B14a WR machinery's
job (front/back WR GFCI boxes unaffected).

## Class 5 — LTG circuit renumbering on mixed scenes

Outdoor zones no longer pack phantom 220.12 lighting VA (3 VA/ft² is
dwelling floor area, not yard area — a 72 m² garden burned a whole
circuit). Downstream rooms' LTG circuit numbers shift down (probe:
garden-door switch LTG-2 → LTG-1); paper circuit colors/labels follow.

## Class 6 — moved-device spacing census honesty

`applyDeviceOverrides`' 210.52(A) census skips open-air faces exactly
like exterior faces: dragging a receptacle on a courtyard partition no
longer warns `receptacle spacing exceeds NEC 210.52` for the outdoor
side's by-design zero boxes.

## Class 7 — B14 counter-walk deviceIds: zone-block keying (item 2)

Multi-kitchen SAME-face walks only: the second zone's walk re-keys from
running ordinals (`ctr-<nA>..`) to its own zone block (`ctr-1xx..`) —
a ONE-TIME re-key (overrides on those boxes orphan once), after which
ids are stable under sibling-sink deletion/re-add (the r3 skeptic's
re-base class: `ctr-4..7` → `ctr-0..3` is dead). BYTE-IDENTICAL
(gated): single-kitchen faces (plain `ctr-0..n-1` — the baseline /
master-parity / existing-user-scene class), same-zone multi-sink walks
(legacy running ordinal within one block), kitchens on different
faces. The reconciler removes only true orphans; a MOVED surviving
node is never re-minted or re-anchored (gated).

## Residuals / queue (board-note)

- Cross-storey interconnect warning predicate (`compute.ts`, sibling
  seam — NOT touched): sibling storeys whose only rooms are outdoor
  still count as "carrying rooms" and trigger the R314.4 cross-storey
  warning although they now place no alarms. Amend the predicate to
  indoor rooms when compute.ts ownership frees up.
- Same-ZONE multi-sink walks: deleting the FIRST same-zone sink still
  re-bases the second walk (solo-scene id parity makes
  sibling-independent ids impossible in a pure engine — stated in E5).
- Kitchen-zone add/delete re-ranks the blocks (structural edit class,
  E5 note 3).
- Panel/WR election on outdoor-only levels mounts on wall-typed garden
  walls (pre-existing election class, untouched).
- General exterior-door lighting (210.70(A)(2)(2) at ALL outdoor
  entrances, not just outdoor-ZONE entrances) is a separate residual —
  minting lights at every exterior door would move the E5 baseline.

## Gates

`src/engines/electrical.outdoor.test.ts` (14 tests) + the night-10
ordinal-stability describe in
`src/engines/electrical.receptacles.test.ts` (5 tests). Mutation
probes (reverted from /tmp backups, per-probe gate failures): item 1 —
M1 interiorFaces indoor filter (4), M2 per-story all-rooms election
(3), M3 proxy outdoor skip (2), M4 LTG phantom VA (1), M5 entrance
light dropped (1), M6 census skip (1), M7 exteriorFaceOf outdoor
fallback (1), M8 outdoor ceiling lights (4); item 2 — N1 running-count
offset restored (3), N2 zone block dropped (4), N3 block count frozen
(2). Checklist rows E5 / E6 / E8 / M4 amended in the behavior commits.
