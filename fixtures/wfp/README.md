# Workers for Platforms Site-service rehearsal

This fixture proves that a real WfP User Worker receives one request-scoped,
read-only Site capability. It deliberately uses fixed fixture content and no CMS
transfer contract.

Set `CLOUDFLARE_ACCOUNT_ID` to the provider account, then create the isolated
prerelease namespace and media bucket once:

```sh
pnpm exec wrangler dispatch-namespace create emdash-build-prerelease
pnpm exec wrangler r2 bucket create emdash-build-wfp-site-rehearsal-media
```

The fixture accepts only these Sites:

```sh
SITE_A=00000000-0000-4000-8000-0000000000a1
SITE_B=00000000-0000-4000-8000-0000000000b2
```

Deploy the dispatch Worker, initialize both stable Site authorities, and deploy
the immutable candidates. Site A's `workers.dev` hostname deliberately matches
the production `s-<site>.<sites-hostname>` parser:

```sh
pnpm wfp:fixture:dispatch
WFP_FIXTURE_DISPATCH_URL=https://s-000000000000400080000000000000a1.emdash-cms.workers.dev
curl -fsS -X POST "$WFP_FIXTURE_DISPATCH_URL/fixture/initialize/$SITE_A"
curl -fsS -X POST "$WFP_FIXTURE_DISPATCH_URL/fixture/initialize/$SITE_B"
pnpm wfp:fixture:release:1
pnpm wfp:fixture:release:2
```

Prove isolation by requesting the same candidate with each Site capability, then
validate release 1 and promote it to Site A's deterministic live script:

```sh
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_A/emdash-build-fixture-release-1/"
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_B/emdash-build-fixture-release-1/"
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_A/emdash-build-fixture-release-1/fixture-media"
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_B/emdash-build-fixture-release-1/fixture-media"
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_A/emdash-build-fixture-release-1/health"
pnpm wfp:fixture:promote:1
LIVE_SCRIPT=e-000000000000400080000000000000a1-live
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_A/$LIVE_SCRIPT/"
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_A/$LIVE_SCRIPT/fixture-media"
```

An unhealthy candidate must return 500 while the stable host remains release 1.
Then promote healthy release 2 and roll back to release 1:

```sh
pnpm wfp:fixture:release:2:failed
curl -fsS -o /dev/null -w '%{http_code}\n' "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_A/emdash-build-fixture-release-2-failed/health"
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_A/$LIVE_SCRIPT/"
pnpm wfp:fixture:promote:2
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_A/$LIVE_SCRIPT/"
pnpm wfp:fixture:rollback:1
curl -fsS "$WFP_FIXTURE_DISPATCH_URL/fixture/$SITE_A/$LIVE_SCRIPT/"
```

The production router maps Site A's stable `workers.dev` hostname to
`e-000000000000400080000000000000a1-live`. Release metadata proves promotion
and rollback; the unchanged Site ID and SVG prove that code releases do not
replace the persistent Site authority. The User Worker never receives the raw
Site DO, R2 binding, Site ID argument, object key, or a write method.
