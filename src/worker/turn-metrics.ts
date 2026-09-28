import type { LanguageModelUsage } from "ai";

export type TurnKind = "interview" | "holding" | "initial-build" | "follow-up";
export type TurnOutcome = "finished" | "stopped" | "error";
export type SyncKind = "previewRefresh" | "backup";

export interface TokenTotals {
	/** All input tokens, including `cachedInput`. */
	input: number;
	cachedInput: number;
	output: number;
	reasoning: number;
}

export interface TurnMetricsRecord {
	turnId: string;
	kind: TurnKind;
	resumed: boolean;
	outcome: TurnOutcome;
	finishReason?: string;
	error?: string;
	stepCapReached: boolean;
	model: string;
	promptChars: number;
	toolCount: number;
	startedAt: number;
	wallMs: number;
	setupMs: number | null;
	/** End-of-turn backup after the model finished; not part of `sync`. */
	finalSaveMs: number | null;
	/** Completed steps. A stopped turn omits the interrupted step's usage. */
	steps: number;
	tokens: TokenTotals;
	peakInputTokens: number;
	subcalls: { calls: number; tokens: TokenTotals };
	tools: Record<string, { calls: number; ms: number; failures: number }>;
	/**
	 * Preview re-renders and backups awaited inside tool calls, so a subset of
	 * `tools` time. Includes waiting behind other backups; parallel tool calls
	 * can overlap.
	 */
	sync: Record<SyncKind, { count: number; ms: number }>;
}

export interface TurnMetricsInit {
	turnId: string;
	kind: TurnKind;
	resumed: boolean;
	model: string;
	stepCap: number;
	/** When the turn began, before setup; defaults to construction time. */
	startedAt?: number;
	now?: () => number;
}

const MAX_ERROR_CHARS = 300;

function emptyTokens(): TokenTotals {
	return { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
}

function addUsage(totals: TokenTotals, usage: LanguageModelUsage): void {
	totals.input += usage.inputTokens ?? 0;
	totals.cachedInput += usage.inputTokenDetails?.cacheReadTokens ?? 0;
	totals.output += usage.outputTokens ?? 0;
	totals.reasoning += usage.outputTokenDetails?.reasoningTokens ?? 0;
}

function errorText(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.slice(0, MAX_ERROR_CHARS);
}

/**
 * Accumulates one builder turn's cost and timing. Several callbacks can end a
 * turn (onFinish, onAbort, the chat-response fallback); only the first
 * `finish` produces a record.
 */
export class TurnMetrics {
	private readonly now: () => number;
	private readonly startedAt: number;
	private setupMs: number | null = null;
	private finalSaveMs: number | null = null;
	private promptChars = 0;
	private toolCount = 0;
	private stepCount = 0;
	private peakInputTokens = 0;
	private readonly tokens = emptyTokens();
	private readonly subcalls = { calls: 0, tokens: emptyTokens() };
	// Invalid calls carry model-chosen names, so no prototype keys like `__proto__`.
	private readonly tools: TurnMetricsRecord["tools"] = Object.create(null);
	private readonly executedToolCalls = new Set<string>();
	private readonly sync: TurnMetricsRecord["sync"] = {
		previewRefresh: { count: 0, ms: 0 },
		backup: { count: 0, ms: 0 },
	};
	private error: string | undefined;
	private modelFinishReason: string | undefined;
	private finished = false;

	constructor(private readonly init: TurnMetricsInit) {
		this.now = init.now ?? Date.now;
		this.startedAt = init.startedAt ?? this.now();
	}

	/** The model call is about to start; everything before it is setup. */
	streamStarted(prompt: { promptChars: number; toolCount: number }): void {
		this.setupMs = this.now() - this.startedAt;
		this.promptChars = prompt.promptChars;
		this.toolCount = prompt.toolCount;
	}

	onStep(step: {
		usage: LanguageModelUsage;
		content?: ReadonlyArray<{ type: string; toolCallId?: string; toolName?: string }>;
	}): void {
		this.stepCount += 1;
		addUsage(this.tokens, step.usage);
		this.peakInputTokens = Math.max(this.peakInputTokens, step.usage.inputTokens ?? 0);
		// Calls the SDK rejected without running (bad input, unknown or inactive
		// tool) reach no onToolCallFinish; count them as failed calls here.
		for (const part of step.content ?? []) {
			if (part.type !== "tool-error" || !part.toolCallId || !part.toolName) continue;
			if (this.executedToolCalls.has(part.toolCallId)) continue;
			const entry = this.toolEntry(part.toolName);
			entry.calls += 1;
			entry.failures += 1;
		}
	}

	onToolCallFinish(event: {
		toolCall: { toolName: string; toolCallId: string };
		durationMs: number;
		success: boolean;
		output?: unknown;
	}): void {
		this.executedToolCalls.add(event.toolCall.toolCallId);
		const entry = this.toolEntry(event.toolCall.toolName);
		entry.calls += 1;
		entry.ms += Math.round(event.durationMs);
		const reportedFailure =
			event.output !== null &&
			typeof event.output === "object" &&
			(event.output as { success?: unknown }).success === false;
		if (!event.success || reportedFailure) entry.failures += 1;
	}

	private toolEntry(name: string): TurnMetricsRecord["tools"][string] {
		return (this.tools[name] ??= { calls: 0, ms: 0, failures: 0 });
	}

	/** Model calls made inside a tool, such as batch entry text. */
	addSubcall(usage: LanguageModelUsage): void {
		this.subcalls.calls += 1;
		addUsage(this.subcalls.tokens, usage);
	}

	/**
	 * A streamText `onError`. It never ends the record: the failed step's usage
	 * arrives afterwards, and `onFinish` or the chat-response fallback ends it.
	 */
	noteError(error: unknown): void {
		this.error ??= errorText(error);
	}

	async timeSync<T>(kind: SyncKind, run: () => Promise<T>): Promise<T> {
		const started = this.now();
		try {
			return await run();
		} finally {
			this.sync[kind].count += 1;
			this.sync[kind].ms += this.now() - started;
		}
	}

	/** The model loop ended; only the end-of-turn save remains. */
	modelFinished(finishReason: string | undefined): void {
		this.modelFinishReason = finishReason;
	}

	async timeFinalSave<T>(run: () => Promise<T>): Promise<T> {
		const started = this.now();
		try {
			return await run();
		} finally {
			this.finalSaveMs = this.now() - started;
		}
	}

	/**
	 * Fallback from ai-chat's `onChatResponse`, which runs after every turn:
	 * some stream failures reach no streamText callback at all.
	 */
	finishFromResponse(result: {
		status: "completed" | "error" | "aborted";
		error?: string;
	}): TurnMetricsRecord | null {
		// A Stop during the end-of-turn save does not undo a finished model turn;
		// it is recorded now, without the save's time, rather than risk no record.
		const stopped = result.status === "aborted" && this.modelFinishReason === undefined;
		const outcome = stopped ? "stopped" : result.status === "error" ? "error" : "finished";
		return this.finish(outcome, { error: result.error });
	}

	/**
	 * The finished turn as it stands before the end-of-turn save, without
	 * ending it; recovery records this if eviction interrupts the save.
	 * Undefined once the turn is recorded (e.g. already stopped).
	 */
	pendingRecord(): TurnMetricsRecord | undefined {
		return this.finished ? undefined : this.build("finished", {});
	}

	finish(
		outcome: TurnOutcome,
		details: { finishReason?: string; error?: unknown } = {},
	): TurnMetricsRecord | null {
		if (this.finished) return null;
		this.finished = true;
		if (details.error !== undefined) this.noteError(details.error);
		return this.build(outcome, details);
	}

	private build(outcome: TurnOutcome, details: { finishReason?: string }): TurnMetricsRecord {
		const finishReason = details.finishReason ?? this.modelFinishReason;
		return {
			turnId: this.init.turnId,
			kind: this.init.kind,
			resumed: this.init.resumed,
			outcome: this.error && outcome === "finished" ? "error" : outcome,
			...(finishReason ? { finishReason } : {}),
			...(this.error ? { error: this.error } : {}),
			stepCapReached: this.stepCount >= this.init.stepCap && finishReason === "tool-calls",
			model: this.init.model,
			promptChars: this.promptChars,
			toolCount: this.toolCount,
			startedAt: this.startedAt,
			wallMs: this.now() - this.startedAt,
			setupMs: this.setupMs,
			finalSaveMs: this.finalSaveMs,
			steps: this.stepCount,
			tokens: { ...this.tokens },
			peakInputTokens: this.peakInputTokens,
			subcalls: { calls: this.subcalls.calls, tokens: { ...this.subcalls.tokens } },
			tools: structuredClone(this.tools),
			sync: structuredClone(this.sync),
		};
	}
}

/** Time `run` against the turn's metrics when there is an active turn. */
export function timeSync<T>(
	metrics: TurnMetrics | undefined,
	kind: SyncKind,
	run: () => Promise<T>,
): Promise<T> {
	return metrics ? metrics.timeSync(kind, run) : run();
}
