# EmDash Build

Status: Draft

> **Note:** The "Architecture", "Bootstrap Sequence", "Sandbox Lifecycle", and "Implementation Plan 1.2/1.4" sections reflect the current design (standalone template scaffolding via `emdash-cms/templates`). Later sections including the tool table and worked examples still describe an earlier design that used a monorepo clone, `select_theme`, and `apply_seed` tools — treat those as historical context, not the current implementation.
>
> **Blank-builder prototype:** New projects use the local `prototype/builder-cloudflare` scaffold. It gives the agent an explicit empty EmDash schema, Tailwind, and source-owned accessible Astro primitives so it can generate the public design rather than select one. Existing Artifacts-backed projects retain their original scaffold. The template-selection material below documents the previous architecture.

## Summary

A vibe coding platform for EmDash sites. Users describe the site they want in a chat interface and an AI agent designs the content schema, generates editable content, builds a custom Astro/Tailwind frontend, and produces a working EmDash site with a live preview. The user iterates via conversation ("add a blog section", "make the accent color teal") and can deploy the result to Cloudflare.

Think bolt.new / VibeSDK, but purpose-built for CMS sites: generated presentation remains coupled to an editor-friendly EmDash schema, accessible source primitives, and visual validation.

This is distinct from the Playground (PLAYGROUND.md), which gives users a pre-built site to explore. The vibe coding platform creates a new site from a text prompt.

## Goals

- **Wow demo**: Someone types a description, hits enter, and watches a real site materialize in real-time. The thinking streams, tool calls appear, the preview updates. Impressive enough for a conference keynote or blog post.
- **Good product**: The result is a real CMS site with an admin panel, not a static mockup. The user can manage content, add pages, and edit everything after the AI finishes.
- **Quality floor**: Generated sites start from accessible, source-owned Astro primitives and a strict EmDash authoring contract. Typechecking, frontend-boundary validation, and repeated screenshot review constrain freeform generation without forcing every brief through one predesigned layout.
- **Cloudflare showcase**: Workers AI, Containers/Sandbox, D1, R2, AI Gateway, Agents SDK all in one product.

## Non-goals (v1)

- Building arbitrary applications unrelated to an editable EmDash content model
- Multi-user collaboration on the same build session
- Building non-EmDash sites
- Self-hosting (this runs on Cloudflare infrastructure)

## User Experience

### Landing

The user opens `build.emdashcms.com` (or whatever the URL is). They see:

- A large text input in the center of the screen: "Describe the site you want to build"
- Below it, 6-8 quick-start cards with example site types. Each card has a thumbnail preview (a screenshot of what that type of site looks like with one of the designer themes), a title ("Photography Portfolio", "Restaurant", "Tech Blog"), and a one-line description. The screenshots are copied from the ones linked in the readme. Clicking a card fills the input with a detailed prompt.
- A subtle "Powered by EmDash CMS + Cloudflare" footer.
- No signup, no login. Just the prompt.

While the user is typing (or browsing the cards), the sandbox is already spinning up in the background. By the time they hit enter, the dev environment may be ready or close to it.

### Building

The user hits enter (or clicks "Build"). The screen transitions to a two-panel layout:

```
+-----------------------------+-----------------------------+
|                             |                             |
|  Chat                       |  Preview                    |
|                             |                             |
|  [Thinking...]              |  [Loading spinner]          |
|                             |                             |
|  Choosing the portfolio     |                             |
|  theme -- this is a visual- |                             |
|  heavy site that needs to   |                             |
|  let the images speak...    |                             |
|                             |                             |
|  > Applying theme...        |  [Site appears here]        |
|  > Creating content...      |                             |
|  > Customizing colors...    |                             |
|                             |                             |
|  Done! Your site is ready.  |                             |
|  I created a photography    |                             |
|  portfolio with...          |                             |
|                             |                             |
|  [type a message...]        |  [url bar: /]     [refresh] |
+-----------------------------+-----------------------------+
```

**What the user sees in the chat panel (in order):**

1. **Their prompt** appears as a sent message.

2. **"Setting up your environment..."** -- a system message while the sandbox initializes (if it wasn't ready). This step is hidden if the sandbox was pre-warmed during the landing page. The user should ideally never see this.

3. **Thinking** -- the AI's reasoning streams in, rendered as markdown. It's collapsible and auto-collapses once the first tool call starts. Shows what the AI is considering: "This sounds like a photography portfolio. The portfolio theme would be ideal -- it has project cards with hover overlays and a gallery layout. I'll organize projects by location and season since this is an Iceland photographer..."

4. **Tool calls appear as compact cards:**

   ```
   [theme icon] Selected theme: Portfolio
   Elegant gallery with Playfair Display headings, purple accent, project cards
   ```

   ```
   [seed icon] Applied content
   2 collections (Projects, Pages) -- 5 projects, 2 pages
   4 taxonomies -- Location (3 terms), Season (4 terms), Technique, Mood
   ```

   ```
   [paint icon] Customized design
   Dark background, teal accent (#64b5c6), adjusted for photography
   ```

   Each card has a expand/collapse toggle to show the full details (the JSON, the CSS variables, etc.) for users who want to see what happened.

5. **The agent's summary** -- a conversational message explaining what was built, what design decisions were made, and what the user can do next. Not a dry list of changes -- a brief, opinionated explanation: "I went with a dark theme to let the landscapes stand out, and organized your projects by Iceland's regions. The accent color is a cool teal that complements the natural scenery."

6. **Suggestions** -- 2-3 clickable suggestions for what to do next: "Add a blog section", "Change the accent color", "View the admin panel". These give the user an obvious next step.

**What the user sees in the preview panel:**

1. Initially: a loading state or the unstyled starter site (if the sandbox was ready before the agent started).
2. After theme selection: the preview refreshes and shows a styled site (with minimal placeholder content from the starter seed).
3. After seed application: the preview refreshes again and shows the fully populated site with the AI-generated content, images, navigation, etc.
4. The preview has a simple URL bar at the top so the user can navigate around the generated site -- click on a project, go to the about page, browse by category. This is a real Astro site running in the sandbox, not a screenshot.

The whole sequence -- from hitting "Build" to seeing a complete site -- should take 15-30 seconds if the sandbox is warm, 1-3 minutes if cold. The streaming reasoning and tool calls keep the user engaged during this time.

### Iterating

After the initial build, the chat input stays active. The user can refine the site:

**Content model changes:**

- "Add a blog section for behind-the-scenes posts" -- the agent adds a `posts` collection, creates sample posts, adds a blog link to the nav, and (if needed) creates a posts listing page.
- "I need a contact page with my email and studio address" -- the agent creates a page with rich content, adds it to the navigation.
- "Add pricing tiers for print sales" -- the agent creates a new collection or a structured page with pricing data.

**Design tweaks:**

- "Make the accent color more warm -- like a sunset orange" -- the agent updates CSS variables, preview refreshes.
- "The headings feel too formal, use a sans-serif instead" -- the agent swaps the heading font.
- "Can you make the homepage show larger images?" -- the agent edits the homepage component or CSS to adjust the grid/sizing.

**Content edits:**

- "Change the site title to 'Northern Light Studio'" -- the agent updates the site settings.
- "The about page should mention that I've been photographing Iceland for 12 years" -- the agent edits the about page content.
- "Add a project about the Westfjords in winter" -- the agent creates a new project entry with appropriate content and images.

**Questions:**

- "How do I add more projects after this?" -- the agent explains the admin panel and how to use it.
- "Can I use my own domain?" -- the agent explains the deployment process.

Each iteration follows the same pattern: the user types, the AI thinks, tool calls execute, the preview updates. The conversation builds up naturally and the user can scroll back to see what was done.

### The Admin Panel

At any point, the user can click "Open Admin" to see the full EmDash admin panel running inside the sandbox. This is a real admin UI where they can:

- Edit content in a rich text editor
- Upload images (stored in the sandbox)
- Create new posts/pages
- Manage taxonomies, menus, widgets
- Edit site settings

Changes made in the admin are immediately visible in the preview (same database). The admin panel demonstrates that this isn't a static mockup -- it's a real CMS they'll own after deployment.

### Deploying (Phase 2)

When the user is happy with the site, they click "Deploy to Cloudflare." This:

1. Provisions a D1 database and R2 bucket on their Cloudflare account (they'll need to authenticate with Cloudflare at this point).
2. Deploys the Astro site + EmDash to a Workers project.
3. Migrates the seed data to the production D1 database.
4. Downloads media from Unsplash URLs and uploads to R2.
5. Gives the user a live URL: `your-site.cloudflare.dev`

The deployed site includes the admin panel at `/_emdash/admin`. The user sets up their own admin account (passkey registration) and they're fully independent -- no ongoing dependency on the vibe platform.

### Returning

Sessions are ephemeral by default (sandbox TTL ~1 hour). The chat history is preserved in the agent's Durable Object for longer. If a user returns to their session URL within the TTL, they pick up where they left off -- same chat, same preview, same site.

After the TTL expires, the sandbox is gone but the conversation remains. The user could start a new build with context from the previous conversation, or deploy a new site from their exported seed.

## Architecture

### Overview

```
Browser
  |
  +-- Chat UI (React, useAgentChat)
  |     User types: "A photography portfolio for a landscape photographer"
  |     Agent streams: thinking, tool calls, status updates
  |
  +-- Preview iframe --> sandbox:4321 (Astro dev server)
  |     Live preview of the EmDash site as it's being built
  |     Updates on each tool call (seed apply, theme change, etc.)
  |
  +-- WebSocket --> Worker --> BuilderAgent (Durable Object)
                                  |
                                  +-- State: conversation history, session config (SQLite)
                                  +-- LLM: AI Gateway --> model (configurable)
                                  +-- Sandbox (Container)
                                        |
                                        +-- Scaffolded EmDash template (from emdash-cms/templates)
                                        +-- Working directory: /home/user/site
                                        +-- pnpm, node, astro
                                        +-- Astro dev server on :4321
                                        +-- D1 local (via wrangler dev)
                                        +-- Full filesystem access
```

### Components

**1. BuilderAgent (Durable Object)**

Extends `AIChatAgent` from the `agents` SDK. Manages:

- Conversation history (persisted in DO SQLite)
- Sandbox lifecycle (create, initialize, destroy)
- LLM calls via AI Gateway
- Tool execution (write files, apply seed, etc.)
- Session metadata (theme choice, seed applied, sandbox status)

**2. Sandbox Container**

A `@cloudflare/sandbox` container running the EmDash development environment:

- Scaffolds a standalone template from `emdash-cms/templates` into `/home/user/site`
- Runs `pnpm install` in the site directory
- Starts the dev server (`pnpm dev --host 0.0.0.0`)
- Exposes port 4321 for live preview
- The agent executes tools by calling `sandbox.exec()` and `sandbox.writeFile()`

**3. Chat UI**

A React SPA using `useAgentChat()` from the `agents` SDK:

- Chat message list with streaming support
- Streamed reasoning display (streaming-markdown)
- Tool call visualization (which tool, arguments, result)
- Preview iframe alongside the chat
- Quick-start prompt buttons
- Model picker (optional)

**4. Worker**

Hono-based Worker that:

- Serves the SPA
- Routes WebSocket connections to the BuilderAgent DO
- Proxies preview requests to the sandbox's exposed port
- Handles static assets

### Template Scaffolding

EmDash is published on npm (`emdash`, `@emdash-cms/cloudflare`) and the public `emdash-cms/templates` repo ships standalone, installable Astro templates. There's no monorepo clone anymore — the sandbox fetches a single template directory at scaffold time.

```
sandbox.exec("git clone --depth 1 https://github.com/emdash-cms/templates.git /tmp/templates")
sandbox.exec("cp -r /tmp/templates/{theme}-cloudflare /home/user/site")
sandbox.exec("cd /home/user/site && pnpm install")
```

Working directory for all subsequent operations: `/home/user/site`.

## Bootstrap Sequence

Getting a visible site in the preview as fast as possible is critical for the demo. The user shouldn't stare at a blank iframe while the AI thinks. The bootstrap happens in two phases:

### Phase 0: Theme Pick + Scaffold (triggered by first user message)

The worker inspects the user's first prompt with a deterministic keyword classifier (portfolio/blog/marketing/starter) and eagerly provisions the matching template. No LLM round-trip for theme selection.

```bash
# Scaffold the chosen template
git clone --depth 1 https://github.com/emdash-cms/templates.git /tmp/templates
cp -r /tmp/templates/{theme}-cloudflare /home/user/site

# Install dependencies
cd /home/user/site && pnpm install

# Start the dev server
pnpm dev --host 0.0.0.0 &

# Wait for dev server to be ready (poll for localhost:4321)

# Run dev-bypass: migrations + admin user + session + built-in seed
curl -s http://localhost:4321/_emdash/api/setup/dev-bypass
```

After Phase 0: the preview iframe shows a working, styled EmDash site with the template's default seed (posts + pages, or projects, etc.). This takes ~30-90 seconds on cold start (dominated by `pnpm install`). MCP connection happens at the end of Phase 0 so the agent has CMS tools available from turn 1.

### Phase 1: Content + Customization (agent's first response)

With the template already running, the agent inspects the collections via `schema_list_collections`, creates custom content matching the user's description, and tweaks CSS variables in `src/styles/theme.css`.

Result: a fully themed, content-rich site matching the user's description.

### Seeding Strategy

EmDash already has a full set of tools for managing sites programmatically:

**CLI commands** (operate directly on SQLite files):

```bash
emdash seed ./seed.json                    # Apply a seed (runs migrations, creates schema, populates content)
emdash seed ./seed.json --on-conflict update  # Re-apply, replacing existing content
emdash content create posts --data '{...}' # Create individual content items
emdash schema                              # Manage collections/fields
emdash taxonomy                            # Manage taxonomy terms
emdash menu                                # Manage menus
```

**REST API** (requires running dev server):

- `POST /_emdash/api/content/{collection}` -- create content
- `POST /_emdash/api/schema/collections` -- create collections
- `POST /_emdash/api/taxonomies/{name}/terms` -- create terms
- `PUT /_emdash/api/menus/{name}` -- update menus

**MCP server** (at `/_emdash/api/mcp`): Same operations as REST API via MCP protocol -- `schema_create_collection`, `content_create`, `taxonomy_create_term`, etc.

**All three paths work. Here's when to use each:**

| Method            | Best for                             | Notes                                                    |
| ----------------- | ------------------------------------ | -------------------------------------------------------- |
| **CLI**           | Initial bulk seed, offline setup     | Opens DB directly. Needs D1 file path with wrangler.     |
| **REST API**      | Follow-up edits from the agent       | Granular CRUD. Server must be running.                   |
| **MCP**           | MCP-aware agents (e.g., OpenCode)    | Same as REST API but via MCP protocol.                   |
| **HTTP endpoint** | Agent applying full seeds at runtime | New. Uses server's own DB connection. No path discovery. |

**For the vibe platform, we'll use a combination:**

1. **Phase 0 (bootstrap)**: `dev-bypass` endpoint -- already exists, runs migrations + applies built-in seed + creates admin user. One curl.
2. **Phase 2 (custom seed)**: New `POST /_emdash/api/seed/apply` endpoint OR CLI `emdash seed` against the wrangler D1 file. The HTTP endpoint is more robust since it uses the running server's DB connection and doesn't require locating the D1 SQLite path.
3. **Follow-up edits**: REST API for granular changes ("add a testimonials section", "create a new blog post"). Avoids regenerating the full seed for small modifications.

The new seed-apply endpoint follows the `dev-bypass` pattern -- gated behind `import.meta.env.DEV`, calls `applySeed()`:

```typescript
// packages/core/src/astro/routes/api/setup/seed-apply.ts
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
	if (!import.meta.env.DEV) {
		return apiError("FORBIDDEN", "Dev-only endpoint", 403);
	}
	const { emdash } = locals;
	if (!emdash) return apiError("NOT_CONFIGURED", "EmDash not initialized", 500);

	const seed = (await request.json()) as SeedFile;
	const validation = validateSeed(seed);
	if (!validation.valid) {
		return apiError("VALIDATION_ERROR", validation.errors.join(", "), 400);
	}

	const result = await applySeed(emdash.db, seed, {
		includeContent: true,
		onConflict: "update", // replace existing content
		skipMediaDownload: true, // use external URLs directly
	});

	return Response.json({ success: true, data: result });
};
```

The agent calls this from the sandbox: `curl -X POST localhost:4321/_emdash/api/seed/apply -H 'Content-Type: application/json' -d @seed.json`

The CLI alternative also works: `emdash seed ./seed.json --database .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite --on-conflict update`. The D1 file path can be discovered with `find .wrangler -name "*.sqlite"`. Either approach is fine -- the HTTP endpoint is slightly cleaner for automation.

### Dev Bypass Enhancement

The existing `dev-bypass` endpoint already does most of Phase 0 work. One enhancement needed: it currently applies the build-time-embedded seed (from `virtual:emdash/seed`). For the vibe platform, we want Phase 0 to apply the starter's minimal seed (so there's something to show), then Phase 2 replaces it with the AI-generated seed.

The current behavior is correct for this -- the starter template's embedded seed IS minimal. The custom seed endpoint with `onConflict: "update"` handles the replacement.

## Theme System

### The Problem

AI-generated CSS from scratch produces mediocre results. Even frontier models generate designs that look "obviously AI" -- generic, lacking personality, inconsistent in the details.

### The Solution

Ship designer-crafted themes. The AI's job is theme _selection_ and _customization_, not generation from scratch.

### Available Themes

Three designer themes exist in the monorepo, each a complete Astro template with pages, layouts, components, and CSS:

| Theme         | Identity                                                                                                    | Best for                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **blog**      | Clean editorial. Inter + JetBrains Mono. Blue accent. Sticky header with blur. Three-column article layout. | Blogs, magazines, personal sites, developer journals           |
| **portfolio** | Elegant gallery. Playfair Display serif headings. Purple accent. Project cards with hover overlay.          | Portfolios, studios, freelancers, galleries, case study sites  |
| **marketing** | Bold SaaS. Inter 800-weight. Indigo-to-pink gradient CTAs. Hero sections, feature grids, pricing tables.    | Landing pages, SaaS products, business sites, product launches |

### Theme Application

The starter-cloudflare template provides the CMS wiring (menus, search, widgets, Portable Text rendering, taxonomy pages, plugin integration) without any visual opinion. Themes are applied by copying layout/component/style files from the chosen template into the starter:

```
# Agent picks "portfolio" theme:
cp -r templates/portfolio/src/* templates/starter-cloudflare/src/
```

This gives the starter the portfolio's visual identity while keeping its own `wrangler.jsonc`, `astro.config.mjs`, and any builder-specific configuration.

### Theme Customization

After applying a base theme, the AI customizes it by editing files directly -- the same way a developer would. Just file edits that the dev server picks up via HMR.

- **CSS custom properties**: Read Base.astro, edit the `:root` variables, write it back. Colors, spacing, border radius, whatever the theme exposes.
- **Font selection**: Edit `astro.config.mjs` to configure the Astro Fonts API. Fonts are downloaded and self-hosted at build time -- no CDN links, no runtime loading, best performance and privacy. The agent adds the desired font families to the `fonts` config and updates the CSS variables to reference them.
- **Content structure**: The seed determines what collections, taxonomies, and menus exist. A "photography portfolio" gets different collections than a "law firm" even on the same base theme.
- **Page tweaks**: The agent can read and edit any Astro component if needed -- adjust the homepage grid, change what metadata is shown on post cards, etc.

What the AI should avoid changing: responsive breakpoints, animation timing, the overall layout architecture. These are the designer's decisions and they work well as-is. The system prompt guides the agent to customize within the theme's design system rather than fighting it.

## Agent Design

### System Prompt

The system prompt includes:

1. **Role and context**: "You are building an EmDash CMS site. You have a running development environment with the starter template."
2. **Theme catalog**: Name, description, visual identity, what types of sites each theme suits. Enough detail for the model to make a good selection.
3. **Seed schema**: The full `SeedFile` type hierarchy and field types. 2-3 example seeds as few-shot examples.
4. **EmDash concepts**: Collections, fields, taxonomies, menus, widgets, Portable Text, sections, bylines. Brief explanations of each.
5. **Design principles**: Typography, color, spacing, layout guidance (distilled from the existing prompts.ts).
6. **Tool descriptions**: What each tool does, when to use it, expected arguments.
7. **Instructions**: Step-by-step workflow -- (1) analyze the user's description, (2) pick the best theme, (3) generate a seed, (4) apply theme + seed, (5) customize if needed, (6) verify the result.

### Tools

The agent has a small set of general-purpose tools plus one domain-specific tool for image search. No special-purpose tools for CSS or fonts -- the agent reads and writes files directly, the same way a developer would.

| Tool              | Description                                    | Implementation                                                                 |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `select_theme`    | Copy a theme's files into the working template | `sandbox.exec("cp -r ...")`                                                    |
| `apply_seed`      | Apply a seed.json to the running site          | `sandbox.exec("curl -X POST localhost:4321/_emdash/api/setup/seed-apply ...")` |
| `write_file`      | Write a file (creates or overwrites)           | `sandbox.writeFile(path, content)`                                             |
| `read_file`       | Read a file's contents                         | `sandbox.readFile(path)`                                                       |
| `exec`            | Run a shell command                            | `sandbox.exec(cmd)`                                                            |
| `search_unsplash` | Search for photos by keyword                   | Unsplash API via Worker (returns URLs, descriptions, dimensions)               |

`search_unsplash` exists because the alternative -- the model hallucinating Unsplash photo IDs -- produces broken image URLs half the time. With a real search tool, the agent finds relevant photos ("iceland highlands landscape") and gets valid URLs to use in the seed's `$media` references. The Unsplash API has a free tier (50 requests/hour) which is plenty for a single site build.

**How each type of customization works with these tools:**

- **Colors/spacing**: `read_file("src/layouts/Base.astro")` -> edit the `:root` CSS variables -> `write_file("src/layouts/Base.astro", ...)`
- **Fonts**: `read_file("astro.config.mjs")` -> add Astro Fonts API config -> `write_file("astro.config.mjs", ...")`. Then update the CSS `font-family` variables to reference the new fonts. Astro downloads and self-hosts the fonts automatically.
- **Images**: `search_unsplash("artisan sourdough bread")` -> use the returned URLs in seed content or page markup
- **Page structure**: `read_file("src/pages/index.astro")` -> edit the markup/logic -> `write_file(...)`
- **Content model**: `apply_seed(...)` for bulk changes, or `exec("curl -X POST localhost:4321/_emdash/api/content/posts ...")` for individual items
- **Check the result**: `exec("curl -s localhost:4321/")` to fetch rendered HTML, or the user sees it live in the preview iframe

### Knowledge: System Prompt + On-Demand Skills

The agent needs to know how to build EmDash sites -- how seeds work, what field types exist, how collections relate to pages, how Portable Text is structured. The templates already contain rich agent skill files in `.opencode/skills/` designed for exactly this purpose:

- `building-emdash-site/SKILL.md` -- querying content, rendering Portable Text, schema design, seed file format, site features (menus, widgets, search, SEO, comments, bylines)
- `creating-plugins/SKILL.md` -- plugin hooks, storage, admin UI, API routes
- `emdash-cli/SKILL.md` -- CLI commands for content management, seeding, type generation

These skills are designed for OpenCode-style agents that load them on demand. Our vibe platform agent uses a **layered knowledge approach** instead:

**Always in the system prompt (essential context):**

- Theme catalog (names, descriptions, visual identity, what each is good for)
- Seed schema (the `SeedFile` type hierarchy, field types, 2-3 example seeds)
- Tool descriptions and usage patterns
- The step-by-step build workflow
- Design principles (typography, color, spacing)
- Key rules: use Astro Fonts API for fonts, use `$media` with URLs from `search_unsplash`, etc.

**Available on demand via `read_file` (reference docs):**

- `.agents/skills/building-emdash-site/SKILL.md` -- deep detail on content queries, Portable Text rendering, page patterns
- `.agents/skills/emdash-cli/SKILL.md` -- CLI commands and API endpoints
- `seed/seed.json` -- the current template's seed file as a reference

The system prompt tells the agent: "For detailed documentation on EmDash concepts, read the skill files in `.agents/skills/`. Read the `building-emdash-site` skill before making structural changes to pages or components."

This keeps the system prompt focused (~3-5k tokens of essential context) while giving the agent access to ~20k tokens of detailed documentation when it needs it. The model reads the skill files on its first turn (or when it encounters something unfamiliar) and the content enters the conversation context naturally.

For follow-up turns, the skill content is already in the conversation history from the initial read. No need to re-read unless the conversation is long enough to require context summarization.

### Agent Loop

The agent uses the standard tool-calling loop:

```
1. User sends prompt
2. Agent calls LLM with conversation + tools
3. LLM returns either:
   a. Text response (done for this turn)
   b. Tool calls (execute them, feed results back, go to 2)
4. Stream everything to the client: reasoning, tool calls, results, final text
```

For the initial build, the typical flow is:

```
User: "A photography portfolio for a landscape photographer based in Iceland"

Agent thinks: Analyzing the request... photography + landscape + Iceland suggests
  a visual-heavy site with location-based organization.

Agent calls: select_theme("portfolio")
  Result: "Copied portfolio theme files. Dev server restarting."

Agent calls: apply_seed({
  version: "1",
  settings: { title: "Eldr | Landscape Photography", tagline: "Iceland through a lens" },
  collections: [
    { slug: "projects", label: "Projects", fields: [...] },
    { slug: "pages", label: "Pages", fields: [...] }
  ],
  taxonomies: [
    { name: "location", label: "Locations", hierarchical: true, ... },
    { name: "season", label: "Seasons", hierarchical: false, ... }
  ],
  content: { projects: [...], pages: [...] },
  ...
})
  Result: "Seed applied. 2 collections, 5 projects, 2 pages."

Agent calls: read_file("src/layouts/Base.astro")
  Result: (full file contents with existing CSS variables)

Agent calls: write_file("src/layouts/Base.astro", "...")
  // Changed: --color-bg: #0a0a0a, --color-text: #f5f5f5, --color-accent: #64b5c6
  Result: "File written."

Agent calls: read_file("astro.config.mjs")
  Result: (existing config)

Agent calls: write_file("astro.config.mjs", "...")
  // Added: fonts({ providers: [google()], families: [{ name: "DM Sans", ... }] })
  Result: "File written."

Agent responds: "Your site is ready! I built a landscape photography portfolio
  with a dark theme to let the images stand out. I organized projects by location
  (Highlands, Westfjords, South Coast) and season. The accent color is a cool
  teal that complements landscape photography. I switched to DM Sans for a
  cleaner feel alongside the serif headings.

  You can manage everything in the admin panel -- the preview is on the right."
```

Follow-up turns work the same way:

```
User: "Add a blog section for behind-the-scenes posts"

Agent calls: apply_seed({ /* delta seed adding a posts collection + sample posts */ })
Agent calls: read_file("src/pages/posts/index.astro")
Agent calls: write_file("src/pages/posts/index.astro", "...")
  // Adapted the listing page for blog-style posts
Agent responds: "Added a blog section with 3 sample posts. Posts are organized
  by category. I added a 'Journal' link to the navigation."
```

### Model Strategy

LLM calls go through Cloudflare AI Gateway, which supports routing to any provider:

- **Default**: Workers AI model (Kimi K2.5 or equivalent) -- free, fast, good enough for theme selection and seed generation.
- **Premium**: Opus/Sonnet via AI Gateway -- best quality, costs per token. Could be offered as a "high quality" mode or BYOK.
- **Per-action routing**: Different models for different tasks. Use a cheap model for theme selection (classification), a good model for seed generation (creative writing + structured output), and the best available for CSS customization and follow-up edits.

AI Gateway provides unified billing, logging, caching, and fallback chains across providers.

## Frontend Design

### Layout

```
+---------------------------------------------------+
| EmDash                                    [Model] |
+------------------------+--------------------------+
|                        |                          |
|  Chat Panel            |  Preview Panel           |
|                        |                          |
|  [Quick-start buttons] |  [iframe: site preview]  |
|                        |                          |
|  Agent: Thinking...    |                          |
|  > select_theme(...)   |                          |
|  > apply_seed(...)     |                          |
|                        |                          |
|  Your site is ready!   |                          |
|  ...                   |                          |
|                        |                          |
|  [message input]       |  [Deploy] [Admin Panel]  |
+------------------------+--------------------------+
```

- **Chat panel** (left): Message list, streaming reasoning (via streaming-markdown), tool call cards, text input.
- **Preview panel** (right): iframe pointing at the sandbox's exposed port. Public
  document routes use the last successful HTML snapshot while the live Astro
  authoring runner processes edits; mutations refresh the snapshot before the
  agent reloads the iframe. CMS/admin/API traffic, assets and WebSockets remain
  live and uncached. Includes a URL bar showing the current page.
- **Quick-start buttons**: Pre-written prompts for common site types ("Photography Portfolio", "Restaurant", "Tech Blog", etc.).
- **Action buttons**: "Deploy to Cloudflare" (creates a real deployment), "Open Admin" (links to the admin panel in the sandbox).

### Chat Message Types

| Type            | Display                                                           |
| --------------- | ----------------------------------------------------------------- |
| User message    | Right-aligned bubble                                              |
| Agent text      | Left-aligned, rendered as markdown                                |
| Agent reasoning | Collapsible, muted, streaming-markdown                            |
| Tool call       | Card with tool name, arguments (collapsed JSON), status indicator |
| Tool result     | Inline in the tool card (success/error + brief message)           |
| System message  | Centered, muted (e.g., "Sandbox ready", "Dev server started")     |

### Streaming UX

The agent's response streams in real-time:

1. **Reasoning tokens** appear in a collapsible "Thinking..." section (streaming-markdown)
2. **Tool calls** appear as cards when the model emits them
3. **Tool results** fill in as each tool completes
4. **Final text** streams after all tools complete
5. **Preview iframe** refreshes after seed/theme/CSS tool calls

This gives the user constant visual feedback. They never stare at a blank screen wondering if anything is happening.

## Sandbox Lifecycle

### Initialization (~60-90s cold, ~5s warm)

1. Classify the user's prompt to pick a template (deterministic keyword match)
2. `sandbox.exec("git clone --depth 1 https://github.com/emdash-cms/templates.git /tmp/templates")`
3. `sandbox.exec("cp -r /tmp/templates/{theme}-cloudflare /home/user/site")`
4. `sandbox.exec("cd /home/user/site && pnpm install")`
5. `sandbox.startProcess("pnpm dev --host 0.0.0.0", { cwd: "/home/user/site" })`
6. Wait for port 4321 (`devServer.waitForPort(4321, { mode: "tcp" })`)
7. `sandbox.exposePort(4321)` -- get the public preview URL
8. Run EmDash setup (migrations + dev admin user) via the dev-bypass endpoint
9. Create an API token via the admin endpoint, pass it to the MCP server

Strategies to reduce cold start further:

- **Pre-built container image**: Bake a pnpm store warmup into the image so installs hit a warm cache.
- **Warm pool**: Keep N sandbox instances warm and pre-initialized. Assign one to each new user session instantly. Refill the pool in the background.

### Idle and Cleanup

- Sandboxes sleep after five minutes of inactivity (`sleepAfter: "5m"`).
- Ephemeral disk means a sleeping sandbox loses its filesystem state.
- Initial setup and every successful mutation are checkpointed to a per-session
  Artifacts git repo; `.wrangler` carries local D1 and media state.
- Opening an existing sidebar project proactively clones the checkpoint when
  needed, restarts Astro, and reactivates the same preview URL.
- Recovery fails closed when no usable checkpoint exists. It never replaces an
  established project with a clean template.

### Session to Sandbox Mapping

Each BuilderAgent DO instance owns one sandbox. The sandbox ID is derived from the agent ID. When the agent DO is garbage collected, the sandbox is destroyed.

## Deployment Pipeline (Phase 2)

When the user clicks "Deploy":

1. Agent bundles the current template state
2. Worker provisions D1 database + R2 bucket via Cloudflare API
3. Worker deploys to a Workers for Platforms dispatch namespace
4. The deployed site gets a URL: `{site-name}.emdashcms.com` or similar
5. The seed data is applied to the production D1 database
6. Media from Unsplash URLs is downloaded and stored in R2

This is the most complex part and doesn't need to be in v1. For the demo, the sandbox preview IS the deliverable.

## Implementation Plan

### Milestone 1: "It works" -- Sandbox + agent loop, no UI

Goal: Prove the end-to-end flow works. An API call spins up a sandbox, the agent builds a site, the site is accessible at a URL. All validation happens via curl and the browser -- no custom frontend yet.

**1.1 Project scaffolding**

- Create `apps/builder/` with `wrangler.jsonc`, `package.json`, `tsconfig.json`
- Dependencies: `agents`, `@cloudflare/sandbox`, `openai`, `hono`
- Bindings: Sandbox DO, AI Gateway (or Workers AI), KV for session mapping
- One `src/index.ts` entrypoint with Hono routes

**1.2 Sandbox bootstrap script**

- The agent's `provisionSite` method scaffolds a template and starts the dev server:
  ```bash
  git clone --depth 1 https://github.com/emdash-cms/templates.git /tmp/templates
  cp -r /tmp/templates/{theme}-cloudflare /home/user/site
  cd /home/user/site
  pnpm install
  pnpm dev --host 0.0.0.0 &
  until curl -s http://localhost:4321 > /dev/null 2>&1; do sleep 1; done
  curl -s http://localhost:4321/_emdash/api/setup/dev-bypass
  ```
- Test this manually in a sandbox container first (`wrangler dev`, then curl the sandbox)
- Understand the cold start time, identify bottlenecks

**1.3 BuilderAgent Durable Object**

- Extend `Agent` from the `agents` SDK (not `AIChatAgent` yet -- start simple)
- State: `{ sandboxId, sandboxReady, previewUrl, themeApplied, seedApplied }`
- `onStart()`: create sandbox, run bootstrap script, store preview URL
- `onMessage(prompt)`: run the agent loop (see 1.5)
- WebSocket for client communication (typed JSON messages)
- Expose via Hono route: `POST /api/build` to start, `WS /api/ws/:agentId` for streaming

**1.4 System prompt + tool definitions**

- Port the seed schema, theme catalog, and design principles from the prototype `prompts.ts`
- Define the sandbox tools as AI SDK `tool()` calls:
  - `read_file(path: string)` -- reads a file (agent reads before editing)
  - `write_file(path: string, content: string)` -- writes/overwrites a file
  - `edit_file(path, oldText, newText)` -- targeted search-and-replace (preferred over write_file for CSS tweaks)
  - `exec(command: string)` -- runs a shell command in `/home/user/site`
  - `search_unsplash(query, count)` -- real Unsplash API search for imagery
- CMS tools come from the EmDash MCP server (`/_emdash/api/mcp`), wired in at runtime: `schema_list_collections`, `schema_create_collection`, `content_create`, `content_publish`, `taxonomy_create_term`, etc.
- Theme selection is NOT a tool — it's a pre-classification step before the agent runs, driven by keyword matching on the user's first prompt.
- Tool execution layer: maps tool calls to `sandbox.exec()` / `sandbox.writeFile()` / `sandbox.readFile()` for file tools; MCP tool calls go through `this.mcp.callTool`.
- Theme catalog as structured data: for each theme, the name, description, visual identity summary, list of CSS custom properties it defines, what page types it includes, the Astro Fonts API config it uses

**1.5 Agent loop**

- Standard tool-calling loop using OpenAI SDK against AI Gateway:
  ```
  messages = [system, user]
  while true:
    response = ai.chat.completions.create(messages, tools, stream=false)
    if response has tool_calls:
      execute tools, append results to messages
    else:
      break  // final text response
  ```
- Start with non-streaming (simpler). Streaming comes in Milestone 2.
- Use Sonnet or Opus via AI Gateway for initial testing (best quality, validate the flow works). Switch to Kimi K2.5 later to test the quality floor.
- Cap at 10 tool-call rounds to prevent runaway loops

**1.6 Validation**

- `curl -X POST /api/build -d '{"prompt": "A photography portfolio..."}'`
- Check: sandbox starts, theme is applied, seed is applied, preview URL returns a real page
- Open the preview URL in a browser: is the site rendered correctly?
- Open `{previewUrl}/_emdash/admin`: does the admin panel work?
- Time the full flow: how long from prompt to preview?
- Test all 3 themes with different prompts

**Done when**: you can POST a prompt to an API endpoint and get back a URL to a working, themed, content-populated EmDash site.

Estimated effort: 2-3 days. ~1500 lines of new code.

---

### Milestone 2: "It looks good" -- Chat UI + streaming

Goal: A web interface where a user types a prompt and watches the site build in real-time.

**2.1 Landing page**

- Simple HTML page served by the Worker
- Centered prompt input, quick-start cards (6-8 site types)
- Each card has: title, one-line description, a subtle icon or gradient (no screenshots yet)
- Clicking a card fills the prompt input
- "Build" button starts the session
- While the user is on this page, pre-warm a sandbox in the background (hit the Worker endpoint to create the DO, which starts sandbox init)

**2.2 Build page -- shell**

- Two-panel layout: chat (left), preview (right)
- React SPA (or Preact for size). Vite build, served as static assets by the Worker.
- Preview panel: `<iframe>` pointed at the sandbox preview URL. Loading state until sandbox is ready.
- Chat panel: message list (scrollable), input bar at bottom
- URL structure: `/build/:sessionId` -- created when the user submits the prompt from the landing page

**2.3 WebSocket integration**

- Connect to the agent's WebSocket endpoint
- Define the message protocol:

  ```typescript
  // Server -> Client
  type ServerMessage =
  	| { type: "status"; phase: string; message: string } // "Setting up environment..."
  	| { type: "reasoning"; content: string } // streaming thinking tokens
  	| { type: "reasoning_end" } // thinking phase complete
  	| { type: "tool_call"; id: string; name: string; args: unknown }
  	| { type: "tool_result"; id: string; success: boolean; message: string }
  	| { type: "content"; text: string } // streaming output tokens
  	| { type: "content_end" } // output complete
  	| { type: "preview_url"; url: string } // sandbox preview is ready
  	| { type: "suggestions"; items: string[] } // clickable next steps
  	| { type: "error"; message: string };

  // Client -> Server
  type ClientMessage = { type: "prompt"; text: string };
  ```

- The agent loop in the DO sends these messages as it progresses

**2.4 Streaming agent loop**

- Upgrade the agent loop from Milestone 1 to stream responses
- Each `ai.chat.completions.create()` call uses `stream: true`
- Parse streaming deltas for reasoning tokens, content tokens, and tool calls
- Broadcast each chunk to connected WebSocket clients as typed messages
- Tool execution results are broadcast as `tool_result` messages

**2.5 Chat rendering**

- Render message types:
  - User message: right-aligned bubble
  - Reasoning: collapsible section, muted text, rendered with `streaming-markdown`
  - Tool call: compact card with icon, tool name, brief description of what happened. Expandable to show full args/result JSON.
  - Agent text: left-aligned, rendered as markdown
  - System message: centered, muted
  - Suggestions: row of clickable pill buttons below the last message
- Auto-scroll to bottom as new content arrives
- Input bar: textarea + send button, disabled while agent is working

**2.6 Preview integration**

- Show loading state in preview panel until `preview_url` message arrives
- Simple URL bar at the top of the preview panel (shows current path, editable)
- Refresh button
- After `tool_result` messages for `select_theme`, `apply_seed`, or `customize_css`: automatically refresh the iframe (with a small debounce to let the dev server rebuild)
- "Open Admin" button: opens `{previewUrl}/_emdash/admin` in the preview iframe (or a new tab)

**Done when**: a user can open the landing page, type a prompt, watch the agent think and build in the chat panel, see the site appear in the preview panel, then iterate with follow-up messages.

Estimated effort: 3-5 days. ~2500 lines of new code (mostly frontend).

---

### Milestone 3: "It's polished" -- Quality and reliability

Goal: The demo is reliable enough to show publicly. Edge cases handled. UX is smooth.

**3.1 Error handling**

- Sandbox creation failures: show error in chat, offer retry
- LLM failures: retry with backoff, show error after 3 attempts
- Tool execution failures: report to the agent (it can try a different approach), show in the tool card
- WebSocket disconnection: auto-reconnect, replay missed messages from DO state
- Seed validation failures: agent sees the error, can fix the seed and retry

**3.2 Quick-start thumbnails**

- Generate screenshots of each theme with representative content (use the blog/portfolio/marketing seeds rendered with their respective themes)
- Show these as card thumbnails on the landing page
- These are static assets, not dynamically generated

**3.3 Model selection**

- Default to a good model via AI Gateway (Sonnet or Kimi K2.5)
- Optional model picker in the UI (dropdown in the header)
- Support BYOK: user can paste an API key for Anthropic/OpenAI to use their own billing
- Per-action routing: cheap model for theme selection, good model for seed generation

**3.4 Sandbox warm pool**

- Pre-create N sandbox instances on a schedule (or on Worker startup)
- When a user starts a build, assign them a pre-warmed sandbox instead of creating a new one
- Refill the pool in the background
- This drops the perceived cold start from minutes to seconds

**3.5 Session management**

- Assign a session ID (ULID) on build start
- Persist conversation history in the DO's SQLite
- Persist sandbox state (theme, seed applied, preview URL) in DO state
- Allow returning to a session via URL: `/build/:sessionId`
- TTL: sandbox auto-destroys after 1 hour of inactivity. Chat history persists longer.

**3.6 Rate limiting**

- Turnstile challenge on the landing page before creating a sandbox
- IP-based rate limiting: max N builds per IP per hour
- Concurrent session limit: one active sandbox per IP

**3.7 Seed export**

- "Export seed" button in the chat panel
- Downloads the applied seed.json file
- User can use this locally: `emdash seed ./seed.json` in their own project

**Done when**: the demo is reliable, handles errors gracefully, has fast startup via warm pool, and is safe to expose publicly with rate limiting.

Estimated effort: 3-4 days.

---

### Milestone 4: "It deploys" -- Production deployment pipeline

Goal: Users can deploy their generated site to Cloudflare with one click.

**4.1 Cloudflare OAuth**

- "Deploy to Cloudflare" button triggers OAuth flow
- User authorizes the vibe platform to access their Cloudflare account
- Store the OAuth token in the DO (per-session, ephemeral)

**4.2 Resource provisioning**

- Create a D1 database via Cloudflare API
- Create an R2 bucket via Cloudflare API
- Create a Workers for Platforms dispatch namespace (or use a shared one)

**4.3 Build and deploy**

- Bundle the Astro site in the sandbox: `pnpm build`
- Upload static assets to the dispatch namespace
- Deploy the Worker with D1 + R2 bindings
- Run migrations on the production D1
- Apply the seed to production D1 (with `skipMediaDownload: false` -- actually download images to R2)

**4.4 Post-deploy**

- Show the live URL in the chat
- "Open your site" button
- Prompt the user to set up their admin account (passkey registration at `{liveUrl}/_emdash/admin`)
- The user is now independent -- they own the deployed site

**Done when**: a user can go from prompt to a deployed, production Cloudflare site with their own admin panel.

Estimated effort: 5-7 days (complex API integrations, lots of edge cases).

---

### Milestone 5: "It's fast" -- Optimization

Goal: Cold starts under 10 seconds, smooth experience for repeated users.

**5.1 Pre-built container image**

- Dockerfile that clones the monorepo and runs `pnpm install`
- CI pipeline: build and push to Cloudflare Container Registry on each release
- Sandbox config references the pre-built image instead of cloning at runtime
- Cold start drops from ~2-3 minutes to ~5-10 seconds

**5.2 Sandbox state persistence**

- Before sandbox sleeps: export key state (DB file, seed.json, theme choice) to R2
- On wake: restore state from R2
- Allows longer session TTLs without paying for always-on containers

**5.3 Incremental builds**

- Track which files changed since last build
- Only rebuild what's needed (Astro's HMR handles this in dev, but production builds might need optimization)

**5.4 Context management for long conversations**

- Summarize conversation history after N turns to keep context window manageable
- Tool results can be large (seed JSON) -- compress or summarize older results
- Session affinity headers for Kimi K2.5 prefix caching

**Done when**: the experience feels instant -- sandbox ready in seconds, preview updates in real-time, conversations flow naturally over many turns.

Estimated effort: 3-5 days.

---

### Build Order Summary

| Milestone             | What you get                             | Effort   | Cumulative |
| --------------------- | ---------------------------------------- | -------- | ---------- |
| **M1: It works**      | API-driven site building, no UI          | 2-3 days | 2-3 days   |
| **M2: It looks good** | Chat UI + streaming + preview            | 3-5 days | 5-8 days   |
| **M3: It's polished** | Error handling, warm pool, rate limiting | 3-4 days | 8-12 days  |
| **M4: It deploys**    | One-click deploy to Cloudflare           | 5-7 days | 13-19 days |
| **M5: It's fast**     | Pre-built images, state persistence      | 3-5 days | 16-24 days |

**M1 is the demo.** Even without a UI, you can show the API call, the streaming output, and open the resulting site in a browser. Good for internal demos, blog post screenshots.

**M1 + M2 is the keynote demo.** The chat interface + live preview is the "wow" moment. This is what you'd show at a conference.

**M3 makes it public.** Rate limiting, error handling, and warm pool mean real users can try it without it falling over.

**M4 makes it a product.** Users keep what they build.

**M5 makes it good.** Fast, reliable, scalable.

### Prerequisites (already done or in progress)

- [x] `POST /_emdash/api/setup/seed-apply` endpoint (built in this session)
- [x] CLI `emdash seed` updated to use HTTP endpoint (built in this session)
- [x] Prototype: Kimi K2.5 streaming + SSE parsing (built in this session, `templates/starter-cloudflare/src/pages/build.astro`)
- [x] System prompts with seed schema + design principles (built in this session, `templates/starter-cloudflare/src/lib/prompts.ts`)
- [ ] Pre-built container image with monorepo + deps (Milestone 5, but building it earlier would speed up all development)
- [ ] Theme metadata files -- structured descriptions of each theme for the system prompt (part of M1.4)

## Open Questions

1. **Container image strategy.** Pre-building a container image with the monorepo installed would drop cold starts from ~2-3 minutes to ~5 seconds. This requires a CI step to build and push the image when the monorepo changes. Worth it for production; skip for prototype.

2. **Model defaults.** Kimi K2.5 on Workers AI is free and has function calling. Is it good enough for theme selection + seed generation? The prototype prompts suggest it's decent for seeds but weaker on design decisions. If we constrain its job to "pick a theme and generate a seed" rather than "design a site from scratch", it might be sufficient.

3. **Follow-up edits.** After the initial build, follow-up requests ("add a contact form", "change the nav layout") may require editing Astro components. The designer themes have complex components (PostCard, TagList, etc.). Can the LLM reliably edit these? If not, we may need to limit follow-ups to seed/content changes and CSS variable tweaks.

4. **Sandbox costs.** Each active sandbox is a running container. At the `basic` tier (1/4 vCPU, 1 GiB RAM), the cost is ~$0.07/hour. For a demo or limited beta this is fine. For a public product, the warm pool strategy and aggressive sleep timers become important.

5. **Monorepo size.** A shallow clone of the monorepo + `pnpm install` produces a large `node_modules`. This affects cold start time and disk usage. Consider: (a) publishing packages to npm (planned), (b) pre-building a container image with deps baked in, (c) using a smaller subset of the monorepo.

6. **Relationship to Playground.** The vibe coding platform and the Playground (PLAYGROUND.md) serve different audiences. The Playground is "try an existing EmDash site" (no AI, instant, lightweight). The vibe platform is "create a new site from a prompt" (AI-powered, heavier, longer setup). They could share infrastructure (sandbox containers) but have different UIs and workflows. Consider whether they should be the same product with different entry points or separate products.
