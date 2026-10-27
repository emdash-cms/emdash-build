import { describe, expect, it } from "vitest";
import { stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { BuildConvergence } from "../src/worker/build-convergence.js";
import {
	DESIGN_STEP_CAP,
	DesignHandoff,
	HAND_OFF_DESIGN,
	prepareSplitBuildStep,
} from "../src/worker/design-handoff.js";

const DESIGNER = "anthropic/claude-opus-5.5";
const BUILDER = "openai/gpt-6-luna";

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
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function toolCallReply(id: string, toolName: string, input: unknown, reasoning?: object) {
	return {
		stream: streamOf([
			...(reasoning
				? [
						{ type: "reasoning-start", id: `r${id}` },
						{ type: "reasoning-delta", id: `r${id}`, delta: "A serif masthead." },
						{ type: "reasoning-end", id: `r${id}`, providerMetadata: reasoning },
					]
				: []),
			{ type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input) },
			{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
		]),
	};
}

const doneReply = () => ({
	stream: streamOf([
		{ type: "text-start", id: "t" },
		{ type: "text-delta", id: "t", delta: "Built." },
		{ type: "text-end", id: "t" },
		{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
	]),
});

function splitBuild(handoff: DesignHandoff, designerReplies: Array<() => unknown>) {
	const calls: Array<{ role: string; tools: string[]; prompt: unknown[]; system?: string }> = [];
	const recording = (role: string, replies: Array<() => unknown>) =>
		new MockLanguageModelV3({
			doStream: async (options) => {
				calls.push({
					role,
					tools: (options.tools ?? []).map((t) => t.name),
					prompt: options.prompt,
					system: options.prompt.find((m) => m.role === "system")?.content as string | undefined,
				});
				return replies.shift()!() as never;
			},
		});
	const noop = tool({ inputSchema: z.object({}), execute: async () => ({ success: true }) });
	const tools = {
		read_files: noop,
		apply_schema_plan: noop,
		write_files: noop,
		create_entries_batch: noop,
		validate_site: noop,
		[HAND_OFF_DESIGN]: tool({
			inputSchema: z.object({ spec: z.string() }),
			execute: async ({ spec }) => {
				handoff.handOff(spec);
				return { success: true };
			},
		}),
	};
	const toolNames = Object.keys(tools) as Array<keyof typeof tools>;
	const roles = {
		designer: { model: recording("designer", designerReplies), system: "You design." },
		builder: { model: recording("builder", [doneReply]), system: "You build." },
	};
	const convergence = new BuildConvergence();
	const result = streamText({
		model: roles[handoff.role()].model,
		prompt: "Build a bakery site",
		tools,
		stopWhen: stepCountIs(DESIGN_STEP_CAP + 4),
		prepareStep: ({ messages, stepNumber }) =>
			prepareSplitBuildStep(handoff, roles, convergence, messages, toolNames, {
				initialBuild: true,
				stepNumber,
			}),
	});
	return { calls, result };
}

describe("split first build", () => {
	it("runs the designer until it hands off, then the builder with every other tool", async () => {
		const handoff = new DesignHandoff(DESIGNER, BUILDER);
		const { calls, result } = splitBuild(handoff, [
			() => toolCallReply("toolu_1", "write_files", {}, { anthropic: { signature: "sig" } }),
			() => toolCallReply("toolu_2", HAND_OFF_DESIGN, { spec: "# Design" }),
		]);
		await result.consumeStream();

		expect(calls.map((call) => call.role)).toEqual(["designer", "designer", "builder"]);
		expect(calls[0]?.tools).toEqual([
			"read_files",
			"apply_schema_plan",
			"write_files",
			HAND_OFF_DESIGN,
		]);
		expect(calls[2]?.tools).toEqual([
			"read_files",
			"apply_schema_plan",
			"write_files",
			"create_entries_batch",
			"validate_site",
		]);
		expect(calls.map((call) => call.system)).toEqual(["You design.", "You design.", "You build."]);
		// The builder sees the designer's calls and results but not its reasoning.
		const builderParts = calls[2]!.prompt.flatMap((message) =>
			Array.isArray((message as { content: unknown }).content)
				? ((message as { content: Array<{ type: string }> }).content ?? [])
				: [],
		);
		expect(builderParts.map((part) => part.type)).toEqual([
			"text",
			"tool-call",
			"tool-result",
			"tool-call",
			"tool-result",
		]);
		expect(calls[1]!.prompt.some((message) => JSON.stringify(message).includes("reasoning"))).toBe(
			true,
		);
	});

	it("leaves the designer only the hand-off once it has used its steps", async () => {
		const handoff = new DesignHandoff(DESIGNER, BUILDER);
		const { calls, result } = splitBuild(handoff, [
			...Array.from(
				{ length: DESIGN_STEP_CAP },
				(_, i) => () => toolCallReply(`toolu_${i}`, "read_files", {}),
			),
			() => toolCallReply("toolu_last", HAND_OFF_DESIGN, { spec: "# Design" }),
		]);
		await result.consumeStream();

		const forced = calls[DESIGN_STEP_CAP]!;
		expect(forced.role).toBe("designer");
		expect(forced.tools).toEqual([HAND_OFF_DESIGN]);
		expect(calls.at(-1)?.role).toBe("builder");
	});

	it("runs both models at the choice's effort", () => {
		const roles = {
			designer: { model: DESIGNER, system: "You design." },
			builder: { model: BUILDER, system: "You build." },
		};
		const effortOf = (handoff: DesignHandoff) =>
			prepareSplitBuildStep(handoff, roles, new BuildConvergence(), [], ["read_files"], {
				initialBuild: true,
				stepNumber: 0,
				effort: "low",
			}).providerOptions;

		expect(effortOf(new DesignHandoff(DESIGNER, BUILDER)).anthropic.effort).toBe("low");
		expect(effortOf(new DesignHandoff(DESIGNER, BUILDER, "# Design")).openai.reasoningEffort).toBe(
			"low",
		);
	});

	it("starts a resumed build that already handed off on the builder", async () => {
		const handoff = new DesignHandoff(DESIGNER, BUILDER, "# Design");
		const { calls, result } = splitBuild(handoff, []);
		await result.consumeStream();

		expect(calls.map((call) => call.role)).toEqual(["builder"]);
		expect(calls[0]?.tools).not.toContain(HAND_OFF_DESIGN);
	});
});
