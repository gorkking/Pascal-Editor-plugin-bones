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
    fill: { 'duct-run': '#9aa7b0', default: '#8fb0c4' },
  },
]

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
    eat(m.position[0], m.position[2], Math.max(m.dims[0], m.dims[2]) / 2)
  }
  for (const f of fixtures) eat(f.position[0], f.position[2], 0.2)
  if (!Number.isFinite(minX)) return null
  return { minX, maxX, minZ, maxZ }
}

/** Title block + border + scale bar, shared by every sheet. */
function chrome(title: string, opts: PlanSetOptions, scale: number, extra = ''): string {
  const meterPx = scale
  // Scale-bar length: a round meter count that fits ~180px.
  const meters = Math.max(1, Math.round(180 / Math.max(1e-6, meterPx)))
  const barPx = meters * meterPx
  const by = H - TITLE_H - 18
  return `
  <rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="#222" stroke-width="2"/>
  <g font-family="Helvetica, Arial, sans-serif">
    <rect x="${W - 380}" y="${H - TITLE_H - 8}" width="${372}" height="${TITLE_H}" fill="#fff" stroke="#222"/>
    <text x="${W - 368}" y="${H - TITLE_H + 14}" font-size="15" font-weight="bold" fill="#111">${esc(title)}</text>
    <text x="${W - 368}" y="${H - TITLE_H + 32}" font-size="11" fill="#333">${esc(opts.projectName ?? 'Pascal project')} — ${esc(opts.levelName ?? 'Level')}</text>
    <text x="${W - 368}" y="${H - TITLE_H + 47}" font-size="10" fill="#555">Jurisdiction: ${esc(opts.jurisdiction ?? 'AUTO')}${opts.codeName ? ` — ${esc(opts.codeName)}` : ''} · LOD 400 · Bones${opts.date ? ` · ${esc(opts.date)}` : ''}</text>
    <text x="${W - 368}" y="${H - TITLE_H + 62}" font-size="9" fill="#777">Drafting aid, not engineering — verify with your local building department.</text>
    <g stroke="#222" stroke-width="2">
      <line x1="${MARGIN}" y1="${by}" x2="${MARGIN + barPx}" y2="${by}"/>
      <line x1="${MARGIN}" y1="${by - 5}" x2="${MARGIN}" y2="${by + 5}"/>
      <line x1="${MARGIN + barPx}" y1="${by - 5}" x2="${MARGIN + barPx}" y2="${by + 5}"/>
    </g>
    <text x="${MARGIN + barPx + 8}" y="${by + 4}" font-size="11" fill="#333">${meters} m</text>
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
  const b = planBounds(mine, devs)
  if (!b) return null

  const drawW = W - 2 * MARGIN
  const drawH = H - 2 * MARGIN - TITLE_H
  const spanX = Math.max(0.5, b.maxX - b.minX)
  const spanZ = Math.max(0.5, b.maxZ - b.minZ)
  const scale = Math.min(drawW / spanX, drawH / spanZ)
  const ox = MARGIN + (drawW - spanX * scale) / 2 - b.minX * scale
  const oz = MARGIN + (drawH - spanZ * scale) / 2 - b.minZ * scale
  const X = (x: number) => ox + x * scale
  const Z = (z: number) => oz + z * scale

  const shapes: string[] = []
  // Long members first so short hardware reads on top.
  const sorted = [...mine].sort((a, b2) => b2.dims[0] - a.dims[0])
  for (const m of sorted) {
    const yaw = m.rotation[1]
    const tilt = m.rotation[2]
    const planLen = Math.max(0.02, m.dims[0] * Math.abs(Math.cos(tilt)))
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
  for (const f of devs) {
    const tag = FIXTURE_TAG[f.kind] ?? '·'
    shapes.push(
      `<g transform="translate(${X(f.position[0]).toFixed(1)} ${Z(f.position[2]).toFixed(1)})"><circle r="7" fill="#fff" stroke="#a05c10" stroke-width="1.2"/><text y="3.5" font-size="8" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="#a05c10">${esc(tag)}</text></g>`,
    )
  }

  // Callouts: most common size per role, top-left legend — and on the
  // electrical sheet, the CIRCUIT legend (color swatch, id, breaker/gauge,
  // zone) so wires on paper match the 3D X-ray colors.
  const roleSizes = new Map<string, string>()
  for (const m of mine) {
    if (m.size && !roleSizes.has(m.role)) roleSizes.set(m.role, m.size)
  }
  const legendLines: string[] = [...roleSizes.entries()]
    .slice(0, 8)
    .map(
      ([role, size], i) =>
        `<text x="${MARGIN + 4}" y="${MARGIN + 14 + i * 14}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#333">${esc(role)} — ${esc(size)}</text>`,
    )
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
  const legend = legendLines.join('')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${shapes.join('')}${chrome(def.title, opts, scale, legend)}</svg>`
  return { title: def.title, svg }
}

/** Schedules sheet: takeoff rows + engineering flags, as printable text. */
function schedulesSheet(
  members: Member[],
  fixtures: Fixture[],
  opts: PlanSetOptions,
): PlanSheet | null {
  const rows = computeTakeoff(members, fixtures)
  if (rows.length === 0) return null
  const flags = [...new Set(members.filter((m) => m.flag).map((m) => m.flag as string))]
  const colW = (W - 2 * MARGIN) / 2
  const lineH = 15
  const maxLines = Math.floor((H - 2 * MARGIN - TITLE_H - 24) / lineH)
  const cells: string[] = []
  rows.slice(0, 2 * maxLines).forEach((r, i) => {
    const col = Math.floor(i / maxLines)
    const x = MARGIN + col * colW
    const y = MARGIN + 24 + (i % maxLines) * lineH
    cells.push(
      `<text x="${x}" y="${y}" font-size="10" font-family="Helvetica, Arial, sans-serif" fill="#222">${esc(`${r.section} · ${r.item} — ${r.quantity} ${r.unit}`)}</text>`,
    )
  })
  const flagText = flags
    .slice(0, 4)
    .map(
      (f, i) =>
        `<text x="${MARGIN}" y="${H - TITLE_H - 40 - i * 13}" font-size="9.5" font-family="Helvetica, Arial, sans-serif" fill="#a03015">⚑ ${esc(f)}</text>`,
    )
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/><text x="${MARGIN}" y="${MARGIN + 4}" font-size="13" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="#111">Material takeoff</text>${cells.join('')}${flagText}${chrome('Schedules + takeoff', opts, 40)}</svg>`
  return { title: 'Schedules + takeoff', svg }
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
  const schedules = schedulesSheet(members, fixtures, opts)
  if (schedules) sheets.push(schedules)
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
