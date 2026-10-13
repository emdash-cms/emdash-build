import {
	InvalidToolInputError,
	isToolUIPart,
	JSONParseError,
	NoSuchToolError,
	TypeValidationError,
	type UIMessage,
} from "ai";
import type { QuestionnaireMessageLike } from "../shared/questionnaire.js";
import { redactArtifactsToken } from "./artifacts-auth.js";
import { shouldGateInitialBuild } from "./questionnaire.js";
import type { TurnMetricsRecord } from "./turn-metrics.js";

export interface SiteReadyTurn {
	messages: readonly QuestionnaireMessageLike[];
	buildStarted: boolean;
	/** True when recovery resumes or restarts a turn interrupted by eviction. */
	resuming: boolean;
	/** A stopped generation resumes only when a newer user message arrives. */
	stoppedAtMessageId?: string;
}

/**
 * Site-ready turns without a new user message do no work in two cases: the
 * provision auto-turn is waiting for unanswered interview questions, or a
 * queued user turn already started the build. Recovering an interrupted
 * build is real work and must run.
 */
export function shouldSkipSiteReadyTurn({
	messages,
	buildStarted,
	resuming,
	stoppedAtMessageId,
}: SiteReadyTurn): boolean {
	if (stoppedAtMessageId) {
		const latestUser = [...messages].reverse().find((message) => message.role === "user");
		if (latestUser?.id === stoppedAtMessageId) return true;
	}
	const isUserTurn = messages[messages.length - 1]?.role === "user";
	if (shouldGateInitialBuild(messages, isUserTurn)) return true;
	return !isUserTurn && buildStarted && !resuming;
}

export function shouldAutoStartInitialBuild(
	ready: boolean,
	buildStarted: boolean,
	status?: string,
): boolean {
	return (
		ready && !buildStarted && status !== "stopping" && status !== "stopped" && status !== "failed"
	);
}

export const INTERRUPTED_TOOL_ERROR =
	"Interrupted before a result was recorded (the turn was stopped or the server restarted); " +
	"it may have run. Check the current site or CMS state before retrying.";

/**
 * Turns run one at a time, so a tool call still awaiting its result when a
 * new turn starts belongs to a turn that was interrupted. Left open, it makes
 * every later prompt invalid (a call without a result). Record it as failed so
 * the history stays promptable and the model knows the step may need checking.
 *
 * Returns the repaired messages, or `undefined` when nothing was open.
 */
export function closeInterruptedToolCalls(messages: readonly UIMessage[]): UIMessage[] | undefined {
	let changed = false;
	const repaired = messages.map((message) => {
		if (message.role !== "assistant") return message;
		let messageChanged = false;
		const parts = message.parts.map((part): UIMessage["parts"][number] => {
			if (!isToolUIPart(part)) return part;
			if (part.state !== "input-streaming" && part.state !== "input-available") return part;
			messageChanged = true;
			return {
				...part,
				state: "output-error",
				input: part.input ?? {},
				errorText: INTERRUPTED_TOOL_ERROR,
			} as UIMessage["parts"][number];
		});
		if (!messageChanged) return message;
		changed = true;
		return { ...message, parts };
	});
	return changed ? repaired : undefined;
}

const STARTED_TURN_STASH = { chatTurnStarted: true } as const;
const FINISHED_TURN_STASH = { chatTurnFinished: true } as const;

/**
 * Checkpoint that the current chat turn got past the site-ready gate, so a
 * restart after eviction runs it again instead of re-deciding (by then the
 * turn may have marked the build as started, which would make the gate skip
 * it). A turn evicted before this point is re-gated like a new turn.
 */
export function markChatTurnStarted(agent: { stash(data: unknown): void }): void {
	try {
		agent.stash(STARTED_TURN_STASH);
	} catch {
		// Outside a recovery fiber there is nothing to checkpoint.
	}
}

/**
 * Checkpoint that the current chat turn's reply is complete, so recovery does
 * not continue it when eviction lands in post-turn work such as the backup.
 * `turnMetrics` is the turn's record so far; recovery writes it instead, and
 * checkpointing again without it (once recorded) prevents a second record.
 */
export function markChatTurnFinished(
	agent: { stash(data: unknown): void },
	turnMetrics?: TurnMetricsRecord,
): void {
	try {
		// ai-chat internal: persist the reply chunks received so far. The final
		// text-end/finish chunks may still be in flight, so the tail can be lost.
		(agent as { _flushChunkBuffer?(): void })._flushChunkBuffer?.();
		agent.stash(turnMetrics ? { ...FINISHED_TURN_STASH, turnMetrics } : FINISHED_TURN_STASH);
	} catch {
		// Outside a recovery fiber there is nothing to checkpoint.
	}
}

/** The record a finished turn stashed before an interrupted end-of-turn save. */
export function stashedTurnMetrics(recoveryData: unknown): TurnMetricsRecord | undefined {
	if (!hasStashFlag(recoveryData, "chatTurnFinished")) return undefined;
	const record = (recoveryData as { turnMetrics?: unknown }).turnMetrics;
	return typeof record === "object" &&
		record !== null &&
		typeof (record as { turnId?: unknown }).turnId === "string"
		? (record as TurnMetricsRecord)
		: undefined;
}

export type ChatRecoveryPlan = "skip" | "continue" | "restart" | "retry";

/**
 * How to recover a chat turn interrupted by eviction. A finished reply needs
 * nothing. A reply that already streamed output is continued in place. A turn
 * that streamed nothing runs again as a fresh turn (continuing it would append
 * the new reply to the previous assistant message instead): "restart" when it
 * had passed the site-ready gate, so it runs past the gate again, and "retry"
 * when it had not, so the gate decides as for any new turn.
 */
export function planChatRecovery(ctx: {
	recoveryData: unknown;
	partialParts: readonly unknown[];
}): ChatRecoveryPlan {
	if (hasStashFlag(ctx.recoveryData, "chatTurnFinished")) return "skip";
	if (ctx.partialParts.length > 0) return "continue";
	return hasStashFlag(ctx.recoveryData, "chatTurnStarted") ? "restart" : "retry";
}

function hasStashFlag(
	recoveryData: unknown,
	flag: "chatTurnStarted" | "chatTurnFinished",
): boolean {
	return (
		typeof recoveryData === "object" &&
		recoveryData !== null &&
		(recoveryData as Record<string, unknown>)[flag] === true
	);
}

/** Longest tool error kept in a reply; a longer one loses its middle. */
const MAX_TOOL_ERROR_CHARS = 2_000;

/**
 * Error text for a reply's UI stream, which reports a failed tool call through
 * the same callback as a failed turn. A tool call keeps its own message, as the
 * model reads it, so the activity details say why the call failed; anything
 * else failed the turn and gets `turnErrorText`. The text reaches the owner and
 * the saved history, and only Artifacts tokens are redacted, so tools must keep
 * secrets out of their errors.
 *
 * Pass `noteToolCall` to `experimental_onToolCallFinish`, which sees an
 * execution error before the stream reports it. A call the SDK refused to run
 * (bad input, unknown tool) is reported twice: as its own error type, then as
 * that error's message.
 */
export function replyErrors(turnErrorText: (error: unknown) => string) {
	const toolErrors = new WeakSet<object>();
	/** The SDK's message for each refused call, and the text shown for it. */
	const refusedCalls = new Map<string, string>();
	const shown = (error: unknown, message: string) => {
		if (!message) return turnErrorText(error);
		const text = redactArtifactsToken(message);
		if (text.length <= MAX_TOOL_ERROR_CHARS) return text;
		const half = MAX_TOOL_ERROR_CHARS / 2;
		return `${text.slice(0, half)} … ${text.slice(-half)}`;
	};
	return {
		noteToolCall(event: { success: boolean; error?: unknown }): void {
			if (!event.success && typeof event.error === "object" && event.error !== null) {
				toolErrors.add(event.error);
			}
		},
		errorText(error: unknown): string {
			if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) {
				const text = shown(error, refusedCallMessage(error));
				refusedCalls.set(error.message, text);
				return text;
			}
			if (typeof error === "string") return refusedCalls.get(error) ?? turnErrorText(error);
			if (typeof error !== "object" || error === null || !toolErrors.has(error)) {
				return turnErrorText(error);
			}
			return shown(error, errorMessage(error));
		},
	};
}

/** Why the SDK refused a call. Its own message for bad input repeats the whole input. */
function refusedCallMessage(error: InvalidToolInputError | NoSuchToolError): string {
	if (!InvalidToolInputError.isInstance(error)) return error.message;
	const cause =
		TypeValidationError.isInstance(error.cause) || JSONParseError.isInstance(error.cause)
			? error.cause.cause
			: error.cause;
	if (cause == null) return error.message;
	return `Invalid input for tool ${error.toolName}: ${errorMessage(cause)}`;
}

/** As the SDK puts an error to the model. */
function errorMessage(error: unknown): string {
	if (error == null) return "unknown error";
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

/**
 * UI stream options for a reply. Each reply announces its own message id:
 * without one, chat recovery merges an orphaned reply into the previous
 * assistant message, above the user request it answers. Continuations drop
 * the id and keep appending to the message they resume.
 */
export function replyStreamOptions(
	onError: (error: unknown) => string,
	initialGenerationId?: string,
	initialGenerationReply?: "holding",
) {
	return {
		originalMessages: [] as UIMessage[],
		generateMessageId: () => crypto.randomUUID(),
		onError,
		...(initialGenerationId
			? {
					messageMetadata: ({ part }: { part: { type: string } }) =>
						part.type === "start" || part.type === "finish"
							? {
									initialGenerationId,
									...(initialGenerationReply ? { initialGenerationReply } : {}),
								}
							: undefined,
				}
			: {}),
	};
}
