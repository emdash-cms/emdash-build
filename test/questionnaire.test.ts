import { describe, expect, it } from "vitest";
import {
	QUESTIONNAIRE_DEFAULTS_MESSAGE,
	createQuestionAnswers,
	findPendingQuestionnaire,
	findQuestionnaireResponse,
	formatQuestionnaireResponse,
	parseClarifyingQuestions,
	readQuestionnaireSubmission,
	setQuestionCustomAnswer,
	toggleQuestionOption,
	type ClarifyingQuestion,
	type QuestionnaireMessageLike,
} from "../src/shared/questionnaire.js";
import {
	createAskQuestionsTool,
	FIRST_INTERVIEW_TOOL_CHOICE,
} from "../src/worker/questionnaire.js";

const questions: ClarifyingQuestion[] = [
	{
		question: "Which pages matter most?",
		why: "Decides which pages the first build includes.",
		options: [
			{ label: "Home", description: "A single page that tells the whole story." },
			{ label: "About" },
			{ label: "Journal", description: "Dated posts you can add from the CMS." },
		],
		allow_multiple: true,
		allow_custom: true,
	},
	{
		question: "Which tone fits best?",
		options: [{ label: "Editorial", recommended: true }, { label: "Playful" }],
		allow_custom: true,
	},
];

function questionnaireMessage(
	state: string = "output-available",
	type: string = "tool-ask_questions",
): QuestionnaireMessageLike {
	return {
		id: "assistant-1",
		role: "assistant",
		parts: [
			{
				type,
				toolName: type === "dynamic-tool" ? "ask_questions" : undefined,
				toolCallId: "questionnaire-1",
				state,
				input: { questions },
			},
		],
	};
}

describe("questionnaire parsing", () => {
	it("lets a complete first-turn brief skip the questionnaire tool", () => {
		expect(FIRST_INTERVIEW_TOOL_CHOICE).toBe("auto");
	});

	it("exposes a no-op interview tool that echoes bounded question input", async () => {
		const questionTool = createAskQuestionsTool() as {
			inputSchema: { safeParse: (input: unknown) => { success: boolean } };
			execute?: (input: { questions: ClarifyingQuestion[] }) => Promise<unknown>;
		};
		expect(await questionTool.execute?.({ questions })).toEqual({ ok: true, questions });
		expect(questionTool.inputSchema.safeParse({ questions }).success).toBe(true);
		expect(
			questionTool.inputSchema.safeParse({
				questions: Array.from({ length: 5 }, (_, index) => ({
					question: `Question ${index}`,
					options: [{ label: "One" }],
				})),
			}).success,
		).toBe(true);
		expect(
			questionTool.inputSchema.safeParse({
				questions: Array.from({ length: 6 }, (_, index) => ({
					question: `Question ${index}`,
					options: [{ label: "One" }],
				})),
			}).success,
		).toBe(false);
		expect(
			questionTool.inputSchema.safeParse({
				questions: [{ question: "Which tone?", options: [{ description: "No label" }] }],
			}).success,
		).toBe(false);
		expect(
			questionTool.inputSchema.safeParse({
				questions: [{ question: "Which tone?", options: ["Plain string"] }],
			}).success,
		).toBe(false);
		// An empty why must not throw away the whole questionnaire.
		expect(
			questionTool.inputSchema.safeParse({
				questions: [{ question: "Which tone?", why: " ", options: [{ label: "Calm" }] }],
			}).success,
		).toBe(true);
		expect(
			questionTool.inputSchema.safeParse({
				questions: [{ question: "No answer", options: [], allow_custom: false }],
			}).success,
		).toBe(false);
	});

	it("trims, deduplicates, bounds, and removes unanswerable questions", () => {
		const parsed = parseClarifyingQuestions({
			questions: [
				{
					question: "  Which pages?  ",
					options: [" Home ", "Home", "About", "Journal", "Shop", "Contact", "Extra"],
					allow_multiple: true,
				},
				{ question: "Which pages?", options: ["Duplicate question"] },
				{ question: "No answer mode", options: [], allow_custom: false },
				{ question: "Free text", allow_custom: true },
				{ question: "Fifth", options: ["One"] },
				{ question: "Sixth", options: ["One"] },
			],
		});

		expect(parsed).toEqual([
			{
				question: "Which pages?",
				options: [
					{ label: "Home" },
					{ label: "About" },
					{ label: "Journal" },
					{ label: "Shop" },
					{ label: "Contact" },
				],
				allow_multiple: true,
				allow_custom: undefined,
			},
			{
				question: "Free text",
				options: undefined,
				allow_multiple: undefined,
				allow_custom: true,
			},
			{
				question: "Fifth",
				options: [{ label: "One" }],
				allow_multiple: undefined,
				allow_custom: undefined,
			},
			{
				question: "Sixth",
				options: [{ label: "One" }],
				allow_multiple: undefined,
				allow_custom: undefined,
			},
		]);
	});

	it("reads legacy string options as labels", () => {
		expect(
			parseClarifyingQuestions({
				questions: [{ question: "Which tone?", options: [" Editorial ", "Playful"] }],
			})[0]?.options,
		).toEqual([{ label: "Editorial" }, { label: "Playful" }]);
	});

	it("keeps option descriptions, the first recommendation, and a trimmed why", () => {
		const [question] = parseClarifyingQuestions({
			questions: [
				{
					question: "Which tone?",
					why: "  Sets   the voice of every page.  ",
					options: [
						{ label: " Editorial ", description: " Serif   headlines. ", recommended: true },
						{ label: "editorial", description: "Duplicate label" },
						{ label: "Playful", description: " ", recommended: true },
						{ label: " ", description: "No label" },
						{ description: "Missing label" },
						{ label: "Calm", recommended: false },
					],
				},
			],
		});
		expect(question).toEqual({
			question: "Which tone?",
			why: "Sets the voice of every page.",
			options: [
				{ label: "Editorial", description: "Serif headlines.", recommended: true },
				{ label: "Playful" },
				{ label: "Calm" },
			],
		});
		expect(Object.keys(question!.options![1]!)).toEqual(["label"]);
		expect(
			parseClarifyingQuestions({ questions: [{ question: "Which tone?", why: " " }] })[0],
		).not.toHaveProperty("why");
	});

	it("accepts five questions and drops a sixth", () => {
		const parsed = parseClarifyingQuestions({
			questions: Array.from({ length: 6 }, (_, index) => ({
				question: `Question ${index + 1}`,
				options: [{ label: "One" }],
			})),
		});
		expect(parsed.map(({ question }) => question)).toEqual([
			"Question 1",
			"Question 2",
			"Question 3",
			"Question 4",
			"Question 5",
		]);
	});

	it("rejects malformed roots", () => {
		expect(parseClarifyingQuestions(null)).toEqual([]);
		expect(parseClarifyingQuestions({ questions: "not-an-array" })).toEqual([]);
		expect(parseClarifyingQuestions({ questions: [{ question: " ", options: ["One"] }] })).toEqual(
			[],
		);
	});

	it("bounds malformed candidate work before accepting questions or options", () => {
		expect(
			parseClarifyingQuestions({
				questions: [
					...Array.from({ length: 100 }, () => null),
					{ question: "Too late", options: ["One"] },
				],
			}),
		).toEqual([]);
		expect(
			parseClarifyingQuestions({
				questions: [
					{
						question: "Which option?",
						options: [...Array.from({ length: 100 }, () => " "), "Too late"],
						allow_custom: false,
					},
				],
			}),
		).toEqual([]);
	});
});

describe("structured questionnaire submissions", () => {
	function submission() {
		const answers = createQuestionAnswers(questions);
		answers[0]!.selected = ["Home", "About"];
		answers[1]!.custom = "Calm\nwith a little colour";
		return {
			id: "answer",
			role: "user",
			metadata: { questionnaire: { toolCallId: "questionnaire-1", answers } },
			parts: [{ type: "text", text: formatQuestionnaireResponse(answers) }],
		};
	}

	it("preserves concrete answers and multiline custom text after transcript reload", () => {
		const answer = submission();
		const history = JSON.parse(JSON.stringify([questionnaireMessage(), answer]));
		expect(readQuestionnaireSubmission(history, 1)).toEqual(answer.metadata.questionnaire);
	});

	it("reads an answer to an older questionnaire with long plain-string options", () => {
		const long =
			"A warm, editorial homepage that leads with the bakery's story, then the seasonal menu";
		const input = { questions: [{ question: "Which direction?", options: [long, "Playful"] }] };
		const asked = {
			...questionnaireMessage(),
			parts: [{ ...questionnaireMessage().parts![0]!, input }],
		};
		const answers = createQuestionAnswers(parseClarifyingQuestions(input));
		answers[0]!.selected = [long];
		const answer = {
			id: "answer",
			role: "user",
			metadata: { questionnaire: { toolCallId: "questionnaire-1", answers } },
			parts: [{ type: "text", text: formatQuestionnaireResponse(answers) }],
		};
		expect(readQuestionnaireSubmission([asked, answer], 1)?.answers).toEqual(answers);
	});

	it("recognizes explicit skips without inventing selected answers", () => {
		const answer = submission();
		answer.metadata.questionnaire.answers = createQuestionAnswers(questions);
		answer.parts[0]!.text = QUESTIONNAIRE_DEFAULTS_MESSAGE;
		expect(readQuestionnaireSubmission([questionnaireMessage(), answer], 1)?.answers).toEqual(
			createQuestionAnswers(questions),
		);
	});

	it("leaves legacy and mixed user messages visible", () => {
		const answer = submission();
		expect(
			readQuestionnaireSubmission([questionnaireMessage(), { ...answer, metadata: undefined }], 1),
		).toBeUndefined();
		answer.parts[0]!.text += "\nAlso, why is setup slow?";
		expect(readQuestionnaireSubmission([questionnaireMessage(), answer], 1)).toBeUndefined();
	});

	it("rejects stale, duplicate, and mismatched questionnaire associations", () => {
		const answer = submission();
		expect(
			readQuestionnaireSubmission([questionnaireMessage(), answer, answer], 2),
		).toBeUndefined();
		answer.metadata.questionnaire.toolCallId = "another-questionnaire";
		expect(readQuestionnaireSubmission([questionnaireMessage(), answer], 1)).toBeUndefined();
	});

	it.each([
		"unknown-option",
		"multiple-single",
		"custom-and-selection",
		"oversize",
		"wrong-question",
	])("rejects invalid answers: %s", (kind) => {
		const answer = submission();
		const selected = answer.metadata.questionnaire.answers[1]!;
		if (kind === "unknown-option") selected.selected = ["Not offered"];
		if (kind === "multiple-single") {
			selected.selected = ["Editorial", "Playful"];
			selected.custom = "";
		}
		if (kind === "custom-and-selection") selected.selected = ["Editorial"];
		if (kind === "oversize") selected.custom = "x".repeat(1_001);
		if (kind === "wrong-question") selected.question = "Changed question";
		answer.parts[0]!.text = formatQuestionnaireResponse(answer.metadata.questionnaire.answers);
		expect(readQuestionnaireSubmission([questionnaireMessage(), answer], 1)).toBeUndefined();
	});
});

describe("questionnaire transcript state", () => {
	it("opens only for a completed static or dynamic tool part", () => {
		expect(findPendingQuestionnaire([questionnaireMessage("input-available")])).toBeUndefined();
		expect(findPendingQuestionnaire([questionnaireMessage()])).toMatchObject({
			toolCallId: "questionnaire-1",
			questions,
		});
		expect(
			findPendingQuestionnaire([questionnaireMessage("output-available", "dynamic-tool")]),
		).toMatchObject({ toolCallId: "questionnaire-1", questions });
	});

	it("closes after any later user message", () => {
		expect(
			findPendingQuestionnaire([
				questionnaireMessage(),
				{ id: "answer-1", role: "user", parts: [{ type: "text" }] },
			]),
		).toBeUndefined();
	});

	it("finds the questionnaire response even when a holding acknowledgement follows", () => {
		const answerOnly = [
			questionnaireMessage(),
			{ id: "answer-1", role: "user", parts: [{ type: "text" }] },
		];
		expect(findQuestionnaireResponse(answerOnly)).toEqual({
			toolCallId: "questionnaire-1",
			answerMessageId: "answer-1",
		});
		expect(
			findQuestionnaireResponse([
				...answerOnly,
				{ id: "holding", role: "assistant", parts: [{ type: "text" }] },
			]),
		).toEqual({ toolCallId: "questionnaire-1", answerMessageId: "answer-1" });
	});
});

describe("questionnaire answers", () => {
	it("supports single and multiple option selection", () => {
		let answers = createQuestionAnswers(questions);
		answers = toggleQuestionOption(answers, questions, 0, "Home");
		answers = toggleQuestionOption(answers, questions, 0, "About");
		expect(answers[0]?.selected).toEqual(["Home", "About"]);

		answers = toggleQuestionOption(answers, questions, 1, "Editorial");
		answers = toggleQuestionOption(answers, questions, 1, "Playful");
		expect(answers[1]?.selected).toEqual(["Playful"]);
	});

	it("keeps custom answers mutually exclusive with options", () => {
		let answers = createQuestionAnswers(questions);
		answers = toggleQuestionOption(answers, questions, 0, "Home");
		answers = setQuestionCustomAnswer(answers, 0, "A press page");
		expect(answers[0]).toMatchObject({ selected: [], custom: "A press page" });

		answers = toggleQuestionOption(answers, questions, 0, "Journal");
		expect(answers[0]).toMatchObject({ selected: ["Journal"], custom: "" });
	});

	it("formats full, partial, and all-default responses", () => {
		let answers = createQuestionAnswers(questions);
		expect(formatQuestionnaireResponse(answers)).toBe(QUESTIONNAIRE_DEFAULTS_MESSAGE);

		answers = toggleQuestionOption(answers, questions, 0, "Home");
		expect(formatQuestionnaireResponse(answers)).toBe(
			"Here are my answers:\n\nQ: Which pages matter most?\nA: Home\n\n" +
				"Use your recommended defaults for any questions I skipped.",
		);

		answers = setQuestionCustomAnswer(answers, 1, "Calm and practical");
		expect(formatQuestionnaireResponse(answers)).toBe(
			"Here are my answers:\n\nQ: Which pages matter most?\nA: Home\n\n" +
				"Q: Which tone fits best?\nA: Calm and practical",
		);
	});
});
