import {
	generateText,
	stepCountIs,
	tool,
	type LanguageModel,
	type LanguageModelUsage,
	type ToolSet,
} from "ai";
import { z } from "zod";

export const DELEGATE = "delegate";

/**
 * A helper works on CMS content and media. Source files, the schema,
 * validation, the preview, and deletions stay with the build model.
 */
export const HELPER_TOOLS: ReadonlySet<string> = new Set([
	"schema_list_collections",
	"schema_get_collection",
	"schema_list_block_types",
	"schema_get_block_type",
	"content_create",
	"content_get",
	"content_update",
	"content_publish",
	"content_list",
	"content_duplicate",
	"search",
	"taxonomy_create",
	"taxonomy_get",
	"taxonomy_create_term",
	"taxonomy_list",
	"taxonomy_list_terms",
	"taxonomy_update_term",
	"byline_list",
	"byline_get",
	"byline_create",
	"byline_update",
	"settings_get",
	"settings_update",
	"media_list",
	"menu_list",
	"menu_get",
	"menu_create",
	"menu_update",
	"menu_set_items",
	"create_entries_batch",
	"run_cms_script",
	"search_unsplash",
	"upload_media",
]);

/**
 * The helpers' share of the work. A driver with helpers cannot call these, so
 * content, settings, menus, and photos go through `delegate`; it keeps the
 * read tools to check what helpers made.
 */
const HELPER_WORK: ReadonlySet<string> = new Set([
	"content_create",
	"content_update",
	"content_publish",
	"content_duplicate",
	"taxonomy_create",
	"taxonomy_create_term",
	"taxonomy_update_term",
	"byline_create",
	"byline_update",
	"settings_update",
	"menu_create",
	"menu_update",
	"menu_set_items",
	"create_entries_batch",
	"run_cms_script",
	"search_unsplash",
	"upload_media",
]);

/**
 * The tools a driver with helpers may call. `repair` is the tool of the next
 * unresolved failure: the driver repairs a helper's failed call itself, since
 * only a forced repair can resolve or retire it before the build completes.
 */
export function driverToolNames<TOOL_NAME extends string>(
	all: readonly TOOL_NAME[],
	repair?: string,
): TOOL_NAME[] {
	return all.filter((name) => !HELPER_WORK.has(name) || name === repair);
}

export const HELPER_STEP_CAP = 16;
export const HELPER_MAX_OUTPUT_TOKENS = 16_384;

export interface DelegateOptions {
	model: LanguageModel;
	system: string;
	/** The build turn's tools; the helper gets the HELPER_TOOLS among them. */
	tools: ToolSet;
	providerOptions: Parameters<typeof generateText>[0]["providerOptions"];
	onStep?: (usage: LanguageModelUsage) => void;
	onToolCallFinish?: (event: {
		toolCall: { toolName: string; toolCallId: string };
		durationMs: number;
		success: boolean;
		output?: unknown;
	}) => void;
}

/**
 * `delegate`: the build model hands one self-contained task to a helper model,
 * which runs its own tool loop on the shared tools and reports back. Calls in
 * one step run at the same time.
 */
export function createDelegateTool(options: DelegateOptions) {
	const helperTools = Object.fromEntries(
		Object.entries(options.tools).filter(([name]) => HELPER_TOOLS.has(name)),
	);
	return tool({
		description:
			"Hand a self-contained CMS or media task to a faster helper model, which does it with its own tool calls and reports back. " +
			"The helper sees only `task`, not this conversation: include every collection and field name, slug, id, voice note, and image direction it needs. " +
			"Several delegate calls in one step run at the same time. Helpers cannot change source files, the schema, validation, or the preview.",
		inputSchema: z.object({
			task: z
				.string()
				.min(40)
				.describe("The complete task, with every name, slug, and id the helper needs."),
		}),
		execute: async ({ task }, { abortSignal }) => {
			try {
				const result = await generateText({
					model: options.model,
					system: options.system,
					prompt: task,
					tools: helperTools,
					stopWhen: stepCountIs(HELPER_STEP_CAP),
					maxOutputTokens: HELPER_MAX_OUTPUT_TOKENS,
					maxRetries: 5,
					providerOptions: options.providerOptions,
					abortSignal,
					onStepFinish: (step) => options.onStep?.(step.usage),
					experimental_onToolCallFinish: (event) =>
						options.onToolCallFinish?.(
							event as Parameters<NonNullable<DelegateOptions["onToolCallFinish"]>>[0],
						),
				});
				const results = result.steps.flatMap((step) => step.toolResults);
				const failed = results.filter(
					(entry) => (entry.output as { success?: unknown } | null)?.success === false,
				);
				return {
					success: true,
					report: result.text || "The helper finished without a report.",
					toolCalls: results.length,
					failedCalls: failed.map((entry) => entry.toolName),
					...(result.steps.length >= HELPER_STEP_CAP && result.finishReason === "tool-calls"
						? { stepCapReached: true }
						: {}),
				};
			} catch (error) {
				if (abortSignal?.aborted) throw error;
				return {
					success: false,
					error:
						`The helper stopped: ${error instanceof Error ? error.message : String(error)}`.slice(
							0,
							500,
						),
				};
			}
		},
	});
}
