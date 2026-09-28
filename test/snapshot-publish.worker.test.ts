import {
	abortAllDurableObjects,
	applyD1Migrations,
	env,
	reset,
	runInDurableObject,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountAuthStore } from "../src/worker/account-auth.js";
import type { BuilderAgent } from "../src/worker/agent.js";
import type { ProjectCatalog } from "../src/worker/project-catalog.js";
import type { StaticSiteSnapshot } from "../src/worker/static-site-snapshot.js";
import { deriveWfpProviderIdentity } from "../src/platform/wfp-release.js";
import { siteForPublishedSlug } from "../src/worker/published-slugs.js";

const SITE_ID = "99999999-9999-4999-8999-999999999999";
const RELEASE_ID = "99999999-9999-5999-8999-999999999991";
const OWNER = "account:publish-owner";

const testEnv = env as typeof env & {
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
	ProjectCatalog: DurableObjectNamespace<ProjectCatalog>;
	AUTH_DB: D1Database;
	TEST_MIGRATIONS: D1Migration[];
};
const publicationEnv = env as { ENABLE_PUBLIC_PUBLISHING: string };

async function runtime(path: string, body?: object) {
	return env.WFP_RUNTIME.fetch(`https://runtime.test${path}`, {
		method: body ? "POST" : "GET",
		headers: body ? { "content-type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
}

async function runtimeState() {
	return (await runtime("/state")).json<{
		scripts: Record<string, { releaseId: string }>;
		calls: Array<{ kind: string; scriptName: string; releaseId?: string }>;
	}>();
}

async function digest(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
	return `sha256:${[...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function snapshot(releaseId = RELEASE_ID): Promise<StaticSiteSnapshot> {
	const bytes = new TextEncoder().encode("<!doctype html><html><body><h1>Live</h1></body></html>");
	const asset = {
		path: "__emdash/pages/home.html",
		bytes,
		contentType: "text/html",
		digest: await digest(bytes),
	};
	return {
		siteId: SITE_ID,
		liveOrigin: "https://s-test.sites.test",
		releaseId,
		sourceRevision: `sha256:${releaseId.replaceAll("-", "").slice(0, 64).padEnd(64, "0")}`,
		routes: [{ path: "/", kind: "page", assetPath: asset.path }],
		assets: [asset],
		manifest: {
			version: 1,
			routes: [{ path: "/", kind: "page", assetPath: asset.path }],
			assets: [],
		},
	};
}

type PublishResult =
	| {
			ok: true;
			status: "live";
			liveUrl: string;
			releaseId: string;
			sourceRevision: string;
			publishedAt: number;
	  }
	| { ok: false; code: string; message: string; reference?: string };

describe("snapshot publishing", () => {
	beforeEach(async () => {
		publicationEnv.ENABLE_PUBLIC_PUBLISHING = "false";
		await reset();
		await applyD1Migrations(testEnv.AUTH_DB, testEnv.TEST_MIGRATIONS);
		await runtime("/reset", {});
		await runInDurableObject(
			env.ProviderControlPlane.getByName(SITE_ID),
			async (_instance, state) => {
				await state.storage.deleteAll();
			},
		);
		await abortAllDurableObjects();
	});

	it("rejects publish reads and writes uniformly when public publishing is disabled", async () => {
		for (const method of ["GET", "POST"] as const) {
			const response = await exports.default.fetch(
				new Request(`http://localhost/api/projects/${SITE_ID}/publish`, {
					method,
					headers: { Origin: "http://localhost" },
				}),
			);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				code: "PUBLISH_DISABLED",
				message: "Publishing is temporarily unavailable.",
			});
		}
	});

	it("publishes through the authenticated HTTP endpoint", async () => {
		const auth = new AccountAuthStore(testEnv.AUTH_DB);
		const now = Date.now();
		const attempt = await auth.createLoginAttempt({ returnPath: `/s/${SITE_ID}`, now });
		const { session, token } = await auth.completeLogin({
			...attempt,
			principal: { kind: "account", issuer: "https://issuer.test", subject: "publisher" },
			now: now + 1,
		});
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(session.ownerKey);
		await testEnv.ProjectCatalog.getByName(session.ownerKey).registerProject(session.ownerKey, {
			id: SITE_ID,
			title: "HTTP publish",
			status: "draft",
			updatedAt: 1,
		});
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				persistenceError: "previous checkpoint failed",
				initialGeneration: { id: "generation", status: "ready" },
			});
			(
				instance as unknown as { prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot> }
			).prepareStaticSiteSnapshot = async () => snapshot();
		});

		publicationEnv.ENABLE_PUBLIC_PUBLISHING = "true";
		const response = await exports.default.fetch(
			new Request(`http://localhost/api/projects/${SITE_ID}/publish`, {
				method: "POST",
				headers: { Cookie: `emdash_session=${token}`, Origin: "http://localhost" },
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "live",
			liveUrl: expect.stringContaining("sites.test"),
			releaseId: RELEASE_ID,
		});
	});

	it("publishes an owned site to a unique named address and reads it after reload", async () => {
		const auth = new AccountAuthStore(testEnv.AUTH_DB);
		const now = Date.now();
		const attempt = await auth.createLoginAttempt({ returnPath: `/s/${SITE_ID}`, now });
		const { session, token } = await auth.completeLogin({
			...attempt,
			principal: { kind: "account", issuer: "https://issuer.test", subject: "named-publisher" },
			now: now + 1,
		});
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(session.ownerKey);
		await testEnv.ProjectCatalog.getByName(session.ownerKey).registerProject(session.ownerKey, {
			id: SITE_ID,
			title: "Named site",
			status: "draft",
			updatedAt: 1,
		});
		const prepare = vi.fn(async () => snapshot());
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			(
				instance as unknown as { prepareStaticSiteSnapshot: typeof prepare }
			).prepareStaticSiteSnapshot = prepare;
		});
		const request = (method: "GET" | "POST", slug?: string) =>
			exports.default.fetch(
				new Request(`http://localhost/api/projects/${SITE_ID}/publish`, {
					method,
					headers: {
						Cookie: `emdash_session=${token}`,
						Origin: "http://localhost",
						...(slug ? { "Content-Type": "application/json" } : {}),
					},
					body: slug ? JSON.stringify({ slug }) : undefined,
				}),
			);
		publicationEnv.ENABLE_PUBLIC_PUBLISHING = "true";
		const invalid = await request("POST", "bad.name");
		expect(invalid.status).toBe(400);
		expect(prepare).not.toHaveBeenCalled();
		const published = await request("POST", "quiet-iceland");
		expect(published.status).toBe(200);
		expect(await published.json()).toMatchObject({
			status: "live",
			liveUrl: "https://quiet-iceland.em-da.sh",
		});
		expect(prepare).toHaveBeenCalledWith("https://quiet-iceland.em-da.sh", expect.any(Function));
		expect(await siteForPublishedSlug(testEnv.AUTH_DB, "quiet-iceland")).toBe(SITE_ID);
		const details = await request("GET");
		expect(await details.json()).toMatchObject({ slug: "quiet-iceland", active: true });
		const changed = await request("POST", "another-iceland");
		expect(changed.status).toBe(409);
		expect(await changed.json()).toMatchObject({ code: "SLUG_LOCKED" });
	});

	it("refuses publishing from a shared-namespace Worker Preview", async () => {
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as {
				env: { SANDBOX_PREVIEW_MODE?: string };
				publishSiteForOwner(
					ownerKey: string,
					hostname: string,
					slug: string,
				): Promise<PublishResult>;
			};
			internals.env.SANDBOX_PREVIEW_MODE = "quick-tunnel";
			try {
				expect(
					await internals.publishSiteForOwner(OWNER, "sites.test", "quiet-iceland"),
				).toMatchObject({
					ok: false,
					code: "PUBLISH_NOT_CONFIGURED",
				});
			} finally {
				delete internals.env.SANDBOX_PREVIEW_MODE;
			}
		});
		expect(await siteForPublishedSlug(testEnv.AUTH_DB, "quiet-iceland")).toBeUndefined();
		expect((await runtimeState()).calls).toHaveLength(0);
	});

	it("keeps a named address unconfirmed when provider promotion is interrupted", async () => {
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Interrupted promotion",
			status: "draft",
			updatedAt: 1,
		});
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const internals = instance as unknown as {
				env: { ProviderControlPlane: typeof testEnv.ProviderControlPlane };
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(
					ownerKey: string,
					hostname: string,
					slug: string,
				): Promise<PublishResult>;
			};
			internals.prepareStaticSiteSnapshot = async () => snapshot();
			const namespace = internals.env.ProviderControlPlane;
			internals.env.ProviderControlPlane = {
				getByName: (siteId: string) => {
					const stub = namespace.getByName(siteId);
					return {
						ensureSite: (request: Parameters<typeof stub.ensureSite>[0]) =>
							stub.ensureSite(request),
						promoteRelease: async () => {
							throw new Error("transport disconnected");
						},
					} as unknown as typeof stub;
				},
			} as typeof namespace;
			try {
				const interrupted = await internals.publishSiteForOwner(
					OWNER,
					"sites.test",
					"quiet-iceland",
				);
				expect(interrupted).toMatchObject({ ok: false, code: "PUBLISH_FAILED" });
				expect(await instance.confirmedPublicationUrlForOwner(OWNER)).toBeUndefined();
				expect(instance.state.publication).toBeUndefined();
			} finally {
				internals.env.ProviderControlPlane = namespace;
			}
			expect(
				await internals.publishSiteForOwner(OWNER, "sites.test", "quiet-iceland"),
			).toMatchObject({
				ok: true,
				liveUrl: "https://quiet-iceland.em-da.sh",
			});
		});
	});

	it("publishes once, persists live metadata, updates the catalogue, and confirms the same release", async () => {
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Publish me",
			status: "draft",
			updatedAt: 1,
		});
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const prepared = await snapshot();
			const harness = instance as unknown as {
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
				setState(state: typeof instance.state): void;
			};
			const statuses: string[] = [];
			const setState = harness.setState.bind(instance);
			harness.setState = (state) => {
				if (state.status) statuses.push(state.status);
				setState(state);
			};
			harness.prepareStaticSiteSnapshot = async () => prepared;

			const first = await harness.publishSiteForOwner(OWNER, "sites.test");
			expect(first).toMatchObject({ ok: true, status: "live", releaseId: RELEASE_ID });
			expect(instance.state).toMatchObject({
				publication: { releaseId: RELEASE_ID, liveUrl: expect.stringContaining("sites.test") },
			});
			const calls = (await runtimeState()).calls.length;
			const second = await harness.publishSiteForOwner(OWNER, "sites.test");
			expect(second).toMatchObject({
				ok: true,
				status: "live",
				liveUrl: first.ok ? first.liveUrl : undefined,
				releaseId: RELEASE_ID,
			});
			expect(second.ok && first.ok ? second.publishedAt : 0).toBeGreaterThan(
				first.ok ? first.publishedAt : 0,
			);
			expect((await runtimeState()).calls).toHaveLength(calls + 1);
			expect(statuses).toEqual(
				expect.arrayContaining([
					"Uploading the publish bundle...",
					"Preparing the public site...",
					"Confirming the live release...",
					"Uploading the release...",
					"Saving the live site details...",
				]),
			);
			expect(instance.state.status).toBe("");
		});

		expect(await testEnv.ProjectCatalog.getByName(OWNER).listProjects()).toMatchObject([
			{ id: SITE_ID, status: "live" },
		]);
	});

	it("leaves Live unchanged on candidate failure and retries the same snapshot explicitly", async () => {
		const nextRelease = "99999999-9999-5999-8999-999999999992";
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Failure isolation",
			status: "draft",
			updatedAt: 1,
		});
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const prepared = [
				await snapshot(),
				await snapshot(nextRelease),
				await snapshot(nextRelease),
				await snapshot(nextRelease),
			];
			const harness = instance as unknown as {
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
			};
			harness.prepareStaticSiteSnapshot = async () => prepared.shift()!;
			expect(await harness.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({ ok: true });
			await runtime("/configure", { failHealth: [nextRelease] });

			const publishLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
			const failed = await harness.publishSiteForOwner(OWNER, "sites.test");
			expect(failed).toMatchObject({
				ok: false,
				code: "PUBLISH_FAILED",
			});
			expect(failed.ok ? undefined : failed.reference).toMatch(/^[0-9a-f]{8}$/);
			expect(publishLog).toHaveBeenCalledWith(
				expect.stringContaining(`"reference":"${failed.ok ? "" : failed.reference}"`),
			);
			publishLog.mockRestore();
			expect(failed.ok ? "" : failed.message).toContain("health check");
			expect(instance.state).toMatchObject({ publication: { releaseId: RELEASE_ID } });
			const liveScript = `e-${SITE_ID.replaceAll("-", "")}-live`;
			expect((await runtimeState()).scripts[liveScript]?.releaseId).toBe(RELEASE_ID);
			await runtime("/configure", {});
			const mutable = instance as unknown as {
				setState(state: typeof instance.state): void;
			};
			const setState = mutable.setState.bind(instance);
			let rejectPublicationState = true;
			mutable.setState = (state) => {
				if (rejectPublicationState && state.publication?.releaseId === nextRelease) {
					rejectPublicationState = false;
					throw new Error("state unavailable");
				}
				setState(state);
			};
			expect(await harness.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
				releaseId: nextRelease,
			});
			expect(instance.state).toMatchObject({ publication: { releaseId: RELEASE_ID } });
			mutable.setState = setState;
			expect(await harness.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
				releaseId: nextRelease,
			});
			expect(instance.state).toMatchObject({ publication: { releaseId: nextRelease } });
		});
		const liveScript = `e-${SITE_ID.replaceAll("-", "")}-live`;
		expect((await runtimeState()).scripts[liveScript]?.releaseId).toBe(nextRelease);
	});

	it("allows the same snapshot to recover after repeated definitive upload failures", async () => {
		const failedRelease = "99999999-9999-5999-8999-999999999992";
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Explicit retries",
			status: "draft",
			updatedAt: 1,
		});
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			let prepared = await snapshot();
			const internals = instance as unknown as {
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
			};
			internals.prepareStaticSiteSnapshot = async () => prepared;

			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({ ok: true });
			prepared = await snapshot(failedRelease);
			const identity = await deriveWfpProviderIdentity(SITE_ID, failedRelease, "sites.test");
			await runtime("/configure", { rejectDefinitely: [identity.candidateScript] });
			for (let attempt = 0; attempt < 4; attempt += 1) {
				const callsBefore = (await runtimeState()).calls.length;
				expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
					ok: false,
					code: "PUBLISH_FAILED",
				});
				expect((await runtimeState()).calls).toHaveLength(callsBefore + 1);
				expect((await runtimeState()).scripts[identity.liveScript]?.releaseId).toBe(RELEASE_ID);
			}
			await runtime("/configure", {});
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
				releaseId: failedRelease,
			});
			expect((await runtimeState()).scripts[identity.liveScript]?.releaseId).toBe(failedRelease);
		});
	});

	it("publishes a newer draft after a definitive promotion failure", async () => {
		const failedRelease = "99999999-9999-5999-8999-999999999992";
		const nextRelease = "99999999-9999-5999-8999-999999999993";
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Promotion recovery",
			status: "draft",
			updatedAt: 1,
		});
		const liveScript = (await deriveWfpProviderIdentity(SITE_ID, failedRelease, "sites.test"))
			.liveScript;
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const prepared = [
				await snapshot(),
				await snapshot(failedRelease),
				await snapshot(nextRelease),
			];
			const internals = instance as unknown as {
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
			};
			internals.prepareStaticSiteSnapshot = async () => prepared.shift()!;

			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
			});
			await runtime("/configure", { rejectDefinitely: [liveScript] });
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: false,
				code: "PUBLISH_FAILED",
			});
			await runtime("/configure", {});
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
				releaseId: nextRelease,
			});
		});
		expect((await runtimeState()).scripts[liveScript]?.releaseId).toBe(nextRelease);
	});

	it("rolls back when the draft exactly matches a previously published release", async () => {
		const secondRelease = "99999999-9999-5999-8999-999999999992";
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Restore release",
			status: "draft",
			updatedAt: 1,
		});
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const prepared = [await snapshot(), await snapshot(secondRelease), await snapshot()];
			const internals = instance as unknown as {
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
			};
			internals.prepareStaticSiteSnapshot = async () => prepared.shift()!;

			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
				releaseId: RELEASE_ID,
			});
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
				releaseId: secondRelease,
			});
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
				releaseId: RELEASE_ID,
			});
		});
		const liveScript = `e-${SITE_ID.replaceAll("-", "")}-live`;
		expect((await runtimeState()).scripts[liveScript]?.releaseId).toBe(RELEASE_ID);
	});

	it("reports an ambiguous promotion without claiming Live is unchanged", async () => {
		const nextRelease = "99999999-9999-5999-8999-999999999992";
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Ambiguous promotion",
			status: "draft",
			updatedAt: 1,
		});
		const liveScript = (await deriveWfpProviderIdentity(SITE_ID, nextRelease, "sites.test"))
			.liveScript;
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const prepared = [
				await snapshot(),
				await snapshot(nextRelease),
				await snapshot(),
				await snapshot(nextRelease),
			];
			const internals = instance as unknown as {
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
			};
			internals.prepareStaticSiteSnapshot = async () => prepared.shift()!;

			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
			});
			await runtime("/configure", { ambiguousOnce: [liveScript] });
			const pending = await internals.publishSiteForOwner(OWNER, "sites.test");
			expect(pending).toMatchObject({ ok: false, code: "PUBLISH_FAILED" });
			expect(pending.ok ? "" : pending.message).toContain("could not be confirmed");
			expect(pending.ok ? "" : pending.message).not.toContain("Live was not changed");
			const attempts = instance as unknown as {
				getPublishAttempt(releaseId: string, publicationEpoch: number): number;
			};
			for (let index = 0; index < 25; index += 1) {
				attempts.getPublishAttempt(`abandoned-${index}`, index);
			}
			const staleShortcut = await internals.publishSiteForOwner(OWNER, "sites.test");
			expect(staleShortcut).toMatchObject({ ok: false, code: "PUBLISH_FAILED" });
			expect(staleShortcut.ok ? "" : staleShortcut.message).toContain("could not be confirmed");
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
				releaseId: nextRelease,
			});
		});
	});

	it("reconciles an ambiguous candidate upload with the same operation on retry", async () => {
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Retry safely",
			status: "draft",
			updatedAt: 1,
		});
		const identity = await deriveWfpProviderIdentity(SITE_ID, RELEASE_ID, "sites.test");
		await runtime("/configure", { ambiguousOnce: [identity.candidateScript] });
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const internals = instance as unknown as {
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
			};
			internals.prepareStaticSiteSnapshot = async () => snapshot();

			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: false,
				code: "PUBLISH_FAILED",
			});
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
				releaseId: RELEASE_ID,
			});
		});
		const deployOperations = await runInDurableObject(
			env.ProviderControlPlane.getByName(SITE_ID),
			(_instance, state) =>
				state.storage.sql
					.exec<{ count: number }>(
						"SELECT COUNT(*) AS count FROM operations WHERE kind = 'deploy-release'",
					)
					.one().count,
		);
		expect(deployOperations).toBe(1);
	});

	it("returns the promoted URL even when catalogue persistence fails afterwards", async () => {
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Metadata failure",
			status: "draft",
			updatedAt: 1,
		});
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const internals = instance as unknown as {
				env: Record<string, unknown>;
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
			};
			internals.prepareStaticSiteSnapshot = async () => snapshot();
			const originalCatalog = internals.env.ProjectCatalog;
			try {
				internals.env.ProjectCatalog = {
					getByName: () => ({
						listProjects: async () => [
							{ id: SITE_ID, title: "Metadata failure", status: "draft", updatedAt: 1 },
						],
						updateProject: async () => {
							throw new Error("catalogue unavailable");
						},
					}),
				};

				await expect(internals.publishSiteForOwner(OWNER, "sites.test")).resolves.toMatchObject({
					ok: true,
					status: "live",
					releaseId: RELEASE_ID,
				});
			} finally {
				internals.env.ProjectCatalog = originalCatalog;
			}
		});
	});

	it("removes the published scripts and artifacts before Builder state on deletion", async () => {
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Delete published",
			status: "draft",
			updatedAt: 1,
		});
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const internals = instance as unknown as {
				env: Record<string, unknown>;
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
			};
			internals.prepareStaticSiteSnapshot = async () => snapshot();
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({ ok: true });
			const originalArtifacts = internals.env.ARTIFACTS;
			const originalSandbox = internals.env.Sandbox;
			try {
				internals.env.ARTIFACTS = { delete: async () => undefined };
				internals.env.Sandbox = {
					getByName: () => ({ deleteProjectData: async () => undefined }),
				};
				expect(await instance.deleteProjectForOwner(OWNER)).toBe("deleted");
			} finally {
				internals.env.ARTIFACTS = originalArtifacts;
				internals.env.Sandbox = originalSandbox;
			}
		});

		expect(Object.keys((await runtimeState()).scripts)).toEqual([]);
		expect(
			(await env.WFP_RELEASES.list({ prefix: `wfp-releases/${SITE_ID.replaceAll("-", "")}/` }))
				.objects,
		).toEqual([]);
	});

	it("refuses deletion without cleanup bindings after remote promotion outlives state", async () => {
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Delete uncertain publication",
			status: "draft",
			updatedAt: 1,
		});
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const internals = instance as unknown as {
				env: Record<string, unknown>;
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
				setState(state: typeof instance.state): void;
			};
			internals.prepareStaticSiteSnapshot = async () => snapshot();
			const setState = internals.setState.bind(instance);
			internals.setState = (state) => {
				if (state.publication) throw new Error("state unavailable");
				setState(state);
			};
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: true,
			});
			internals.setState = setState;
			expect(instance.state.publication).toBeUndefined();

			const originalProvider = internals.env.ProviderControlPlane;
			const originalReleases = internals.env.WFP_RELEASES;
			const originalArtifacts = internals.env.ARTIFACTS;
			const originalSandbox = internals.env.Sandbox;
			const deleteArtifacts = vi.fn();
			try {
				internals.env.ProviderControlPlane = undefined;
				internals.env.WFP_RELEASES = undefined;
				internals.env.ARTIFACTS = { delete: deleteArtifacts };
				internals.env.Sandbox = {
					getByName: () => ({ deleteProjectData: vi.fn() }),
				};
				expect(await instance.deleteProjectForOwner(OWNER)).toBe("retry");
				expect(deleteArtifacts).not.toHaveBeenCalled();
			} finally {
				internals.env.ProviderControlPlane = originalProvider;
				internals.env.WFP_RELEASES = originalReleases;
				internals.env.ARTIFACTS = originalArtifacts;
				internals.env.Sandbox = originalSandbox;
			}
		});
	});

	it("refuses deletion without cleanup bindings after a failed candidate upload", async () => {
		const agent = testEnv.BuilderAgent.getByName(SITE_ID);
		await agent.initializeOwnership(OWNER);
		await testEnv.ProjectCatalog.getByName(OWNER).registerProject(OWNER, {
			id: SITE_ID,
			title: "Delete failed candidate",
			status: "draft",
			updatedAt: 1,
		});
		await runtime("/configure", { failHealth: [RELEASE_ID] });
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				complete: true,
				previewUrl: "https://preview.example.test",
				initialGeneration: { id: "generation", status: "ready" },
			});
			const internals = instance as unknown as {
				env: Record<string, unknown>;
				prepareStaticSiteSnapshot(): Promise<StaticSiteSnapshot>;
				publishSiteForOwner(ownerKey: string, sitesHostname: string): Promise<PublishResult>;
			};
			internals.prepareStaticSiteSnapshot = async () => snapshot();
			expect(await internals.publishSiteForOwner(OWNER, "sites.test")).toMatchObject({
				ok: false,
				code: "PUBLISH_FAILED",
			});
			expect(instance.state.publication).toBeUndefined();

			const originalProvider = internals.env.ProviderControlPlane;
			const originalReleases = internals.env.WFP_RELEASES;
			const originalArtifacts = internals.env.ARTIFACTS;
			const originalSandbox = internals.env.Sandbox;
			const deleteArtifacts = vi.fn();
			try {
				internals.env.ProviderControlPlane = undefined;
				internals.env.WFP_RELEASES = undefined;
				internals.env.ARTIFACTS = { delete: deleteArtifacts };
				internals.env.Sandbox = {
					getByName: () => ({ deleteProjectData: vi.fn() }),
				};
				expect(await instance.deleteProjectForOwner(OWNER)).toBe("retry");
				expect(deleteArtifacts).not.toHaveBeenCalled();
			} finally {
				internals.env.ProviderControlPlane = originalProvider;
				internals.env.WFP_RELEASES = originalReleases;
				internals.env.ARTIFACTS = originalArtifacts;
				internals.env.Sandbox = originalSandbox;
			}
		});
	});
});
