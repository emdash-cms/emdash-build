import { describe, expect, it } from "vitest";
import type { QuestionnaireMessageLike } from "../src/shared/questionnaire.js";
import {
	shouldGateInitialBuild,
	shouldRecordBuildEligibility,
} from "../src/worker/questionnaire.js";

const questions = [{ question: "Which tone?", options: ["Editorial", "Playful"] }];

function askMessage(input: unknown = { questions }): QuestionnaireMessageLike {
	return {
		id: "assistant-ask",
		role: "assistant",
		parts: [
			{
				type: "tool-ask_questions",
				toolCallId: "ask-1",
				state: "output-available",
				input,
			},
		],
	};
}

describe("initial questionnaire build gate", () => {
	it("gates only a no-user auto-turn with unanswered completed questions", () => {
		expect(shouldGateInitialBuild([askMessage()], false)).toBe(true);
		expect(shouldGateInitialBuild([askMessage()], true)).toBe(false);
	});

	it("releases the build after any user response", () => {
		expect(
			shouldGateInitialBuild(
				[askMessage(), { id: "answer", role: "user", parts: [{ type: "text" }] }],
				false,
			),
		).toBe(false);
	});

	it("records build eligibility only after questionnaire gating clears", () => {
		expect(shouldRecordBuildEligibility([askMessage()], false)).toBe(false);
		expect(
			shouldRecordBuildEligibility(
				[askMessage(), { id: "answer", role: "user", parts: [{ type: "text" }] }],
				true,
			),
		).toBe(true);
		expect(shouldRecordBuildEligibility([], false)).toBe(false);
		expect(
			shouldRecordBuildEligibility(
				[{ id: "brief", role: "user", parts: [{ type: "text" }] }],
				true,
			),
		).toBe(false);
	});

	it("fails open for partial or malformed tool output", () => {
		expect(shouldGateInitialBuild([], false)).toBe(false);
		expect(
			shouldGateInitialBuild(
				[
					{
						...askMessage(),
						parts: [{ ...askMessage().parts![0], state: "input-available" }],
					},
				],
				false,
			),
		).toBe(false);
		expect(shouldGateInitialBuild([askMessage({ questions: [] })], false)).toBe(false);
	});
});
