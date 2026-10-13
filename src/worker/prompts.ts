/**
 * System prompts for the EmDash Build agent.
 *
 * Two phases:
 *   1. INTERVIEW -- first turn. The site is provisioning in the background.
 *      The model has only the ask_questions tool; it runs a short,
 *      domain-neutral intake while provisioning continues.
 *   2. BUILD -- subsequent turns. Provisioning is done; the full tool set
 *      is available. The model designs from the blank scaffold and creates
 *      the schema, public frontend, and real content.
 *
 * Prose lives in the sibling `prompts/` directory as markdown so it can
 * be edited as prose. CMS tool descriptions come from MCP at runtime
 * and are not duplicated here.
 */

import blankBuildPrompt from "./prompts/build-blank.md?raw";
import blocksContract from "./prompts/blocks-contract.md?raw";
import blocksFollowUp from "./prompts/blocks-follow-up.md?raw";
import followUpPrompt from "./prompts/build-follow-up.md?raw";
import interviewHeader from "./prompts/interview.md?raw";
import interviewBlank from "./prompts/interview-blank.md?raw";
import type { InitialScaffoldContext } from "./initial-scaffold.js";

export function buildInterviewPrompt(): string {
	return [interviewHeader, interviewBlank].join("\n\n");
}

/**
 * System prompt for a follow-up turn during the interview phase -- the user
 * replied (or added more detail) while the site is still provisioning. We must
 * NOT re-ask the interview questions (that reads as a broken loop); just
 * acknowledge the new detail and reassure them building starts automatically
 * once setup finishes.
 */
export function buildHoldingPrompt(): string {
	return [
		"You are setting up an EmDash site. You already asked the user some clarifying questions and the site is still being provisioned in the background.",
		"The user sent a freeform message while setup continues. If they asked a direct question, answer it briefly in one or two sentences. Otherwise acknowledge the new detail in one short sentence and say it will be included when building starts.",
		"Do not repeat the interview questions or their answers. Do not present a numbered list, restate a plan, or claim the site has been built. Building begins automatically after setup.",
	].join("\n\n");
}

export interface BuildPromptOptions {
	/** The blank scaffold's AGENTS.md body, if available. */
	templateGuidance?: string;
	/** Immutable source captured before the first model-authored mutation. */
	initialScaffoldContext?: InitialScaffoldContext;
	editMode?: boolean;
	/** `run_cms_script` is available this turn. */
	cmsScripts?: boolean;
}

const CMS_PROGRAMS = [
	"## CMS programs",
	"`run_cms_script` runs one short program of CMS calls in a single step and checkpoints once. Use it for three or more CMS calls that belong together, such as site settings and menus, or bylines, uploaded images, entries and the menus that link them, and for one change repeated across many entries. Use direct tools for a single change, for a result you must read before deciding what to do next, and for schema plans, block-type changes, `create_entries_batch`, files, validation and preview. Pass explicit slugs. If a program fails partway, fix only the calls its `log` marks as failed; do not re-run it whole.",
].join("\n\n");

function initialScaffoldSection(context: InitialScaffoldContext): string {
	const files = context.files.map(
		(file) => `<file path="${file.path}" bytes="${file.bytes}">\n${file.content}\n</file>`,
	);
	const missing =
		context.missingPaths.length > 0
			? `Missing from the snapshot: ${context.missingPaths.join(", ")}. Read only those paths if they are needed.`
			: "All fixed scaffold files were captured successfully.";
	return [
		"## Initial blank-scaffold snapshot",
		"This source was read from the current blank scaffold before any model-authored mutation. Do not re-read an included file before its first mutation.",
		...files,
		missing,
	].join("\n\n");
}

export function buildBuildPrompt({
	templateGuidance,
	initialScaffoldContext,
	editMode = false,
	cmsScripts = false,
}: BuildPromptOptions): string {
	if (editMode) {
		return [followUpPrompt, ...(cmsScripts ? [CMS_PROGRAMS] : []), blocksFollowUp].join("\n\n");
	}

	const sections = [
		blankBuildPrompt,
		"## What you're building\n\nA new site from a blank EmDash/Astro/Tailwind scaffold. Design and implement the site described by the conversation.",
	];
	if (templateGuidance) {
		sections.push(`## Template-specific guidance\n\n${templateGuidance.trim()}`);
	}
	if (initialScaffoldContext) sections.push(initialScaffoldSection(initialScaffoldContext));
	if (cmsScripts) sections.push(CMS_PROGRAMS);
	// Runtime-owned and last so stale guidance pinned in recovered sessions cannot override it.
	sections.push(blocksContract);
	return sections.join("\n\n");
}
