// Finds a gateway route that runs a Claude model with adaptive thinking at a
// chosen effort: each route is tried at low and high effort with one tool,
// and output tokens should rise with effort.
import { devVars } from "./dev-vars.mjs";

const env = { ...devVars(), ...process.env };
const account = env.AI_GATEWAY_ACCOUNT_ID;
const gateway = env.AI_GATEWAY_ID;
const token = env.AI_GATEWAY_TOKEN;
const model = process.argv[2] ?? "anthropic/claude-haiku-5.5";
const bare = model.split("/").pop();
const anthropicId = bare.replaceAll(".", "-");

const PUZZLE =
	"A bakery sold 40 items: loaves at £5 and buns at £3, taking £164. How many loaves? Call record_answer with the number.";
const schema = {
	type: "object",
	properties: { loaves: { type: "integer" } },
	required: ["loaves"],
	additionalProperties: false,
};
const unified = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`;
const unifiedHeaders = { Authorization: `Bearer ${token}`, "cf-aig-gateway-id": gateway };

const messagesBody = (id, effort) => ({
	model: id,
	max_tokens: 16_000,
	thinking: { type: "adaptive", display: "summarized" },
	output_config: { effort },
	tools: [{ name: "record_answer", description: "Record the answer.", input_schema: schema }],
	messages: [{ role: "user", content: PUZZLE }],
});

const routes = {
	nativeMessages: (effort) => ({
		url: `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/anthropic/v1/messages`,
		headers: { "cf-aig-authorization": `Bearer ${token}`, "anthropic-version": "2023-06-01" },
		body: messagesBody(anthropicId, effort),
	}),
	unifiedMessages: (effort) => ({
		url: `${unified}/messages`,
		headers: { ...unifiedHeaders, "anthropic-version": "2023-06-01" },
		body: messagesBody(model, effort),
	}),
	unifiedChat: (effort) => ({
		url: `${unified}/chat/completions`,
		headers: unifiedHeaders,
		body: {
			model,
			reasoning_effort: effort,
			messages: [{ role: "user", content: PUZZLE }],
			tools: [{ type: "function", function: { name: "record_answer", parameters: schema } }],
		},
	}),
	responsesPassthrough: (effort) => ({
		url: `${unified}/responses`,
		headers: unifiedHeaders,
		body: {
			model,
			input: PUZZLE,
			max_output_tokens: 16_000,
			thinking: { type: "adaptive" },
			output_config: { effort },
			tools: [{ type: "function", name: "record_answer", parameters: schema }],
		},
	}),
};

for (const [name, build] of Object.entries(routes)) {
	for (const effort of ["low", "high"]) {
		const { url, headers, body } = build(effort);
		const started = Date.now();
		let line;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(120_000),
			});
			const text = await response.text();
			let json;
			try {
				json = JSON.parse(text);
			} catch {}
			const usage = json?.usage;
			line = {
				status: response.status,
				outputTokens: usage?.output_tokens ?? usage?.completion_tokens,
				reasoningTokens:
					usage?.output_tokens_details?.reasoning_tokens ??
					usage?.completion_tokens_details?.reasoning_tokens,
				cacheRead: usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens,
				served: json?.model,
				blocks: json?.content?.map((block) => block.type) ?? json?.output?.map((item) => item.type),
				error: response.ok ? undefined : text.slice(0, 300),
			};
		} catch (error) {
			line = { error: String(error?.message ?? error) };
		}
		console.log(JSON.stringify({ route: name, effort, ms: Date.now() - started, ...line }));
	}
}
