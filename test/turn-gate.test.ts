import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
	closeInterruptedToolCalls,
	INTERRUPTED_TOOL_ERROR,
	planChatRecovery,
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
