import { abortAllDurableObjects, env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	SITE_FIXTURE_MEDIA_MAX_BYTES,
	SiteReadCapability,
	siteFixtureMediaKey,
} from "../src/worker/site-service.js";

const SITE_A = "00000000-0000-4000-8000-0000000000a1";
const SITE_B = "00000000-0000-4000-8000-0000000000b2";

describe("stable Site fixture service", () => {
	beforeEach(() => reset());

	it("persists one Site identity and streams its scoped fixture media", async () => {
		const site = env.SiteService.getByName(SITE_A);
		expect(await site.initializeFixture(SITE_A)).toEqual({ ok: true });

		expect(await site.readFixtureContent()).toEqual({
			version: 1,
			siteId: SITE_A,
			title: "EmDash production fixture",
			body: "Persistent Site content served through a request-scoped capability.",
			mediaPath: "/fixture-media",
		});
		const stored = await env.SITE_MEDIA.get(siteFixtureMediaKey(SITE_A));
		expect(stored?.customMetadata).toEqual({ siteId: SITE_A });
		const storedBytes = await stored?.text();
		expect(await site.initializeFixture(SITE_A)).toEqual({ ok: true });
		expect(await (await env.SITE_MEDIA.get(siteFixtureMediaKey(SITE_A)))?.text()).toBe(storedBytes);

		const response = await site.readFixtureMedia();
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(response.body).not.toBeNull();
		expect(await response.text()).toContain(SITE_A);
	});

	it("converges concurrent exact initialization and rejects rebinding", async () => {
		const site = env.SiteService.getByName(SITE_A);
		await expect(
			Promise.all([site.initializeFixture(SITE_A), site.initializeFixture(SITE_A)]),
		).resolves.toEqual([{ ok: true }, { ok: true }]);
		await expect(site.initializeFixture(SITE_B)).resolves.toEqual({
			ok: false,
			code: "SITE_ID_MISMATCH",
		});

		const rows = await runInDurableObject(site, (_instance, state) =>
			state.storage.sql.exec<{ site_id: string }>("SELECT site_id FROM site_fixture").toArray(),
		);
		expect(rows).toEqual([{ site_id: SITE_A }]);
		expect(await env.SITE_MEDIA.get(siteFixtureMediaKey(SITE_B))).toBeNull();
	});

	it("allows only one identity when mismatched initialization races", async () => {
		const site = env.SiteService.getByName(SITE_A);
		const results = await Promise.allSettled([
			site.initializeFixture(SITE_A),
			site.initializeFixture(SITE_B),
		]);
		expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
		const values = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		expect(values.filter(({ ok }) => ok)).toHaveLength(1);
		expect(values.filter(({ ok }) => !ok)).toEqual([{ ok: false, code: "SITE_ID_MISMATCH" }]);
		const content = await site.readFixtureContent();
		expect(content?.siteId).toBe(SITE_A);
		expect(await env.SITE_MEDIA.get(siteFixtureMediaKey(SITE_B))).toBeNull();
	});

	it("keeps separate Sites isolated across object recreation", async () => {
		const siteA = env.SiteService.getByName(SITE_A);
		const siteB = env.SiteService.getByName(SITE_B);
		await Promise.all([siteA.initializeFixture(SITE_A), siteB.initializeFixture(SITE_B)]);
		await abortAllDurableObjects();

		expect((await env.SiteService.getByName(SITE_A).readFixtureContent())?.siteId).toBe(SITE_A);
		expect((await env.SiteService.getByName(SITE_B).readFixtureContent())?.siteId).toBe(SITE_B);
		expect(await (await env.SiteService.getByName(SITE_A).readFixtureMedia()).text()).toContain(
			SITE_A,
		);
		expect(await (await env.SiteService.getByName(SITE_B).readFixtureMedia()).text()).toContain(
			SITE_B,
		);
	});

	it("fails closed for absent, oversized, and mismatched media", async () => {
		const site = env.SiteService.getByName(SITE_A);
		await site.initializeFixture(SITE_A);
		const key = siteFixtureMediaKey(SITE_A);

		await env.SITE_MEDIA.delete(key);
		expect((await site.readFixtureMedia()).status).toBe(404);

		await env.SITE_MEDIA.put(key, new Uint8Array(SITE_FIXTURE_MEDIA_MAX_BYTES + 1), {
			customMetadata: { siteId: SITE_A },
		});
		expect((await site.readFixtureMedia()).status).toBe(502);

		await env.SITE_MEDIA.put(key, "wrong", { customMetadata: { siteId: SITE_B } });
		expect((await site.readFixtureMedia()).status).toBe(502);

		await runInDurableObject(site, (_instance, state) => {
			state.storage.sql.exec("UPDATE site_fixture SET media_key = ? WHERE slot = 1", "foreign/key");
		});
		expect((await site.readFixtureMedia()).status).toBe(502);
	});

	it("exposes only Site reads through the hidden capability identity", async () => {
		await Promise.all([
			env.SiteService.getByName(SITE_A).initializeFixture(SITE_A),
			env.SiteService.getByName(SITE_B).initializeFixture(SITE_B),
		]);
		const capabilityA = new SiteReadCapability(
			{ props: { siteId: SITE_A } } as ExecutionContext<{ siteId: string }>,
			{ SITE_MEDIA: env.SITE_MEDIA, SiteService: env.SiteService },
		);
		const capabilityB = new SiteReadCapability(
			{ props: { siteId: SITE_B } } as ExecutionContext<{ siteId: string }>,
			{ SITE_MEDIA: env.SITE_MEDIA, SiteService: env.SiteService },
		);

		expect(Object.getOwnPropertyNames(SiteReadCapability.prototype).sort()).toEqual([
			"constructor",
			"readFixtureContent",
			"readFixtureMedia",
		]);
		expect((await capabilityA.readFixtureContent())?.siteId).toBe(SITE_A);
		expect((await capabilityB.readFixtureContent())?.siteId).toBe(SITE_B);
		const mediaA = await (await capabilityA.readFixtureMedia()).text();
		const mediaB = await (await capabilityB.readFixtureMedia()).text();
		expect(mediaA).toContain(SITE_A);
		expect(mediaB).toContain(SITE_B);
		expect(mediaA).not.toBe(mediaB);
	});
});
