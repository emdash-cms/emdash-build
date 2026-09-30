# Operations

## Readiness milestones

BuilderAgent emits structured `builder.milestone` events for container start,
preview, CMS, agent tools, personalization and completion. Alert and product
timing should treat these as separate boundaries rather than one `siteReady`
duration.

Initial targets:

- real template navigable: p95 under 15 seconds
- personalized above the fold: p95 under 30 seconds
- simple follow-up visible: p95 under 15 seconds
- refresh/reconnect must not duplicate the initial build

## Turn metrics

Every model turn (interview, holding reply, first build, follow-up), including
failed and stopped ones, logs one `builder.turn_metrics` event. The latest is
also kept in agent state as `lastTurnMetrics`. Fields:

- `kind`, `resumed`, `outcome` (`finished`, `stopped`, `error`), `finishReason`,
  a shortened `error`, and `stepCapReached`
- `wallMs` from the start of `onChatMessage`; `setupMs` until the model call,
  including sandbox recovery; `finalSaveMs` for the end-of-turn backup
- `steps`, `tokens` (`input` includes `cachedInput`), `peakInputTokens`, and
  `subcalls` for batch entry-text model calls
- per-tool `calls`, `ms` and `failures`, including calls the SDK rejected
  without running them (invalid input, unknown or disabled tool) at 0 ms;
  `sync` is the time tools wait on sync work: `previewRefresh` for marking
  preview snapshots stale (the re-render runs in the background) and `backup`
  for staging and committing a checkpoint (the upload runs in the background)
- `stepTimings` for the first 64 steps (`stepTimingsOmitted` counts the rest),
  each measured from the step's start: the requested `effort`; `attempts`, the
  model HTTP attempts (above 1, the times include the SDK's retry backoff);
  `firstByteMs` to the successful attempt's response headers; `firstChunkMs`
  to the first reasoning summary, answer text or tool input; `firstOutputMs`
  to the first answer text or tool input (queueing plus thinking); `ms` to the
  step's end including its tools; the step's `tokens`; and `incomplete` when
  the step never finished (stopped, failed or out of retries)
- `modelWaitMs`, the sum of the timed steps' `firstOutputMs`
- `scriptCalls`: the calls `run_cms_script` programs made, by inner tool, with
  the same `calls`, `ms` and `failures` as `tools` (the program itself is in
  `tools.run_cms_script`)
- `modelHttp`: model HTTP attempts, including SDK retries and entry-body
  sub-calls, with failed statuses counted by code (`0` is a network error; a
  Stop is not counted)

`lastTurnMetrics` in agent state omits `stepTimings`; the log line has them.
Model requests carry `cf-aig-metadata` (`session`, `turn`, `kind`, and
`purpose` for sub-calls), so AI Gateway logs join to these records.
`builder.initial_build_benchmark` carries an `outcome` of `completed`,
`failed` or `stopped`; unfinished first builds are logged too.

Tool times overlap when tools run in parallel, and `sync` includes time spent
waiting behind another backup. Waiting for MCP before `onChatMessage` and a
Durable Object eviction mid-turn are not covered; the resumed turn records
with `resumed: true`. A failed end-of-turn backup makes the outcome `error`
(`Session backup failed: ...`). A turn evicted during that backup is logged by
recovery as it stood before the backup, with `finalSaveMs: null` (log only; it
does not replace `lastTurnMetrics`).

To measure a change, run the same fixed brief before and after it:

```bash
EMDASH_SMOKE_BRIEF=stargazing pnpm smoke:chat   # usually asks questions first
EMDASH_SMOKE_BRIEF=bakery pnpm smoke:chat       # detailed; usually builds straight away
EMDASH_SMOKE_BRIEF=editorial pnpm smoke:chat    # stories, authors, sections
```

Briefs live in `scripts/smoke-briefs.json`. Each run builds the site, checks the
public routes, sends one follow-up edit, and checks the routes again. Each check
renders live (`cacheHits` should be 0). `followUp.landed` reports whether the
edit's expected text reached a public page's visible text (`null` when it was
already there before the edit); `false` fails the run. The editorial follow-up
also requires the specified story to disappear from Waterways and appear on the
Brookwatch filtered route; a section label alone does not count as a move. The output also
lists every turn record plus `totals`, and `questionnaireObserved`
shows which path the interview took (`EMDASH_SMOKE_REQUIRE_QUESTIONNAIRE=1`
requires questions). Every run, including a failed or timed-out one, prints one
JSON result, with `reason` set when `ok` is false. A server restart mid-run
closes the agent socket and fails the run; rerun it.

Set `EMDASH_SMOKE_BROWSER=1` to also open a fresh anonymous Chromium session
after each round and check visible content on `/` and up to two discovered
routes. This requires the `agent-browser` CLI and fails the smoke when a page
renders blank; it does not replace the raw HTML/link crawl. For a quick browser
check of an existing preview, run `node scripts/smoke-browser.mjs <preview-url>`.

Public preview snapshots accept only complete HTML with visible body content.
An empty or partial HTTP 200 response fails validation, cannot replace the last
complete cacheable page, and returns 503 on an anonymous cache miss. Responses
with negotiated `Vary` are checked but remain uncached.

`EMDASH_SMOKE_URL` points at another dev server (default
`http://localhost:5173`). `EMDASH_SMOKE_PROMPT` and `EMDASH_SMOKE_ANSWER`
override the brief; a custom prompt gets a neutral answer and runs without a
follow-up unless `EMDASH_SMOKE_FOLLOW_UP` (and optionally
`EMDASH_SMOKE_FOLLOW_UP_EXPECT`) is set, and an empty follow-up skips it. Model
output varies between runs, so compare several runs per brief.

## Publication invariant

At every failure boundary, `activeReleaseId` remains the previously validated
release. Retried mutations reuse their idempotency key. Rollback copies a known
release bundle into the stable live slot; it does not rewind content.

Builder publication is synchronous and bounded: checkpoint the draft, copy that
frozen tree and its installed dependencies into a temporary publish workspace,
build once without stopping or sharing mutable dependency state with the
authoring server, capture the anonymous static snapshot, then write artifacts
and run ensure → candidate health → promotion. The browser receives only the
final stable URL or one actionable failure.

Every attempt emits one terminal `builder.publish_run` JSON record with its run
ID, short reference, final phase, result code and elapsed time. A failed Publish
dialog shows that reference without exposing tokens, owner keys, content or raw
provider responses.

- `SITE_BUSY` means a turn, recovery or another publish is active.
- `SITE_CHANGED_DURING_PUBLISH` means the draft changed during capture; retry.
- `SNAPSHOT_UNSUPPORTED` identifies dynamic behavior that cannot run in the
  static publication.
- `SNAPSHOT_TOO_LARGE` identifies a route, file, asset-count or byte limit.
- `PUBLISH_NOT_CONFIGURED` means a required provider binding, value or secret is
  absent.
- `PUBLISH_FAILED` means candidate or promotion work failed; the prior Live
  release remains active.

The same snapshot reuses its release ID and provider operation keys. One
terminal retryable deploy or promotion failure may advance from attempt `0` to
attempt `1`; no later attempt is created. An interrupted ambiguous operation is
replayed with the same key so the control plane reconciles remote identity.

## Capacity and abuse

- Guest identities are limited to ten projects in the reference app.
- Keep Sandbox `max_instances` aligned with the account's deliberate capacity.
  Production allows 100 concurrent sandboxes (4 vCPU and 12 GiB each), about a
  quarter of the default account limit of 1,500 vCPU. Past the cap, a new
  container waits for the SDK's retries (about two minutes) and then fails, so
  watch for `ContainerUnavailableError` and AI Gateway 429s before raising it.
- Add provider rate limiting/Turnstile before opening an unrestricted public demo.
- Expire idle Sandbox compute while retaining source in Artifacts.
- Commit recovery snapshots from a stable staging copy after initial setup,
  each successful mutating tool and each completed turn; never run Git against
  the live Vite/SQLite tree. A follow-up turn can reuse its last successful
  checkpoint instead of pushing the same site again when the preview generation
  is unchanged. Resumed turns, shell calls, failed tools and uncertain state
  still force a final save. The staging copy excludes only Miniflare's transient
  `.wrangler/state/v3/observability` traces; D1 and R2 state remain in the repo.
- Established projects fail closed when no snapshot can be restored. Never
  replace an owned project with a clean template as a recovery fallback.
- Never retry provisioning or publication without a bound attempt count.
- Dev-server start/restart uses a direct TCP probe and fails within 45 seconds;
  it must never inherit the SDK's two-minute wait boundary.
- The client masks the exposed-port disconnect while Astro restarts. If the
  Sandbox transport changes, BuilderAgent discards stale handles, reacquires
  the stable sandbox id and reloads only after recovery succeeds.
- Opening an existing sidebar project proactively wakes the Sandbox and
  reactivates port forwarding. Vite HMR uses the public preview host, and the
  Worker must preserve WebSocket upgrade responses from `routePreviewRequest`.
- Serialize per-site MCP calls through the Astro dev runner and reload the
  preview only for mutating CMS tools. Parallel MCP bursts otherwise queue
  user page loads behind several multi-second dynamic requests.
- Keep the last successful public HTML response per route in the Sandbox DO.
  Builder mutations refresh it before reloading the iframe, so user-facing
  preview traffic does not queue behind the authoring runner. CMS, admin,
  static assets and WebSockets always bypass this cache.
- Leave `PREVIEW_ROUTE_SUFFIX` unset on the production Worker. An isolated review
  deployment with its own bindings may set a two-to-four character suffix to
  route its Sandbox preview hosts through a narrow wildcard on a separately
  provisioned preview domain. The remaining token bytes stay random and the
  token is still stored per session; this does not replace wildcard DNS/TLS.

## Release rehearsal

For every release exercise:

1. Record current Worker and container versions.
2. Create a new guest project and reach every readiness milestone.
3. Refresh during a turn and recover after Sandbox sleep.
4. Validate candidate release directly.
5. Prove a failed candidate leaves Live unchanged.
6. Promote a second release on the same hostname.
7. Roll back and verify the prior release.
8. Re-query deployed scripts, namespaces and routes.

Do not use a narrow unit suite as evidence for the browser, Sandbox or WfP
boundaries.
