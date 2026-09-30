import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

export const BUILDER_MODEL_ID = "openai/gpt-5.6-luna";

export const BUILDER_PROVIDER_OPTIONS = {
	openai: {
		forceReasoning: true,
		reasoningEffort: "high",
		reasoningSummary: "auto",
		store: false,
	} satisfies OpenAIResponsesProviderOptions,
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
