import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResponseResult } from "@cloudflare/ai-chat";
import type { BuilderAgent } from "../src/worker/agent.js";
import { BuildConvergence } from "../src/worker/build-convergence.js";
import { shouldSkipSiteReadyTurn } from "../src/worker/turn-gate.js";

const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

describe("initial generation stop", () => {
	beforeEach(async () => {
		await reset();
	});

	it("stops only the matching unfinished generation and persists across DO access", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000008");
		await runInDurableObject(agent, async (instance) => {
			instance.messages = [
				{ id: "opening-brief", role: "user", parts: [{ type: "text", text: "Build a bakery" }] },
			];
			instance.setState({
				siteReady: false,
				initialGeneration: { id: "opening-brief", status: "preparing" },
			});
			expect(await instance.stopInitialGeneration("other-brief")).toBe(false);
			expect(instance.state.initialGeneration?.status).toBe("preparing");
			expect(await instance.stopInitialGeneration("opening-brief")).toBe(true);
		});
		await runInDurableObject(agent, async (instance) => {
			expect(instance.state.initialGeneration).toEqual({
				id: "opening-brief",
				status: "stopped",
				terminalMessageId: "opening-brief",
			});
		});
	});

	it("waits for provisioning and the active mutation before reporting stopped", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000012");
		await runInDurableObject(agent, async (instance) => {
			instance.messages = [
				{ id: "opening-brief", role: "user", parts: [{ type: "text", text: "Build a bakery" }] },
			];
			instance.setState({
				siteReady: false,
				initialGeneration: { id: "opening-brief", status: "preparing" },
			});

			const controller = new AbortController();
			let finishProvision!: () => void;
			const provision = new Promise<{ ready: boolean; stopped: boolean }>((resolve) => {
				finishProvision = () => resolve({ ready: false, stopped: true });
			});
			const convergence = new BuildConvergence();
			let finishMutation!: () => void;
			const mutation = convergence.runMutation(
				() => new Promise<void>((resolve) => (finishMutation = resolve)),
			);
			const internals = instance as unknown as {
				provisionController: AbortController;
				provisionPromise: typeof provision;
				activeBuildConvergences: Map<string, BuildConvergence>;
			};
			internals.provisionController = controller;
			internals.provisionPromise = provision;
			internals.activeBuildConvergences = new Map([["request-a", convergence]]);

			let settled = false;
			const stop = instance.stopInitialGeneration("opening-brief").then(() => (settled = true));
			await Promise.resolve();
			expect(controller.signal.aborted).toBe(true);
			expect(instance.state.initialGeneration?.status).toBe("stopping");
			expect(settled).toBe(false);

			finishMutation();
			finishProvision();
			await mutation;
			await stop;
			expect(instance.state.initialGeneration?.status).toBe("stopped");
		});
	});

	it("keeps each response hook scoped to its own build convergence", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000013");
		await runInDurableObject(agent, async (instance) => {
			const first = new BuildConvergence();
			const second = new BuildConvergence();
			let finishSecond!: () => void;
			const secondMutation = second.runMutation(
				() => new Promise<void>((resolve) => (finishSecond = resolve)),
			);
			const internals = instance as unknown as {
				activeBuildConvergences: Map<string, BuildConvergence>;
				onChatResponse(result: ChatResponseResult): Promise<void>;
			};
			internals.activeBuildConvergences = new Map([
				["request-a", first],
				["request-b", second],
			]);

			await internals.onChatResponse({
				requestId: "request-a",
				continuation: false,
				status: "completed",
				message: { id: "reply-a", role: "assistant", parts: [] },
			});
			expect(internals.activeBuildConvergences.has("request-a")).toBe(false);
			expect(internals.activeBuildConvergences.get("request-b")).toBe(second);

			finishSecond();
			await secondMutation;
		});
	});

	it("holds a queued turn until the active Stop barrier settles", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000014");
		await agent.initializeOwnership("stop-barrier");
		await runInDurableObject(agent, async (instance) => {
			instance.messages = [
				{ id: "user-b", role: "user", parts: [{ type: "text", text: "Retry" }] },
			];
			let releaseStop!: () => void;
			const barrier = new Promise<void>((resolve) => (releaseStop = resolve));
			const register = vi.fn(async () => {});
			const internals = instance as unknown as {
				stopPromise: Promise<void>;
				registerProjectForCurrentOwner: typeof register;
			};
			internals.stopPromise = barrier;
			internals.registerProjectForCurrentOwner = register;
			const controller = new AbortController();
			controller.abort();

			const turn = instance.onChatMessage(async () => {}, {
				requestId: "request-b",
				abortSignal: controller.signal,
			});
			await Promise.resolve();
			expect(register).not.toHaveBeenCalled();

			releaseStop();
			await turn;
			expect(register).toHaveBeenCalledOnce();
		});
	});

	it("anchors active Stop to its own user message when another tab has sent a newer one", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-00000000000e");
		await runInDurableObject(agent, async (instance) => {
			instance.messages = [
				{ id: "user-a", role: "user", parts: [{ type: "text", text: "Build a bakery" }] },
				{ id: "user-b", role: "user", parts: [{ type: "text", text: "Add a menu" }] },
			];
			instance.setState({
				siteReady: true,
				initialGeneration: { id: "user-a", status: "building" },
			});
			const harness = instance as unknown as {
				activeInitialRequestId?: string;
				activeInitialUserMessageId?: string;
			};
			harness.activeInitialRequestId = "request-a";
			harness.activeInitialUserMessageId = "user-a";
			expect(await instance.stopInitialGeneration("user-a")).toBe(true);
			expect(instance.state.initialGeneration?.terminalMessageId).toBe("user-a");
			expect(
				shouldSkipSiteReadyTurn({
					messages: instance.messages,
					buildStarted: true,
					resuming: false,
					stoppedAtMessageId: "user-a",
				}),
			).toBe(false);
		});
	});

	it("does not provision after Stop aborts a turn during registration", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-00000000000d");
		await agent.initializeOwnership("stopped-during-registration");
		await runInDurableObject(agent, async (instance) => {
			instance.messages = [
				{ id: "user-a", role: "user", parts: [{ type: "text", text: "Build a bakery" }] },
			];
			let finishRegistration: (() => void) | undefined;
			const harness = instance as unknown as {
				registerProjectForCurrentOwner(): Promise<void>;
				provisionPromise: Promise<unknown> | null;
			};
			harness.registerProjectForCurrentOwner = () =>
				new Promise((resolve) => {
					finishRegistration = resolve;
				});
			const controller = new AbortController();
			const turn = instance.onChatMessage(async () => {}, {
				requestId: "request-a",
				abortSignal: controller.signal,
			});
			controller.abort();
			finishRegistration?.();
			await turn;
			expect(instance.state.initialGeneration).toEqual({
				id: "user-a",
				status: "stopped",
				terminalMessageId: "user-a",
			});
			expect(harness.provisionPromise).toBeNull();
		});
	});

	it.each([false, true])(
		"records unanswered questions after persistence when siteReady=%s",
		async (siteReady) => {
			const agent = testEnv.BuilderAgent.getByName(
				siteReady ? "11111111-1111-4111-8111-00000000000c" : "11111111-1111-4111-8111-00000000000b",
			);
			await runInDurableObject(agent, async (instance) => {
				const assistant: ChatResponseResult["message"] = {
					id: "interview",
					role: "assistant",
					parts: [
						{
							type: "tool-ask_questions",
							toolCallId: "questions-1",
							state: "output-available",
							input: {
								questions: [{ question: "Which audience?", options: ["Readers", "Teams"] }],
							},
							output: { ok: true },
						},
					],
				};
				instance.messages = [
					{ id: "opening-brief", role: "user", parts: [{ type: "text", text: "A journal" }] },
					assistant,
				];
				instance.setState({
					siteReady,
					initialGeneration: { id: "opening-brief", status: "preparing" },
				});
				const harness = instance as unknown as {
					activeInitialRequestId?: string;
					onChatResponse(result: ChatResponseResult): Promise<void>;
				};
				harness.activeInitialRequestId = "interview-request";
				await harness.onChatResponse({
					message: assistant,
					requestId: "interview-request",
					continuation: false,
					status: "completed",
				});
				expect(instance.state.initialGeneration).toEqual({
					id: "opening-brief",
					status: "awaiting_answers",
				});
				instance.setState({
					...instance.state,
					initialGeneration: {
						id: "opening-brief",
						status: "stopped",
						terminalMessageId: "opening-brief",
					},
				});
				harness.activeInitialRequestId = "interview-request-2";
				await harness.onChatResponse({
					message: assistant,
					requestId: "interview-request-2",
					continuation: false,
					status: "completed",
				});
				expect(instance.state.initialGeneration?.status).toBe("stopped");
			});
		},
	);

	it("attributes a failed turn to its own request rather than a newer queued message", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-00000000000f");
		await runInDurableObject(agent, async (instance) => {
			instance.messages = [
				{ id: "user-a", role: "user", parts: [{ type: "text", text: "Build" }] },
				{ id: "user-b", role: "user", parts: [{ type: "text", text: "Try again" }] },
			];
			instance.setState({
				siteReady: true,
				initialGeneration: { id: "user-a", status: "building" },
			});
			const harness = instance as unknown as {
				activeInitialRequestId: string;
				activeInitialUserMessageId: string;
				onChatResponse(result: ChatResponseResult): Promise<void>;
			};
			harness.activeInitialRequestId = "request-a";
			harness.activeInitialUserMessageId = "user-a";
			await harness.onChatResponse({
				requestId: "request-a",
				continuation: false,
				status: "error",
				message: { id: "failed", role: "assistant", parts: [] },
				error: "Failed",
			});
			expect(instance.state.initialGeneration?.terminalMessageId).toBe("user-a");
		});
	});
});
