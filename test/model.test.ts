import { describe, expect, it } from "vitest";
import {
	convertToModelMessages,
	generateText,
	isStepCount,
	readUIMessageStream,
	streamText,
	toUIMessageStream,
	tool,
	type UIMessage,
} from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { vi } from "vitest";
import { z } from "zod";
import { BuildConvergence } from "../src/worker/build-convergence.js";
import {
	BUILDER_MODEL_ID,
	BUILDER_REASONING_EFFORT,
	buildStepProviderOptions,
	buildStepReasoningEffort,
	builderProviderOptions,
	createBuilderModel,
	EMPTY_SUMMARY_REPLY,
	noToolCallsWhenNoneMiddleware,
	prepareBuildTurnStep,
} from "../src/worker/model.js";

const env = {
	AI_GATEWAY_TOKEN: "gateway-token",
	AI_GATEWAY_ACCOUNT_ID: "account",
	AI_GATEWAY_ID: "gateway",
};

function streamOf(parts: Array<Record<string, unknown>>) {
	return new ReadableStream({
		start(controller) {
			controller.enqueue({ type: "stream-start", warnings: [] });
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}

function completedResponse() {
	return new Response(
		JSON.stringify({
			id: "resp_1",
			object: "response",
			created_at: 1,
			model: BUILDER_MODEL_ID,
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "ok", annotations: [] }],
				},
			],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("builder model configuration", () => {
	it("uses Terra without stored response references", () => {
		expect(BUILDER_MODEL_ID).toBe("openai/gpt-6.1-terra");
		expect(builderProviderOptions("medium")).toEqual({
			openai: {
				forceReasoning: true,
				reasoningEffort: "medium",
				reasoningSummary: "auto",
				store: false,
			},
		});
		expect(builderProviderOptions("high", { promptCacheKey: "session-1" }).openai).toMatchObject({
			promptCacheKey: "session-1",
		});
		// Nobody reads a sub-call's reasoning, so it asks for no summary.
		expect(builderProviderOptions("low", { reasoningSummary: false })).toEqual({
			openai: {
				forceReasoning: true,
				reasoningEffort: "low",
				reasoningSummary: null,
				store: false,
			},
		});
	});

	it("runs every phase at low effort", () => {
		expect(BUILDER_REASONING_EFFORT).toEqual({
			interview: "low",
			holding: "low",
			plan: "low",
			build: "low",
			followUp: "low",
			entryBody: "low",
		});
		expect(buildStepReasoningEffort({ initialBuild: true, stepNumber: 0 })).toBe("low");
		expect(buildStepReasoningEffort({ initialBuild: true, stepNumber: 1 })).toBe("low");
		expect(buildStepReasoningEffort({ initialBuild: true, stepNumber: 40 })).toBe("low");
		expect(buildStepReasoningEffort({ initialBuild: false, stepNumber: 0 })).toBe("low");
		expect(buildStepReasoningEffort({ initialBuild: false, stepNumber: 3 })).toBe("low");
	});

	it("restricts a step's callable tools through the provider, not the tools sent", () => {
		expect(
			buildStepProviderOptions({
				initialBuild: false,
				stepNumber: 4,
				allowedTools: { toolNames: ["view_preview"], mode: "required" },
			}),
		).toEqual({
			openai: {
				reasoningEffort: "low",
				allowedTools: { toolNames: ["view_preview"], mode: "required" },
				parallelToolCalls: false,
			},
		});
		expect(buildStepProviderOptions({ initialBuild: false, stepNumber: 4 })).toEqual({
			openai: { reasoningEffort: "low" },
		});
	});

	it("applies a per-step effort through prepareStep", async () => {
		const sent: unknown[] = [];
		let call = 0;
		const model = new MockLanguageModelV3({
			doStream: async (options) => {
				sent.push(options.providerOptions?.openai);
				const first = call++ === 0;
				return {
					stream: streamOf([
						...(first
							? [{ type: "tool-call", toolCallId: "1", toolName: "noop", input: "{}" }]
							: [
									{ type: "text-start", id: "t" },
									{ type: "text-delta", id: "t", delta: "Done." },
									{ type: "text-end", id: "t" },
								]),
						{
							type: "finish",
							finishReason: first
								? { unified: "tool-calls", raw: "tool_calls" }
								: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 1, text: 1, reasoning: 0 },
							},
						},
					]),
				};
			},
		});
		const result = streamText({
			model,
			prompt: "Build",
			tools: { noop: tool({ inputSchema: z.object({}), execute: async () => ({}) }) },
			stopWhen: isStepCount(3),
			providerOptions: builderProviderOptions("high"),
			prepareStep: ({ stepNumber }) => ({
				providerOptions: buildStepProviderOptions({ initialBuild: true, stepNumber }),
			}),
		});
		await result.consumeStream();

		// The step's effort replaces the base effort and keeps every other option.
		const base = { forceReasoning: true, reasoningSummary: "auto", store: false };
		expect(sent).toEqual([
			{ ...base, reasoningEffort: "low" },
			{ ...base, reasoningEffort: "low" },
		]);
	});

	it("reports every model response status and tags gateway requests", async () => {
		const statuses: number[] = [];
		const requests: Request[] = [];
		let attempt = 0;
		const model = createBuilderModel(env, {
			metadata: { session: "session-1", turn: "turn-1", kind: "follow-up" },
			onResponse: (status) => statuses.push(status),
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				attempt += 1;
				// A short Retry-After keeps the SDK's backoff out of the test's time budget.
				const retryAfter = { "retry-after-ms": "1" };
				if (attempt === 1) return new Response("busy", { status: 429, headers: retryAfter });
				if (attempt === 2) {
					return new Response("unavailable", { status: 503, headers: retryAfter });
				}
				return completedResponse();
			},
		});
		const { generateText } = await import("ai");

		const result = await generateText({ model, prompt: "hi", maxRetries: 2 });

		expect(result.text).toBe("ok");
		expect(statuses).toEqual([429, 503, 200]);
		expect(requests).toHaveLength(3);
		expect(requests[0]?.headers.get("cf-aig-gateway-id")).toBe("gateway");
		expect(JSON.parse(requests[0]?.headers.get("cf-aig-metadata") ?? "null")).toEqual({
			session: "session-1",
			turn: "turn-1",
			kind: "follow-up",
		});
	});

	it("does not report a request the caller aborted", async () => {
		const statuses: number[] = [];
		const controller = new AbortController();
		const model = createBuilderModel(env, {
			onResponse: (status) => statuses.push(status),
			fetch: async () => {
				controller.abort();
				throw new DOMException("The operation was aborted.", "AbortError");
			},
		});
		const { generateText } = await import("ai");

		await expect(
			generateText({ model, prompt: "hi", maxRetries: 0, abortSignal: controller.signal }),
		).rejects.toThrow();
		expect(statuses).toEqual([]);
	});

	it("reports a failed request as status 0 and rethrows it", async () => {
		const statuses: number[] = [];
		const model = createBuilderModel(env, {
			onResponse: (status) => statuses.push(status),
			fetch: async () => {
				throw new TypeError("network lost");
			},
		});
		const { generateText } = await import("ai");

		await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow(
			"network lost",
		);
		expect(statuses).toEqual([0]);
	});
});

describe("build step requests", () => {
	function responseStream(events: Array<Record<string, unknown>>) {
		const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	function toolCallTurn(name: string) {
		return responseStream([
			{ type: "response.created", response: { id: "resp_1", created_at: 1, model: "m" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "" },
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name,
					arguments: "{}",
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		]);
	}

	function textTurn() {
		return responseStream([
			{ type: "response.created", response: { id: "resp_2", created_at: 1, model: "m" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", content: [] },
			},
			{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Done." },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Done.", annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_2",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		]);
	}

	/** A summary written, then a tool called anyway. */
	function textThenToolCallTurn(name: string) {
		return responseStream([
			{ type: "response.created", response: { id: "resp_3", created_at: 1, model: "m" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", content: [] },
			},
			{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Built it." },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "Built it.", annotations: [] }],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "" },
			},
			{
				type: "response.output_item.done",
				output_index: 1,
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name,
					arguments: "{}",
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_3",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		]);
	}

	/** The same reply as toolCallTurn, not streamed, after reasoning if asked. */
	function toolCallResponse(name: string, reasoning = false, preamble = false) {
		return Response.json({
			id: "resp_4",
			created_at: 1,
			model: "m",
			status: "completed",
			output: [
				...(reasoning
					? [{ type: "reasoning", id: "rs_1", encrypted_content: "enc_1", summary: [] }]
					: []),
				...(preamble
					? [
							{
								type: "message",
								id: "msg_1",
								role: "assistant",
								status: "completed",
								phase: "commentary",
								content: [
									{ type: "output_text", text: "Let me check the preview.", annotations: [] },
								],
							},
						]
					: []),
				{
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name,
					arguments: "{}",
					status: "completed",
				},
			],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		});
	}

	/** The build's closing summary step: it writes the summary and must not change the site. */
	function summaryStep(reply: () => Response) {
		const write = vi.fn(async () => ({ success: true }));
		const errors: unknown[] = [];
		const result = streamText({
			model: createBuilderModel(env, { fetch: async () => reply() }),
			prompt: "Summarise the build",
			tools: { write_file: tool({ inputSchema: z.object({}), execute: write }) },
			toolChoice: "none",
			providerOptions: builderProviderOptions("low"),
			onError: ({ error }) => {
				errors.push(error);
			},
		});
		return { result, write, errors };
	}

	it("ends a summary step that calls a tool anyway as a stop, keeping its text", async () => {
		const { result, write, errors } = summaryStep(() => textThenToolCallTurn("write_file"));
		await result.consumeStream();

		// AI SDK 7 fails a step whose reply breaks toolChoice; the call is dropped instead.
		expect(errors).toEqual([]);
		expect(await result.finishReason).toBe("stop");
		expect(await result.text).toBe("Built it.");
		expect(await result.toolCalls).toEqual([]);
		expect(write).not.toHaveBeenCalled();
		// Nor does the call reach the saved conversation.
		const parts = (await result.response).messages.flatMap((message): Array<{ type: string }> =>
			Array.isArray(message.content) ? message.content : [],
		);
		expect(parts.map((part) => part.type)).toEqual(["text"]);
	});

	/** A reply of reasoning, text and function-call items, in order. */
	function itemsTurn(items: Array<"reasoning" | "text" | "preamble" | "call">) {
		const events: Array<Record<string, unknown>> = [
			{ type: "response.created", response: { id: "resp_5", created_at: 1, model: "m" } },
		];
		items.forEach((kind, index) => {
			const words = kind === "preamble" ? "Let me check the preview once more." : "Built it.";
			const item =
				kind === "reasoning"
					? { type: "reasoning", id: `rs_${index}`, encrypted_content: `enc_${index}`, summary: [] }
					: kind === "text" || kind === "preamble"
						? {
								type: "message",
								id: `msg_${index}`,
								role: "assistant",
								status: "completed",
								phase: kind === "preamble" ? "commentary" : "final_answer",
								content: [{ type: "output_text", text: words, annotations: [] }],
							}
						: {
								type: "function_call",
								id: `fc_${index}`,
								call_id: `call_${index}`,
								name: "write_file",
								arguments: "{}",
								status: "completed",
							};
			const added =
				kind === "text" || kind === "preamble"
					? { ...item, content: [] }
					: kind === "call"
						? { ...item, arguments: "" }
						: item;
			events.push({ type: "response.output_item.added", output_index: index, item: added });
			if (kind === "text" || kind === "preamble") {
				events.push({
					type: "response.output_text.delta",
					item_id: `msg_${index}`,
					output_index: index,
					delta: words,
				});
			}
			events.push({ type: "response.output_item.done", output_index: index, item });
		});
		events.push({
			type: "response.completed",
			response: {
				id: "resp_5",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		});
		return responseStream(events);
	}

	/**
	 * The reply as the builder saves it (its UI message), and what the next
	 * request sends back of it: OpenAI input items by type or role.
	 */
	async function savedAndSentBack(result: ReturnType<typeof summaryStep>["result"]) {
		let saved: UIMessage | undefined;
		for await (const message of readUIMessageStream({
			stream: toUIMessageStream({ stream: result.stream }),
		})) {
			saved = message;
		}
		const bodies: Array<{ input: Array<Record<string, unknown>> }> = [];
		const next = streamText({
			model: createBuilderModel(env, {
				fetch: async (_input, init) => {
					bodies.push(JSON.parse(String(init?.body)));
					return textTurn();
				},
			}),
			messages: await convertToModelMessages([
				{ id: "ask", role: "user", parts: [{ type: "text", text: "Summarise the build" }] },
				saved!,
				{ id: "next", role: "user", parts: [{ type: "text", text: "Next" }] },
			]),
			// As every build step asks: nothing stored, so reasoning goes back by value.
			providerOptions: builderProviderOptions("low"),
		});
		await next.consumeStream();
		return {
			shown: saved!.parts
				.filter((part) => part.type === "reasoning" || part.type === "text")
				.map((part) => part.type),
			sentBack: bodies[0]!.input.map((item) =>
				item.type === "reasoning" ? "reasoning" : String(item.role ?? item.type),
			),
		};
	}

	it.each<{
		reply: Array<"reasoning" | "text" | "preamble" | "call">;
		text: string;
		shown: string[];
		sentBack: string[];
	}>([
		// Reasoning that led to a dropped call, or to no text, still shows but is not sent
		// back: without the item it was produced with, OpenAI may refuse the request.
		{
			reply: ["reasoning", "call"],
			text: EMPTY_SUMMARY_REPLY,
			shown: ["reasoning", "text"],
			sentBack: ["user", "assistant", "user"],
		},
		{
			reply: ["reasoning", "text", "call"],
			text: "Built it.",
			shown: ["reasoning", "text"],
			sentBack: ["user", "reasoning", "assistant", "user"],
		},
		{
			reply: ["reasoning", "text", "reasoning", "call"],
			text: "Built it.",
			shown: ["reasoning", "text", "reasoning"],
			sentBack: ["user", "reasoning", "assistant", "user"],
		},
		{
			reply: ["reasoning", "call", "text"],
			text: "Built it.",
			shown: ["reasoning", "text"],
			sentBack: ["user", "assistant", "user"],
		},
		{
			reply: ["reasoning"],
			text: EMPTY_SUMMARY_REPLY,
			shown: ["reasoning", "text"],
			sentBack: ["user", "assistant", "user"],
		},
		// A preamble announces the call, which never happens: it goes with the call.
		{
			reply: ["reasoning", "preamble", "call"],
			text: EMPTY_SUMMARY_REPLY,
			shown: ["reasoning", "text"],
			sentBack: ["user", "assistant", "user"],
		},
		{
			reply: ["reasoning", "text", "preamble", "call"],
			text: "Built it.",
			shown: ["reasoning", "text"],
			sentBack: ["user", "reasoning", "assistant", "user"],
		},
		// Reasoning after a preamble keeps its place, and only what text follows goes back.
		{
			reply: ["reasoning", "preamble", "reasoning", "text"],
			text: "Let me check the preview once more.Built it.",
			shown: ["reasoning", "text", "reasoning", "text"],
			sentBack: ["user", "reasoning", "assistant", "reasoning", "assistant", "user"],
		},
		{
			reply: ["reasoning", "preamble", "reasoning"],
			text: "Let me check the preview once more.",
			shown: ["reasoning", "text", "reasoning"],
			sentBack: ["user", "reasoning", "assistant", "user"],
		},
		// The model's last words, with no call after them, are its reply.
		{
			reply: ["reasoning", "preamble"],
			text: "Let me check the preview once more.",
			shown: ["reasoning", "text"],
			sentBack: ["user", "reasoning", "assistant", "user"],
		},
	])(
		"sends back only the reasoning a summary step's own text follows: $reply",
		async ({ reply, text, shown, sentBack }) => {
			const { result, errors } = summaryStep(() => itemsTurn(reply));
			const outcome = await savedAndSentBack(result);

			expect(errors).toEqual([]);
			expect(await result.text).toBe(text);
			expect(outcome).toEqual({ shown, sentBack });
		},
	);

	it.each([
		{ ending: "an error", error: true, finish: "error" },
		{ ending: "a content filter", error: false, finish: "content-filter" },
	] as const)(
		"adds no closing reply to a summary step that ends in $ending",
		async ({ error, finish }) => {
			const parts = [
				{ type: "stream-start", warnings: [] },
				{ type: "reasoning-start", id: "rs_1:0" },
				{ type: "reasoning-end", id: "rs_1:0" },
				...(error ? [{ type: "error", error: new Error("The model failed.") }] : []),
				{
					type: "finish",
					finishReason: { unified: finish, raw: finish },
					usage: {
						inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 1, text: 1, reasoning: 0 },
					},
				},
			];
			const wrapped = await noToolCallsWhenNoneMiddleware.wrapStream!({
				doStream: async () => ({
					stream: new ReadableStream({
						start(controller) {
							for (const part of parts) controller.enqueue(part);
							controller.close();
						},
					}),
				}),
				doGenerate: async () => {
					throw new Error("not called");
				},
				params: { prompt: [], toolChoice: { type: "none" } },
				model: {} as never,
			} as never);
			const out: Array<{ type: string }> = [];
			const reader = wrapped.stream.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				out.push(value as { type: string });
			}

			expect(out.map((part) => part.type)).not.toContain("text-delta");
			expect(out.at(-1)).toMatchObject({ type: "finish", finishReason: { unified: finish } });
		},
	);

	it("still lets out what waited when a summary's stream ends without a finish", async () => {
		const parts = [
			{ type: "stream-start", warnings: [] },
			{ type: "reasoning-start", id: "rs_1:0" },
			{ type: "reasoning-end", id: "rs_1:0", providerMetadata: { openai: { itemId: "rs_1" } } },
			{ type: "text-start", id: "msg_1" },
			{ type: "text-delta", id: "msg_1", delta: " " },
		];
		const wrapped = await noToolCallsWhenNoneMiddleware.wrapStream!({
			doStream: async () => ({
				stream: new ReadableStream({
					start(controller) {
						for (const part of parts) controller.enqueue(part);
						controller.close();
					},
				}),
			}),
			doGenerate: async () => {
				throw new Error("not called");
			},
			params: { prompt: [], toolChoice: { type: "none" } },
			model: {} as never,
		} as never);
		const out: Array<{ type: string; providerMetadata?: unknown }> = [];
		const reader = wrapped.stream.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out.push(value as { type: string });
		}

		// The reasoning ends, without the item no text followed; the blank text stays out.
		expect(out.map((part) => part.type)).toEqual([
			"stream-start",
			"reasoning-start",
			"reasoning-end",
		]);
		expect(out.at(-1)).toMatchObject({ providerMetadata: {} });
	});

	it("lets a summary's text out as it streams, with the reasoning before it", async () => {
		let source!: ReadableStreamDefaultController<unknown>;
		const wrapped = await noToolCallsWhenNoneMiddleware.wrapStream!({
			doStream: async () => ({
				stream: new ReadableStream({
					start(controller) {
						source = controller;
					},
				}),
			}),
			doGenerate: async () => {
				throw new Error("not called");
			},
			params: { prompt: [], toolChoice: { type: "none" } },
			model: {} as never,
		} as never);
		const reader = wrapped.stream.getReader();
		const next = async () => ((await reader.read()).value as { type: string }).type;

		source.enqueue({ type: "reasoning-start", id: "rs_1:0" });
		// Reasoning shows while the model thinks.
		expect(await next()).toBe("reasoning-start");
		// The first summary part ends as the next begins, which shows too.
		source.enqueue({ type: "reasoning-end", id: "rs_1:0" });
		source.enqueue({ type: "reasoning-start", id: "rs_1:1" });
		source.enqueue({ type: "reasoning-delta", id: "rs_1:1", delta: "Checking the menu." });
		expect([await next(), await next()]).toEqual(["reasoning-start", "reasoning-delta"]);
		source.enqueue({ type: "reasoning-end", id: "rs_1:1" });
		source.enqueue({ type: "text-start", id: "msg_1" });
		source.enqueue({ type: "text-delta", id: "msg_1", delta: "Built it." });
		// The first words of the reply let out what waited, before the step ends.
		expect([await next(), await next(), await next(), await next()]).toEqual([
			"reasoning-end",
			"reasoning-end",
			"text-start",
			"text-delta",
		]);
		source.enqueue({ type: "text-delta", id: "msg_1", delta: " Have a look." });
		expect(await next()).toBe("text-delta");
		source.close();
		await reader.cancel();
	});

	it("answers a summary step of nothing but whitespace with the closing reply", async () => {
		const { result } = summaryStep(() =>
			responseStream([
				{ type: "response.created", response: { id: "resp_7", created_at: 1, model: "m" } },
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", content: [] },
				},
				{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "\n" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "\n", annotations: [] }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "resp_7",
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			]),
		);

		expect(await result.text).toBe(EMPTY_SUMMARY_REPLY);
	});

	it("gives a summary step that only calls a tool a closing reply", async () => {
		const { result, write, errors } = summaryStep(() => toolCallTurn("write_file"));
		await result.consumeStream();

		expect(errors).toEqual([]);
		expect(await result.finishReason).toBe("stop");
		expect(await result.text).toBe(EMPTY_SUMMARY_REPLY);
		expect(write).not.toHaveBeenCalled();
	});

	it.each([
		{ reasoning: false, preamble: false },
		{ reasoning: true, preamble: false },
		{ reasoning: true, preamble: true },
	])(
		"drops the tool call from a summary step that is not streamed (reasoning: $reasoning, preamble: $preamble)",
		async ({ reasoning, preamble }) => {
			const write = vi.fn(async () => ({ success: true }));
			const result = await generateText({
				model: createBuilderModel(env, {
					fetch: async () => toolCallResponse("write_file", reasoning, preamble),
				}),
				prompt: "Summarise the build",
				tools: { write_file: tool({ inputSchema: z.object({}), execute: write }) },
				toolChoice: "none",
			});

			expect(result.finishReason).toBe("stop");
			// A preamble announced the call, so it goes with it.
			expect(result.text).toBe(EMPTY_SUMMARY_REPLY);
			expect(result.toolCalls).toEqual([]);
			expect(result.content.map((part) => part.type)).toEqual(
				reasoning ? ["reasoning", "text"] : ["text"],
			);
			// It led to the dropped call: it shows, but is not sent back to OpenAI.
			const reasoningPart = result.content.find((part) => part.type === "reasoning");
			if (reasoning) expect(reasoningPart?.providerMetadata).toEqual({});
			expect(write).not.toHaveBeenCalled();
		},
	);

	it("leaves a step that may call tools as the model replied", async () => {
		const write = vi.fn(async () => ({ success: true }));
		const result = streamText({
			model: createBuilderModel(env, { fetch: async () => toolCallTurn("write_file") }),
			prompt: "Build the site",
			tools: { write_file: tool({ inputSchema: z.object({}), execute: write }) },
		});
		await result.consumeStream();

		expect(await result.finishReason).toBe("tool-calls");
		expect(await result.text).toBe("");
		expect(write).toHaveBeenCalledOnce();
	});

	it("asks for a reasoning summary only where one is read", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const model = createBuilderModel(env, {
			fetch: async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				return textTurn();
			},
		});
		for (const reasoningSummary of [true, false]) {
			await streamText({
				model,
				prompt: "Write",
				providerOptions: builderProviderOptions("low", { reasoningSummary }),
			}).consumeStream();
		}
		// @ai-sdk/openai 4 asks for a detailed summary unless told none is wanted.
		expect(bodies.map((body) => body.reasoning)).toEqual([
			{ effort: "low", summary: "auto" },
			{ effort: "low" },
		]);
	});

	it("sends the same tools every step and restricts calls through tool_choice", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		// The second reply ignores the required preview and edits instead, which
		// voids validation; the third step must carry no stale restriction.
		const turns = [() => toolCallTurn("validate_site"), () => toolCallTurn("write_file"), textTurn];
		const convergence = new BuildConvergence();
		const model = createBuilderModel(env, {
			fetch: async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body)));
				return turns.shift()!();
			},
		});
		const noop = tool({ inputSchema: z.object({}), execute: async () => ({ success: true }) });
		const tools = {
			exec: noop,
			validate_site: tool({
				inputSchema: z.object({}),
				execute: async () => {
					convergence.recordValidation(convergence.beginObservation()!, { success: true });
					return { success: true };
				},
			}),
			view_preview: noop,
			write_file: tool({
				inputSchema: z.object({}),
				execute: async () => {
					convergence.beginMutation()();
					return { success: true };
				},
			}),
		};
		const toolNames = Object.keys(tools) as Array<keyof typeof tools>;

		const result = streamText({
			model,
			prompt: "Build",
			tools,
			stopWhen: isStepCount(3),
			providerOptions: builderProviderOptions("medium", { promptCacheKey: "session-1" }),
			prepareStep: ({ messages, stepNumber }) =>
				prepareBuildTurnStep(convergence, messages, toolNames, {
					initialBuild: true,
					stepNumber,
				}),
		});
		await result.consumeStream();

		expect(bodies).toHaveLength(3);
		const toolLists = bodies.map((body) => JSON.stringify(body.tools));
		expect(new Set(toolLists).size).toBe(1);
		expect(bodies.map((body) => body.prompt_cache_key)).toEqual([
			"session-1",
			"session-1",
			"session-1",
		]);
		expect(bodies.map((body) => (body.reasoning as { effort?: string }).effort)).toEqual([
			"low",
			"low",
			"low",
		]);
		expect(bodies[0]?.tool_choice).toBe("auto");
		// Validation passed: the final preview is required, one call at a time.
		expect(bodies[1]?.tool_choice).toEqual({
			type: "allowed_tools",
			mode: "required",
			tools: [{ type: "function", name: "view_preview" }],
		});
		expect(bodies[1]?.parallel_tool_calls).toBe(false);
		expect(bodies[2]?.tool_choice).toBe("auto");
		expect(bodies[2]?.parallel_tool_calls).toBeUndefined();
	});

	it("drops tool restrictions and the cache key once a gateway rejects them", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const model = createBuilderModel(env, {
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				bodies.push(body);
				const choice = body.tool_choice as { type?: unknown } | undefined;
				if (body.prompt_cache_key !== undefined || choice?.type === "allowed_tools") {
					return new Response(
						JSON.stringify({
							error: { message: "Unknown parameter: 'tool_choice.allowed_tools'." },
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				}
				return completedResponse();
			},
		});
		const { generateText } = await import("ai");
		const call = () =>
			generateText({
				model,
				prompt: "hi",
				maxRetries: 0,
				tools: {
					view_preview: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
				},
				providerOptions: {
					openai: {
						promptCacheKey: "session-1",
						allowedTools: { toolNames: ["view_preview"], mode: "required" },
					},
				},
			});

		await expect(call()).resolves.toMatchObject({ text: "ok" });
		await expect(call()).resolves.toMatchObject({ text: "ok" });

		// The rejected request is re-sent once with a plain forced tool instead,
		// and later requests from the same model skip the unsupported fields.
		expect(bodies).toHaveLength(3);
		expect(bodies[1]).not.toHaveProperty("prompt_cache_key");
		expect(bodies[1]?.tool_choice).toEqual({ type: "function", name: "view_preview" });
		expect(bodies[2]).not.toHaveProperty("prompt_cache_key");
		expect(bodies[2]?.tool_choice).toEqual({ type: "function", name: "view_preview" });
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("recognises the rejected parameter from the error's param field", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const model = createBuilderModel(env, {
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				bodies.push(body);
				if ("parallel_tool_calls" in body) {
					return new Response(
						JSON.stringify({
							error: { message: "Unsupported parameter.", param: "parallel_tool_calls" },
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				}
				return completedResponse();
			},
		});
		const { generateText } = await import("ai");

		await expect(
			generateText({
				model,
				prompt: "hi",
				maxRetries: 0,
				tools: { view_preview: tool({ inputSchema: z.object({}), execute: async () => ({}) }) },
				providerOptions: {
					openai: {
						allowedTools: { toolNames: ["view_preview"], mode: "required" },
						parallelToolCalls: false,
					},
				},
			}),
		).resolves.toMatchObject({ text: "ok" });
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).not.toHaveProperty("parallel_tool_calls");
		warn.mockRestore();
	});

	it("keeps using the optional fields when a reduced retry fails too", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const model = createBuilderModel(env, {
			fetch: async (_input, init) => {
				bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				// A failure that mentions tool_choice but is not caused by these fields.
				return new Response(
					JSON.stringify({ error: { message: "tool_choice requires at least one tool." } }),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			},
		});
		const { generateText } = await import("ai");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const call = () =>
			generateText({
				model,
				prompt: "hi",
				maxRetries: 0,
				providerOptions: { openai: { promptCacheKey: "session-1" } },
			});

		await expect(call()).rejects.toThrow();
		await expect(call()).rejects.toThrow();
		// Each request tried the reduced form once, and the next still led with the key.
		expect(bodies.map((body) => "prompt_cache_key" in body)).toEqual([true, false, true, false]);
		warn.mockRestore();
	});

	it("keeps a 400 that is not about the optional fields", async () => {
		let requests = 0;
		const model = createBuilderModel(env, {
			fetch: async () => {
				requests += 1;
				return new Response(JSON.stringify({ error: { message: "Invalid input image." } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			},
		});
		const { generateText } = await import("ai");

		await expect(
			generateText({
				model,
				prompt: "hi",
				maxRetries: 0,
				providerOptions: { openai: { promptCacheKey: "session-1" } },
			}),
		).rejects.toThrow("Invalid input image");
		expect(requests).toBe(1);
	});
});
