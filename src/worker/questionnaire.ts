import { tool, type Tool } from "ai";
import { z } from "zod";
import {
	findQuestionnaireResponse,
	findPendingQuestionnaire,
	type QuestionnaireMessageLike,
} from "../shared/questionnaire.js";

const DESCRIPTION = [
	"Ask the user the smallest useful set of first-turn questions before site generation begins.",
	"",
	"Each question may provide predefined options, allow multiple selections, and/or allow a custom free-text answer.",
	"",
	"Every predefined option must be a self-contained decision the builder can act on now. For an exact fact, use a custom-only question. Never offer promises to provide information later or ask permission to use placeholders.",
	"",
	"Call this tool only when the brief leaves at least one material decision unresolved. Include every question you need answered, then end the turn and wait. The site environment continues provisioning in parallel.",
].join("\n");

export const FIRST_INTERVIEW_TOOL_CHOICE = "auto" as const;

const questionSchema = z
	.object({
		question: z
			.string()
			.trim()
			.min(1)
			.max(240)
			.describe("One concise, user-facing question about a material decision."),
		options: z
			.array(z.string().trim().min(1).max(160))
			.max(5)
			.optional()
			.describe("Short actionable choices. Omit for an exact free-text fact."),
		allow_multiple: z
			.boolean()
			.optional()
			.describe("True only when several options can meaningfully coexist; otherwise omit."),
		allow_custom: z
			.boolean()
			.optional()
			.describe(
				"False only when the listed options are exhaustive; custom input is allowed by default.",
			),
	})
	.refine((question) => (question.options?.length ?? 0) > 0 || question.allow_custom !== false, {
		message: "A question must provide options or allow a custom answer.",
	});

export function createAskQuestionsTool(): Tool {
	return tool({
		description: DESCRIPTION,
		inputSchema: z.object({
			questions: z.array(questionSchema).min(1).max(4),
		}),
		execute: async ({ questions }) => ({ ok: true, questions }),
	});
}

export function shouldGateInitialBuild(
	messages: readonly QuestionnaireMessageLike[],
	isUserTurn: boolean,
): boolean {
	return !isUserTurn && findPendingQuestionnaire(messages) !== undefined;
}

export function shouldRecordBuildEligibility(
	messages: readonly QuestionnaireMessageLike[],
	isUserTurn: boolean,
): boolean {
	return isUserTurn && findQuestionnaireResponse(messages) !== undefined;
}
