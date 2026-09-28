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

/** Create the frontier model routed through the configured Cloudflare AI Gateway. */
export function createBuilderModel(env: GatewayEnv) {
	const gateway = createOpenAI({
		apiKey: env.AI_GATEWAY_TOKEN,
		baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.AI_GATEWAY_ACCOUNT_ID}/ai/v1`,
		headers: {
			"cf-aig-gateway-id": env.AI_GATEWAY_ID,
		},
	});
	return gateway.responses(BUILDER_MODEL_ID);
}
