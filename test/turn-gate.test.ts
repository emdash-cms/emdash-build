import {
	convertToModelMessages,
	InvalidToolInputError,
	streamText,
	tool,
	TypeValidationError,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	closeInterruptedToolCalls,
	INTERRUPTED_TOOL_ERROR,
	planChatRecovery,
	replyErrors,
	replyStreamOptions,
	shouldAutoStartInitialBuild,
	shouldSkipSiteReadyTurn,
	stashedTurnMetrics,
} from "../src/worker/turn-gate.js";

const brief: UIMessage = {
	id: "user-1",
	role: "user",
	parts: [{ type: "text", text: "Build a bakery site" }],
};

const questionnaire: UIMessage = {
	id: "assistant-ask",
	role: "assistant",
	parts: [
		{
			type: "tool-ask_questions",
			toolCallId: "ask-1",
			state: "output-available",
			input: { questions: [{ question: "Which tone?", options: ["Warm", "Formal"] }] },
			output: { ok: true },
		},
	],
};

/** A build reply persisted by chat recovery while `write_file` was still running. */
const interruptedBuild: UIMessage = {
	id: "assistant-build",
	role: "assistant",
	parts: [
		{ type: "reasoning", text: "Write the homepage first." },
		{ type: "text", text: "Building the homepage." },
		{
			type: "tool-write_file",
			toolCallId: "write-1",
			state: "input-available",
			input: { path: "src/pages/index.astro", content: "<h1>Bakery</h1>" },
		},
	],
};

/** A model that makes these tool calls in one step. */
function toolCallModel(calls: { toolName: string; input: string }[]) {
	return new MockLanguageModelV3({
		doStream: async () => ({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					calls.forEach((call, index) =>
						controller.enqueue({ type: "tool-call", toolCallId: `call-${index}`, ...call }),
					);
					controller.enqueue({
						type: "finish",
						finishReason: { unified: "tool-calls", raw: "tool_calls" },
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

function finishedModel() {
	return new MockLanguageModelV3({
		doStream: async () => ({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "stream-start", warnings: [] });
					controller.enqueue({
						type: "finish",
						finishReason: { unified: "stop", raw: "stop" },
						usage: {
							inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
							outputTokens: { total: 0, text: 0, reasoning: 0 },
						},
					});
					controller.close();
				},
			}),
		}),
	});
}

describe("site-ready turn gate", () => {
	it("skips the provision auto-turn once a build has started", () => {
		expect(
			shouldSkipSiteReadyTurn({
				messages: [brief, interruptedBuild],
				buildStarted: true,
				resuming: false,
			}),
		).toBe(true);
	});

	it("resumes a build turn interrupted by eviction", () => {
		expect(
			shouldSkipSiteReadyTurn({
				messages: [brief, interruptedBuild],
				buildStarted: true,
				resuming: true,
			}),
		).toBe(false);
	});

	it("keeps unanswered questions gating even for a continuation", () => {
		expect(
			shouldSkipSiteReadyTurn({
				messages: [brief, questionnaire],
				buildStarted: false,
				resuming: true,
			}),
		).toBe(true);
	});

	it("does not restart a stopped generation from a queued auto-turn or recovery", () => {
		for (const resuming of [false, true]) {
			expect(
				shouldSkipSiteReadyTurn({
					messages: [brief],
					buildStarted: false,
					resuming,
					stoppedAtMessageId: brief.id,
				}),
			).toBe(true);
		}
	});

	it("does not enqueue the build when setup finishes after Stop", () => {
		expect(shouldAutoStartInitialBuild(true, false, "stopping")).toBe(false);
		expect(shouldAutoStartInitialBuild(true, false, "stopped")).toBe(false);
		expect(shouldAutoStartInitialBuild(true, false, "failed")).toBe(false);
		expect(shouldAutoStartInitialBuild(true, false, "awaiting_answers")).toBe(true);
		expect(shouldAutoStartInitialBuild(true, true, "preparing")).toBe(false);
	});

	it("always runs a user turn", () => {
		expect(
			shouldSkipSiteReadyTurn({
				messages: [brief, interruptedBuild, { ...brief, id: "user-2" }],
				buildStarted: true,
				resuming: false,
			}),
		).toBe(false);
	});
});

describe("interrupted tool calls", () => {
	it("records the open call as failed so later prompts stay valid", async () => {
		const repaired = closeInterruptedToolCalls([brief, interruptedBuild]);
		expect(repaired).toBeDefined();
		const model = finishedModel();
		const errors: unknown[] = [];

		const result = streamText({
			model,
			messages: await convertToModelMessages([...repaired!, { ...brief, id: "user-2" }]),
			onError: ({ error }) => void errors.push(error),
		});
		await result.consumeStream();

		expect(errors).toEqual([]);
		expect(model.doStreamCalls).toHaveLength(1);
		const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
		// The reasoning and call keep their pairing; the model is told why it failed.
		expect(prompt).toContain("Write the homepage first.");
		expect(prompt).toContain('"toolCallId":"write-1"');
		expect(prompt).toContain(INTERRUPTED_TOOL_ERROR);
	});

	it("leaves complete history untouched", () => {
		expect(closeInterruptedToolCalls([brief, questionnaire])).toBeUndefined();
	});
});

describe("reply stream", () => {
	it("tags the assistant reply at stream boundaries without repeating metadata on each delta", async () => {
		const result = streamText({ model: finishedModel(), prompt: "Build" });
		const chunks = [];
		for await (const chunk of result.toUIMessageStream(replyStreamOptions(String, brief.id))) {
			chunks.push(chunk);
		}
		expect(chunks.filter((chunk) => chunk.type === "message-metadata")).toEqual([]);
		expect(chunks.find((chunk) => chunk.type === "start")).toMatchObject({
			messageMetadata: { initialGenerationId: brief.id },
		});
		expect(chunks.find((chunk) => chunk.type === "finish")).toMatchObject({
			messageMetadata: { initialGenerationId: brief.id },
		});
	});
	it("identifies a conversational holding reply within the first generation", async () => {
		const result = streamText({ model: finishedModel(), prompt: "Can I edit the posts?" });
		const chunks = [];
		for await (const chunk of result.toUIMessageStream(
			replyStreamOptions(String, brief.id, "holding"),
		)) {
			chunks.push(chunk);
		}
		expect(chunks.find((chunk) => chunk.type === "start")).toMatchObject({
			messageMetadata: { initialGenerationId: brief.id, initialGenerationReply: "holding" },
		});
		expect(chunks.filter((chunk) => chunk.type === "message-metadata")).toEqual([]);
	});
	it("announces a fresh message id so recovery never merges into the previous reply", async () => {
		const model = finishedModel();
		const result = streamText({ model, prompt: "Continue" });
		const reader = result.toUIMessageStream(replyStreamOptions(String)).getReader();

		const first = await reader.read();
		await reader.cancel();

		expect(first.value).toMatchObject({ type: "start", messageId: expect.any(String) });
		expect((first.value as { messageId: string }).messageId).not.toBe(interruptedBuild.id);
	});
	it("says why a tool call failed, and gives a failed turn the turn message", async () => {
		const errors = replyErrors(() => "Turn failed.");
		const result = streamText({
			model: toolCallModel([
				{ toolName: "read_file", input: '{"path":"a.astro"}' },
				{ toolName: "read_file", input: '{"path":1}' },
				{ toolName: "missing_tool", input: "{}" },
			]),
			tools: {
				read_file: tool({
					inputSchema: z.object({ path: z.string() }),
					execute: async ({ path }): Promise<string> => {
						throw new Error(`Could not read ${path}: The container did not answer.`);
					},
				}),
			},
			experimental_onToolCallFinish: errors.noteToolCall,
			prompt: "Build",
		});
		const chunks: UIMessageChunk[] = [];
		for await (const chunk of result.toUIMessageStream(replyStreamOptions(errors.errorText))) {
			chunks.push(chunk);
		}
		const errorText = (type: string, toolCallId: string) =>
			chunks.find(
				(chunk): chunk is Extract<UIMessageChunk, { errorText: string; toolCallId: string }> =>
					chunk.type === type && "toolCallId" in chunk && chunk.toolCallId === toolCallId,
			)?.errorText;

		expect(errorText("tool-output-error", "call-0")).toBe(
			"Could not read a.astro: The container did not answer.",
		);
		// The reason, without the SDK's copy of the whole input, which the details show already.
		expect(errorText("tool-input-error", "call-1")).toMatch(
			/^Invalid input for tool read_file: [^]*expected string/,
		);
		expect(errorText("tool-input-error", "call-1")).not.toContain("Type validation failed");
		expect(errorText("tool-output-error", "call-1")).toBe(errorText("tool-input-error", "call-1"));
		expect(errorText("tool-output-error", "call-2")).toMatch(/missing_tool/);
		expect(errors.errorText(new Error("Could not read a.astro"))).toBe("Turn failed.");
	});
	it("keeps the end of a long tool error, where the reason is", () => {
		const errors = replyErrors(() => "Turn failed.");
		const error = new Error(`Invalid input: ${"x".repeat(10_000)} expected string`);
		errors.noteToolCall({ success: false, error });

		const text = errors.errorText(error);

		expect(text.length).toBeLessThan(2_100);
		expect(text).toMatch(/^Invalid input: x+ … x+ expected string$/);
	});
	it("gives a tool error with no message the turn message", () => {
		const errors = replyErrors(() => "Turn failed.");
		const error = new Error("");
		errors.noteToolCall({ success: false, error });

		expect(errors.errorText(error)).toBe("Turn failed.");
	});
	it("says something for a tool error that cannot be put as JSON", () => {
		const errors = replyErrors(() => "Turn failed.");
		const cyclic: Record<string, unknown> = { code: "E_LOOP" };
		cyclic.self = cyclic;
		errors.noteToolCall({ success: false, error: cyclic });

		expect(errors.errorText(cyclic)).toBe("[object Object]");
	});
	it("keeps the SDK's message for bad input whose validation gave no reason", () => {
		const errors = replyErrors(() => "Turn failed.");
		const error = new InvalidToolInputError({
			toolName: "write_file",
			toolInput: "{}",
			cause: new TypeValidationError({ value: {}, cause: undefined }),
		});

		expect(errors.errorText(error)).toBe(error.message);
	});
	it("never repeats an Artifacts token from a tool error", () => {
		const errors = replyErrors(() => "Turn failed.");
		const error = new Error("git push failed: token art_v1_abc123?expires=99 rejected");
		errors.noteToolCall({ success: false, error });

		expect(errors.errorText(error)).toBe("git push failed: token art_*** rejected");
	});
});

describe("chat recovery plan", () => {
	it("continues a reply that already streamed output", () => {
		expect(planChatRecovery({ recoveryData: null, partialParts: [{ type: "text" }] })).toBe(
			"continue",
		);
	});

	it("restarts a turn evicted past the gate before it streamed anything", () => {
		expect(planChatRecovery({ recoveryData: { chatTurnStarted: true }, partialParts: [] })).toBe(
			"restart",
		);
	});

	it("retries a turn evicted before the gate, so the gate decides again", () => {
		expect(planChatRecovery({ recoveryData: null, partialParts: [] })).toBe("retry");
	});

	it("leaves a finished reply alone", () => {
		expect(planChatRecovery({ recoveryData: { chatTurnFinished: true }, partialParts: [] })).toBe(
			"skip",
		);
	});

	it("reads back only the record a finished turn stashed", () => {
		const turnMetrics = { turnId: "req-1", outcome: "finished" };
		expect(stashedTurnMetrics({ chatTurnFinished: true, turnMetrics })).toBe(turnMetrics);
		expect(stashedTurnMetrics({ chatTurnFinished: true })).toBeUndefined();
		expect(stashedTurnMetrics({ chatTurnStarted: true, turnMetrics })).toBeUndefined();
		expect(stashedTurnMetrics({ chatTurnFinished: true, turnMetrics: { turnId: 1 } })).toBe(
			undefined,
		);
		expect(stashedTurnMetrics(null)).toBeUndefined();
	});
});
