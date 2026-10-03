import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { prepareBuildStep, type BuildConvergence } from "./build-convergence.js";

export const BUILDER_MODEL_ID = "openai/gpt-5.6-luna";

export type BuilderReasoningEffort = "low" | "medium" | "high";

/**
 * Reasoning effort by phase. At high effort Luna thinks for several seconds
 * before every step's first answer token, and a build runs dozens of steps in
 * sequence, so high effort is spent only where one step's decisions shape the
 * rest of the turn.
 */
export const BUILDER_REASONING_EFFORT = {
	/** Choosing questions that change the content model; the user waits on them. */
	interview: "medium",
	/** A one-sentence acknowledgement while setup continues. */
	holding: "low",
	/** The first step of a first build plans the content model, design and schema. */
	plan: "high",
	/** Later first-build steps: authoring, content, and validation fixes. */
	build: "medium",
	followUp: "medium",
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
			...(reasoningSummary ? { reasoningSummary: "auto" } : {}),
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
	return gateway.responses(BUILDER_MODEL_ID);
}

/** The reasoning effort a step's provider options request, for turn metrics. */
export function requestedReasoningEffort(providerOptions: unknown): string | undefined {
	if (providerOptions === null || typeof providerOptions !== "object") return undefined;
	const openai = (providerOptions as { openai?: unknown }).openai;
	if (openai === null || typeof openai !== "object") return undefined;
	const effort = (openai as { reasoningEffort?: unknown }).reasoningEffort;
	return typeof effort === "string" ? effort : undefined;
}
