import { describe, expect, test } from 'bun:test'
import { circuitColor } from './circuit-colors'

const rgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]
const dist = (a: string, b: string): number => {
  const [r1, g1, b1] = rgb(a)
  const [r2, g2, b2] = rgb(b)
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2)
}

describe('circuit colors (checklist E3)', () => {
  test('a full house of circuits stays pairwise distinct', () => {
    const ids = [
      'SA-1',
      'SA-2',
      'BA-1',
      'BA-2',
      'LA-1',
      'GA-1',
      'LTG-1',
      'LTG-2',
      ...Array.from({ length: 8 }, (_, i) => `GEN-${i + 1}`),
      ...Array.from({ length: 3 }, (_, i) => `AC-${i + 1}`),
    ]
    const colors = ids.map(circuitColor)
    expect(new Set(colors).size).toBe(ids.length)
  })

  test('AC family reads apart from EVERY real circuit id (two dawn rounds of near-collisions)', () => {
    // hue 130 hit LTG-7 (dist 5); hue 160's walk hit LA-1 (18.7). The gate
    // now covers the full set of ids the engine can actually emit.
    const others = [
      'SA-1', 'SA-2', 'BA-1', 'BA-2', 'LA-1', 'GA-1',
      ...Array.from({ length: 8 }, (_, i) => `LTG-${i + 1}`),
      ...Array.from({ length: 8 }, (_, i) => `GEN-${i + 1}`),
    ].map(circuitColor)
    const ac = Array.from({ length: 3 }, (_, i) => circuitColor(`AC-${i + 1}`))
    for (const a of ac) {
      for (const o of others) {
        expect(dist(a, o)).toBeGreaterThan(40)
      }
    }
    // and within the family
    for (let i = 0; i < ac.length; i++) {
      for (let j = i + 1; j < ac.length; j++) {
        expect(dist(ac[i] as string, ac[j] as string)).toBeGreaterThan(40)
      }
    }
  })

  test('GEN family reads apart on paper (blueprint round-1: four near-identical magentas)', () => {
    const gens = Array.from({ length: 8 }, (_, i) => circuitColor(`GEN-${i + 1}`))
    for (let i = 0; i < gens.length; i++) {
      for (let j = i + 1; j < gens.length; j++) {
        expect(dist(gens[i] as string, gens[j] as string)).toBeGreaterThan(40)
      }
    }
  })

  test('FULL family floor: every real circuit pair clears 20 RGB (examiner round-4 twins)', () => {
    // GEN's old 26° walk from 285 wrapped GEN-7/8 into the GA/LTG bands
    // (worst pair 4.2). The floor is now 22 — pinned above 20 here; the
    // residual 22 is the pre-existing GA-1/LTG-3 pair (palette redesign
    // queued for a >40 family-wide floor).
    const ids = [
      'SA-1', 'SA-2', 'BA-1', 'BA-2', 'LA-1', 'GA-1',
      ...Array.from({ length: 8 }, (_, i) => `LTG-${i + 1}`),
      ...Array.from({ length: 8 }, (_, i) => `GEN-${i + 1}`),
      ...Array.from({ length: 3 }, (_, i) => `AC-${i + 1}`),
    ]
    const colors = ids.map(circuitColor)
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        expect(
          dist(colors[i] as string, colors[j] as string),
          `${ids[i]} vs ${ids[j]}`,
        ).toBeGreaterThan(20)
      }
    }
  })

  test('unknown circuit falls back to legacy copper', () => {
    expect(circuitColor('WAT-1')).toBe('#b0723d')
  })
})
