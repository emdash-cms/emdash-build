import type { ModelMessage } from "ai";
import type { BuildConvergence } from "./build-convergence.js";
import {
	builderProvider,
	prepareBuildTurnStep,
	turnInputMessages,
	type BuilderReasoningEffort,
} from "./model.js";

export const HAND_OFF_DESIGN = "hand_off_design";

/** The designer inspects the scaffold, creates the schema, and writes the design system. */
const DESIGNER_TOOLS: ReadonlySet<string> = new Set([
	"read_file",
	"read_files",
	"exec",
	"apply_schema_plan",
	"refresh_types",
	"write_file",
	"write_files",
	"edit_file",
	"edit_files",
	HAND_OFF_DESIGN,
]);

/** Designer steps before `hand_off_design` is the only tool left. */
export const DESIGN_STEP_CAP = 8;

/**
 * A first build split between a designer model and a builder model. The
 * designer runs from the turn's first step until `hand_off_design` succeeds,
 * and every later step runs on the builder. A resumed build that already
 * handed off starts on the builder.
 */
export class DesignHandoff {
	constructor(
		readonly designer: string,
		readonly builder: string,
		private spec?: string,
	) {}

	get handedOff(): boolean {
		return this.spec !== undefined;
	}

	handOff(spec: string): void {
		this.spec = spec;
	}

	role(): "designer" | "builder" {
		return this.handedOff ? "builder" : "designer";
	}

	modelId(): string {
		return this.handedOff ? this.builder : this.designer;
	}

	mustHandOff(stepNumber: number): boolean {
		return !this.handedOff && stepNumber >= DESIGN_STEP_CAP;
	}

	/** The tools a step may call. */
	toolNames<TOOL_NAME extends string>(all: readonly TOOL_NAME[], stepNumber: number): TOOL_NAME[] {
		if (this.handedOff) return all.filter((name) => name !== HAND_OFF_DESIGN);
		if (this.mustHandOff(stepNumber)) return all.filter((name) => name === HAND_OFF_DESIGN);
		return all.filter((name) => DESIGNER_TOOLS.has(name));
	}
}

type DesignRole = ReturnType<DesignHandoff["role"]>;

/**
 * One step of a split first build: the current role's model and prompt, its
 * tools, and the conversation without the other provider's reasoning. Once
 * the designer has used its steps, the hand-off is the only tool left.
 */
export function prepareSplitBuildStep<TOOL_NAME extends string, MODEL>(
	handoff: DesignHandoff,
	roles: Record<DesignRole, { model: MODEL; system: string }>,
	convergence: BuildConvergence,
	messages: ModelMessage[],
	toolNames: readonly TOOL_NAME[],
	step: {
		initialBuild: boolean;
		stepNumber: number;
		routineEffort?: BuilderReasoningEffort;
		effort?: BuilderReasoningEffort;
	},
) {
	const role = roles[handoff.role()];
	const provider = builderProvider(handoff.modelId());
	const stepTools = handoff.toolNames(toolNames, step.stepNumber);
	const prepared = prepareBuildTurnStep(convergence, messages, stepTools, { ...step, provider });
	return {
		...prepared,
		...(handoff.mustHandOff(step.stepNumber)
			? { toolChoice: { type: "tool" as const, toolName: HAND_OFF_DESIGN as TOOL_NAME } }
			: {}),
		model: role.model,
		system: role.system,
		activeTools: stepTools,
		messages: turnInputMessages(prepared.messages, provider),
	};
}
