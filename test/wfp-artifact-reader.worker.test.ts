import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RELEASE_BUNDLE_VERSION, type ReleaseBundle } from "../src/platform/contracts.js";
import {
	WFP_ASSETS_FORMAT,
	WFP_COMPATIBILITY_DATE,
	WFP_WORKER_FORMAT,
} from "../src/platform/wfp-release.js";
import { R2ReleaseArtifactReader, releaseArtifactKey } from "../src/platform/wfp-runtime.js";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SITE_ID = "00000000-0000-4000-8000-000000000002";
const RELEASE_ID = "00000000-0000-4000-8000-000000000011";

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return btoa(binary);
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const value = await crypto.subtle.digest("SHA-256", bytes.buffer);
	return `sha256:${[...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function encodedFile(name: string, type: string, bytes: Uint8Array<ArrayBuffer>) {
	return {
		name,
		type,
		base64: base64(bytes),
		digest: await digest(bytes),
		byteLength: bytes.length,
	};
}

async function fixture(envelopeSiteId = SITE_ID) {
	const workerArtifact = {
		version: WFP_WORKER_FORMAT,
		kind: "worker",
		siteId: envelopeSiteId,
		releaseId: RELEASE_ID,
		sourceRevision: "source-1",
		mainModule: "./src/index.js",
		modules: [
			await encodedFile(
				"src/index.js",
				"esm",
				new TextEncoder().encode("export default { fetch: () => new Response('ok') }"),
			),
			await encodedFile("src/module.wasm", "wasm", Uint8Array.of(0, 97, 115, 109, 255)),
		],
		compatibilityDate: WFP_COMPATIBILITY_DATE,
		compatibilityFlags: ["nodejs_compat"],
		bindingIntents: ["ASSETS"],
		healthPath: "/health",
	};
	const assetsArtifact = {
		version: WFP_ASSETS_FORMAT,
		kind: "assets",
		siteId: envelopeSiteId,
		releaseId: RELEASE_ID,
		assets: [
			{
				path: "images/logo.png",
				base64: base64(Uint8Array.of(137, 80, 78, 71, 0, 255)),
				digest: await digest(Uint8Array.of(137, 80, 78, 71, 0, 255)),
				byteLength: 6,
			},
		],
	};
	const workerBytes = new TextEncoder().encode(JSON.stringify(workerArtifact));
	const assetsBytes = new TextEncoder().encode(JSON.stringify(assetsArtifact));
	const workerDigest = await digest(workerBytes);
	const assetsDigest = await digest(assetsBytes);
	const workerKey = releaseArtifactKey(SITE_ID, RELEASE_ID, "worker", workerDigest);
	const assetsKey = releaseArtifactKey(SITE_ID, RELEASE_ID, "assets", assetsDigest);
	const bundle: ReleaseBundle = {
		version: RELEASE_BUNDLE_VERSION,
		sourceRevision: "source-1",
		worker: {
			kind: "worker-bundle",
			artifactId: workerKey,
			formatVersion: WFP_WORKER_FORMAT,
			digest: workerDigest,
			byteLength: workerBytes.length,
		},
		assets: {
			kind: "static-assets",
			artifactId: assetsKey,
			formatVersion: WFP_ASSETS_FORMAT,
			digest: assetsDigest,
			byteLength: assetsBytes.length,
		},
	};
	return { bundle, workerBytes, assetsBytes, workerKey, assetsKey };
}

async function withSeededArtifacts<T>(
	data: Awaited<ReturnType<typeof fixture>>,
	callback: () => Promise<T>,
): Promise<T> {
	await env.WFP_RELEASES.put(data.workerKey, data.workerBytes);
	await env.WFP_RELEASES.put(data.assetsKey, data.assetsBytes);
	try {
		return await callback();
	} finally {
		await env.WFP_RELEASES.delete(data.workerKey);
		await env.WFP_RELEASES.delete(data.assetsKey);
	}
}

async function seedBoundaryFixture() {
	const fileBytes = new Uint8Array(4 * 1024 * 1024);
	const fileBase64 = base64(fileBytes);
	const fileDigest = await digest(fileBytes);
	const file = { base64: fileBase64, digest: fileDigest, byteLength: fileBytes.length };
	const workerBytes = new TextEncoder().encode(
		JSON.stringify({
			version: WFP_WORKER_FORMAT,
			kind: "worker",
			siteId: SITE_ID,
			releaseId: RELEASE_ID,
			sourceRevision: "boundary-source",
			mainModule: "./src/a.js",
			modules: [
				{ name: "src/a.js", type: "esm", ...file },
				{ name: "src/b.bin", type: "data", ...file },
			],
			compatibilityDate: WFP_COMPATIBILITY_DATE,
			compatibilityFlags: ["nodejs_compat"],
			bindingIntents: ["ASSETS"],
			healthPath: "/health",
		}),
	);
	const assetsBytes = new TextEncoder().encode(
		JSON.stringify({
			version: WFP_ASSETS_FORMAT,
			kind: "assets",
			siteId: SITE_ID,
			releaseId: RELEASE_ID,
			assets: Array.from({ length: 4 }, (_, index) => ({
				path: `assets/${index}.bin`,
				...file,
			})),
		}),
	);
	const workerDigest = await digest(workerBytes);
	const assetsDigest = await digest(assetsBytes);
	const workerKey = releaseArtifactKey(SITE_ID, RELEASE_ID, "worker", workerDigest);
	const assetsKey = releaseArtifactKey(SITE_ID, RELEASE_ID, "assets", assetsDigest);
	await env.WFP_RELEASES.put(workerKey, workerBytes);
	await env.WFP_RELEASES.put(assetsKey, assetsBytes);
	return {
		workerKey,
		assetsKey,
		bundle: {
			version: RELEASE_BUNDLE_VERSION,
			sourceRevision: "boundary-source",
			worker: {
				kind: "worker-bundle",
				artifactId: workerKey,
				formatVersion: WFP_WORKER_FORMAT,
				digest: workerDigest,
				byteLength: workerBytes.length,
			},
			assets: {
				kind: "static-assets",
				artifactId: assetsKey,
				formatVersion: WFP_ASSETS_FORMAT,
				digest: assetsDigest,
				byteLength: assetsBytes.length,
			},
		} satisfies ReleaseBundle,
	};
}

describe("R2 release artifact reader", () => {
	it("loads and verifies a binary-safe package from the actual R2 binding", async () => {
		const data = await fixture();
		await withSeededArtifacts(data, async () => {
			const resolved = await new R2ReleaseArtifactReader(env.WFP_RELEASES).read(
				SITE_ID,
				RELEASE_ID,
				data.bundle,
			);

			expect(resolved.siteId).toBe(SITE_ID);
			expect(resolved.modules[1]?.bytes).toEqual(Uint8Array.of(0, 97, 115, 109, 255));
			expect(resolved.assets[0]?.bytes).toEqual(Uint8Array.of(137, 80, 78, 71, 0, 255));
		});
	});

	it("rejects missing, mismatched, and cross-Site objects", async () => {
		const missing = await fixture();
		await expect(
			new R2ReleaseArtifactReader(env.WFP_RELEASES).read(SITE_ID, RELEASE_ID, missing.bundle),
		).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });

		const mismatched = await fixture();
		await withSeededArtifacts(mismatched, async () => {
			await expect(
				new R2ReleaseArtifactReader(env.WFP_RELEASES).read(SITE_ID, RELEASE_ID, {
					...mismatched.bundle,
					worker: { ...mismatched.bundle.worker, byteLength: mismatched.workerBytes.length + 1 },
				}),
			).rejects.toMatchObject({ code: "ARTIFACT_LENGTH_MISMATCH" });
		});

		const foreign = await fixture(OTHER_SITE_ID);
		await withSeededArtifacts(foreign, async () => {
			await expect(
				new R2ReleaseArtifactReader(env.WFP_RELEASES).read(SITE_ID, RELEASE_ID, foreign.bundle),
			).rejects.toMatchObject({ code: "ARTIFACT_PROVENANCE" });
		});

		const digestMismatch = await fixture();
		const wrongDigest = `sha256:${"f".repeat(64)}`;
		const wrongKey = releaseArtifactKey(SITE_ID, RELEASE_ID, "worker", wrongDigest);
		await env.WFP_RELEASES.put(wrongKey, digestMismatch.workerBytes);
		await env.WFP_RELEASES.put(digestMismatch.assetsKey, digestMismatch.assetsBytes);
		try {
			await expect(
				new R2ReleaseArtifactReader(env.WFP_RELEASES).read(SITE_ID, RELEASE_ID, {
					...digestMismatch.bundle,
					worker: { ...digestMismatch.bundle.worker, artifactId: wrongKey, digest: wrongDigest },
				}),
			).rejects.toMatchObject({ code: "ARTIFACT_DIGEST_MISMATCH" });
		} finally {
			await env.WFP_RELEASES.delete(wrongKey);
			await env.WFP_RELEASES.delete(digestMismatch.assetsKey);
		}
	});

	it("rejects oversized references and object metadata before parsing", async () => {
		const data = await fixture();
		await expect(
			new R2ReleaseArtifactReader(env.WFP_RELEASES).read(SITE_ID, RELEASE_ID, {
				...data.bundle,
				worker: { ...data.bundle.worker, byteLength: 12 * 1024 * 1024 + 1 },
			}),
		).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });

		const oversizedKey = data.workerKey;
		await env.WFP_RELEASES.put(oversizedKey, new Uint8Array(12 * 1024 * 1024 + 1));
		try {
			await expect(
				new R2ReleaseArtifactReader(env.WFP_RELEASES).read(SITE_ID, RELEASE_ID, data.bundle),
			).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
		} finally {
			await env.WFP_RELEASES.delete(oversizedKey);
		}
	});

	it("resolves the approved 24 MiB decoded boundary inside the Workers isolate", async () => {
		const data = await seedBoundaryFixture();
		try {
			const resolved = await new R2ReleaseArtifactReader(env.WFP_RELEASES).read(
				SITE_ID,
				RELEASE_ID,
				data.bundle,
			);
			expect(resolved.modules.reduce((total, module) => total + module.bytes.length, 0)).toBe(
				8 * 1024 * 1024,
			);
			expect(resolved.assets.reduce((total, asset) => total + asset.bytes.length, 0)).toBe(
				16 * 1024 * 1024,
			);
		} finally {
			await env.WFP_RELEASES.delete(data.workerKey);
			await env.WFP_RELEASES.delete(data.assetsKey);
		}
	});
});
