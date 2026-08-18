import type { NodeDefinition, ParametricDescriptor } from '@pascal-app/core'
import { jurisdictionOptions } from '../jurisdiction/profiles'
import { FramingNode } from './schema'

type FramingDefinition = NodeDefinition<typeof FramingNode> & Record<string, unknown>

const jurisdictionEnum = ['AUTO', ...jurisdictionOptions().map((o) => o.code)]

const framingParametrics: ParametricDescriptor<FramingNode> = {
  groups: [
    {
      label: 'Code',
      fields: [
        { key: 'jurisdiction', kind: 'enum', options: jurisdictionEnum },
        { key: 'detail', kind: 'enum', options: ['200', '300', '400'], display: 'segmented' },
        { key: 'studSpacingIn', kind: 'enum', options: [16, 24] as unknown as string[], display: 'segmented' },
      ],
    },
    {
      label: 'Systems',
      fields: [
        { key: 'showWalls', kind: 'boolean' },
        { key: 'showFloor', kind: 'boolean' },
        { key: 'showRoof', kind: 'boolean' },
        { key: 'showFoundation', kind: 'boolean' },
        { key: 'showElectrical', kind: 'boolean' },
      ],
    },
  ],
}

/**
 * The `bones:framing` config node — the persisted anchor for the derived
 * X-ray. Not placeable from a tool: the Bones panel creates exactly one per
 * level. Invisible in plan, unselectable in 3D (the panel is its UI); it
 * simply mounts the renderer that derives and instances every member.
 */
export const framingDefinition: FramingDefinition = {
  kind: 'bones:framing',
  schemaVersion: 1,
  schema: FramingNode,
  category: 'furnish',

  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    jurisdiction: 'AUTO',
    detail: '400',
    studSpacingIn: 16,
    showWalls: true,
    showFloor: true,
    showRoof: true,
    showFoundation: true,
    showElectrical: false,
    showPlumbing: false,
    showHvac: false,
    movableOutlets: false,
    xray: 1,
    seeThrough: true,
    wallOverrides: {},
  }),

  capabilities: {
    deletable: true,
  },

  parametrics: framingParametrics,

  renderer: { kind: 'parametric', module: () => import('./renderer') },

  presentation: {
    label: 'X-Ray',
    description:
      'The Bones engineering X-ray for this level — derives framing, foundation, and systems from the model.',
    icon: { kind: 'iconify', name: 'lucide:scan-line' },
    paletteSection: 'furnish',
    hidden: true,
  },

  mcp: {
    description:
      'Bones X-ray config node (one per level). Derives the construction skeleton — wall framing (studs/plates/headers), floor joists, roof rafters, foundation, electrical layout — from the level architecture and renders it in 3D. Settings: jurisdiction (US state code/INTL/AUTO), detail (200 generic / 300 code-sized), studSpacingIn (16/24), per-system show* booleans, per-wall construction overrides (framed/cmu/skip).',
  },
}
