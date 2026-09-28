import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RELEASE_BUNDLE_VERSION,
	type ProviderOperation,
	type ReleaseBundle,
} from "../src/platform/contracts.js";
import { CloudflareWfpProviderAdapter } from "../src/platform/cloudflare-wfp-provider.js";
import {
	WFP_COMPATIBILITY_DATE,
	WFP_WORKER_FORMAT,
	deriveWfpProviderIdentity,
} from "../src/platform/wfp-release.js";
import { releaseArtifactKey } from "../src/platform/wfp-runtime.js";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const RELEASE_1 = "00000000-0000-4000-8000-000000000011";
const RELEASE_2 = "00000000-0000-4000-8000-000000000012";
const RELEASE_3 = "00000000-0000-4000-8000-000000000013";

function base64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const value = await crypto.subtle.digest("SHA-256", bytes.buffer);
	return `sha256:${[...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function seedRelease(releaseId: string) {
	const moduleBytes = new TextEncoder().encode(
		"export default { fetch: () => new Response('ok') }",
	);
	const artifact = {
		version: WFP_WORKER_FORMAT,
		kind: "worker",
		siteId: SITE_ID,
		releaseId,
		sourceRevision: `source-${releaseId}`,
		mainModule: "./src/index.js",
		modules: [
			{
				name: "src/index.js",
				type: "esm",
				base64: base64(moduleBytes),
				digest: await digest(moduleBytes),
				byteLength: moduleBytes.length,
			},
		],
		compatibilityDate: WFP_COMPATIBILITY_DATE,
		compatibilityFlags: ["nodejs_compat"],
		bindingIntents: [],
		healthPath: "/health",
	};
	const bytes = new TextEncoder().encode(JSON.stringify(artifact));
	const objectDigest = await digest(bytes);
	const key = releaseArtifactKey(SITE_ID, releaseId, "worker", objectDigest);
	await env.WFP_RELEASES.put(key, bytes);
	const bundle: ReleaseBundle = {
		version: RELEASE_BUNDLE_VERSION,
		sourceRevision: artifact.sourceRevision,
		worker: {
			kind: "worker-bundle",
			artifactId: key,
			formatVersion: WFP_WORKER_FORMAT,
			digest: objectDigest,
			byteLength: bytes.length,
		},
	};
	return { bundle, key };
}

async function runtime(path: string, body?: object) {
	return env.WFP_RUNTIME.fetch(`https://runtime.test${path}`, {
		method: body ? "POST" : "GET",
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function runtimeState() {
	const response = await runtime("/state");
	return response.json<{
		scripts: Record<string, { releaseId: string; uploadDigest: string }>;
		calls: Array<{ kind: string; scriptName: string; releaseId: string; uploadDigest: string }>;
	}>();
}

async function operation(
	provider: CloudflareWfpProviderAdapter,
	reference: { operationId: string },
): Promise<ProviderOperation> {
	return provider.getOperation(reference.operationId);
}

async function inspectSite() {
	const stub = env.ProviderControlPlane.getByName(SITE_ID);
	return runInDurableObject(stub, (_instance, state) => ({
		site: state.storage.sql
			.exec<{
				active_release_id: string | null;
				candidate_release_id: string | null;
				candidate_operation_id: string | null;
				live_operation_id: string | null;
			}>(
				"SELECT active_release_id, candidate_release_id, candidate_operation_id, live_operation_id FROM sites WHERE site_id = ?",
				SITE_ID,
			)
			.one(),
		releases: state.storage.sql
			.exec<{ release_id: string; state: string }>(
				"SELECT release_id, state FROM releases ORDER BY release_id",
			)
			.toArray(),
		operationCount: state.storage.sql
			.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations")
			.one().count,
	}));
}

describe("persistent WfP control plane", () => {
	beforeEach(async () => {
		await runtime("/reset", {});
		await runInDurableObject(
			env.ProviderControlPlane.getByName(SITE_ID),
			async (_instance, state) => {
				await state.storage.deleteAll();
			},
		);
		await abortAllDurableObjects();
	});

	it("deletes only one Site's deterministic scripts, release prefix, and records", async () => {
		const seeded = await seedRelease(RELEASE_1);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-cleanup" });
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: seeded.bundle,
			idempotencyKey: "deploy-cleanup",
		});
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "promote-cleanup",
		});
		await runtime("/upload", {
			scriptName: "unrelated-live",
			releaseId: RELEASE_3,
			uploadDigest: `sha256:${"f".repeat(64)}`,
		});
		await env.WFP_RELEASES.put("wfp-releases/unrelated/keep.json", "keep");

		const stub = env.ProviderControlPlane.getByName(SITE_ID) as DurableObjectStub & {
			cleanupSite(siteId: string): Promise<{ ok: true; value: { deleted: boolean } }>;
		};
		expect(await stub.cleanupSite(SITE_ID)).toEqual({ ok: true, value: { deleted: true } });
		expect(await stub.cleanupSite(SITE_ID)).toEqual({ ok: true, value: { deleted: true } });

		const state = await runtimeState();
		expect(Object.keys(state.scripts)).toEqual(["unrelated-live"]);
		expect(
			(await env.WFP_RELEASES.list({ prefix: `wfp-releases/${SITE_ID.replaceAll("-", "")}/` }))
				.objects,
		).toEqual([]);
		expect(await env.WFP_RELEASES.get("wfp-releases/unrelated/keep.json")).not.toBeNull();
		await env.WFP_RELEASES.delete("wfp-releases/unrelated/keep.json");
	});

	it("keeps Live unchanged on failed candidate, then promotes and rolls back", async () => {
		const release1 = await seedRelease(RELEASE_1);
		const release2 = await seedRelease(RELEASE_2);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure" });
		expect(
			await operation(
				provider,
				await provider.deployRelease({
					siteId: SITE_ID,
					releaseId: RELEASE_1,
					bundle: release1.bundle,
					idempotencyKey: "deploy-1",
				}),
			),
		).toMatchObject({ status: "succeeded" });
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "promote-1",
		});

		await runtime("/configure", { failHealth: [RELEASE_2] });
		const failed = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			bundle: release2.bundle,
			idempotencyKey: "deploy-2-failed",
		});
		expect(await operation(provider, failed)).toMatchObject({ status: "failed" });
		expect((await inspectSite()).site.active_release_id).toBe(RELEASE_1);
		const beforeRetry = await runtimeState();
		const liveScript = (await deriveWfpProviderIdentity(SITE_ID, RELEASE_1, "sites.test"))
			.liveScript;
		expect(beforeRetry.scripts[liveScript]?.releaseId).toBe(RELEASE_1);
		expect(beforeRetry.calls.filter(({ scriptName }) => scriptName === liveScript)).toHaveLength(1);
		expect(
			await provider.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_2,
				bundle: release2.bundle,
				idempotencyKey: "deploy-2-failed",
			}),
		).toEqual(failed);
		expect((await runtimeState()).calls).toHaveLength(beforeRetry.calls.length);

		await runtime("/configure", {});
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			bundle: release2.bundle,
			idempotencyKey: "deploy-2-retry",
		});
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			idempotencyKey: "promote-2",
		});
		expect((await inspectSite()).site.active_release_id).toBe(RELEASE_2);
		await provider.rollbackRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "rollback-1",
		});
		expect((await inspectSite()).site.active_release_id).toBe(RELEASE_1);

		await env.WFP_RELEASES.delete(release1.key);
		await env.WFP_RELEASES.delete(release2.key);
	});

	it("retries a candidate health check while a new upload becomes available", async () => {
		const release = await seedRelease(RELEASE_1);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-health-retry" });
		await runtime("/configure", { failHealthOnce: [RELEASE_1] });

		const deployed = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: release.bundle,
			idempotencyKey: "deploy-health-retry",
		});

		expect(await operation(provider, deployed)).toMatchObject({ status: "succeeded" });
		await env.WFP_RELEASES.delete(release.key);
	});

	it("survives DO eviction and rejects a mismatched idempotency replay", async () => {
		const seeded = await seedRelease(RELEASE_1);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-eviction" });
		const deployed = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: seeded.bundle,
			idempotencyKey: "deploy-eviction",
		});
		const calls = (await runtimeState()).calls.length;

		await abortAllDurableObjects();
		const recreated = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		expect(await recreated.getOperation(deployed.operationId)).toMatchObject({
			status: "succeeded",
		});
		expect(
			await recreated.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_1,
				bundle: seeded.bundle,
				idempotencyKey: "deploy-eviction",
			}),
		).toEqual(deployed);
		expect((await runtimeState()).calls).toHaveLength(calls);
		await expect(
			recreated.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_2,
				bundle: seeded.bundle,
				idempotencyKey: "deploy-eviction",
			}),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
		await env.WFP_RELEASES.delete(seeded.key);
	});

	it("reconciles applied candidate and live PUTs while fencing other mutations", async () => {
		const release1 = await seedRelease(RELEASE_1);
		const release2 = await seedRelease(RELEASE_2);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-ambiguous" });
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: release1.bundle,
			idempotencyKey: "deploy-1",
		});
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "promote-1",
		});
		const identity = await deriveWfpProviderIdentity(SITE_ID, RELEASE_2, "sites.test");
		await runtime("/configure", { ambiguousOnce: [identity.candidateScript] });
		const deploy2Request = {
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			bundle: release2.bundle,
			idempotencyKey: "deploy-2-ambiguous",
		};
		const ambiguousCandidate = await provider.deployRelease(deploy2Request);
		expect(await operation(provider, ambiguousCandidate)).toMatchObject({ status: "running" });
		await expect(
			provider.deployRelease({
				...deploy2Request,
				releaseId: RELEASE_3,
				idempotencyKey: "deploy-3",
			}),
		).rejects.toMatchObject({ code: "CANDIDATE_BUSY" });
		expect(await operation(provider, await provider.deployRelease(deploy2Request))).toMatchObject({
			status: "succeeded",
		});

		await runtime("/configure", { ambiguousOnce: [identity.liveScript] });
		const promoteRequest = {
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			idempotencyKey: "promote-2-ambiguous",
		};
		const ambiguousLive = await provider.promoteRelease(promoteRequest);
		expect(await operation(provider, ambiguousLive)).toMatchObject({ status: "running" });
		await expect(
			provider.rollbackRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_1,
				idempotencyKey: "blocked-rollback",
			}),
		).rejects.toMatchObject({ code: "LIVE_BUSY" });
		await abortAllDurableObjects();
		const recreated = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		expect(
			await operation(recreated, await recreated.promoteRelease(promoteRequest)),
		).toMatchObject({ status: "succeeded" });
		expect((await inspectSite()).site.active_release_id).toBe(RELEASE_2);
		expect(
			(await runtimeState()).calls.filter(({ scriptName }) => scriptName === identity.liveScript),
		).toHaveLength(2);
		await env.WFP_RELEASES.delete(release1.key);
		await env.WFP_RELEASES.delete(release2.key);
	});

	it("fails a candidate after bounded known HTTP errors and releases its fence", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const release1 = await seedRelease(RELEASE_1);
		const release2 = await seedRelease(RELEASE_2);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-rejected" });
		const rejectedIdentity = await deriveWfpProviderIdentity(SITE_ID, RELEASE_1, "sites.test");
		await runtime("/configure", { rejectUpload: [rejectedIdentity.candidateScript] });

		const rejected = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: release1.bundle,
			idempotencyKey: "deploy-rejected",
		});
		expect(await operation(provider, rejected)).toMatchObject({
			status: "failed",
			error: { code: "CANDIDATE_UPLOAD_FAILED", retryable: true },
		});
		const afterFailure = await inspectSite();
		expect(afterFailure.site.candidate_operation_id).toBeNull();
		expect(afterFailure.releases).toContainEqual({ release_id: RELEASE_1, state: "failed" });
		expect(
			(await runtimeState()).calls.filter(
				({ scriptName }) => scriptName === rejectedIdentity.candidateScript,
			),
		).toHaveLength(3);
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('"event":"builder.wfp_runtime_failure"'),
		);
		consoleError.mockRestore();

		await runtime("/configure", {});
		const next = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			bundle: release2.bundle,
			idempotencyKey: "deploy-after-rejected",
		});
		expect(await operation(provider, next)).toMatchObject({ status: "succeeded" });
		await env.WFP_RELEASES.delete(release1.key);
		await env.WFP_RELEASES.delete(release2.key);
	});

	it("replaces a completed candidate when a newer release is deployed", async () => {
		const release1 = await seedRelease(RELEASE_1);
		const release2 = await seedRelease(RELEASE_2);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-candidate-replace" });
		expect(
			await operation(
				provider,
				await provider.deployRelease({
					siteId: SITE_ID,
					releaseId: RELEASE_1,
					bundle: release1.bundle,
					idempotencyKey: "deploy-candidate-replace-1",
				}),
			),
		).toMatchObject({ status: "succeeded" });
		expect(
			await operation(
				provider,
				await provider.deployRelease({
					siteId: SITE_ID,
					releaseId: RELEASE_2,
					bundle: release2.bundle,
					idempotencyKey: "deploy-candidate-replace-2",
				}),
			),
		).toMatchObject({ status: "succeeded" });

		const inspected = await inspectSite();
		expect(inspected.site.candidate_release_id).toBe(RELEASE_2);
		expect(inspected.releases).toContainEqual({ release_id: RELEASE_1, state: "failed" });
		await env.WFP_RELEASES.delete(release1.key);
		await env.WFP_RELEASES.delete(release2.key);
	});

	it("keeps Live unchanged and fenced after known HTTP upload errors", async () => {
		const release1 = await seedRelease(RELEASE_1);
		const release2 = await seedRelease(RELEASE_2);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-live-rejected" });
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: release1.bundle,
			idempotencyKey: "deploy-live-rejected-1",
		});
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "promote-live-rejected-1",
		});
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			bundle: release2.bundle,
			idempotencyKey: "deploy-live-rejected-2",
		});
		const identity = await deriveWfpProviderIdentity(SITE_ID, RELEASE_2, "sites.test");
		await runtime("/configure", { rejectUpload: [identity.liveScript] });

		const rejected = await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			idempotencyKey: "promote-live-rejected-2",
		});
		expect(await operation(provider, rejected)).toMatchObject({
			status: "running",
			error: { code: "RECONCILIATION_REQUIRED", retryable: true },
		});
		const afterFailure = await inspectSite();
		expect(afterFailure.site.active_release_id).toBe(RELEASE_1);
		expect(afterFailure.site.live_operation_id).toBe(rejected.operationId);
		expect(
			(await runtimeState()).calls.filter(
				({ scriptName, releaseId }) =>
					scriptName === identity.liveScript && releaseId === RELEASE_2,
			),
		).toHaveLength(3);

		await env.WFP_RELEASES.delete(release1.key);
		await env.WFP_RELEASES.delete(release2.key);
	});

	it("reconciles an applied Live PUT after a later definite rejection", async () => {
		const release1 = await seedRelease(RELEASE_1);
		const release2 = await seedRelease(RELEASE_2);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-live-sequence" });
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: release1.bundle,
			idempotencyKey: "deploy-live-sequence-1",
		});
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "promote-live-sequence-1",
		});
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			bundle: release2.bundle,
			idempotencyKey: "deploy-live-sequence-2",
		});
		const identity = await deriveWfpProviderIdentity(SITE_ID, RELEASE_2, "sites.test");
		await runtime("/configure", { retryableThenRejected: [identity.liveScript] });
		const request = {
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			idempotencyKey: "promote-live-sequence-2",
		};

		const pending = await provider.promoteRelease(request);
		expect(await operation(provider, pending)).toMatchObject({
			status: "running",
			error: { code: "RECONCILIATION_REQUIRED", retryable: true },
		});
		expect((await inspectSite()).site).toMatchObject({
			active_release_id: RELEASE_1,
			live_operation_id: pending.operationId,
		});
		expect((await runtimeState()).scripts[identity.liveScript]?.releaseId).toBe(RELEASE_2);

		expect(await operation(provider, await provider.promoteRelease(request))).toMatchObject({
			status: "succeeded",
		});
		expect((await inspectSite()).site).toMatchObject({
			active_release_id: RELEASE_2,
			live_operation_id: null,
		});
		expect(
			(await runtimeState()).calls.filter(
				({ scriptName, releaseId }) =>
					scriptName === identity.liveScript && releaseId === RELEASE_2,
			),
		).toHaveLength(2);

		await env.WFP_RELEASES.delete(release1.key);
		await env.WFP_RELEASES.delete(release2.key);
	});

	it("rejects orphan mutations and records unsupported CMS and hostname operations", async () => {
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		const seeded = await seedRelease(RELEASE_1);
		await expect(
			provider.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_1,
				bundle: seeded.bundle,
				idempotencyKey: "orphan",
			}),
		).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-unsupported" });
		const cms = await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: {
				...seeded.bundle,
				cms: {
					kind: "cms-artifact",
					artifactId: "cms",
					formatVersion: "cms-v1",
					digest: `sha256:${"a".repeat(64)}`,
					byteLength: 1,
				},
			},
			idempotencyKey: "cms",
		});
		expect(await operation(provider, cms)).toMatchObject({
			status: "failed",
			error: { code: "CMS_TRANSFER_UNSUPPORTED", retryable: false },
		});
		const hostname = await provider.setHostname({
			siteId: SITE_ID,
			hostname: "custom.example.test",
			idempotencyKey: "hostname",
		});
		expect(await operation(provider, hostname)).toMatchObject({
			status: "failed",
			error: { code: "CUSTOM_HOSTNAME_UNSUPPORTED", retryable: false },
		});
		expect((await runtimeState()).calls).toHaveLength(0);
		expect((await inspectSite()).releases).toEqual([]);
		await env.WFP_RELEASES.delete(seeded.key);
	});

	it("fails closed at the per-Site operation and release retention caps", async () => {
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		const ensured = await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-cap" });
		await runInDurableObject(env.ProviderControlPlane.getByName(SITE_ID), (_instance, state) => {
			const now = new Date().toISOString();
			for (let index = 0; index < 199; index += 1) {
				state.storage.sql.exec(
					`INSERT INTO operations (id, site_id, kind, status, idempotency_key, request_hash, phase, created_at, updated_at)
					 VALUES (?, ?, 'set-hostname', 'failed', ?, ?, 'commit', ?, ?)`,
					`cap-operation-${index}`,
					SITE_ID,
					`cap-key-${index}`,
					`sha256:${index.toString(16).padStart(64, "0")}`,
					now,
					now,
				);
			}
		});
		expect(await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-cap" })).toEqual(
			ensured,
		);
		await expect(
			provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-over-cap" }),
		).rejects.toMatchObject({ code: "OPERATION_CAPACITY" });

		await runInDurableObject(
			env.ProviderControlPlane.getByName(SITE_ID),
			async (_instance, state) => {
				await state.storage.deleteAll();
			},
		);
		await abortAllDurableObjects();
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-release-cap" });
		await runInDurableObject(env.ProviderControlPlane.getByName(SITE_ID), (_instance, state) => {
			const now = new Date().toISOString();
			for (let index = 0; index < 20; index += 1) {
				state.storage.sql.exec(
					`INSERT INTO releases (site_id, release_id, bundle_json, request_hash, wrapper_version, candidate_script, state, created_at, updated_at)
					 VALUES (?, ?, '{}', ?, 'emdash-wrapper-v1', ?, 'failed', ?, ?)`,
					SITE_ID,
					`retained-${index}`,
					`sha256:${index.toString(16).padStart(64, "0")}`,
					`candidate-${index}`,
					now,
					now,
				);
			}
		});
		const seeded = await seedRelease(RELEASE_1);
		await expect(
			provider.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_1,
				bundle: seeded.bundle,
				idempotencyKey: "release-over-cap",
			}),
		).rejects.toMatchObject({ code: "RELEASE_CAPACITY" });
		expect((await runtimeState()).calls).toHaveLength(0);
		await env.WFP_RELEASES.delete(seeded.key);
	});

	it("keeps the live fence at the PUT limit when remote identity is foreign", async () => {
		const release1 = await seedRelease(RELEASE_1);
		const release2 = await seedRelease(RELEASE_2);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-limit" });
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: release1.bundle,
			idempotencyKey: "deploy-limit-1",
		});
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "promote-limit-1",
		});
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_2,
			bundle: release2.bundle,
			idempotencyKey: "deploy-limit-2",
		});
		const identity = await deriveWfpProviderIdentity(SITE_ID, RELEASE_2, "sites.test");
		await runtime("/configure", { ambiguousOnce: [identity.liveScript] });
		const request = { siteId: SITE_ID, releaseId: RELEASE_2, idempotencyKey: "promote-at-limit" };
		const pending = await provider.promoteRelease(request);
		await runInDurableObject(env.ProviderControlPlane.getByName(SITE_ID), (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE operations SET put_attempts = 5 WHERE id = ?",
				pending.operationId,
			);
		});
		await runtime("/upload", {
			scriptName: identity.liveScript,
			releaseId: RELEASE_3,
			uploadDigest: `sha256:${"f".repeat(64)}`,
		});

		const replay = await provider.promoteRelease(request);
		expect(await operation(provider, replay)).toMatchObject({
			status: "running",
			error: { code: "RECONCILIATION_REQUIRED", retryable: true },
		});
		const inspected = await inspectSite();
		expect(inspected.site.active_release_id).toBe(RELEASE_1);
		expect(inspected.site.live_operation_id).toBe(pending.operationId);
		await env.WFP_RELEASES.delete(release1.key);
		await env.WFP_RELEASES.delete(release2.key);
	});

	it("never redeploys an active or superseded Release as a candidate", async () => {
		const seeded = await seedRelease(RELEASE_1);
		const provider = new CloudflareWfpProviderAdapter(env.ProviderControlPlane);
		await provider.ensureSite({ siteId: SITE_ID, idempotencyKey: "ensure-live-redeploy" });
		await provider.deployRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			bundle: seeded.bundle,
			idempotencyKey: "deploy-live",
		});
		await provider.promoteRelease({
			siteId: SITE_ID,
			releaseId: RELEASE_1,
			idempotencyKey: "promote-live",
		});
		const calls = (await runtimeState()).calls.length;

		await expect(
			provider.deployRelease({
				siteId: SITE_ID,
				releaseId: RELEASE_1,
				bundle: seeded.bundle,
				idempotencyKey: "redeploy-live",
			}),
		).rejects.toMatchObject({ code: "RELEASE_ALREADY_LIVE" });
		expect((await inspectSite()).releases).toContainEqual({
			release_id: RELEASE_1,
			state: "active",
		});
		expect((await runtimeState()).calls).toHaveLength(calls);
		await env.WFP_RELEASES.delete(seeded.key);
	});
});
