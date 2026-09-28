# Named publishing on em-da.sh

Status: implementation contract for one Build PR, based on `cc8ed5a` (September 25, 2026).

## Outcome and scope

A signed-in project owner chooses one available label and publishes to
`https://<label>.em-da.sh`. The top-right Publish button opens a small anchored
popover: address entry, clear progress, a live link with Copy link and Visit
site actions, or an actionable failure. The draft remains editable. Existing
UUID-based links keep working. This is a platform-owned publishing hostname,
not customer-managed domains or CMS transfer.

The first successful label is permanent for that project in this PR, so shared
links cannot silently change owners. Before a live mutation starts the owner may
correct a pending label. Once a live mutation starts, the label is held during
reconciliation if the response is ambiguous. A previously published UUID site may opt into a label on its
next publish. A project already live on `em-da.sh` republishes to its existing
label. No automatic slug from the project title, custom-domain UI, social
sharing integrations, or background publish coordinator.

## Verified boundaries

- Build currently derives `s-<site UUID>.build.emdashcms.com`; the live WfP
  script identity is already site-ID-based. Its public router only recognizes
  the UUID host. `setHostname` is deliberately unsupported.
- A successful static snapshot publish updates `BuilderAgent.state.publication`;
  the old live release remains available until the candidate passes health and
  promotion succeeds. The existing web response is synchronous but the dialog
  can close while the request stays in flight.
- Production `AUTH_DB` is a D1 database; branch Previews bind a separate shared
  Preview D1. The `em-da.sh` zone is active in the same EmDash CMS account.
  Wildcard DNS does not currently resolve. `cdn.em-da.sh` already serves
  `blob-proxy` through a Custom Domain. The Build wildcard route would also
  match CDN requests, so install a higher-priority
  `cdn.em-da.sh/* → blob-proxy` route before deploying Build's route. Preserve
  the existing proxied DNS and Custom Domain.
- New site scaffolds pin EmDash `0.40.0`; persisted sites keep their own older
  dependencies. This PR does not migrate an old site's CMS version.

## Backend contract

Add one D1 migration with `published_site_slugs(slug TEXT PRIMARY KEY,
site_id TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 0)`. The primary
key enforces global uniqueness; the unique site ID prevents a site from owning
two names. Only authenticated ownership-checked publish requests may reserve.
Accepted labels: lowercase ASCII letters, digits and interior hyphens,
3–63 characters; no leading/trailing hyphen, dots, ports, Unicode lookalikes,
or reserved platform labels (`www`, `api`, `admin`, `cdn`, `build`). Return a
specific 409 for a taken name and 400 for an invalid name without running a
build. The server revalidates independently of the form.

`POST /api/projects/:id/publish` accepts `{ slug }`, with absent slug retaining
the legacy UUID behavior for old clients. At the start of the existing
owner-fenced operation, reserve by atomic D1 insert/upsert: an inactive pending
project may change its name; an active project cannot. Build and
capture use the selected branded origin in `EMDASH_SITE_URL` and snapshot URL
rewrites; script identities stay UUID-based. On a failed build or WfP
mutation, the pending reservation remains for a retry or project deletion and
is never publicly routable. Immediately before a live mutation, activate the
label with one atomic D1 update. This ensures the new build's branded absolute links resolve
if promotion succeeds, including when the response is lost. During the narrow
pre-promotion interval, a first-time named host may return unavailable; an
existing UUID live release remains reachable. Definitive rejected probes or
promotions reset an unpublished label to pending, but ambiguous results retain
the binding for exact-release reconciliation. After a confirmed promotion,
persist/return the branded URL. Do not promise that Live is unchanged after an
ambiguous result. A database failure after promotion cannot strand the old
live release with links to an inactive branded hostname.

If execution stops between activation and provider acknowledgement, the name
may route briefly to the site's old public release (or 502 before first Live),
but the UI does not call it published. A retry uses the existing provider
idempotency and reconciliation path. This is the bounded, same-site trade-off
for two stores without a distributed transaction; no other owner's content
becomes visible.

An authenticated project-scoped GET reads the reserved/active label from D1 so
a refresh remembers the chosen address. The UI claims success only when the
active mapping and confirmed agent publication agree; when agent state was not saved, it asks the
owner to retry for reconciliation. POST with no slug reuses the D1 name for old
clients.

On `*.em-da.sh`, resolve only a single valid label with an active row. Unknown
or pending names return 404; a database error returns 503. Dispatch to the
existing `e-<site UUID without hyphens>-live` WfP script with the same bounds,
site capability, and hidden health paths as the UUID route. Do not fall through
to the Builder SPA. The old UUID hostname remains a working alias for legacy
links. One D1 lookup per public request is acceptable for this first version;
do not add cache invalidation or a new coordination service prematurely.

After the existing exact-site WfP cleanup succeeds during agent deletion,
remove its slug row **inside that agent operation**, before erasing Artifacts,
Sandbox or agent storage. A partial cleanup is retryable and must not release
a still-live name to another owner.

Production config adds an `em-da.sh` wildcard route and branded-hostname var.
Branch Previews do not claim `em-da.sh` as a working public origin: their
separate D1 and shared dispatch namespace cannot prove production DNS routing.
Do not accept Preview publishing at all while that WfP namespace is shared: a
duplicate site UUID could overwrite production. UI and data behavior are
verified locally; the public hostname check runs on production after the route
and DNS are configured.

## Popover behavior

Use Kumo's `Popover` anchored under the header's Publish button, aligned right
and fitting a narrow viewport. On first publish show a labelled address input
with a visible `.em-da.sh` suffix, a sample URL, and Publish action. On repeat
show the permanent address. Keep the popover available while publishing; closing
it does not cancel the in-flight request. The trigger says “Publishing…” until
completion. The success state shows the verified URL, Copy link, Visit site,
and Publish again. Copy has a success/failure announcement and selectable link
fallback. Failure keeps the typed name, shows collision or build errors in
plain language and lets the owner retry. Escape/outside click returns focus to
the trigger. Respect reduced motion and keyboard/200% zoom; do not imitate
Lovable's branding, icons or social sharing.

## Checks and release gate

- Test invalid/taken labels, concurrent owner collision, pending correction,
  active immutability, wrong-owner access, deletion order and retry, failed and
  ambiguous promotion, old UUID compatibility, pending/unknown branded host,
  and the production host's hidden health paths.
- Test keyboard popover use, close-during-publish, link/copy feedback, and
  narrow layouts with focused component/browser checks.
- Run focused Vitest, `pnpm check`, `pnpm format`, production build, and a
  same-account two-project publish rehearsal. The final live smoke checks a
  branded route, page navigation, media bytes, old UUID alias, and republish.

Two commits: (1) D1 name reservation, routing, worker config and tests
(~180–300 production, ~180–300 test lines); (2) popover/request wiring,
UI tests and operator guidance (~160–270 production, ~100–180 test lines).
These are review alarms, not targets. No transfer coordinator, CMS migration,
custom domain service, or unrelated refactor.

Cloudflare prerequisite: a proxied `*` DNS record in the existing `em-da.sh`
zone, the exact `cdn.em-da.sh/* → blob-proxy` route (managed outside Build),
Build's wildcard route, and active TLS for a sample subdomain. Verify an
existing CDN object before and after routing. The PR cannot be called
production-ready until these are confirmed.
This specification alone authorizes no code, DNS, GitHub, merge or deployment
mutation; the accompanying user request separately authorizes implementation,
PR creation and a merge once verified.
