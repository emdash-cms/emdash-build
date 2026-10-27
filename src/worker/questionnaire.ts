import { tool, type Tool } from "ai";
import { z } from "zod";
import {
	findQuestionnaireResponse,
	findPendingQuestionnaire,
	MAX_DETAIL_LENGTH,
	MAX_OPTION_LENGTH,
	MAX_QUESTION_LENGTH,
	type QuestionnaireMessageLike,
} from "../shared/questionnaire.js";

const DESCRIPTION = [
	"Ask the site owner a short, pick-first creative brief before the first build.",
	"",
	"Give each question 3 or 4 distinct, concrete options the owner can choose with one click. Each option has a short label and a one-sentence description of what the site will look, read, or feel like with that choice. Mark the option that best fits the brief as recommended. Add a short why that says what the answer changes in the site.",
	"",
	"Never ask the owner to type operational facts such as opening hours, addresses, prices, dates, or contact details; the builder never invents them, and the owner adds them once the first draft exists. Ask a custom-only question (no options) only for an exact name the brief does not give.",
	"",
	"Include every question you need, then end the turn and wait. The site environment continues provisioning in parallel.",
].join("\n");

export const FIRST_INTERVIEW_TOOL_CHOICE = "auto" as const;

const optionSchema = z.object({
	label: z
		.string()
		.trim()
		.min(1)
		.max(MAX_OPTION_LENGTH)
		.describe("The choice itself, 2 to 6 words."),
	description: z
		.string()
		.trim()
		.max(MAX_DETAIL_LENGTH)
		.optional()
		.describe("One sentence on what the site will look, read, or feel like with this choice."),
	recommended: z.boolean().optional().describe("True on the one option that best fits the brief."),
});

const questionSchema = z
	.object({
		question: z
			.string()
			.trim()
			.min(1)
			.max(MAX_QUESTION_LENGTH)
			.describe(
				"One warm, specific question to the owner about their site, at most two short sentences.",
			),
		why: z
			.string()
			.trim()
			.max(MAX_DETAIL_LENGTH)
			.optional()
			.describe(
				"One short sentence on what this answer changes in the site. Shown under the question.",
			),
		options: z
			.array(optionSchema)
			.max(5)
			.optional()
			.describe(
				"3 or 4 distinct, concrete choices drawn from the brief. Omit only for an exact name.",
			),
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
			questions: z.array(questionSchema).min(1).max(5),
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
