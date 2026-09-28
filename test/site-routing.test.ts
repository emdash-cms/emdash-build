import { describe, expect, it, vi } from "vitest";
import { WFP_DISPATCH_LIMITS, routeProviderSite } from "../src/worker/site-routing.js";
import { WFP_HEALTH_PATH } from "../src/platform/wfp-release.js";
import { SNAPSHOT_HEALTH_PATH } from "../src/platform/wfp-snapshot-release.js";
import { createWfpRuntime } from "../src/platform/wfp-runtime.js";

const SITE_ID = "00000000000040008000000000000001";

function dispatcher() {
	const fetch = vi.fn(async () => new Response("live"));
	const get = vi.fn(() => ({ fetch }) as unknown as Fetcher);
	return { binding: { get } as unknown as DispatchNamespace, get, fetch };
}

describe("provider site routing", () => {
	it("returns not found without touching provider state when public publishing is disabled", async () => {
		const fake = dispatcher();
		const first = vi.fn(async () => ({ site_id: "00000000-0000-4000-8000-000000000001" }));
		const db = {
			prepare: vi.fn(() => ({ bind: () => ({ first }) })),
		} as unknown as D1Database;
		const siteCapabilityFor = vi.fn(() => ({}));

		for (const url of [
			"https://quiet-iceland.em-da.sh/work",
			`https://s-${SITE_ID}.sites.example.test/page`,
		]) {
			const response = await routeProviderSite(new Request(url), {
				enabled: false,
				sitesHostname: "sites.example.test",
				brandedSitesHostname: "em-da.sh",
				slugDatabase: db,
				dispatcher: fake.binding,
				siteCapabilityFor,
			});
			expect(response?.status).toBe(404);
		}

		expect(db.prepare).not.toHaveBeenCalled();
		expect(siteCapabilityFor).not.toHaveBeenCalled();
		expect(fake.get).not.toHaveBeenCalled();
		expect(
			(
				await routeProviderSite(new Request(`https://s-${SITE_ID}.sites.example.test/page`), {
					enabled: false,
					sitesHostname: "sites.example.test",
				})
			)?.status,
		).toBe(404);
	});

	it("routes a named public host through the existing stable site script", async () => {
		const fake = dispatcher();
		const first = vi.fn(async () => ({ site_id: "00000000-0000-4000-8000-000000000001" }));
		const db = {
			prepare: () => ({ bind: () => ({ first }) }),
		} as unknown as D1Database;
		const response = await routeProviderSite(new Request("https://quiet-iceland.em-da.sh/work"), {
			sitesHostname: "sites.example.test",
			brandedSitesHostname: "em-da.sh",
			slugDatabase: db,
			dispatcher: fake.binding,
		});
		expect(await response?.text()).toBe("live");
		expect(fake.get).toHaveBeenCalledWith(`e-${SITE_ID}-live`, {}, WFP_DISPATCH_LIMITS);
		expect(first).toHaveBeenCalledOnce();
	});

	it("keeps unknown names and private health paths off the dispatcher", async () => {
		const fake = dispatcher();
		const first = vi.fn(async () => null);
		const db = {
			prepare: () => ({ bind: () => ({ first }) }),
		} as unknown as D1Database;
		for (const pathname of ["/", WFP_HEALTH_PATH, SNAPSHOT_HEALTH_PATH]) {
			const response = await routeProviderSite(new Request(`https://unknown.em-da.sh${pathname}`), {
				sitesHostname: "sites.example.test",
				brandedSitesHostname: "em-da.sh",
				slugDatabase: db,
				dispatcher: fake.binding,
			});
			expect(response?.status).toBe(404);
		}
		expect(first).toHaveBeenCalledOnce();
		expect(fake.get).not.toHaveBeenCalled();
	});
	it("routes a canonical provider host only to its stable live script", async () => {
		const fake = dispatcher();
		const response = await routeProviderSite(
			new Request(`https://s-${SITE_ID}.sites.example.test/page`),
			{ sitesHostname: "sites.example.test", dispatcher: fake.binding },
		);

		expect(await response?.text()).toBe("live");
		expect(fake.get).toHaveBeenCalledWith(`e-${SITE_ID}-live`, {}, WFP_DISPATCH_LIMITS);
		expect(fake.fetch).toHaveBeenCalledTimes(1);
	});

	it("passes one capability for the canonical Site through dispatch props", async () => {
		const fake = dispatcher();
		const capability = { readFixtureContent: vi.fn(), readFixtureMedia: vi.fn() };
		const siteCapabilityFor = vi.fn(() => capability);
		await routeProviderSite(new Request(`https://s-${SITE_ID}.sites.example.test/page`), {
			sitesHostname: "sites.example.test",
			dispatcher: fake.binding,
			siteCapabilityFor,
		});

		expect(siteCapabilityFor).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
		expect(fake.get).toHaveBeenCalledWith(
			`e-${SITE_ID}-live`,
			{ props: { SITE: capability } },
			WFP_DISPATCH_LIMITS,
		);
	});

	it("does not create capabilities for malformed provider hosts", async () => {
		const fake = dispatcher();
		const siteCapabilityFor = vi.fn(() => ({}));
		expect(
			await routeProviderSite(new Request("https://s-not-a-site.sites.example.test/"), {
				sitesHostname: "sites.example.test",
				dispatcher: fake.binding,
				siteCapabilityFor,
			}),
		).toBeUndefined();
		expect(siteCapabilityFor).not.toHaveBeenCalled();
	});

	it("stays inactive when the default app has no provider bindings", async () => {
		expect(
			await routeProviderSite(new Request(`https://s-${SITE_ID}.sites.example.test/`), {}),
		).toBeUndefined();
	});

	it("never exposes the trusted health endpoint through the public host", async () => {
		const fake = dispatcher();
		const response = await routeProviderSite(
			new Request(`https://s-${SITE_ID}.sites.example.test${WFP_HEALTH_PATH}`),
			{ sitesHostname: "sites.example.test", dispatcher: fake.binding },
		);

		expect(response?.status).toBe(404);
		expect(fake.get).not.toHaveBeenCalled();
	});

	it("never exposes snapshot candidate health through the public host", async () => {
		const fake = dispatcher();
		const response = await routeProviderSite(
			new Request(`https://s-${SITE_ID}.sites.example.test${SNAPSHOT_HEALTH_PATH}`),
			{ sitesHostname: "sites.example.test", dispatcher: fake.binding },
		);

		expect(response?.status).toBe(404);
		expect(fake.get).not.toHaveBeenCalled();
	});

	it("ignores malformed, arbitrary-script, preview, and wrong-suffix hosts", async () => {
		for (const host of [
			"candidate-name.sites.example.test",
			`s-${SITE_ID}.preview.example.test`,
			`s-${SITE_ID}x.sites.example.test`,
		]) {
			const fake = dispatcher();
			expect(
				await routeProviderSite(new Request(`https://${host}/`), {
					sitesHostname: "sites.example.test",
					dispatcher: fake.binding,
				}),
			).toBeUndefined();
			expect(fake.get).not.toHaveBeenCalled();
		}
	});

	it("normalizes DNS case to the same stable script", async () => {
		const fake = dispatcher();
		await routeProviderSite(new Request(`https://s-${SITE_ID.toUpperCase()}.SITES.EXAMPLE.TEST/`), {
			sitesHostname: "sites.example.test",
			dispatcher: fake.binding,
		});
		expect(fake.get).toHaveBeenCalledWith(`e-${SITE_ID}-live`, {}, WFP_DISPATCH_LIMITS);
	});

	it("routes every UUID version accepted by the control plane", async () => {
		const version7 = "0199c2f8c21d7f6a8db3396aa401dfd4";
		const fake = dispatcher();
		await routeProviderSite(new Request(`https://s-${version7}.sites.example.test/`), {
			sitesHostname: "sites.example.test",
			dispatcher: fake.binding,
		});
		expect(fake.get).toHaveBeenCalledWith(`e-${version7}-live`, {}, WFP_DISPATCH_LIMITS);
	});

	it("returns a generic unavailable response without leaking dispatch errors", async () => {
		const get = vi.fn(() => {
			throw new Error("provider secret body");
		});
		const response = await routeProviderSite(
			new Request(`https://s-${SITE_ID}.sites.example.test/`),
			{ sitesHostname: "sites.example.test", dispatcher: { get } as unknown as DispatchNamespace },
		);

		expect(response?.status).toBe(502);
		expect(await response?.text()).not.toContain("secret");
	});

	it("uses the same bounded dispatch contract for direct identity and health", async () => {
		const fetch = vi.fn(async (request: Request) => {
			if (new URL(request.url).pathname === WFP_HEALTH_PATH) {
				return Response.json(
					{
						releaseId: "00000000-0000-4000-8000-000000000011",
						uploadDigest: `sha256:${"d".repeat(64)}`,
					},
					{
						headers: {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store",
						},
					},
				);
			}
			return new Response("ok");
		});
		const get = vi.fn(() => ({ fetch }) as unknown as Fetcher);
		const runtime = createWfpRuntime({
			WFP_RELEASES: {} as R2Bucket,
			WFP_ACCOUNT_ID: "a".repeat(32),
			WFP_API_TOKEN: "secret",
			WFP_DISPATCH_NAMESPACE: "emdash-build",
			WFP_DISPATCHER: { get } as unknown as DispatchNamespace,
		});

		expect(await runtime.identity("candidate-script")).toMatchObject({ status: "present" });
		expect(await runtime.health("candidate-script", "/health")).toBe(true);
		expect(get).toHaveBeenNthCalledWith(1, "candidate-script", {}, WFP_DISPATCH_LIMITS);
		expect(get).toHaveBeenNthCalledWith(2, "candidate-script", {}, WFP_DISPATCH_LIMITS);
	});

	it("fails closed when the default app has no WfP credential", () => {
		expect(() =>
			createWfpRuntime({
				WFP_RELEASES: {} as R2Bucket,
				WFP_ACCOUNT_ID: "a".repeat(32),
				WFP_DISPATCH_NAMESPACE: "emdash-build",
				WFP_DISPATCHER: dispatcher().binding,
			}),
		).toThrowError("WFP_NOT_CONFIGURED");
	});
});
