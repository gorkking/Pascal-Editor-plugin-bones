/**
 * Deterministic circuit → color mapping, shared by the 3D X-ray renderer
 * and the exported electrical plan sheet so a wire reads as the SAME
 * circuit in the building and on paper.
 *
 * Prefixes follow the engine's NEC circuit ids: SA (kitchen small
 * appliance), BA (bathroom), LA (laundry), GA (garage), LTG-n (lighting),
 * GEN-n (general receptacles). Even/odd indexes within a family alternate
 * base/variant so SA-1 and SA-2 read apart.
 */

const FAMILY: Record<string, { hint: string; base: string; variant: string }> = {
  SA: { hint: 'kitchen small-appliance', base: '#e2703a', variant: '#b34f22' },
  BA: { hint: 'bathroom', base: '#3d84c6', variant: '#2a5f95' },
  LA: { hint: 'laundry', base: '#2fa3a0', variant: '#1f7a78' },
  GA: { hint: 'garage', base: '#7a8b5c', variant: '#5a6a40' },
  LTG: { hint: 'lighting', base: '#e0b53c', variant: '#b18a25' },
  GEN: { hint: 'general receptacles', base: '#b06fc9', variant: '#844d9c' },
}

export function circuitZoneHint(circuit: string): string {
  const family = FAMILY[circuit.split('-')[0] ?? '']
  return family?.hint ?? circuit.toLowerCase()
}

export function circuitColor(circuit: string): string {
  const [prefix, indexRaw] = circuit.split('-')
  const family = FAMILY[prefix ?? '']
  if (!family) return '#b0723d' // unknown circuit — legacy copper
  const index = Number(indexRaw ?? 1)
  return Number.isFinite(index) && index >= 2 && index % 2 === 0 ? family.variant : family.base
}
