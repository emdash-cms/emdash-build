# Self-hosting the reference platform

This is a prerelease deployment guide. Use an isolated Cloudflare account or
explicitly prefixed resources until the platform has completed its production
hardening.

## Required Cloudflare capabilities

- Workers, Durable Objects and static assets
- Containers / Cloudflare Sandbox
- Workers AI
- Artifacts
- Workers for Platforms dispatch namespaces
- A proxied zone with one application hostname and wildcard preview/site hostnames

Confirm current entitlements and limits before provisioning.

## Configuration values

Copy `provider.config.example.json` to the ignored/local
`provider.config.json`, replace every example value, then run:

```sh
pnpm preflight
pnpm configure
pnpm build:provider
```

Set `EMDASH_PROVIDER_CONFIG` if the config lives elsewhere. Preflight validates
the configuration, Node, Docker and Wrangler authentication without creating
Cloudflare resources. `pnpm configure` renders an ignored
`wrangler.provider.jsonc`; the provider build uses that file without modifying
the default configuration. Inspect the generated file before running
`pnpm deploy:provider`.

Create a provider-specific Wrangler config with unique values for:

- Worker name
- Cloudflare zone name
- Artifacts namespace
- Sandbox image name and capacity
- application hostname
- wildcard Sandbox preview hostname
- WfP dispatch namespace
- public sites hostname
- identity broker URL and audience
- identity issuer and a dedicated auth D1 database name/ID
- for provider-config version 3, a dedicated Site-media R2 bucket distinct from
  the immutable WfP release-package bucket

Use unique domains and resource names for the target account.

## Publish site setup

The **Publish site** action creates a static snapshot and promotes it through
the configured Workers for Platforms namespace. The generated site never
receives account credentials or a production CMS binding.

The provider Worker requires:

- `WFP_RELEASES`, backed by the immutable release-package R2 bucket;
- `ProviderControlPlane` and `WFP_DISPATCHER` bindings for the same dispatch
  namespace;
- `SITES_HOSTNAME`, `WFP_DISPATCH_NAMESPACE` and `WFP_ACCOUNT_ID` values;
- `WFP_API_TOKEN` as a Worker secret with permission to write Workers scripts.

These values are rendered by `pnpm configure` from `provider.config.json`.
Never put `WFP_API_TOKEN` in that file, `.dev.vars`, the Sandbox image or a
generated site. Set it on the provider Worker with Wrangler or your deployment
system.

Published sites are read-only snapshots. Republish to ship Builder changes.
Sites that depend on same-origin APIs, forms, WebSockets or browser-side network
requests are rejected before Live changes. Deleting a project removes its exact
live/candidate scripts and Site-specific release prefix before Builder state is
deleted.

## Bootstrap outline

1. Run `wrangler login` and verify the exact account with `wrangler whoami`.
2. Build and push the Sandbox image.
3. Create an Artifacts namespace and the production/staging WfP namespaces.
4. Deploy the dispatch/site service before the public studio.
5. Configure wildcard DNS/routes for previews and provider sites.
6. For provider-config versions 2 and 3, create a dedicated auth D1 database and
   apply `migrations/` with Wrangler. Configure the broker URL, exact issuer and
   Access application audience. Version 3 also requires the dedicated
   Site-media R2 bucket used by the Site service. Versions 1 and 2 remain
   supported without the Site-service capability; version 1 keeps identity
   fail-closed.
7. Configure an identity adapter. The studio must stay public; protect only the
   same-origin `/api/auth/callback` path with Access. The Worker validates the
   assertion signature, issuer and audience again before creating its own
   application session.
8. Add `UNSPLASH_ACCESS_KEY` as a Worker secret if media search is enabled.
9. Run create, resume, snapshot publish, republish, failed-candidate and project
   deletion checks.

Never place an account API token, production CMS token or shared data binding in
the Sandbox or generated user Worker. A trusted deployment service owns WfP
credentials. Generated code receives only site-scoped read access.

The Sandbox image stores each pinned template as a separate compressed,
ready-to-extract layer. This avoids runtime package installation and prevents
one oversized registry layer from making the image impossible to upload.

## WfP fixture

The fixture under `fixtures/wfp` is the pre-core acceptance boundary. Set the
target account explicitly, create `emdash-build-prerelease`, then follow its
README. Keep the fixture namespace separate from real provider namespaces.

## Cleanup

Delete only explicitly prefixed fixture scripts and the
`emdash-build-prerelease` namespace after validating the exact target set. Do
not use broad tag, wildcard or account-wide deletion commands.
