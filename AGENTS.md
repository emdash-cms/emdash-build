# EmDash Build

A chat-based site builder where users describe the site they want and an AI agent builds it in a Cloudflare Sandbox, with a live preview alongside the chat.

## Blank-builder prototype

New projects use the local `prototype/builder-cloudflare` scaffold. It provides EmDash, Astro, Tailwind 4, and source-owned accessible Astro primitives but no content schema or site design; the agent creates those from the brief. Public generated routes must remain Astro/vanilla JavaScript even though React stays configured for the EmDash admin. Existing persisted projects recover their own scaffold from Artifacts and are not replaced.

Read `SPEC.md` for product context. Its blank-builder note and the architecture here describe the current prototype; its designer-template selection, worked examples, and tool table describe earlier designs.

## Stack

- **Worker**: Hono for HTTP, `agents` SDK for the BuilderAgent DO, `@cloudflare/sandbox` for containers
- **LLM**: Workers AI binding, streaming via the Vercel AI SDK (`ai` package)
- **Frontend**: React 19 + Tailwind CSS 4 + `@cloudflare/kumo` component library
- **Build**: Vite + `@cloudflare/vite-plugin` (single build for Worker + SPA)
- **Test**: Vitest 4.1 + `@cloudflare/vitest-pool-workers`
- **Formatting**: oxfmt (tabs for indentation)

## Directory Structure

```
src/
  worker/           # Worker entrypoint + BuilderAgent DO
    index.ts        # Hono app, sandbox proxy, agent routing
    agent.ts        # BuilderAgent DO + provisionSite + onChatMessage interview/build phases
    tools.ts        # Sandbox file/shell/unsplash tools
    prompts.ts      # buildInterviewPrompt + buildBuildPrompt (composes markdown sections)
    prompts/        # Prompt prose as markdown files (imported with ?raw)
      build-blank.md # Blank builder schema/design system prompt
      interview.md  # Shared interview behaviour
      interview-blank.md    # Domain-neutral schema/design intake
  client/           # React SPA
    components/     # Chat UI, preview panel, tool cards
  vite-env.d.ts     # Ambient declaration for "*.md?raw" imports
```

## Key Architecture Decisions

1. **The agent runs in a Durable Object**, not the Worker. The DO owns the conversation state (persisted in SQLite), the sandbox instance, and the agent loop. The Worker routes requests to the right DO.

2. **Standalone blank scaffolding.** The Sandbox image contains one installed archive built from `prototype/builder-cloudflare`; each new project extracts it into `/home/user/site`. No monorepo, public-template checkout, `GH_TOKEN`, or workspace links. EmDash itself is on npm (`emdash`, `@emdash-cms/cloudflare`).

3. **There is no template-selection phase.** Provisioning begins immediately from `builder-cloudflare` while the agent runs a domain-neutral interview. Once MCP is connected, the agent creates the schema and frontend from the brief.

   The agent runs in two phases: an **interview phase** (first turn, only the optional `ask_questions` tool, domain-neutral intake from `prompts/interview-blank.md`) and a **build phase** (once provisioning is ready and any questions have been answered or skipped, full tools and rules from `prompts/build-blank.md` plus the scaffold's own `AGENTS.md` appended as `## Template-specific guidance`).

   The opening brief anchors a durable `initialGeneration` state. Interview, setup, and build assistant messages carry its ID, so the client shows one evolving activity card and an ordered timeline. Verified form submissions keep structured answers alongside model-readable text; freeform replies remain visible in chat. Stop, retry, and recovery retain this identity until a validated first site is ready. Later edits remain separate turns.

4. **Sandbox tools:** `read_file`, `read_files`, `write_file`, `write_files`, `edit_file`, `edit_files`, `exec`, `refresh_types`, `validate_site`, `search_unsplash`, `upload_media`, `view_preview`, and `offer_clone`. CMS operations (schema, content, taxonomy, settings) come from the EmDash MCP server at `/_emdash/api/mcp`, wired in at runtime in `agent.ts` against an allowlist (`ALLOWED_MCP_TOOLS`). `upload_media` does its `fetch`/download and `POST /_emdash/api/media` entirely **in the Worker** (via the public preview URL), so the bearer API token never enters the sandbox where the LLM has shell access. `run_cms_script` runs a short program of those CMS and media calls in a Dynamic Worker (Worker Loader binding `LOADER`, gated by `ENABLE_CMS_SCRIPTS`) with no network or bindings; each call runs the same tool object as a direct call, and the program is one mutation window with one preview refresh and checkpoint.

   Builder-managed files (`src/worker.ts`, `src/live.config.ts`, `wrangler.jsonc`, `.dev.vars`, `AGENTS.md`) are refused by `write_file`/`edit_file` (`.dev.vars*` also by `read_file`/`read_files`), and `exec` runs inside `guardProtectedFiles`, which restores any it changed. The guard catches mistakes, not a determined model, so the scaffold guidance that enters the system prompt is pinned in the agent's SQLite rather than re-read from the sandbox.

   The model has no deployment tool. User-initiated static WfP publishing remains behind the server-owned `ENABLE_PUBLIC_PUBLISHING` release flag and account/project authorization.

5. **State and secrets.** Non-sensitive session state (`siteReady`, `previewUrl`, `provisionError`, `persistenceError`) lives in the agent's durable `this.state` (persisted across DO eviction and broadcast to clients for UI; `validateStateChange` rejects client-sent state, so only the server writes it). The API token is a secret/server-only, persisted separately in the agent's SQLite (`this.sql`, `builder_secrets` table, key `apiToken`) and never broadcast. `chatRecovery = true` resumes a turn interrupted by eviction; `waitForMcpConnections` blocks the turn until MCP (auto-restored from SQLite after hibernation) is connected, so CMS tools are present on turn 1 and after eviction.

6. **Sessions persist across sandbox sleep (via Artifacts/git).** A session lives at `/s/<uuid>`; the client mints the id in memory and only writes it to the URL on the first prompt, keeping `/` clean. The uuid is the DO name, the sandbox id, and the session's **Artifacts repo name** (`ARTIFACTS` binding, namespace `emdash-build`). Sandbox disk is ephemeral (wiped on `sleepAfter`), so `backupSite` commits `SITE_PATH` and `git push`es it to the session's Artifacts repo after initial provisioning, after each successful mutating tool, and after each completed turn. The template `.gitignore` excludes `node_modules`/`dist`/`.astro` (reinstalled/rebuilt on restore) but **not** `.wrangler`, so the EmDash D1 + R2 local state (content + media) rides along. Opening an existing sidebar project calls `resumePreview` immediately: warm → reactivate the stable preview URL; site dir gone → `git clone` the repo + reinstall + restart. An established site with no usable snapshot fails closed and is never replaced by a clean template. The Worker only mints short-lived, repo-scoped git tokens (`repo.createToken`); commit/push/clone run in the sandbox via `http.extraHeader` (token kept out of the remote URL and never echoed). This replaced the R2 `createBackup`/`restoreBackup` path, whose container-side exclude-file step failed on our custom image.

7. **The blank prototype replaces the visual quality floor with an authoring contract.** The agent designs schema, Astro components, routes, and Tailwind styling from scratch, using source-owned accessible primitives and repeated screenshot QA.

8. **`AIChatAgent` is in `@cloudflare/ai-chat`**, not in the `agents` package. The client hook `useAgentChat` is in `@cloudflare/ai-chat/react`.

9. **Sandbox proxy must be first.** In the Worker fetch handler, `routePreviewRequest(request, env)` must be called before any other routing. It sends preview hosts (`<port>-<project uuid>-<token>.<PREVIEW_HOSTNAME>`, or `.localhost` locally) to the project's Sandbox, which checks the token; other hosts never wake a Sandbox. WebSocket upgrade responses must be returned unchanged; reconstructing the response drops the socket and breaks Vite HMR. The generated Astro config points HMR at the public preview host, never container-local `localhost:4321`.

10. **Public preview HTML is last-known-good, not synchronous authoring traffic.** Astro's Cloudflare dev runner can hold a document request for tens of seconds while the agent is concurrently editing or using MCP, even when the page render itself takes milliseconds. The app exports a small `Sandbox` subclass that stores the last successful public HTML response per route in the Sandbox DO's SQLite, tagged with the content generation it was rendered at. Builder mutations (and dev-server restarts) bump the generation, then re-render `/` plus the routes builder clients report viewing (`setPreviewPath`) before broadcasting the iframe reload; CMS writes through the preview origin also bump it. Current snapshots are served immediately; older ones re-render canonically (credential-free) for up to 5s and otherwise fall back to the last good snapshot marked `STALE`. Responses negotiated on request headers (`Vary` beyond `Accept-Encoding`) are never cached. Credential-free misses populate it opportunistically; misses carrying cookies (e.g. after the Admin tab) seed it from a background canonical render. A page left on a `STALE` copy retries, then polls `getPreviewRouteSnapshot` and reloads once the snapshot is current. CMS/admin/API traffic, assets and WebSockets always pass through to the live dev server.

11. **Preview navigation bridge.** The preview is cross-origin to the app, so the Worker's proxy branch injects a small inline script (`preview-bridge.ts`, via HTMLRewriter, after the Sandbox cache so it never enters snapshots, Artifacts or deploys). It `postMessage`s path/title/links to the app origin (the preview host minus its first label) and accepts a `reload` command. `PreviewPanel` owns the iframe `src` imperatively, so reloads keep the current route.

## Bootstrap Flow

`BuilderAgent.onChatMessage` runs a two-phase flow on a new session:

**Turn 1 (interview phase).** The user's first message arrives. The agent:

1. Kicks off `provisionSite(hostname)` from the prepared blank scaffold as a background promise stored on `this.provisionPromise` (not awaited).
2. Streams the domain-neutral interview from `buildInterviewPrompt()` with no tools. The model asks only questions that materially affect the site's content model or direction.

`provisionSite` does the heavy lifting in parallel:

- Extract `/home/user/.prepared/builder-cloudflare.tgz` into `/home/user/site`
- Write `src/middleware.ts` to strip `X-Frame-Options` / CSP for iframe embedding
- Activate the stable port-4321 preview URL, pass it to the Astro process for Vite HMR, and mirror it in `.dev.vars` for the runtime
- `pnpm dev --host 0.0.0.0`, wait for port 4321
- `curl '/_emdash/api/setup/dev-bypass?token=1'` — migrations + dev admin + template seed, returns a full-scope PAT at `data.token` in one call
- `sandbox.exposePort(4321, { hostname, name: "preview" })`
- `addMcpServer("emdash", mcpUrl, { transport: { headers: { Authorization: ... } } })`

**Build phase.** When the user replies or provisioning finishes without pending questions, the agent:

1. Awaits the in-flight `provisionPromise` (usually already resolved). If it's still pending, the turn blocks here until provisioning is done.
2. Loads the blank scaffold's `AGENTS.md` via `loadTemplateGuidance()` (pinned in SQLite on first read, so later sandbox edits cannot change the prompt).
3. Builds the system prompt with `buildBuildPrompt({ templateGuidance })` from `prompts/build-blank.md` plus the scaffold-specific section.
4. Runs `streamText` with the full tool set (sandbox tools + MCP tools).

Opening an existing session calls `resumePreview` without waiting for another message. Follow-up messages also call `recoverSite`: it reuses the warm sandbox, or `git clone`s the session's Artifacts repo and restarts the dev server if the sandbox slept. Recovery never re-scaffolds an established project; missing or failed persistence is surfaced to the user instead.

## Conventions

- Tabs for indentation
- ESM only, `.js` extensions on relative imports
- `import type` for type-only imports
- Run `pnpm check` (tsc) after changes
- Run `pnpm format` (oxfmt) to format
- `UNSPLASH_ACCESS_KEY` lives in `.dev.vars` locally; push to secrets for deploy
