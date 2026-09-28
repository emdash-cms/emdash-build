import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { compactFollowUpContext } from "../src/worker/follow-up-context.js";

describe("follow-up model context", () => {
	it("keeps user decisions and final text but drops old tool results and reasoning", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "Build a bakery with editable prices." },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "A long internal plan." },
					{ type: "text", text: "I will build the menu." },
					{
						type: "tool-call",
						toolCallId: "read-1",
						toolName: "read_file",
						input: { path: "src/pages/index.astro" },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "read-1",
						toolName: "read_file",
						output: { type: "text", value: "many lines of old source" },
					},
				],
			},
			{ role: "assistant", content: "Built the editable bakery menu at /menu." },
			{ role: "user", content: "Change the loaf to £5.20." },
		];
		const compact = compactFollowUpContext(messages);
		expect(compact).toEqual([
			messages[0],
			{ role: "assistant", content: [{ type: "text", text: "I will build the menu." }] },
			messages[3],
			messages[4],
		]);
	});

	it("leaves an in-flight turn intact after the latest user message", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "Initial request" },
			{ role: "assistant", content: "Built the site" },
			{ role: "user", content: "Change the header" },
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "current-read",
						toolName: "read_file",
						input: { path: "src/styles/global.css" },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "current-read",
						toolName: "read_file",
						output: { type: "text", value: "Current CSS" },
					},
				],
			},
		];
		expect(compactFollowUpContext(messages)).toEqual(messages);
	});
});
