/**
 * One-shot capture: run computeLevel AT MASTER (before the movable-outlets
 * change) on the shared representative scene and pin the full members +
 * fixtures output. The movable-outlets byte-equality gate
 * (src/framing/compute.devices.test.ts) then asserts a scene with zero
 * device nodes/overrides still computes members STRICTLY byte-equal and
 * fixtures identical except the added `meta.deviceId` key.
 *
 * Run from the repo root: `bun scripts/capture-master-baseline.ts`
 * Output: src/framing/master-baseline.json (test fixture, committed —
 * regenerate ONLY from master, never after behavior changes).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { baselineConfig, baselineScene } from '../src/framing/baseline-scene'
import { computeLevel } from '../src/framing/compute'

const out: Record<string, unknown> = {}
for (const jurisdiction of ['INTL', 'TX']) {
  const result = computeLevel(baselineScene(), baselineConfig(jurisdiction))
  out[jurisdiction] = {
    members: result.members,
    fixtures: result.fixtures,
    warnings: result.warnings,
  }
}

const target = join(import.meta.dir, '..', 'src', 'framing', 'master-baseline.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, JSON.stringify(out))
console.log(
  'wrote',
  target,
  Object.entries(out)
    .map(
      ([k, v]) =>
        `${k}: ${(v as { members: unknown[] }).members.length} members, ${(v as { fixtures: unknown[] }).fixtures.length} fixtures`,
    )
    .join(' | '),
)
