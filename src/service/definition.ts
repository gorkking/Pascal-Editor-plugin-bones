import type { MovableConfig, NodeDefinition, ParametricDescriptor } from '@pascal-app/core'
import { serviceParentFrame } from './frame'
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
 * tools. Wall-mounted types drag DOOR-STYLE via `movable.parentFrame`
 * (frame.ts): the cursor projects onto the wall axis, the box slides along
 * the wall live, and the commit writes `wallId`+`wallT` while resetting
 * `position` to [0,0,0] — the wall anchor stays authoritative after every
 * drag (the old "wallT slider inert after a gizmo drag" quirk is gone).
 * Floor types keep plain plan moves (drag writes `position`). A manually
 * written non-default `position` (inspector vec3 / MCP) still OUTRANKS the
 * wall anchor — wall types snap to the nearest wall — as the escape hatch.
 * Engines re-route to the node on every change.
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
    // `cursorAttached` + `parentFrame` are newer host contract fields than
    // the pinned @pascal-app/core 0.9.1 types — mirrored in frame.ts and
    // cast here (the host reads them structurally at runtime).
    // cursorAttached: service boxes are small connector-like nodes; pinning
    // to the cursor also makes the drag origin independent of the stored
    // position (which is the [0,0,0] sentinel while wall-anchored).
    movable: {
      axes: ['x', 'z'],
      gridSnap: true,
      cursorAttached: true,
      parentFrame: serviceParentFrame,
    } as unknown as MovableConfig,
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
      'Bones service point node. serviceType: panel | water-heater | water-entry | sewer-exit | power-entry | thermostat | heat-pump | electric-meter. Wall-mounted via wallId + wallT (0..1 along the wall) + heightAff, or floor-placed via position; editor drags slide wall types along their wall and commit wallT (position resets to [0,0,0]); a position written off the default [0,0,0] outranks the wall anchor. The engines treat an existing node as the authoritative location and re-route wiring/piping to it; deleting it restores auto-placement.',
  },
}
