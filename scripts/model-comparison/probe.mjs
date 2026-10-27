// Checks, per model, that the builder's own request path works before a
// comparison spends hours on it: multi-step tool calls with reasoning replayed,
// effort that changes how much the model reasons, prompt caching, a forced
// tool, an edited history, and an image in a user message. Every request goes
// through the worker's createBuilderModel and provider options.
// Run: node --import ./scripts/model-comparison/ts-resolve.mjs scripts/model-comparison/probe.mjs [models] [checks]
import { generateText, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { BuildConvergence } from "../../src/worker/build-convergence.ts";
import {
	DesignHandoff,
	HAND_OFF_DESIGN,
	prepareSplitBuildStep,
} from "../../src/worker/design-handoff.ts";
import { createDelegateTool, DELEGATE } from "../../src/worker/helpers.ts";
import {
	buildStepProviderOptions,
	builderProvider,
	builderProviderOptions,
	createBuilderModel,
	parseBuilderLineup,
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

// A split build's hand-off on the real providers: the designer's tool calls and
// results reach the builder, the designer's reasoning does not, and the
// builder acts on the written spec.
async function handoffCheck(lineup) {
	const handoff = new DesignHandoff(lineup.design, lineup.build);
	const answers = [];
	const tools = {
		write_files: tool({
			description: "Write source files.",
			inputSchema: z.object({
				files: z.array(z.object({ path: z.string(), content: z.string() })),
			}),
			execute: async ({ files }) => ({ success: true, written: files.map((file) => file.path) }),
		}),
		[HAND_OFF_DESIGN]: tool({
			description: "Hand the build to the builder with the written design spec.",
			inputSchema: z.object({ spec: z.string() }),
			execute: async ({ spec }) => {
				handoff.handOff(spec);
				return { success: true };
			},
		}),
		record_answer: tool({
			description: "Record the builder's answer.",
			inputSchema: z.object({ accent: z.string(), stylesheet: z.string() }),
			execute: async (answer) => {
				answers.push(answer);
				return { recorded: true };
			},
		}),
	};
	const toolNames = Object.keys(tools);
	const system = (role) =>
		role === "designer"
			? "You are the designer. Write /src/styles/global.css with write_files, choosing one accent colour as a hex token, then call hand_off_design with a short spec naming that accent. Do not call record_answer."
			: "You are the builder. The designer handed off above. Call record_answer with the accent hex from the spec and the stylesheet path it wrote, then reply in one sentence.";
	const roles = {
		designer: {
			model: createBuilderModel(env, { modelId: lineup.design }),
			system: system("designer"),
		},
		builder: {
			model: createBuilderModel(env, { modelId: lineup.build }),
			system: system("builder"),
		},
	};
	const convergence = new BuildConvergence();
	const served = [];
	const result = await generateText({
		model: roles.designer.model,
		prompt: "A one-page site for a small bakery.",
		tools,
		stopWhen: stepCountIs(8),
		providerOptions: builderProviderOptions("medium"),
		prepareStep: ({ messages, stepNumber }) =>
			prepareSplitBuildStep(handoff, roles, convergence, messages, toolNames, {
				initialBuild: true,
				stepNumber,
			}),
		onStepFinish: (step) => served.push(step.response?.modelId),
	});
	return { result, served, answers, handedOff: handoff.handedOff };
}

// A helper lineup on the real providers: the driver delegates, the helper
// runs the task with its own tool call, and the driver reads its report.
async function delegateCheck(lineup) {
	const created = [];
	const helperSteps = [];
	const delegate = createDelegateTool({
		model: createBuilderModel(env, { modelId: lineup.helper }),
		system: "You are a helper. Do the task with your tools, then report the ids you created.",
		tools: {
			content_create: tool({
				description: "Create a CMS entry.",
				inputSchema: z.object({ collection: z.string(), title: z.string(), status: z.string() }),
				execute: async (entry) => {
					created.push(entry);
					return { success: true, id: "01HELPERENTRY" };
				},
			}),
		},
		providerOptions: builderProviderOptions("low"),
		onStep: (usage) => helperSteps.push(usage.outputTokens),
	});
	const result = await generateText({
		model: createBuilderModel(env, { modelId: lineup.build }),
		system:
			"You build sites. Delegate content to helpers with the delegate tool; you have no CMS tools yourself.",
		prompt:
			"Have a helper create one published entry titled 'Sourdough loaf' in the `products` collection, then tell me the id it reported.",
		tools: { [DELEGATE]: delegate },
		stopWhen: stepCountIs(4),
		providerOptions: builderProviderOptions("medium"),
	});
	return { result, created, helperSteps };
}

// Fast mode on the real gateway: the same long answer with and without it,
// alternating, timed from the first answer token to the last. The raw stream's
// usage says which speed the API served.
async function speedCheck(lineup) {
	const runs = [];
	for (const fast of [false, true, false, true]) {
		let served;
		const model = createBuilderModel(env, {
			modelId: lineup.build,
			fetch: async (input, init) => {
				const response = await fetch(input, init);
				response
					.clone()
					.text()
					.then((text) => (served = text.match(/"speed":"(\w+)"/)?.[1] ?? "not reported"));
				return response;
			},
		});
		const started = Date.now();
		let firstText;
		const result = streamText({
			model,
			// A different prompt each run, so the gateway's response cache cannot answer.
			prompt: `Describe one week in a small neighbourhood bakery, day by day, in about 900 words of plain prose. (Run ${runs.length + 1} at ${Date.now()}.)`,
			maxOutputTokens: 4000,
			providerOptions: builderProviderOptions("low", { reasoningSummary: false, fast }),
			onChunk: ({ chunk }) => {
				if (chunk.type === "text-delta") firstText ??= Date.now();
			},
		});
		const usage = await result.totalUsage;
		const finished = Date.now();
		runs.push({
			fast,
			served,
			outputTokens: usage.outputTokens,
			firstTextMs: firstText - started,
			tokensPerSecond: Math.round(usage.outputTokens / ((finished - firstText) / 1000)),
		});
	}
	return runs;
}

for (const id of models) {
	const lineup = parseBuilderLineup(id);
	if (lineup.fast) {
		try {
			for (const run of await speedCheck(lineup)) {
				console.log(JSON.stringify({ model: id, check: "speed", ok: true, ...run }));
			}
		} catch (error) {
			const detail = String(error?.responseBody ?? error?.message ?? error).slice(0, 600);
			console.log(JSON.stringify({ model: id, check: "speed", ok: false, error: detail }));
		}
		continue;
	}
	if (lineup.helper) {
		const started = Date.now();
		let outcome;
		try {
			const { result, created, helperSteps } = await delegateCheck(lineup);
			outcome = { ...summarize(result, started), created, helperSteps };
		} catch (error) {
			outcome = {
				ok: false,
				ms: Date.now() - started,
				error: String(error?.responseBody ?? error?.message ?? error).slice(0, 600),
			};
		}
		console.log(JSON.stringify({ model: id, check: "delegate", ...outcome }));
		continue;
	}
	if (lineup.design) {
		const started = Date.now();
		let outcome;
		try {
			const { result, served, handedOff, answers } = await handoffCheck(lineup);
			outcome = { ...summarize(result, started), served, handedOff, answers };
		} catch (error) {
			outcome = {
				ok: false,
				ms: Date.now() - started,
				error: String(error?.responseBody ?? error?.message ?? error).slice(0, 600),
			};
		}
		console.log(JSON.stringify({ model: id, check: "handoff", ...outcome }));
		continue;
	}
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
