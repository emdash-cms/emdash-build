/**
 * `run_cms_script`: one short JavaScript program that performs several CMS
 * operations in a single model step. The program runs in a Dynamic Worker with
 * no network, bindings, files or shell; its only capability is `cms`, whose
 * methods are the builder's own CMS tools, so every call keeps their guards,
 * serialization and failure bookkeeping. The preview refresh and checkpoint
 * run once, when the program ends.
 */
import type { ExecuteResult, Executor } from "@cloudflare/codemode";
import { asSchema, tool, type Tool } from "ai";
import { z } from "zod";
import type { SiteSync } from "./agent.js";
import { settleWithin } from "./preview-cache.js";

export const CMS_SCRIPT_TOOL = "run_cms_script";

export const CMS_SCRIPT_LIMITS = {
	timeoutMs: 150_000,
	cpuMs: 5_000,
	maxCodeChars: 40_000,
	maxCalls: 200,
	maxMutations: 100,
	maxSearches: 8,
	maxImages: 24,
	maxArgBytes: 256 * 1024,
	resultChars: 6_000,
	consoleChars: 4_000,
	errorChars: 2_000,
	maxLogged: 60,
} as const;

/** Log references are slugs and ids; a longer one is the program's own input echoed back. */
const REF_CHARS = 100;

const CMS_SCRIPT_READS = [
	"schema_list_collections",
	"schema_get_collection",
	"schema_list_block_types",
	"schema_get_block_type",
	"content_get",
	"content_list",
	"search",
	"taxonomy_get",
	"taxonomy_list",
	"taxonomy_list_terms",
	"byline_list",
	"byline_get",
	"settings_get",
	"media_list",
	"menu_list",
	"menu_get",
	"search_unsplash",
] as const;

const CMS_SCRIPT_MUTATIONS = [
	"content_create",
	"content_update",
	"content_publish",
	"content_unpublish",
	"content_delete",
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
	"upload_media",
] as const;

/**
 * The CMS and media tools a program may call. Schema plans, block-type
 * changes, permanent deletes, files, shell, validation and preview stay direct:
 * their output needs the model's attention, or they are gated on evidence a
 * program's mutation window would make stale. So does the entry batch, which
 * drafts every body with the model: cut short by the program's time limit, a
 * re-run would create its entries again.
 */
export const CMS_SCRIPT_TOOLS: readonly string[] = [...CMS_SCRIPT_READS, ...CMS_SCRIPT_MUTATIONS];

const MUTATIONS = new Set<string>(CMS_SCRIPT_MUTATIONS);

export function isCmsScriptMutation(name: string): boolean {
	return MUTATIONS.has(name);
}

/**
 * Wrap a normalized program so whatever it throws reaches the sandbox as an
 * Error with a message: the sandbox reports `err.message`, so `throw "x"` or
 * `throw new Error()` would otherwise read as success.
 */
export function guardProgram(normalized: string): string {
	return [
		"async () => {",
		"  try {",
		// Its own statement, on its own lines: a trailing `;` or comment after the
		// function then ends the statement instead of breaking the call.
		"    const program =",
		normalized.trim(),
		"    ;",
		"    const result = await program();",
		// Statements before the program's function make normalizeCode return it uncalled.
		'    return typeof result === "function" ? await result() : result;',
		"  } catch (error) {",
		"    if (error instanceof Error && error.message) throw error;",
		'    throw new Error("The program threw " + (error instanceof Error ? "an Error with no message" : String(error)));',
		"  }",
		"}",
	].join("\n");
}

/** A Dynamic Worker executor with no network and a CPU cap per program. */
export async function createCmsScriptExecutor(loader: WorkerLoader): Promise<Executor> {
	// Loaded lazily: the package's entry imports `cloudflare:workers`.
	const { DynamicWorkerExecutor, normalizeCode } = await import("@cloudflare/codemode");
	const limits = { cpuMs: CMS_SCRIPT_LIMITS.cpuMs };
	const executor = new DynamicWorkerExecutor({
		loader: {
			load: (code) => loader.load({ ...code, limits }),
			get: (name, getCode) => loader.get(name, async () => ({ ...(await getCode()), limits })),
		},
		timeout: CMS_SCRIPT_LIMITS.timeoutMs,
		globalOutbound: null,
	});
	return {
		execute: (code, providers, options) =>
			executor.execute(guardProgram(normalizeCode(code)), providers, options),
	};
}

/** Records the sync a program's mutations asked for, to run once when it ends. */
export class DeferredSiteSync implements SiteSync {
	private refresh = false;
	private save = false;

	async refreshPreview(): Promise<void> {
		this.refresh = true;
	}

	async checkpoint(): Promise<void> {
		this.save = true;
	}

	/** A failed or ambiguous mutation may still have changed the site, so any mutation saves. */
	async flush(target: SiteSync, mutated: boolean): Promise<void> {
		if (this.refresh || mutated) await target.refreshPreview();
		if (this.save || mutated) await target.checkpoint();
	}
}

export interface CmsScriptLogEntry {
	tool: string;
	ok: boolean;
	ref?: string;
	error?: string;
}

export interface CmsScriptOutput {
	/** No uncaught error, timeout or budget stop, and every mutation succeeded. */
	success: boolean;
	/** An inner mutation started; failed and ambiguous ones count. */
	changed: boolean;
	result?: unknown;
	error?: string;
	calls: number;
	/** Calls refused by a budget; the log names each reason, and each refused input. */
	refused?: number;
	/** Mutations and failed reads, in order. Failed entries are kept when it is cut. */
	log?: CmsScriptLogEntry[];
	logOmitted?: number;
	console?: string;
}

class CmsCallFailure extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A CMS tool's MCP envelope as the parsed data the CMS returned; other results unchanged. */
export function resultForProgram(output: unknown): unknown {
	if (!isObject(output) || !Array.isArray(output.content)) return output;
	const text = output.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isObject(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
	let data: unknown = text;
	try {
		data = JSON.parse(text);
	} catch {
		// Plain text stays text.
	}
	return typeof output.note === "string" && isObject(data) ? { ...data, note: output.note } : data;
}

/** Why a result that still reports success left part of its work undone. */
function partialFailure(output: unknown): string | undefined {
	if (!isObject(output)) return undefined;
	const { uploaded, count, results } = output;
	if (typeof uploaded !== "number" || typeof count !== "number" || uploaded >= count) {
		return undefined;
	}
	const failed = (Array.isArray(results) ? results : [])
		.filter((item) => isObject(item) && item.success === false)
		.map((item) => `${String(item.url ?? "an image")} (${String(item.error ?? "failed")})`);
	return `${count - uploaded} of ${count} images failed${failed.length > 0 ? `: ${failed.join("; ")}` : ""}`;
}

/** The slug or id a mutation's result names, so the model can find what exists. */
function referenceOf(data: unknown): string | undefined {
	if (!isObject(data)) return undefined;
	const item = isObject(data.item) ? data.item : data;
	for (const key of ["slug", "id", "name"]) {
		if (typeof item[key] === "string") return item[key];
	}
	return undefined;
}

function bounded(value: unknown, maxChars: number): unknown {
	if (value === undefined) return undefined;
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch {
		return String(value).slice(0, maxChars);
	}
	if (json === undefined || json.length <= maxChars) return value;
	return { truncated: true, preview: json.slice(0, maxChars) };
}

/** What a program call needs from a tool. */
export type CmsScriptTarget = Pick<Tool, "inputSchema" | "execute">;

export class CmsScriptRun {
	private readonly controller = new AbortController();
	readonly signal: AbortSignal;
	private closed = false;
	private seq = 0;
	private readonly inFlight = new Set<Promise<unknown>>();
	readonly log: CmsScriptLogEntry[] = [];
	calls = 0;
	mutations = 0;
	failedMutations = 0;
	refused = 0;
	/** Calls still running when the program returned: it did not await them. */
	unawaited = 0;
	/** Changes the program asked for after it returned, refused. */
	lateCalls = 0;
	private readonly loggedRefusals = new Set<string>();
	private searches = 0;
	private images = 0;

	constructor(
		private readonly options: {
			toolCallId: string;
			abortSignal?: AbortSignal;
			onCall?: (tool: string, ms: number, ok: boolean) => void;
			onActivity?: () => void;
		},
	) {
		this.signal = options.abortSignal
			? AbortSignal.any([options.abortSignal, this.controller.signal])
			: this.controller.signal;
	}

	/** A program function that runs the direct tool with its own validation and execute. */
	bind(name: string, target: CmsScriptTarget) {
		const schema = asSchema(target.inputSchema);
		return async (input: unknown = {}): Promise<unknown> => {
			if (this.closed) {
				// A read nobody waited for is harmless; a change is lost work.
				if (isCmsScriptMutation(name)) this.lateCalls += 1;
				throw new Error(`${name}: the program has already finished`);
			}
			if (input === null || typeof input !== "object" || Array.isArray(input)) {
				const message = `${name}: the input must be an object`;
				this.refused += 1;
				// It has no reference, so a repeat would only grow the log.
				if (!this.loggedRefusals.has(message)) {
					this.loggedRefusals.add(message);
					this.log.push({ tool: name, ok: false, error: message });
				}
				throw new Error(message);
			}
			this.signal.throwIfAborted();
			const refusal = this.charge(name, input);
			if (refusal) {
				this.refused += 1;
				// An exhausted budget refuses every later call of its kind, so its first refusal says it all.
				if (!refusal.exhausted || !this.loggedRefusals.has(refusal.message)) {
					this.loggedRefusals.add(refusal.message);
					const ref = referenceOf(input)?.slice(0, REF_CHARS);
					this.log.push({ tool: name, ok: false, ...(ref ? { ref } : {}), error: refusal.message });
				}
				throw new Error(refusal.message);
			}
			this.options.onActivity?.();
			const started = Date.now();
			const call = (async () => {
				const parsed = schema.validate
					? await schema.validate(input)
					: { success: true as const, value: input };
				if (!parsed.success) throw new Error(`invalid input: ${parsed.error.message}`);
				return target.execute!(parsed.value as never, {
					toolCallId: `${this.options.toolCallId}:${++this.seq}`,
					messages: [],
					abortSignal: this.signal,
				});
			})();
			this.inFlight.add(call);
			try {
				const output = await call;
				const failed = isObject(output) && output.success === false;
				const data = failed ? output : resultForProgram(output);
				// A partial result stays usable by the program but fails the run.
				const error = failed
					? String(output.error ?? partialFailure(output) ?? "failed")
					: partialFailure(output);
				this.record(name, error, data, started);
				if (failed) throw new CmsCallFailure(`${name} failed: ${error}`);
				return data;
			} catch (error) {
				if (!(error instanceof CmsCallFailure)) {
					this.record(name, messageOf(error), undefined, started);
				}
				throw error instanceof Error ? error : new Error(String(error));
			} finally {
				this.inFlight.delete(call);
			}
		};
	}

	/**
	 * Count a call against the budgets, or return why it is refused (counting
	 * nothing). The call, change and search budgets are `exhausted` once they
	 * refuse; image and input-size refusals depend on the call.
	 */
	private charge(
		name: string,
		input: unknown,
	): { message: string; exhausted: boolean } | undefined {
		const limits = CMS_SCRIPT_LIMITS;
		const mutation = isCmsScriptMutation(name);
		const search = name === "search_unsplash";
		const images =
			name === "upload_media" && isObject(input) && Array.isArray(input.images)
				? input.images.length
				: 0;
		const exhausted = (message: string) => ({ message, exhausted: true });
		// Refused calls count too, so a program that catches refusals cannot loop on them.
		if (this.calls + this.refused + 1 > limits.maxCalls) {
			return exhausted(`${name}: a program may make at most ${limits.maxCalls} calls`);
		}
		if (mutation && this.mutations + 1 > limits.maxMutations) {
			return exhausted(`${name}: a program may make at most ${limits.maxMutations} changes`);
		}
		if (search && this.searches + 1 > limits.maxSearches) {
			return exhausted(`${name}: a program may search photos at most ${limits.maxSearches} times`);
		}
		if (this.images + images > limits.maxImages) {
			return {
				message: `${name}: a program may upload at most ${limits.maxImages} images (${limits.maxImages - this.images} left)`,
				exhausted: false,
			};
		}
		const bytes = new TextEncoder().encode(JSON.stringify(input ?? {})).byteLength;
		if (bytes > limits.maxArgBytes) {
			return {
				message: `${name}: the input is larger than ${limits.maxArgBytes / 1024} KiB`,
				exhausted: false,
			};
		}
		this.calls += 1;
		if (mutation) this.mutations += 1;
		if (search) this.searches += 1;
		this.images += images;
		return undefined;
	}

	private record(name: string, error: string | undefined, data: unknown, started: number): void {
		const ok = error === undefined;
		this.options.onCall?.(name, Date.now() - started, ok);
		const mutation = isCmsScriptMutation(name);
		if (mutation && !ok) this.failedMutations += 1;
		if (!mutation && ok) return;
		const ref = ok ? referenceOf(data)?.slice(0, REF_CHARS) : undefined;
		this.log.push({
			tool: name,
			ok,
			...(ref ? { ref } : {}),
			...(error ? { error: error.slice(0, 300) } : {}),
		});
	}

	/** Race the sandbox against Stop and a host-side watchdog; never throws. */
	async execute(
		executor: Executor,
		code: string,
		fns: Record<string, (input?: unknown) => Promise<unknown>>,
	): Promise<ExecuteResult & { stop?: "aborted" | "timeout" }> {
		const execution = executor
			.execute(code, [
				{ name: "cms", fns: fns as Record<string, (...args: unknown[]) => Promise<unknown>> },
			])
			.catch(
				(error: unknown): ExecuteResult => ({
					result: undefined,
					// Past its first call, a program that ends here (such as at its CPU limit) has made changes.
					error: `${this.calls > 0 ? "The program stopped" : "The program could not start"}: ${messageOf(error)}`,
				}),
			);
		let onAbort: (() => void) | undefined;
		const stopped = new Promise<ExecuteResult & { stop: "aborted" }>((resolve) => {
			onAbort = () => resolve({ result: undefined, error: "Stopped.", stop: "aborted" });
			if (this.signal.aborted) onAbort();
			else this.signal.addEventListener("abort", onAbort, { once: true });
		});
		const watchdog = settleWithin(execution, CMS_SCRIPT_LIMITS.timeoutMs + 15_000).then(
			(settled): ExecuteResult & { stop?: "timeout" } =>
				settled.status === "fulfilled"
					? settled.value
					: settled.status === "rejected"
						? { result: undefined, error: messageOf(settled.reason) }
						: { result: undefined, error: "Execution timed out", stop: "timeout" },
		);
		try {
			const outcome = await Promise.race([watchdog, stopped]);
			// A read counts too: the change waiting on it can no longer be made.
			if (!outcome.stop) this.unawaited = this.inFlight.size;
			return outcome.error === "Execution timed out" ? { ...outcome, stop: "timeout" } : outcome;
		} finally {
			if (onAbort) this.signal.removeEventListener("abort", onAbort);
		}
	}

	/** Refuse late calls, abort stragglers on timeout or Stop, and wait for every started call. */
	async close(stop?: "aborted" | "timeout"): Promise<void> {
		this.closed = true;
		if (stop) {
			this.controller.abort(
				new DOMException(
					`The CMS program ${stop === "timeout" ? "timed out" : "was stopped"}.`,
					"AbortError",
				),
			);
		}
		while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
	}
}

export function cmsScriptOutput(
	outcome: ExecuteResult & { stop?: "aborted" | "timeout" },
	run: CmsScriptRun,
	changed: boolean,
): CmsScriptOutput {
	const limits = CMS_SCRIPT_LIMITS;
	const logs = (outcome.logs ?? []).join("\n");
	const error =
		outcome.stop === "timeout"
			? `The program ran past its ${limits.timeoutMs / 1000}-second limit and was stopped; calls it started have finished. Check the log before retrying.`
			: (outcome.error?.slice(0, limits.errorChars) ??
				unfinishedCalls(run) ??
				emptyProgram(outcome, run, logs));
	const log = boundedLog(run.log, limits.maxLogged);
	return {
		success: !error && run.failedMutations === 0 && run.refused === 0,
		changed,
		...(outcome.result !== undefined
			? { result: bounded(outcome.result, limits.resultChars) }
			: {}),
		...(error ? { error } : {}),
		calls: run.calls,
		...(run.refused > 0 ? { refused: run.refused } : {}),
		...(log.length > 0 ? { log } : {}),
		...(run.log.length > log.length ? { logOmitted: run.log.length - log.length } : {}),
		...(logs ? { console: logs.slice(0, limits.consoleChars) } : {}),
	};
}

/** Why a program that returned with calls still running, or asking for more, fails. */
function unfinishedCalls(run: CmsScriptRun): string | undefined {
	const plural = (count: number, kind: string) => `${count} cms ${kind}${count === 1 ? "" : "s"}`;
	const parts = [
		...(run.unawaited > 0 ? [`returned before ${plural(run.unawaited, "call")} finished`] : []),
		...(run.lateCalls > 0
			? [`made ${plural(run.lateCalls, "change")} after it returned, which were refused`]
			: []),
	];
	if (parts.length === 0) return undefined;
	return `The program ${parts.join(" and ")}. Await every cms call: an async callback passed to forEach or map is not awaited.`;
}

/** A program that did nothing, such as one that only defines its function, fails rather than passing. */
function emptyProgram(outcome: ExecuteResult, run: CmsScriptRun, logs: string): string | undefined {
	if (run.calls > 0 || run.refused > 0 || outcome.result !== undefined || logs) return undefined;
	return "The program made no cms calls and returned nothing: it must be one async arrow function whose body awaits cms calls.";
}

/** The log cut to `max` entries in order, keeping failures first: the model repairs from them. */
function boundedLog(log: readonly CmsScriptLogEntry[], max: number): CmsScriptLogEntry[] {
	if (log.length <= max) return [...log];
	const kept = new Set<number>();
	for (let index = 0; index < log.length && kept.size < max; index++) {
		if (!log[index]!.ok) kept.add(index);
	}
	for (let index = 0; index < log.length && kept.size < max; index++) kept.add(index);
	return log.filter((_, index) => kept.has(index));
}

export function cmsScriptDescription(names: readonly string[]): string {
	const limits = CMS_SCRIPT_LIMITS;
	return [
		"Run one short JavaScript program that performs several CMS operations in a single step. It runs in an isolated sandbox with no network, file, or shell access; its only capability is `cms`. The preview is refreshed and the site checkpointed once, after the program ends.",
		"Write one async arrow function in plain JavaScript (no TypeScript, no imports).",
		"- `await cms.NAME(input)` runs the tool NAME with the input its own schema describes and resolves to its result data. CMS tools resolve to the parsed JSON the CMS returns, such as `{ item, _rev }` from content_get and content_create, and `{ items, nextCursor }` from list tools.",
		"- A failed call throws an Error whose message starts with the tool name. Catch it only when later calls do not depend on it.",
		"- Calls reach the CMS one at a time, so await them in order.",
		"- Pass explicit slugs, so a repeated program cannot create duplicates.",
		"- Return a small summary (ids, slugs, counts); it is cut to about 6,000 characters. console.log output is returned as text.",
		`Methods: ${names.map((name) => `cms.${name}`).join(", ")}.`,
		"Call these directly instead: apply_schema_plan, schema_update_block_type, update_blocks_field, schema_activate_block_type_version, content_permanent_delete, create_entries_batch, file tools, exec, refresh_types, validate_site, view_preview.",
		`Per program: ${limits.timeoutMs / 1000} seconds, ${limits.maxCalls} calls, ${limits.maxMutations} changes, ${limits.maxSearches} photo searches, ${limits.maxImages} uploaded images.`,
		"Example:",
		[
			"async () => {",
			'  await cms.settings_update({ title: "Crumb & Co.", tagline: "Sourdough from Leith" });',
			"  const slugs = [];",
			'  for (const post of [{ slug: "why-we-cold-proof", title: "Why we cold-proof" }]) {',
			"    const { item } = await cms.content_create({",
			'      collection: "posts", slug: post.slug, status: "published", data: { title: post.title },',
			"    });",
			"    slugs.push(item.slug);",
			"  }",
			'  await cms.menu_create({ name: "primary", label: "Primary" });',
			'  await cms.menu_set_items({ name: "primary", items: [{ label: "Journal", type: "custom", customUrl: "/posts" }] });',
			"  return { slugs };",
			"}",
		].join("\n"),
	].join("\n");
}

export function createCmsScriptTool(
	names: readonly string[],
	run: (
		code: string,
		context: { toolCallId: string; abortSignal?: AbortSignal },
	) => Promise<CmsScriptOutput>,
) {
	return tool({
		description: cmsScriptDescription(names),
		inputSchema: z.object({
			code: z
				.string()
				.min(1)
				.max(CMS_SCRIPT_LIMITS.maxCodeChars)
				.describe("One async arrow function in plain JavaScript."),
		}),
		execute: ({ code }, { toolCallId, abortSignal }) => run(code, { toolCallId, abortSignal }),
	});
}
