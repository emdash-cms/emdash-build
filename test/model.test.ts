import { describe, expect, it } from "vitest";
import { stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { vi } from "vitest";
import { z } from "zod";
import { BuildConvergence } from "../src/worker/build-convergence.js";
import {
	BUILDER_MODEL_ID,
	BUILDER_REASONING_EFFORT,
	buildStepProviderOptions,
	buildStepReasoningEffort,
	builderModelChoices,
	builderProvider,
	builderProviderOptions,
	createBuilderModel,
	prepareBuildTurnStep,
	turnInputMessages,
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
	it("uses Luna without stored response references", () => {
		expect(BUILDER_MODEL_ID).toBe("openai/gpt-5.6-luna");
		expect(builderProviderOptions("medium").openai).toEqual({
			forceReasoning: true,
			reasoningEffort: "medium",
			reasoningSummary: "auto",
			store: false,
		});
		expect(builderProviderOptions("high", { promptCacheKey: "session-1" }).openai).toMatchObject({
			promptCacheKey: "session-1",
		});
		// Nobody reads a sub-call's reasoning, so it asks for no summary.
		expect(builderProviderOptions("low", { reasoningSummary: false }).openai).toEqual({
			forceReasoning: true,
			reasoningEffort: "low",
			store: false,
		});
	});

	it("gives Claude adaptive thinking at the same effort, with automatic caching", () => {
		expect(builderProviderOptions("high").anthropic).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			effort: "high",
			cacheControl: { type: "ephemeral" },
		});
		expect(builderProviderOptions("low", { reasoningSummary: false }).anthropic).toEqual({
			thinking: { type: "adaptive" },
			effort: "low",
			cacheControl: { type: "ephemeral" },
		});
		expect(builderProvider("anthropic/claude-opus-5.5")).toBe("anthropic");
		expect(builderProvider(BUILDER_MODEL_ID)).toBe("openai");
	});

	it("spends high effort only where a step shapes the rest of the build", () => {
		expect(BUILDER_REASONING_EFFORT).toEqual({
			interview: "medium",
			holding: "low",
			plan: "high",
			build: "medium",
			followUp: "medium",
			entryBody: "low",
		});
		expect(buildStepReasoningEffort({ initialBuild: true, stepNumber: 0 })).toBe("high");
		expect(buildStepReasoningEffort({ initialBuild: true, stepNumber: 1 })).toBe("medium");
		expect(buildStepReasoningEffort({ initialBuild: true, stepNumber: 40 })).toBe("medium");
		expect(buildStepReasoningEffort({ initialBuild: false, stepNumber: 0 })).toBe("medium");
		expect(buildStepReasoningEffort({ initialBuild: false, stepNumber: 3 })).toBe("medium");
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
				reasoningEffort: "medium",
				allowedTools: { toolNames: ["view_preview"], mode: "required" },
				parallelToolCalls: false,
			},
			anthropic: { effort: "medium", disableParallelToolUse: true },
		});
		expect(buildStepProviderOptions({ initialBuild: false, stepNumber: 4 })).toEqual({
			openai: { reasoningEffort: "medium" },
			anthropic: { effort: "medium" },
		});
	});

	it("forces Claude's tool through tool choice and leaves a narrowed set to exec's own refusal", () => {
		const toolNames = ["exec", "write_file", "view_preview"] as const;
		const validated = new BuildConvergence();
		validated.recordValidation(validated.beginObservation()!, { success: true });
		const step = { initialBuild: true, stepNumber: 5 };

		const claude = prepareBuildTurnStep(validated, [], toolNames, {
			...step,
			provider: "anthropic",
		});
		const luna = prepareBuildTurnStep(validated, [], toolNames, { ...step, provider: "openai" });

		expect(claude.toolChoice).toEqual({ type: "tool", toolName: "view_preview" });
		expect(claude.providerOptions.anthropic).toEqual({
			effort: "medium",
			disableParallelToolUse: true,
		});
		expect(luna.toolChoice).toBeUndefined();
		expect(luna.providerOptions.openai.allowedTools).toEqual({
			toolNames: ["view_preview"],
			mode: "required",
		});
		expect(claude).not.toHaveProperty("activeTools");
	});

	it("ends Claude's input at the latest user or tool message, not a prefill", () => {
		const brief = { role: "user" as const, content: "Build a bakery site" };
		const ack = { role: "assistant" as const, content: "I'll start building now." };
		const call = {
			role: "assistant" as const,
			content: [{ type: "tool-call" as const, toolCallId: "1", toolName: "exec", input: {} }],
		};
		const result = {
			role: "tool" as const,
			content: [
				{
					type: "tool-result" as const,
					toolCallId: "1",
					toolName: "exec",
					output: { type: "text" as const, value: "ok" },
				},
			],
		};

		expect(turnInputMessages([brief, ack], "anthropic")).toEqual([brief]);
		expect(turnInputMessages([brief, ack], "openai")).toEqual([brief, ack]);
		expect(turnInputMessages([brief, call, result], "anthropic")).toEqual([brief, call, result]);
	});

	it("sends Claude to the gateway's Anthropic endpoint, billed by the gateway", async () => {
		const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
		const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			});
			return new Response(
				JSON.stringify({
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "claude-opus-5-5",
					content: [{ type: "text", text: "ok" }],
					stop_reason: "end_turn",
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const { generateText } = await import("ai");
		const tools = {
			write_file: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
			view_preview: tool({ inputSchema: z.object({}), execute: async () => ({}) }),
		};
		const forcedPreview = {
			tools,
			prompt: "Build",
			toolChoice: { type: "tool" as const, toolName: "view_preview" as const },
			providerOptions: builderProviderOptions("high"),
		};

		await generateText({
			model: createBuilderModel(env, {
				fetch,
				modelId: "anthropic/claude-opus-5.5",
				metadata: { session: "s1" },
			}),
			...forcedPreview,
		});
		await generateText({
			model: createBuilderModel(env, { fetch, modelId: "anthropic/claude-haiku-5.5" }),
			...forcedPreview,
		});

		const [opus, haiku] = requests;
		expect(opus?.url).toBe(
			"https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
		);
		expect(opus?.headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
		expect(opus?.headers.has("x-api-key")).toBe(false);
		expect(JSON.parse(opus?.headers.get("cf-aig-metadata") ?? "null")).toEqual({ session: "s1" });
		expect(opus?.body).toMatchObject({
			model: "claude-opus-5-5",
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
			cache_control: { type: "ephemeral" },
		});
		// Opus 5.5 rejects forced tools: only the forced tool goes, unforced.
		expect(opus?.body.tool_choice).toMatchObject({ type: "auto" });
		expect((opus?.body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
			"view_preview",
		]);
		expect(haiku?.body.model).toBe("claude-haiku-5-5");
		expect(haiku?.body.tool_choice).toMatchObject({ type: "tool", name: "view_preview" });
		expect((haiku?.body.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
			"write_file",
			"view_preview",
		]);
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
			stopWhen: stepCountIs(3),
			providerOptions: builderProviderOptions(BUILDER_REASONING_EFFORT.build),
			prepareStep: ({ stepNumber }) => ({
				providerOptions: buildStepProviderOptions({ initialBuild: true, stepNumber }),
			}),
		});
		await result.consumeStream();

		// The step's effort replaces the base effort and keeps every other option.
		const base = { forceReasoning: true, reasoningSummary: "auto", store: false };
		expect(sent).toEqual([
			{ ...base, reasoningEffort: "high" },
			{ ...base, reasoningEffort: "medium" },
		]);
	});

	it("sends a comparison model id when one is chosen", async () => {
		const bodies: Array<Record<string, unknown>> = [];
		const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return completedResponse();
		};
		const { generateText } = await import("ai");

		await generateText({ model: createBuilderModel(env, { fetch }), prompt: "hi" });
		await generateText({
			model: createBuilderModel(env, { fetch, modelId: "openai/gpt-6-luna" }),
			prompt: "hi",
		});

		expect(bodies.map((body) => body.model)).toEqual([BUILDER_MODEL_ID, "openai/gpt-6-luna"]);
		expect(
			builderModelChoices({
				BUILDER_MODEL_CHOICES: " openai/gpt-6-luna, ,anthropic/claude-haiku-5-5 ",
			}),
		).toEqual(["openai/gpt-6-luna", "anthropic/claude-haiku-5-5"]);
		expect(builderModelChoices({})).toEqual([]);
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
			stopWhen: stepCountIs(3),
			providerOptions: builderProviderOptions("medium", { promptCacheKey: "session-1" }),
			prepareStep: ({ messages, stepNumber }) =>
				prepareBuildTurnStep(convergence, messages, toolNames, {
					initialBuild: true,
					stepNumber,
					provider: "openai",
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
			"high",
			"medium",
			"medium",
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
