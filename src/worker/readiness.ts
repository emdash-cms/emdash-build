export type BuilderMilestone =
	| "containerStarting"
	| "previewReady"
	| "cmsReady"
	| "agentToolsReady"
	| "buildEligible"
	| "buildStarting"
	| "personalized"
	| "complete";

export interface BuilderReadinessState {
	previewReady?: boolean;
	previewRestarting?: boolean;
	cmsReady?: boolean;
	agentToolsReady?: boolean;
	personalized?: boolean;
	complete?: boolean;
	milestones?: Partial<Record<BuilderMilestone, number>>;
}

export interface BuilderMilestoneUpdate<T> {
	state: T;
	elapsedMs: number;
}

export interface BuildStepLike {
	toolCalls?: readonly { toolName?: unknown }[];
	toolResults?: readonly { toolName?: unknown; output?: unknown }[];
}

/** Find a real capture for the accepted revision; a cached acknowledgement has no PNG of its own. */
export function capturedPreviewShotId(
	steps: readonly BuildStepLike[],
	revision: number,
): string | undefined {
	for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex--) {
		const results = steps[stepIndex]?.toolResults ?? [];
		for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex--) {
			const result = results[resultIndex];
			if (result?.toolName !== "view_preview" && result?.toolName !== "validate_site") continue;
			const raw = result.output as {
				success?: unknown;
				preview?: { shotId?: unknown; revision?: unknown };
			} | null;
			// Validation carries its final capture under `preview`.
			const output = (
				result.toolName === "validate_site"
					? raw?.success === true
						? raw.preview
							? { success: true, ...raw.preview }
							: null
						: null
					: raw
			) as {
				success?: unknown;
				cached?: unknown;
				skipped?: unknown;
				shotId?: unknown;
				revision?: unknown;
			} | null;
			if (
				output?.success === true &&
				output.cached !== true &&
				output.skipped !== true &&
				output.revision === revision &&
				typeof output.shotId === "string" &&
				/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(output.shotId)
			) {
				return output.shotId;
			}
		}
	}
	return undefined;
}

export interface InitialBuildBenchmark {
	qualityValid: boolean;
	rejectionReasons: string[];
	stepCount: number;
	toolCalls: Record<string, number>;
	questionnaireToPersonalizedMs: number | null;
	modelToPersonalizedMs: number | null;
	modelToFinishMs: number | null;
	/** The build was resumed after eviction; steps cover only the resumed part. */
	resumed?: boolean;
}

const MUTATING_BUILD_TOOLS = new Set([
	"write_file",
	"write_files",
	"edit_file",
	"edit_files",
	"exec",
	"refresh_types",
	"upload_media",
	"apply_schema_plan",
	"create_entries_batch",
	"schema_create_collection",
	"schema_create_field",
	"update_blocks_field",
	"schema_update_block_type",
	"schema_activate_block_type_version",
	"content_create",
	"content_update",
	"content_publish",
	"content_unpublish",
	"content_delete",
	"content_permanent_delete",
	"content_duplicate",
	"taxonomy_create",
	"taxonomy_create_term",
	"taxonomy_update_term",
	"taxonomy_delete_term",
	"byline_create",
	"byline_update",
	"settings_update",
	"menu_create",
	"menu_update",
	"menu_set_items",
]);

function successfulToolResult(step: BuildStepLike, toolName: string): boolean {
	return (step.toolResults ?? []).some((result) => {
		if (result.toolName !== toolName) return false;
		return (
			result.output !== null &&
			typeof result.output === "object" &&
			(result.output as { success?: unknown }).success === true
		);
	});
}

/** A passing validation that captured the final preview itself. */
function validationDeliveredPreview(step: BuildStepLike): boolean {
	return (step.toolResults ?? []).some((result) => {
		if (result.toolName !== "validate_site") return false;
		const output = result.output as { success?: unknown; preview?: { shotId?: unknown } } | null;
		return output?.success === true && typeof output.preview?.shotId === "string";
	});
}

/** Final preview evidence for the validation at `validationStep`. */
function hasFinalPreview(steps: readonly BuildStepLike[], validationStep: number): boolean {
	return (
		validationDeliveredPreview(steps[validationStep]!) ||
		steps.slice(validationStep + 1).some((step) => successfulToolResult(step, "view_preview"))
	);
}

function toolMayHaveChanged(step: BuildStepLike, toolName: string): boolean {
	const results = (step.toolResults ?? []).filter((result) => result.toolName === toolName);
	if (results.length === 0) return true;
	return results.some((result) => {
		const output = result.output;
		return !(
			output !== null &&
			typeof output === "object" &&
			((output as { changed?: unknown }).changed === false ||
				(output as { cached?: unknown }).cached === true)
		);
	});
}

function milestoneDelta(
	milestones: Partial<Record<BuilderMilestone, number>>,
	from: BuilderMilestone,
	to: BuilderMilestone,
): number | null {
	const start = milestones[from];
	const end = milestones[to];
	return typeof start === "number" && typeof end === "number" ? end - start : null;
}

/**
 * Extract stable benchmark evidence from the completed AI SDK steps. A run is
 * quality-valid only when a successful validation is followed by a later
 * successful preview, with no mutation at or after that validation.
 */
export function summarizeInitialBuildBenchmark(
	milestones: Partial<Record<BuilderMilestone, number>>,
	steps: readonly BuildStepLike[],
): InitialBuildBenchmark {
	const toolCalls: Record<string, number> = {};
	for (const step of steps) {
		for (const call of step.toolCalls ?? []) {
			if (typeof call.toolName !== "string") continue;
			toolCalls[call.toolName] = (toolCalls[call.toolName] ?? 0) + 1;
		}
	}

	const successfulValidationSteps = steps.flatMap((step, index) =>
		successfulToolResult(step, "validate_site") ? [index] : [],
	);
	const validValidationStep = successfulValidationSteps.find((validationStep) => {
		const mutationAfterValidation = steps
			.slice(validationStep)
			.some((step) =>
				(step.toolCalls ?? []).some(
					(call) =>
						typeof call.toolName === "string" &&
						MUTATING_BUILD_TOOLS.has(call.toolName) &&
						toolMayHaveChanged(step, call.toolName),
				),
			);
		return !mutationAfterValidation && hasFinalPreview(steps, validationStep);
	});

	const rejectionReasons: string[] = [];
	if (successfulValidationSteps.length === 0) {
		rejectionReasons.push("missing-successful-validation");
	} else if (
		successfulValidationSteps.every((validationStep) =>
			steps
				.slice(validationStep)
				.some((step) =>
					(step.toolCalls ?? []).some(
						(call) =>
							typeof call.toolName === "string" &&
							MUTATING_BUILD_TOOLS.has(call.toolName) &&
							toolMayHaveChanged(step, call.toolName),
					),
				),
		)
	) {
		rejectionReasons.push("mutation-after-validation");
	}
	if (
		successfulValidationSteps.length > 0 &&
		!successfulValidationSteps.some((validationStep) => hasFinalPreview(steps, validationStep))
	) {
		rejectionReasons.push("missing-final-preview");
	}
	if (validValidationStep === undefined && rejectionReasons.length === 0) {
		rejectionReasons.push("invalid-quality-sequence");
	}

	const qualityValid = validValidationStep !== undefined;
	return {
		qualityValid,
		rejectionReasons,
		stepCount: steps.length,
		toolCalls: Object.fromEntries(
			Object.entries(toolCalls).sort(([left], [right]) => left.localeCompare(right)),
		),
		questionnaireToPersonalizedMs: milestoneDelta(milestones, "buildEligible", "personalized"),
		modelToPersonalizedMs: milestoneDelta(milestones, "buildStarting", "personalized"),
		modelToFinishMs: qualityValid ? milestoneDelta(milestones, "buildStarting", "complete") : null,
	};
}

/** Pure transition used by the agent and product timing tests. */
export function recordBuilderMilestone<T extends BuilderReadinessState>(
	state: T,
	milestone: BuilderMilestone,
	at = Date.now(),
): BuilderMilestoneUpdate<T> | undefined {
	if (state.milestones?.[milestone]) return undefined;

	const startedAt = state.milestones?.containerStarting ?? at;
	const flags =
		milestone === "containerStarting"
			? {}
			: milestone === "previewReady"
				? { previewReady: true }
				: milestone === "cmsReady"
					? { cmsReady: true }
					: milestone === "agentToolsReady"
						? { agentToolsReady: true }
						: milestone === "personalized"
							? { personalized: true }
							: milestone === "complete"
								? { complete: true }
								: {};

	return {
		state: {
			...state,
			...flags,
			milestones: { ...state.milestones, [milestone]: at },
		},
		elapsedMs: at - startedAt,
	};
}

/** Keep failed or follow-up refreshes from being reported as personalization. */
export function recordPersonalizationMilestone<T extends BuilderReadinessState>(
	state: T,
	initialBuild: boolean,
	refreshSucceeded: boolean,
	at = Date.now(),
): BuilderMilestoneUpdate<T> | undefined {
	return initialBuild && refreshSucceeded
		? recordBuilderMilestone(state, "personalized", at)
		: undefined;
}

/**
 * Keep initial-build bookkeeping with every retry or resumed turn until the
 * first validated site is complete; later edits are independent follow-ups.
 */
export function classifyBuildTurn(
	state: { buildStarted?: boolean; initialBuildInFlight?: boolean; complete?: boolean },
	_resuming: boolean,
): { startsInitialBuild: boolean; initialBuild: boolean } {
	const startsInitialBuild = !state.buildStarted;
	return {
		startsInitialBuild,
		initialBuild: startsInitialBuild || !state.complete,
	};
}
