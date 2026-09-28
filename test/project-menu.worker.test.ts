import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";
import { BuildConvergence } from "../src/worker/build-convergence.js";
import type { ProjectCatalog } from "../src/worker/project-catalog.js";
import {
	createGuestToken,
	hashGuestToken,
	serializeGuestCookie,
} from "../src/worker/project-auth.js";

const testEnv = env as typeof env & {
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
	ProjectCatalog: DurableObjectNamespace<ProjectCatalog>;
};
const id = "11111111-1111-4111-8111-111111111111";
const project = { id, title: "First site", status: "building" as const, updatedAt: 1 };

async function setup() {
	const token = createGuestToken();
	const owner = await hashGuestToken(token);
	const cookie = serializeGuestCookie(token, false).split(";", 1)[0]!;
	const catalog = testEnv.ProjectCatalog.getByName(owner);
	const agent = testEnv.BuilderAgent.getByName(id);
	await agent.initializeOwnership(owner);
	await catalog.registerProject(owner, project);
	return { owner, cookie, catalog, agent };
}

function request(method: "PATCH" | "DELETE", cookie: string, title?: string) {
	return exports.default.fetch(
		new Request(`http://localhost/api/projects/${id}`, {
			method,
			headers: { Cookie: cookie, "Content-Type": "application/json" },
			...(title ? { body: JSON.stringify({ title }) } : {}),
		}),
	);
}

describe("recent-site actions", () => {
	beforeEach(() => reset());

	it("requires ownership and renames without changing build state", async () => {
		const { cookie, catalog } = await setup();
		const stranger = serializeGuestCookie(createGuestToken(), false).split(";", 1)[0]!;
		expect((await request("PATCH", stranger, "Stolen")).status).toBe(404);
		expect((await request("DELETE", stranger)).status).toBe(404);
		expect((await request("PATCH", cookie, "  Iceland by Noah  ")).status).toBe(200);
		expect(await catalog.listProjects()).toMatchObject([
			{ title: "Iceland by Noah", status: "building" },
		]);
	});

	it("coalesces overlapping cleanup and accepts duplicate completion", async () => {
		const { owner, catalog, agent } = await setup();
		expect(await catalog.beginDeleteProject(owner, id)).toBe("ready");
		let attempts = 0;
		const outcomes = await runInDurableObject(agent, async (instance) => {
			let releaseCleanup!: () => void;
			let cleanupStarted!: () => void;
			const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));
			const started = new Promise<void>((resolve) => (cleanupStarted = resolve));
			const harness = instance as unknown as { eraseProjectData: () => Promise<void> };
			harness.eraseProjectData = async () => {
				attempts++;
				cleanupStarted();
				await cleanupGate;
			};
			const first = instance.deleteProjectForOwner(owner);
			await started;
			const second = instance.deleteProjectForOwner(owner);
			releaseCleanup();
			return Promise.all([first, second]);
		});
		expect(outcomes).toEqual(["deleted", "deleted"]);
		expect(attempts).toBe(1);
		expect(await catalog.finishDeleteProject(owner, id)).toBe(true);
		expect(await catalog.finishDeleteProject(owner, id)).toBe(true);
		expect(await catalog.listProjects()).toEqual([]);
	});

	it("deletes a site whose setup failed before producing a build", async () => {
		const { cookie, catalog, agent } = await setup();
		const erased = vi.fn();
		await runInDurableObject(agent, (instance) => {
			instance.setState({
				...instance.state,
				provisionError: "Setup failed",
				initialGeneration: { id: "opening-brief", status: "failed" },
			});
			const harness = instance as unknown as {
				provisionPromise: Promise<{ ready: false; error: string }>;
				eraseProjectData: () => Promise<void>;
			};
			harness.provisionPromise = Promise.resolve({ ready: false, error: "Setup failed" });
			harness.eraseProjectData = async () => erased();
		});

		expect((await request("DELETE", cookie)).status).toBe(200);
		expect(erased).toHaveBeenCalledOnce();
		expect(await catalog.listProjects()).toEqual([]);
	});

	it("stops active setup before deleting the site", async () => {
		const { cookie, catalog, agent } = await setup();
		let setupStopped = false;
		const erased = vi.fn();
		await runInDurableObject(agent, (instance) => {
			instance.setState({
				...instance.state,
				status: "Setting up your site...",
				initialGeneration: { id: "opening-brief", status: "preparing" },
			});
			const controller = new AbortController();
			const provision = new Promise<{ ready: false; stopped: true }>((resolve) => {
				controller.signal.addEventListener(
					"abort",
					() => {
						setupStopped = true;
						resolve({ ready: false, stopped: true });
					},
					{ once: true },
				);
			});
			const harness = instance as unknown as {
				provisionController: AbortController;
				provisionPromise: typeof provision;
				eraseProjectData: () => Promise<void>;
			};
			harness.provisionController = controller;
			harness.provisionPromise = provision;
			harness.eraseProjectData = async () => {
				expect(setupStopped).toBe(true);
				erased();
			};
		});

		expect((await request("DELETE", cookie)).status).toBe(200);
		expect(erased).toHaveBeenCalledOnce();
		expect(await catalog.listProjects()).toEqual([]);
	});

	it("deletes after an interrupted chat leaves only stale activity", async () => {
		const { cookie, catalog, agent } = await setup();
		await runInDurableObject(agent, (instance) => {
			const harness = instance as unknown as {
				beginOwnerActivity(id: string, kind: string): void;
			};
			harness.beginOwnerActivity("chat:evicted", "chat");
		});
		await evictDurableObject(agent);
		await runInDurableObject(agent, (instance) => {
			const harness = instance as unknown as {
				eraseProjectData: () => Promise<void>;
				ctx: DurableObjectState;
			};
			harness.eraseProjectData = () => harness.ctx.storage.deleteAll();
		});

		expect((await request("DELETE", cookie)).status).toBe(200);
		expect(await catalog.listProjects()).toEqual([]);
	});

	it("deletes when eviction leaves stale preview recovery state", async () => {
		const { cookie, catalog, agent } = await setup();
		await runInDurableObject(agent, (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				status: "Restoring preview...",
				previewRestarting: true,
				initialGeneration: { id: "opening-brief", status: "building" },
			});
		});
		await evictDurableObject(agent);
		await runInDurableObject(agent, (instance) => {
			const harness = instance as unknown as {
				eraseProjectData: () => Promise<void>;
				ctx: DurableObjectState;
			};
			harness.eraseProjectData = () => harness.ctx.storage.deleteAll();
		});

		expect((await request("DELETE", cookie)).status).toBe(200);
		expect(await catalog.listProjects()).toEqual([]);
	});

	it("waits for an active build mutation before deleting the site", async () => {
		const { cookie, catalog, agent } = await setup();
		let finishMutation!: () => void;
		let mutationFinished = false;
		const erased = vi.fn();
		await runInDurableObject(agent, (instance) => {
			instance.setState({
				...instance.state,
				status: "Building site...",
				initialGeneration: { id: "opening-brief", status: "building" },
			});
			const convergence = new BuildConvergence();
			void convergence
				.runMutation(() => new Promise<void>((resolve) => (finishMutation = resolve)))
				.then(() => (mutationFinished = true));
			const harness = instance as unknown as {
				activeBuildConvergences: Map<string, BuildConvergence>;
				eraseProjectData: () => Promise<void>;
			};
			harness.activeBuildConvergences = new Map([["request-a", convergence]]);
			harness.eraseProjectData = async () => {
				expect(mutationFinished).toBe(true);
				erased();
			};
		});

		let deletionFinished = false;
		const deletion = request("DELETE", cookie).then((response) => {
			deletionFinished = true;
			return response;
		});
		await Promise.resolve();
		expect(deletionFinished).toBe(false);
		expect(erased).not.toHaveBeenCalled();

		finishMutation();
		expect((await deletion).status).toBe(200);
		expect(erased).toHaveBeenCalledOnce();
		expect(await catalog.listProjects()).toEqual([]);
	});

	it("keeps a failed cleanup available for retry", async () => {
		const { owner, cookie, catalog, agent } = await setup();
		let attempts = 0;
		await runInDurableObject(agent, (instance) => {
			const harness = instance as unknown as {
				eraseProjectData: () => Promise<void>;
				ctx: DurableObjectState;
			};
			harness.eraseProjectData = async () => {
				if (attempts++ === 0) throw new Error("Temporary cleanup error");
				await harness.ctx.storage.deleteAll();
			};
		});
		expect((await request("DELETE", cookie)).status).toBe(503);
		expect(await catalog.listProjects()).toHaveLength(1);
		expect((await request("PATCH", cookie, "Should not rename")).status).toBe(404);
		const pendingSession = await exports.default.fetch(
			new Request("http://localhost/api/project-session", {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json" },
				body: JSON.stringify({ projectId: id }),
			}),
		);
		expect(pendingSession.status).toBe(409);
		expect(await pendingSession.json()).toMatchObject({ code: "PROJECT_DELETION_PENDING" });
		expect((await request("DELETE", cookie)).status).toBe(200);
		expect(await catalog.listProjects()).toEqual([]);
		expect(attempts).toBe(2);
	});
});
