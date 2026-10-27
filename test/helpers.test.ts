import { describe, expect, it } from "vitest";
import { stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { BuildConvergence, prepareBuildStep } from "../src/worker/build-convergence.js";
import { createDelegateTool, DELEGATE, driverToolNames } from "../src/worker/helpers.js";

function streamOf(parts: Array<Record<string, unknown>>) {
	return new ReadableStream({
		start(controller) {
			controller.enqueue({ type: "stream-start", warnings: [] });
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}

const usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const callReply = (calls: Array<{ id: string; name: string; input?: unknown }>) => ({
	stream: streamOf([
		...calls.map((call) => ({
			type: "tool-call",
			toolCallId: call.id,
			toolName: call.name,
			input: JSON.stringify(call.input ?? {}),
		})),
		{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
	]),
});

const textReply = (text: string) => ({
	stream: streamOf([
		{ type: "text-start", id: "t" },
		{ type: "text-delta", id: "t", delta: text },
		{ type: "text-end", id: "t" },
		{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
	]),
});

function scripted(replies: Array<() => unknown>) {
	const calls: Array<{ tools: string[]; prompt: unknown }> = [];
	const model = new MockLanguageModelV3({
		doStream: async (options) => {
			calls.push({ tools: (options.tools ?? []).map((t) => t.name), prompt: options.prompt });
			const next = replies.shift();
			if (!next) throw new Error("no scripted reply left");
			return next() as never;
		},
	});
	return { model, calls };
}

/** The helper runs generateText, which calls doGenerate rather than doStream. */
function scriptedHelper(
	replies: Array<{ calls?: Array<{ id: string; name: string }>; text?: string }>,
) {
	const calls: Array<{ tools: string[]; prompt: unknown }> = [];
	const model = new MockLanguageModelV3({
		doGenerate: async (options) => {
			calls.push({ tools: (options.tools ?? []).map((t) => t.name), prompt: options.prompt });
			const next = replies.shift();
			if (!next) throw new Error("no scripted reply left");
			return {
				content: next.calls
					? next.calls.map((call) => ({
							type: "tool-call" as const,
							toolCallId: call.id,
							toolName: call.name,
							input: "{}",
						}))
					: [{ type: "text" as const, text: next.text ?? "" }],
				finishReason: next.calls
					? { unified: "tool-calls" as const, raw: "tool_use" }
					: { unified: "stop" as const, raw: "stop" },
				usage,
				warnings: [],
			};
		},
	});
	return { model, calls };
}

describe("delegate", () => {
	it("runs the task on the helper with only content and media tools, and reports back", async () => {
		const executed: string[] = [];
		const record = (name: string) =>
			tool({
				inputSchema: z.object({}),
				execute: async () => {
					executed.push(name);
					return { success: true };
				},
			});
		const tools = {
			write_file: record("write_file"),
			apply_schema_plan: record("apply_schema_plan"),
			validate_site: record("validate_site"),
			content_create: record("content_create"),
			upload_media: record("upload_media"),
		};
		const helper = scriptedHelper([
			{
				calls: [
					{ id: "h1", name: "upload_media" },
					{ id: "h2", name: "content_create" },
				],
			},
			{ text: "Created 2 loaves entries." },
		]);
		const steps: number[] = [];
		const finished: string[] = [];
		const delegate = createDelegateTool({
			model: helper.model,
			system: "You are a helper.",
			tools,
			providerOptions: {},
			onStep: (stepUsage) => steps.push(stepUsage.outputTokens ?? 0),
			onToolCallFinish: (event) => finished.push(event.toolCall.toolName),
		});
		const driver = scripted([
			() =>
				callReply([
					{
						id: "d1",
						name: DELEGATE,
						input: { task: "Create two published loaves entries in `products` with photos." },
					},
				]),
			() => textReply("Done."),
		]);

		const result = streamText({
			model: driver.model,
			prompt: "Build",
			tools: { ...tools, [DELEGATE]: delegate },
			stopWhen: stepCountIs(3),
		});
		await result.consumeStream();

		expect(helper.calls[0]?.tools.sort()).toEqual(["content_create", "upload_media"]);
		expect(JSON.stringify(helper.calls[0]?.prompt)).toContain(
			"Create two published loaves entries",
		);
		expect(executed.sort()).toEqual(["content_create", "upload_media"]);
		expect(steps).toEqual([5, 5]);
		expect(finished.sort()).toEqual(["content_create", "upload_media"]);
		const delegated = (await result.steps)[0]?.toolResults[0]?.output;
		expect(delegated).toEqual({
			success: true,
			report: "Created 2 loaves entries.",
			toolCalls: 2,
			failedCalls: [],
		});
	});

	it("leaves a driver with helpers the code, schema, checks, and content reads", () => {
		expect(
			driverToolNames([
				"write_files",
				"apply_schema_plan",
				"validate_site",
				"content_get",
				"content_create",
				"create_entries_batch",
				"run_cms_script",
				"search_unsplash",
				"upload_media",
				"menu_set_items",
				"settings_update",
				DELEGATE,
			]),
		).toEqual(["write_files", "apply_schema_plan", "validate_site", "content_get", DELEGATE]);
	});

	it("forces the driver to repair a helper's failed call, so the build can still finish", () => {
		const convergence = new BuildConvergence();
		convergence.recordUnresolvedFailure({
			key: "content:posts:rye",
			toolName: "content_create",
			error: "[VALIDATION_ERROR] body: required",
		});
		const all = ["write_files", "content_get", "content_create", "menu_set_items", DELEGATE];
		const repairable = () => driverToolNames(all, convergence.nextUnresolvedFailure()?.toolName);

		expect(repairable()).toEqual(["write_files", "content_get", "content_create", DELEGATE]);
		for (let step = 0; step < 3; step++) {
			expect(prepareBuildStep(convergence, [] as never, repairable()).allowedTools).toEqual({
				toolNames: ["content_create"],
				mode: "required",
			});
		}
		// Three failed repairs retire it, as without helpers, and the content tool goes back.
		expect(convergence.hasUnresolvedFailures()).toBe(false);
		expect(repairable()).toEqual(["write_files", "content_get", DELEGATE]);
	});

	it("tells the driver when the helper fails instead of failing the turn", async () => {
		const helper = new MockLanguageModelV3({
			doGenerate: async () => {
				throw new Error("helper overloaded");
			},
		});
		const delegate = createDelegateTool({
			model: helper,
			system: "You are a helper.",
			tools: {},
			providerOptions: {},
		});
		const output = await delegate.execute!(
			{ task: "Create the opening hours in site settings, Monday to Saturday." },
			{ toolCallId: "d1", messages: [] },
		);
		expect(output).toMatchObject({ success: false });
		expect((output as { error: string }).error).toContain("helper overloaded");
	});
});
