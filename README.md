<p align="center">
  <img src="assets/bones-icon.png" alt="Bones" width="128" />
</p>

<h1 align="center">Bones</h1>

<p align="center"><strong>The structural skeleton of your Pascal house.</strong><br/>
A <a href="https://github.com/pascalorg/editor">Pascal editor</a> plugin that infers what a house is actually <em>made of</em> — studs, plates, headers, joists, rafters, concrete — and shows it in 3D.</p>

---

## What it does

**Today (v0.1 — MVP):**

- **Lumber** — place real dimensional lumber members (2x4 … 6x6) at actual dressed
  dimensions, as studs (vertical), plates (flat), or joists (edge). A left-rail
  **Bones** panel drives placement; the inspector edits size, orientation, and length.

**Next (see [SPEC.md](SPEC.md) for the full roadmap):**

- **Wall framing inference** — studs at 16"/24" o.c., top/bottom plates, and around
  every opening: kings, trimmers, headers (auto-sized by span), sills, and cripples —
  generated automatically from the walls you already drew.
- **Floor & roof framing** — joists, rim, girders; rafters, ridge, hips, valleys,
  ceiling joists, collar ties — solved from Pascal's slabs and roofs.
- **Foundation** — stemwalls, footings, slab edges, mudsills, anchor bolts.
- **X-ray mode & takeoff** — peel the drywall off any house; count the lumber that
  came out of the actual generated members, not an estimate.

Inspired by the excellent prior framing tools by
the framing trade — plans, not pictures.

## Publisher

- **Author:** Julien Brissonneau — [@Snoopy147](https://github.com/Snoopy147)
- **Support:** [GitHub issues](https://github.com/pascalorg/plugin-bones/issues)
- **License:** MIT

## Capabilities & data

- Registers node kinds under the `bones:` namespace (`bones:lumber` today) and one
  editor panel ("Bones").
- **No external origins, no network calls, no accounts, no personal data.** Everything
  is computed locally from the scene graph.
- Persisted project data: only the plugin's own nodes (their size / length /
  orientation / transform), stored in the scene JSON like any built-in node.
- Renderer and panel entry points are lazy — loading plugin metadata initializes no
  runtime code.

## Structure

Follows the [plugin authoring contract](https://editor.pascal.app/docs/developers/plugins)
and the layout of the first-party [Nature plugin](https://github.com/pascalorg/plugin-trees):
one npm package (`@pascal-app/plugin-bones`), `@pascal-app/*` / React / Three.js as peer
dependencies, TypeScript source shipped directly (hosts transpile).

```
src/
  index.ts        plugin manifest (bonesPlugin) + host panel (bonesHostPanel)
  schema.ts       LumberNode zod schema (bones:lumber)
  definition.ts   NodeDefinition: capabilities, inspector, renderer, tool
  lumber.ts       nominal → actual dressed dimensions catalog
  renderer.tsx    per-node parametric renderer
  tool.tsx        placement tool  ·  preview.tsx placement ghost
  panel.tsx       the Bones left-rail panel
  store.ts        placement brush (zustand)
```

## Develop

```bash
bun install
bun run check-types
bun test
```

## Load in a host

```ts
import { extendPluginDiscovery } from '@pascal-app/core'

extendPluginDiscovery(async () => {
  const { bonesPlugin } = await import('@pascal-app/plugin-bones')
  return [bonesPlugin]
})
```

and register the panel where the host registers plugin panels:

```ts
import { registerEditorHostPanel } from '@pascal-app/editor'
import { bonesHostPanel } from '@pascal-app/plugin-bones'

registerEditorHostPanel(bonesHostPanel)
```
