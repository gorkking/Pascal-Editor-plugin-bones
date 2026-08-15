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

const FAMILY: Record<string, { hint: string; hue: number }> = {
  SA: { hint: 'kitchen small-appliance', hue: 21 },
  BA: { hint: 'bathroom', hue: 210 },
  LA: { hint: 'laundry', hue: 178 },
  GA: { hint: 'garage', hue: 82 },
  LTG: { hint: 'lighting', hue: 44 },
  GEN: { hint: 'general receptacles', hue: 285 },
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
  const hue = (family.hue + (index - 1) * 14) % 360
  const light = index % 2 === 1 ? 42 : 55
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
