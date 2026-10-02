import { jsonSchema, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ExecuteResult, Executor, ResolvedProvider } from "@cloudflare/codemode";
import {
	CMS_SCRIPT_LIMITS,
	CMS_SCRIPT_TOOLS,
	CmsScriptRun,
	DeferredSiteSync,
	cmsScriptDescription,
	cmsScriptOutput,
	guardProgram,
	resultForProgram,
} from "../src/worker/cms-script.js";

/** Runs a closure per program and mirrors the RPC boundary: JSON arguments, message-only errors. */
class ScriptedExecutor implements Executor {
	constructor(
		private readonly program: (
			cms: Record<string, (input?: unknown) => Promise<unknown>>,
		) => Promise<unknown>,
	) {}

	async execute(
		_code: string,
		providers: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
	): Promise<ExecuteResult> {
		const fns = (providers as ResolvedProvider[])[0]!.fns;
		const cms = new Proxy(
			{},
			{
				get: (_, name) => async (input?: unknown) => {
					const fn = fns[String(name)];
					if (!fn) throw new Error(`Tool "${String(name)}" not found`);
					try {
						return JSON.parse(JSON.stringify(await fn(JSON.parse(JSON.stringify(input ?? {})))));
					} catch (error) {
						throw new Error(error instanceof Error ? error.message : String(error));
					}
				},
			},
		) as Record<string, (input?: unknown) => Promise<unknown>>;
		try {
			return { result: await this.program(cms), logs: ["done"] };
		} catch (error) {
			return { result: undefined, error: (error as Error).message, logs: [] };
		}
	}
}

const mcpEnvelope = (data: unknown) => ({
	content: [{ type: "text", text: JSON.stringify(data) }],
});

function tools() {
	const executed: Array<{ name: string; input: unknown; signal?: AbortSignal }> = [];
	const mcp = (name: string, result: (input: Record<string, unknown>) => unknown) => ({
		inputSchema: jsonSchema({ type: "object" }),
		execute: async (input: Record<string, unknown>, options: { abortSignal?: AbortSignal }) => {
			executed.push({ name, input, signal: options.abortSignal });
			return result(input);
		},
	});
	return {
		executed,
		content_create: mcp("content_create", (input) =>
			mcpEnvelope({ item: { id: "01X", slug: input.slug }, _rev: "r1" }),
		),
		content_get: mcp("content_get", () => mcpEnvelope({ item: { id: "01X" }, _rev: "r1" })),
		settings_update: mcp("settings_update", (input) =>
			input.title === "bad"
				? { success: false, error: "[VALIDATION_ERROR] title" }
				: mcpEnvelope({ ok: true }),
		),
		search_unsplash: tool({
			inputSchema: z.object({ query: z.string(), count: z.number().optional().default(5) }),
			execute: async (input) => {
				executed.push({ name: "search_unsplash", input });
				return { success: true, photos: [] };
			},
		}),
	};
}

function bindAll(run: CmsScriptRun, set: ReturnType<typeof tools>) {
	const { executed: _, ...rest } = set;
	return Object.fromEntries(
		Object.entries(rest).map(([name, target]) => [name, run.bind(name, target as never)]),
	);
}

describe("CMS programs", () => {
	it("runs direct tools with their own validation and passes Stop to each call", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-1" });
		const executor = new ScriptedExecutor(async (cms) => {
			const created = (await cms.content_create!({ collection: "posts", slug: "rye" })) as {
				item: { slug: string };
			};
			await cms.search_unsplash!({ query: "bread" });
			return { slug: created.item.slug };
		});

		const outcome = await run.execute(executor, "code", bindAll(run, set));
		await run.close();
		const output = cmsScriptOutput(outcome, run, true);

		expect(output).toMatchObject({
			success: true,
			changed: true,
			result: { slug: "rye" },
			calls: 2,
		});
		expect(output.log).toEqual([{ tool: "content_create", ok: true, ref: "rye" }]);
		expect(output.console).toBe("done");
		// Zod defaults apply, as for a direct call.
		expect(set.executed[1]?.input).toEqual({ query: "bread", count: 5 });
		expect(set.executed[0]?.signal).toBe(run.signal);
	});

	it("throws a failed call into the program and reports what completed", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-2" });
		const executor = new ScriptedExecutor(async (cms) => {
			await cms.content_create!({ collection: "posts", slug: "rye" });
			try {
				await cms.settings_update!({ title: "bad" });
			} catch (error) {
				return { caught: (error as Error).message };
			}
			return "unreachable";
		});

		const outcome = await run.execute(executor, "code", bindAll(run, set));
		const output = cmsScriptOutput(outcome, run, true);

		expect(output.success).toBe(false);
		expect(output.result).toEqual({ caught: "settings_update failed: [VALIDATION_ERROR] title" });
		expect(output.log).toEqual([
			{ tool: "content_create", ok: true, ref: "rye" },
			{ tool: "settings_update", ok: false, error: "[VALIDATION_ERROR] title" },
		]);
	});

	it("refuses calls past a budget without counting them, and fails the program", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-3b" });
		const executor = new ScriptedExecutor(async (cms) => {
			for (let index = 0; index < CMS_SCRIPT_LIMITS.maxSearches + 3; index++) {
				try {
					await cms.search_unsplash!({ query: `q${index}` });
				} catch {
					// A program may catch a refusal; the result must still report it.
				}
			}
			return "done";
		});

		const outcome = await run.execute(executor, "code", bindAll(run, set));
		const output = cmsScriptOutput(outcome, run, false);

		expect(set.executed).toHaveLength(CMS_SCRIPT_LIMITS.maxSearches);
		expect(output).toMatchObject({
			success: false,
			result: "done",
			calls: CMS_SCRIPT_LIMITS.maxSearches,
			refused: 3,
		});
		expect(output.log).toEqual([
			{
				tool: "search_unsplash",
				ok: false,
				error: expect.stringContaining("at most 8 times"),
			},
		]);
	});

	it("logs each kind of refusal a program catches, and every refused upload", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-3e" });
		const images = (count: number) => Array.from({ length: count }, () => ({ url: "https://img" }));
		const upload = {
			inputSchema: jsonSchema({ type: "object" }),
			execute: async (input: { images: unknown[] }) => ({
				success: true,
				count: input.images.length,
				uploaded: input.images.length,
				results: [],
			}),
		};
		const executor = new ScriptedExecutor(async (cms) => {
			const attempt = (call: Promise<unknown>) =>
				call.then(
					() => "ok",
					() => "refused",
				);
			const outcomes: string[] = [];
			for (let index = 0; index <= CMS_SCRIPT_LIMITS.maxSearches; index++) {
				outcomes.push(await attempt(cms.search_unsplash!({ query: `q${index}` })));
			}
			outcomes.push(await attempt(cms.search_unsplash!({ query: "again" })));
			outcomes.push(await attempt(cms.upload_media!({ images: images(20) })));
			outcomes.push(await attempt(cms.upload_media!({ images: images(5) })));
			outcomes.push(await attempt(cms.upload_media!({ images: images(4) })));
			outcomes.push(await attempt(cms.upload_media!({ images: images(1) })));
			outcomes.push(
				await attempt(
					cms.content_create!({
						collection: "posts",
						slug: "huge",
						data: { body: "x".repeat(300 * 1024) },
					}),
				),
			);
			return outcomes.slice(CMS_SCRIPT_LIMITS.maxSearches);
		});

		const outcome = await run.execute(executor, "code", {
			...bindAll(run, set),
			upload_media: run.bind("upload_media", upload as never),
		});
		const output = cmsScriptOutput(outcome, run, true);

		// 20 + 4 images fit the budget of 24; the 5 and the final 1 do not.
		expect(output.result).toEqual([
			"refused",
			"refused",
			"ok",
			"refused",
			"ok",
			"refused",
			"refused",
		]);
		expect(output).toMatchObject({ success: false, refused: 5 });
		expect(output.log?.filter((entry) => !entry.ok)).toEqual([
			{ tool: "search_unsplash", ok: false, error: expect.stringContaining("at most 8 times") },
			{ tool: "upload_media", ok: false, error: expect.stringContaining("(4 left)") },
			{ tool: "upload_media", ok: false, error: expect.stringContaining("(0 left)") },
			{ tool: "content_create", ok: false, ref: "huge", error: expect.stringContaining("256 KiB") },
		]);
	});

	it("counts a partial upload as a failed change and still returns its results", async () => {
		const run = new CmsScriptRun({ toolCallId: "call-3c" });
		const upload = {
			inputSchema: jsonSchema({ type: "object" }),
			execute: async () => ({
				success: true,
				count: 3,
				uploaded: 2,
				results: [
					{ url: "https://img/a", success: true },
					{ url: "https://img/b", success: false, error: "HTTP 404" },
					{ url: "https://img/c", success: true },
				],
			}),
		};
		const executor = new ScriptedExecutor(async (cms) => {
			const result = (await cms.upload_media!({ images: [{}, {}, {}] })) as { uploaded: number };
			return { uploaded: result.uploaded };
		});

		const outcome = await run.execute(executor, "code", {
			upload_media: run.bind("upload_media", upload as never),
		});
		const output = cmsScriptOutput(outcome, run, true);

		expect(output).toMatchObject({ success: false, result: { uploaded: 2 } });
		expect(output.log).toEqual([
			{ tool: "upload_media", ok: false, error: "1 of 3 images failed: https://img/b (HTTP 404)" },
		]);
	});

	it("says why every image of a failed upload failed", async () => {
		const run = new CmsScriptRun({ toolCallId: "call-3e" });
		const upload = {
			inputSchema: jsonSchema({ type: "object" }),
			execute: async () => ({
				success: false,
				changed: false,
				count: 1,
				uploaded: 0,
				results: [{ url: "https://img/a", success: false, error: "Not a stock photo" }],
			}),
		};
		const executor = new ScriptedExecutor(async (cms) => {
			await cms.upload_media!({ images: [{}] });
		});

		const outcome = await run.execute(executor, "code", {
			upload_media: run.bind("upload_media", upload as never),
		});

		expect(cmsScriptOutput(outcome, run, false).log).toEqual([
			{
				tool: "upload_media",
				ok: false,
				error: "1 of 1 images failed: https://img/a (Not a stock photo)",
			},
		]);
	});

	it("keeps failed entries when the log is cut", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-3d" });
		const total = CMS_SCRIPT_LIMITS.maxLogged + 10;
		const executor = new ScriptedExecutor(async (cms) => {
			for (let index = 0; index < total; index++) {
				await cms.settings_update!({ title: index === total - 2 ? "bad" : `t${index}` }).catch(
					() => undefined,
				);
			}
		});

		const outcome = await run.execute(executor, "code", bindAll(run, set));
		const output = cmsScriptOutput(outcome, run, true);

		expect(output.log).toHaveLength(CMS_SCRIPT_LIMITS.maxLogged);
		expect(output.logOmitted).toBe(10);
		expect(output.log?.at(-1)).toEqual({
			tool: "settings_update",
			ok: false,
			error: "[VALIDATION_ERROR] title",
		});
	});

	it("enforces the per-program budgets", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-3" });
		const executor = new ScriptedExecutor(async (cms) => {
			for (let index = 0; index < CMS_SCRIPT_LIMITS.maxSearches + 1; index++) {
				await cms.search_unsplash!({ query: `q${index}` });
			}
		});

		const outcome = await run.execute(executor, "code", bindAll(run, set));

		expect(outcome.error).toContain("at most 8 times");
		expect(set.executed).toHaveLength(8);
		const oversized = new CmsScriptRun({ toolCallId: "call-4" });
		const big = new ScriptedExecutor(async (cms) =>
			cms.content_create!({ collection: "posts", data: { body: "x".repeat(300 * 1024) } }),
		);
		const bigOutcome = await oversized.execute(big, "code", bindAll(oversized, tools()));
		expect(bigOutcome.error).toContain("larger than 256 KiB");
	});

	it("stops waiting on Stop, refuses later calls, and waits for calls already started", async () => {
		const controller = new AbortController();
		let finishCall!: () => void;
		const slow = {
			inputSchema: jsonSchema({ type: "object" }),
			execute: () =>
				new Promise((resolve) => {
					finishCall = () => resolve(mcpEnvelope({ ok: true }));
				}),
		};
		const run = new CmsScriptRun({ toolCallId: "call-5", abortSignal: controller.signal });
		const fns = { settings_update: run.bind("settings_update", slow as never) };
		const executor = new ScriptedExecutor(async (cms) => {
			await cms.settings_update!({});
			return "never";
		});

		const outcome = run.execute(executor, "code", fns);
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();
		await expect(outcome).resolves.toMatchObject({ stop: "aborted" });

		let closed = false;
		const closing = run.close("aborted").then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(closed).toBe(false);
		finishCall();
		await closing;
		await expect(fns.settings_update({})).rejects.toThrow("already finished");
	});

	it("says a program stopped, not that it could not start, once it has made calls", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-6b" });
		const fns = bindAll(run, set);
		const crashing: Executor = {
			execute: async () => {
				await fns.content_create!({ collection: "posts", slug: "rye" });
				throw new Error("Worker exceeded CPU time limit.");
			},
		};

		const outcome = await run.execute(crashing, "code", fns);

		expect(cmsScriptOutput(outcome, run, true)).toMatchObject({
			success: false,
			error: "The program stopped: Worker exceeded CPU time limit.",
			log: [{ tool: "content_create", ok: true, ref: "rye" }],
		});
	});

	it("reports a program that could not start instead of throwing", async () => {
		const run = new CmsScriptRun({ toolCallId: "call-6" });
		const broken: Executor = {
			execute: async () => {
				throw new SyntaxError("Unexpected token");
			},
		};

		const outcome = await run.execute(broken, "async () => {", {});

		expect(cmsScriptOutput(outcome, run, false)).toMatchObject({
			success: false,
			changed: false,
			error: expect.stringContaining("could not start: Unexpected token"),
		});
	});

	it("bounds large results and console output", () => {
		const run = new CmsScriptRun({ toolCallId: "call-7" });
		const output = cmsScriptOutput(
			{ result: { big: "x".repeat(50_000) }, logs: ["y".repeat(10_000)] },
			run,
			false,
		);

		expect(JSON.stringify(output.result).length).toBeLessThan(CMS_SCRIPT_LIMITS.resultChars + 200);
		expect(output.console?.length).toBe(CMS_SCRIPT_LIMITS.consoleChars);
	});

	it("unwraps CMS envelopes and keeps builder notes", () => {
		expect(resultForProgram(mcpEnvelope({ items: [1] }))).toEqual({ items: [1] });
		expect(
			resultForProgram({ ...mcpEnvelope({ item: { id: "a" } }), note: "Published automatically." }),
		).toEqual({ item: { id: "a" }, note: "Published automatically." });
		expect(resultForProgram({ success: true, uploaded: 2 })).toEqual({
			success: true,
			uploaded: 2,
		});
	});

	it("syncs once at the end, including after a failed mutation", async () => {
		const target = { refreshPreview: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
		const deferred = new DeferredSiteSync();
		await deferred.refreshPreview();
		await deferred.checkpoint();
		await deferred.refreshPreview();
		await deferred.flush(target, true);
		expect(target.refreshPreview).toHaveBeenCalledOnce();
		expect(target.checkpoint).toHaveBeenCalledOnce();

		const readOnly = { refreshPreview: vi.fn(async () => {}), checkpoint: vi.fn(async () => {}) };
		await new DeferredSiteSync().flush(readOnly, false);
		expect(readOnly.refreshPreview).not.toHaveBeenCalled();
		expect(readOnly.checkpoint).not.toHaveBeenCalled();
	});

	it("lists only CMS and media tools and names the ones to call directly", () => {
		expect(CMS_SCRIPT_TOOLS).not.toContain("apply_schema_plan");
		expect(CMS_SCRIPT_TOOLS).not.toContain("content_permanent_delete");
		expect(CMS_SCRIPT_TOOLS).not.toContain("exec");
		// A batch drafts every body with the model; cut short by the program's
		// time limit, a re-run would create its entries again.
		expect(CMS_SCRIPT_TOOLS).not.toContain("create_entries_batch");
		expect(CMS_SCRIPT_TOOLS).toContain("upload_media");
		const description = cmsScriptDescription(["content_create", "menu_set_items"]);
		expect(description).toContain("cms.content_create, cms.menu_set_items");
		expect(description).toContain("Call these directly instead: apply_schema_plan");
		expect(description).toContain("create_entries_batch");
		// The blank scaffold starts with no menus, so the example creates the one it fills.
		expect(description.indexOf("cms.menu_create(")).toBeGreaterThan(-1);
		expect(description.indexOf("cms.menu_create(")).toBeLessThan(
			description.indexOf("cms.menu_set_items("),
		);
	});

	it("wraps programs so they stay valid JavaScript", async () => {
		for (const program of [
			"async () => 1",
			"async () => 1;",
			"async () => 1; // done",
			"() => {\n  return 1;\n} // done",
			"async () => 1; /* done */",
			"async () => 1;\n// a\n// b",
			"async () => 1 // a\n/* b */ ;",
		]) {
			const wrapped = new Function(`return ${guardProgram(program)}`)() as () => Promise<unknown>;
			await expect(wrapped(), program).resolves.toBe(1);
		}
	});

	it("fails a program that returns before its calls finish", async () => {
		const set = tools();
		const slow = set.content_create;
		set.content_create = {
			...slow,
			execute: async (input: Record<string, unknown>, options: { abortSignal?: AbortSignal }) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return slow.execute(input, options);
			},
		};
		const run = new CmsScriptRun({ toolCallId: "call-unawaited" });
		const executor = new ScriptedExecutor(async (cms) => {
			// The classic missing await: each publish would start after the program returned.
			for (const slug of ["a", "b"]) {
				void (async () => {
					await cms.content_create!({ collection: "posts", slug });
					await cms.settings_update!({ title: slug });
				})().catch(() => undefined);
			}
			return "queued";
		});

		const outcome = await run.execute(executor, "code", bindAll(run, set));
		await run.close();
		// The publishes come once the creates resolve, after the program returned.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const output = cmsScriptOutput(outcome, run, true);

		expect(output.success).toBe(false);
		expect(output.error).toMatch(/returned before 2 cms calls finished/);
		expect(output.error).toMatch(/made 2 cms changes after it returned, which were refused/);
		expect(output.error).toMatch(/await/);
	});

	it("fails a program that returns while the reads its changes wait on are running", async () => {
		const set = tools();
		const slow = set.content_get;
		set.content_get = {
			...slow,
			execute: async (input: Record<string, unknown>, options: { abortSignal?: AbortSignal }) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return slow.execute(input, options);
			},
		};
		const run = new CmsScriptRun({ toolCallId: "call-read-first" });
		const executor = new ScriptedExecutor(async (cms) => {
			// An update needs the entry's _rev, so each unawaited callback reads first.
			for (const id of ["a", "b"]) {
				void (async () => {
					const { _rev } = (await cms.content_get!({ id })) as { _rev: string };
					// A Dynamic Worker hears back over RPC, after the result was built.
					await new Promise((resolve) => setTimeout(resolve, 5));
					await cms.settings_update!({ title: `${id} ${_rev}` });
				})().catch(() => undefined);
			}
			return { updated: 2 };
		});

		const outcome = await run.execute(executor, "code", bindAll(run, set));
		await run.close();
		const output = cmsScriptOutput(outcome, run, false);

		expect(output.success).toBe(false);
		expect(output.error).toMatch(/returned before 2 cms calls finished/);
	});

	it("names a read left running beside the change that failed", async () => {
		const set = tools();
		const slow = set.content_get;
		set.content_get = {
			...slow,
			execute: async (input: Record<string, unknown>, options: { abortSignal?: AbortSignal }) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return slow.execute(input, options);
			},
		};
		const run = new CmsScriptRun({ toolCallId: "call-race" });
		const executor = new ScriptedExecutor(async (cms) => {
			try {
				await Promise.all([cms.content_get!({ id: "a" }), cms.settings_update!({ title: "bad" })]);
			} catch {
				return "settings were refused";
			}
			return "unreachable";
		});

		const outcome = await run.execute(executor, "code", bindAll(run, set));
		await run.close();
		const output = cmsScriptOutput(outcome, run, false);

		// A read left running could have led to a change, so it fails the program too.
		expect(output.success).toBe(false);
		expect(output.error).toMatch(/returned before 1 cms call finished/);
		expect(output.log).toEqual([
			{ tool: "settings_update", ok: false, error: "[VALIDATION_ERROR] title" },
		]);
		expect(output.result).toBe("settings were refused");
	});

	it("runs a program whose function comes after a helper", async () => {
		// What codemode's normalizeCode makes of a helper followed by the program's
		// function: a function that returns the program's function uncalled.
		const program = guardProgram(
			"async () => {\nconst slug = (s) => s.toLowerCase();\nreturn (async () => slug('Rye'))\n}",
		);
		const wrapped = new Function(`return ${program}`)() as () => Promise<unknown>;

		await expect(wrapped()).resolves.toBe("rye");
	});

	it("counts and logs an input that is not an object as a refusal", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-refused-null" });
		// Arguments arrive as the program sent them; JSON turns undefined into null.
		const executor: Executor = {
			execute: async (_code, providers) => {
				const cms = (providers as ResolvedProvider[])[0]!.fns;
				try {
					await cms.content_get!(null);
				} catch {
					// Caught, but the run still says so.
				}
				return { result: "ok" };
			},
		};

		const outcome = await run.execute(executor, "code", {
			content_get: run.bind("content_get", set.content_get as never),
		});
		const output = cmsScriptOutput(outcome, run, false);

		expect(output).toMatchObject({ success: false, refused: 1 });
		expect(output.log).toEqual([
			expect.objectContaining({ tool: "content_get", error: expect.stringContaining("object") }),
		]);
	});

	it("logs a repeated input that is not an object once, however often a program sends it", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-refused-loop" });
		const executor: Executor = {
			execute: async (_code, providers) => {
				const cms = (providers as ResolvedProvider[])[0]!.fns;
				for (let index = 0; index < 1_000; index++) {
					await cms.content_get!(null).catch(() => undefined);
				}
				return { result: "ok" };
			},
		};

		await run.execute(executor, "code", {
			content_get: run.bind("content_get", set.content_get as never),
		});

		expect(run.refused).toBe(1_000);
		expect(run.log).toHaveLength(1);
	});

	it("fails a program that made no calls and returned nothing", async () => {
		const run = new CmsScriptRun({ toolCallId: "call-noop" });
		const executor: Executor = { execute: async () => ({ result: undefined }) };

		const outcome = await run.execute(executor, "code", {});
		const output = cmsScriptOutput(outcome, run, false);

		expect(output.success).toBe(false);
		expect(output.error).toMatch(/made no cms calls and returned nothing/i);
	});

	it("bounds the error, refusal and log text a program can send back", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-flood" });
		const huge = "x".repeat(CMS_SCRIPT_LIMITS.maxArgBytes + 10);
		let refusals = 0;
		const executor = new ScriptedExecutor(async (cms) => {
			for (let index = 0; index < CMS_SCRIPT_LIMITS.maxCalls + 50; index++) {
				try {
					await cms.content_get!({ slug: huge });
				} catch {
					refusals++;
				}
			}
			throw new Error("y".repeat(500_000));
		});

		const outcome = await run.execute(executor, "code", bindAll(run, set));
		const output = cmsScriptOutput(outcome, run, false);

		expect(refusals).toBe(CMS_SCRIPT_LIMITS.maxCalls + 50);
		expect(JSON.stringify(output).length).toBeLessThan(20_000);
		expect(output.error!.length).toBeLessThanOrEqual(2_100);
		for (const entry of output.log ?? []) expect(entry.ref?.length ?? 0).toBeLessThanOrEqual(100);
		// Refused calls count against the call budget, so a loop of them ends.
		expect(run.log).toContainEqual(
			expect.objectContaining({ error: expect.stringContaining("at most 200 calls") }),
		);
	});

	it("refuses an input that is not an object before the tool runs", async () => {
		const set = tools();
		const run = new CmsScriptRun({ toolCallId: "call-null" });
		const call = run.bind("content_get", set.content_get as never);

		for (const input of [null, [], "slug", 3]) {
			await expect(call(input)).rejects.toThrow("content_get: the input must be an object");
		}
		await expect(call(undefined)).resolves.toBeDefined();
		expect(set.executed).toHaveLength(1);
	});
});
