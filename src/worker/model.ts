import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModelMiddleware, type ModelMessage } from "ai";
import { prepareBuildStep, type BuildConvergence } from "./build-convergence.js";

export const BUILDER_MODEL_ID = "openai/gpt-6.1-terra";

export type BuilderReasoningEffort = "low" | "medium" | "high";

/**
 * Reasoning effort by phase. In a local benchmark, Terra at low effort on every
 * step built first sites in less than half the time GPT-6 Luna took at higher
 * per-phase efforts; the design-score comparison was inconclusive. Each phase
 * keeps its own setting so one can be raised alone.
 */
export const BUILDER_REASONING_EFFORT = {
	/** Choosing questions that change the content model; the user waits on them. */
	interview: "low",
	/** A one-sentence acknowledgement while setup continues. */
	holding: "low",
	/** The first step of a first build plans the content model, design and schema. */
	plan: "low",
	/** Later first-build steps: authoring, content, and validation fixes. */
	build: "low",
	followUp: "low",
	/** Drafting entry bodies inside create_entries_batch. */
	entryBody: "low",
} as const satisfies Record<string, BuilderReasoningEffort>;

export function builderProviderOptions(
	effort: BuilderReasoningEffort,
	{
		reasoningSummary = true,
		promptCacheKey,
	}: {
		reasoningSummary?: boolean;
		/** Routes a session's requests to the same prompt cache. */
		promptCacheKey?: string;
	} = {},
) {
	return {
		openai: {
			forceReasoning: true,
			reasoningEffort: effort,
			// @ai-sdk/openai 4 asks for a detailed summary when this is left out.
			reasoningSummary: reasoningSummary ? "auto" : null,
			...(promptCacheKey ? { promptCacheKey } : {}),
			store: false,
		} satisfies OpenAIResponsesProviderOptions,
	};
}

/**
 * Effort for one build step. Changing effort changes the cached prompt prefix,
 * so a first-build turn switches once, after its first step, rather than per
 * step. A resumed first build plans again: its first step may still face an
 * unplanned site.
 */
export function buildStepReasoningEffort(step: {
	initialBuild: boolean;
	stepNumber: number;
}): BuilderReasoningEffort {
	if (!step.initialBuild) return BUILDER_REASONING_EFFORT.followUp;
	return step.stepNumber === 0 ? BUILDER_REASONING_EFFORT.plan : BUILDER_REASONING_EFFORT.build;
}

/** A build step's provider options, merged by the SDK over the turn's base options. */
export function buildStepProviderOptions(step: {
	initialBuild: boolean;
	stepNumber: number;
	allowedTools?: { toolNames: string[]; mode: "auto" | "required" };
}) {
	return {
		openai: {
			reasoningEffort: buildStepReasoningEffort(step),
			...(step.allowedTools ? { allowedTools: step.allowedTools } : {}),
			// A forced tool is one call, as tool_choice for a single function was.
			...(step.allowedTools?.mode === "required" ? { parallelToolCalls: false } : {}),
		} satisfies OpenAIResponsesProviderOptions,
	};
}

/** One build step's settings: convergence gating plus this step's provider options. */
export function prepareBuildTurnStep<TOOL_NAME extends string>(
	convergence: BuildConvergence,
	messages: ModelMessage[],
	toolNames: readonly TOOL_NAME[],
	step: { initialBuild: boolean; stepNumber: number },
) {
	const { allowedTools, ...prepared } = prepareBuildStep(convergence, messages, toolNames);
	return {
		...prepared,
		providerOptions: buildStepProviderOptions({ ...step, allowedTools }),
	};
}

/** The optional request fields below, as a gateway's error names them. */
const OPTIONAL_FIELD_ERROR = /allowed_tools|prompt_cache_key|parallel_tool_calls|tool_choice/i;

/** Whether a 400 body blames one of the optional fields, by its `param` when it names one. */
function rejectsOptionalFields(detail: string): boolean {
	try {
		const param = (JSON.parse(detail) as { error?: { param?: unknown } }).error?.param;
		if (typeof param === "string") return OPTIONAL_FIELD_ERROR.test(param);
	} catch {
		// Not JSON: fall back to the message text.
	}
	return OPTIONAL_FIELD_ERROR.test(detail);
}

/**
 * The request without fields an OpenAI-compatible gateway may not accept, or
 * undefined when it has none. A single required tool becomes a plain forced
 * tool; other restrictions are dropped, and exec refuses by itself while
 * validation is current.
 */
function withoutOptionalRequestFields(
	body: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const next = { ...body };
	let changed = false;
	for (const field of ["prompt_cache_key", "parallel_tool_calls"]) {
		if (!(field in next)) continue;
		delete next[field];
		changed = true;
	}
	const choice = next.tool_choice as
		| { type?: unknown; mode?: unknown; tools?: Array<{ type?: unknown; name?: unknown }> }
		| undefined;
	if (choice !== null && typeof choice === "object" && choice.type === "allowed_tools") {
		const tools = Array.isArray(choice.tools) ? choice.tools : [];
		const only = tools.length === 1 ? tools[0] : undefined;
		if (choice.mode === "required" && only?.type === "function" && typeof only.name === "string") {
			next.tool_choice = { type: "function", name: only.name };
		} else if (choice.mode === "required") {
			next.tool_choice = "required";
		} else {
			delete next.tool_choice;
		}
		changed = true;
	}
	return changed ? next : undefined;
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> | undefined {
	if (typeof init?.body !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(init.body);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;
type GenerateResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>>;

const TOOL_CALL_PARTS = new Set([
	"tool-input-start",
	"tool-input-delta",
	"tool-input-end",
	"tool-call",
]);

function warnDroppedToolCalls() {
	console.warn(
		"[builder-model] The model called a tool on a step that allows none; the call was dropped.",
	);
}

/**
 * The reply of a step that allows no tool and ended with no text. Only the
 * build's closing summary allows none; it may follow checks that still fail
 * or a preview that could not be captured, so the reply claims nothing.
 */
export const EMPTY_SUMMARY_REPLY = "Check the preview and tell me what you'd like to change next.";
const EMPTY_SUMMARY_TEXT_ID = "builder-empty-summary";

/** Whether a text part is a preamble: what the model says before a tool call. */
function isPreamble(part: { providerMetadata?: Record<string, unknown> }): boolean {
	const openai = part.providerMetadata?.openai as { phase?: unknown } | undefined;
	return openai?.phase === "commentary";
}

/**
 * Keeps a step whose tool choice is "none" free of tool calls, and never
 * silent. AI SDK 7 fails a step whose reply breaks its tool choice, and the
 * build's closing summary step allows no tool, so a model that calls one
 * anyway would fail the build. The call is dropped instead, with any preamble
 * announcing it, and the step ends as a stop, which is what "none" asks for.
 * A step that stops cleanly with no text gets EMPTY_SUMMARY_REPLY, so the
 * build does not end with a blank message.
 *
 * The builder does not store responses, so saved reasoning goes back to
 * OpenAI with later requests, by its item id and encrypted content. Reasoning
 * that led to a dropped call, or to no text, would go back without the item
 * it was produced with, which OpenAI can refuse. Such reasoning still shows,
 * but its end carries no OpenAI metadata, so it is never sent back.
 */
export const noToolCallsWhenNoneMiddleware: LanguageModelMiddleware = {
	specificationVersion: "v4",
	async wrapStream({ doStream, params }) {
		const result = await doStream();
		if (params.toolChoice?.type !== "none") return result;
		let dropped = false;
		let wroteText = false;
		let failed = false;
		// Reasoning ends, and from a text start on everything, wait here in order
		// until it is known what follows: the model's text, a dropped call, or nothing.
		let queue: StreamPart[] = [];
		const queuedText = new Map<string, { preamble: boolean }>();
		// Text items let out or dropped while still streaming.
		const released = new Set<string>();
		const discarded = new Set<string>();
		const resolve = (
			controller: TransformStreamDefaultController<StreamPart>,
			follows: "nothing" | "call",
		) => {
			const hasText = new Set<string>();
			const ended = new Set<string>();
			for (const part of queue) {
				if (part.type === "text-delta" && part.delta.trim()) hasText.add(part.id);
				if (part.type === "text-end") ended.add(part.id);
			}
			// From the end: a text item stays if it has text and is not a preamble a
			// dropped call follows; a reasoning end goes back to OpenAI only if text follows it.
			const keptText = new Set<string>();
			const decided = new Set<string>();
			const sentBack = new Set<number>();
			let next: "nothing" | "text" | "call" = follows;
			for (let index = queue.length - 1; index >= 0; index--) {
				const part = queue[index]!;
				if (part.type === "reasoning-end") {
					if (next === "text") sentBack.add(index);
				} else if (
					(part.type === "text-start" || part.type === "text-delta" || part.type === "text-end") &&
					!decided.has(part.id)
				) {
					decided.add(part.id);
					const preamble = queuedText.get(part.id)?.preamble ?? false;
					if (hasText.has(part.id) && !(preamble && next === "call")) {
						keptText.add(part.id);
						next = "text";
					}
				}
			}
			queue.forEach((part, index) => {
				if (part.type === "reasoning-end") {
					controller.enqueue(sentBack.has(index) ? part : { ...part, providerMetadata: {} });
				} else if (
					part.type === "text-start" ||
					part.type === "text-delta" ||
					part.type === "text-end"
				) {
					if (keptText.has(part.id)) controller.enqueue(part);
				} else {
					controller.enqueue(part);
				}
			});
			for (const id of decided) {
				if (ended.has(id)) continue;
				if (keptText.has(id)) released.add(id);
				else discarded.add(id);
			}
			if (keptText.size > 0) wroteText = true;
			queue = [];
			queuedText.clear();
		};
		return {
			...result,
			stream: result.stream.pipeThrough(
				new TransformStream<StreamPart, StreamPart>({
					transform(part, controller) {
						if (TOOL_CALL_PARTS.has(part.type)) {
							if (!dropped) warnDroppedToolCalls();
							dropped = true;
							resolve(controller, "call");
							return;
						}
						if (part.type === "error") failed = true;
						if (part.type === "finish") {
							resolve(controller, "nothing");
							const finish =
								dropped && part.finishReason.unified === "tool-calls"
									? { ...part, finishReason: { ...part.finishReason, unified: "stop" as const } }
									: part;
							if (!wroteText && !failed && finish.finishReason.unified === "stop") {
								const id = EMPTY_SUMMARY_TEXT_ID;
								controller.enqueue({ type: "text-start", id });
								controller.enqueue({ type: "text-delta", id, delta: EMPTY_SUMMARY_REPLY });
								controller.enqueue({ type: "text-end", id });
							}
							controller.enqueue(finish);
							return;
						}
						if (part.type === "text-delta" || part.type === "text-end") {
							if (released.has(part.id) || discarded.has(part.id)) {
								if (released.has(part.id)) controller.enqueue(part);
								if (part.type === "text-end") {
									released.delete(part.id);
									discarded.delete(part.id);
								}
								return;
							}
						}
						// Reasoning streams live until a text item waits: a part goes where its start
						// arrives, so only a start after a held text start could land out of order.
						if (
							queuedText.size === 0 &&
							part.type !== "reasoning-end" &&
							part.type !== "text-start"
						) {
							controller.enqueue(part);
							return;
						}
						queue.push(part);
						if (part.type === "text-start") queuedText.set(part.id, { preamble: isPreamble(part) });
						// The model's own text: what waited before it is part of its reply.
						if (
							part.type === "text-delta" &&
							part.delta.trim() &&
							queuedText.get(part.id)?.preamble === false
						) {
							resolve(controller, "nothing");
						}
					},
					// A stream that ends without a finish part still lets out what waited.
					flush(controller) {
						resolve(controller, "nothing");
					},
				}),
			),
		};
	},
	async wrapGenerate({ doGenerate, params }) {
		const result: GenerateResult = await doGenerate();
		if (params.toolChoice?.type !== "none") return result;
		const dropped = result.content.some((part) => part.type === "tool-call");
		if (dropped) warnDroppedToolCalls();
		// From the end, by what follows each part: reasoning goes back to OpenAI
		// only where the model's text follows it, and a preamble goes with its call.
		const content: GenerateResult["content"] = [];
		let follows: "nothing" | "text" | "call" = "nothing";
		for (const part of [...result.content].reverse()) {
			if (part.type === "tool-call") {
				follows = "call";
				continue;
			}
			if (part.type === "text") {
				if (!part.text.trim() || (isPreamble(part) && follows === "call")) continue;
				follows = "text";
			}
			content.unshift(
				part.type === "reasoning" && follows !== "text" ? { ...part, providerMetadata: {} } : part,
			);
		}
		const finishReason =
			dropped && result.finishReason.unified === "tool-calls"
				? { ...result.finishReason, unified: "stop" as const }
				: result.finishReason;
		const wroteText = content.some((part) => part.type === "text");
		return {
			...result,
			content:
				wroteText || finishReason.unified !== "stop"
					? content
					: [...content, { type: "text", text: EMPTY_SUMMARY_REPLY }],
			finishReason,
		};
	},
};

type GatewayEnv = Pick<Env, "AI_GATEWAY_TOKEN" | "AI_GATEWAY_ACCOUNT_ID" | "AI_GATEWAY_ID">;

export interface BuilderModelOptions {
	/** AI Gateway custom metadata, so gateway logs can be joined to builder turns. */
	metadata?: Record<string, string | number | boolean>;
	/** Called once per HTTP attempt, retries included; 0 means the request failed. */
	onResponse?: (status: number) => void;
	fetch?: typeof fetch;
}

/** Create the frontier model routed through the configured Cloudflare AI Gateway. */
export function createBuilderModel(env: GatewayEnv, options: BuilderModelOptions = {}) {
	const baseFetch = options.fetch ?? fetch;
	const onResponse = options.onResponse;
	const attempt = async (input: RequestInfo | URL, init?: RequestInit) => {
		let response: Response;
		try {
			response = await baseFetch(input, init);
		} catch (error) {
			// A Stop is not a network error.
			if (!init?.signal?.aborted) onResponse?.(0);
			throw error;
		}
		onResponse?.(response.status);
		return response;
	};
	// Set once a request succeeds without the optional fields after the full
	// request was rejected for them; later requests from this model omit them.
	let optionalFieldsRejected = false;
	const gatewayFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = jsonBody(init);
		const reduced = body ? withoutOptionalRequestFields(body) : undefined;
		if (optionalFieldsRejected && reduced) {
			return attempt(input, { ...init, body: JSON.stringify(reduced) });
		}
		const response = await attempt(input, init);
		if (response.status !== 400 || !reduced) return response;
		const detail = await response
			.clone()
			.text()
			.catch(() => "");
		if (!rejectsOptionalFields(detail)) return response;
		console.warn(
			"[builder-model] The gateway rejected an optional request field; retrying without the optional fields:",
			detail.slice(0, 300),
		);
		const retried = await attempt(input, { ...init, body: JSON.stringify(reduced) });
		if (retried.ok) optionalFieldsRejected = true;
		return retried;
	};
	const gateway = createOpenAI({
		apiKey: env.AI_GATEWAY_TOKEN,
		baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.AI_GATEWAY_ACCOUNT_ID}/ai/v1`,
		headers: {
			"cf-aig-gateway-id": env.AI_GATEWAY_ID,
			...(options.metadata ? { "cf-aig-metadata": JSON.stringify(options.metadata) } : {}),
		},
		fetch: gatewayFetch,
	});
	return wrapLanguageModel({
		model: gateway.responses(BUILDER_MODEL_ID),
		middleware: noToolCallsWhenNoneMiddleware,
	});
}

/** The reasoning effort a step's provider options request, for turn metrics. */
export function requestedReasoningEffort(providerOptions: unknown): string | undefined {
	if (providerOptions === null || typeof providerOptions !== "object") return undefined;
	const openai = (providerOptions as { openai?: unknown }).openai;
	if (openai === null || typeof openai !== "object") return undefined;
	const effort = (openai as { reasoningEffort?: unknown }).reasoningEffort;
	return typeof effort === "string" ? effort : undefined;
}
