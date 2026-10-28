import {
	env,
	evictDurableObject,
	reset,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BuilderAgent, BuilderState } from "../src/worker/agent.js";
import type { ProjectCatalog } from "../src/worker/project-catalog.js";

const testEnv = env as typeof env & {
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
	ProjectCatalog: DurableObjectNamespace<ProjectCatalog>;
};

type ProvisionResult = { ready: boolean; stopped?: boolean; error?: string };

interface SetupHarness {
	createTurnModel(): unknown;
	provisionSite(hostname: string, signal?: AbortSignal): Promise<ProvisionResult>;
	provisionPromise: Promise<ProvisionResult> | null;
	saveMessages(
		update: (messages: UIMessage[]) => UIMessage[] | Promise<UIMessage[]>,
	): Promise<unknown>;
}

const brief: UIMessage = {
	id: "brief",
	role: "user",
	parts: [{ type: "text", text: "Build a bakery site" }],
};

/** An interview that asks nothing, so the build starts once setup is done. */
function interviewModel() {
	return new MockLanguageModelV3({
		doStream: async () => ({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					controller.enqueue({ type: "text-start", id: "reply" });
					controller.enqueue({ type: "text-delta", id: "reply", delta: "Setting it up now." });
					controller.enqueue({ type: "text-end", id: "reply" });
					controller.enqueue({
						type: "finish",
						finishReason: { unified: "stop", raw: "stop" },
						usage: {
							inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
							outputTokens: { total: 1, text: 1, reasoning: 0 },
						},
					});
					controller.close();
				},
			}),
		}),
	});
}

async function newProject(id: string) {
	const guestKey = `guest-${id}`;
	const agent = testEnv.BuilderAgent.getByName(id);
	await agent.initializeOwnership(guestKey);
	await testEnv.ProjectCatalog.getByName(guestKey).registerProject(
		guestKey,
		{ id, title: "Bakery", status: "building", updatedAt: 1 },
		10,
	);
	return agent;
}

/** Record what a new instance sets up and auto-starts, and hold setup until `finish`. */
function recordResumes(instance: BuilderAgent) {
	const harness = instance as unknown as SetupHarness;
	const resumed = {
		provisions: [] as string[],
		autoStarts: [] as string[][],
		finish: (_result: ProvisionResult) => {},
	};
	harness.provisionSite = (hostname) => {
		resumed.provisions.push(hostname);
		return new Promise((resolve) => (resumed.finish = resolve));
	};
	harness.saveMessages = async (update) => {
		const ids: string[] = [];
		resumed.autoStarts.push(ids);
		ids.push(...(await update(instance.messages)).map((message) => message.id));
		return { requestId: "auto-start", status: "completed" };
	};
	return resumed;
}

/** Save a project's brief and state, then drop its instance as a deploy or an eviction would. */
async function leaveProject(
	agent: DurableObjectStub<BuilderAgent>,
	state: Partial<BuilderState>,
	leave?: (instance: BuilderAgent) => void,
) {
	await runInDurableObject(agent, async (instance) => {
		await instance.persistMessages([brief]);
		instance.setState({ ...instance.state, ...state });
		leave?.(instance);
	});
	await evictDurableObject(agent);
}

/** Start a new instance over the saved project and record what it resumes. */
function restart(agent: DurableObjectStub<BuilderAgent>) {
	return runInDurableObject(agent, async (instance) => {
		const resumed = recordResumes(instance);
		await instance.onStart();
		return resumed;
	});
}

describe("setup interrupted by a restart", () => {
	beforeEach(async () => {
		await reset();
	});

	it("resumes setup and starts the first build on its own", async () => {
		const agent = await newProject("33333333-3333-4333-8333-000000000001");
		// The brief's turn starts setup, which is still waiting for a slot when the instance goes.
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as SetupHarness;
			harness.createTurnModel = interviewModel;
			harness.provisionSite = () => new Promise(() => {});
			instance.setState({ ...instance.state, appHost: "localhost:5173" });
			await instance.saveMessages([brief]);
			expect(instance.state.initialGeneration).toEqual({ id: "brief", status: "preparing" });
		});
		await evictDurableObject(agent);

		const resumed = await runInDurableObject(agent, (instance) => recordResumes(instance));
		// The new instance starts on the renewal alarm that setup left behind.
		expect(await runDurableObjectAlarm(agent)).toBe(true);
		expect(resumed.provisions).toEqual(["localhost:5173"]);
		expect(resumed.autoStarts).toEqual([]);

		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			resumed.finish({ ready: true });
			await (instance as unknown as SetupHarness).provisionPromise;
		});
		expect(resumed.autoStarts).toEqual([["brief", expect.any(String)]]);
	});

	it("stops the dev servers an interrupted setup left before extracting the new site", async () => {
		const agent = testEnv.BuilderAgent.getByName("33333333-3333-4333-8333-000000000005");
		const steps = await runInDurableObject(agent, async (instance) => {
			const steps: { step: string; cwd?: string }[] = [];
			const harness = instance as unknown as {
				waitForSandbox(): Promise<{ ok: boolean }>;
				sandboxOps(): unknown;
				provisionSite(hostname: string): Promise<ProvisionResult>;
			};
			harness.waitForSandbox = async () => ({ ok: true });
			harness.sandboxOps = () => ({
				exec: async (command: string, options?: { cwd?: string }) => {
					steps.push({ step: command, cwd: options?.cwd });
					// The new site's extraction fails, so setup ends there.
					const success = !command.startsWith("rm -rf");
					return { success, exitCode: success ? 0 : 1, stdout: "", stderr: "" };
				},
				stopProcess: async () => {},
				stopProcesses: async (prefix: string) => void steps.push({ step: `stop ${prefix}*` }),
			});
			await expect(harness.provisionSite("localhost:5173")).resolves.toMatchObject({
				ready: false,
			});
			return steps;
		});
		// This instance never started a dev server, so it must stop them by their ids' prefix.
		const stop = steps.findIndex(({ step }) => step === "stop dev-*");
		const extract = steps.findIndex(({ step }) => step.startsWith("rm -rf"));
		expect(stop).toBeGreaterThanOrEqual(0);
		expect(stop).toBeLessThan(extract);
		// Before extraction there may be no site directory to run in.
		expect(steps.find(({ step }) => step.includes("pkill"))?.cwd).toBeUndefined();
	});

	it("does not set up twice when a message arrives during resumed setup", async () => {
		const agent = await newProject("33333333-3333-4333-8333-000000000002");
		await leaveProject(agent, { initialGeneration: { id: "brief", status: "awaiting_answers" } });
		const resumed = await restart(agent);
		expect(resumed.provisions).toHaveLength(1);

		await runInDurableObject(agent, async (instance) => {
			(instance as unknown as SetupHarness).createTurnModel = interviewModel;
			await instance.persistMessages([
				...instance.messages,
				{ id: "more", role: "user", parts: [{ type: "text", text: "Add a menu page" }] },
			]);
			const turn = await instance.onChatMessage(async () => {}, { requestId: "more" });
			await turn.text();
			// PartyServer runs onStart again after one that threw.
			await instance.onStart();
		});
		expect(resumed.provisions).toHaveLength(1);
	});

	it.each<{
		id: string;
		left: string;
		state: Partial<BuilderState>;
		leave?: (instance: BuilderAgent) => void;
	}>([
		{
			id: "33333333-3333-4333-8333-000000000010",
			left: "a stopped first generation",
			state: { initialGeneration: { id: "brief", status: "stopped", terminalMessageId: "brief" } },
		},
		{
			id: "33333333-3333-4333-8333-000000000012",
			left: "a failed first generation",
			state: {
				provisionError: "Every build slot is still busy.",
				initialGeneration: { id: "brief", status: "failed", terminalMessageId: "brief" },
			},
		},
		{
			id: "33333333-3333-4333-8333-000000000013",
			left: "a site being deleted",
			state: { initialGeneration: { id: "brief", status: "preparing" } },
			leave: (instance) =>
				instance.sql`INSERT INTO builder_secrets (k, v) VALUES ('deleting', '1')`,
		},
		{
			id: "33333333-3333-4333-8333-000000000014",
			left: "a ready site waiting for answers",
			state: { siteReady: true, initialGeneration: { id: "brief", status: "awaiting_answers" } },
		},
		{
			id: "33333333-3333-4333-8333-000000000017",
			left: "a ready site whose first build already began",
			state: {
				siteReady: true,
				buildStarted: true,
				initialGeneration: { id: "brief", status: "preparing" },
			},
		},
		{
			id: "33333333-3333-4333-8333-000000000016",
			left: "an established site",
			state: {
				siteReady: true,
				buildStarted: true,
				initialGeneration: { id: "brief", status: "ready" },
			},
		},
	])("leaves $left alone", async ({ id, state, leave }) => {
		const agent = await newProject(id);
		await leaveProject(agent, state, leave);
		const resumed = await restart(agent);
		expect(resumed.provisions).toEqual([]);
		expect(resumed.autoStarts).toEqual([]);
	});

	it("starts the build of a site that was ready before it", async () => {
		const agent = await newProject("33333333-3333-4333-8333-000000000004");
		await leaveProject(agent, {
			siteReady: true,
			initialGeneration: { id: "brief", status: "preparing" },
		});
		const resumed = await restart(agent);
		expect(resumed.provisions).toEqual([]);
		expect(resumed.autoStarts).toEqual([["brief"]]);
	});

	it("starts the build of a ready site after a turn that finished", async () => {
		const agent = await newProject("33333333-3333-4333-8333-000000000007");
		const snapshot = JSON.stringify({ chatTurnFinished: true });
		await leaveProject(
			agent,
			{ siteReady: true, initialGeneration: { id: "brief", status: "preparing" } },
			(instance) => {
				// The turn was evicted while it saved its finished reply.
				instance.sql`INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
					VALUES ('turn-fiber', '__cf_internal_chat_turn:turn', ${snapshot}, ${Date.now()})`;
				instance.sql`INSERT INTO owner_activity (id, kind, started_at)
					VALUES ('chat:turn', 'chat', ${Date.now()})`;
			},
		);
		const resumed = await restart(agent);
		expect(resumed.autoStarts).toEqual([["brief"]]);
	});

	it("leaves the build of a ready site to a turn that chat recovery runs again", async () => {
		const agent = await newProject("33333333-3333-4333-8333-000000000006");
		await leaveProject(
			agent,
			{ siteReady: true, initialGeneration: { id: "brief", status: "preparing" } },
			(instance) => {
				// A turn was under way when the instance went.
				instance.sql`INSERT INTO cf_agents_runs (id, name, snapshot, created_at)
					VALUES ('turn-fiber', '__cf_internal_chat_turn:turn', NULL, ${Date.now()})`;
				instance.sql`INSERT INTO owner_activity (id, kind, started_at)
					VALUES ('chat:turn', 'chat', ${Date.now()})`;
			},
		);
		const outcome = await runInDurableObject(agent, async (instance) => {
			const resumed = recordResumes(instance);
			await instance.onStart();
			return {
				autoStarts: [...resumed.autoStarts],
				recovery: instance.getSchedules().map(({ callback }) => callback),
			};
		});
		expect(outcome).toEqual({ autoStarts: [], recovery: ["restartInterruptedTurn"] });
	});
});
