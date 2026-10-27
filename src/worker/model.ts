import { createAnthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { ModelMessage } from "ai";
import { prepareBuildStep, type BuildConvergence } from "./build-convergence.js";

export const BUILDER_MODEL_ID = "openai/gpt-5.6-luna";

/**
 * Gateway model ids a local model comparison may pin per project, from the
 * comma-separated `BUILDER_MODEL_CHOICES`. Deployed config leaves it empty, so
 * production always builds with BUILDER_MODEL_ID.
 */
export function builderModelChoices(env: { BUILDER_MODEL_CHOICES?: string }): string[] {
	return (env.BUILDER_MODEL_CHOICES ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
}

/**
 * The choice a new local project pins when its first request names none, from
 * `BUILDER_MODEL_DEFAULT`, so the app's own UI can try a comparison model.
 * Deployed config leaves it empty.
 */
export function localDefaultChoice(env: { BUILDER_MODEL_DEFAULT?: string }): string | undefined {
	return env.BUILDER_MODEL_DEFAULT?.trim() || undefined;
}

/**
 * The models behind one builder choice. A choice is a gateway model id,
 * `<design>><build>`, or `<build>+<helper>`, optionally followed by speed
 * tags: `:fast`, `:low`, `:all-low`, or `:batched`. A design model plans a first build and writes its
 * design system, then hands off to the build model. A helper model runs the
 * build model's delegated tasks and entry bodies.
 */
export interface BuilderLineup {
	build: string;
	design?: string;
	helper?: string;
	/** `:fast`: the build model's own requests ask for fast output (Claude Opus only). */
	fast?: true;
	/** `:low`: effort for every build step after a first build's plan. */
	routineEffort?: BuilderReasoningEffort;
	/** `:all-low`: effort for every interview and build step, a first build's plan included. */
	effort?: BuilderReasoningEffort;
	/** `:batched`: the build prompt maps a first build onto as few steps as it can. */
	batchedSteps?: true;
}

export function parseBuilderLineup(choice: string): BuilderLineup {
	const [models = choice, ...tags] = choice.split(":");
	const unknown = tags.filter((tag) => !["fast", "low", "all-low", "batched"].includes(tag));
	if (unknown.length > 0) throw new Error(`Unknown builder choice tags: ${unknown.join(", ")}`);
	const [driver = models, helper] = models.split("+");
	const [design, build] = driver.split(">");
	return {
		...(build ? { design, build } : { build: driver }),
		...(helper ? { helper } : {}),
		...(tags.includes("fast") ? { fast: true as const } : {}),
		...(tags.includes("low") ? { routineEffort: "low" as const } : {}),
		...(tags.includes("all-low") ? { effort: "low" as const } : {}),
		...(tags.includes("batched") ? { batchedSteps: true as const } : {}),
	};
}

/**
 * The API a gateway model id is served through. Claude models go to the
 * gateway's Anthropic Messages endpoint: its Responses translation turns effort
 * into budgeted thinking, which Claude 5.5 models reject.
 */
export type BuilderProvider = "openai" | "anthropic";

export function builderProvider(modelId: string): BuilderProvider {
	return modelId.startsWith("anthropic/") ? "anthropic" : "openai";
}

/** The gateway lists `anthropic/claude-opus-5.5`; Anthropic's API names it `claude-opus-5-5`. */
function anthropicModelId(modelId: string): string {
	return modelId.slice("anthropic/".length).replaceAll(".", "-");
}

/**
 * The conversation as `provider` can take it. Reasoning is replayable only to
 * the provider that produced it, so a split build drops the other provider's.
 * Claude 5.5 models take no assistant prefill, but a first build that follows
 * an interview without questions continues the interview's own reply. For
 * Claude the turn's input ends at the latest user or tool message; the reply
 * stays in the stored conversation.
 */
export function turnInputMessages(
	messages: ModelMessage[],
	provider: BuilderProvider,
): ModelMessage[] {
	const own = messages.map((message) =>
		message.role === "assistant" && Array.isArray(message.content)
			? {
					...message,
					content: message.content.filter(
						(part) => part.type !== "reasoning" || part.providerOptions?.[provider] !== undefined,
					),
				}
			: message,
	);
	if (provider !== "anthropic") return own;
	let end = own.length;
	while (end > 0 && own[end - 1]?.role === "assistant") end -= 1;
	return own.slice(0, end);
}

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
	/** A helper running one delegated CMS or media task. */
	helper: "low",
} as const satisfies Record<string, BuilderReasoningEffort>;

export function builderProviderOptions(
	effort: BuilderReasoningEffort,
	{
		reasoningSummary = true,
		promptCacheKey,
		fast = false,
	}: {
		reasoningSummary?: boolean;
		/** Routes a session's requests to the same prompt cache. */
		promptCacheKey?: string;
		/** Fast output, at twice the price; Claude Opus only. */
		fast?: boolean;
	} = {},
) {
	// Each provider reads only its own key, so one value serves every model.
	return {
		openai: {
			forceReasoning: true,
			reasoningEffort: effort,
			...(reasoningSummary ? { reasoningSummary: "auto" } : {}),
			...(promptCacheKey ? { promptCacheKey } : {}),
			store: false,
		} satisfies OpenAIResponsesProviderOptions,
		anthropic: {
			thinking: { type: "adaptive", ...(reasoningSummary ? { display: "summarized" } : {}) },
			effort,
			// Automatic caching of the growing prefix, as OpenAI caches without being asked.
			cacheControl: { type: "ephemeral" },
			...(fast ? { speed: "fast" as const } : {}),
		} satisfies AnthropicLanguageModelOptions,
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
	routineEffort?: BuilderReasoningEffort;
	effort?: BuilderReasoningEffort;
}): BuilderReasoningEffort {
	if (step.effort) return step.effort;
	if (step.initialBuild && step.stepNumber === 0) return BUILDER_REASONING_EFFORT.plan;
	if (step.routineEffort) return step.routineEffort;
	return step.initialBuild ? BUILDER_REASONING_EFFORT.build : BUILDER_REASONING_EFFORT.followUp;
}

/** A build step's provider options, merged by the SDK over the turn's base options. */
export function buildStepProviderOptions(step: {
	initialBuild: boolean;
	stepNumber: number;
	routineEffort?: BuilderReasoningEffort;
	effort?: BuilderReasoningEffort;
	allowedTools?: { toolNames: string[]; mode: "auto" | "required" };
}) {
	const forced = step.allowedTools?.mode === "required";
	return {
		openai: {
			reasoningEffort: buildStepReasoningEffort(step),
			...(step.allowedTools ? { allowedTools: step.allowedTools } : {}),
			// A forced tool is one call, as tool_choice for a single function was.
			...(forced ? { parallelToolCalls: false } : {}),
		} satisfies OpenAIResponsesProviderOptions,
		anthropic: {
			effort: buildStepReasoningEffort(step),
			...(forced ? { disableParallelToolUse: true } : {}),
		} satisfies AnthropicLanguageModelOptions,
	};
}

/**
 * One build step's settings: convergence gating plus this step's provider
 * options. Anthropic has no allowed_tools, so a forced tool becomes a tool
 * choice (the SDK sends only that tool, unforced, to models that reject forced
 * tools), and a narrowed set is dropped as on gateways that reject the field:
 * exec refuses by itself while validation is current.
 */
export function prepareBuildTurnStep<TOOL_NAME extends string>(
	convergence: BuildConvergence,
	messages: ModelMessage[],
	toolNames: readonly TOOL_NAME[],
	step: {
		initialBuild: boolean;
		stepNumber: number;
		provider: BuilderProvider;
		routineEffort?: BuilderReasoningEffort;
		effort?: BuilderReasoningEffort;
	},
) {
	const { allowedTools, ...prepared } = prepareBuildStep(convergence, messages, toolNames);
	const forcedTool =
		step.provider === "anthropic" &&
		allowedTools?.mode === "required" &&
		allowedTools.toolNames.length === 1
			? allowedTools.toolNames[0]
			: undefined;
	return {
		...prepared,
		...(forcedTool ? { toolChoice: { type: "tool" as const, toolName: forcedTool } } : {}),
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

type GatewayEnv = Pick<Env, "AI_GATEWAY_TOKEN" | "AI_GATEWAY_ACCOUNT_ID" | "AI_GATEWAY_ID"> & {
	/**
	 * Local only. `provider` sends OpenAI models to the gateway's OpenAI endpoint
	 * instead of its unified API, which lists new models days after OpenAI does.
	 */
	AI_GATEWAY_OPENAI_ROUTE?: string;
};

export interface BuilderModelOptions {
	/** A gateway model id from `builderModelChoices`; BUILDER_MODEL_ID otherwise. */
	modelId?: string;
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
	const modelId = options.modelId ?? BUILDER_MODEL_ID;
	if (builderProvider(modelId) === "anthropic") {
		return createAnthropic({
			baseURL: `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic/v1`,
			// The gateway bills its own account; a provider key would replace that.
			apiKey: "gateway-billed",
			headers: {
				"cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
				...(options.metadata ? { "cf-aig-metadata": JSON.stringify(options.metadata) } : {}),
			},
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				headers.delete("x-api-key");
				return attempt(input, { ...init, headers });
			},
		}).messages(anthropicModelId(modelId));
	}
	if (env.AI_GATEWAY_OPENAI_ROUTE === "provider") {
		return createOpenAI({
			baseURL: `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/openai`,
			apiKey: "gateway-billed",
			headers: {
				"cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
				...(options.metadata ? { "cf-aig-metadata": JSON.stringify(options.metadata) } : {}),
			},
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				headers.delete("authorization");
				return gatewayFetch(input, { ...init, headers });
			},
		}).responses(modelId.replace(/^openai\//, ""));
	}
	const gateway = createOpenAI({
		apiKey: env.AI_GATEWAY_TOKEN,
		baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.AI_GATEWAY_ACCOUNT_ID}/ai/v1`,
		headers: {
			"cf-aig-gateway-id": env.AI_GATEWAY_ID,
			...(options.metadata ? { "cf-aig-metadata": JSON.stringify(options.metadata) } : {}),
		},
		fetch: gatewayFetch,
	});
	return gateway.responses(modelId);
}

/** The reasoning effort a step's provider options request, for turn metrics. */
export function requestedReasoningEffort(providerOptions: unknown): string | undefined {
	if (providerOptions === null || typeof providerOptions !== "object") return undefined;
	const openai = (providerOptions as { openai?: unknown }).openai;
	if (openai === null || typeof openai !== "object") return undefined;
	const effort = (openai as { reasoningEffort?: unknown }).reasoningEffort;
	return typeof effort === "string" ? effort : undefined;
}
