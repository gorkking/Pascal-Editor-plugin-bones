/**
 * LOD 400 plan-set export — pure functions: (Member[], Fixture[]) → SVG
 * construction sheets + a printable HTML document.
 *
 * These are DRAWINGS, not a BIM interchange format: one plan sheet per
 * system present (foundation / floor / wall / roof framing, electrical
 * rough-in, MEP) plus a schedules sheet (takeoff + flags). Each sheet is a
 * landscape-letter SVG with a title block and scale bar; the HTML wrapper
 * paginates them for the browser's Print → Save as PDF, which keeps the
 * plugin dependency-free while producing a real, shareable plan set.
 */

import type { Fixture, Member } from '../core/types'
import type { BuildingCharacteristics } from '../engines/characteristics'
import { computeTakeoff } from '../engines/takeoff'
import { PLUMBING_COLORS, circuitColor, circuitZoneHint, plumbingPipeColor } from './circuit-colors'

export type PlanSheet = { title: string; svg: string }

export type PlanSetOptions = {
  projectName?: string
  levelName?: string
  jurisdiction?: string
  /** Engine warnings — printed verbatim in the schedules flag block. */
  warnings?: string[]
  /** Resolved code name, e.g. "2023 FBC — Residential (2021 IRC base)". */
  codeName?: string
  /** Preformatted date string for the title block. */
  date?: string
  /** Stud spacing (inches o.c.) for the framing-sheet callout. */
  studSpacingIn?: number
  /** Storey elevations by level id — members tagged levelId (cross-level
   * roofs) are level-local; elevations/sections/cover lift them by this. */
  levelBaseY?: Record<string, number>
  /** Whole-building metrics — printed as a compact block on the schedules
   * sheet (above the flags on the last page). */
  characteristics?: BuildingCharacteristics
}

// Sheet canvas (landscape letter at 96dpi: 11in × 8.5in).
const W = 1056
const H = 816
const MARGIN = 48
const TITLE_H = 76

/** Systems that get a dedicated plan sheet, with drawing styles. */
const PLAN_SHEETS: {
  key: string
  title: string
  systems: Member['system'][]
  fill: Record<string, string>
}[] = [
  {
    key: 'foundation',
    title: 'Foundation plan',
    systems: ['foundation'],
    fill: { footing: '#c9cdd2', stemwall: '#aab0b7', mudsill: '#d9c39a', default: '#e3e6e9' },
  },
  {
    key: 'floor',
    title: 'Floor framing plan',
    systems: ['floor-framing'],
    fill: { girder: '#b98d4f', 'rim-joist': '#caa36a', joist: '#d9c39a', default: '#e8d9b8' },
  },
  {
    key: 'wall',
    title: 'Wall framing plan',
    systems: ['wall-framing'],
    fill: { header: '#b98d4f', 'king-stud': '#caa36a', default: '#d9c39a' },
  },
  {
    key: 'roof',
    title: 'Roof framing plan',
    systems: ['roof-framing'],
    fill: { ridge: '#b98d4f', hip: '#caa36a', valley: '#caa36a', default: '#d9c39a' },
  },
  {
    key: 'electrical',
    title: 'Electrical rough-in plan',
    systems: ['electrical'],
    fill: { 'wire-run': '#d7a43c', default: '#d7a43c' },
  },
  {
    key: 'mep',
    title: 'Plumbing + HVAC plan',
    systems: ['plumbing', 'hvac'],
    fill: {
      'duct-run': '#9aa7b0',
      'vent-stack': '#6e8fa0',
      'pipe-run': '#8fb0c4',
      'water-heater': '#b5aa97',
      default: '#8fb0c4',
    },
  },
]

/** Systems whose sheets draw the wall footprint as faint context. */
const CONTEXT_SHEETS = new Set(['electrical', 'mep'])

/** Device tags for the electrical sheet's symbols. */
const FIXTURE_TAG: Record<string, string> = {
  receptacle: 'R',
  'receptacle-gfci': 'G',
  switch: 'S',
  light: 'L',
  'smoke-alarm': 'SD',
  panel: 'P',
  'exhaust-fan': 'EF',
  thermostat: 'T',
  register: 'SR',
  return: 'RA',
  'stub-out': 'SO',
  'vent-stack': 'VS',
  'water-heater': 'WH',
  'water-meter': 'M',
  'electric-meter': 'EM',
  equipment: 'AH',
  cleanout: 'CO',
  disconnect: 'DS',
}

const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const deg = (rad: number): number => (rad * 180) / Math.PI

/** Drop exactly-coincident duplicates (same role, position, dims) —
 * double-plotted bolts/CMU courses read as smudges (blueprint round-1). */
function dedupeShapes(members: Member[]): Member[] {
  const seen = new Set<string>()
  const out: Member[] = []
  for (const m of members) {
    const key = `${m.role}|${m.position.map((v) => v.toFixed(3)).join(',')}|${m.dims.map((v) => v.toFixed(3)).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number }

function planBounds(members: Member[], fixtures: Fixture[]): Bounds | null {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  const eat = (x: number, z: number, r: number) => {
    minX = Math.min(minX, x - r)
    maxX = Math.max(maxX, x + r)
    minZ = Math.min(minZ, z - r)
    maxZ = Math.max(maxZ, z + r)
  }
  for (const m of members) {
    // Rotation-aware per-axis extents — a single max-dim radius inflated
    // the frame ~40% on elongated plans (quality C1).
    const yaw = m.rotation[1]
    const ex = (Math.abs(Math.cos(yaw)) * m.dims[0] + Math.abs(Math.sin(yaw)) * m.dims[2]) / 2
    const ez = (Math.abs(Math.sin(yaw)) * m.dims[0] + Math.abs(Math.cos(yaw)) * m.dims[2]) / 2
    minX = Math.min(minX, m.position[0] - ex)
    maxX = Math.max(maxX, m.position[0] + ex)
    minZ = Math.min(minZ, m.position[2] - ez)
    maxZ = Math.max(maxZ, m.position[2] + ez)
  }
  for (const f of fixtures) eat(f.position[0], f.position[2], 0.2)
  if (!Number.isFinite(minX)) return null
  return { minX, maxX, minZ, maxZ }
}

/** Title block + border + scale bar, shared by every sheet. */
/** Clip one text line to the title block width (~70 chars at 10px). */
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

function chrome(
  title: string,
  opts: PlanSetOptions,
  scale: number,
  extra = '',
  { scaleBar = true, ratio, northArrow }: { scaleBar?: boolean; ratio?: number; northArrow?: boolean } = {},
): string {
  const meterPx = scale
  const meters = Math.max(1, Math.round(180 / Math.max(1e-6, meterPx)))
  const barPx = meters * meterPx
  const by = H - TITLE_H - 18
  // Two wrapped code lines instead of one overflowing one (quality C1:
  // the effective date clipped off the sheet edge on every sheet).
  const code = opts.codeName ?? ''
  // wrap at a word boundary (round-3: '8th Editi / on' split mid-word)
  let head = code
  let rest = ''
  if (code.length > 46) {
    const cut = code.lastIndexOf(' ', 46)
    const at = cut > 20 ? cut : 46
    head = code.slice(0, at)
    rest = code.slice(at).trim()
  }
  const line1 = clip(`Jurisdiction: ${opts.jurisdiction ?? 'AUTO'}${head ? ` — ${head}` : ''}`, 66)
  const line1b = rest ? clip(rest, 66) : ''
  const line2 = clip(
    `LOD 400 · Bones${ratio ? ` · scale 1:${ratio}` : ''}${opts.date ? ` · ${opts.date}` : ''} · __SHEET_NO__`,
    72,
  )
  const bar = scaleBar
    ? `<g stroke="#222" stroke-width="2">
      <line x1="${MARGIN}" y1="${by}" x2="${MARGIN + barPx}" y2="${by}"/>
      <line x1="${MARGIN}" y1="${by - 5}" x2="${MARGIN}" y2="${by + 5}"/>
      <line x1="${MARGIN + barPx}" y1="${by - 5}" x2="${MARGIN + barPx}" y2="${by + 5}"/>
    </g>
    <text x="${MARGIN + barPx + 8}" y="${by + 4}" font-size="11" fill="#333">${meters} m${ratio ? ` (1:${ratio})` : ''}</text>
    ${
      (northArrow ?? true)
        ? `<g transform="translate(${W - 40} ${MARGIN + 8})" stroke="#222" fill="none">
      <circle r="11"/>
      <path d="M0 8 L0 -8 M0 -8 L-3.5 -1 M0 -8 L3.5 -1" stroke-width="1.6"/>
      <text y="-14" font-size="9" text-anchor="middle" fill="#222" stroke="none">N</text>
    </g>`
        : ''
    }`
    : ''
  return `
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="#222" stroke-width="2"/>
  <g font-family="Helvetica, Arial, sans-serif">
    <rect x="${W - 380}" y="${H - TITLE_H - 8}" width="${372}" height="${TITLE_H}" fill="#fff" stroke="#222"/>
    <text x="${W - 368}" y="${H - TITLE_H + 12}" font-size="14" font-weight="bold" fill="#111">${esc(clip(title, 44))}</text>
    <text x="${W - 368}" y="${H - TITLE_H + 27}" font-size="10" fill="#333">${esc(clip(`${opts.projectName ?? 'Pascal project'} — ${opts.levelName ?? 'Level'}`, 66))}</text>
    <text x="${W - 368}" y="${H - TITLE_H + 38}" font-size="8.5" fill="#555">${esc(line1)}</text>
    ${line1b ? `<text x="${W - 368}" y="${H - TITLE_H + 48}" font-size="8.5" fill="#555">${esc(line1b)}</text>` : ''}
    <text x="${W - 368}" y="${H - TITLE_H + 58}" font-size="8.5" fill="#555">${esc(line2)}</text>
    <text x="${W - 368}" y="${H - TITLE_H + 66}" font-size="8" fill="#777">Drafting aid, not engineering — verify with your local building department.</text>
    ${bar}
    ${extra}
  </g>`
}

/**
 * ONE transform for the whole set (blueprint round-1 P2: five different
 * scales/origins made cross-sheet overlay impossible). Union bbox of every
 * system, scale snapped DOWN to a standard architectural ratio so the bar
 * reads 1:50 / 1:75 / 1:100…, gutter reserved on every sheet uniformly.
 */
type SetTransform = { scale: number; ratio: number; X: (x: number) => number; Z: (z: number) => number; gutter: number }

/** 96dpi: px per meter at ratio 1:n = 96/0.0254/n. */
const RATIOS = [20, 25, 50, 75, 100, 125, 150, 200, 250, 500]

function setTransform(members: Member[], fixtures: Fixture[]): SetTransform | null {
  const b = planBounds(members, fixtures)
  if (!b) return null
  const gutter = 258 // uniform legend/notes strip, every sheet
  const drawW = W - 2 * MARGIN - gutter
  const drawH = H - 2 * MARGIN - TITLE_H
  const spanX = Math.max(0.5, b.maxX - b.minX)
  const spanZ = Math.max(0.5, b.maxZ - b.minZ)
  const fit = Math.min(drawW / spanX, drawH / spanZ)
  const pxPerM = 96 / 0.0254
  const ratio = RATIOS.find((r) => pxPerM / r <= fit) ?? 500
  const scale = pxPerM / ratio
  const ox = MARGIN + gutter + (drawW - spanX * scale) / 2 - b.minX * scale
  const oz = MARGIN + (drawH - spanZ * scale) / 2 - b.minZ * scale
  return { scale, ratio, X: (x) => ox + x * scale, Z: (z) => oz + z * scale, gutter }
}

/** One top-view plan sheet for the given systems. */
function planSheet(
  def: (typeof PLAN_SHEETS)[number],
  members: Member[],
  fixtures: Fixture[],
  opts: PlanSetOptions,
  t: SetTransform,
): PlanSheet | null {
  const mine = dedupeShapes(members.filter((m) => def.systems.includes(m.system)))
  const devs = fixtures.filter((f) => def.systems.includes(f.system))
  if (mine.length === 0 && devs.length === 0) return null
  // Wall footprint context: runs floating on white are unreadable — draw
  // the bottom plates as light gray underlay on every non-wall sheet.
  const context =
    def.key === 'wall'
      ? []
      : members.filter((m) => m.system === 'wall-framing' && m.role === 'bottom-plate')
  const { scale, X, Z } = t

  const shapes: string[] = []
  // Foundation runs draw as MITERED PATHS, not independent rectangles:
  // per-member boxes read as crossed bow-ties at oblique corners (user
  // report — fine at 90°, wrong at angles). Chained centerlines with
  // stroke miter joins give the drafting-correct corner at any angle.
  const STROKE_ROLES = new Set(['footing', 'stemwall', 'bond-beam'])
  const stroked = new Set<Member>()
  if (def.key === 'foundation') {
    type Seg = { a: [number, number]; b: [number, number]; w: number; m: Member }
    const byRole = new Map<string, Seg[]>()
    for (const m of mine) {
      if (!STROKE_ROLES.has(m.role)) continue
      const yaw = m.rotation[1]
      const dx = (Math.cos(yaw) * m.dims[0]) / 2
      const dz = (-Math.sin(yaw) * m.dims[0]) / 2
      const seg: Seg = {
        a: [m.position[0] - dx, m.position[2] - dz],
        b: [m.position[0] + dx, m.position[2] + dz],
        w: m.dims[2],
        m,
      }
      stroked.add(m)
      byRole.set(m.role, [...(byRole.get(m.role) ?? []), seg])
    }
    const lineHit = (
      p: Seg,
      q: Seg,
    ): [number, number] | null => {
      // intersection of the two centerlines — the true corner vertex
      const d1: [number, number] = [p.b[0] - p.a[0], p.b[1] - p.a[1]]
      const d2: [number, number] = [q.b[0] - q.a[0], q.b[1] - q.a[1]]
      const den = d1[0] * d2[1] - d1[1] * d2[0]
      if (Math.abs(den) < 1e-9) return null
      const t = ((q.a[0] - p.a[0]) * d2[1] - (q.a[1] - p.a[1]) * d2[0]) / den
      return [p.a[0] + d1[0] * t, p.a[1] + d1[1] * t]
    }
    for (const [role, segs] of byRole) {
      const width = Math.max(...segs.map((sg) => sg.w))
      const tol = width * 2.5
      const used = new Set<Seg>()
      const fill = def.fill[role] ?? def.fill.default ?? '#c9cdd2'
      for (const seed of segs) {
        if (used.has(seed)) continue
        used.add(seed)
        // grow a chain both directions
        const chain: [number, number][] = [seed.a, seed.b]
        let extended = true
        while (extended) {
          extended = false
          for (const cand of segs) {
            if (used.has(cand)) continue
            for (const [candEnd, candFar] of [
              [cand.a, cand.b],
              [cand.b, cand.a],
            ] as const) {
              const head = chain[0] as [number, number]
              const tail = chain[chain.length - 1] as [number, number]
              if (Math.hypot(candEnd[0] - tail[0], candEnd[1] - tail[1]) < tol) {
                const hit = lineHit(
                  { a: chain[chain.length - 2] as [number, number], b: tail, w: 0, m: seed.m },
                  cand,
                )
                if (hit) chain[chain.length - 1] = hit
                chain.push(candFar as [number, number])
                used.add(cand)
                extended = true
                break
              }
              if (Math.hypot(candEnd[0] - head[0], candEnd[1] - head[1]) < tol) {
                const hit = lineHit(
                  { a: chain[1] as [number, number], b: head, w: 0, m: seed.m },
                  cand,
                )
                if (hit) chain[0] = hit
                chain.unshift(candFar as [number, number])
                used.add(cand)
                extended = true
                break
              }
            }
            if (extended) break
          }
        }
        // closed loop? join the ends at their intersection too
        const head = chain[0] as [number, number]
        const tail = chain[chain.length - 1] as [number, number]
        let closed = false
        if (chain.length > 3 && Math.hypot(head[0] - tail[0], head[1] - tail[1]) < tol) {
          const hit = lineHit(
            { a: chain[1] as [number, number], b: head, w: 0, m: seed.m },
            { a: chain[chain.length - 2] as [number, number], b: tail, w: 0, m: seed.m },
          )
          if (hit) {
            chain[0] = hit
            chain[chain.length - 1] = hit
          }
          closed = true
        }
        const d = chain
          .map((pt, i) => `${i === 0 ? 'M' : 'L'}${X(pt[0]).toFixed(1)} ${Z(pt[1]).toFixed(1)}`)
          .join('')
        shapes.push(
          `<path d="${d}${closed ? 'Z' : ''}" fill="none" stroke="${fill}" stroke-width="${(width * scale).toFixed(1)}" stroke-linejoin="miter" stroke-miterlimit="8" stroke-linecap="butt"/>`,
        )
      }
    }
  }
  for (const m of context) {
    const yaw = m.rotation[1]
    const w = m.dims[0] * scale
    const h = Math.max(1, m.dims[2] * scale)
    shapes.push(
      `<rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#e4e7ea" stroke="#c9ced4" stroke-width="0.4" transform="translate(${X(m.position[0]).toFixed(1)} ${Z(m.position[2]).toFixed(1)}) rotate(${(-deg(yaw)).toFixed(2)})"/>`,
    )
  }
  // Long members first so short hardware reads on top.
  const sorted = [...mine].sort((a, b2) => b2.dims[0] - a.dims[0])
  for (const m of sorted) {
    if (stroked.has(m)) continue
    // Foundation hardware symbols (blueprint round-3): anchor bolts print as
    // FILLED dots, vertical rebar dowels as OPEN circles — identical gray
    // squares made the two anchorage systems indistinguishable on paper.
    if (
      def.key === 'foundation' &&
      (m.role === 'anchor-bolt' ||
        (m.role === 'rebar' && m.dims[1] > m.dims[0] && m.dims[1] > m.dims[2]))
    ) {
      const cx = X(m.position[0]).toFixed(1)
      const cy = Z(m.position[2]).toFixed(1)
      shapes.push(
        m.role === 'anchor-bolt'
          ? `<circle cx="${cx}" cy="${cy}" r="2.2" fill="#444"/>`
          : `<circle cx="${cx}" cy="${cy}" r="2.6" fill="none" stroke="#444" stroke-width="0.9"/>`,
      )
      continue
    }
    // Plan projection from the FULL euler (XYZ: M = Rx·Ry·Rz applied Rz
    // first): rolled members (outlookers) ignore neither rx nor the yaw —
    // round-14 caught 5.8° drift on yawed roofs from the yaw-only path.
    const [rx, ry, rz] = m.rotation
    const cy = Math.cos(ry)
    const sy = Math.sin(ry)
    const cz = Math.cos(rz)
    const sz = Math.sin(rz)
    // axis = R·(1,0,0): x' = cy·cz, y' = cx·sz + sx·sy·cz…, z' only needs
    // the plan pair — for XYZ order: x' = cy·cz, z' = sx·sz − cx·sy·cz
    const cx = Math.cos(rx)
    const sxr = Math.sin(rx)
    const ax = cy * cz
    const az = sxr * sz - cx * sy * cz
    const planFrac = Math.hypot(ax, az)
    const yaw = Math.atan2(-az, ax)
    const planLen = Math.max(0.02, m.dims[0] * planFrac)
    const w = planLen * scale
    const h = Math.max(1.2, m.dims[2] * scale)
    // Per-member colors: wires by circuit; plumbing runs by system —
    // cold blue / hot red / DWV slate via the sourceId prefix (identical
    // to the 3D X-ray, invariant E3's spirit).
    const fill =
      m.system === 'electrical' && m.role === 'wire-run'
        ? circuitColor(m.sourceId)
        : (m.system === 'plumbing' && m.role === 'pipe-run'
            ? plumbingPipeColor(m.sourceId)
            : null) ?? (def.fill[m.role] ?? def.fill.default ?? '#ddd')
    shapes.push(
      `<rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" stroke="#444" stroke-width="0.6" transform="translate(${X(m.position[0]).toFixed(1)} ${Z(m.position[2]).toFixed(1)}) rotate(${(-deg(yaw)).toFixed(2)})"/>`,
    )
  }
  // Device tags: dedupe identical (kind, position) fixtures and nudge
  // colliding bubbles apart in a small spiral (quality A6/C3: six tags
  // overprinted into a blob; the panel symbol printed twice).
  const placed: { x: number; y: number }[] = []
  const seenDev = new Set<string>()
  for (const f of devs) {
    const key = `${f.kind}|${f.position[0].toFixed(2)}|${f.position[2].toFixed(2)}`
    if (seenDev.has(key)) continue
    seenDev.add(key)
    // Condensers share kind 'equipment' with the air handler — key the
    // refinement off meta (examiner round-4: two 'AH' bubbles outdoors).
    const tag =
      f.kind === 'equipment' && f.meta?.equipment === 'condenser'
        ? 'CU'
        : (FIXTURE_TAG[f.kind] ?? '·')
    let px = X(f.position[0])
    let py = Z(f.position[2])
    for (let attempt = 0; attempt < 8; attempt++) {
      const clash = placed.some((q) => Math.hypot(q.x - px, q.y - py) < 15)
      if (!clash) break
      const ang = (attempt * Math.PI) / 3
      px = X(f.position[0]) + 16 * Math.cos(ang)
      py = Z(f.position[2]) + 16 * Math.sin(ang)
    }
    placed.push({ x: px, y: py })
    shapes.push(
      `<g transform="translate(${px.toFixed(1)} ${py.toFixed(1)})"><circle r="7" fill="#fff" stroke="#a05c10" stroke-width="1.2"/><text y="3.5" font-size="8" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="#a05c10">${esc(tag)}</text></g>`,
    )
  }

  // Circuit-ID text on each circuit's longest horizontal run — the examiner
  // couldn't trace a colored line back to its legend row without following
  // it to the panel (blueprint P4). Runs sharing a homerun spine anchor at
  // the SAME point (round-3 scorecard: LTG-3/LTG-4/GEN-3/GEN-4 stacked at
  // one coordinate) — labels de-collide as RECTANGLES sized by their text
  // (round-3 fixCheck: a fixed 16 px point nudge left ~30 px-wide bold
  // labels overprinting as 'LTGGEN-3'). Spiral with growing radius, ~8
  // tries per anchor, then fall back to the circuit's 2nd/3rd-longest
  // segment — a bubble-parked anchor used to silently drop the label
  // (gabled GEN-2). Drawn AFTER the bubbles so `placed` holds their spots.
  if (def.key === 'electrical') {
    const runs = new Map<string, Member[]>()
    for (const m of mine) {
      if (m.role !== 'wire-run') continue
      const list = runs.get(m.sourceId) ?? []
      list.push(m)
      runs.set(m.sourceId, list)
    }
    // ~6.5 px/char at font-size 8 bold; glyph box ≈ 10 px tall
    const LABEL_H = 10
    const rects: { x: number; y: number; w: number }[] = []
    const clashes = (x: number, y: number, w: number): boolean =>
      rects.some(
        (r) => Math.abs(r.x - x) < (r.w + w) / 2 + 2 && Math.abs(r.y - y) < LABEL_H + 2,
      ) ||
      // device bubbles are r=7 circles — keep the label rect clear of them
      placed.some((q) => Math.abs(q.x - x) < w / 2 + 9 && Math.abs(q.y - y) < LABEL_H / 2 + 9)
    for (const [circuit, list] of runs) {
      list.sort((a, b2) => b2.length - a.length)
      const w = circuit.length * 6.5
      let spot: { x: number; y: number } | null = null
      for (const m of list.slice(0, 3)) {
        if (m.length * scale < 40) continue // too short to label legibly
        const ax = X(m.position[0])
        const ay = Z(m.position[2]) - 3
        for (let attempt = 0; attempt < 8; attempt++) {
          const r = attempt === 0 ? 0 : 10 + 7 * attempt
          const ang = (attempt * Math.PI) / 3
          const px = ax + r * Math.cos(ang)
          const py = ay + r * Math.sin(ang)
          if (!clashes(px, py, w)) {
            spot = { x: px, y: py }
            break
          }
        }
        if (spot) break
      }
      if (!spot) continue // every anchor crowded — drop rather than overprint
      rects.push({ x: spot.x, y: spot.y, w })
      shapes.push(
        `<text x="${spot.x.toFixed(1)}" y="${spot.y.toFixed(1)}" font-size="8" font-weight="bold" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="${circuitColor(circuit)}" stroke="#fff" stroke-width="2" paint-order="stroke">${esc(circuit)}</text>`,
      )
    }
  }

  // Callouts: most common size per role, top-left legend — and on the
  // electrical sheet, the CIRCUIT legend (color swatch, id, breaker/gauge,
  // zone) so wires on paper match the 3D X-ray colors.
  // Most-common size per role — 'first seen' printed 2x4 for everything
  // on a 2x6-dominant house (quality C4).
  const roleSizeCounts = new Map<string, Map<string, number>>()
  for (const m of mine) {
    if (!m.size) continue
    const counts = roleSizeCounts.get(m.role) ?? new Map<string, number>()
    counts.set(m.size, (counts.get(m.size) ?? 0) + 1)
    roleSizeCounts.set(m.role, counts)
  }
  const roleSizes = new Map<string, string>()
  for (const [role, counts] of roleSizeCounts) {
    roleSizes.set(role, [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '')
  }
  const legendLines: string[] = [...roleSizes.entries()]
    .slice(0, 8)
    .map(
      ([role, size], i) =>
        `<text x="${MARGIN + 4}" y="${MARGIN + 14 + i * 14}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(role)} — ${esc(size)}</text>`,
    )
  if (def.key === 'mep') {
    // Supply/DWV split by sourceId prefix (placed-fixture engine); the
    // legacy room-category fallback keeps its single pipe tint.
    const pipes = mine.filter((m) => m.system === 'plumbing' && m.role === 'pipe-run')
    const entries: [string, string][] = []
    if (pipes.some((m) => plumbingPipeColor(m.sourceId) === PLUMBING_COLORS.cold)) {
      entries.push(['supply — cold water', PLUMBING_COLORS.cold])
    }
    if (pipes.some((m) => plumbingPipeColor(m.sourceId) === PLUMBING_COLORS.hot)) {
      entries.push(['supply — hot water', PLUMBING_COLORS.hot])
    }
    if (pipes.some((m) => m.sourceId.startsWith('dwv-'))) {
      entries.push(['DWV drain / vent', PLUMBING_COLORS.dwv])
    }
    if (pipes.some((m) => plumbingPipeColor(m.sourceId) === null)) {
      entries.push(['supply / DWV pipe', def.fill['pipe-run'] ?? '#8fb0c4'])
    }
    const NAMES: Record<string, string> = {
      'vent-stack': 'vent stack',
      'duct-run': 'duct',
      'water-heater': 'water heater',
    }
    for (const role of Object.keys(NAMES)) {
      if (mine.some((m) => m.role === role)) {
        entries.push([NAMES[role] as string, def.fill[role] ?? def.fill.default ?? '#8fb0c4'])
      }
    }
    let row = legendLines.length
    for (const [name, color] of entries) {
      const y = MARGIN + 14 + row * 14
      legendLines.push(
        `<rect x="${MARGIN + 2}" y="${y - 8}" width="10" height="10" fill="${color}" stroke="#444" stroke-width="0.5"/>` +
          `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(name)}</text>`,
      )
      row++
    }
    // Horizontal drainage falls — the drafter's standing note (P3005.3).
    if (mine.some((m) => m.system === 'plumbing')) {
      const y = MARGIN + 14 + row * 14
      legendLines.push(
        `<text x="${MARGIN + 4}" y="${y}" font-size="10" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#333">DWV SLOPE 1/4 IN/FT (P3005.3)</text>`,
      )
    }
  }
  if (def.key === 'electrical' || def.key === 'mep') {
    const TAG_NAMES: Record<string, string> = {
      R: 'receptacle',
      G: 'GFCI receptacle',
      S: 'switch',
      L: 'light',
      SD: 'smoke alarm',
      CU: 'AC condenser (outdoor unit)',
      P: 'panel',
      EF: 'exhaust fan',
      T: 'thermostat',
      SR: 'supply register',
      RA: 'return air',
      SO: 'stub-out',
      VS: 'vent stack',
      WH: 'water heater',
      M: 'water meter',
      EM: 'electric meter',
      AH: 'air handler',
      CO: 'cleanout',
      DS: 'AC disconnect',
    }
    const usedTags = [
      ...new Set(
        devs.map((f) =>
          f.kind === 'equipment' && f.meta?.equipment === 'condenser'
            ? 'CU'
            : (FIXTURE_TAG[f.kind] ?? '·'),
        ),
      ),
    ]
    let trow = legendLines.length
    for (const tag of usedTags) {
      const y = MARGIN + 14 + trow * 14
      legendLines.push(
        `<circle cx="${MARGIN + 7}" cy="${y - 3}" r="6" fill="#fff" stroke="#a05c10" stroke-width="1"/>` +
          `<text x="${MARGIN + 7}" y="${y - 0.5}" font-size="7" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="#a05c10">${esc(tag)}</text>` +
          `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(TAG_NAMES[tag] ?? tag)}</text>`,
      )
      trow++
    }
  }
  if (def.key === 'electrical') {
    const circuits = new Map<string, Fixture | undefined>()
    for (const m of mine) {
      if (m.role === 'wire-run' && !circuits.has(m.sourceId)) {
        // Sample from ALL fixtures, not the sheet's system filter: the AC
        // disconnect is system 'hvac' but carries the circuit's breaker +
        // gauge — devs-only sampling printed 'AC-1 — —A/—AWG', the exact
        // dash pattern round-3 called a defect (dawn round, exhibit 4).
        circuits.set(
          m.sourceId,
          fixtures.find((f) => f.meta?.circuit === m.sourceId),
        )
      }
    }
    let row = legendLines.length
    // EVERY circuit gets a legend row — the old 'row > 22' cap silently
    // dropped LTG-6+/SA-1/2 and the SE cable on 23-circuit sets while
    // their colored runs were drawn (examiner round-4 blocker). Rows past
    // the column cap continue in a SECOND column.
    const CIRCUIT_ROWS_PER_COL = 22
    let circuitIdx = 0
    for (const [circuit, sample] of [...circuits.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const col = Math.floor(circuitIdx / CIRCUIT_ROWS_PER_COL)
      const rowInCol = circuitIdx % CIRCUIT_ROWS_PER_COL
      const colX = MARGIN + col * 230
      const y = MARGIN + 14 + (col === 0 ? row + rowInCol : rowInCol) * 14
      const amps = sample?.meta?.breakerA ?? '—'
      const awg = sample?.meta?.gaugeAwg ?? '—'
      // The SE cable is not a branch circuit — it has no breaker/gauge meta,
      // so the generic row printed '— —A/—AWG · service-entrance' (round-3
      // fixCheck2). Name it like the takeoff books it.
      const text =
        circuit === 'service-entrance'
          ? 'SE cable 2 AWG Cu — street → meter → panel (NEC 230)'
          : `${circuit} — ${amps}A/${awg}AWG · ${circuitZoneHint(circuit)}`
      legendLines.push(
        `<rect x="${colX + 2}" y="${y - 8}" width="10" height="10" fill="${circuitColor(circuit)}" stroke="#444" stroke-width="0.5"/>` +
          `<text x="${colX + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(text)}</text>`,
      )
      circuitIdx++
    }
  }
  if (def.key === 'foundation') {
    const bolts = mine.filter((m) => m.role === 'anchor-bolt')
    if (bolts.length > 0) {
      const y = MARGIN + 14 + legendLines.length * 14
      legendLines.push(
        `<circle cx="${MARGIN + 7}" cy="${y - 3}" r="2.2" fill="#444"/>` +
          `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(`1/2" anchor bolts @ 6'-0" o.c. max — ${bolts.length} pcs`)}</text>`,
      )
    }
    const dowels = mine.filter(
      (m) => m.role === 'rebar' && m.dims[1] > m.dims[0] && m.dims[1] > m.dims[2],
    )
    if (dowels.length > 0) {
      const y = MARGIN + 14 + legendLines.length * 14
      legendLines.push(
        `<circle cx="${MARGIN + 7}" cy="${y - 3}" r="2.6" fill="none" stroke="#444" stroke-width="0.9"/>` +
          `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(`vertical rebar dowels — ${dowels.length} pcs`)}</text>`,
      )
    }
  }
  if (def.key === 'wall' && opts.studSpacingIn) {
    const y = MARGIN + 14 + legendLines.length * 14
    legendLines.push(
      `<text x="${MARGIN + 4}" y="${y}" font-size="10" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(`STUDS @ ${opts.studSpacingIn}" O.C. U.N.O.`)}</text>`,
    )
  }
  // Rafter-spacing note (round-3 C4 carried item): stated from the dominant
  // rafter gap when derivable, spec spacing + VERIFY otherwise.
  if (def.key === 'roof') {
    const note = rafterSpacingNote(mine, opts)
    if (note) {
      const y = MARGIN + 14 + legendLines.length * 14
      legendLines.push(
        `<text x="${MARGIN + 4}" y="${y}" font-size="10" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(note)}</text>`,
      )
    }
  }
  // Printed roof-coverage flag (blueprint round-3): a wing without roof
  // members is invisible on a per-sheet read — call it out on THIS sheet.
  if (def.key === 'roof') {
    const roofWarn = roofCoverageWarning(members)
    if (roofWarn) {
      const y = () => MARGIN + 14 + legendLines.length * 14
      legendLines.push(
        `<text x="${MARGIN + 4}" y="${y()}" font-size="10" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#a03015">${esc('⚑ part of the plan has no roof members —')}</text>`,
      )
      legendLines.push(
        `<text x="${MARGIN + 4}" y="${y()}" font-size="10" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#a03015">${esc('check roof coverage')}</text>`,
      )
    }
  }
  // A-A cut mark (blueprint round-3): the section's cut plane printed on
  // the wall framing plan — dashed line at the SHARED cutX with 'A' bubbles
  // at both ends, so the section can be located on the plan.
  if (def.key === 'wall') {
    const cutX = sectionCutX(members)
    if (cutX !== null) {
      const cx = X(cutX)
      const y0 = MARGIN + 14
      const y1 = MARGIN + (H - 2 * MARGIN - TITLE_H) - 6
      const bubble = (y: number): string =>
        `<circle cx="${cx.toFixed(1)}" cy="${y.toFixed(1)}" r="10" fill="#fff" stroke="#222" stroke-width="1.4"/>` +
        `<text x="${cx.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" font-size="10" font-weight="bold" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="#222">A</text>`
      shapes.push(
        `<line x1="${cx.toFixed(1)}" y1="${(y0 + 10).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(y1 - 10).toFixed(1)}" stroke="#222" stroke-width="1.2" stroke-dasharray="9 4"/>${bubble(y0)}${bubble(y1)}`,
      )
    }
  }

  const legend =
    legendLines.length > 0
      ? `<rect x="${MARGIN - 4}" y="${MARGIN - 6}" width="250" height="${legendLines.length * 14 + 14}" fill="#ffffff" fill-opacity="0.92" stroke="#ccc" stroke-width="0.5"/>${legendLines.join('')}`
      : ''

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${shapes.join('')}${chrome(def.title, opts, scale, legend, { ratio: t.ratio })}</svg>`
  return { title: def.title, svg }
}

/** Schedules sheet: takeoff rows + engineering flags, as printable text. */
// ---------------------------------------------------------------------------
// Cover, elevations, section — the rest of a standard set (round: "standard
// blueprints show side views"). Members are drawn as stroke segments along
// their longest local axis: honest line-art framing, no hidden-face solver.
// ---------------------------------------------------------------------------

type Seg = { x1: number; y1: number; x2: number; y2: number; w: number; depth: number; color: string; dashed?: boolean; opacity?: number }

/** World-space endpoints of a member's longest axis + its stroke thickness. */
function memberAxis(m: Member, lift: number): { a: [number, number, number]; b: [number, number, number]; w: number } {
  const dims = m.dims
  const axis = dims[0] >= dims[1] && dims[0] >= dims[2] ? 0 : dims[1] >= dims[2] ? 1 : 2
  const half = dims[axis] / 2
  const [rx, ry, rz] = m.rotation
  // R = Rx(rx) · Ry(ry) · Rz(rz) applied to e_axis (three.js XYZ order)
  const e: [number, number, number] = [0, 0, 0]
  e[axis] = 1
  const cz = Math.cos(rz)
  const sz = Math.sin(rz)
  let vx = e[0] * cz - e[1] * sz
  let vy = e[0] * sz + e[1] * cz
  let vz = e[2]
  const cy = Math.cos(ry)
  const sy = Math.sin(ry)
  const tx = vx * cy + vz * sy
  vz = -vx * sy + vz * cy
  vx = tx
  const cx = Math.cos(rx)
  const sx = Math.sin(rx)
  const ty = vy * cx - vz * sx
  vz = vy * sx + vz * cx
  vy = ty
  const c: [number, number, number] = [m.position[0], m.position[1] + lift, m.position[2]]
  const w = [...dims].sort((p, q) => q - p)[1] ?? 0.05
  return {
    a: [c[0] - vx * half, c[1] - vy * half, c[2] - vz * half],
    b: [c[0] + vx * half, c[1] + vy * half, c[2] + vz * half],
    w,
  }
}

const SYSTEM_STROKE: Record<string, string> = {
  foundation: '#8b8f96',
  'wall-framing': '#caa06a',
  'floor-framing': '#b98d55',
  'roof-framing': '#a97e48',
  electrical: '#c2803d',
  plumbing: '#6f8fa8',
  hvac: '#8fa8a0',
}

const STROKE_LEGEND_NAMES: Record<string, string> = {
  foundation: 'foundation',
  'wall-framing': 'wall framing',
  'floor-framing': 'floor framing',
  'roof-framing': 'roof framing',
  electrical: 'electrical',
  plumbing: 'plumbing',
  hvac: 'HVAC',
}

/** Rotation-aware x half-extent of a member (yaw only — plan projection). */
function xExtentOf(m: Member): number {
  return (
    (Math.abs(Math.cos(m.rotation[1])) * m.dims[0] +
      Math.abs(Math.sin(m.rotation[1])) * m.dims[2]) /
    2
  )
}

/** |x-component| of the member's unit long axis. Below AXIS_CROSS_MIN the
 * axis lies parallel-ish to the section plane (angle to the plane normal
 * ≥ 60°) — a wall run or stud, not a stick the plane slices across. */
function axisXFrac(m: Member): number {
  const { a, b } = memberAxis(m, 0)
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
  return len < 1e-9 ? 0 : Math.abs(b[0] - a[0]) / len
}

/** cos 60° — members whose axis makes < 60° with the plane normal CROSS it. */
const AXIS_CROSS_MIN = 0.5

/**
 * The section's cut plane: mid X of the member x-position extents, SLID off
 * any member whose axis lies along the plane (blueprint round-3 N3 FAIL: the
 * plan-midpoint plane coincided with the 9 m spine wall's axis and the whole
 * wall + foundation printed as one black silhouette). Steps ±0.3 m up to
 * ±2 m; the nearest offset with the fewest parallel-axis members touching
 * the plane wins — a clear stud bay when one exists. ONE helper shared by
 * sectionSheet and the wall-plan A-A cut mark, so the mark follows the slide.
 */
function sectionCutX(members: Member[]): number | null {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  for (const m of members) {
    minX = Math.min(minX, m.position[0])
    maxX = Math.max(maxX, m.position[0])
  }
  if (!Number.isFinite(minX)) return null
  const mid = (minX + maxX) / 2
  const parallelAt = (cutX: number): number =>
    members.filter(
      (m) => axisXFrac(m) < AXIS_CROSS_MIN && Math.abs(m.position[0] - cutX) <= xExtentOf(m),
    ).length
  let best = mid
  let bestCount = parallelAt(mid)
  for (let step = 0.3; step <= 2.0001 && bestCount > 0; step += 0.3) {
    for (const cand of [mid + step, mid - step]) {
      const count = parallelAt(cand)
      if (count < bestCount) {
        best = cand
        bestCount = count
      }
    }
  }
  return best
}

/**
 * Compact swatch legend of the SYSTEM_STROKE colors drawn on a line-art
 * sheet (blueprint round-3: the examiner couldn't tell rafters from pipes on
 * the elevations). `filter` mirrors the sheet's own memberSegs filter so the
 * legend lists only what that sheet actually shows.
 */
function strokeLegend(members: Member[], filter?: (m: Member) => boolean, yOff = 0): string {
  const systems = new Set<string>()
  for (const m of members) {
    if (m.role === 'wire-run' || m.face) continue // memberSegs skips these
    if (filter && !filter(m)) continue
    systems.add(m.system)
  }
  const present = Object.keys(STROKE_LEGEND_NAMES).filter((s) => systems.has(s))
  if (present.length === 0) return ''
  const rows = present.map((s, i) => {
    const y = MARGIN + 14 + yOff + i * 14
    return (
      `<rect x="${MARGIN + 2}" y="${y - 8}" width="10" height="10" fill="${SYSTEM_STROKE[s]}" stroke="#444" stroke-width="0.5"/>` +
      `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(STROKE_LEGEND_NAMES[s] ?? s)}</text>`
    )
  })
  return `<rect x="${MARGIN - 4}" y="${MARGIN - 6 + yOff}" width="150" height="${present.length * 14 + 14}" fill="#ffffff" fill-opacity="0.92" stroke="#ccc" stroke-width="0.5"/>${rows.join('')}`
}

/**
 * 'Wing has no roof' printed flag (blueprint round-3, reworked round-3
 * scorecard C1): the wall-plan bbox is rasterized into ~1 m cells and a
 * cell counts 'roofed' when ANY roof member's rotation-aware plan bbox
 * overlaps it; >25% unroofed cells fires the warning. The old bbox-AREA
 * ratio could not see an unroofed wing overlapping the roofed body's
 * extents — the demo's 8×5 m west wing evaluated 0.72 ≥ 0.6 and passed
 * silently. Printed on the roof sheet legend AND joined into the schedules
 * flag block.
 */
function roofCoverageWarning(members: Member[]): string | null {
  const roof = members.filter((m) => m.system === 'roof-framing')
  const wall = members.filter((m) => m.system === 'wall-framing')
  if (roof.length === 0 || wall.length === 0) return null
  const wb = planBounds(wall, [])
  if (!wb) return null
  const spanX = Math.max(0, wb.maxX - wb.minX)
  const spanZ = Math.max(0, wb.maxZ - wb.minZ)
  if (spanX * spanZ <= 1) return null
  const nx = Math.max(1, Math.round(spanX))
  const nz = Math.max(1, Math.round(spanZ))
  const boxes: Bounds[] = roof.map((m) => {
    const yaw = m.rotation[1]
    const ex = (Math.abs(Math.cos(yaw)) * m.dims[0] + Math.abs(Math.sin(yaw)) * m.dims[2]) / 2
    const ez = (Math.abs(Math.sin(yaw)) * m.dims[0] + Math.abs(Math.cos(yaw)) * m.dims[2]) / 2
    return {
      minX: m.position[0] - ex,
      maxX: m.position[0] + ex,
      minZ: m.position[2] - ez,
      maxZ: m.position[2] + ez,
    }
  })
  let unroofed = 0
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x0 = wb.minX + (i * spanX) / nx
      const x1 = wb.minX + ((i + 1) * spanX) / nx
      const z0 = wb.minZ + (j * spanZ) / nz
      const z1 = wb.minZ + ((j + 1) * spanZ) / nz
      const roofed = boxes.some((b) => x1 > b.minX && x0 < b.maxX && z1 > b.minZ && z0 < b.maxZ)
      if (!roofed) unroofed++
    }
  }
  if (unroofed / (nx * nz) <= 0.25) return null
  return 'part of the plan has no roof members — check roof coverage'
}

/**
 * Rafter-spacing note for the roof plan legend (round-3 C4 carried item).
 * The spacing reads from the members themselves: rafters are grouped by
 * plan direction (5° buckets, mod π), the dominant group's centers project
 * onto the axis PERPENDICULAR to their run, and the modal gap between
 * neighbours is the layout spacing. When that gap maps onto a standard
 * o.c. spacing (12 / 16 / 19.2 / 24 in) and the mode carries at least half
 * the gaps, the note states it as fact; anything else prints the spec stud
 * spacing suffixed 'VERIFY' — a note an examiner can trust either way.
 */
function rafterSpacingNote(members: Member[], opts: PlanSetOptions): string | null {
  const rafters = members.filter((m) => m.role === 'rafter')
  if (rafters.length === 0) return null
  const fallback = `RAFTERS @ ${opts.studSpacingIn ?? 16}" O.C. — VERIFY`
  // plan yaw from the full euler — mirrors the plan sheet's projection
  const planDir = (m: Member): [number, number] => {
    const [rx, ry, rz] = m.rotation
    const ax = Math.cos(ry) * Math.cos(rz)
    const az = Math.sin(rx) * Math.sin(rz) - Math.cos(rx) * Math.sin(ry) * Math.cos(rz)
    const len = Math.hypot(ax, az)
    return len < 1e-9 ? [1, 0] : [ax / len, az / len]
  }
  const groups = new Map<number, Member[]>()
  for (const r of rafters) {
    const [dx, dz] = planDir(r)
    const yaw = ((Math.atan2(dz, dx) % Math.PI) + Math.PI) % Math.PI // mod π: direction sign is layout-irrelevant
    const key = Math.round((yaw * 36) / Math.PI) % 36 // 5° buckets
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const dom = [...groups.values()].sort((a, b) => b.length - a.length)[0] as Member[]
  if (dom.length < 3) return fallback
  const [dx, dz] = planDir(dom[0] as Member)
  const offsets = dom
    .map((m) => m.position[0] * -dz + m.position[2] * dx) // ⊥ the run axis
    .sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < offsets.length; i++) {
    const gap = (offsets[i] as number) - (offsets[i - 1] as number)
    if (gap > 0.02) gaps.push(gap) // doubled/sistered members aren't a bay
  }
  if (gaps.length < 2) return fallback
  // modal gap: 5mm buckets, most frequent wins
  const buckets = new Map<number, number[]>()
  for (const g of gaps) {
    const key = Math.round(g / 0.005)
    buckets.set(key, [...(buckets.get(key) ?? []), g])
  }
  const mode = [...buckets.values()].sort((a, b) => b.length - a.length)[0] as number[]
  if (mode.length * 2 < gaps.length) return fallback // no dominant gap
  const inches = (mode.reduce((s, g) => s + g, 0) / mode.length) / 0.0254
  const std = [12, 16, 19.2, 24].find((s) => Math.abs(inches - s) <= 0.6)
  return std !== undefined ? `RAFTERS @ ${std}" O.C.` : fallback
}

function memberSegs(
  members: Member[],
  opts: PlanSetOptions,
  proj: (p: [number, number, number]) => [number, number],
  depthOf: (p: [number, number, number]) => number,
  filter?: (m: Member) => boolean,
): Seg[] {
  const segs: Seg[] = []
  for (const m of members) {
    if (m.role === 'wire-run' || m.face) continue // keep line art structural
    if (filter && !filter(m)) continue
    const lift = m.levelId ? (opts.levelBaseY?.[m.levelId] ?? 0) : 0
    const { a, b, w } = memberAxis(m, lift)
    const [x1, y1] = proj(a)
    const [x2, y2] = proj(b)
    segs.push({
      x1,
      y1,
      x2,
      y2,
      w,
      depth: (depthOf(a) + depthOf(b)) / 2,
      color: SYSTEM_STROKE[m.system] ?? '#9a9a9a',
      // below-grade work prints dashed ('hidden' convention)
      dashed: m.system === 'foundation',
    })
  }
  return segs.sort((p, q) => p.depth - q.depth)
}

function fitSegs(segs: Seg[], fixedRatio?: number): { sx: (x: number) => number; sy: (y: number) => number; scale: number; ratio: number } | null {
  if (segs.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const s of segs) {
    minX = Math.min(minX, s.x1, s.x2)
    maxX = Math.max(maxX, s.x1, s.x2)
    minY = Math.min(minY, s.y1, s.y2)
    maxY = Math.max(maxY, s.y1, s.y2)
  }
  const availW = W - 2 * MARGIN - 258
  const availH = H - 2 * MARGIN - TITLE_H - 30
  const raw = Math.min(availW / Math.max(0.1, maxX - minX), availH / Math.max(0.1, maxY - minY))
  const ppm = 96 / 0.0254
  const ratio = fixedRatio ?? (RATIOS.find((r) => ppm / r <= raw) ?? (RATIOS[RATIOS.length - 1] as number))
  const scale = ppm / ratio
  const ox = MARGIN + (availW - (maxX - minX) * scale) / 2
  // Vertical centering in the TRUE free field (round-3 P1: elevations and
  // sections parked the drawing as one band in the upper half): availH keeps
  // its slack for the FIT, but the centering runs from the top margin down
  // to just above the title block — not to the fitting reserve's bottom.
  const fieldBottom = H - TITLE_H - 8 - 12 // title block top, 12px breathing
  const oy = MARGIN + (fieldBottom - MARGIN - (maxY - minY) * scale) / 2
  return { sx: (x) => ox + (x - minX) * scale, sy: (y) => oy + (y - minY) * scale, scale, ratio }
}

function segSvg(segs: Seg[], f: NonNullable<ReturnType<typeof fitSegs>>): string {
  // butt caps for EVERY member stroke (blueprint N2/P3, third round: round
  // caps bulged CMU courses into logs and merged section poché into blobs).
  return segs
    .map((s) => {
      const op = s.opacity ?? (s.dashed ? 0.75 : null)
      return `<line x1="${f.sx(s.x1).toFixed(1)}" y1="${f.sy(s.y1).toFixed(1)}" x2="${f.sx(s.x2).toFixed(1)}" y2="${f.sy(s.y2).toFixed(1)}" stroke="${s.color}" stroke-width="${Math.max(0.7, s.w * f.scale).toFixed(1)}" stroke-linecap="butt"${s.dashed ? ' stroke-dasharray="5 3"' : ''}${op !== null ? ` opacity="${op}"` : ''}/>`
    })
    .join('')
}

/**
 * Right-edge elevation datums (round-3 N2 carried item): GRADE 0.00m,
 * T.O. PLATE +<max wall top> and RIDGE +<max member top> print as leader
 * ticks + tags at the drawing field's right edge — the first thing a plans
 * examiner reads on a side view. Heights come straight from the segs' y
 * extents (projected y = −world y, lifts already applied by memberSegs).
 * Degenerate tags skip: no wall segs → no PLATE; a tag whose tick would
 * land within one text height of the previous kept tag never overprints.
 */
function elevationDatums(segs: Seg[], f: NonNullable<ReturnType<typeof fitSegs>>): string {
  const topOf = (pred: (s: Seg) => boolean): number | null => {
    let top = Number.NEGATIVE_INFINITY
    for (const s of segs) {
      if (!pred(s)) continue
      top = Math.max(top, -s.y1, -s.y2)
    }
    return Number.isFinite(top) ? top : null
  }
  const wallTop = topOf((s) => s.color === SYSTEM_STROKE['wall-framing'])
  const memberTop = topOf(() => true)
  const tags: { h: number; label: string }[] = [{ h: 0, label: 'GRADE 0.00m' }]
  if (wallTop !== null && wallTop > 0.05) {
    tags.push({ h: wallTop, label: `T.O. PLATE +${wallTop.toFixed(2)}m` })
  }
  if (memberTop !== null && memberTop > Math.max(wallTop ?? 0, 0) + 0.05) {
    tags.push({ h: memberTop, label: `RIDGE +${memberTop.toFixed(2)}m` })
  }
  const x0 = W - MARGIN - 258 + 14 // grade line's right end — the field edge
  const parts: string[] = []
  let lastY = Number.POSITIVE_INFINITY
  for (const t of tags) {
    const py = f.sy(-t.h)
    if (Math.abs(lastY - py) < 11) continue // degenerate — would overprint
    lastY = py
    parts.push(
      `<line x1="${x0}" y1="${py.toFixed(1)}" x2="${x0 + 16}" y2="${py.toFixed(1)}" stroke="#222" stroke-width="1.2"/>` +
        `<text x="${x0 + 20}" y="${(py + 3).toFixed(1)}" font-size="9" font-family="Helvetica, Arial, sans-serif" fill="#222">${esc(t.label)}</text>`,
    )
  }
  return parts.join('')
}

const ELEVATIONS: { key: string; title: string; proj: (p: [number, number, number]) => [number, number]; depth: (p: [number, number, number]) => number }[] = [
  { key: 'south', title: 'South elevation (framing)', proj: (p) => [p[0], -p[1]], depth: (p) => -p[2] },
  { key: 'north', title: 'North elevation (framing)', proj: (p) => [-p[0], -p[1]], depth: (p) => p[2] },
  // Standing EAST of the building looking west, north (−z) is screen-RIGHT
  // (blueprint round-2: both sheets printed mirrored).
  { key: 'east', title: 'East elevation (framing)', proj: (p) => [-p[2], -p[1]], depth: (p) => p[0] },
  { key: 'west', title: 'West elevation (framing)', proj: (p) => [p[2], -p[1]], depth: (p) => -p[0] },
]

function elevationSheets(members: Member[], opts: PlanSetOptions): PlanSheet[] {
  const sheets: PlanSheet[] = []
  // one building, one elevation family, ONE scale (round-2: S/N printed
  // 1:100 next to E/W at 1:75) — fit every view, keep the coarsest ratio
  const fits = ELEVATIONS.map((ev) => fitSegs(memberSegs(members, opts, ev.proj, ev.depth)))
  const familyRatio = Math.max(...fits.filter((f) => f !== null).map((f) => f.ratio), 0)
  for (const ev of ELEVATIONS) {
    const segs = memberSegs(members, opts, ev.proj, ev.depth)
    const f = fitSegs(segs, familyRatio || undefined)
    if (!f) continue
    // grade line at world y = 0 (proj y of [x,0,z] is 0 in every elevation)
    const gy = f.sy(0)
    const grade = `<line x1="${MARGIN - 14}" y1="${gy.toFixed(1)}" x2="${W - MARGIN - 258 + 14}" y2="${gy.toFixed(1)}" stroke="#222" stroke-width="2.5"/><text x="${MARGIN - 14}" y="${(gy + 14).toFixed(1)}" font-size="9" font-family="Helvetica, Arial, sans-serif" fill="#222">GRADE</text>`
    sheets.push({
      title: ev.title,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${segSvg(segs, f)}${grade}${elevationDatums(segs, f)}${chrome(ev.title, opts, f.scale, strokeLegend(members), { ratio: f.ratio, northArrow: false })}</svg>`,
    })
  }
  return sheets
}

function sectionSheet(members: Member[], opts: PlanSetOptions): PlanSheet | null {
  if (members.length === 0) return null
  const cutX = sectionCutX(members)
  if (cutX === null) return null
  const BAND = 0.9
  // Poché membership (round-3 N3 rework): the plane must SLICE ACROSS the
  // stick — its extent touches the plane AND its axis is perpendicular-ish
  // to it (angle to the plane normal < 60°). A wall lying along the plane
  // (plates along z, vertical studs) is never solid-poché'd: it renders as
  // beyond-work like the rest of the band. Extents stay rotation-aware
  // (round-2: center-only tests dropped the very walls the cut slices).
  const crossesCut = (m: Member): boolean =>
    Math.abs(m.position[0] - cutX) <= xExtentOf(m) && axisXFrac(m) >= AXIS_CROSS_MIN
  const inBand = (m: Member): boolean => Math.abs(m.position[0] - cutX) < BAND + xExtentOf(m)
  const proj = (p: [number, number, number]): [number, number] => [p[2], -p[1]]
  const depth = (p: [number, number, number]): number => p[0]
  // Section poché (round-3 scorecard N3 rework): EVERY band member prints
  // as light 'beyond' line work at reduced opacity; the cut cross-section
  // is a separate explicit FILLED RECT at the plane∩member intersection.
  // The old whole-member dark recolor made oblique plates print full-length
  // ~1.9 m black bars, and end-on members vanished entirely (a zero-length
  // butt-capped line draws no pixels).
  const beyond: Seg[] = memberSegs(members, opts, proj, depth, inBand).map((s) => ({
    ...s,
    opacity: 0.6,
  }))
  const f = fitSegs(beyond)
  if (!f) return null
  // Cut poché rects: sized from dims + yaw — width ≈ the member's thickness
  // across the view at the cut (an oblique crossing widens by 1/|planUx|,
  // capped at the full projected extent), height ≈ its vertical extent at
  // the cut; centered where the plane actually crosses the axis. Below-grade
  // keeps the dash convention on the OUTLINE (fill stays dark).
  const poche: string[] = []
  for (const m of members) {
    if (m.role === 'wire-run' || m.face) continue // mirror memberSegs
    if (!crossesCut(m)) continue
    const lift = m.levelId ? (opts.levelBaseY?.[m.levelId] ?? 0) : 0
    const { a, b } = memberAxis(m, lift)
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = b[2] - a[2]
    const t = Math.abs(dx) < 1e-9 ? 0.5 : Math.min(1, Math.max(0, (cutX - a[0]) / dx))
    const cz = a[2] + t * dz
    const cyW = a[1] + t * dy
    const dims = m.dims
    const axis = dims[0] >= dims[1] && dims[0] >= dims[2] ? 0 : dims[1] >= dims[2] ? 1 : 2
    const hDim = axis === 0 ? dims[2] : dims[0] // plan cross thickness
    const vDim = axis === 1 ? Math.min(dims[0], dims[2]) : dims[1] // vertical thickness
    const planL = Math.hypot(dx, dz)
    const ux = planL < 1e-9 ? 1 : Math.abs(dx) / planL
    const pitchL = Math.hypot(dx, dy)
    const cosPitch = pitchL < 1e-9 ? 1 : Math.abs(dx) / pitchL
    const sliceW = Math.min(hDim / Math.max(ux, 0.35), Math.abs(dz) + hDim)
    const sliceH = Math.min(vDim / Math.max(cosPitch, 0.35), Math.abs(dy) + vDim)
    const wPx = Math.max(1.5, sliceW * f.scale)
    const hPx = Math.max(1.5, sliceH * f.scale)
    const dashed = m.system === 'foundation' ? ' stroke="#222" stroke-width="0.9" stroke-dasharray="5 3"' : ''
    poche.push(
      `<rect x="${(f.sx(cz) - wPx / 2).toFixed(1)}" y="${(f.sy(-cyW) - hPx / 2).toFixed(1)}" width="${wPx.toFixed(1)}" height="${hPx.toFixed(1)}" fill="#222"${dashed}/>`,
    )
  }
  const gy = f.sy(0)
  const grade = `<line x1="${MARGIN - 14}" y1="${gy.toFixed(1)}" x2="${W - MARGIN - 258 + 14}" y2="${gy.toFixed(1)}" stroke="#222" stroke-width="2.5"/>`
  const title = 'Section A-A (transverse)'
  return {
    title,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${segSvg(beyond, f)}${poche.join('')}${grade}<text x="${MARGIN}" y="${MARGIN + 4}" font-size="11" font-family="Helvetica, Arial, sans-serif" fill="#333">Cut ${BAND.toFixed(1)} m band (plane slid clear of along-plane walls) — dark rects = cut cross-sections the plane slices, light = beyond</text>${chrome(title, opts, f.scale, strokeLegend(members, inBand, 16), { ratio: f.ratio, northArrow: false })}</svg>`,
  }
}

function coverSheet(members: Member[], opts: PlanSetOptions, index: string[]): PlanSheet | null {
  // isometric hero: u = (x − z)·cos30, v = (x + z)·sin30 − y
  const c30 = Math.cos(Math.PI / 6)
  const s30 = Math.sin(Math.PI / 6)
  const segs = memberSegs(
    members,
    opts,
    (p) => [(p[0] - p[2]) * c30, (p[0] + p[2]) * s30 - p[1]],
    (p) => p[0] + p[2] - p[1] * 0.01,
  )
  const f = fitSegs(segs)
  if (!f) return null
  const title = opts.projectName ?? 'Pascal project'
  const lines = [
    `${opts.levelName ?? 'Level'} — full construction set`,
    [opts.jurisdiction, opts.codeName].filter(Boolean).join(' · '),
    `${opts.date ?? ''} · Drafting aid, not engineering — verify with your local building department`,
  ].filter((l) => l.length > 0)
  const indexRows = index
    .map(
      (name, i) =>
        `<text x="${W - MARGIN - 236}" y="${MARGIN + 30 + i * 16}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${i + 2}.  ${esc(name)}</text>`,
    )
    .join('')
  return {
    title: 'Cover',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${segSvg(segs, f)}${strokeLegend(members)}<text x="${W - MARGIN - 236}" y="${MARGIN + 8}" font-size="12" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#111">SHEET INDEX</text><text x="${W - MARGIN}" y="${H - MARGIN}" text-anchor="end" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#555">__SHEET_NO__ · members drawn at model elevations</text>${indexRows}<text x="${MARGIN}" y="${H - MARGIN - 44}" font-size="30" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#111">${esc(title)}</text>${lines
      .map(
        (l, i) =>
          `<text x="${MARGIN}" y="${H - MARGIN - 22 + i * 14}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#444">${esc(l)}</text>`,
      )
      .join('')}</svg>`,
  }
}

function schedulesSheets(
  members: Member[],
  fixtures: Fixture[],
  opts: PlanSetOptions,
): PlanSheet[] {
  // Flags render as their own ⚑ list — the 'Flags · FLAG — 1 ea' rows
  // read as nonsense in the grid (quality C5).
  const rows = computeTakeoff(members, fixtures).filter((r) => r.section !== 'Flags')
  if (rows.length === 0) return []
  const flags = [
    ...new Set([
      ...members.filter((m) => m.flag).map((m) => m.flag as string),
      ...(opts.warnings ?? []),
    ]),
  ]
  const colW = (W - 2 * MARGIN) / 2
  const lineH = 15
  const maxLines = Math.floor((H - 2 * MARGIN - TITLE_H - 24) / lineH)
  // Long rows WRAP to a second line at a word boundary (blueprint round-3:
  // 'R403.1…' ellipsized mid-word) — capacities count LINES, a wrapped row
  // costs 2, and one line of slack per column keeps a 2-line row from ever
  // straddling into the reserved blocks.
  const wrapRow = (text: string, max = 62): string[] => {
    if (text.length <= max) return [text]
    const cut = text.lastIndexOf(' ', max)
    const at = cut > 24 ? cut : max
    const head = text.slice(0, at)
    let rest = text.slice(at).trim()
    if (rest.length > max) {
      const rcut = rest.lastIndexOf(' ', max - 1)
      rest = `${rest.slice(0, rcut > 24 ? rcut : max - 1)}…`
    }
    return [head, rest]
  }
  const wrapped = rows.map((r) => {
    const detail = r.detail && r.detail !== 'linear feet' ? ` (${r.detail})` : ''
    return wrapRow(`${r.section} · ${r.item} — ${r.quantity} ${r.unit}${detail}`)
  })
  const perSheetLines = 2 * (maxLines - 1)
  // The flag block bottom-anchors on the LAST page — shrink that page's
  // line capacity so a full column never runs under the red list
  // (quality round-3: row 41 and the flags overprinted at y≈673). EVERY
  // flag prints: the reserve grows with the list (round-3 scorecard C5:
  // '… +1 more flags' truncated exactly the new roof-coverage safety flag);
  // pagination adds sheets when the shrunken cap overflows.
  // Flag lines wrap at the column width (the blocks live in ONE column now)
  // — flags still print VERBATIM, a long one just takes two lines.
  const flagLines: { text: string; indent: boolean }[] = flags.flatMap((fl) =>
    wrapRow(`⚑ ${fl}`, 92).map((text, k) => ({ text, indent: k > 0 })),
  )
  const flagRows = flagLines.length
  // Building characteristics print just above the flags on the same page —
  // built HERE so the reserve counts the real line total (the citation/notes
  // line WRAPS at the column width instead of clipping, round-3 fixCheck2).
  const charBlockLines: string[] = []
  if (opts.characteristics) {
    const c = opts.characteristics
    // A slab-less model has NO floor area — printing 'Floor area 0.0 m² …
    // Cooling ~0.0 ton' reads as computed fact (round-3 scorecard C5);
    // the area-derived metrics say n/a and point at the no-slab flag.
    const noSlab = c.floorAreaM2 <= 0
    const na = 'n/a — no floor slabs (see flags)'
    charBlockLines.push(
      noSlab
        ? `Floor area & volume ${na} · Envelope ${c.envelopeAreaM2.toFixed(1)} m² net of openings`
        : `Floor area ${c.floorAreaM2.toFixed(1)} m² · Volume ${c.volumeM3.toFixed(1)} m³ · Envelope ${c.envelopeAreaM2.toFixed(1)} m² net of openings`,
      `Windows ${c.windowCount} (${c.windowAreaM2.toFixed(1)} m²) · Doors ${c.doorCount} · Climate zone ${c.insulation.climateZone} · Wall cavity R-${c.insulation.wallR}`,
      noSlab
        ? `Envelope UA ${c.uaWPerK.toFixed(1)} W/K · Design heat loss ${c.designHeatLossW.toFixed(0)} W @ ΔT 22 K · Cooling ${na}`
        : `Envelope UA ${c.uaWPerK.toFixed(1)} W/K · Design heat loss ${c.designHeatLossW.toFixed(0)} W @ ΔT 22 K · Cooling ~${c.coolingTonsEstimate.toFixed(1)} ton (RULE OF THUMB)`,
      // ~100 chars ≈ the column width at 9.5px — WRAPPED, never clipped
      ...wrapRow(
        `${c.insulation.citation} · window U-0.32 assumed (2021 IECC R402.1.2) · schematic — not a Manual J`,
        100,
      ),
    )
  }
  // title + the block's real line count — reserved out of the last page too.
  const charLines = charBlockLines.length > 0 ? charBlockLines.length + 1 : 0
  // P1 balance (round-3 carried): the reserve consumes the SECOND column
  // only — the flag/characteristics blocks bottom-anchor in the right
  // column, the first column keeps its full height, and rows flow beside
  // the blocks before any page is added. The old 2×(shrunk-cap) math
  // halved BOTH columns and shipped ~2/3-empty takeoff sheets.
  const reserve = (flagRows > 0 ? flagRows + 1 : 0) + (charLines > 0 ? charLines + 1 : 0)
  const fullColCap = maxLines - 1
  const reservedColCap = Math.max(4, maxLines - reserve) - 1
  const lastPageCap = fullColCap + reservedColCap
  const totalLines = wrapped.reduce((sum, w) => sum + w.length, 0)
  let pages = 1
  if (totalLines > lastPageCap) {
    pages = 2
    while ((pages - 1) * perSheetLines + lastPageCap < totalLines) pages++
  }
  // Even distribution: filling early pages to 100% left a near-blank
  // flags-only sheet at the end (blueprint P1) — every page carries its
  // line share; the last stays under its flag-shrunk cap (page count grows
  // if wrap fragmentation overflows it).
  let placements: number[][] = []
  for (;;) {
    placements = []
    let cursor = 0
    let linesLeft = totalLines
    for (let p = 0; p < pages - 1; p++) {
      const share = Math.min(perSheetLines, Math.max(2, Math.ceil(linesLeft / (pages - p))))
      const take: number[] = []
      let used = 0
      while (cursor < rows.length && used + (wrapped[cursor] as string[]).length <= share) {
        used += (wrapped[cursor] as string[]).length
        take.push(cursor)
        cursor++
      }
      linesLeft -= used
      placements.push(take)
    }
    const rest: number[] = []
    let restLines = 0
    while (cursor < rows.length) {
      restLines += (wrapped[cursor] as string[]).length
      rest.push(cursor)
      cursor++
    }
    placements.push(rest)
    if (restLines <= lastPageCap) break
    pages++
  }
  // Never ship a nearly-empty trailing sheet (round-3 P1: three ~2/3-empty
  // demo sheets): a last page under 30% fill merges into its predecessor
  // whenever the combined rows still fit the last-page cap.
  const linesOf = (take: number[]): number =>
    take.reduce((sum, i) => sum + (wrapped[i] as string[]).length, 0)
  while (placements.length > 1) {
    const last = placements[placements.length - 1] as number[]
    const prev = placements[placements.length - 2] as number[]
    if (linesOf(last) >= 0.3 * perSheetLines) break
    if (linesOf(prev) + linesOf(last) > lastPageCap) break
    placements.splice(placements.length - 2, 2, [...prev, ...last])
  }
  pages = placements.length
  const sheets: PlanSheet[] = []
  for (const [page, take] of placements.entries()) {
    const pageLineCount = linesOf(take)
    // Last page: the FIRST column may fill to full height; only the second
    // column stops above the reserved blocks. Balanced when there's room.
    const colTarget =
      page === pages - 1
        ? Math.min(
            fullColCap,
            Math.max(Math.ceil(pageLineCount / 2), pageLineCount - reservedColCap),
          )
        : Math.ceil(pageLineCount / 2)
    const cells: string[] = []
    let col = 0
    let line = 0
    for (const i of take) {
      const rowLines = wrapped[i] as string[]
      if (col === 0 && line > 0 && line + rowLines.length > colTarget) {
        col = 1
        line = 0
      }
      for (const [k, text] of rowLines.entries()) {
        const x = MARGIN + col * colW + (k > 0 ? 14 : 0)
        const y = MARGIN + 24 + line * lineH
        cells.push(
          `<text x="${x}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#222">${esc(text)}</text>`,
        )
        line++
      }
    }
    // Flags on the LAST page — ALL of them, bottom-anchored in the SECOND
    // column (the reserve consumes that column's capacity, P1); the reserve
    // grows with the list, so nothing truncates (round-3 scorecard C5: the
    // old '… +N more flags' line dropped exactly the newest safety flag).
    let flagText = ''
    if (page === pages - 1 && flagLines.length > 0) {
      flagText = flagLines
        .map(
          (l, i) =>
            `<text x="${MARGIN + colW + (l.indent ? 12 : 0)}" y="${H - TITLE_H - 40 - (flagLines.length - 1 - i) * 13}" font-size="9.5" font-family="Helvetica, Arial, sans-serif" fill="#a03015">${esc(l.text)}</text>`,
        )
        .join('')
    }
    // BUILDING CHARACTERISTICS block — last page, stacked above the flags
    // (whole-building metrics for HVAC dimensioning; assumptions inline).
    // Lines pre-built above (charBlockLines) so the reserve matches: the
    // notes line WRAPS at the column width, never clips (round-3 fixCheck2).
    let charText = ''
    if (page === pages - 1 && charBlockLines.length > 0) {
      // bottom-anchor above the flag block (or where flags would start) —
      // in the SECOND column, same as the flags (P1 reserve rework)
      const flagsTopY = H - TITLE_H - 40 - Math.max(0, flagLines.length - 1) * 13
      const bottomY = flagLines.length > 0 ? flagsTopY - 18 : H - TITLE_H - 40
      charText = [
        `<text x="${MARGIN + colW}" y="${bottomY - charBlockLines.length * 13}" font-size="10" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#111">BUILDING CHARACTERISTICS</text>`,
        ...charBlockLines.map(
          (l, i) =>
            `<text x="${MARGIN + colW}" y="${bottomY - (charBlockLines.length - 1 - i) * 13}" font-size="9.5" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(l)}</text>`,
        ),
      ].join('')
    }
    const title = pages > 1 ? `Schedules + takeoff (${page + 1}/${pages})` : 'Schedules + takeoff'
    sheets.push({
      title,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><text x="${MARGIN}" y="${MARGIN + 4}" font-size="13" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#111">Material takeoff${pages > 1 ? ` — sheet ${page + 1} of ${pages}` : ''}</text>${cells.join('')}${charText}${flagText}${chrome(title, opts, 40, '', { scaleBar: false })}</svg>`,
    })
  }
  return sheets
}

/** Every sheet the current level's members can support, in print order. */
export function buildPlanSet(
  members: Member[],
  fixtures: Fixture[],
  opts: PlanSetOptions = {},
): PlanSheet[] {
  const t = setTransform(members, fixtures)
  const sheets: PlanSheet[] = []
  if (t) {
    for (const def of PLAN_SHEETS) {
      const sheet = planSheet(def, members, fixtures, opts, t)
      if (sheet) sheets.push(sheet)
    }
  }
  sheets.push(...elevationSheets(members, opts))
  const section = sectionSheet(members, opts)
  if (section) sheets.push(section)
  // The roof-coverage flag prints on the roof sheet AND joins the schedules
  // flag block (opts.warnings handling) so it survives a text-only read.
  const roofWarn = roofCoverageWarning(members)
  const schedOpts = roofWarn
    ? { ...opts, warnings: [...(opts.warnings ?? []), roofWarn] }
    : opts
  sheets.push(...schedulesSheets(members, fixtures, schedOpts))
  const cover = coverSheet(members, opts, sheets.map((sh) => sh.title))
  if (cover) sheets.unshift(cover)
  // SHEET n/N in every title block (blueprint C6) — patch the placeholder
  // after the census is known.
  return sheets.map((sheet, i) => ({
    ...sheet,
    svg: sheet.svg.replaceAll('__SHEET_NO__', `SHEET ${i + 1}/${sheets.length}`),
  }))
}

/** Self-contained printable document — Print → Save as PDF gives the plan set. */
export function planSetHtml(sheets: PlanSheet[], opts: PlanSetOptions = {}): string {
  const pages = sheets
    .map((s) => `<section class="sheet">${s.svg}</section>`)
    .join('\n')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(opts.projectName ?? 'Pascal')} — Full plans (LOD 400)</title>
<style>
  @page { size: letter landscape; margin: 0; }
  html, body { margin: 0; padding: 0; background: #6b7078; }
  .hint { font: 12px Helvetica, Arial, sans-serif; color: #fff; padding: 10px 16px; }
  .sheet { width: ${W}px; height: ${H}px; margin: 12px auto; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.35); page-break-after: always; break-after: page; }
  .sheet svg { display: block; }
  @media print { .hint { display: none; } .sheet { margin: 0; box-shadow: none; } }
</style></head>
<body><div class="hint">Print (⌘P) → Save as PDF for the shareable plan set. ${sheets.length} sheets.</div>
${pages}
</body></html>`
}
