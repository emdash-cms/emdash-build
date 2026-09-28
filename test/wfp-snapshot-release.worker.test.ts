import { env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	buildWfpSnapshotRelease,
	storeWfpSnapshotRelease,
} from "../src/platform/wfp-snapshot-release.js";
import type { StaticSiteSnapshot } from "../src/worker/static-site-snapshot.js";

const SITE_ID = "88888888-8888-4888-8888-888888888888";
const RELEASE_ID = "88888888-8888-5888-8888-888888888889";

async function digest(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
	return `sha256:${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function snapshot(): Promise<StaticSiteSnapshot> {
	const bytes = new TextEncoder().encode(
		"<!doctype html><html><body><h1>Stored</h1></body></html>",
	);
	const asset = {
		path: "__emdash/pages/home.html",
		bytes,
		contentType: "text/html",
		digest: await digest(bytes),
	};
	return {
		siteId: SITE_ID,
		liveOrigin: "https://site.test",
		releaseId: RELEASE_ID,
		sourceRevision: `sha256:${"a".repeat(64)}`,
		routes: [{ path: "/", kind: "page", assetPath: asset.path }],
		assets: [asset],
		manifest: {
			version: 1,
			routes: [{ path: "/", kind: "page", assetPath: asset.path }],
			assets: [
				{
					path: asset.path,
					byteLength: bytes.length,
					contentType: asset.contentType,
					digest: asset.digest,
				},
			],
		},
	};
}

describe("WfP snapshot artifact storage", () => {
	beforeEach(async () => {
		await reset();
		const objects = await env.WFP_RELEASES.list({
			prefix: `wfp-releases/${SITE_ID.replaceAll("-", "")}/`,
		});
		if (objects.objects.length)
			await env.WFP_RELEASES.delete(objects.objects.map(({ key }) => key));
	});

	it("reuses matching immutable objects and rejects mismatched existing bytes", async () => {
		const release = await buildWfpSnapshotRelease(await snapshot());

		await storeWfpSnapshotRelease(env.WFP_RELEASES, release);
		await storeWfpSnapshotRelease(env.WFP_RELEASES, release);
		expect(
			(await env.WFP_RELEASES.list({ prefix: `wfp-releases/${SITE_ID.replaceAll("-", "")}/` }))
				.objects,
		).toHaveLength(2);

		await env.WFP_RELEASES.put(release.bundle.worker.artifactId, "wrong");
		await expect(storeWfpSnapshotRelease(env.WFP_RELEASES, release)).rejects.toMatchObject({
			code: "ARTIFACT_IMMUTABLE",
		});
	});

	it("refuses to exceed the exact per-Site deletion bound", async () => {
		const release = await buildWfpSnapshotRelease(await snapshot());
		const prefix = `wfp-releases/${SITE_ID.replaceAll("-", "")}/`;
		for (let index = 0; index < 40; index += 1) {
			await env.WFP_RELEASES.put(`${prefix}existing-${index}.json`, "existing");
		}

		await expect(storeWfpSnapshotRelease(env.WFP_RELEASES, release)).rejects.toMatchObject({
			code: "ARTIFACT_CAPACITY",
		});
	});
});
