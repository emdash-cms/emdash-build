import {
	env,
	evictDurableObject,
	reset,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRecoveryContext, ChatRecoveryOptions } from "@cloudflare/ai-chat";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { BuilderAgent } from "../src/worker/agent.js";
import { markChatTurnFinished, planChatRecovery } from "../src/worker/turn-gate.js";
import { TurnMetrics } from "../src/worker/turn-metrics.js";

const testEnv = env as typeof env & {
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
};

interface RecoveryHarness {
	onChatRecovery(ctx: Partial<ChatRecoveryContext>): Promise<ChatRecoveryOptions>;
	restartInterruptedTurn(payload: {
		afterMessageId: string | null;
		pastGate?: boolean;
		giveUp?: boolean;
	}): Promise<void>;
	interruptedTurnRestart?: { pastGate: boolean } | { giveUp: "error" | "superseded" };
	saveMessages(update: (messages: UIMessage[]) => UIMessage[]): Promise<unknown>;
	registerProjectForCurrentOwner(): Promise<void>;
	waitUntilStable(options: { timeout: number }): Promise<boolean>;
}

interface RecoveredBuildHarness extends RecoveryHarness {
	_chatRecoveryContinue(data?: { targetAssistantId?: string }): Promise<void>;
	backupSite(): Promise<string | undefined>;
	createTurnModel(): unknown;
	getMcpServers(): unknown;
	loadTemplateGuidance(): Promise<string | undefined>;
	provisionSite(): Promise<{ ready: boolean }>;
}

/** An established site whose edit was under way when the instance went. */
async function leaveEditUnderWay(instance: BuilderAgent, partial?: UIMessage) {
	await instance.persistMessages([
		{ id: "brief", role: "user", parts: [{ type: "text", text: "Build a bakery site" }] },
		{ id: "built", role: "assistant", parts: [{ type: "text", text: "Built the site." }] },
		{ id: "edit", role: "user", parts: [{ type: "text", text: "Add an events page" }] },
		...(partial ? [partial] : []),
	]);
	instance.setState({
		...instance.state,
		siteReady: true,
		buildStarted: true,
		complete: true,
		initialGeneration: { id: "brief", status: "ready" },
	});
}

/** Reports the tools each model call offers, and replies with text. */
function replyModel(onCall: (toolNames: string[]) => void) {
	return new MockLanguageModelV3({
		doStream: async ({ tools }) => {
			onCall((tools ?? []).map((tool) => tool.name));
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						controller.enqueue({ type: "text-start", id: "reply" });
						controller.enqueue({ type: "text-delta", id: "reply", delta: "Added the page." });
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
			};
		},
	});
}

describe("chat recovery", () => {
	beforeEach(async () => {
		await reset();
	});

	it("checkpoints a finished reply from the stream's finish callback", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000003");
		await runInDurableObject(agent, async (instance) => {
			let snapshot: string | null = null;
			await instance.runFiber("__cf_internal_chat_turn:req-1", async () => {
				// streamText runs onFinish in a transform flush while the reply is read.
				const reply = new ReadableStream({
					start(controller) {
						controller.enqueue("done");
						controller.close();
					},
				}).pipeThrough(
					new TransformStream({
						flush: async () => {
							await Promise.resolve();
							markChatTurnFinished(instance);
						},
					}),
				);
				for await (const _chunk of reply) {
					// drain
				}
				snapshot = instance.sql<{ snapshot: string | null }>`
					SELECT snapshot FROM cf_agents_runs WHERE name = ${"__cf_internal_chat_turn:req-1"}
				`[0]!.snapshot;
			});

			const harness = instance as unknown as RecoveryHarness;
			expect(
				await harness.onChatRecovery({ recoveryData: JSON.parse(snapshot!), partialParts: [] }),
			).toEqual({ continue: false });
			expect(
				await harness.onChatRecovery({
					recoveryData: null,
					partialParts: [{ type: "text", text: "Building" }],
				}),
			).toEqual({});
		});
	});

	it("records a finished turn once, even when eviction interrupts its final save", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-00000000000b");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveryHarness & {
				backupSite(): Promise<string | undefined>;
				saveAndRecordTurn(metrics: TurnMetrics): Promise<void>;
			};
			const logged: Array<{ turnId: string; outcome: string; finalSaveMs: number | null }> = [];
			const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
				if (typeof line === "string" && line.includes('"builder.turn_metrics"')) {
					logged.push(JSON.parse(line));
				}
			});
			const newTurn = (turnId: string) => {
				const metrics = new TurnMetrics({
					turnId,
					kind: "follow-up",
					resumed: false,
					model: "test-model",
					stepCap: 256,
				});
				metrics.modelFinished("stop");
				return metrics;
			};
			const stashOf = async (turnId: string, run: () => Promise<void>) => {
				const fiber = `__cf_internal_chat_turn:${turnId}`;
				let snapshot: string | null = null;
				await instance.runFiber(fiber, async () => {
					await run().catch(() => {});
					snapshot = instance.sql<{ snapshot: string | null }>`
						SELECT snapshot FROM cf_agents_runs WHERE name = ${fiber}
					`[0]!.snapshot;
				});
				return JSON.parse(snapshot!);
			};

			try {
				// Evicted during the backup: only the stash survives, and recovery logs
				// it without writing state (onStart still resets stale progress).
				const evicted = newTurn("req-evicted");
				const stash = await stashOf("req-evicted", async () => {
					markChatTurnFinished(instance, evicted.pendingRecord());
				});
				expect(await harness.onChatRecovery({ recoveryData: stash, partialParts: [] })).toEqual({
					continue: false,
				});
				expect(logged).toMatchObject([
					{ turnId: "req-evicted", outcome: "finished", finalSaveMs: null },
				]);
				expect(instance.state.lastTurnMetrics).toBeUndefined();

				// Recorded after a failed backup; the stash no longer carries a copy.
				harness.backupSite = async () => "git push failed";
				const saved = newTurn("req-saved");
				const cleared = await stashOf("req-saved", async () => {
					markChatTurnFinished(instance, saved.pendingRecord());
					await harness.saveAndRecordTurn(saved);
				});
				expect(instance.state.lastTurnMetrics).toMatchObject({
					turnId: "req-saved",
					outcome: "error",
					error: "Session backup failed: git push failed",
					finalSaveMs: expect.any(Number),
				});
				expect(cleared).toEqual({ chatTurnFinished: true });
				await harness.onChatRecovery({ recoveryData: cleared, partialParts: [] });
				expect(logged.map((record) => record.turnId)).toEqual(["req-evicted", "req-saved"]);
			} finally {
				log.mockRestore();
			}
		});
	});

	it.each([
		{ how: "fails in place", id: "11111111-1111-4111-8111-000000000010", inPlace: true },
		{
			how: "is cut off by an eviction",
			id: "11111111-1111-4111-8111-0000000000f2",
			inPlace: false,
		},
	])(
		"leaves the first build to the restart it scheduled when its stream $how",
		async ({ id, inPlace }) => {
			const agent = testEnv.BuilderAgent.getByName(id);
			const statuses = await runInDurableObject(agent, async (instance) => {
				await instance.lifecycle.start();
				const harness = instance as unknown as RecoveryHarness & {
					activeInitialRequestId?: string;
					openTurnMetrics: Map<string, TurnMetrics>;
					onChatResponse(result: Record<string, unknown>): Promise<void>;
				};
				// A turn this instance runs is in place; one an eviction cut off ran on another.
				if (inPlace) {
					harness.openTurnMetrics.set(
						"streamed-nothing",
						new TurnMetrics({
							turnId: "streamed-nothing",
							kind: "initial-build",
							resumed: false,
							model: "test",
							stepCap: 1,
						}),
					);
				}
				const fail = async (requestId: string) => {
					instance.setState({
						...instance.state,
						siteReady: true,
						initialGeneration: { id: "brief", status: "building" },
					});
					harness.activeInitialRequestId = requestId;
					await harness.onChatResponse({
						requestId,
						status: "error",
						continuation: false,
						message: { id: `reply-${requestId}`, role: "assistant", parts: [] },
					});
					return instance.state.initialGeneration?.status;
				};
				// A transient read error mid-stream: recovery restarts the turn in place,
				// and the chat SDK ends the interrupted request with an error.
				await harness.onChatRecovery({
					requestId: "streamed-nothing",
					recoveryData: { chatTurnStarted: true },
					partialParts: [],
					messages: [],
				});
				const counted = instance.sql<{ in_place: number; wake: number }>`
					SELECT in_place, wake FROM builder_turn_restarts
				`;
				const restarted = await fail("streamed-nothing");
				const failed = await fail("plain-error");
				return { counted, restarted, failed };
			});
			expect(statuses).toEqual({
				counted: [inPlace ? { in_place: 1, wake: 0 } : { in_place: 0, wake: 1 }],
				restarted: "building",
				failed: "failed",
			});
		},
	);

	it("does not wait on a server tool orphaned by eviction", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000004");
		await runInDurableObject(agent, async (instance) => {
			instance.messages = [
				{ id: "user-1", role: "user", parts: [{ type: "text", text: "Build a bakery site" }] },
				{
					id: "assistant-1",
					role: "assistant",
					parts: [
						{
							type: "tool-write_file",
							toolCallId: "write-1",
							state: "input-available",
							input: { path: "src/pages/index.astro", content: "" },
						},
					],
				},
			];

			const harness = instance as unknown as RecoveryHarness;
			expect(await harness.waitUntilStable({ timeout: 50 })).toBe(true);
		});
	});

	it("restarts a turn evicted before it streamed as a fresh reply", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000007");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveryHarness;

			const messages: UIMessage[] = [
				{ id: "user-1", role: "user", parts: [{ type: "text", text: "Build a bakery site" }] },
			];

			expect(
				await harness.onChatRecovery({
					recoveryData: { chatTurnStarted: true },
					partialParts: [],
					messages,
				}),
			).toEqual({ continue: false });
			expect(
				instance.getSchedules().map(({ callback, payload }) => ({ callback, payload })),
			).toEqual([
				{
					callback: "restartInterruptedTurn",
					payload: { afterMessageId: "user-1", pastGate: true },
				},
			]);
		});
	});

	it("re-gates a turn evicted before it passed the gate", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000009");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveryHarness;
			const reply: UIMessage = {
				id: "assistant-build",
				role: "assistant",
				parts: [{ type: "text", text: "Built the site" }],
			};
			await harness.onChatRecovery({ recoveryData: null, partialParts: [], messages: [reply] });
			expect(instance.getSchedules().map(({ payload }) => payload)).toEqual([
				{ afterMessageId: "assistant-build", pastGate: false },
			]);

			let restarting: unknown;
			instance.messages = [reply];
			harness.saveMessages = async (update) => {
				update([reply]);
				restarting = harness.interruptedTurnRestart;
			};
			await harness.restartInterruptedTurn({ afterMessageId: "assistant-build", pastGate: false });
			expect(restarting).toEqual({ pastGate: false });
		});
	});

	it("marks a resumed turn as past the gate before it does anything else", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-00000000000a");
		await agent.initializeOwnership("recovery-guest");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveryHarness;
			harness.registerProjectForCurrentOwner = async () => {
				throw new Error("evicted mid-call");
			};
			harness.interruptedTurnRestart = { pastGate: true };
			const fiber = "__cf_internal_chat_turn:req-resume";
			await instance.runFiber(fiber, async () => {
				await instance.onChatMessage(async () => {}, { requestId: "req-resume" });
				const snapshot = instance.sql<{ snapshot: string | null }>`
					SELECT snapshot FROM cf_agents_runs WHERE name = ${fiber}
				`[0]!.snapshot;
				expect(JSON.parse(snapshot!)).toEqual({ chatTurnStarted: true });
			});
		});
	});

	it("ends a restart's scheduled job once its turn starts, so an eviction mid-turn cannot run it again", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-0000000000f1");
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await runInDurableObject(agent, async (instance) => {
			await instance.lifecycle.start();
			const harness = instance as unknown as RecoveryHarness;
			instance.messages = [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Hi" }] }];
			harness.saveMessages = async (update) => {
				update(instance.messages);
				await held;
			};
			await instance.schedule(0, "restartInterruptedTurn", {
				afterMessageId: "user-1",
				pastGate: true,
			});
		});

		// The job's callback returns while the turn it started still runs, so its row is gone.
		const alarm = await Promise.race([
			runDurableObjectAlarm(agent),
			new Promise((resolve) => setTimeout(() => resolve("still in the job"), 2_000)),
		]);
		try {
			expect(alarm).toBe(true);
			await runInDurableObject(agent, (instance) => {
				const restarts = instance
					.getSchedules()
					.filter(({ callback }) => callback === "restartInterruptedTurn");
				expect(restarts).toEqual([]);
				expect((instance as unknown as RecoveryHarness).interruptedTurnRestart).toEqual({
					pastGate: true,
				});
			});
		} finally {
			release();
		}
	});

	it("leaves a later restart's word for its turn when an earlier restart's turn ends", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-0000000000f3");
		await runInDurableObject(agent, async (instance) => {
			await instance.lifecycle.start();
			const harness = instance as unknown as RecoveryHarness;
			const user: UIMessage = { id: "user-1", role: "user", parts: [{ type: "text", text: "Hi" }] };
			instance.messages = [user];
			const releases: (() => void)[] = [];
			// Each mock turn starts, then holds until released, never taking what its restart set.
			harness.saveMessages = async (update) => {
				update([user]);
				await new Promise<void>((resolve) => releases.push(resolve));
			};
			await harness.restartInterruptedTurn({ afterMessageId: "user-1", pastGate: true });
			await harness.restartInterruptedTurn({ afterMessageId: "user-1", giveUp: true });

			releases[0]!();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(harness.interruptedTurnRestart).toEqual({ giveUp: "error" });
			releases[1]!();
			await vi.waitFor(() => expect(harness.interruptedTurnRestart).toBeUndefined());
		});
	});

	it("resumes a restarted turn only while the conversation is where it stopped", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000008");
		await runInDurableObject(agent, async (instance) => {
			// Started first, so the transcript it loads does not replace the one set below.
			await instance.lifecycle.start();
			const harness = instance as unknown as RecoveryHarness;
			const user: UIMessage = { id: "user-1", role: "user", parts: [{ type: "text", text: "Hi" }] };
			const later: UIMessage = {
				id: "assistant-2",
				role: "assistant",
				parts: [{ type: "text", text: "Answered a newer message" }],
			};
			const observed: unknown[] = [];
			const restartWith = async (current: UIMessage[], atTurnStart: UIMessage[]) => {
				instance.messages = current;
				harness.saveMessages = async (update) => {
					update(atTurnStart);
					observed.push(harness.interruptedTurnRestart);
				};
				await harness.restartInterruptedTurn({ afterMessageId: "user-1", pastGate: true });
			};

			await restartWith([user], [user]);
			// A newer turn got in between enqueueing and running.
			await restartWith([user], [user, later]);
			// Already superseded: nothing is enqueued.
			await restartWith([user, later], [user, later]);

			expect(observed).toEqual([{ pastGate: true }, { pastGate: false }]);
			// Neither mock turn took what its restart set; each restart cleared its own.
			await vi.waitFor(() => expect(harness.interruptedTurnRestart).toBeUndefined());
		});
	});

	it.each<{
		plan: string;
		id: string;
		partial?: UIMessage;
		recover(harness: RecoveredBuildHarness): Promise<void>;
	}>([
		{
			plan: "restart",
			id: "11111111-1111-4111-8111-00000000000c",
			recover: (harness) =>
				harness.restartInterruptedTurn({ afterMessageId: "edit", pastGate: true }),
		},
		{
			plan: "continue",
			id: "11111111-1111-4111-8111-00000000000e",
			partial: {
				id: "partial",
				role: "assistant",
				parts: [{ type: "text", text: "Adding an events page." }],
			},
			recover: (harness) => harness._chatRecoveryContinue({ targetAssistantId: "partial" }),
		},
	])(
		"waits for MCP to reconnect before a recovered build reads its tools: $plan",
		async ({ id, partial, recover }) => {
			const agent = testEnv.BuilderAgent.getByName(id);
			await agent.initializeOwnership(`guest-${id}`);
			const steps = await runInDurableObject(agent, async (instance) => {
				const harness = instance as unknown as RecoveredBuildHarness;
				await leaveEditUnderWay(instance, partial);
				const steps: unknown[] = [];
				// The container is warm, so recovery leaves the saved CMS connection to its
				// background reconnect, which is still under way.
				harness.provisionSite = async () => {
					steps.push("recover the site");
					return { ready: true };
				};
				let reconnected = false;
				(
					instance.mcp as { waitForConnections(options?: unknown): Promise<void> }
				).waitForConnections = async (options) => {
					steps.push(["wait for MCP", options]);
					await new Promise((resolve) => setTimeout(resolve, 10));
					reconnected = true;
				};
				const cmsTool = { name: "schema_list_collections", inputSchema: { type: "object" } };
				harness.getMcpServers = () => ({
					prompts: [],
					resources: [],
					servers: {},
					tools: reconnected ? [cmsTool] : [],
				});
				harness.loadTemplateGuidance = async () => undefined;
				harness.backupSite = async () => undefined;
				harness.createTurnModel = () => replyModel((tools) => steps.push(["build with", tools]));

				await recover(harness);
				// Recovery hands its continuation to a turn of its own; wait for it to finish.
				await harness.waitUntilStable({ timeout: 10_000 });
				return steps;
			});

			// The wait comes after recovery, which reconnects MCP itself on a cold site.
			expect(steps).toEqual([
				"recover the site",
				["wait for MCP", { timeout: 20_000 }],
				["build with", expect.arrayContaining(["schema_list_collections"])],
			]);
		},
	);

	it("ends a build stopped while it waits for MCP, before it builds its tools", async () => {
		const id = "11111111-1111-4111-8111-00000000000f";
		const agent = testEnv.BuilderAgent.getByName(id);
		await agent.initializeOwnership(`guest-${id}`);
		const outcome = await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveredBuildHarness;
			await leaveEditUnderWay(instance);
			const steps: string[] = [];
			const stop = new AbortController();
			harness.provisionSite = async () => {
				steps.push("recover the site");
				return { ready: true };
			};
			// The reconnect hangs, and the user stops the turn while it waits.
			(
				instance.mcp as { waitForConnections(options?: unknown): Promise<void> }
			).waitForConnections = () => {
				steps.push("wait for MCP");
				setTimeout(() => stop.abort(), 0);
				return new Promise<void>(() => {});
			};
			harness.getMcpServers = () => {
				steps.push("read the CMS tools");
				return { prompts: [], resources: [], servers: {}, tools: [] };
			};
			harness.createTurnModel = () => {
				steps.push("call the model");
				return replyModel(() => {});
			};

			const reply = await instance.onChatMessage(async () => {}, {
				requestId: "stopped-edit",
				abortSignal: stop.signal,
			});
			return { steps, reply: await reply.text() };
		});

		expect(outcome).toEqual({ steps: ["recover the site", "wait for MCP"], reply: "" });
	});
});

describe("chat recovery the chat SDK settles itself", () => {
	beforeEach(async () => {
		await reset();
	});

	type SettledHarness = RecoveryHarness & {
		activeInitialRequestId?: string;
		onChatResponse(result: Record<string, unknown>): Promise<void>;
		beginOwnerActivity(id: string, kind: string): void;
		chatRecovery: { onExhausted?(ctx: Record<string, unknown>): Promise<void> | void };
		openTurnMetrics: Map<string, TurnMetrics>;
		startedBuildOnStart: boolean;
		autoStartPending: boolean;
		provisionController?: AbortController;
	};
	const turnOf = (requestId: string, kind: "interview" | "initial-build" | "follow-up") =>
		new TurnMetrics({ turnId: requestId, kind, resumed: false, model: "test", stepCap: 1 });
	const exhausted = (requestId: string) => ({
		requestId,
		recoveryRootRequestId: requestId,
		reason: "no_progress_timeout",
		terminalMessage: "The response was interrupted.",
	});
	const brief: UIMessage = {
		id: "brief",
		role: "user",
		parts: [{ type: "text", text: "A bakery" }],
	};

	/** A first build under way, as its turn left it. */
	async function building(instance: BuilderAgent) {
		await instance.lifecycle.start();
		instance.setState({
			...instance.state,
			siteReady: true,
			buildStarted: true,
			initialGeneration: { id: "brief", status: "building" },
		});
		return instance as unknown as SettledHarness;
	}
	const respond = (harness: SettledHarness, requestId: string, status: string) => {
		harness.activeInitialRequestId = requestId;
		return harness.onChatResponse({
			requestId,
			status,
			continuation: false,
			message: { id: `reply-${requestId}`, role: "assistant", parts: [] },
		});
	};

	it("keeps building when recovery continues a stream that failed in place", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000051");
		const status = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			expect(
				await harness.onChatRecovery({
					requestId: "streamed-some",
					recoveryData: { chatTurnStarted: true },
					partialParts: [{ type: "text", text: "Adding the menu" }],
					messages: [brief],
				}),
			).toEqual({});
			// The chat SDK ends the interrupted request as aborted and continues it.
			await respond(harness, "streamed-some", "aborted");
			return instance.state.initialGeneration?.status;
		});
		expect(status).toBe("building");
	});

	it("does not fail a reply that finished before its stream failed", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000052");
		const status = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			expect(
				await harness.onChatRecovery({
					requestId: "finished",
					recoveryData: { chatTurnFinished: true },
					partialParts: [],
					messages: [brief],
				}),
			).toEqual({ continue: false });
			await respond(harness, "finished", "error");
			return instance.state.initialGeneration?.status;
		});
		expect(status).toBe("building");
	});

	it("stops restarting a turn whose stream keeps failing in place", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000053");
		const statuses = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			const seen: Array<string | undefined> = [];
			for (const requestId of ["attempt-1", "attempt-2", "attempt-3"]) {
				harness.openTurnMetrics.set(requestId, turnOf(requestId, "initial-build"));
				await harness.onChatRecovery({
					requestId,
					recoveryData: { chatTurnStarted: true },
					partialParts: [],
					messages: [brief],
				});
				await respond(harness, requestId, "error");
				seen.push(instance.state.initialGeneration?.status);
			}
			return seen;
		});
		expect(statuses).toEqual(["building", "building", "failed"]);
	});

	it("continues a follow-up it started after onStart started the first build", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000056");
		const options = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			harness.startedBuildOnStart = true;
			harness.openTurnMetrics.set("follow-up", turnOf("follow-up", "follow-up"));
			return harness.onChatRecovery({
				requestId: "follow-up",
				recoveryData: { chatTurnStarted: true },
				partialParts: [{ type: "text", text: "Adding the events page" }],
				messages: [brief],
			});
		});
		expect(options).toEqual({});
	});

	it.each([
		{ kind: "initial-build" as const, status: "failed" },
		{ kind: "interview" as const, status: "preparing" },
	])(
		"ends the $kind turn recovery gave up on in place as an error, not a Stop",
		async ({ kind, status }) => {
			const id = kind === "interview" ? "000000000058" : "000000000057";
			const agent = testEnv.BuilderAgent.getByName(`11111111-1111-4111-8111-${id}`);
			const outcome = await runInDurableObject(agent, async (instance) => {
				const harness = await building(instance);
				if (kind === "interview") {
					instance.setState({
						...instance.state,
						siteReady: false,
						buildStarted: false,
						initialGeneration: { id: "brief", status: "preparing" },
					});
				}
				const setup = new AbortController();
				harness.provisionController = setup;
				harness.beginOwnerActivity("chat:in-place", "chat");
				harness.openTurnMetrics.set("in-place", turnOf("in-place", kind));
				await harness.chatRecovery.onExhausted?.(exhausted("in-place"));
				// The chat SDK then ends the request it gave up on as aborted.
				await respond(harness, "in-place", "aborted");
				return {
					status: instance.state.initialGeneration?.status,
					setupAborted: setup.signal.aborted,
				};
			});
			expect(outcome).toEqual({ status, setupAborted: false });
		},
	);

	it("leaves setup to resume when recovery gives up on a turn before the build", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000059");
		const status = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			instance.setState({
				...instance.state,
				siteReady: false,
				buildStarted: false,
				initialGeneration: { id: "brief", status: "preparing" },
			});
			instance.sql`INSERT INTO owner_activity (id, kind, started_at)
				VALUES ('chat:interview', 'chat', ${Date.now()})`;
			await harness.chatRecovery.onExhausted?.(exhausted("interview"));
			return instance.state.initialGeneration?.status;
		});
		expect(status).toBe("preparing");
	});

	it.each([
		{ pending: true, status: "building" },
		{ pending: false, status: "failed" },
	])(
		"leaves the first build onStart started to settle the generation while it runs (running: $pending)",
		async ({ pending, status }) => {
			const id = pending ? "00000000005a" : "00000000005b";
			const agent = testEnv.BuilderAgent.getByName(`11111111-1111-4111-8111-${id}`);
			const after = await runInDurableObject(agent, async (instance) => {
				const harness = await building(instance);
				harness.startedBuildOnStart = true;
				harness.autoStartPending = pending;
				await harness.chatRecovery.onExhausted?.(exhausted("interview"));
				return instance.state.initialGeneration?.status;
			});
			expect(after).toBe(status);
		},
	);

	it("fails a first build recovery gave up on before it began to stream", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-00000000005c");
		const status = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			// The build marks itself started only just before it streams.
			instance.setState({ ...instance.state, buildStarted: false });
			await harness.chatRecovery.onExhausted?.(exhausted("restoring"));
			return instance.state.initialGeneration?.status;
		});
		expect(status).toBe("failed");
	});

	it.each([
		{ site: "a first build", id: "00000000005e", status: "building", settled: "failed" },
		{ site: "a follow-up on a ready site", id: "00000000005f", status: "ready", settled: "ready" },
	])(
		"ends $site that evictions keep interrupting before it streams with an error",
		async ({ id, status, settled }) => {
			const agent = testEnv.BuilderAgent.getByName(`11111111-1111-4111-8111-${id}`);
			const last = await runInDurableObject(agent, async (instance) => {
				if (status === "building") {
					await building(instance);
					await instance.persistMessages([brief]);
				} else {
					await instance.lifecycle.start();
					await leaveEditUnderWay(instance);
				}
				return instance.messages.at(-1)!.id;
			});
			const recoverAfterEviction = async (requestId: string) => {
				// Each restart is a new request, recovered by a new instance.
				await evictDurableObject(agent);
				return runInDurableObject(agent, async (instance) => {
					const harness = instance as unknown as SettledHarness;
					await instance.lifecycle.start();
					// The instance that ran the attempt is gone; only its row is left.
					instance.sql`INSERT OR IGNORE INTO owner_activity (id, kind, started_at)
						VALUES (${`chat:${requestId}`}, 'chat', ${Date.now()})`;
					const options = await harness.onChatRecovery({
						requestId,
						recoveryData: { chatTurnStarted: true },
						partialParts: [],
						messages: [...instance.messages],
					});
					const scheduled = instance
						.getSchedules()
						.filter(({ callback }) => callback === "restartInterruptedTurn");
					return {
						options,
						scheduled: scheduled.map(({ payload }) => payload),
						status: instance.state.initialGeneration?.status,
					};
				});
			};
			const cancelSchedules = () =>
				runInDurableObject(agent, async (instance) => {
					for (const { id } of instance.getSchedules()) await instance.cancelSchedule(id);
				});

			const restarted = {
				options: { continue: false },
				scheduled: [{ afterMessageId: last, pastGate: true }],
				status,
			};
			for (let attempt = 1; attempt <= 4; attempt++) {
				expect(await recoverAfterEviction(`attempt-${attempt}`)).toEqual(restarted);
				await cancelSchedules();
			}
			// Recovered again after the instance went mid-recovery: the same attempt.
			expect(await recoverAfterEviction("attempt-4")).toEqual(restarted);
			await cancelSchedules();
			// Five attempts in all, as the chat SDK allows a turn it recovers itself.
			const givenUp = {
				options: { continue: false },
				scheduled: [{ afterMessageId: last, giveUp: true }],
				status,
			};
			expect(await recoverAfterEviction("attempt-5")).toEqual(givenUp);
			expect(await recoverAfterEviction("attempt-5")).toEqual(givenUp);
			await cancelSchedules();

			// The turn the give-up enqueues ends it with the error, and calls no model.
			const outcome = await runInDurableObject(agent, async (instance) => {
				const harness = instance as unknown as RecoveredBuildHarness & SettledHarness;
				harness.createTurnModel = () => {
					throw new Error("A given-up turn must not call the model.");
				};
				const ended: unknown[] = [];
				const respond = harness.onChatResponse.bind(instance);
				harness.onChatResponse = async (result) => {
					ended.push(result.status);
					return respond(result);
				};
				const sent: string[] = [];
				const broadcast = instance.broadcast.bind(instance);
				instance.broadcast = (message, without) => {
					sent.push(String(message));
					return broadcast(message, without);
				};
				await harness.restartInterruptedTurn({ afterMessageId: last, giveUp: true });
				await harness.waitUntilStable({ timeout: 10_000 });
				return {
					ended,
					error: sent.some((message) => message.includes("interrupted too many times")),
					status: instance.state.initialGeneration?.status,
					rows: instance.sql<{ id: string }>`SELECT id FROM owner_activity WHERE kind = 'chat'`.map(
						(row) => row.id,
					),
					counts: instance.sql<{ n: number }>`SELECT COUNT(*) AS n FROM builder_turn_restarts`[0]
						?.n,
				};
			});
			// The owner's retry of the same message then gets a full budget of its own.
			expect(outcome).toEqual({
				ended: ["error"],
				error: true,
				status: settled,
				rows: [],
				counts: 0,
			});
		},
	);

	it.each([
		{ why: "the owner stopped the build", id: "000000000061", stopped: true },
		{ why: "the build onStart started answers it", id: "000000000062", stopped: false },
	])("ends a given-up turn with nothing when $why", async ({ id, stopped }) => {
		const agent = testEnv.BuilderAgent.getByName(`11111111-1111-4111-8111-${id}`);
		const outcome = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			await instance.persistMessages([brief]);
			if (stopped) {
				instance.setState({
					...instance.state,
					initialGeneration: { id: "brief", status: "stopped", terminalMessageId: "brief" },
				});
			} else {
				harness.autoStartPending = true;
			}
			const ended: unknown[] = [];
			const respond = harness.onChatResponse.bind(instance);
			harness.onChatResponse = async (result) => {
				ended.push(result.status);
				return respond(result);
			};
			const sent: string[] = [];
			const broadcast = instance.broadcast.bind(instance);
			instance.broadcast = (message, without) => {
				sent.push(String(message));
				return broadcast(message, without);
			};
			await harness.restartInterruptedTurn({ afterMessageId: "brief", giveUp: true });
			await harness.waitUntilStable({ timeout: 10_000 });
			return {
				ended,
				error: sent.some((message) => message.includes("interrupted too many times")),
				status: instance.state.initialGeneration?.status,
			};
		});
		// No reply at all, as for a Stop before a turn starts.
		expect(outcome).toEqual({
			ended: [],
			error: false,
			status: stopped ? "stopped" : "building",
		});
	});

	it("ends a given-up turn again when the instance goes before its error is out", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000063");
		const outcome = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			await instance.persistMessages([brief]);
			// Five attempts evicted before they streamed: the fifth was given up on.
			for (let attempt = 1; attempt <= 5; attempt++) {
				await harness.onChatRecovery({
					requestId: `attempt-${attempt}`,
					recoveryData: { chatTurnStarted: true },
					partialParts: [],
					messages: [brief],
				});
			}
			for (const { id } of instance.getSchedules()) await instance.cancelSchedule(id);

			// The turn that ends it starts, and the instance goes before its error is read.
			Reflect.set(instance, "interruptedTurnRestart", { giveUp: "error" });
			const fiber = "__cf_internal_chat_turn:give-up";
			let stashed: unknown;
			await instance.runFiber(fiber, async () => {
				await instance.onChatMessage(async () => {}, { requestId: "give-up" });
				const snapshot = instance.sql<{ snapshot: string | null }>`
					SELECT snapshot FROM cf_agents_runs WHERE name = ${fiber}
				`[0]?.snapshot;
				stashed = snapshot ? JSON.parse(snapshot) : null;
			});
			const plan = planChatRecovery({ recoveryData: stashed, partialParts: [] });
			await harness.onChatRecovery({
				requestId: "give-up",
				recoveryData: stashed,
				partialParts: [],
				messages: [brief],
			});
			return {
				plan,
				scheduled: instance
					.getSchedules()
					.filter(({ callback }) => callback === "restartInterruptedTurn")
					.map(({ payload }) => payload),
			};
		});
		// Recovery does not take it for a finished reply: it ends the turn again.
		expect(outcome).toEqual({
			plan: "retry",
			scheduled: [{ afterMessageId: "brief", giveUp: true }],
		});
	});

	it("keeps in-place restarts apart from restarts after an eviction", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000060");
		const statuses = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			// Three attempts evicted before they streamed, within their own limit.
			for (const requestId of ["evicted-1", "evicted-2", "evicted-3"]) {
				await harness.onChatRecovery({
					requestId,
					recoveryData: { chatTurnStarted: true },
					partialParts: [],
					messages: [brief],
				});
			}
			const seen: Array<string | undefined> = [];
			for (const requestId of ["attempt-1", "attempt-2", "attempt-3"]) {
				harness.openTurnMetrics.set(requestId, turnOf(requestId, "initial-build"));
				await harness.onChatRecovery({
					requestId,
					recoveryData: { chatTurnStarted: true },
					partialParts: [],
					messages: [brief],
				});
				await respond(harness, requestId, "error");
				seen.push(instance.state.initialGeneration?.status);
			}
			return seen;
		});
		// The in-place limit still allows its two restarts.
		expect(statuses).toEqual(["building", "building", "failed"]);
	});

	it("counts in-place restarts again after a turn ends without one", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-00000000005d");
		const statuses = await runInDurableObject(agent, async (instance) => {
			const harness = await building(instance);
			const seen: Array<string | undefined> = [];
			const failInPlace = async (requestId: string) => {
				harness.openTurnMetrics.set(requestId, turnOf(requestId, "initial-build"));
				await harness.onChatRecovery({
					requestId,
					recoveryData: { chatTurnStarted: true },
					partialParts: [],
					messages: [brief],
				});
				await respond(harness, requestId, "error");
				seen.push(instance.state.initialGeneration?.status);
			};
			await failInPlace("attempt-1");
			await failInPlace("attempt-2");
			// A turn that ran to its end in between: the next failure is a fresh start.
			await respond(harness, "answered", "completed");
			await failInPlace("attempt-3");
			return seen;
		});
		expect(statuses).toEqual(["building", "building", "building"]);
	});

	it.each([
		{ live: false, status: "failed", rows: [] },
		{ live: true, status: "building", rows: ["chat:live"] },
	])(
		"settles a turn recovery gave up on unless one is running here (running: $live)",
		async ({ live, status, rows }) => {
			const id = live ? "000000000055" : "000000000054";
			const agent = testEnv.BuilderAgent.getByName(`11111111-1111-4111-8111-${id}`);
			const outcome = await runInDurableObject(agent, async (instance) => {
				const harness = await building(instance);
				// Left by the instance whose turn recovery kept failing to resume.
				instance.sql`INSERT INTO owner_activity (id, kind, started_at)
					VALUES ('chat:gone', 'chat', ${Date.now()})`;
				if (live) harness.beginOwnerActivity("chat:live", "chat");
				await harness.chatRecovery.onExhausted?.({
					requestId: "gone",
					recoveryRootRequestId: "gone",
					reason: "interrupted_attempts_exceeded",
					terminalMessage: "The response was interrupted.",
				});
				return {
					status: instance.state.initialGeneration?.status,
					rows: instance.sql<{ id: string }>`SELECT id FROM owner_activity WHERE kind = 'chat'`.map(
						(row) => row.id,
					),
				};
			});
			expect(outcome).toEqual({ status, rows });
		},
	);
});
