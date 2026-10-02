import type { ModelMessage } from "ai";

export interface BuildObservation {
	revision: number;
}

export interface BuildConvergenceStep {
	content?: readonly { type?: unknown; toolName?: unknown }[];
	toolResults?: readonly { toolName?: unknown; output?: unknown }[];
	response?: { messages?: ModelMessage[] };
}

interface RevisionEvent {
	revision: number;
	order: number;
}

export interface UnresolvedBuildFailure {
	key: string;
	toolName: string;
	error: string;
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonicalJson(child)]),
	);
}

/**
 * Forced repair steps per unresolved failure. A retry that changes the
 * failure's identity (a new title or filename) never resolves the original
 * key, and forcing it on every step would run the turn to its step cap.
 */
const MAX_FORCED_RECOVERY_STEPS = 3;
/** Tools whose one call retries all of their failures at once, such as an image batch. */
const BATCH_REPAIR_TOOLS = new Set(["upload_media"]);

function reportsFailure(result: unknown): boolean {
	return (
		result !== null &&
		typeof result === "object" &&
		(result as { success?: unknown }).success === false
	);
}

export function mutationKey(toolName: string, input: unknown): string {
	return `${toolName}\0${JSON.stringify(canonicalJson(input))}`;
}

/** The mutation surface a tool needs; a script run hands its tools a scoped one. */
export type MutationScope = Pick<
	BuildConvergence,
	| "runMutation"
	| "runConditionalMutation"
	| "reusedMutationResultQueued"
	| "recordUnresolvedFailure"
	| "resolveUnresolvedFailure"
>;

export interface ScriptScope extends MutationScope {
	/** Whether an inner mutation has started. */
	readonly mutated: boolean;
}

/**
 * Turn-local evidence for the site revision currently being built.
 *
 * Mutations advance the revision before touching the site. Validation and
 * preview observations are accepted only when no mutation overlaps them, so
 * parallel tool calls cannot certify partially changed output.
 */
export class BuildConvergence {
	private revision = 0;
	private mutationsInFlight = 0;
	private eventOrder = 0;
	private validationResult?: { revision: number; output: unknown };
	private validation?: RevisionEvent & { output: unknown };
	private previewCaptureRevision?: number;
	private previewDelivery?: RevisionEvent;
	private evidenceObservedRevision?: number;
	private postEvidenceFailures = 0;
	private finalPreviewFailures = 0;
	private forceText = false;
	private mutationResults = new Map<string, unknown>();
	private mutationTail: Promise<void> = Promise.resolve();
	private unresolvedFailures = new Map<string, UnresolvedBuildFailure>();
	private forcedRecoveries = new Map<string, number>();
	private readonly bypassedFailures = new Map<string, UnresolvedBuildFailure>();
	/** The failure the current step was forced to repair, and failures it recorded again. */
	private forcedStep?: { key: string; toolName: string };
	private rerecordedFailures = new Set<string>();

	constructor(private readonly abortSignal?: AbortSignal) {}

	currentRevision(): number {
		return this.revision;
	}

	waitForIdle(): Promise<void> {
		return this.mutationTail;
	}

	cachedMutationResult<T>(key: string): { hit: true; value: T } | { hit: false } {
		if (!this.mutationResults.has(key)) return { hit: false };
		return { hit: true, value: this.mutationResults.get(key) as T };
	}

	reusedMutationResult<T>(key: string): { hit: true; value: T } | { hit: false } {
		const cached = this.cachedMutationResult<T>(key);
		return cached.hit ? { hit: true, value: this.cachedNoChange(cached.value) } : cached;
	}

	reusedMutationResultQueued<T>(key: string): Promise<{ hit: true; value: T } | { hit: false }> {
		return this.enqueueMutation(async () => this.reusedMutationResult<T>(key));
	}

	recordMutationResult<T>(key: string, value: T, revision = this.revision): boolean {
		if (revision !== this.revision || this.mutationsInFlight > 1) return false;
		this.mutationResults.clear();
		this.mutationResults.set(key, value);
		return true;
	}

	runMutation<T>(
		operation: () => Promise<T>,
		options: {
			key?: string;
			cacheResult?: (result: T) => boolean;
		} = {},
	): Promise<T> {
		return this.enqueueMutation(async () => {
			if (options.key) {
				const cached = this.reusedMutationResult<T>(options.key);
				if (cached.hit) return cached.value;
			}
			return this.executeMutation(operation, options);
		});
	}

	runConditionalMutation<T>(
		prepare: () => Promise<
			{ changed: false; result: T } | { changed: true; operation: () => Promise<T> }
		>,
		options: {
			key?: string;
			cacheResult?: (result: T) => boolean;
		} = {},
	): Promise<T> {
		return this.enqueueMutation(async () => {
			if (options.key) {
				const cached = this.reusedMutationResult<T>(options.key);
				if (cached.hit) return cached.value;
			}
			const prepared = await prepare();
			this.abortSignal?.throwIfAborted();
			if (!prepared.changed) return prepared.result;
			return this.executeMutation(prepared.operation, options);
		});
	}

	/**
	 * One mutation window for a whole program of tool calls. It holds the
	 * mutation lane, advances the revision once when the first inner mutation
	 * starts, and keeps observations out until `operation` (including any sync
	 * it performs) settles. Inner calls use `scope`, which never re-enters the
	 * lane, so they cannot deadlock behind the program itself; they still run
	 * one at a time, as direct calls do.
	 */
	runScript<T>(
		operation: (scope: ScriptScope) => Promise<T>,
		options: { key?: string; cacheResult?: (result: T) => boolean } = {},
	): Promise<T> {
		return this.enqueueMutation(async () => {
			if (options.key) {
				const cached = this.reusedMutationResult<T>(options.key);
				if (cached.hit) return cached.value;
			}
			let finish: ((succeeded?: boolean) => void) | undefined;
			let revision = this.revision;
			const begin = () => {
				this.abortSignal?.throwIfAborted();
				if (finish) return;
				finish = this.beginMutation();
				revision = this.revision;
			};
			let innerTail: Promise<unknown> = Promise.resolve();
			const serial = <R>(run: () => Promise<R>): Promise<R> => {
				const scheduled = innerTail.then(run, run);
				innerTail = scheduled.catch(() => undefined);
				return scheduled;
			};
			const scope: ScriptScope = {
				get mutated() {
					return finish !== undefined;
				},
				runMutation: <R>(mutation: () => Promise<R>) =>
					serial(async () => {
						begin();
						return mutation();
					}),
				runConditionalMutation: <R>(
					prepare: () => Promise<
						{ changed: false; result: R } | { changed: true; operation: () => Promise<R> }
					>,
				) =>
					serial(async () => {
						const prepared = await prepare();
						if (!prepared.changed) return prepared.result;
						begin();
						return prepared.operation();
					}),
				reusedMutationResultQueued: async () => ({ hit: false as const }),
				recordUnresolvedFailure: (failure) => this.recordUnresolvedFailure(failure),
				resolveUnresolvedFailure: (key) => this.resolveUnresolvedFailure(key),
			};
			let succeeded = false;
			try {
				const result = await operation(scope);
				succeeded = !reportsFailure(result);
				if (succeeded && finish && options.key && (options.cacheResult?.(result) ?? true)) {
					this.recordMutationResult(options.key, result, revision);
				}
				return result;
			} finally {
				finish?.(succeeded);
			}
		});
	}

	private executeMutation<T>(
		operation: () => Promise<T>,
		options: { key?: string; cacheResult?: (result: T) => boolean },
	): Promise<T> {
		const finish = this.beginMutation();
		const revision = this.currentRevision();
		let succeeded = false;
		return operation()
			.then((result) => {
				succeeded = !reportsFailure(result);
				if (succeeded && options.key && (options.cacheResult?.(result) ?? true)) {
					this.recordMutationResult(options.key, result, revision);
				}
				return result;
			})
			.finally(() => finish(succeeded));
	}

	private enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
		const guardedRun = () => {
			this.abortSignal?.throwIfAborted();
			return run();
		};
		const scheduled = this.mutationTail.then(guardedRun, guardedRun);
		this.mutationTail = scheduled.then(
			() => undefined,
			() => undefined,
		);
		return scheduled;
	}

	private cachedNoChange<T>(value: T): T {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
		return { ...value, cached: true, changed: false } as T;
	}

	beginMutation(): (succeeded?: boolean) => void {
		const startedAfterCompleteEvidence = this.hasCompleteEvidence();
		// Exact-result reuse applies only to consecutive repeats. A different
		// mutation may make the same later input meaningful again (publish,
		// unpublish, then publish), so starting real work clears prior entries.
		this.mutationResults.clear();
		this.revision += 1;
		this.mutationsInFlight += 1;
		this.resetLoopDecision();
		let finished = false;
		return (succeeded = true) => {
			if (finished) return;
			finished = true;
			this.mutationsInFlight = Math.max(0, this.mutationsInFlight - 1);
			if (succeeded) this.postEvidenceFailures = 0;
			else if (startedAfterCompleteEvidence) this.postEvidenceFailures += 1;
		};
	}

	beginObservation(): BuildObservation | undefined {
		if (this.mutationsInFlight > 0) return undefined;
		return { revision: this.revision };
	}

	isObservationCurrent(observation: BuildObservation): boolean {
		return observation.revision === this.revision && this.mutationsInFlight === 0;
	}

	recordValidation<T>(observation: BuildObservation, output: T): boolean {
		return this.recordValidationResult(observation, output, true);
	}

	recordValidationResult<T>(observation: BuildObservation, output: T, success: boolean): boolean {
		if (!this.isObservationCurrent(observation)) return false;
		this.validationResult = { revision: observation.revision, output };
		if (success) {
			this.validation = {
				revision: observation.revision,
				order: ++this.eventOrder,
				output,
			};
		} else {
			this.validation = undefined;
		}
		return true;
	}

	currentValidationResult<T>(): T | undefined {
		if (
			!this.validationResult ||
			this.validationResult.revision !== this.revision ||
			this.mutationsInFlight > 0
		) {
			return undefined;
		}
		return this.validationResult.output as T;
	}

	currentValidation<T>(): T | undefined {
		if (
			!this.validation ||
			this.validation.revision !== this.revision ||
			this.mutationsInFlight > 0
		) {
			return undefined;
		}
		return this.validation.output as T;
	}

	hasCurrentValidation(): boolean {
		return this.currentValidation() !== undefined;
	}

	recordPreviewCapture(observation: BuildObservation): boolean {
		if (!this.isObservationCurrent(observation)) return false;
		this.previewCaptureRevision = observation.revision;
		return true;
	}

	hasCurrentPreviewCapture(): boolean {
		return this.previewCaptureRevision === this.revision && this.mutationsInFlight === 0;
	}

	recordPreviewDelivery(revision: number): boolean {
		if (
			revision !== this.revision ||
			this.previewCaptureRevision !== revision ||
			this.mutationsInFlight > 0
		) {
			return false;
		}
		this.previewDelivery = {
			revision,
			order: ++this.eventOrder,
		};
		return true;
	}

	hasCurrentPreviewDelivery(): boolean {
		return this.previewDelivery?.revision === this.revision && this.mutationsInFlight === 0;
	}

	hasCompleteEvidence(): boolean {
		return Boolean(
			this.validation &&
			this.previewDelivery &&
			this.validation.revision === this.revision &&
			this.previewDelivery.revision === this.revision &&
			this.previewDelivery.order > this.validation.order &&
			this.mutationsInFlight === 0,
		);
	}

	recordUnresolvedFailure(failure: UnresolvedBuildFailure): void {
		this.rerecordedFailures.add(failure.key);
		this.unresolvedFailures.set(failure.key, failure);
		this.bypassedFailures.delete(failure.key);
		this.forceText = false;
	}

	resolveUnresolvedFailure(key: string): void {
		this.unresolvedFailures.delete(key);
		this.forcedRecoveries.delete(key);
		this.bypassedFailures.delete(key);
	}

	/** Failures a successful forced call went around; they are no longer forced. */
	bypassedRepairs(): UnresolvedBuildFailure[] {
		return [...this.bypassedFailures.values()];
	}

	private isAbandoned(failure: UnresolvedBuildFailure): boolean {
		return (this.forcedRecoveries.get(failure.key) ?? 0) >= MAX_FORCED_RECOVERY_STEPS;
	}

	/** Failures still worth forcing a repair for; abandoned ones no longer block completion. */
	hasUnresolvedFailures(): boolean {
		return this.nextUnresolvedFailure() !== undefined;
	}

	nextUnresolvedFailure(): UnresolvedBuildFailure | undefined {
		for (const failure of this.unresolvedFailures.values()) {
			if (!this.isAbandoned(failure)) return failure;
		}
		return undefined;
	}

	/**
	 * A step is about to force a repair of this failure. It counts against that
	 * failure, and against every failure of a batch tool, whose one call
	 * retries them all; one-entry tools repair one failure per call.
	 */
	noteForcedRecovery(key: string): void {
		const forced = this.unresolvedFailures.get(key);
		if (!forced) return;
		const batch = BATCH_REPAIR_TOOLS.has(forced.toolName);
		for (const failure of this.unresolvedFailures.values()) {
			if (failure.key !== key && !(batch && failure.toolName === forced.toolName)) continue;
			this.forcedRecoveries.set(failure.key, (this.forcedRecoveries.get(failure.key) ?? 0) + 1);
		}
		this.forcedStep = { key, toolName: forced.toolName };
		this.rerecordedFailures.clear();
	}

	/** Failures that stayed unresolved through every forced repair step. */
	abandonedFailures(): UnresolvedBuildFailure[] {
		return [...this.unresolvedFailures.values()].filter((failure) => this.isAbandoned(failure));
	}

	markEvidenceExposed(): void {
		if (!this.hasCompleteEvidence()) return;
		this.evidenceObservedRevision = this.revision;
		this.forceText = this.postEvidenceFailures >= 2;
	}

	finishStep(step: BuildConvergenceStep): void {
		this.settleForcedStep(step);
		if (!this.hasCompleteEvidence()) {
			if (this.hasCurrentValidation() && this.stepFailed(step, "view_preview")) {
				this.finalPreviewFailures += 1;
				this.forceText = this.finalPreviewFailures >= 2;
				return;
			}
			this.resetLoopDecision();
			return;
		}
		this.finalPreviewFailures = 0;
		if (this.evidenceObservedRevision !== this.revision) {
			this.evidenceObservedRevision = this.revision;
			this.forceText = this.postEvidenceFailures >= 2;
			return;
		}

		if (this.stepFailed(step)) {
			this.postEvidenceFailures += 1;
			if (this.postEvidenceFailures < 2) return;
		}
		this.forceText = true;
	}

	/**
	 * A forced call that succeeded without resolving its failure went around
	 * it: a retry under a new identity (a new title, say) or a different item
	 * altogether. Forcing it again could create a duplicate, so it stops
	 * blocking, but it stays in front of the model to check or report.
	 */
	private settleForcedStep(step: BuildConvergenceStep): void {
		const forced = this.forcedStep;
		const rerecorded = this.rerecordedFailures;
		this.forcedStep = undefined;
		this.rerecordedFailures = new Set();
		if (!forced || rerecorded.has(forced.key)) return;
		const called = (step.toolResults ?? []).some((result) => result.toolName === forced.toolName);
		const failure = this.unresolvedFailures.get(forced.key);
		if (failure && called && !this.stepFailed(step, forced.toolName)) {
			// Its forced steps still count, should it fail again.
			this.unresolvedFailures.delete(forced.key);
			this.bypassedFailures.set(forced.key, failure);
		}
	}

	private stepFailed(step: BuildConvergenceStep, toolName?: string): boolean {
		return (
			(step.content ?? []).some(
				(part) =>
					part.type === "tool-error" && (toolName === undefined || part.toolName === toolName),
			) ||
			(step.toolResults ?? []).some((result) => {
				if (toolName !== undefined && result.toolName !== toolName) return false;
				const output = result.output;
				return (
					output !== null &&
					typeof output === "object" &&
					(output as { success?: unknown }).success === false
				);
			})
		);
	}

	shouldForceText(): boolean {
		return this.forceText && !this.hasUnresolvedFailures();
	}

	private resetLoopDecision(): void {
		this.evidenceObservedRevision = undefined;
		this.finalPreviewFailures = 0;
		this.forceText = false;
	}
}

/** Tools whose results can carry a preview screenshot: validation attaches the final one. */
const PREVIEW_IMAGE_TOOLS = new Set(["view_preview", "validate_site"]);

/** The screenshot caption; pruning drops it with the image and keeps any other text. */
export const PREVIEW_IMAGE_CAPTION =
	"Current preview screenshot. Review layout, spacing, alignment, colour/contrast, whether images loaded, any empty or broken sections, and how well it matches the brief. If anything looks off, fix it and look again.";

const OMITTED_PREVIEW_TEXT =
	"A superseded preview image was omitted from the current build context.";

export function prunePreviewImages(messages: ModelMessage[], keepLatest: boolean): ModelMessage[] {
	const imageLocations: Array<{ messageIndex: number; partIndex: number }> = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role !== "tool" || !Array.isArray(message.content)) continue;
		for (const [partIndex, part] of message.content.entries()) {
			if (
				part.type !== "tool-result" ||
				!PREVIEW_IMAGE_TOOLS.has(part.toolName) ||
				part.output.type !== "content" ||
				!part.output.value.some((item) => item.type === "file-data")
			) {
				continue;
			}
			imageLocations.push({ messageIndex, partIndex });
		}
	}
	const retained = keepLatest ? imageLocations.at(-1) : undefined;
	const removals = new Map<number, Set<number>>();
	for (const location of imageLocations) {
		if (
			retained &&
			location.messageIndex === retained.messageIndex &&
			location.partIndex === retained.partIndex
		) {
			continue;
		}
		const indexes = removals.get(location.messageIndex) ?? new Set<number>();
		indexes.add(location.partIndex);
		removals.set(location.messageIndex, indexes);
	}
	for (const [messageIndex, indexes] of removals) {
		const message = messages[messageIndex];
		if (!message || message.role !== "tool" || !Array.isArray(message.content)) {
			continue;
		}
		message.content = message.content.map((part, partIndex) => {
			if (!indexes.has(partIndex) || part.type !== "tool-result") return part;
			// Keep what else the result said, such as validation output beside the image.
			const kept =
				part.output.type === "content"
					? part.output.value.flatMap((item) =>
							item.type === "text" && item.text !== PREVIEW_IMAGE_CAPTION ? [item.text] : [],
						)
					: [];
			return {
				...part,
				output: { type: "text" as const, value: [...kept, OMITTED_PREVIEW_TEXT].join("\n") },
			};
		});
	}
	return messages;
}

const PREVIEW_USER_TEXT =
	"Current preview screenshot. Review it before deciding whether the site needs another real change.";

function isPromotedPreviewMessage(message: ModelMessage): boolean {
	return (
		message.role === "user" &&
		Array.isArray(message.content) &&
		message.content.some((part) => part.type === "text" && part.text === PREVIEW_USER_TEXT) &&
		message.content.some((part) => part.type === "file")
	);
}

export function promoteLatestPreviewImage(
	messages: ModelMessage[],
	includeLatest: boolean,
): { messages: ModelMessage[]; promoted: boolean } {
	let latest:
		| {
				text: string;
				data: string;
				mediaType: string;
		  }
		| undefined;
	for (const message of messages) {
		if (message.role !== "tool" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (
				part.type !== "tool-result" ||
				!PREVIEW_IMAGE_TOOLS.has(part.toolName) ||
				part.output.type !== "content"
			) {
				continue;
			}
			const file = part.output.value.find((item) => item.type === "file-data");
			if (!file || typeof file.data !== "string") continue;
			latest = {
				text:
					part.output.value
						.filter((item): item is { type: "text"; text: string } => item.type === "text")
						.map((item) => item.text)
						.join("\n") || PREVIEW_USER_TEXT,
				data: file.data,
				mediaType: file.mediaType,
			};
		}
	}

	const prepared = messages.filter((message) => !isPromotedPreviewMessage(message));
	prunePreviewImages(prepared, false);
	if (!includeLatest || !latest) return { messages: prepared, promoted: false };
	prepared.push({
		role: "user",
		content: [
			{ type: "text", text: PREVIEW_USER_TEXT },
			{ type: "file", data: latest.data, mediaType: latest.mediaType },
		],
	});
	return { messages: prepared, promoted: true };
}

export function releaseStepPreviewImages(step: BuildConvergenceStep): void {
	if (step.response?.messages) prunePreviewImages(step.response.messages, false);
}

export function canCompleteBuild(convergence: BuildConvergence, finishReason: unknown): boolean {
	return (
		typeof finishReason === "string" &&
		finishReason !== "error" &&
		finishReason !== "tool-calls" &&
		convergence.hasCompleteEvidence() &&
		!convergence.hasUnresolvedFailures() &&
		convergence.shouldForceText()
	);
}

const ABANDONED_REPAIR_NOTE =
	"The builder stopped requiring repairs for these failures after three attempts. Fix them if you can; otherwise say in your final summary what is still missing:";
const BYPASSED_REPAIR_NOTE =
	"A later call of the same tool succeeded, but not as these failed calls; one may have been retried under another name or slug. Check each is covered (for example with content_list) before creating it again; otherwise say in your final summary what is still missing:";

/**
 * Say which failure a forced step is for: two calls of one tool can fail the
 * same way, and a retry of the other would look like the repair.
 */
function withForcedRepairNote(
	messages: ModelMessage[],
	failure: UnresolvedBuildFailure,
): ModelMessage[] {
	// Keys end with what failed: a collection, locale and entry, or an image.
	const subject = failure.key.split("\0").slice(1).filter(Boolean).join(" / ");
	const text = `Retry this failed ${failure.toolName} call${subject ? ` for ${subject}` : ""} now: ${failure.error.slice(0, 200)}`;
	return [...messages, { role: "user", content: [{ type: "text", text }] }];
}

/** Keep repairs the builder no longer forces in front of the model, so its summary reports them. */
function withAbandonedRepairNote(
	messages: ModelMessage[],
	convergence: BuildConvergence,
): ModelMessage[] {
	const section = (note: string, failures: UnresolvedBuildFailure[]) =>
		failures.length === 0
			? []
			: [
					note,
					...failures
						.slice(0, 5)
						.map((failure) => `- ${failure.toolName}: ${failure.error.slice(0, 200)}`),
				];
	const lines = [
		...section(ABANDONED_REPAIR_NOTE, convergence.abandonedFailures()),
		...section(BYPASSED_REPAIR_NOTE, convergence.bypassedRepairs()),
	];
	if (lines.length === 0) return messages;
	return [...messages, { role: "user", content: [{ type: "text", text: lines.join("\n") }] }];
}

/**
 * One step's gating. The full tool list is always sent: narrowing it changes
 * the cached prompt prefix, so `allowedTools` restricts calls through the
 * provider (OpenAI `allowed_tools`) instead. A text-only step and a tool
 * restriction are exclusive, since the provider lets the restriction win.
 */
export type PreparedBuildStep<TOOL_NAME extends string> = { messages: ModelMessage[] } & (
	| {
			toolChoice?: undefined;
			allowedTools?: { toolNames: TOOL_NAME[]; mode: "auto" | "required" };
	  }
	| { toolChoice: "none"; allowedTools?: undefined }
);

export function prepareBuildStep<TOOL_NAME extends string>(
	convergence: BuildConvergence,
	messages: ModelMessage[],
	toolNames: readonly TOOL_NAME[],
): PreparedBuildStep<TOOL_NAME> {
	const preparedPreview = promoteLatestPreviewImage(
		messages,
		convergence.hasCurrentPreviewCapture(),
	);
	if (preparedPreview.promoted) {
		convergence.recordPreviewDelivery(convergence.currentRevision());
		convergence.markEvidenceExposed();
	}
	const prunedMessages = withAbandonedRepairNote(preparedPreview.messages, convergence);
	// A shell command counts as a mutation, so it would void current validation.
	const callable = convergence.hasCurrentValidation()
		? toolNames.filter((toolName) => toolName !== "exec")
		: [...toolNames];
	const required = (toolName: TOOL_NAME): PreparedBuildStep<TOOL_NAME> => ({
		messages: prunedMessages,
		allowedTools: { toolNames: [toolName], mode: "required" },
	});
	const unresolved = convergence.nextUnresolvedFailure();
	const recoveryTool = unresolved
		? callable.find((toolName) => toolName === unresolved.toolName)
		: undefined;
	if (unresolved && recoveryTool) {
		convergence.noteForcedRecovery(unresolved.key);
		return {
			messages: withForcedRepairNote(prunedMessages, unresolved),
			allowedTools: { toolNames: [recoveryTool], mode: "required" },
		};
	}
	if (convergence.shouldForceText()) {
		return { messages: prunedMessages, toolChoice: "none" };
	}
	if (convergence.hasCurrentValidation()) {
		if (!convergence.hasCompleteEvidence()) {
			const previewTool = callable.find((toolName) => toolName === "view_preview");
			if (previewTool) return required(previewTool);
		}
		if (callable.length < toolNames.length) {
			return { messages: prunedMessages, allowedTools: { toolNames: callable, mode: "auto" } };
		}
	}
	return { messages: prunedMessages };
}
