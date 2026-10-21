// Checks, per model, that the builder's own request path works before a
// comparison spends hours on it: multi-step tool calls with reasoning replayed,
// effort that changes how much the model reasons, prompt caching, a forced
// tool, an edited history, and an image in a user message. Every request goes
// through the worker's createBuilderModel and provider options.
// Run: node --import ./scripts/model-comparison/ts-resolve.mjs scripts/model-comparison/probe.mjs [models] [checks]
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import {
	buildStepProviderOptions,
	builderProvider,
	builderProviderOptions,
	createBuilderModel,
} from "../../src/worker/model.ts";
import { devVars } from "./dev-vars.mjs";

const env = { ...devVars(), ...process.env };
const models = (
	process.argv[2] ?? "openai/gpt-6-luna,anthropic/claude-haiku-5.5,anthropic/claude-opus-5.5"
).split(",");
const only = process.argv[3]?.split(",");

const PUZZLE =
	"A bakery sold 40 items yesterday: loaves and buns. Look up both prices first, " +
	"then work out how many loaves it sold if takings were £164, and record the answer.";
const HARD =
	"How many integers from 1 to 10000 inclusive have digits that sum to exactly 20? Reply with the number only.";
const tools = {
	lookup_price: tool({
		description: "Look up the price of a bakery item in pounds.",
		inputSchema: z.object({ item: z.enum(["loaf", "bun"]) }),
		execute: async ({ item }) => ({ item, price: item === "loaf" ? 5 : 3 }),
	}),
	record_answer: tool({
		description: "Record the final number of loaves.",
		inputSchema: z.object({ loaves: z.number().int() }),
		execute: async ({ loaves }) => ({ recorded: loaves }),
	}),
};

// 8x8 solid red PNG.
const RED_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

function summarize(result, started) {
	return {
		ok: true,
		ms: Date.now() - started,
		steps: result.steps.length,
		finishReason: result.finishReason,
		toolCalls: result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
		usage: {
			input: result.totalUsage.inputTokens,
			cached: result.totalUsage.inputTokenDetails?.cacheReadTokens,
			output: result.totalUsage.outputTokens,
			reasoning: result.totalUsage.outputTokenDetails?.reasoningTokens,
		},
		reasoningChars: result.steps.reduce((sum, step) => sum + (step.reasoningText?.length ?? 0), 0),
		servedModel: result.response?.modelId,
		warnings: result.warnings?.map((warning) => warning.details ?? warning.type),
		text: result.text.slice(0, 120),
	};
}

const checks = {
	toolLoopLow: (model) =>
		generateText({
			model,
			tools,
			prompt: PUZZLE,
			stopWhen: stepCountIs(5),
			providerOptions: builderProviderOptions("low"),
		}),
	toolLoopHigh: (model) =>
		generateText({
			model,
			tools,
			prompt: PUZZLE,
			stopWhen: stepCountIs(5),
			providerOptions: builderProviderOptions("high"),
		}),
	effortLow: (model) =>
		generateText({ model, prompt: HARD, providerOptions: builderProviderOptions("low") }),
	effortHigh: (model) =>
		generateText({ model, prompt: HARD, providerOptions: builderProviderOptions("high") }),
	// Forced the way a build step forces a tool (see prepareBuildTurnStep).
	forcedTool: (model, id) => {
		const allowedTools = { toolNames: ["record_answer"], mode: "required" };
		const step = buildStepProviderOptions({ initialBuild: true, stepNumber: 1, allowedTools });
		const base = builderProviderOptions("medium");
		return generateText({
			model,
			tools,
			prompt: PUZZLE,
			stopWhen: stepCountIs(1),
			...(builderProvider(id) === "anthropic"
				? { toolChoice: { type: "tool", toolName: "record_answer" } }
				: {}),
			providerOptions: {
				openai: { ...base.openai, ...step.openai },
				anthropic: { ...base.anthropic, ...step.anthropic },
			},
		});
	},
	cachedPrefix: async (model) => {
		const system = Array.from(
			{ length: 400 },
			(_, i) => `Rule ${i}: keep bakery item ${i} priced in whole pence and list it once.`,
		).join("\n");
		const ask = (question) =>
			generateText({
				model,
				system,
				prompt: question,
				providerOptions: builderProviderOptions("low", {
					promptCacheKey: `probe-${Date.now() >> 16}`,
				}),
			});
		await ask("Which rule mentions item 7? Reply with its number only.");
		return ask("Which rule mentions item 9? Reply with its number only.");
	},
	// The builder rewrites earlier tool results every step (it drops superseded
	// screenshots). Providers that bind reasoning to unedited history may reject
	// or silently drop it; this replays an edited history across steps.
	editedHistory: (model) =>
		generateText({
			model,
			tools,
			prompt: PUZZLE,
			stopWhen: stepCountIs(5),
			providerOptions: builderProviderOptions("medium"),
			prepareStep: ({ messages }) => ({
				messages: messages.map((message) =>
					message.role !== "tool"
						? message
						: {
								...message,
								content: message.content.map((part) =>
									part.type === "tool-result"
										? {
												...part,
												output: {
													type: "text",
													value: `${JSON.stringify(part.output.value)} (earlier detail omitted)`,
												},
											}
										: part,
								),
							},
				),
			}),
		}),
	image: (model) =>
		generateText({
			model,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "What colour is this image? One word." },
						{ type: "file", data: RED_PNG, mediaType: "image/png" },
					],
				},
			],
			providerOptions: builderProviderOptions("low"),
		}),
};

for (const id of models) {
	const model = createBuilderModel(env, { modelId: id });
	for (const [check, run] of Object.entries(checks)) {
		if (only && !only.includes(check)) continue;
		const started = Date.now();
		let result;
		try {
			result = summarize(await run(model, id), started);
		} catch (error) {
			result = {
				ok: false,
				ms: Date.now() - started,
				error: String(error?.responseBody ?? error?.message ?? error).slice(0, 400),
			};
		}
		console.log(JSON.stringify({ model: id, check, ...result }));
	}
}
