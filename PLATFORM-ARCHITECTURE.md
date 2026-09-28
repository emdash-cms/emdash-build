# EmDash Build Platform Architecture

Status: exploratory design note

This document explores how EmDash Build could evolve from a technology demo into a platform that hosting providers can offer to their customers. It focuses on four problems:

1. Showing a useful preview much sooner.
2. Deploying sites through Workers for Platforms without running Wrangler in the Sandbox.
3. Giving sites a stable production lifecycle with updates and rollback.
4. Letting users continue to edit design and content after publication.

There is no backwards-compatibility requirement. Existing sessions and deployment behavior can be replaced if a simpler architecture results.

## Summary

The recommended architecture separates authoring from production:

```text
Authoring plane

Chat UI -> BuilderAgent -> Workspace DO -> Sandbox compute
                            |                 |
                            |                 +-- Astro dev server
                            |                 +-- production build
                            |
                            +-- durable source and history

                                      |
                                      v

                                Release Bundle

                                      |
                                      v

Production plane

Provider control plane -> Workers for Platforms -> Site Worker release
              |                                      |
              +-- hostname -> active release         +-- stable Site DO
              +-- publish and rollback               +-- R2 media
              +-- resource lifecycle                 +-- static assets
```

The key decisions are:

- The Sandbox is disposable compute, not the durable owner of a project.
- A Workspace Durable Object can eventually own the source filesystem and history.
- A stable Site Durable Object can own production CMS content across code releases.
- Production code is deployed as immutable Workers for Platforms releases.
- A dispatch Worker maps a stable hostname to the active release.
- Publishing is an explicit product action, not an agent tool call.
- Content publication and design/code publication become separate operations after the first release.
- Direct, structured edits should not require an LLM.

## Product Goals

The target experience is:

```text
Describe a site
-> see the real template quickly
-> watch it become personalized
-> publish to a stable URL
-> continue editing safely
-> publish an update
-> roll back if necessary
```

For hosting providers, the system should demonstrate more than code generation. It should provide a credible site lifecycle:

- Provider-owned infrastructure and branding
- Stable site identity
- Structured CMS content
- Safe preview and production separation
- Explicit publication
- Repeatable updates
- Release history and rollback
- Custom domains
- Export and ownership portability

## Current Bottlenecks

The current provisioning path performs substantial work before publishing the preview URL:

1. Classify the theme with a model call.
2. Start a Sandbox container.
3. Clone the templates repository.
4. Copy and transform the selected template.
5. Run `pnpm install`.
6. Start the Astro development server.
7. Run EmDash setup and migrations.
8. Mint the API token.
9. Expose port 4321.
10. Connect the MCP server.
11. Mark the site ready and publish the preview URL.

The interview hides some of this latency, but it does not reduce it. The first build then performs many agent and MCP round trips to customize design, settings, navigation, content, and media.

The current deployment path has separate limitations:

- It stops the development server during the build.
- It runs `npx wrangler@latest` inside the Sandbox.
- It depends on temporary Cloudflare accounts and claim URLs.
- It strips R2, Worker Loader, cron triggers, and the plugin bridge.
- It produces a one-off snapshot with no stable update path.
- Later builder changes are not connected to the deployed site.

## Principles

### Show the real site early

Prefer an early, uncustomized render of the real Astro template over a second browser-only renderer. A fake preview risks visible differences when the real site replaces it.

### Remove work before hiding it

Interviews, progress UI, and skeleton states are useful, but they should not substitute for removing runtime cloning, installation, repeated setup, and unnecessary tool calls.

### Keep credentials out of generated environments

Cloudflare account credentials and production API tokens must remain in the trusted control plane. The agent and Sandbox shell must never receive them.

### Make production immutable where possible

Code and asset releases should be immutable. Promotion and rollback should update a small routing record rather than mutating the currently active release.

### Keep mutable content stable across code releases

Once a site is in production, its content database should have a stable identity. Deploying or rolling back code should not normally replace the production CMS database.

### Use the CMS as a differentiator

Lovable, v0, Bolt, and Replit generally treat site content as code. EmDash already has structured content, revisions, taxonomies, media, and editorial workflows. The builder should expose those capabilities instead of hiding them behind agent-generated file changes.

## Faster First Preview

Latency should be measured as several milestones rather than one undifferentiated provisioning duration:

| Milestone            | Meaning                                                   |
| -------------------- | --------------------------------------------------------- |
| First response       | The interface visibly reacts to the prompt                |
| Template preview     | The real selected template is navigable                   |
| Personalized preview | Identity, palette, hero, and navigation reflect the brief |
| CMS ready            | Structured content can be read and written                |
| Build complete       | Full content, media, and validation are finished          |

### Publish preview readiness sooner

Use separate state fields instead of one `siteReady` boundary:

```text
containerStarting
previewReady
cmsReady
agentToolsReady
personalized
complete
```

As soon as the homepage responds successfully, expose the port and publish the preview URL. Token creation and MCP connection can continue in parallel. The Admin tab can remain disabled until `cmsReady`.

### Bake templates and dependencies into the image

The Sandbox image can include:

- All supported templates
- Installed dependency trees or a prepared package store
- Current EmDash Build configuration transforms
- Iframe middleware
- Vite dependency configuration
- Template guidance metadata
- Any portable Astro synchronization output

Provisioning then becomes:

```text
select prepared template -> copy workspace -> start dev server -> expose port
```

One image containing prepared template archives is likely simpler than one container class per theme. Image size and cold-start behavior should be benchmarked before choosing.

### Start speculatively

The builder can allocate a generic Sandbox when the user shows strong intent:

- Prompt input receives focus
- The user begins typing
- A quick-start card is selected

The selected template should not require a separate container because all prepared templates are available in the same image.

### Replace the initial tool marathon

The first build has a bounded shape. The model can produce one typed customization plan:

```ts
interface SitePlan {
	identity: {
		title: string;
		tagline: string;
		audience: string;
	};
	designTokens: Record<string, string>;
	navigation: NavigationItem[];
	pages: PagePlan[];
	content: ContentPlan[];
	imageQueries: string[];
}
```

A purpose-built bootstrap operation can apply this plan in one transaction or a small number of deterministic stages. This can begin as one first-party MCP tool rather than a general intermediate representation.

MCP remains useful for open-ended subsequent edits. It does not need to be the orchestration protocol for a known initial bootstrap.

### Progressively enrich the preview

The first personalized update should include:

- Site title and tagline
- Design tokens
- Hero content
- Navigation
- One representative item for each major section

Later updates can add:

- Long-form pages and posts
- Remaining collection entries
- Taxonomies and bylines
- Full media ingestion
- Screenshot-based visual checks
- Accessibility and link validation

Media search and upload should not block the first personalized render. A temporary remote image or prepared placeholder can be replaced after ingestion.

### Reload at semantic checkpoints

Do not reload the iframe after every low-level read or write. Reload after coherent operations such as:

- Branding applied
- Navigation created
- Homepage content ready
- Media imported
- Agent proposal applied

### Golden snapshots and warm pools

Golden Sandbox snapshots could contain a migrated template, installed dependencies, and warm caches. This may be faster than copying prepared templates, but it should be treated as an experiment because backup and restore previously failed with the custom image.

A warm container pool should come later. It can improve demos, but it adds allocation, sanitization, capacity, and cost complexity. Work should first be removed from cold provisioning.

## Workspace-Backed Authoring

The `cloudflare/workspace` project is directly relevant to the authoring plane. It provides a virtual filesystem whose authoritative state lives in Durable Object SQLite.

It currently has two execution backends:

- A container backend that mounts the filesystem through FUSE using `wsd`.
- A Dynamic Worker backend that runs textual shell tools through `just-bash`.

The long-term opportunity is to make the Sandbox a compute attachment to durable source rather than the owner of the source.

### Proposed authoring topology

```text
BuilderAgent DO
      |
      v
Workspace DO
      |
      +-- source files
      +-- git history
      +-- checkpoints and branches
      |
      +-- Worker backend for reads and small edits
      |
      +-- Sandbox mount for Astro development and builds
```

This could replace:

- Post-turn Git commits and Artifacts pushes
- Git clone recovery after Sandbox sleep
- Ephemeral Sandbox source ownership
- The window in which Admin or source edits can be lost before backup
- Container startup for simple file reads and edits

It could also provide natural primitives for:

- Version history
- Agent proposals
- Branches and alternate designs
- Checkpoints per chat turn
- Git export without a running Sandbox

### Keep dependencies off the durable mount

Workspace's FUSE backend is not a good location for `node_modules`, build output, or large caches. Its published benchmark shows a full package installation taking roughly twice as long as native container disk, with larger penalties for sequential file I/O.

The preferred layout is:

```text
Workspace DO / FUSE
  src/
  public/
  configuration
  project metadata

Native or image-backed container disk
  node_modules/
  .astro/
  build caches
  dist/
```

The image can contain compatible dependencies, or the container can maintain a native cache keyed by template and lockfile digest.

### Current Workspace limitations

Workspace should not yet become a production dependency. It is currently an alpha preview and explicitly not production-ready.

Important gaps include:

- Hibernation is not implemented.
- Transparent reconnect is incomplete.
- Mount and agent-tool interfaces are unfinished.
- The container backend needs a custom `wsd` image.
- It does not expose development server ports.
- It does not deploy applications to Workers for Platforms.

The correct next step is a source-only prototype measuring restore-to-preview time, edit synchronization, and behavior under container restart.

## Production Content Storage

EmDash already supports Durable Object-backed sites through a first-class adapter, and the playground uses this model. That makes a stable Site Durable Object a strong option for production content.

### Stable Site DO

Each site can have one object selected by stable site ID:

```text
SiteContent namespace
  object idFromName(siteId)
    SQLite CMS database
    content revisions
    taxonomies and menus
    settings
    publication state
    optional alarms
```

Every immutable code release receives access to the same site data capability. The content database is not recreated when a new release is deployed.

This avoids provisioning a D1 database per release and aligns naturally with code promotion:

```text
release 17 -----+
release 18 -----+--> stable Site DO
release 19 -----+
```

### Benefits over per-release D1

- Stable content identity across releases
- Strongly consistent content and publication changes
- Transactions colocated with CMS logic
- No database copy for normal code updates
- Per-site isolation by Durable Object ID
- Point-in-time recovery for SQLite-backed Durable Objects
- Alarms can support per-site scheduled work without user-Worker cron triggers
- No control-plane operation to create a database for every code release

### Tradeoffs

Durable Objects are single-location stateful compute. A public request that needs uncached CMS data must reach the object's location. D1 can provide managed database tooling and read replication, while DO SQLite requires more application-owned tooling.

The main concerns are:

- Global read latency for dynamically rendered pages
- Provider portability and export tooling
- Migration ownership
- Backup and inspection tooling
- Adapting deployment bindings to a stable external namespace
- Avoiding a hot object if a site receives significant dynamic traffic

These concerns are less serious for sites that render mostly static assets, use route caching, or read content during publication rather than on every request.

### Possible hybrid

A useful hybrid is:

- Site DO for authoritative CMS writes, drafts, revisions, coordination, and publication state.
- Immutable static assets or cached page output for public delivery.
- R2 for media blobs.
- Optional D1 read models only if global dynamic reads become a measured problem.

The DO remains the source of truth. Any read model is derived and replaceable.

### Separate the two Durable Object roles

The authoring Workspace DO and production Site DO solve different problems:

| Durable Object | Owns                                                         |
| -------------- | ------------------------------------------------------------ |
| Workspace DO   | Source files, project history, agent proposals               |
| Site DO        | Production CMS content, drafts, revisions, publication state |

They should not be conflated. Source rollback and content rollback have different semantics.

## Workers for Platforms Deployment

Workers for Platforms is a good production runtime for provider-hosted sites.

### Verified capability boundary

| Capability                             | User Worker support                |
| -------------------------------------- | ---------------------------------- |
| Static assets                          | Supported                          |
| D1 bindings                            | Supported                          |
| R2 bindings                            | Supported                          |
| Durable Object bindings and migrations | Supported                          |
| Service bindings                       | Supported                          |
| Direct API upload without Wrangler     | Supported                          |
| Native preview URLs                    | Not currently supported            |
| Dynamic Worker Loader binding          | Not currently supported            |
| Per-user-Worker cron triggers          | Not currently supported            |
| Direct custom domains                  | Routed through the dispatch Worker |

Worker Loader and cron are the main EmDash compatibility gaps.

For an initial provider demo:

- Disable production plugins that require Worker Loader.
- Disable or centralize scheduled tasks.
- Use per-site DO alarms where the operation naturally belongs to the Site DO.
- Add a platform scheduler later for operations that must invoke releases externally.

### Direct API deployment

The production control plane should upload releases through Cloudflare APIs. Wrangler should not run in the Sandbox.

The deployment flow is:

1. Build Astro in the Sandbox.
2. Package modules, static assets, migrations, and resource intents into a Release Bundle.
3. Store the bundle in trusted platform storage.
4. Create a Workers static-assets upload session.
5. Upload missing asset hashes.
6. Upload Worker modules and metadata to the dispatch namespace.
7. Attach the site's R2, Site DO, assets, and service bindings.
8. Route a private candidate hostname to the release.
9. Run health checks.
10. Promote the release by changing the active-release pointer.

Cloudflare's VibeSDK contains a reference implementation of the assets upload session and multipart Worker upload flow.

### Immutable release workers

Deploy each release under a unique script name:

```text
site-123-release-17
site-123-release-18
site-123-release-19
```

The dispatch Worker resolves:

```text
hostname -> site -> active release -> user Worker script
```

This gives the platform atomic promotion and rollback without relying on gradual deployment support.

### Candidate previews

Workers for Platforms user Workers do not currently receive native Worker preview URLs. The platform can provide its own candidate routing:

```text
release-18.site-123.preview.provider.example
```

Alternatively, an authenticated preview route can select a candidate release through a signed token or control-plane lookup.

### Namespaces

Use dispatch namespaces as environment, jurisdiction, or trust boundaries:

```text
emdash-production
emdash-staging
emdash-production-eu
emdash-production-untrusted
```

Do not create a dispatch namespace for every site.

## Release Bundle

The builder and hosting provider should communicate through a provider-neutral Release Bundle rather than raw Wrangler configuration.

The bundle should contain:

- Entry module and additional modules
- Static asset manifest and content digests
- Compatibility date and flags
- Required binding names and resource intents
- Site schema and migration requirements
- Initial content import for first publication
- Media manifest
- Health-check path
- Source revision identifier
- Template and EmDash versions
- Bundle format version and digest

The provider maps logical resource intents to resources in its own account.

Example contract:

```text
getCapabilities()
ensureSite(siteSpec)
deployRelease(siteId, releaseBundle)
promoteRelease(siteId, releaseId)
rollbackRelease(siteId, releaseId)
setHostname(siteId, hostnameSpec)
getOperation(operationId)
exportSite(siteId)
deleteSite(siteId)
```

This allows two operating models:

- A provider with an existing WfP platform implements the contract in its own control plane.
- EmDash offers a managed implementation for providers that want a turnkey service.

## Production Lifecycle

### Data model

```text
Site
  stable identity
  hostname configuration
  active release
  content object identity

Revision
  source checkpoint
  design state
  build inputs

Release
  immutable bundle
  deployed script name
  validation results
  status and timestamps
```

### First publication

Before first publication, the Sandbox or local playground data is authoritative. First publication performs a logical import into the stable production Site DO and R2 media store.

The import should include:

- Collections and field definitions
- Content entries and revisions
- Live and draft state
- Taxonomies, menus, widgets, and settings
- Stable content and media IDs
- Media metadata and blob references

It should exclude:

- Development bypass users
- Sessions and API tokens
- Local runtime metadata
- Rebuildable indexes
- Sandbox-specific configuration

After activation, the production Site DO becomes authoritative for content.

### Publishing an update

Publishing code or design should:

1. Capture an immutable source revision.
2. Build without stopping the interactive development server where possible.
3. Create and upload a candidate release.
4. Run smoke, link, and compatibility checks.
5. Atomically update the active-release pointer.
6. Retain previous releases according to policy.

A failed publication leaves the active release untouched.

### Content publication

After first publication, content and design have separate lifecycles:

- Content edits create drafts in the stable Site DO.
- Publishing content promotes draft revision pointers without deploying code.
- Design and structural edits create a new Worker release.
- Code rollback normally retains current production content.

Schema changes need compatibility metadata and additive migrations. Destructive changes should use expand-and-contract migration patterns so the previous release remains usable during the rollback window.

### Rollback

Code rollback changes the active-release pointer. It should not automatically restore content.

Content rollback restores selected revisions into new drafts and publishes them explicitly.

A combined site rollback can be offered, but it should be represented as a new release and new content publication rather than erasing history.

## Continued Editing

The editing interface should distinguish direct structured operations from agent work.

### Workspace layout

```text
+----------------+---------------------------+----------------+
| Chat/Activity  | Responsive preview        | Inspector      |
|                |                           |                |
| Agent changes  | Browse/Edit/Comment modes | Content        |
| Direct edits   | Device controls           | Design         |
| Publish status | Draft/Live comparison     | History        |
+----------------+---------------------------+----------------+
```

The top bar should always answer what the user is viewing:

```text
Live: Release 7
Draft: 3 content changes, 1 design change
[View live] [Preview update] [Publish update]
```

### Semantic element selection

Templates can expose stable editing identities:

```html
<h1 data-emdash-entry="home" data-emdash-field="hero.heading" data-emdash-component="hero"></h1>
```

Selecting an element gives the inspector and agent exact CMS or component context. This is more reliable than CSS selectors or DOM paths.

### Deterministic edits

These operations should not need an LLM:

- Edit text and metadata
- Replace or crop an image
- Edit alt text and captions
- Reorder navigation or supported sections
- Change exposed design tokens
- Publish or discard a content draft
- Restore a content revision

They should apply immediately, create an activity record, and support undo.

### Agent edits

Use the agent for intent and structural work:

- Rewrite content by tone or audience
- Add a new section
- Change a component layout
- Add a collection or route
- Perform broad visual redesigns
- Apply coordinated changes across pages

Large changes should be proposals:

```text
Proposal: Add customer stories

+ case-studies collection
+ /customers route
+ navigation item
+ homepage section
+ 3 draft entries

[Preview proposal] [Apply] [Keep iterating] [Discard]
```

Workspace branches or checkpoints could eventually back these proposals.

### History

Expose three related histories:

| History  | Contents                                      |
| -------- | --------------------------------------------- |
| Activity | Chat turns, direct edits, design transactions |
| Content  | EmDash entry revisions and publication events |
| Releases | Deployed code and design snapshots            |

Restoring an old state should create a new draft or release rather than deleting subsequent history.

## Provider Integration

### Existing WfP provider

The provider owns:

- Cloudflare account and namespaces
- Dispatch Worker
- Custom hostname zone
- Production resources
- Runtime billing and metering
- Customer identity and plans

EmDash Build submits signed Release Bundles through the provider contract. No provider Cloudflare token needs to enter EmDash infrastructure.

### Managed turnkey provider

EmDash can operate shared or dedicated platform cells:

- Shared namespace
- Dedicated namespace
- Dedicated Cloudflare account
- Customer-owned account managed by EmDash

The same Release Bundle and deployment contract should be used in every model.

### Custom domains

User Workers are reached through the dispatch Worker. Provider subdomains can be routed immediately through wildcard DNS.

Customer-owned domains should use Cloudflare for SaaS custom hostnames. The dispatch Worker resolves the hostname or custom metadata to a site and active release.

## Wider Options

Several more radical architectures were considered.

### Browser-side approximate preview

Render a lightweight prompt-aware homepage in the browser while the Sandbox starts. This gives nearly instant pixels but creates a second rendering implementation and risks a jarring transition.

Recommendation: defer unless real-template startup cannot meet the product target.

### Shared multi-tenant preview renderer

Render all initial previews from one Worker using a template registry and structured Site Plan. Materialize source into a Sandbox only when arbitrary edits are needed.

This could support high scale, but it duplicates the Astro rendering path and weakens preview fidelity.

Recommendation: reconsider only if one Sandbox per active site becomes the dominant scaling constraint.

### Page graph instead of source code

Make a structured page graph and design tokens the primary artifact, with a shared runtime rendering every site. Astro source becomes an export format.

This enables instant updates and easy versioning, but risks recreating a frontend framework and constraining customization.

Recommendation: do not pursue for the current product.

### Semantic patch intermediate representation

Have the agent emit operations such as "add hero" or "change heading" rather than file diffs. A materializer updates source, preview, and history.

This could improve replay and template upgrades, but defining a durable patch language is substantial work.

Recommendation: use narrow structured operations for supported template capabilities rather than a universal IR.

### CRDT-backed collaboration

Represent source and editing operations as a replicated log for branching and concurrent editing.

This is unnecessary while a Durable Object already provides a single serialization point. Field-level optimistic concurrency and proposal branches are simpler.

Recommendation: defer.

### Multi-agent build pipeline

Run design, content, development, and QA agents in parallel with restricted tool sets.

This can reduce wall-clock time but introduces coordination, cost, and conflict complexity.

Recommendation: parallelize deterministic subtasks and content generation before creating multiple autonomous agents.

### Deploy-first preview

Compile the first Site Plan directly to a WfP release and start the Sandbox later for continued editing.

This provides a realistic edge runtime immediately, but deployment propagation and production resource setup may be slower than starting a prepared local template.

Recommendation: use WfP for candidate and production previews, not the first interactive preview.

## Recommended Delivery Plan

### Phase 1: Measure and remove startup work

- Add timing for every provisioning stage.
- Bake templates and dependencies into the image.
- Publish the real preview before CMS and MCP readiness.
- Add one bulk bootstrap operation.
- Generate representative homepage content before long-form content.
- Reload only at semantic checkpoints.

### Phase 2: Prove the production loop

- Build a representative EmDash site for WfP.
- Confirm stable Site DO access from immutable releases.
- Upload assets and modules through direct APIs.
- Add stable Site and Release records.
- Add candidate routing and smoke tests.
- Add atomic promotion and rollback.
- Keep Worker Loader plugins out of scope.
- Use Site DO alarms or disable scheduled behavior initially.

### Phase 3: Introduce durable authoring

- Prototype a source-only Workspace filesystem.
- Keep dependencies and caches on native container disk.
- Measure cold mount, synchronization, and restart behavior.
- Move checkpoints and proposal history into Workspace.
- Remove Artifacts backup and recovery only after Workspace matures.

### Phase 4: Connect authoring to production content

- Import initial content into the production Site DO.
- Make the Site DO authoritative after first publication.
- Let previews read and write production drafts through scoped APIs.
- Separate content publication from design release publication.
- Add schema compatibility gates.

### Phase 5: Visual CMS workspace

- Add semantic element selection.
- Add inline content and media editing.
- Add design-token controls.
- Add agent proposals.
- Add Draft versus Live comparison.
- Surface activity, content, and release histories.

### Phase 6: Provider readiness

- Publish the provider deployment contract.
- Ship a reference WfP adapter and dispatch Worker.
- Add custom hostnames through Cloudflare for SaaS.
- Add provider-level logs and metering.
- Add export and account-ejection workflows.

## Validation Spikes

Before committing to the full architecture, run these focused spikes.

### Startup image spike

Measure current provisioning against a prepared-image path:

- Container allocation to first command
- Template copy time
- Dev server startup
- First homepage response
- CMS readiness
- First personalized render

### Workspace spike

Store source in a Workspace DO while keeping dependencies on native disk:

- Mount and start Astro
- Edit through Worker and container backends
- Restart the container
- Verify source recovery
- Measure HMR and build performance
- Measure synchronization cost for a typical template

### WfP compatibility spike

Deploy a representative EmDash build through the direct API with:

- Static assets
- Stable Site DO binding
- R2 media
- Service bindings
- Candidate hostname routing

Explicitly verify behavior without Worker Loader and per-release cron triggers.

### Publication spike

Demonstrate the complete lifecycle:

```text
create
-> preview
-> publish
-> edit
-> publish update
-> fail a candidate safely
-> roll back
```

### Site DO performance spike

Measure public rendering from several regions:

- Uncached dynamic page latency
- Route-cache hit rate
- Static generation opportunities
- Admin and agent write latency
- Behavior under a burst of public reads

Use the result to decide whether a derived global read model is necessary.

## Open Questions

- Can prepared dependencies be safely shared across all templates without increasing image cold starts too much?
- Is Workspace mature enough by implementation time to replace Artifacts persistence?
- Should Workspace be composed into the BuilderAgent or use a separate Durable Object?
- What is the cleanest binding shape for stable Site DO access from WfP release workers?
- Which public routes need dynamic CMS reads, and which can use static assets or route caching?
- Can plugin execution move behind a platform service while WfP user Workers lack Worker Loader bindings?
- Which scheduled operations belong in per-site DO alarms versus a platform scheduler?
- How should template schema changes declare compatibility with older code releases?
- What export format allows a provider-hosted Site DO to move to another account or adapter?
- What resource and release limits should the first provider pilot enforce?

## References

- [Cloudflare Workspace](https://github.com/cloudflare/workspace)
- [Cloudflare VibeSDK](https://github.com/cloudflare/vibesdk)
- [Workers for Platforms bindings](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/bindings/)
- [Workers for Platforms static assets](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/static-assets/)
- [Workers for Platforms hostname routing](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/)
- [Enterprise AI vibe coding architecture](https://developers.cloudflare.com/reference-architecture/diagrams/ai/enterprise-ai-vibe-coding-platform/)
- [SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
