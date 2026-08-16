import type { NodeDefinition, ParametricDescriptor } from '@pascal-app/core'
import { SERVICE_TYPES, ServiceNode } from './schema'

type ServiceDefinition = NodeDefinition<typeof ServiceNode> & Record<string, unknown>

const serviceParametrics: ParametricDescriptor<ServiceNode> = {
  groups: [
    {
      label: 'Service point',
      fields: [
        { key: 'serviceType', kind: 'enum', options: [...SERVICE_TYPES] },
        { key: 'heightAff', kind: 'number', unit: 'm', min: 0, max: 3, step: 0.05 },
        { key: 'wallT', kind: 'number', min: 0, max: 1, step: 0.01 },
      ],
    },
    {
      label: 'Position',
      fields: [{ key: 'position', kind: 'vec3' }],
    },
  ],
}

/**
 * The `bones:service` definition — service points the Bones panel creates
 * (never palette-placed). Selectable and movable with the host's standard
 * tools: dragging writes `position`, the wall fields stay available for
 * host wall-anchor tooling. Engines re-route to the node on every change.
 */
export const serviceDefinition: ServiceDefinition = {
  kind: 'bones:service',
  schemaVersion: 1,
  schema: ServiceNode,
  category: 'furnish',
  snapProfile: 'item',

  defaults: () => ({
    object: 'node',
    parentId: null,
    visible: true,
    metadata: {},
    serviceType: 'panel',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
  }),

  capabilities: {
    movable: { axes: ['x', 'z'], gridSnap: true },
    rotatable: {
      axes: ['y'],
      snapAngles: Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4),
    },
    selectable: { hitVolume: 'bbox' },
    deletable: true,
    duplicable: false,
  },

  parametrics: serviceParametrics,

  renderer: { kind: 'parametric', module: () => import('./renderer') },

  presentation: {
    label: 'Service point',
    description:
      'A Bones utility interface point (panel, water heater, water/sewer/power entry) — move it and the systems re-route to it.',
    icon: { kind: 'iconify', name: 'lucide:plug-zap' },
    paletteSection: 'furnish',
    hidden: true,
  },

  mcp: {
    description:
      'Bones service point node. serviceType: panel | water-heater | water-entry | sewer-exit | power-entry. Wall-mounted via wallId + wallT (0..1 along the wall) + heightAff, or floor-placed via position. The electrical/plumbing engines treat an existing node as the authoritative location and re-route wiring/piping to it; deleting it restores auto-placement.',
  },
}
