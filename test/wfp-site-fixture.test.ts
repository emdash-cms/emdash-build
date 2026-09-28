import { describe, expect, it, vi } from "vitest";
import dispatchWorker from "../fixtures/wfp/dispatch.js";
import siteWorker from "../fixtures/wfp/site.js";

const SITE_A = "00000000-0000-4000-8000-0000000000a1";
const SITE_B = "00000000-0000-4000-8000-0000000000b2";
const COMPACT_A = SITE_A.replaceAll("-", "");
const SITES_HOSTNAME = "emdash-cms.workers.dev";

interface FixtureContent {
	version: 1;
	siteId: string;
	title: string;
	body: string;
	mediaPath: "/fixture-media";
}

interface SiteCapability {
	readFixtureContent(): Promise<FixtureContent | null>;
	readFixtureMedia(): Promise<Response>;
}

type SiteFetch = (
	request: Request,
	env: { RELEASE_ID: string; FAIL_HEALTH?: string; fixtureScript?: string },
	ctx: ExecutionContext<{ SITE: SiteCapability }>,
) => Promise<Response>;

type DispatchFetch = (
	request: Request,
	env: {
		DISPATCHER: DispatchNamespace;
		SITES_HOSTNAME: string;
		SiteService: DurableObjectNamespace;
	},
	ctx: ExecutionContext,
) => Promise<Response>;

const fetchSite = siteWorker.fetch as unknown as SiteFetch;
const fetchDispatch = dispatchWorker.fetch as unknown as DispatchFetch;

function content(siteId = SITE_A): FixtureContent {
	return {
		version: 1,
		siteId,
		title: "EmDash production fixture",
		body: "Persistent Site content served through a request-scoped capability.",
		mediaPath: "/fixture-media",
	};
}

function siteContext(siteId = SITE_A) {
	const SITE = {
		readFixtureContent: vi.fn(async () => content(siteId)),
		readFixtureMedia: vi.fn(async () => new Response(`media:${siteId}`)),
	};
	return {
		SITE,
		ctx: { props: { SITE } } as unknown as ExecutionContext<{ SITE: SiteCapability }>,
	};
}

function dispatchHarness() {
	const capability = { site: "opaque" };
	const initializeFixture = vi.fn(async () => ({ ok: true }));
	const getByName = vi.fn(() => ({ initializeFixture }));
	const targetFetch = vi.fn(async () => new Response("dispatched"));
	const get = vi.fn(() => ({ fetch: targetFetch }) as unknown as Fetcher);
	const capabilityFactory = vi.fn(() => capability);
	return {
		capability,
		initializeFixture,
		getByName,
		get,
		targetFetch,
		capabilityFactory,
		env: {
			DISPATCHER: { get } as unknown as DispatchNamespace,
			SITES_HOSTNAME,
			SiteService: { getByName } as unknown as DurableObjectNamespace,
		},
		ctx: {
			exports: { SiteReadCapability: capabilityFactory },
		} as unknown as ExecutionContext,
	};
}

describe("WfP Site-service fixture", () => {
	it("keeps health independent from Site data", async () => {
		const { SITE, ctx } = siteContext();
		const response = await fetchSite(
			new Request("https://fixture.test/health"),
			{ RELEASE_ID: "release-2-failed", FAIL_HEALTH: "1" },
			ctx,
		);
		expect(response.status).toBe(500);
		expect(SITE.readFixtureContent).not.toHaveBeenCalled();
		expect(SITE.readFixtureMedia).not.toHaveBeenCalled();
	});

	it("reads content and streams media only through ctx.props", async () => {
		const { SITE, ctx } = siteContext();
		const page = await fetchSite(
			new Request("https://fixture.test/"),
			{ RELEASE_ID: "release-1" },
			ctx,
		);
		expect(await page.json()).toMatchObject({ releaseId: "release-1", site: { siteId: SITE_A } });
		expect(SITE.readFixtureContent).toHaveBeenCalledTimes(1);

		const media = await fetchSite(
			new Request("https://fixture.test/fixture-media"),
			{ RELEASE_ID: "release-1" },
			ctx,
		);
		expect(await media.text()).toBe(`media:${SITE_A}`);
		expect(SITE.readFixtureMedia).toHaveBeenCalledTimes(1);
	});

	it("initializes only the two fixed fixture Sites through the explicit route", async () => {
		const harness = dispatchHarness();
		const initialized = await fetchDispatch(
			new Request(`https://fixture.test/fixture/initialize/${SITE_A}`, { method: "POST" }),
			harness.env,
			harness.ctx,
		);
		expect(initialized.status).toBe(200);
		expect(harness.getByName).toHaveBeenCalledWith(SITE_A);
		expect(harness.initializeFixture).toHaveBeenCalledWith(SITE_A);

		for (const siteId of ["00000000-0000-4000-8000-0000000000c3", "not-a-site"]) {
			const response = await fetchDispatch(
				new Request(`https://fixture.test/fixture/initialize/${siteId}`, { method: "POST" }),
				harness.env,
				harness.ctx,
			);
			expect(response.status).toBe(404);
		}
		expect(harness.initializeFixture).toHaveBeenCalledTimes(1);
	});

	it("passes isolated capabilities without initializing on candidate traffic", async () => {
		const harness = dispatchHarness();
		for (const siteId of [SITE_A, SITE_B]) {
			const response = await fetchDispatch(
				new Request(`https://fixture.test/fixture/${siteId}/emdash-build-fixture-release-1/page`),
				harness.env,
				harness.ctx,
			);
			expect(await response.text()).toBe("dispatched");
		}
		expect(harness.initializeFixture).not.toHaveBeenCalled();
		expect(harness.capabilityFactory).toHaveBeenNthCalledWith(1, { props: { siteId: SITE_A } });
		expect(harness.capabilityFactory).toHaveBeenNthCalledWith(2, { props: { siteId: SITE_B } });
		expect(harness.get).toHaveBeenNthCalledWith(
			1,
			"emdash-build-fixture-release-1",
			{ props: { SITE: harness.capability } },
			{ limits: { cpuMs: 20, subRequests: 10 } },
		);
	});

	it("uses the production stable script and capability contract", async () => {
		const harness = dispatchHarness();
		const response = await fetchDispatch(
			new Request(`https://s-${COMPACT_A}.${SITES_HOSTNAME}/`),
			harness.env,
			harness.ctx,
		);
		expect(await response.text()).toBe("dispatched");
		expect(harness.get).toHaveBeenCalledWith(
			`e-${COMPACT_A}-live`,
			{ props: { SITE: harness.capability } },
			{ limits: { cpuMs: 50, subRequests: 20 } },
		);
		expect(harness.initializeFixture).not.toHaveBeenCalled();
	});
});
