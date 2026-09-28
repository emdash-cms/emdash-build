export const ASK_QUESTIONS_TOOL_NAME = "ask_questions";

export const QUESTIONNAIRE_DEFAULTS_MESSAGE =
	"I skipped the clarifying questions. Use your recommended defaults and start building.";

export interface ClarifyingQuestion {
	question: string;
	options?: string[];
	allow_multiple?: boolean;
	allow_custom?: boolean;
}

export interface QuestionAnswer {
	question: string;
	selected: string[];
	custom: string;
}

export interface QuestionnairePartLike {
	type?: unknown;
	text?: unknown;
	toolName?: unknown;
	toolCallId?: unknown;
	state?: unknown;
	input?: unknown;
	args?: unknown;
}

export interface QuestionnaireMessageLike {
	id?: string;
	role: string;
	metadata?: unknown;
	parts?: readonly QuestionnairePartLike[];
}

export interface PendingQuestionnaire {
	toolCallId: string;
	questions: ClarifyingQuestion[];
	messageIndex: number;
}

export interface QuestionnaireResponse {
	toolCallId: string;
	answerMessageId?: string;
}

export interface QuestionnaireSubmission {
	toolCallId: string;
	answers: QuestionAnswer[];
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 5;
const MAX_QUESTION_CANDIDATES = MAX_QUESTIONS * 4;
const MAX_OPTION_CANDIDATES = MAX_OPTIONS * 4;
const MAX_QUESTION_LENGTH = 240;
const MAX_OPTION_LENGTH = 160;
const MAX_CUSTOM_LENGTH = 1_000;
const TERMINAL_TOOL_STATES = new Set(["output-available", "result"]);

function inlineText(value: unknown, maxLength: number): string {
	return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function questionInput(value: unknown): unknown[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const questions = (value as { questions?: unknown }).questions;
	return Array.isArray(questions) ? questions : [];
}

export function parseClarifyingQuestions(input: unknown): ClarifyingQuestion[] {
	const parsed: ClarifyingQuestion[] = [];
	const seenQuestions = new Set<string>();

	for (const candidate of questionInput(input).slice(0, MAX_QUESTION_CANDIDATES)) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const raw = candidate as Record<string, unknown>;
		const question = inlineText(raw.question, MAX_QUESTION_LENGTH);
		const questionKey = question.toLowerCase();
		if (!question || seenQuestions.has(questionKey)) continue;

		const options: string[] = [];
		const seenOptions = new Set<string>();
		if (Array.isArray(raw.options)) {
			for (const value of raw.options.slice(0, MAX_OPTION_CANDIDATES)) {
				const option = inlineText(value, MAX_OPTION_LENGTH);
				const optionKey = option.toLowerCase();
				if (!option || seenOptions.has(optionKey)) continue;
				seenOptions.add(optionKey);
				options.push(option);
				if (options.length === MAX_OPTIONS) break;
			}
		}

		const allowMultiple = typeof raw.allow_multiple === "boolean" ? raw.allow_multiple : undefined;
		const allowCustom = typeof raw.allow_custom === "boolean" ? raw.allow_custom : undefined;
		if (options.length === 0 && allowCustom === false) continue;

		seenQuestions.add(questionKey);
		parsed.push({
			question,
			options: options.length > 0 ? options : undefined,
			allow_multiple: allowMultiple,
			allow_custom: allowCustom,
		});
		if (parsed.length === MAX_QUESTIONS) break;
	}

	return parsed;
}

function toolName(part: QuestionnairePartLike): string | undefined {
	if (part.type === "dynamic-tool" && typeof part.toolName === "string") {
		return part.toolName;
	}
	if (typeof part.type === "string" && part.type.startsWith("tool-")) {
		return part.type.slice(5);
	}
	return undefined;
}

export function isAskQuestionsToolPart(part: QuestionnairePartLike): boolean {
	return toolName(part) === ASK_QUESTIONS_TOOL_NAME;
}

function latestQuestionnaire(
	messages: readonly QuestionnaireMessageLike[],
): PendingQuestionnaire | undefined {
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const message = messages[messageIndex];
		if (message?.role !== "assistant" || !message.parts) continue;
		for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
			const part = message.parts[partIndex];
			if (!part || toolName(part) !== ASK_QUESTIONS_TOOL_NAME) continue;
			if (typeof part.state !== "string" || !TERMINAL_TOOL_STATES.has(part.state)) continue;
			if (typeof part.toolCallId !== "string" || !part.toolCallId.trim()) continue;
			const questions = parseClarifyingQuestions(part.input ?? part.args);
			if (questions.length === 0) continue;
			return { toolCallId: part.toolCallId, questions, messageIndex };
		}
	}
	return undefined;
}

export function findPendingQuestionnaire(
	messages: readonly QuestionnaireMessageLike[],
): PendingQuestionnaire | undefined {
	const latest = latestQuestionnaire(messages);
	if (!latest) return undefined;
	return messages.slice(latest.messageIndex + 1).some((message) => message.role === "user")
		? undefined
		: latest;
}

export function findQuestionnaireResponse(
	messages: readonly QuestionnaireMessageLike[],
): QuestionnaireResponse | undefined {
	const latest = latestQuestionnaire(messages);
	if (!latest) return undefined;
	const answerOffset = messages
		.slice(latest.messageIndex + 1)
		.findIndex((message) => message.role === "user");
	if (answerOffset < 0) return undefined;
	const answerIndex = latest.messageIndex + answerOffset + 1;
	return {
		toolCallId: latest.toolCallId,
		answerMessageId: messages[answerIndex]?.id,
	};
}

export function createQuestionAnswers(questions: readonly ClarifyingQuestion[]): QuestionAnswer[] {
	return questions.map(({ question }) => ({ question, selected: [], custom: "" }));
}

export function toggleQuestionOption(
	answers: readonly QuestionAnswer[],
	questions: readonly ClarifyingQuestion[],
	questionIndex: number,
	option: string,
): QuestionAnswer[] {
	const current = answers[questionIndex];
	const question = questions[questionIndex];
	if (!current || !question?.options?.includes(option)) return [...answers];

	const next = answers.map((answer) => ({ ...answer, selected: [...answer.selected] }));
	if (current.selected.includes(option)) {
		next[questionIndex] = {
			...current,
			selected: current.selected.filter((value) => value !== option),
		};
	} else {
		next[questionIndex] = {
			...current,
			selected: question.allow_multiple ? [...current.selected, option] : [option],
			custom: "",
		};
	}
	return next;
}

export function setQuestionCustomAnswer(
	answers: readonly QuestionAnswer[],
	questionIndex: number,
	value: string,
): QuestionAnswer[] {
	const current = answers[questionIndex];
	if (!current) return [...answers];
	const next = answers.map((answer) => ({ ...answer, selected: [...answer.selected] }));
	const custom = value.slice(0, MAX_CUSTOM_LENGTH);
	next[questionIndex] = {
		...current,
		custom,
		selected: custom.trim() ? [] : current.selected,
	};
	return next;
}

export function formatQuestionnaireResponse(answers: readonly QuestionAnswer[]): string {
	const answered = answers.flatMap((answer) => {
		const values = answer.selected.map((value) => value.trim()).filter(Boolean);
		if (answer.custom.trim()) values.push(answer.custom.trim());
		return values.length > 0 ? [`Q: ${answer.question}\nA: ${values.join(", ")}`] : [];
	});
	if (answered.length === 0) return QUESTIONNAIRE_DEFAULTS_MESSAGE;

	const defaults =
		answered.length < answers.length
			? "\n\nUse your recommended defaults for any questions I skipped."
			: "";
	return `Here are my answers:\n\n${answered.join("\n\n")}${defaults}`;
}

/** Only collapse form transport that exactly answers its pending questionnaire.
 * Typed, mixed, stale, and legacy messages remain ordinary visible messages. */
export function readQuestionnaireSubmission(
	messages: readonly QuestionnaireMessageLike[],
	index: number,
): QuestionnaireSubmission | undefined {
	const message = messages[index];
	if (message?.role !== "user" || message.parts?.length !== 1) return;
	const metadata = message.metadata as { questionnaire?: unknown } | undefined;
	const raw = metadata?.questionnaire as Partial<QuestionnaireSubmission> | undefined;
	if (!raw || typeof raw.toolCallId !== "string" || !Array.isArray(raw.answers)) return;
	const pending = findPendingQuestionnaire(messages.slice(0, index));
	if (!pending || raw.toolCallId !== pending.toolCallId) return;
	if (raw.answers.length !== pending.questions.length) return;
	const answers: QuestionAnswer[] = [];
	for (const [questionIndex, question] of pending.questions.entries()) {
		const answer = raw.answers[questionIndex];
		if (!answer || answer.question !== question.question || !Array.isArray(answer.selected)) return;
		if (typeof answer.custom !== "string" || answer.custom.length > MAX_CUSTOM_LENGTH) return;
		if (
			answer.selected.length > MAX_OPTIONS ||
			(!question.allow_multiple && answer.selected.length > 1)
		)
			return;
		if (new Set(answer.selected).size !== answer.selected.length) return;
		if (
			answer.selected.some(
				(value) => typeof value !== "string" || !question.options?.includes(value),
			)
		)
			return;
		const custom = answer.custom.trim();
		if (custom && (question.allow_custom === false || answer.selected.length > 0)) return;
		answers.push({ question: question.question, selected: [...answer.selected], custom });
	}
	const part = message.parts[0];
	if (part?.type !== "text" || part.text !== formatQuestionnaireResponse(answers)) return;
	return { toolCallId: pending.toolCallId, answers };
}
