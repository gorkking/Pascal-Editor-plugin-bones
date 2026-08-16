'use client'

import { useLiveNodeOverrides, useLiveTransforms, useRegistry, useScene } from '@pascal-app/core'
import { useNodeEvents } from '@pascal-app/viewer'
import { useMemo, useRef } from 'react'
import { CanvasTexture, DoubleSide, type Group } from 'three'
import { resolveServicePlacement, SERVICE_BODY } from './placement'
import type { ServiceNode } from './schema'

/**
 * Renderer for a `bones:service` point: an equipment box per type plus an
 * identifying SIGN plate (canvas-texture label, double-sided) offset off the
 * wall face. A gizmo-written `position` (non-default) OUTRANKS the wall
 * anchor (wall types snap to the nearest wall); otherwise wall-mounted types
 * resolve from `wallId + wallT + heightAff` (wall start/end lerp — live, so
 * sliding `wallT` moves the node along its wall). No usable anchor → a bare
 * selectable stub. The engines consume the same node as a routing override,
 * so wherever this renders, the wires/pipes follow.
 */

/** Draw the sign label (+ bolt glyph for the panel) onto a canvas texture. */
function makeSignTexture(text: string, bolt: boolean): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#1e2126'
  ctx.fillRect(0, 0, 256, 128)
  ctx.strokeStyle = '#f5c518'
  ctx.lineWidth = 6
  ctx.strokeRect(5, 5, 246, 118)
  if (bolt) {
    // Lightning bolt drawn as a path — never rely on an emoji glyph.
    ctx.fillStyle = '#f5c518'
    ctx.beginPath()
    ctx.moveTo(52, 18)
    ctx.lineTo(30, 70)
    ctx.lineTo(44, 70)
    ctx.lineTo(36, 110)
    ctx.lineTo(66, 56)
    ctx.lineTo(50, 56)
    ctx.lineTo(64, 18)
    ctx.closePath()
    ctx.fill()
  }
  ctx.fillStyle = '#f2f2f2'
  ctx.font = 'bold 44px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, bolt ? 156 : 128, 64, bolt ? 170 : 226)
  const texture = new CanvasTexture(canvas)
  texture.anisotropy = 4
  return texture
}

const SIGN_W = 0.26
const SIGN_H = 0.13
const SIGN_GAP = 0.03

export const ServiceRenderer = ({ node: rawNode }: { node: ServiceNode }) => {
  const ref = useRef<Group>(null!)
  const liveOverride = useLiveNodeOverrides((s) => s.overrides.get(rawNode.id))
  const node = useMemo<ServiceNode>(
    () => (liveOverride ? ({ ...rawNode, ...liveOverride } as ServiceNode) : rawNode),
    [rawNode, liveOverride],
  )
  const handlers = useNodeEvents(node as never, node.type as never)
  const liveTransform = useLiveTransforms((state) => state.get(node.id))
  useRegistry(node.id, node.type, ref)

  // Live wall lookup: editing the wall (or wallT) re-resolves the spot.
  const nodes = useScene((s) => s.nodes)
  const placement = useMemo(
    () => resolveServicePlacement(nodes as Record<string, Record<string, unknown>>, node),
    [nodes, node],
  )

  const body = SERVICE_BODY[node.serviceType]
  const texture = useMemo(
    () => makeSignTexture(body.sign, node.serviceType === 'panel'),
    [body.sign, node.serviceType],
  )
  // Dispose the previous texture when the sign changes / node unmounts.
  const lastTexture = useRef<CanvasTexture | null>(null)
  if (lastTexture.current && lastTexture.current !== texture) lastTexture.current.dispose()
  lastTexture.current = texture

  if (node.visible === false) return null

  // Unresolvable anchor (missing/curved/foreign wall + never-moved position):
  // render only a small selectable stub — the node stays pickable/deletable
  // via the gizmo, but no equipment is drawn and the engines auto-place.
  if (!placement) {
    const sx = Number.isFinite(node.position?.[0]) ? node.position[0] : 0
    const sz = Number.isFinite(node.position?.[2]) ? node.position[2] : 0
    return (
      <group position={[sx, 0, sz]} ref={ref} {...handlers}>
        <mesh position={[0, 0.08, 0]}>
          <boxGeometry args={[0.16, 0.16, 0.16]} />
          <meshStandardMaterial color="#9aa0a6" roughness={0.85} />
        </mesh>
      </group>
    )
  }

  // Gizmo drags override the plan position live (floor-placed nodes).
  const position: readonly [number, number, number] =
    !placement.wallMounted && liveTransform?.position
      ? [liveTransform.position[0], placement.position[1], liveTransform.position[2]]
      : placement.position

  // Sign plates sit proud of both wall faces (interior side unknown here);
  // floor types wear one flag above the body.
  const signZ = placement.wallThickness / 2 + body.dims[2] / 2 + SIGN_GAP
  const signOffsets: [number, number, number][] = placement.wallMounted
    ? [
        [0, body.dims[1] / 2 + SIGN_H / 2 + 0.02, signZ],
        [0, body.dims[1] / 2 + SIGN_H / 2 + 0.02, -signZ],
      ]
    : [[0, body.dims[1] / 2 + SIGN_H / 2 + 0.06, 0]]
  return (
    <group
      position={[position[0], 0, position[2]]}
      ref={ref}
      rotation={[0, placement.rotationY, 0]}
      {...handlers}
    >
      <mesh castShadow position={[0, position[1], 0]} receiveShadow>
        <boxGeometry args={[body.dims[0], body.dims[1], body.dims[2]]} />
        <meshStandardMaterial color={body.color} roughness={0.7} />
      </mesh>
      {texture &&
        signOffsets.map(([sx, sy, sz], i) => (
          <mesh key={String(i)} position={[sx, position[1] + sy, sz]}>
            <planeGeometry args={[SIGN_W, SIGN_H]} />
            <meshBasicMaterial map={texture} side={DoubleSide} toneMapped={false} />
          </mesh>
        ))}
    </group>
  )
}

export default ServiceRenderer
