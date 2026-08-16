import { describe, expect, test } from 'bun:test'
import { bonesHostPanel, bonesPlugin } from './index'
import { lumberBoxDims } from './lumber'
import { LumberNode } from './schema'

describe('Bones plugin manifest', () => {
  test('exports the stable plugin identity and node kinds', () => {
    expect(bonesPlugin.id).toBe('pascal:bones')
    expect(bonesPlugin.apiVersion).toBe(1)
    expect(bonesPlugin.nodes?.map((definition) => definition.kind)).toEqual([
      'bones:framing',
      'bones:lumber',
      'bones:service',
    ])
  })

  test('associates the Bones panel with the plugin', () => {
    expect(bonesHostPanel.pluginId).toBe(bonesPlugin.id)
    expect(bonesHostPanel.defaultInstalled).toBe(true)
    expect(bonesHostPanel.pluginUrl).toBe('https://github.com/pascalorg/plugin-bones')
  })
})

describe('LumberNode schema', () => {
  test('parses defaults — an 8ft vertical 2x4', () => {
    const node = LumberNode.parse({})
    expect(node.size).toBe('2x4')
    expect(node.orientation).toBe('stud')
    expect(node.length).toBeCloseTo(2.4384, 4)
    expect(node.type).toBe('bones:lumber')
    expect(node.id.startsWith('lumber')).toBe(true)
  })

  test('rejects a non-positive length', () => {
    expect(() => LumberNode.parse({ length: 0 })).toThrow()
  })
})

describe('lumberBoxDims', () => {
  test('a stud stands its length up along Y at actual dressed size', () => {
    const [x, y, z] = lumberBoxDims('2x4', 2.4384, 'stud')
    expect(y).toBeCloseTo(2.4384, 4)
    expect(x).toBeCloseTo(3.5 * 0.0254, 4) // 3.5" face
    expect(z).toBeCloseTo(1.5 * 0.0254, 4) // 1.5" thickness
  })

  test('a flat member lies on its wide face like a plate', () => {
    const [x, y, z] = lumberBoxDims('2x6', 3, 'flat')
    expect(x).toBe(3)
    expect(y).toBeCloseTo(1.5 * 0.0254, 4)
    expect(z).toBeCloseTo(5.5 * 0.0254, 4)
  })

  test('an edge member stands on its narrow edge like a joist', () => {
    const [x, y, z] = lumberBoxDims('2x10', 4, 'edge')
    expect(x).toBe(4)
    expect(y).toBeCloseTo(9.25 * 0.0254, 4)
    expect(z).toBeCloseTo(1.5 * 0.0254, 4)
  })
})
