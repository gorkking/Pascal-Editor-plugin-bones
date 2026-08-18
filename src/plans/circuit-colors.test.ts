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

  test('AC family reads apart from the FULL lighting walk (dawn round: hue 130 vs LTG-7 128)', () => {
    const ltg = Array.from({ length: 8 }, (_, i) => circuitColor(`LTG-${i + 1}`))
    const ac = Array.from({ length: 3 }, (_, i) => circuitColor(`AC-${i + 1}`))
    for (const a of ac) {
      for (const l of ltg) {
        expect(dist(a, l)).toBeGreaterThan(40)
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

  test('unknown circuit falls back to legacy copper', () => {
    expect(circuitColor('WAT-1')).toBe('#b0723d')
  })
})
