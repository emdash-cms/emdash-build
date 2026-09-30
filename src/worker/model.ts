import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

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
	{ reasoningSummary = true }: { reasoningSummary?: boolean } = {},
) {
	return {
		openai: {
			forceReasoning: true,
			reasoningEffort: effort,
			...(reasoningSummary ? { reasoningSummary: "auto" } : {}),
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
export function buildStepProviderOptions(step: { initialBuild: boolean; stepNumber: number }) {
	return { openai: { reasoningEffort: buildStepReasoningEffort(step) } };
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
	const gateway = createOpenAI({
		apiKey: env.AI_GATEWAY_TOKEN,
		baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.AI_GATEWAY_ACCOUNT_ID}/ai/v1`,
		headers: {
			"cf-aig-gateway-id": env.AI_GATEWAY_ID,
			...(options.metadata ? { "cf-aig-metadata": JSON.stringify(options.metadata) } : {}),
		},
		...(onResponse || options.fetch
			? {
					fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
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
					},
				}
			: {}),
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
