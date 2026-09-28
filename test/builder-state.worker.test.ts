import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { formatQuestionnaireResponse } from "../src/shared/questionnaire.js";
import type { BuilderAgent } from "../src/worker/agent.js";
import type { ProjectCatalog } from "../src/worker/project-catalog.js";

const testEnv = env as typeof env & {
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
	ProjectCatalog: DurableObjectNamespace<ProjectCatalog>;
};

describe("builder state", () => {
	beforeEach(async () => {
		await reset();
	});

	it("keeps builder state server-owned against client state updates", async () => {
		const guestKey = "state-writing-guest";
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000005");
		await agent.initializeOwnership(guestKey);
		await testEnv.ProjectCatalog.getByName(guestKey).registerProject(
			guestKey,
			{
				id: "22222222-2222-4222-8222-000000000005",
				title: "State",
				status: "draft" as const,
				updatedAt: 1,
			},
			10,
		);

		const result = await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, previewUrl: "https://preview.test" });
			const sent: string[] = [];
			const connection = {
				id: "owner-connection",
				state: { emdashAuth: { ownerKey: guestKey, kind: "guest" as const } },
				send(message: string) {
					sent.push(message);
				},
				close() {},
			} as unknown as Parameters<BuilderAgent["onMessage"]>[0];
			// upload_media sends the site's API token to previewUrl.
			await instance.onMessage(
				connection,
				JSON.stringify({
					type: "cf_agent_state",
					state: { ...instance.state, previewUrl: "https://attacker.test" },
				}),
			);
			return { previewUrl: instance.state.previewUrl, sent };
		});

		expect(result.previewUrl).toBe("https://preview.test");
		expect(result.sent.map((message) => JSON.parse(message).type)).toContain(
			"cf_agent_state_error",
		);
	});

	it("syncs authoritative history before resolving a reconnecting chat stream", async () => {
		const guestKey = "history-sync-guest";
		const projectId = "22222222-2222-4222-8222-000000000020";
		const agent = testEnv.BuilderAgent.getByName(projectId);
		await agent.initializeOwnership(guestKey);
		await testEnv.ProjectCatalog.getByName(guestKey).authorizeActiveGuest(guestKey);

		const result = await runInDurableObject(agent, async (instance) => {
			const opening = {
				id: "opening",
				role: "user" as const,
				parts: [{ type: "text" as const, text: "Build a portfolio" }],
			};
			const completed = {
				id: "completed",
				role: "assistant" as const,
				parts: [{ type: "text" as const, text: "The portfolio is ready." }],
			};
			instance.messages = [opening];
			const session = await instance.openProjectSession(guestKey);
			instance.messages = [opening, completed];
			const sent: Array<{ type?: string; messages?: unknown[] }> = [];
			const connection = {
				id: "reconnecting-client",
				state: { emdashAuth: { ownerKey: guestKey, kind: "guest" as const } },
				send(message: string) {
					sent.push(JSON.parse(message) as (typeof sent)[number]);
				},
				close() {},
			} as unknown as Parameters<BuilderAgent["onMessage"]>[0];
			await instance.onMessage(
				connection,
				JSON.stringify({ type: "cf_agent_stream_resume_request" }),
			);
			return {
				initialMessages: "initialMessages" in session ? session.initialMessages : [],
				syncedMessages: sent.find((message) => message.type === "cf_agent_chat_messages")?.messages,
			};
		});

		expect(result.initialMessages).toHaveLength(1);
		expect(result.syncedMessages).toMatchObject([{ id: "opening" }, { id: "completed" }]);
	});

	it("reports durable transcript and turn state for ambiguous client actions", async () => {
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000021");
		const recovered = await runInDurableObject(agent, async (instance) => {
			instance.messages = [
				{ id: "message-1", role: "user", parts: [{ type: "text", text: "Keep this" }] },
			];
			instance.setState({
				...instance.state,
				initialGeneration: { id: "message-1", status: "stopping" },
			});
			const internals = instance as unknown as {
				beginOwnerActivity(id: string, kind: string): void;
			};
			internals.beginOwnerActivity("chat:request-1", "chat");
			return instance.getClientRecoveryState();
		});

		expect(recovered).toMatchObject({
			messages: [{ id: "message-1" }],
			turnActive: true,
			initialGeneration: { id: "message-1", status: "stopping" },
		});
	});

	it("repairs blank-project ownership with the creation capability, then locks it", async () => {
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000022");
		const result = await runInDurableObject(agent, async (instance) => {
			const creationDigest = "cd".repeat(32);
			const first = await instance.initializeCreationOwnership("guest:first", creationDigest);
			const closed: string[] = [];
			const internals = instance as unknown as {
				getConnections: () => Array<{
					state: { emdashAuth: { ownerKey: string; kind: "guest" | "account" } };
					close(): void;
				}>;
			};
			internals.getConnections = () => [
				{
					state: { emdashAuth: { ownerKey: "guest:first", kind: "guest" } },
					close: () => closed.push("old-owner"),
				},
				{
					state: { emdashAuth: { ownerKey: "account:second", kind: "guest" } },
					close: () => closed.push("new-owner"),
				},
			];
			const wrongCapability = await instance.initializeCreationOwnership(
				"guest:stranger",
				"ef".repeat(32),
			);
			const rebound = await instance.initializeCreationOwnership("account:second", creationDigest);
			instance.messages = [
				{ id: "brief", role: "user", parts: [{ type: "text", text: "Anchor this site" }] },
			];
			const late = await instance.initializeCreationOwnership("guest:late", creationDigest);
			return {
				first,
				wrongCapability,
				rebound,
				late,
				firstAuthorized: await instance.authorizeProject("guest:first"),
				secondAuthorized: await instance.authorizeProject("account:second"),
				closed,
			};
		});

		expect(result).toEqual({
			first: true,
			wrongCapability: false,
			rebound: true,
			late: false,
			firstAuthorized: false,
			secondAuthorized: true,
			closed: ["old-owner"],
		});
	});

	it("records a turn that only the chat response ended, once and redacted", async () => {
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000006");
		const result = await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as {
				startTurnMetrics(
					requestId: string,
					init: { kind: "follow-up"; resumed: boolean; stepCap: number },
				): { noteError(error: unknown): void };
				onChatResponse(result: {
					requestId: string;
					status: "completed" | "error" | "aborted";
					continuation: boolean;
					message: { id: string; role: "assistant"; parts: [] };
				}): Promise<void>;
			};
			const metrics = internals.startTurnMetrics("request-1", {
				kind: "follow-up",
				resumed: false,
				stepCap: 256,
			});
			metrics.noteError(new Error("push failed for art_v1_0123abcd?expires=99"));
			const response = {
				requestId: "request-1",
				status: "completed" as const,
				continuation: false,
				message: { id: "reply-1", role: "assistant" as const, parts: [] as [] },
			};
			await internals.onChatResponse(response);
			const first = instance.state.lastTurnMetrics;
			// A second response for the same request records nothing new.
			instance.setState({ ...instance.state, lastTurnMetrics: undefined });
			await internals.onChatResponse(response);
			return { first, second: instance.state.lastTurnMetrics };
		});

		expect(result.first).toMatchObject({
			turnId: "request-1",
			kind: "follow-up",
			outcome: "error",
		});
		// Redacted with the shared Artifacts helper, whatever its placeholder.
		expect(result.first?.error).toMatch(/^push failed for art_\S*\*\*\*$/);
		expect(result.first?.error).not.toContain("0123abcd");
		expect(result.second).toBeUndefined();
	});

	it("broadcasts whether a chat turn is running, independent of the status line", async () => {
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000007");
		const result = await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as {
				beginOwnerActivity(id: string, kind: string): void;
				finishOwnerActivity(id: string): void;
				onChatResponse(result: {
					requestId: string;
					status: "completed" | "error" | "aborted";
					continuation: boolean;
					message: { id: string; role: "assistant"; parts: [] };
				}): Promise<void>;
				stateWrittenHere: boolean;
			};
			const seen: Array<boolean | undefined> = [];
			internals.beginOwnerActivity("resume-preview:1", "resume-preview");
			seen.push(instance.state.turnActive);
			internals.beginOwnerActivity("chat:request-1", "chat");
			seen.push(instance.state.turnActive);
			internals.finishOwnerActivity("resume-preview:1");
			seen.push(instance.state.turnActive);
			await internals.onChatResponse({
				requestId: "request-1",
				status: "aborted",
				continuation: false,
				message: { id: "reply-1", role: "assistant", parts: [] },
			});
			seen.push(instance.state.turnActive);

			// A flag left by an evicted instance describes a turn that no longer runs.
			instance.setState({ ...instance.state, turnActive: true });
			internals.stateWrittenHere = false;
			await instance.onStart();
			seen.push(instance.state.turnActive);
			return seen;
		});

		expect(result).toEqual([undefined, true, true, false, false]);
	});

	it("still resets an evicted instance's progress when recovery settles its turn first", async () => {
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000008");
		const state = await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as {
				beginOwnerActivity(id: string, kind: string): void;
				finishOwnerActivity(id: string): void;
				stateWrittenHere: boolean;
			};
			internals.beginOwnerActivity("chat:evicted", "chat");
			instance.setState({
				...instance.state,
				status: "Saving session...",
				previewRestarting: true,
				turnActive: true,
				initialGeneration: {
					id: "opening-brief",
					status: "stopping",
					terminalMessageId: "opening-brief",
				},
			});
			// A new instance: recovery skips the finished turn before onStart runs.
			internals.stateWrittenHere = false;
			internals.finishOwnerActivity("chat:evicted");
			await instance.onStart();
			return instance.state;
		});

		expect(state).toMatchObject({
			status: "",
			previewRestarting: false,
			turnActive: false,
			initialGeneration: { status: "stopped", terminalMessageId: "opening-brief" },
		});
	});

	it("reports when the site's brief was first saved as its creation time", async () => {
		const guestKey = "created-at-guest";
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000012");
		await agent.initializeOwnership(guestKey);
		const summary = await runInDurableObject(agent, async (instance) => {
			const brief = {
				id: "brief",
				role: "user" as const,
				parts: [{ type: "text" as const, text: "A journal" }],
			};
			instance.sql`INSERT INTO cf_ai_chat_agent_messages (id, message, created_at)
				VALUES ('brief', ${JSON.stringify(brief)}, '2026-01-02 03:04:05')`;
			instance.messages = [brief];
			return instance.getClaimableProjectSummary(guestKey);
		});
		expect(summary?.createdAt).toBe(Date.UTC(2026, 0, 2, 3, 4, 5));
	});

	it("tells the catalogue while the site is building, not while it waits for answers", async () => {
		const guestKey = "building-guest";
		const projectId = "22222222-2222-4222-8222-000000000013";
		const agent = testEnv.BuilderAgent.getByName(projectId);
		await agent.initializeOwnership(guestKey);
		const catalog = testEnv.ProjectCatalog.getByName(guestKey);
		await catalog.registerProject(guestKey, {
			id: projectId,
			title: "Site",
			status: "building",
			updatedAt: 1,
		});
		const building = async () => (await catalog.listProjects())[0]!.building;

		const step = (
			run: (internals: {
				beginOwnerActivity(id: string, kind: string): void;
				finishOwnerActivity(id: string): void;
				setInitialGenerationStatus(status: string): void;
				buildActivityChain: Promise<void>;
			}) => void,
		) =>
			runInDurableObject(agent, async (instance) => {
				const internals = instance as unknown as Parameters<typeof run>[0];
				run(internals);
				await internals.buildActivityChain;
			});

		await runInDurableObject(agent, (instance) => {
			instance.setState({
				...instance.state,
				initialGeneration: { id: "brief", status: "awaiting_answers" },
			});
		});
		await step((internals) => internals.beginOwnerActivity("provision:1", "provision"));
		expect(await building()).toBe(false);
		await step((internals) => internals.setInitialGenerationStatus("preparing"));
		expect(await building()).toBe(true);
		await step((internals) => internals.finishOwnerActivity("provision:1"));
		expect(await building()).toBe(false);
		await step((internals) => internals.beginOwnerActivity("chat:turn", "chat"));
		expect(await building()).toBe(true);
		await step((internals) => internals.finishOwnerActivity("chat:turn"));
		expect(await building()).toBe(false);

		// Evicted mid-turn: the renewal it left finds no live work, clears the
		// flag at once, and cancels itself.
		await step((internals) => internals.beginOwnerActivity("chat:evicted", "chat"));
		expect(await building()).toBe(true);
		await evictDurableObject(agent);
		const renewals = await runInDurableObject(agent, async (instance) => {
			await instance.renewBuildActivity();
			return (await instance.listSchedules()).filter(
				(schedule) => schedule.callback === "renewBuildActivity",
			).length;
		});
		expect(await building()).toBe(false);
		expect(renewals).toBe(0);
	});

	it("reports a new site as building once the catalogue knows it", async () => {
		const guestKey = "new-site-guest";
		const projectId = "22222222-2222-4222-8222-000000000014";
		const agent = testEnv.BuilderAgent.getByName(projectId);
		await agent.initializeOwnership(guestKey);
		const catalog = testEnv.ProjectCatalog.getByName(guestKey);
		await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as {
				beginOwnerActivity(id: string, kind: string): void;
				buildActivityChain: Promise<void>;
			};
			instance.messages = [
				{ id: "brief", role: "user", parts: [{ type: "text", text: "Build a journal" }] },
			];
			// The turn begins before registration adds the site's catalogue row.
			internals.beginOwnerActivity("chat:first", "chat");
			await internals.buildActivityChain;
			await instance.registerProjectForCurrentOwner();
			await internals.buildActivityChain;
		});
		expect(await catalog.listProjects()).toMatchObject([{ id: projectId, building: true }]);
	});

	it("renews from the work itself and stops counting work that looks hung", async () => {
		const guestKey = "renew-guest";
		const projectId = "22222222-2222-4222-8222-000000000015";
		const agent = testEnv.BuilderAgent.getByName(projectId);
		await agent.initializeOwnership(guestKey);
		const catalog = testEnv.ProjectCatalog.getByName(guestKey);
		await catalog.registerProject(guestKey, {
			id: projectId,
			title: "Site",
			status: "building",
			updatedAt: 1,
		});
		const lapse = () =>
			runInDurableObject(catalog, (_instance, state) => {
				state.storage.sql.exec("UPDATE projects SET active_until = ?", Date.now() - 1);
			});
		const building = async () => (await catalog.listProjects())[0]!.building;
		type Internals = {
			beginOwnerActivity(id: string, kind: string): void;
			touchBuildActivity(): void;
			sendStatus(status: string): void;
			sendConsole(text: string): void;
			buildActivityChain: Promise<void>;
			lastBuildReportAt: number;
			liveBuildWork: Map<string, { kind: string; startedAt: number }>;
		};
		const inside = (run: (internals: Internals) => void | Promise<void>) =>
			runInDurableObject(agent, async (instance) => {
				const internals = instance as unknown as Internals;
				await run(internals);
				await internals.buildActivityChain;
			});

		await inside((internals) => internals.beginOwnerActivity("chat:long", "chat"));
		// A turn resumed inside the alarm renews as it makes progress...
		await lapse();
		await inside((internals) => {
			internals.lastBuildReportAt = 0;
			internals.touchBuildActivity();
		});
		expect(await building()).toBe(true);
		// ...but at most once per renewal period.
		await lapse();
		await inside((internals) => internals.touchBuildActivity());
		expect(await building()).toBe(false);
		// Status lines and console output count as progress.
		for (const progress of ["sendStatus", "sendConsole"] as const) {
			await lapse();
			await inside((internals) => {
				internals.lastBuildReportAt = 0;
				internals[progress](`${progress} progress`);
			});
			expect(await building()).toBe(true);
		}

		// Work far older than any real turn stops counting, and its renewal ends.
		await catalog.setProjectActivity(guestKey, projectId, true);
		const renewals = await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as Internals;
			internals.liveBuildWork.set("chat:long", { kind: "chat", startedAt: 0 });
			await instance.renewBuildActivity();
			return (await instance.listSchedules()).filter(
				(schedule) => schedule.callback === "renewBuildActivity",
			).length;
		});
		expect(await building()).toBe(false);
		expect(renewals).toBe(0);
	});

	it("lets each step clear only its own progress line", async () => {
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000011");
		const seen = await runInDurableObject(agent, (instance) => {
			const internals = instance as unknown as {
				statusLine(): { set(status: string): void; clear(): void };
			};
			const first = internals.statusLine();
			const second = internals.statusLine();
			const states: Array<string | undefined> = [];
			first.set("Drafting (0/5)...");
			second.set("Drafting (0/3)...");
			first.clear();
			states.push(instance.state.status);
			second.set("Drafting (1/3)...");
			second.clear();
			states.push(instance.state.status);
			// A worker still settling after Stop cannot bring a cleared line back.
			second.set("Drafting (2/3)...");
			states.push(instance.state.status);
			return states;
		});

		expect(seen).toEqual(["Drafting (0/3)...", "", ""]);
	});

	it("releases the chat turn for a setup answer and for a turn that throws", async () => {
		const guestKey = "turn-release-guest";
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000009");
		await agent.initializeOwnership(guestKey);
		const result = await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as {
				provisionPromise: Promise<{ ready: boolean }> | null;
				ensureInitialGeneration(): unknown;
			};
			internals.provisionPromise = new Promise(() => {});
			const question = { question: "Which tone?", options: ["Editorial", "Playful"] };
			const answers = [{ question: question.question, selected: ["Editorial"], custom: "" }];
			instance.messages = [
				{ id: "brief", role: "user", parts: [{ type: "text", text: "Build a journal" }] },
				{
					id: "questions",
					role: "assistant",
					parts: [
						{
							type: "tool-ask_questions",
							toolCallId: "ask-1",
							state: "output-available",
							input: { questions: [question] },
							output: { ok: true },
						},
					],
				},
				{
					id: "answer",
					role: "user",
					metadata: { questionnaire: { toolCallId: "ask-1", answers } },
					parts: [{ type: "text", text: formatQuestionnaireResponse(answers) }],
				},
			];
			const answered = await instance.onChatMessage(async () => {}, { requestId: "answer-turn" });
			const afterAnswer = instance.state.turnActive;

			internals.ensureInitialGeneration = () => {
				throw new Error("storage failed");
			};
			const thrown = await instance
				.onChatMessage(async () => {}, { requestId: "throwing-turn" })
				.then(
					() => "resolved",
					(error: Error) => error.message,
				);
			const activity = instance.sql<{ id: string }>`SELECT id FROM owner_activity`.map(
				(row) => row.id,
			);
			return {
				body: answered.body,
				afterAnswer,
				thrown,
				afterThrow: instance.state.turnActive,
				activity,
			};
		});

		expect(result).toEqual({
			body: null,
			afterAnswer: false,
			thrown: "storage failed",
			afterThrow: false,
			activity: [],
		});
	});
});
