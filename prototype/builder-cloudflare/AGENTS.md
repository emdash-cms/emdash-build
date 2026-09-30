# EmDash blank builder scaffold

This is a deliberately blank public site built with Astro, Tailwind CSS 4, and EmDash CMS. React is configured because the EmDash admin requires it; public pages must remain Astro-only.

The site builder is expected to create the content architecture, schema, pages, components, and visual design from the user's brief. `seed/seed.json` is explicitly empty so EmDash does not apply its built-in starter schema. Nothing in this scaffold is a required visual style.

## Commands

```bash
pnpm dev                  # managed by EmDash Build; do not start it yourself
pnpm exec emdash types    # refresh emdash-env.d.ts after schema changes
pnpm validate:frontend    # reject React/JSX hydration in public code
pnpm typecheck            # Astro and TypeScript validation
pnpm validate             # both checks
```

The admin UI is at `/_emdash/admin`.

## Protected infrastructure

Do not edit these files during ordinary site building:

- `src/worker.ts`
- `src/live.config.ts`
- `wrangler.jsonc`
- `.dev.vars`

Do not replace `astro.config.mjs`. EmDash Build manages its bindings, preview HMR, and SSR optimiser settings. A targeted font entry change is allowed only when necessary.

You may freely create and rewrite public-site code in:

- `src/pages/`
- `src/layouts/`
- `src/components/`
- `src/styles/`

## No React on public routes

- Public pages, layouts, and components use `.astro`, CSS, and vanilla browser scripts.
- Do not import `react`, `react-dom`, JSX, or TSX from public-site code.
- Do not use Astro `client:*` directives on public routes.
- React is reserved for EmDash admin and plugin-admin code.
- Run `pnpm validate:frontend` before completion.

## Schema decision guide

Content editors should be able to change ordinary site content without editing source code.

| Need                                                  | EmDash model               |
| ----------------------------------------------------- | -------------------------- |
| Site name, tagline, logo, favicon, social links       | Settings                   |
| Header/footer navigation                              | Menus                      |
| Repeated independently managed things                 | Collection                 |
| Grouping/filtering/archive dimensions                 | Taxonomy                   |
| Long-form prose with flexible structure               | Portable Text field        |
| Relationship between entries                          | Reference field            |
| Structured reorderable page section                   | First-class `blocks` field |
| Layout, colour, typography, spacing, responsive rules | Astro/Tailwind code        |

Good collection candidates include products, services, posts, projects, people, events, locations, and testimonials. Do not create a collection for a one-off decorative section. Avoid JSON fields for ordinary structured content; they are harder for editors and generated renderers to keep correct.

Start with the smallest schema that represents the real organisation. Field slugs are lowercase snake_case. Every field must have a useful admin label and a corresponding renderer. Add `drafts`, `revisions`, `search`, and `seo` only where editors benefit from them.

Schema must be created through `apply_schema_plan`, which applies subject-specific block definitions, collections, and fields in one idempotent pass with one persistence checkpoint. A successful plan regenerates `emdash-env.d.ts` and returns its declarations; write typechecked queries and block renderers from those names. After other schema changes, run `refresh_types`, which returns them too.

When several independent whole-file sources are ready together, use `write_files`. When several exact targeted corrections are ready together, apply them with `edit_files`, including multiple replacements in the same file; read first any affected file you have not read or written in this turn. Each batch gets one preview reload and one Artifacts checkpoint. Use `write_file` or `edit_file` for one change, and keep dependent mutations in order.

## EmDash rendering patterns

All content pages are server-rendered. Never use `getStaticPaths()` for CMS content.

Collection query:

```astro
---
import { getEmDashCollection } from "emdash";

const { entries: products, cacheHint } = await getEmDashCollection("products", {
	orderBy: { created_at: "asc" },
});
Astro.cache.set(cacheHint);
---
```

Single entry:

```astro
---
import { getEmDashEntry } from "emdash";

const { slug } = Astro.params;
if (!slug) return Astro.redirect("/404");
const { entry, cacheHint } = await getEmDashEntry("products", slug);
if (!entry) return Astro.redirect("/404");
Astro.cache.set(cacheHint);
---
```

Critical distinctions:

- `entry.id` is the slug used in URLs.
- `entry.data.id` is the database ULID used for API relationships.
- Image fields are objects, not strings. Use `<Image image={entry.data.image} />` from `emdash/ui`.
- Portable Text fields render through `<RichText value={entry.data.content} />` from `src/components/ui/RichText.astro`, which wraps EmDash's `PortableText` with prose styles; Tailwind's reset leaves bare `PortableText` output unstyled.
- Spread `entry.edit.FIELD_NAME` onto visible editable fields when available.
- Taxonomy names in queries must exactly match the schema's singular name.
- Always call `Astro.cache.set(cacheHint)` for queried content.

### First-class blocks

A `blocks` field stores ordered structured page sections. Portable Text is prose inside a section; Astro owns markup and visual design. Do not ship a generic block catalogue. Create types that match the brief.

Use the generated field union and these fixed paths:

```text
src/components/blocks/index.ts
src/components/blocks/<block_slug>/index.astro
src/components/blocks/<block_slug>/vN.astro
```

Each `vN.astro` receives `BlockComponentProps<Extract<TypeBlockUnion, { _version: N }>>`. The `_type` dispatcher receives `BlockComponentProps<TypeBlockUnion>` and must use the source-owned helper:

```astro
---
import type { BlockComponentProps } from "emdash/ui";
import type { PageLayoutBlock } from "../../../../emdash-env";
import { defineBlockVersionComponents, resolveBlockVersionComponent } from "../../ui/block-versions";
import V1 from "./v1.astro";

type TypeBlock = Extract<PageLayoutBlock, { _type: "bakery_intro" }>;
type Props = BlockComponentProps<TypeBlock>;
const props = Astro.props;
const versions = defineBlockVersionComponents<TypeBlock>({ 1: V1 });
const Component = resolveBlockVersionComponent(props.value, versions);
---
<Component {...props} />
```

`src/components/blocks/index.ts` imports every fixed dispatcher and exports one exhaustive `defineBlockComponents<FieldBlockUnion>` map named `<collection>_<field>`, for example `pages_layout`. Routes import that exact export and pass it directly:

```astro
<Blocks value={page.data.layout} components={pages_layout} fallback={MissingBlock} />
```

Provide a safe production fallback such as `MissingBlock`, while keeping exhaustive validated mappings as the primary contract.

Create block content only after these renderers exist. Initial values omit `_key` and `_version`. Follow-up edits read the current entry and `_rev`, preserve every surviving `_key`, `_type`, `_version`, untouched value, and order, and move whole keyed objects when reordering.

The shared layout must retain `EmDashHead`, `EmDashBodyStart`, and `EmDashBodyEnd` with `createPublicPageContext()`. `src/layouts/SiteLayout.astro` demonstrates the required wiring and may be visually rewritten. `src/pages/404.astro` is the not-found page the examples above redirect to; it uses `SiteLayout` and the theme tokens, so keep it.

Use `getSiteSettings()` and `getMenu()` for site identity and navigation. Do not hard-code them in the layout.

## UI primitives

Source-owned accessible Astro primitives live in `src/components/ui/`. Read their `README.md` before use. They are adapted from Accessible Astro Components under the MIT licence recorded in `THIRD_PARTY_NOTICES.md`.

These primitives solve behaviour and semantics, not page composition. Create subject-specific Astro components for heroes, galleries, product lists, stories, calls to action, and footers. Tailwind 4 is configured through `src/styles/global.css`.

When changing a primitive, preserve native semantics, labels, keyboard behaviour, focus visibility, and reduced-motion handling.

## Build order

1. Infer the site's real content entities and routes from the brief.
2. Create all block definitions, collections, and fields in one `apply_schema_plan` call.
3. Update settings and create menus.
4. From the generated types the plan returns, create exhaustive block dispatchers/maps before block content.
5. Create the shared layout and homepage using real CMS queries.
6. Create and publish representative content for the requested views. Add media when the subject needs it, and taxonomy terms only when classification is part of the site.
7. Add the list/detail and narrative routes the brief requires. Keep navigation free of dead links.
8. Run `validate_site`.
9. Inspect the live preview, correct the design, validate again, and inspect the final result.

Never expose credentials to the sandbox or place secrets in source files.
