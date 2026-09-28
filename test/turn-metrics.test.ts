import { stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TurnMetrics, timeSync } from "../src/worker/turn-metrics.js";

type StreamPart = Record<string, unknown>;

function usage(input: number, cacheRead: number, output: number, reasoning: number) {
	return {
		inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: 0 },
		outputTokens: { total: output, text: output - reasoning, reasoning },
	};
}

function streamOf(parts: StreamPart[]) {
	return new ReadableStream({
		start(controller) {
			controller.enqueue({ type: "stream-start", warnings: [] });
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}

function toolStep(calls: { id: string; name: string }[], stepUsage: ReturnType<typeof usage>) {
	return streamOf([
		...calls.map((call) => ({
			type: "tool-call",
			toolCallId: call.id,
			toolName: call.name,
			input: "{}",
		})),
		{
			type: "finish",
			finishReason: { unified: "tool-calls", raw: "tool_calls" },
			usage: stepUsage,
		},
	]);
}

function textStep(stepUsage: ReturnType<typeof usage>) {
	return streamOf([
		{ type: "text-start", id: "t" },
		{ type: "text-delta", id: "t", delta: "Done." },
		{ type: "text-end", id: "t" },
		{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: stepUsage },
	]);
}

function modelWithSteps(...steps: Array<() => ReadableStream>) {
	let call = 0;
	return new MockLanguageModelV3({
		doStream: async () => ({ stream: steps[Math.min(call++, steps.length - 1)]!() }),
	});
}

const tools = {
	write_file: tool({ inputSchema: z.object({}), execute: async () => ({ success: true }) }),
	exec: tool({ inputSchema: z.object({}), execute: async () => ({ success: false }) }),
	explode: tool({
		inputSchema: z.object({}),
		execute: async (): Promise<unknown> => {
			throw new Error("boom");
		},
	}),
};

function clock(start = 1_000) {
	let now = start;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function newMetrics(now: () => number = Date.now) {
	return new TurnMetrics({
		turnId: "turn-1",
		kind: "initial-build",
		resumed: false,
		model: "test-model",
		stepCap: 256,
		now,
	});
}

describe("turn metrics", () => {
	it("adds up tokens and tool calls from a real multi-step stream", async () => {
		const metrics = newMetrics();
		const finished: Array<ReturnType<TurnMetrics["finish"]>> = [];
		const result = streamText({
			model: modelWithSteps(
				() =>
					toolStep(
						[
							{ id: "1", name: "write_file" },
							{ id: "2", name: "exec" },
							{ id: "3", name: "explode" },
						],
						usage(1_000, 200, 300, 120),
					),
				() => textStep(usage(1_500, 1_000, 50, 10)),
			),
			prompt: "Build",
			tools,
			stopWhen: stepCountIs(5),
			onStepFinish: (step) => metrics.onStep(step),
			experimental_onToolCallFinish: (event) => metrics.onToolCallFinish(event),
			onFinish: ({ finishReason }) => {
				finished.push(metrics.finish("finished", { finishReason }));
			},
		});
		await result.consumeStream();

		const record = finished[0];
		expect(record).toMatchObject({
			outcome: "finished",
			finishReason: "stop",
			steps: 2,
			tokens: { input: 2_500, cachedInput: 1_200, output: 350, reasoning: 130 },
			peakInputTokens: 1_500,
			stepCapReached: false,
		});
		expect(record?.tools.write_file).toMatchObject({ calls: 1, failures: 0 });
		// A `success: false` result and a thrown error both count as failures.
		expect(record?.tools.exec).toMatchObject({ calls: 1, failures: 1 });
		expect(record?.tools.explode).toMatchObject({ calls: 1, failures: 1 });
		expect(record?.tools.write_file?.ms).toBeGreaterThanOrEqual(0);
	});

	it("records a turn whose model call fails after earlier steps as an error", async () => {
		const metrics = newMetrics();
		const records: Array<ReturnType<TurnMetrics["finish"]>> = [];
		const result = streamText({
			model: modelWithSteps(
				() => toolStep([{ id: "1", name: "write_file" }], usage(100, 0, 10, 0)),
				() => streamOf([{ type: "error", error: new Error("gateway unavailable") }]),
			),
			prompt: "Build",
			tools,
			maxRetries: 0,
			stopWhen: stepCountIs(5),
			onStepFinish: (step) => metrics.onStep(step),
			onError: ({ error }) => metrics.noteError(error),
			onFinish: ({ finishReason }) => {
				records.push(metrics.finish("finished", { finishReason }));
			},
		});
		await result.consumeStream();

		// The SDK still calls onFinish after an error once a step completed, so the
		// record comes from onFinish (it carries the finish reason), not onError.
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ outcome: "error", error: "gateway unavailable" });
		expect(records[0]?.finishReason).toBeDefined();
		expect(records[0]?.steps).toBeGreaterThanOrEqual(1);
	});

	it("keeps the usage of a step whose own stream reported the error", async () => {
		const metrics = newMetrics();
		const records: Array<ReturnType<TurnMetrics["finish"]>> = [];
		const result = streamText({
			model: modelWithSteps(() =>
				streamOf([
					{ type: "error", error: new Error("response failed") },
					{
						type: "finish",
						finishReason: { unified: "error", raw: "failed" },
						usage: usage(40_000, 0, 5, 0),
					},
				]),
			),
			prompt: "Build",
			maxRetries: 0,
			onStepFinish: (step) => metrics.onStep(step),
			onError: ({ error }) => metrics.noteError(error),
			onFinish: ({ finishReason }) => {
				records.push(metrics.finish("finished", { finishReason }));
			},
		});
		await result.consumeStream();

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			outcome: "error",
			error: "response failed",
			steps: 1,
			tokens: { input: 40_000 },
		});
	});

	it("falls back to the chat response when no streamText callback ends the turn", async () => {
		const metrics = newMetrics();
		let finishCalled = false;
		const result = streamText({
			model: new MockLanguageModelV3({
				doStream: async () => {
					throw new Error("model unavailable");
				},
			}),
			prompt: "Build",
			maxRetries: 0,
			onStepFinish: (step) => metrics.onStep(step),
			onError: ({ error }) => metrics.noteError(error),
			onFinish: () => {
				finishCalled = true;
			},
		});
		await result.consumeStream();

		// ai-chat reports the reply as completed; the noted error still wins.
		expect(finishCalled).toBe(false);
		expect(metrics.finishFromResponse({ status: "completed" })).toMatchObject({
			outcome: "error",
			steps: 0,
			error: "model unavailable",
		});
		expect(metrics.finishFromResponse({ status: "completed" })).toBeNull();
		expect(newMetrics().finishFromResponse({ status: "aborted" })).toMatchObject({
			outcome: "stopped",
		});
		expect(
			newMetrics().finishFromResponse({ status: "error", error: "Network connection lost." }),
		).toMatchObject({ outcome: "error", error: "Network connection lost." });
	});

	it("records a stopped turn once", async () => {
		const metrics = newMetrics();
		const controller = new AbortController();
		const records: Array<ReturnType<TurnMetrics["finish"]>> = [];
		const result = streamText({
			model: modelWithSteps(
				() => toolStep([{ id: "1", name: "write_file" }], usage(100, 0, 10, 0)),
				() => textStep(usage(100, 0, 10, 0)),
			),
			prompt: "Build",
			tools,
			stopWhen: stepCountIs(5),
			abortSignal: controller.signal,
			onStepFinish: (step) => {
				metrics.onStep(step);
				controller.abort();
			},
			onAbort: () => {
				records.push(metrics.finish("stopped"));
			},
			onFinish: ({ finishReason }) => {
				records.push(metrics.finish("finished", { finishReason }));
			},
		});
		await result.consumeStream();

		expect(records.filter(Boolean)).toHaveLength(1);
		expect(records[0]).toMatchObject({ outcome: "stopped", steps: 1 });
		expect(metrics.finishFromResponse({ status: "aborted" })).toBeNull();
	});

	it("keeps a finished turn finished when the user stops during the final save", () => {
		const metrics = newMetrics();
		metrics.modelFinished("stop");
		// The copy recovery would record does not end the turn.
		expect(metrics.pendingRecord()).toMatchObject({ outcome: "finished", finalSaveMs: null });

		expect(metrics.finishFromResponse({ status: "aborted" })).toMatchObject({
			outcome: "finished",
			finishReason: "stop",
			finalSaveMs: null,
		});
		// Already recorded: nothing left for recovery to record again.
		expect(metrics.pendingRecord()).toBeUndefined();
	});

	it("counts tool calls the SDK rejected without running them", async () => {
		const metrics = newMetrics();
		const finished: Array<ReturnType<TurnMetrics["finish"]>> = [];
		const result = streamText({
			model: modelWithSteps(
				() =>
					toolStep(
						[
							{ id: "1", name: "explode" },
							{ id: "2", name: "needs_path" },
							{ id: "3", name: "missing_tool" },
						],
						usage(100, 0, 10, 0),
					),
				() => textStep(usage(100, 0, 10, 0)),
			),
			prompt: "Build",
			tools: {
				...tools,
				needs_path: tool({
					inputSchema: z.object({ path: z.string() }),
					execute: async () => ({ success: true }),
				}),
			},
			stopWhen: stepCountIs(5),
			onStepFinish: (step) => metrics.onStep(step),
			experimental_onToolCallFinish: (event) => metrics.onToolCallFinish(event),
			onFinish: ({ finishReason }) => {
				finished.push(metrics.finish("finished", { finishReason }));
			},
		});
		await result.consumeStream();

		expect(finished[0]?.tools).toEqual({
			// Ran and threw: counted once, by onToolCallFinish.
			explode: { calls: 1, ms: expect.any(Number), failures: 1 },
			needs_path: { calls: 1, ms: 0, failures: 1 },
			missing_tool: { calls: 1, ms: 0, failures: 1 },
		});
	});

	it("keys tools by model-chosen names without touching object prototypes", () => {
		const metrics = newMetrics();
		metrics.onStep({
			usage: {
				inputTokens: 1,
				inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
				outputTokens: 1,
				outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
				totalTokens: 2,
			},
			content: [{ type: "tool-error", toolCallId: "x", toolName: "__proto__" }],
		});
		const record = metrics.finish("finished");

		expect(Object.hasOwn(record!.tools, "__proto__")).toBe(true);
		expect(JSON.parse(JSON.stringify(record)).tools.__proto__).toEqual({
			calls: 1,
			ms: 0,
			failures: 1,
		});
		expect(({} as { calls?: unknown }).calls).toBeUndefined();
	});

	it("times setup, sync work and the final save", async () => {
		const time = clock();
		const metrics = new TurnMetrics({
			turnId: "turn-1",
			kind: "initial-build",
			resumed: false,
			model: "test-model",
			stepCap: 256,
			startedAt: 500,
			now: time.now,
		});
		time.advance(4_000);
		metrics.streamStarted({ promptChars: 17_000, toolCount: 45 });

		await timeSync(metrics, "backup", async () => time.advance(3_000));
		await timeSync(metrics, "previewRefresh", async () => time.advance(500));
		await expect(
			timeSync(metrics, "backup", async () => {
				time.advance(1_000);
				throw new Error("push failed");
			}),
		).rejects.toThrow("push failed");
		await metrics.timeFinalSave(async () => time.advance(2_000));
		// No active turn: the work still runs.
		expect(await timeSync(undefined, "backup", async () => "ran")).toBe("ran");

		expect(metrics.finish("finished", { finishReason: "stop" })).toMatchObject({
			turnId: "turn-1",
			kind: "initial-build",
			model: "test-model",
			promptChars: 17_000,
			toolCount: 45,
			startedAt: 500,
			setupMs: 4_500,
			wallMs: 11_000,
			finalSaveMs: 2_000,
			// The final save runs after the model; sync only covers work inside tools.
			sync: { backup: { count: 2, ms: 4_000 }, previewRefresh: { count: 1, ms: 500 } },
		});
	});

	it("counts entry-text model calls separately from the turn's own steps", () => {
		const metrics = newMetrics();
		const bodyUsage = {
			inputTokens: 300,
			inputTokenDetails: { noCacheTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
			outputTokens: 900,
			outputTokenDetails: { textTokens: 400, reasoningTokens: 500 },
			totalTokens: 1_200,
		};
		metrics.addSubcall(bodyUsage);
		metrics.addSubcall(bodyUsage);

		expect(metrics.finish("finished")).toMatchObject({
			steps: 0,
			tokens: { input: 0, output: 0 },
			subcalls: { calls: 2, tokens: { input: 600, output: 1_800, reasoning: 1_000 } },
		});
	});

	it("flags a turn cut off by the step cap and shortens long errors", () => {
		const stepUsage = {
			inputTokens: 10,
			inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
			outputTokens: 1,
			outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
			totalTokens: 11,
		};
		const twoSteps = () => {
			const metrics = new TurnMetrics({
				turnId: "turn-2",
				kind: "follow-up",
				resumed: true,
				model: "test-model",
				stepCap: 2,
			});
			metrics.onStep({ usage: stepUsage });
			metrics.onStep({ usage: stepUsage });
			return metrics;
		};

		expect(twoSteps().finish("finished", { finishReason: "tool-calls" })).toMatchObject({
			kind: "follow-up",
			resumed: true,
			stepCapReached: true,
		});
		// The last allowed step ended on its own.
		expect(twoSteps().finish("finished", { finishReason: "stop" })?.stepCapReached).toBe(false);
		const failed = twoSteps().finish("error", { error: new Error("x".repeat(1_000)) });
		expect(failed?.error?.length).toBe(300);
	});
});
