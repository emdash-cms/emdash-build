import { describe, expect, it } from "vitest";
import {
	RELEASE_BUNDLE_VERSION,
	cmsArtifactReferenceSchema,
	releaseBundleSchema,
	type ReleaseBundle,
} from "../src/platform/contracts.js";
import { InMemoryProviderAdapter } from "../src/platform/in-memory-provider.js";
import { providerContractTests } from "./provider-contract-harness.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-09-13T12:00:00.000Z";
const SITE_ID = "00000000-0000-4000-8000-000000000001";
const RELEASE_1 = "00000000-0000-4000-8000-000000000011";
const RELEASE_2 = "00000000-0000-4000-8000-000000000012";
const RELEASE_BAD = "00000000-0000-4000-8000-000000000099";

const bundle: ReleaseBundle = {
	version: RELEASE_BUNDLE_VERSION,
	sourceRevision: "source-revision-1",
	worker: {
		kind: "worker-bundle",
		artifactId: "worker-1",
		formatVersion: "worker-bundle-v1",
		digest: DIGEST,
		byteLength: 1024,
	},
};

const bundleWithCms: ReleaseBundle = {
	...bundle,
	cms: {
		kind: "cms-artifact",
		artifactId: "cms-1",
		formatVersion: "core-owned-format-v1",
		digest: DIGEST,
		byteLength: 512,
	},
};

providerContractTests("in-memory", () => ({
	provider: new InMemoryProviderAdapter({ now: () => NOW }),
	siteId: SITE_ID,
	releaseId: RELEASE_1,
	bundle,
}));

describe("release bundle contracts", () => {
	it("accepts a versioned opaque CMS artifact reference", () => {
		expect(releaseBundleSchema.parse(bundleWithCms)).toEqual(bundleWithCms);
	});

	it("rejects embedded CMS serialization details", () => {
		const result = cmsArtifactReferenceSchema.safeParse({
			...bundleWithCms.cms,
			payload: { collections: [], content: [] },
		});

		expect(result.success).toBe(false);
	});

	it("rejects unverifiable artifact digests", () => {
		const result = cmsArtifactReferenceSchema.safeParse({
			...bundleWithCms.cms,
			digest: "not-a-digest",
		});

		expect(result.success).toBe(false);
	});

	it("rejects changing the bundle behind an existing release ID", async () => {
		const provider = new InMemoryProviderAdapter({ now: () => NOW });
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-immutable" });
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle,
			idempotencyKey: "deploy-original",
		});

		await expect(
			provider.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_1,
				bundle: { ...bundle, sourceRevision: "different-revision" },
				idempotencyKey: "deploy-mutated",
			}),
		).rejects.toMatchObject({ code: "RELEASE_IMMUTABLE" });
	});

	it("records declared CMS transfer as unsupported without creating a release", async () => {
		const provider = new InMemoryProviderAdapter({ now: () => NOW });
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-cms" });
		const first = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: bundleWithCms,
			idempotencyKey: "deploy-cms",
		});
		const retry = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: bundleWithCms,
			idempotencyKey: "deploy-cms",
		});

		expect(retry).toEqual(first);
		expect(await provider.getOperation(first.operationId)).toMatchObject({
			status: "failed",
			error: { code: "CMS_TRANSFER_UNSUPPORTED", retryable: false },
		});
		expect(provider.inspectSite(SITE_ID).releaseIds).toEqual([]);
	});

	it("allows only one bundle to win concurrent deployment of a release ID", async () => {
		const provider = new InMemoryProviderAdapter({ now: () => NOW });
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-race" });
		const results = await Promise.allSettled([
			provider.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_1,
				bundle,
				idempotencyKey: "deploy-race-a",
			}),
			provider.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_1,
				bundle: { ...bundle, sourceRevision: "racing-revision" },
				idempotencyKey: "deploy-race-b",
			}),
		]);

		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
		expect(results.find(({ status }) => status === "rejected")).toMatchObject({
			reason: { code: "RELEASE_IMMUTABLE" },
		});
		expect(provider.inspectSite(SITE_ID).releaseIds).toEqual([RELEASE_1]);
	});

	it("keeps a failed release ID bound to its original bundle", async () => {
		const provider = new InMemoryProviderAdapter({
			now: () => NOW,
			failDeployForRelease: (releaseId) => releaseId === RELEASE_BAD,
		});
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-failed" });
		const failed = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_BAD,
			bundle,
			idempotencyKey: "deploy-failed-original",
		});
		expect(await provider.getOperation(failed.operationId)).toMatchObject({ status: "failed" });

		await expect(
			provider.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_BAD,
				bundle: { ...bundle, sourceRevision: "changed-after-failure" },
				idempotencyKey: "deploy-failed-mutated",
			}),
		).rejects.toMatchObject({ code: "RELEASE_IMMUTABLE" });
	});

	it("never permits rollback to a failed deployment", async () => {
		const provider = new InMemoryProviderAdapter({
			now: () => NOW,
			failDeployForRelease: (releaseId) => releaseId === RELEASE_BAD,
		});
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-no-rollback" });
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_BAD,
			bundle,
			idempotencyKey: "deploy-no-rollback",
		});
		const rollback = await provider.rollbackRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_BAD,
			idempotencyKey: "rollback-failed",
		});

		expect(await provider.getOperation(rollback.operationId)).toMatchObject({ status: "failed" });
		expect(provider.inspectSite(SITE_ID).activeReleaseId).toBeUndefined();
	});
});

describe("fixture release lifecycle", () => {
	it("keeps live unchanged when a candidate fails, then supports promotion and rollback", async () => {
		const provider = new InMemoryProviderAdapter({
			now: () => NOW,
			failDeployForRelease: (releaseId) => releaseId === RELEASE_BAD,
		});
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure" });
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle,
			idempotencyKey: "deploy-1",
		});
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "promote-1",
		});

		const failed = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_BAD,
			bundle,
			idempotencyKey: "deploy-bad",
		});
		expect(await provider.getOperation(failed.operationId)).toMatchObject({ status: "failed" });
		expect(provider.inspectSite(SITE_ID).activeReleaseId).toBe(RELEASE_1);

		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			bundle,
			idempotencyKey: "deploy-2",
		});
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			idempotencyKey: "promote-2",
		});
		expect(provider.inspectSite(SITE_ID).activeReleaseId).toBe(RELEASE_2);

		await provider.rollbackRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "rollback-1",
		});
		expect(provider.inspectSite(SITE_ID).activeReleaseId).toBe(RELEASE_1);
	});
});
