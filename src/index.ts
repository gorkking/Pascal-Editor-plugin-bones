import type { AnyNodeDefinition, Plugin } from '@pascal-app/core'
import { BONES_ICON } from './art'
import { lumberDefinition } from './definition'

type PluginHostPanel = {
  id: string
  label: string
  icon: { kind: 'url'; src: string }
  component: () => Promise<{ default: React.ComponentType }>
  pluginId: string
  description: string
  creator: {
    name: string
    url?: string
  }
  pluginUrl: string
  defaultInstalled: boolean
}

/**
 * The Bones plugin manifest — the entire public surface of this package.
 * A host loads it through the same `loadPlugin` path the built-ins use:
 * one node kind today (`bones:lumber`) and one left-rail panel (`Bones`).
 * Framing inference kinds (`bones:framing`, …) land next — see SPEC.md.
 */
export const bonesPlugin: Plugin = {
  id: 'snoopy:bones',
  apiVersion: 1,
  nodes: [lumberDefinition as unknown as AnyNodeDefinition],
}

export const bonesHostPanel: PluginHostPanel = {
  id: 'snoopy:bones:panel',
  label: 'Bones',
  icon: { kind: 'url', src: BONES_ICON },
  component: () => import('./panel'),
  pluginId: bonesPlugin.id,
  description:
    'Structural framing for Pascal — dimensional lumber today; inferred wall, floor, and roof framing (studs, plates, headers, joists, rafters) next.',
  creator: {
    name: 'Julien Brissonneau',
    url: 'https://github.com/Snoopy147',
  },
  pluginUrl: 'https://github.com/Snoopy147/plugin-bones',
  defaultInstalled: true,
}

export { lumberDefinition } from './definition'
export { LumberNode } from './schema'
export { LUMBER_CROSS_SECTIONS, LUMBER_SIZES, lumberBoxDims } from './lumber'
