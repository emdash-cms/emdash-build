import type { useAgentChat } from "@cloudflare/ai-chat/react";
import type { InitialGeneration } from "../shared/initial-generation.js";
import {
	isAskQuestionsToolPart,
	readQuestionnaireSubmission,
	type QuestionnaireSubmission,
} from "../shared/questionnaire.js";

type ChatMessage = ReturnType<typeof useAgentChat>["messages"][number];
type MessagePart = ChatMessage["parts"][number];

export interface InitialGenerationView {
	id: string;
	message: ChatMessage;
	groupedMessageIds: Set<string>;
	answerMessageIds: Set<string>;
	answerCount: number;
	usingDefaults: boolean;
}

export { isInitialGenerationActive } from "../shared/initial-generation.js";

/**
 * Older sessions and a newly connected tab can have messages before the
 * durable generation state arrives. Keep the transcript's first prompt in
 * one card while that state catches up; this is display-only and never writes
 * inferred state back to the agent.
 */
export function initialGenerationForDisplay(
	messages: ChatMessage[],
	generation: InitialGeneration | undefined,
	{
		buildStarted,
		buildComplete,
		awaitingAnswers,
		active,
	}: {
		buildStarted: boolean;
		buildComplete: boolean;
		awaitingAnswers: boolean;
		active: boolean;
	},
): InitialGeneration | undefined {
	if (generation) return generation;
	const firstPrompt = messages.find((message) => message.role === "user");
	if (!firstPrompt) return;
	const hasInitialFlow = messages.some((message) => {
		if (message.role !== "assistant") return false;
		const taggedId = (message.metadata as { initialGenerationId?: unknown } | undefined)
			?.initialGenerationId;
		return (
			taggedId === firstPrompt.id ||
			(message.parts ?? []).some((part) => isAskQuestionsToolPart(part))
		);
	});
	if (!hasInitialFlow) return;
	return {
		id: firstPrompt.id,
		status: buildComplete
			? "ready"
			: awaitingAnswers
				? "awaiting_answers"
				: buildStarted
					? active
						? "building"
						: "failed"
					: "preparing",
	};
}

export function projectInitialGeneration(
	messages: ChatMessage[],
	generation?: InitialGeneration,
): InitialGenerationView | undefined {
	const firstUserIndex = generation
		? messages.findIndex((message) => message.id === generation.id)
		: -1;
	if (!generation || firstUserIndex < 0) return;

	const groupedMessageIds = new Set<string>();
	const answerMessageIds = new Set<string>();
	const questionCalls = new Set<string>();
	const submissions = new Map<number, QuestionnaireSubmission>();
	let answerCount = 0;
	let usingDefaults = false;

	let withinInitialTurn = true;
	for (let index = firstUserIndex + 1; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "user") {
			const submission = readQuestionnaireSubmission(messages, index);
			if (!submission || !questionCalls.has(submission.toolCallId)) withinInitialTurn = false;
			continue;
		}
		if (message.role !== "assistant") continue;
		const taggedId = (message.metadata as { initialGenerationId?: unknown } | undefined)
			?.initialGenerationId;
		// During a live first turn the assistant message can appear before its
		// stream metadata arrives. Keep that reply in the initial card until an
		// unrelated user turn starts; later edits stay separate.
		if (taggedId !== generation.id && !(withinInitialTurn && taggedId === undefined)) continue;
		groupedMessageIds.add(message.id);
		for (const part of message.parts ?? []) {
			const toolCallId = "toolCallId" in part ? part.toolCallId : undefined;
			if (isAskQuestionsToolPart(part) && typeof toolCallId === "string") {
				questionCalls.add(toolCallId);
			}
		}
	}

	for (let index = 0; index < messages.length; index++) {
		const submission = readQuestionnaireSubmission(messages, index);
		if (!submission || !questionCalls.has(submission.toolCallId)) continue;
		submissions.set(index, submission);
		answerMessageIds.add(messages[index]!.id);
		answerCount += submission.answers.filter(
			(answer) => answer.selected.length > 0 || Boolean(answer.custom.trim()),
		).length;
		usingDefaults ||= submission.answers.some(
			(answer) => answer.selected.length === 0 && !answer.custom.trim(),
		);
	}

	const answeredCalls = new Map(
		[...submissions.values()].map((submission) => [submission.toolCallId, submission]),
	);
	const parts: MessagePart[] = [];
	let lastMessageStart = 0;
	for (const message of messages) {
		if (groupedMessageIds.has(message.id)) {
			lastMessageStart = parts.length;
			for (const part of message.parts ?? []) {
				const toolCallId = "toolCallId" in part ? part.toolCallId : undefined;
				if (
					isAskQuestionsToolPart(part) &&
					typeof toolCallId === "string" &&
					answeredCalls.has(toolCallId)
				) {
					parts.push({
						type: "data-questionnaire-answers",
						data: answeredCalls.get(toolCallId),
						toolCallId,
					} as MessagePart);
					continue;
				}
				parts.push(part);
			}
		}
	}

	// Only the newest message can still be streaming; parts from earlier grouped
	// replies (such as a stopped attempt before a retry) are settled history.
	const latestId = messages[messages.length - 1]?.id;
	const liveMessageId =
		latestId !== undefined && groupedMessageIds.has(latestId) ? latestId : undefined;
	const liveFromPart = liveMessageId ? lastMessageStart : parts.length;

	return {
		id: generation.id,
		message: {
			id: generation.id,
			role: "assistant",
			parts,
			metadata: { initialGenerationStatus: generation.status, liveFromPart, liveMessageId },
		},
		groupedMessageIds,
		answerMessageIds,
		answerCount,
		usingDefaults,
	};
}
