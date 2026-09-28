import { applyD1Migrations, env, reset } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	activatePublishedSlug,
	activePublishedSlugForSite,
	deletePublishedSlug,
	reservePublishedSlug,
	siteForPublishedSlug,
	validPublishedSlug,
} from "../src/worker/published-slugs.js";

const siteA = "11111111-1111-4111-8111-111111111111";
const siteB = "22222222-2222-4222-8222-222222222222";
const testEnv = env as typeof env & { AUTH_DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

describe("published site names", () => {
	beforeEach(async () => {
		await reset();
		await applyD1Migrations(testEnv.AUTH_DB, testEnv.TEST_MIGRATIONS);
	});

	it("accepts one DNS label but excludes platform and malformed labels", () => {
		expect(validPublishedSlug("quiet-iceland")).toBe(true);
		for (const slug of [
			"www",
			"cdn",
			"api",
			"a",
			"A-Team",
			"-bad",
			"bad-",
			"two.dots",
			"xn--pple-43d",
			"a".repeat(64),
		]) {
			expect(validPublishedSlug(slug)).toBe(false);
		}
	});

	it("reserves atomically across sites and allows correction only before activation", async () => {
		await reservePublishedSlug(testEnv.AUTH_DB, siteA, "quiet-iceland");
		expect(await siteForPublishedSlug(testEnv.AUTH_DB, "quiet-iceland")).toBeUndefined();
		await expect(
			reservePublishedSlug(testEnv.AUTH_DB, siteB, "quiet-iceland"),
		).rejects.toMatchObject({ code: "SLUG_TAKEN" });
		await reservePublishedSlug(testEnv.AUTH_DB, siteA, "noah-iceland");
		await reservePublishedSlug(testEnv.AUTH_DB, siteB, "quiet-iceland");
		await activatePublishedSlug(testEnv.AUTH_DB, siteA, "noah-iceland");
		await expect(
			reservePublishedSlug(testEnv.AUTH_DB, siteA, "another-name"),
		).rejects.toMatchObject({ code: "SLUG_LOCKED" });
		await activatePublishedSlug(testEnv.AUTH_DB, siteA, "noah-iceland");
		expect(await siteForPublishedSlug(testEnv.AUTH_DB, "noah-iceland")).toBe(siteA);
		expect(await activePublishedSlugForSite(testEnv.AUTH_DB, siteA)).toBe("noah-iceland");
		await expect(
			reservePublishedSlug(testEnv.AUTH_DB, siteA, "another-name"),
		).rejects.toMatchObject({ code: "SLUG_LOCKED" });
		await reservePublishedSlug(testEnv.AUTH_DB, siteA, "noah-iceland");
		await activatePublishedSlug(testEnv.AUTH_DB, siteA, "noah-iceland");
		await deletePublishedSlug(testEnv.AUTH_DB, siteB);
		await reservePublishedSlug(testEnv.AUTH_DB, siteB, "quiet-iceland");
	});

	it("releases an active name only on exact-site deletion", async () => {
		await reservePublishedSlug(testEnv.AUTH_DB, siteA, "quiet-iceland");
		await activatePublishedSlug(testEnv.AUTH_DB, siteA, "quiet-iceland");
		await deletePublishedSlug(testEnv.AUTH_DB, siteB);
		expect(await siteForPublishedSlug(testEnv.AUTH_DB, "quiet-iceland")).toBe(siteA);
		await deletePublishedSlug(testEnv.AUTH_DB, siteA);
		await reservePublishedSlug(testEnv.AUTH_DB, siteB, "quiet-iceland");
	});
});
