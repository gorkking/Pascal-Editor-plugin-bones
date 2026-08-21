/**
 * Deterministic circuit → color mapping, shared by the 3D X-ray renderer
 * and the exported electrical plan sheet so a wire reads as the SAME
 * circuit in the building and on paper.
 *
 * Every circuit INDEX gets its own hue step inside the family band
 * (quality round-1 A6: two shades per family left GEN-1/3/5/7 identical) —
 * hue walks ±14° per index around the family base, lightness alternates,
 * so up to ~8 circuits per family stay tellable apart.
 */

/**
 * Plumbing run colors keyed by the engine's sourceId prefix — cold/hot
 * supply and DWV read identically in 3D and on the MEP sheet (same
 * contract as circuit colors). Null for legacy room-sourced fallback runs.
 */
export const PLUMBING_COLORS = {
  cold: '#4a7dbf',
  hot: '#c0504d',
  dwv: '#8fb0c4',
  /** Refrigerant line-set pair (hvac, M2): the suction line runs COLD →
   * cold-blue (cyan-shifted off supply cold), the liquid line runs warm →
   * warm-red (orange-shifted off supply hot) — the plumbing hot/cold
   * convention mirrored onto refrigerant, distinct enough to tell apart. */
  linesetSuction: '#35b8c9',
  linesetLiquid: '#d98134',
} as const

export function plumbingPipeColor(sourceId: string): string | null {
  if (sourceId.startsWith('cold-') || sourceId.startsWith('conn-cold-')) {
    return PLUMBING_COLORS.cold
  }
  // The WH T&P discharge carries TANK-HOT water — it joins the hot supply
  // family (B20 closing round: a null tone resurrected the LOD-200
  // 'supply / DWV pipe' legend row on every water-heater sheet).
  if (
    sourceId.startsWith('hot-') ||
    sourceId.startsWith('conn-hot-') ||
    sourceId.startsWith('wh-tp-')
  ) {
    return PLUMBING_COLORS.hot
  }
  if (sourceId.startsWith('dwv-')) return PLUMBING_COLORS.dwv
  if (sourceId.startsWith('lineset-suction-')) return PLUMBING_COLORS.linesetSuction
  if (sourceId.startsWith('lineset-liquid-')) return PLUMBING_COLORS.linesetLiquid
  return null
}

/**
 * HVAC duct tones (B19c): the RETURN trunk prints DARKER than the supply
 * gray so the two air paths read apart in 3D and on the MEP sheet — the
 * same contract as circuit/plumbing colors. Keyed by the hvac engine's
 * sourceId ('return-trunk' chain); null keeps the base duct fill.
 */
export const DUCT_COLORS = {
  supply: '#9aa7b0',
  return: '#5f7282',
} as const

export function hvacDuctColor(sourceId: string): string | null {
  return sourceId.startsWith('return-') ? DUCT_COLORS.return : null
}

const FAMILY: Record<string, { hint: string; hue: number }> = {
  SA: { hint: 'kitchen small-appliance', hue: 21 },
  BA: { hint: 'bathroom', hue: 210 },
  LA: { hint: 'laundry', hue: 178 },
  GA: { hint: 'garage', hue: 82 },
  LTG: { hint: 'lighting', hue: 44 },
  GEN: { hint: 'general receptacles', hue: 256 },
  // Hue 218 + a 22° walk + its OWN three lightness stops (below): the
  // brute-forced config whose worst pair vs every REAL circuit id
  // (SA-1..2, BA-1..2, LA-1, GA-1, LTG-1..8, GEN-1..8) clears 64 RGB —
  // hue 130 collided with LTG-7 (dist 5) and hue 160's walk hit LA-1
  // at 18.7 (two dawn rounds).
  AC: { hint: 'AC condenser (dedicated 2-pole)', hue: 218 },
}

export function circuitZoneHint(circuit: string): string {
  const family = FAMILY[circuit.split('-')[0] ?? '']
  return family?.hint ?? circuit.toLowerCase()
}

export function circuitColor(circuit: string): string {
  const [prefix, indexRaw] = circuit.split('-')
  const family = FAMILY[prefix ?? '']
  if (!family) return '#b0723d' // unknown circuit — legacy copper
  const index = Math.max(1, Number(indexRaw ?? 1) || 1)
  // GEN is the crowded family (a house easily runs GEN-1…8): walk its hue
  // 26° per index and cycle THREE lightness stops — the 14°/two-stop walk
  // left four near-identical magentas on paper (blueprint round-1 P4).
  const crowded = prefix === 'GEN'
  // AC walks 22° with its own deep/mid/light stops — see the FAMILY note.
  const ac = prefix === 'AC'
  // GEN walks 16° from 256: the old 26° walk from 285 WRAPPED into the
  // lighting band (GEN-8 at hue 107 vs LTG-6 at 114 — twin greens on
  // paper, examiner round-4); 256+16° stays inside [256, 368→8] clear
  // of every other family's walk. Family floor brute-forced to 22 RGB
  // (the residual 22 is the pre-existing GA-1/LTG-3 pair — full-palette
  // redesign queued).
  const hue = (family.hue + (index - 1) * (crowded ? 16 : ac ? 22 : 14)) % 360
  const light = ac
    ? ([30, 48, 66][(index - 1) % 3] as number)
    : crowded
      ? ([40, 52, 63][(index - 1) % 3] as number)
      : index % 2 === 1
        ? 42
        : 55
  const sat = 62
  // hsl → hex so both three.js and the SVG sheets get plain hex strings
  const h = hue / 360
  const l = light / 100
  const sN = sat / 100
  const q = l < 0.5 ? l * (1 + sN) : l + sN - l * sN
  const pQ = 2 * l - q
  const channel = (tRaw: number): number => {
    let t = tRaw
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return pQ + (q - pQ) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return pQ + (q - pQ) * (2 / 3 - t) * 6
    return pQ
  }
  const toHex = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(channel(h + 1 / 3))}${toHex(channel(h))}${toHex(channel(h - 1 / 3))}`
}
