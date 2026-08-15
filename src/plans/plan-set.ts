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
import { computeTakeoff } from '../engines/takeoff'
import { circuitColor, circuitZoneHint } from './circuit-colors'

export type PlanSheet = { title: string; svg: string }

export type PlanSetOptions = {
  projectName?: string
  levelName?: string
  jurisdiction?: string
  /** Resolved code name, e.g. "2023 FBC — Residential (2021 IRC base)". */
  codeName?: string
  /** Preformatted date string for the title block. */
  date?: string
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
    fill: { 'duct-run': '#9aa7b0', 'vent-stack': '#6e8fa0', 'pipe-run': '#8fb0c4', default: '#8fb0c4' },
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
  equipment: 'AH',
  cleanout: 'CO',
}

const esc = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

const deg = (rad: number): number => (rad * 180) / Math.PI

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
  { scaleBar = true }: { scaleBar?: boolean } = {},
): string {
  const meterPx = scale
  const meters = Math.max(1, Math.round(180 / Math.max(1e-6, meterPx)))
  const barPx = meters * meterPx
  const by = H - TITLE_H - 18
  // Two wrapped code lines instead of one overflowing one (quality C1:
  // the effective date clipped off the sheet edge on every sheet).
  const code = opts.codeName ?? ''
  const line1 = clip(`Jurisdiction: ${opts.jurisdiction ?? 'AUTO'}${code ? ` — ${code.slice(0, 46)}` : ''}`, 66)
  const line1b = code.length > 46 ? clip(code.slice(46).trim(), 66) : ''
  const line2 = clip(`LOD 400 · Bones${opts.date ? ` · ${opts.date}` : ''}`, 66)
  const bar = scaleBar
    ? `<g stroke="#222" stroke-width="2">
      <line x1="${MARGIN}" y1="${by}" x2="${MARGIN + barPx}" y2="${by}"/>
      <line x1="${MARGIN}" y1="${by - 5}" x2="${MARGIN}" y2="${by + 5}"/>
      <line x1="${MARGIN + barPx}" y1="${by - 5}" x2="${MARGIN + barPx}" y2="${by + 5}"/>
    </g>
    <text x="${MARGIN + barPx + 8}" y="${by + 4}" font-size="11" fill="#333">${meters} m</text>`
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
    <text x="${W - 368}" y="${H - TITLE_H + 68}" font-size="8" fill="#777">Drafting aid, not engineering — verify with your local building department.</text>
    ${bar}
    ${extra}
  </g>`
}

/** One top-view plan sheet for the given systems. */
function planSheet(
  def: (typeof PLAN_SHEETS)[number],
  members: Member[],
  fixtures: Fixture[],
  opts: PlanSetOptions,
): PlanSheet | null {
  const mine = members.filter((m) => def.systems.includes(m.system))
  const devs = fixtures.filter((f) => def.systems.includes(f.system))
  if (mine.length === 0 && devs.length === 0) return null
  // Wall footprint context: MEP runs floating on white are unreadable —
  // draw the bottom plates as light gray underlay (quality round-2 C3).
  const context = CONTEXT_SHEETS.has(def.key)
    ? members.filter((m) => m.system === 'wall-framing' && m.role === 'bottom-plate')
    : []
  const b = planBounds([...mine, ...context], devs)
  if (!b) return null

  // Legend gutter: sheets with a legend reserve a left strip so the
  // backing never erases geometry (quality round-2).
  const hasLegend = def.key === 'electrical' || mine.some((m) => m.size)
  const gutter = hasLegend ? 258 : 0
  const drawW = W - 2 * MARGIN - gutter
  const drawH = H - 2 * MARGIN - TITLE_H
  const spanX = Math.max(0.5, b.maxX - b.minX)
  const spanZ = Math.max(0.5, b.maxZ - b.minZ)
  const scale = Math.min(drawW / spanX, drawH / spanZ)
  const ox = MARGIN + gutter + (drawW - spanX * scale) / 2 - b.minX * scale
  const oz = MARGIN + (drawH - spanZ * scale) / 2 - b.minZ * scale
  const X = (x: number) => ox + x * scale
  const Z = (z: number) => oz + z * scale

  const shapes: string[] = []
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
    const fill =
      m.system === 'electrical' && m.role === 'wire-run'
        ? circuitColor(m.sourceId)
        : (def.fill[m.role] ?? def.fill.default ?? '#ddd')
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
    const tag = FIXTURE_TAG[f.kind] ?? '·'
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
    const seenRoles = new Map<string, string>()
    for (const m of mine) {
      if (!seenRoles.has(m.role)) {
        seenRoles.set(m.role, def.fill[m.role] ?? def.fill.default ?? '#8fb0c4')
      }
    }
    let row = legendLines.length
    const NAMES: Record<string, string> = {
      'pipe-run': 'supply / DWV pipe',
      'vent-stack': 'vent stack',
      'duct-run': 'duct',
    }
    for (const [role, color] of seenRoles) {
      const y = MARGIN + 14 + row * 14
      legendLines.push(
        `<rect x="${MARGIN + 2}" y="${y - 8}" width="10" height="10" fill="${color}" stroke="#444" stroke-width="0.5"/>` +
          `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(NAMES[role] ?? role)}</text>`,
      )
      row++
    }
  }
  if (def.key === 'electrical') {
    const circuits = new Map<string, Fixture | undefined>()
    for (const m of mine) {
      if (m.role === 'wire-run' && !circuits.has(m.sourceId)) {
        circuits.set(
          m.sourceId,
          devs.find((f) => f.meta?.circuit === m.sourceId),
        )
      }
    }
    let row = legendLines.length
    for (const [circuit, sample] of [...circuits.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const y = MARGIN + 14 + row * 14
      const amps = sample?.meta?.breakerA ?? '—'
      const awg = sample?.meta?.gaugeAwg ?? '—'
      legendLines.push(
        `<rect x="${MARGIN + 2}" y="${y - 8}" width="10" height="10" fill="${circuitColor(circuit)}" stroke="#444" stroke-width="0.5"/>` +
          `<text x="${MARGIN + 17}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(`${circuit} — ${amps}A/${awg}AWG · ${circuitZoneHint(circuit)}`)}</text>`,
      )
      row++
      if (row > 22) break
    }
  }
  const legend =
    legendLines.length > 0
      ? `<rect x="${MARGIN - 4}" y="${MARGIN - 6}" width="250" height="${legendLines.length * 14 + 14}" fill="#ffffff" fill-opacity="0.92" stroke="#ccc" stroke-width="0.5"/>${legendLines.join('')}`
      : ''

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${shapes.join('')}${chrome(def.title, opts, scale, legend)}</svg>`
  return { title: def.title, svg }
}

/** Schedules sheet: takeoff rows + engineering flags, as printable text. */
function schedulesSheets(
  members: Member[],
  fixtures: Fixture[],
  opts: PlanSetOptions,
): PlanSheet[] {
  // Flags render as their own ⚑ list — the 'Flags · FLAG — 1 ea' rows
  // read as nonsense in the grid (quality C5).
  const rows = computeTakeoff(members, fixtures).filter((r) => r.section !== 'Flags')
  if (rows.length === 0) return []
  const flags = [...new Set(members.filter((m) => m.flag).map((m) => m.flag as string))]
  const colW = (W - 2 * MARGIN) / 2
  const lineH = 15
  const maxLines = Math.floor((H - 2 * MARGIN - TITLE_H - 24) / lineH)
  const perSheet = 2 * maxLines
  const pages = Math.max(1, Math.ceil(rows.length / perSheet))
  const sheets: PlanSheet[] = []
  for (let page = 0; page < pages; page++) {
    const slice = rows.slice(page * perSheet, (page + 1) * perSheet)
    const cells: string[] = []
    slice.forEach((r, i) => {
      const col = Math.floor(i / maxLines)
      const x = MARGIN + col * colW
      const y = MARGIN + 24 + (i % maxLines) * lineH
      const detail = r.detail && r.detail !== 'linear feet' ? ` (${r.detail})` : ''
      cells.push(
        `<text x="${x}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#222">${esc(clip(`${r.section} · ${r.item} — ${r.quantity} ${r.unit}${detail}`, 62))}</text>`,
      )
    })
    // Flags on the LAST page; overflow called out, never silently dropped
    // (round-14: a 60-wall house lost 11 rows and most flags).
    let flagText = ''
    if (page === pages - 1 && flags.length > 0) {
      const shown = flags.slice(0, 6)
      const parts = shown.map(
        (f, i) =>
          `<text x="${MARGIN}" y="${H - TITLE_H - 40 - (shown.length - 1 - i) * 13}" font-size="9.5" font-family="Helvetica, Arial, sans-serif" fill="#a03015">⚑ ${esc(f)}</text>`,
      )
      if (flags.length > shown.length) {
        parts.push(
          `<text x="${MARGIN}" y="${H - TITLE_H - 40 + 13}" font-size="9.5" font-family="Helvetica, Arial, sans-serif" fill="#a03015">… +${flags.length - shown.length} more flags — see the panel takeoff</text>`,
        )
      }
      flagText = parts.join('')
    }
    const title = pages > 1 ? `Schedules + takeoff (${page + 1}/${pages})` : 'Schedules + takeoff'
    sheets.push({
      title,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><text x="${MARGIN}" y="${MARGIN + 4}" font-size="13" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#111">Material takeoff${pages > 1 ? ` — sheet ${page + 1} of ${pages}` : ''}</text>${cells.join('')}${flagText}${chrome(title, opts, 40, '', { scaleBar: false })}</svg>`,
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
  const sheets: PlanSheet[] = []
  for (const def of PLAN_SHEETS) {
    const sheet = planSheet(def, members, fixtures, opts)
    if (sheet) sheets.push(sheet)
  }
  sheets.push(...schedulesSheets(members, fixtures, opts))
  return sheets
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
