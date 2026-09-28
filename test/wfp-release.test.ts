import { describe, expect, it } from "vitest";
import {
	RELEASE_BUNDLE_VERSION,
	providerRequestFingerprint,
	type ReleaseBundle,
} from "../src/platform/contracts.js";
import {
	WFP_ASSETS_FORMAT,
	WFP_COMPATIBILITY_DATE,
	WFP_HEALTH_PATH,
	WFP_RELEASE_LIMITS,
	WFP_WORKER_FORMAT,
	deriveWfpProviderIdentity,
	resolveWfpReleasePackage,
} from "../src/platform/wfp-release.js";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const RELEASE_ID = "00000000-0000-4000-8000-000000000011";

async function digest(bytes: Uint8Array): Promise<string> {
	const input = new Uint8Array(bytes.byteLength);
	input.set(bytes);
	const value = await crypto.subtle.digest("SHA-256", input.buffer);
	return `sha256:${[...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

async function file(name: string, type: string, bytes: Uint8Array) {
	return {
		name,
		type,
		base64: base64(bytes),
		digest: await digest(bytes),
		byteLength: bytes.length,
	};
}

async function fixture() {
	const script = new TextEncoder().encode("export default { fetch: () => new Response('ok') };");
	const wasm = Uint8Array.of(0, 97, 115, 109, 255, 0, 128);
	const image = Uint8Array.of(137, 80, 78, 71, 0, 255, 10);
	const bundle: ReleaseBundle = {
		version: RELEASE_BUNDLE_VERSION,
		sourceRevision: "source-1",
		worker: {
			kind: "worker-bundle",
			artifactId: "worker-object",
			formatVersion: WFP_WORKER_FORMAT,
			digest: `sha256:${"a".repeat(64)}`,
			byteLength: 1,
		},
		assets: {
			kind: "static-assets",
			artifactId: "assets-object",
			formatVersion: WFP_ASSETS_FORMAT,
			digest: `sha256:${"b".repeat(64)}`,
			byteLength: 1,
		},
	};
	return {
		bundle,
		workerArtifact: {
			version: WFP_WORKER_FORMAT,
			kind: "worker",
			siteId: SITE_ID,
			releaseId: RELEASE_ID,
			sourceRevision: bundle.sourceRevision,
			mainModule: "./src/index.js",
			modules: [
				await file("src/index.js", "esm", script),
				await file("src/module.wasm", "wasm", wasm),
			],
			compatibilityDate: WFP_COMPATIBILITY_DATE,
			compatibilityFlags: ["nodejs_compat"],
			bindingIntents: ["ASSETS"],
			healthPath: "/health",
		},
		assetsArtifact: {
			version: WFP_ASSETS_FORMAT,
			kind: "assets",
			siteId: SITE_ID,
			releaseId: RELEASE_ID,
			assets: [
				{
					path: "images/logo.png",
					base64: base64(image),
					digest: await digest(image),
					byteLength: image.length,
				},
			],
		},
		wasm,
		image,
	};
}

describe("WfP release package", () => {
	it("resolves a binary-safe bounded package and stable upload digest", async () => {
		const input = await fixture();
		const first = await resolveWfpReleasePackage({
			siteId: SITE_ID,
			releaseId: RELEASE_ID,
			...input,
		});
		const second = await resolveWfpReleasePackage({
			siteId: SITE_ID,
			releaseId: RELEASE_ID,
			...input,
		});

		expect(first.uploadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(second.uploadDigest).toBe(first.uploadDigest);
		expect(first.modules[1]?.bytes).toEqual(input.wasm);
		expect(first.assets[0]?.bytes).toEqual(input.image);
		expect(new TextDecoder().decode(first.wrapperBytes)).toContain(WFP_HEALTH_PATH);
	});

	it("rejects unsafe package metadata before upload", async () => {
		const cases: Array<[string, (input: Awaited<ReturnType<typeof fixture>>) => void]> = [
			["traversing module", (input) => (input.workerArtifact.modules[0]!.name = "../index.js")],
			[
				"reserved module",
				(input) => (input.workerArtifact.modules[0]!.name = "__emdash_entry.mjs"),
			],
			["missing main", (input) => (input.workerArtifact.mainModule = "./missing.js")],
			["absolute main", (input) => (input.workerArtifact.mainModule = "https://evil.test/x.js")],
			["source injection", (input) => (input.workerArtifact.mainModule = './src/";throw 1;//.js')],
			[
				"wrong compatibility date",
				(input) =>
					((input.workerArtifact as { compatibilityDate: string }).compatibilityDate =
						"2026-09-22"),
			],
			[
				"duplicate flag",
				(input) => (input.workerArtifact.compatibilityFlags = ["nodejs_compat", "nodejs_compat"]),
			],
			["unsupported flag", (input) => (input.workerArtifact.compatibilityFlags = ["unsafe_flag"])],
			["unsupported binding", (input) => (input.workerArtifact.bindingIntents = ["SECRET"])],
			["reserved health path", (input) => (input.workerArtifact.healthPath = WFP_HEALTH_PATH)],
			[
				"normalized reserved health path",
				(input) => (input.workerArtifact.healthPath = `/foo/..${WFP_HEALTH_PATH}`),
			],
			[
				"encoded normalized reserved health path",
				(input) => (input.workerArtifact.healthPath = `/foo/%2e%2e${WFP_HEALTH_PATH}`),
			],
			["health query", (input) => (input.workerArtifact.healthPath = "/health?deep=1")],
			["traversing asset", (input) => (input.assetsArtifact.assets[0]!.path = "../logo.png")],
		];

		for (const [name, mutate] of cases) {
			const input = await fixture();
			mutate(input);
			await expect(
				resolveWfpReleasePackage({ siteId: SITE_ID, releaseId: RELEASE_ID, ...input }),
				name,
			).rejects.toThrow();
		}
	});

	it("rejects duplicates, binding mismatches, bad digests, and count overflow", async () => {
		const duplicate = await fixture();
		duplicate.workerArtifact.modules.push(duplicate.workerArtifact.modules[0]!);
		await expect(
			resolveWfpReleasePackage({ siteId: SITE_ID, releaseId: RELEASE_ID, ...duplicate }),
		).rejects.toThrow();

		const mismatch = await fixture();
		mismatch.workerArtifact.bindingIntents = [];
		await expect(
			resolveWfpReleasePackage({ siteId: SITE_ID, releaseId: RELEASE_ID, ...mismatch }),
		).rejects.toThrow();

		const badDigest = await fixture();
		badDigest.workerArtifact.modules[0]!.digest = `sha256:${"0".repeat(64)}`;
		await expect(
			resolveWfpReleasePackage({ siteId: SITE_ID, releaseId: RELEASE_ID, ...badDigest }),
		).rejects.toThrow();

		const tooMany = await fixture();
		tooMany.workerArtifact.modules = Array.from(
			{ length: WFP_RELEASE_LIMITS.modules + 1 },
			(_, index) => ({ ...tooMany.workerArtifact.modules[0]!, name: `src/${index}.js` }),
		);
		await expect(
			resolveWfpReleasePackage({ siteId: SITE_ID, releaseId: RELEASE_ID, ...tooMany }),
		).rejects.toThrow();
	});

	it("rejects declared file and aggregate byte limits before decoding", async () => {
		const moduleFile = await fixture();
		moduleFile.workerArtifact.modules[0]!.byteLength = WFP_RELEASE_LIMITS.moduleBytes + 1;
		await expect(
			resolveWfpReleasePackage({ siteId: SITE_ID, releaseId: RELEASE_ID, ...moduleFile }),
		).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

		const moduleTotal = await fixture();
		moduleTotal.workerArtifact.modules = Array.from({ length: 3 }, (_, index) => ({
			...moduleTotal.workerArtifact.modules[0]!,
			name: `src/${index}.js`,
			byteLength: 3 * 1024 * 1024,
		}));
		moduleTotal.workerArtifact.mainModule = "./src/0.js";
		await expect(
			resolveWfpReleasePackage({ siteId: SITE_ID, releaseId: RELEASE_ID, ...moduleTotal }),
		).rejects.toMatchObject({ code: "MODULES_TOO_LARGE" });

		const assetTotal = await fixture();
		assetTotal.assetsArtifact.assets = Array.from({ length: 5 }, (_, index) => ({
			...assetTotal.assetsArtifact.assets[0]!,
			path: `images/${index}.png`,
			byteLength: 3_500_000,
		}));
		await expect(
			resolveWfpReleasePackage({ siteId: SITE_ID, releaseId: RELEASE_ID, ...assetTotal }),
		).rejects.toMatchObject({ code: "ASSETS_TOO_LARGE" });
	});

	it("rejects an unknown historical wrapper before generating live bytes", async () => {
		const input = await fixture();
		await expect(
			resolveWfpReleasePackage({
				siteId: SITE_ID,
				releaseId: RELEASE_ID,
				...input,
				wrapperVersion: "emdash-wrapper-v999",
			}),
		).rejects.toThrow(/wrapper/i);
	});
});

describe("WfP deterministic identity", () => {
	it("normalizes UUID case into one provider identity", async () => {
		const lower = await deriveWfpProviderIdentity(SITE_ID, RELEASE_ID, "sites.example.test");
		const upper = await deriveWfpProviderIdentity(
			SITE_ID.toUpperCase(),
			RELEASE_ID.toUpperCase(),
			"sites.example.test",
		);

		expect(upper).toEqual(lower);
		expect(lower.candidateScript).toMatch(/^e-[a-z2-7]{20}-r-[a-z2-7]{20}$/);
		expect(lower.liveScript).toBe(`e-${SITE_ID.replaceAll("-", "")}-live`);
		expect(lower.hostname).toBe(`s-${SITE_ID.replaceAll("-", "")}.sites.example.test`);
	});
});

describe("provider request fingerprint", () => {
	it("ignores caller object insertion order", async () => {
		const { bundle } = await fixture();
		const reordered = {
			cms: undefined,
			assets: bundle.assets,
			worker: bundle.worker,
			sourceRevision: bundle.sourceRevision,
			version: bundle.version,
		} as ReleaseBundle;
		const first = await providerRequestFingerprint("deploy-release", {
			siteId: SITE_ID,
			releaseId: RELEASE_ID,
			bundle,
			idempotencyKey: "first",
		});
		const second = await providerRequestFingerprint("deploy-release", {
			siteId: SITE_ID,
			releaseId: RELEASE_ID,
			bundle: reordered,
			idempotencyKey: "second",
		});

		expect(second).toBe(first);
	});
});
