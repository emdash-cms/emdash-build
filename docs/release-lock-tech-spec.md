# Public release lock

Status: approved for implementation by the 2026-09-28 user request.

Base: `origin/main` at `9b4404e0bb32eaa23a468d5d5e202c641422e3a1`.

Stack position: a standalone release-safety change after the first-class blocks workflow. It does not depend on site transfer and does not alter generated-site authoring.

## Purpose

Keep EmDash Build usable as an in-product, iframe-based demo while temporarily removing every supported path that turns a draft into a publicly routed site. A copied Sandbox preview URL must not render as a top-level website in a normal browser, while the Builder iframe, EmDash Admin, HMR, MCP, media, preview caching and Artifacts recovery continue to work.

The lock must be easy to reverse deliberately later, but fail closed when configuration is absent or malformed.

## Verified current behavior

- `POST /api/projects/:projectId/publish` authenticates the account and publishes a static snapshot through the WfP control plane.
- `GET /api/projects/:projectId/publish` exposes named-site and current-publication state to the Publish popover.
- `routeProviderSite()` routes both `s-<uuid>.<sites host>` and named `*.em-da.sh` traffic to stable WfP scripts.
- The client always renders `PublishPanel` in an active workspace and can surface an older `state.publication` or temporary-deploy result.
- The current Builder model tool set does not include `deploy_site`. The private temporary-account deploy implementation, historical tool-card rendering and capability detection remain in the tree but are unreachable from current build turns.
- Sandbox proxying must remain the first Worker operation. Non-WebSocket proxy responses have frame-blocking headers removed and receive the preview navigation bridge.
- The preview toolbar exposes the current draft, Admin or Live URL through **Open in a new tab**.
- The production Admin bootstrap deliberately performs a top-level preview navigation carrying `__emdash_build_return`; same-origin redirects retain the marker and the injected bridge returns the browser to `/s/<project-id>` after the preview-origin session cookie is established.
- Quick-tunnel Admin opens in a separate tab only in disposable branch Preview/local validation flows.

## Included scope

1. Add `ENABLE_PUBLIC_PUBLISHING` and `APP_HOSTNAME` as non-secret Worker variables in the root and Worker Preview configurations. Only the exact string `"true"` enables publication; missing, empty or any other value is disabled. Provider configuration renders `APP_HOSTNAME` from its existing application hostname.
2. Return one uniform disabled response from both publish endpoints before authentication, ownership, slug, snapshot or provider work.
3. Include the resolved publication capability in `/api/project-session`, and hide Publish/Live/legacy deployment UI when disabled.
4. Make `routeProviderSite()` return `404` for recognized canonical or branded public-site hosts without touching D1, Site capabilities or the dispatcher when publication is disabled.
5. Remove the preview toolbar's external-open control.
6. For Sandbox-proxied traffic on recognized preview hosts:
   - reject ordinary top-level browser document navigations with `404` before redirects or response rendering;
   - allow iframe documents;
   - allow the validated Admin return bootstrap;
   - replace generated frame policy with `Content-Security-Policy: frame-ancestors 'self' <configured-builder-origin>`;
   - leave iframe redirects, assets, APIs, HMR WebSockets and other non-document traffic on their existing paths.
7. Correct `AGENTS.md` so it no longer tells future agents that `deploy_site` is in the current model tool set.

## Explicit non-goals

- Deleting WfP resources, dispatch namespaces, secrets, published-slug records or publication implementation.
- Revoking already claimed Cloudflare temporary-account deployments.
- Adding signed preview tokens, preview cookies, a new authentication subsystem or a public/private visibility model.
- Treating Fetch Metadata or `frame-ancestors` as full authorization. This is temporary browser containment, not bearer-link security.
- Turnstile, build/model rate limits, account-only project creation, brand-impersonation policy, scanning, takedown tooling or site transfer.
- Changing Sandbox exposure, preview tokens, last-known-good caching, HMR, Admin authentication, MCP, media, Artifacts, provisioning or recovery.
- Changing quick-tunnel branch Preview behavior.
- Removing historical deployment rendering or dead temporary-deploy code solely for cleanup.

## Architecture and contracts

### Publication capability

Add one side-effect-free helper that evaluates `env.ENABLE_PUBLIC_PUBLISHING === "true"`. All server decisions use that helper.

`/api/project-session` adds:

```ts
publishingEnabled: boolean;
```

This is an internal capability advertisement, not authorization. The publish endpoint continues to perform account and ownership checks when enabled.

When disabled, both publish endpoints return `404` with the same bounded body:

```json
{
	"code": "PUBLISH_DISABLED",
	"message": "Publishing is temporarily unavailable."
}
```

The check runs before request-body parsing and provider access. Enabling the flag preserves the existing endpoint behavior unchanged.

The client treats a missing capability as disabled. It passes an explicit non-rendering value through `ProjectHeader` so that component's legacy fallback Publish button cannot appear, does not surface persisted `publication`/`deploy` URLs, and never offers the draft/live switch. Source export remains available.

### Public-site routing

`routeProviderSite()` receives an `enabled` option that defaults to the current enabled behavior for direct callers and tests. The Worker passes the resolved flag explicitly.

When `enabled` is false:

- any host below `BRANDED_SITES_HOSTNAME` returns `404`;
- a canonical `s-<uuid>.<SITES_HOSTNAME>` host returns `404`;
- other hosts remain outside provider routing;
- no D1 lookup, capability construction or dispatcher call occurs.

Sandbox preview proxying still runs first, so active `<port>-<id>-<token>.<SITES_HOSTNAME>` previews are unaffected.

### Preview containment

The Worker continues to proxy the request before all application routing and returns WebSocket upgrades unchanged.

For a recognized Sandbox preview host:

- `Sec-Fetch-Dest: document` means top-level browser navigation and receives a generic `404` before redirects or response-type handling, unless a GET request's `previewEditorReturnUrl()` validates the existing Builder return marker.
- `Sec-Fetch-Dest: iframe` and other nested preview document requests continue.
- Missing Fetch Metadata continues for compatibility; the containment guarantee targets normal current browsers and is explicitly not authentication.
- Allowed HTML responses get `frame-ancestors 'self' <configured Builder origin>`. `APP_HOSTNAME` supplies the production origin even when app, preview and published-site hostnames are intentionally distinct; localhost preview bases derive their current origin and port. This preserves same-origin nested frames and the Builder iframe while preventing other websites from embedding the preview.
- The Admin bootstrap is allowed only through the existing exact same-origin `/s/<uuid>` return validation; its redirect marker propagation and top-level bridge return remain unchanged.
- Quick-tunnel hosts are not recognized by `previewParentOrigin()` and retain their existing branch-review behavior.

Top-level rejection runs before response classification for every request method. The frame policy applies to every allowed HTML response, while the navigation bridge remains GET-only. This prevents generated redirects or POST routes from bypassing containment while preserving the existing rule that only safe GET documents are rewritten.

The client removes only the general external-open link. The quick-tunnel Admin action remains because that environment intentionally cannot certify production iframe-cookie behavior.

## Failure, retry and recovery behavior

- The publication lock is stateless and deterministic. Retries cannot bypass it.
- Disabling during an in-flight publish is not a cancellation mechanism. Operational rollout must avoid starting new publishes before deploying the disabled Worker; this PR prevents requests received by the disabled version.
- Existing publication metadata remains stored, but its route and client presentation are suppressed.
- Preview containment adds no durable state and does not participate in Sandbox or Artifacts recovery.
- A stale or sleeping preview still follows the existing recovery path. Once proxied HTML resumes, the same document rules apply.

## Validation

Focused automated coverage must prove:

- missing, false and malformed publication values are disabled; only `"true"` enables;
- disabled publish GET/POST requests return the same response before account/provider work;
- enabled endpoint behavior remains covered by the existing publication tests;
- disabled canonical and branded routes return `404` without D1, capability or dispatcher calls;
- project session capability is false by default and true when enabled;
- the disabled full workspace/header contains no `[data-publish-button]` fallback and no persisted Live/deploy presentation;
- direct top-level GET and POST preview HTML are rejected;
- iframe GET and POST HTML receive the Builder-only frame policy, while only GET receives the bridge;
- distinct configured app and preview hostnames still allow the app origin, not the preview wildcard base;
- the validated Admin top-level return flow remains allowed;
- assets/non-HTML responses and WebSocket behavior are unchanged;
- the preview toolbar has no external-open link while in-frame navigation and quick-tunnel Admin remain functional.

Final checks: focused Vitest suites, Worker suites affected by configuration, `pnpm check`, `pnpm format`, production build, `git diff --check`, and one browser journey covering Builder iframe, Admin switch/login, direct copied preview rejection and saved-preview recovery when the local Sandbox harness is available.

## Commit plan and size gates

### Commit 1: specify the release lock

- Add this specification only.
- Expected documentation: 150-230 lines.

### Commit 2: disable public publication end to end

- Configuration/type generation, Worker capability and gates, provider routing, project-session capability, client presentation, `AGENTS.md`, and focused tests.
- Expected production/config/docs: 70-140 changed lines.
- Expected tests: 50-110 changed lines.
- Does not change publication internals or delete provider resources.

### Commit 3: contain previews inside Builder

- Preview response guard/frame policy, toolbar external-link removal, and focused Worker/UI tests.
- Expected production: 35-80 changed lines.
- Expected tests: 35-90 changed lines.
- Does not introduce signed preview auth or change quick-tunnel Admin.

Warning gate: investigate if either implementation commit exceeds 170 production/config lines or 130 test lines. Blocking gate: stop before committing if the combined implementation exceeds 280 production/config lines, requires a new state machine/table/service, changes Sandbox/recovery architecture, or cannot preserve Admin login and HMR.

## Acceptance criteria

1. A production deployment with the committed default cannot publish through UI or direct API calls.
2. Previously routed WfP hosts return `404` while the lock is disabled.
3. An active generated site remains visible and editable inside EmDash Build.
4. Opening the copied draft preview URL in a normal private browser window returns `404`.
5. The EmDash Admin bootstrap, iframe session, HMR, MCP, media, caching and recovery remain functional.
6. Setting `ENABLE_PUBLIC_PUBLISHING` to exactly `"true"` restores the existing publication path without a data migration.
7. No Cloudflare resources, secrets, live deployments or GitHub state are changed by implementation.

## Authority

This document records the approved design but does not itself authorize deployment, secret deletion, Cloudflare dashboard changes, push, PR creation, merge or release. The current user request separately authorizes local implementation and sequential local commits only.
