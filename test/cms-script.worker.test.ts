import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecuteResult, Executor, ResolvedProvider } from "@cloudflare/codemode";
import { BuildConvergence } from "../src/worker/build-convergence.js";
import { McpToolFailureGuard } from "../src/worker/mcp-tool-guard.js";
import { createCmsScriptExecutor } from "../src/worker/cms-script.js";
import { TurnMetrics } from "../src/worker/turn-metrics.js";
import type { BuilderAgent } from "../src/worker/agent.js";

const testEnv = env as typeof env & {
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
	LOADER: WorkerLoader;
};

type Program = (cms: Record<string, (input?: unknown) => Promise<unknown>>) => Promise<unknown>;

/** Runs the registered closure for each code string, across a JSON boundary like the RPC one. */
class ScriptedExecutor implements Executor {
	constructor(private readonly programs: Record<string, Program>) {}

	async execute(
		code: string,
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
			return { result: await this.programs[code]!(cms), logs: [] };
		} catch (error) {
			return { result: undefined, error: (error as Error).message, logs: [] };
		}
	}
}

interface McpCall {
	name: string;
	args: Record<string, unknown>;
}

const mcpJson = (data: unknown) => ({
	status: "ok" as const,
	result: { content: [{ type: "text", text: JSON.stringify(data) }] },
});

type ScriptTool = {
	execute: (input: { code: string }, options: unknown) => Promise<Record<string, unknown>>;
};

function install(instance: BuilderAgent, programs: Record<string, Program>) {
	const calls: McpCall[] = [];
	const refresh = vi.fn(async () => {});
	const checkpoint = vi.fn(async () => undefined);
	const harness = instance as unknown as {
		createCmsScriptExecutor: () => Promise<Executor>;
		getMcpServers: () => unknown;
		mcpToolMeta: (name: string) => { serverId: string; inputSchema: unknown } | null;
		callMcpTool: (
			name: string,
			serverId: string,
			inputSchema: unknown,
			args: Record<string, unknown>,
		) => Promise<unknown>;
		refreshAndReloadPreview: typeof refresh;
		checkpointSite: typeof checkpoint;
		buildCmsScriptTool: (turn: unknown) => Promise<Record<string, ScriptTool>>;
	};
	harness.createCmsScriptExecutor = async () => new ScriptedExecutor(programs);
	harness.getMcpServers = () => ({
		tools: ["settings_update", "content_create", "menu_set_items", "content_get"].map((name) => ({
			name,
			serverId: "emdash",
			description: name,
			inputSchema: { type: "object" },
		})),
	});
	harness.mcpToolMeta = () => ({ serverId: "emdash", inputSchema: { type: "object" } });
	harness.callMcpTool = async (name, _serverId, _inputSchema, args) => {
		calls.push({ name, args });
		if (name === "content_create" && args.slug === "bad") {
			return {
				status: "toolError",
				text: "[VALIDATION_ERROR] title: Required",
				result: { content: [{ type: "text", text: "[VALIDATION_ERROR] title: Required" }] },
			};
		}
		return mcpJson({ item: { id: `id-${String(args.slug ?? name)}`, slug: args.slug } });
	};
	harness.refreshAndReloadPreview = refresh;
	harness.checkpointSite = checkpoint;
	const convergence = new BuildConvergence();
	const metrics = new TurnMetrics({
		turnId: "turn-1",
		kind: "initial-build",
		resumed: false,
		model: "test",
		stepCap: 256,
	});
	const build = () =>
		harness.buildCmsScriptTool({
			convergence,
			failureGuard: new McpToolFailureGuard(),
			metrics,
			abortSignal: new AbortController().signal,
			toolNames: ["settings_update", "content_create", "menu_set_items", "content_get"],
		});
	return { harness, calls, refresh, checkpoint, convergence, metrics, build };
}

const options = { toolCallId: "script-1", messages: [] };

describe("run_cms_script", () => {
	beforeEach(async () => {
		await reset();
	});

	it("runs a program's CMS calls in order with one refresh, one checkpoint and one revision", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000051");
		await runInDurableObject(agent, async (instance) => {
			const { calls, refresh, checkpoint, convergence, metrics, build } = install(instance, {
				seed: async (cms) => {
					await cms.settings_update!({ title: "Crumb & Co." });
					for (const slug of ["rye", "spelt", "oat"]) {
						await cms.content_create!({ collection: "posts", slug, status: "published", data: {} });
					}
					await cms.menu_set_items!({ name: "primary", items: [] });
					return { done: true };
				},
			});

			const tools = await build();
			const output = await tools.run_cms_script!.execute({ code: "seed" }, options);

			expect(output).toMatchObject({
				success: true,
				changed: true,
				result: { done: true },
				calls: 5,
			});
			expect(calls.map((call) => call.name)).toEqual([
				"settings_update",
				"content_create",
				"content_create",
				"content_create",
				"menu_set_items",
			]);
			expect(refresh).toHaveBeenCalledOnce();
			expect(checkpoint).toHaveBeenCalledOnce();
			expect(convergence.currentRevision()).toBe(1);
			expect(metrics.finish("finished")?.scriptCalls.content_create).toMatchObject({ calls: 3 });
		});
	});

	it("leaves a read-only program without sync or a new revision", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000052");
		await runInDurableObject(agent, async (instance) => {
			const { refresh, checkpoint, convergence, build } = install(instance, {
				read: async (cms) => cms.content_get!({ collection: "posts", id: "rye" }),
			});

			const output = await (await build()).run_cms_script!.execute({ code: "read" }, options);

			expect(output).toMatchObject({ success: true, changed: false });
			expect(refresh).not.toHaveBeenCalled();
			expect(checkpoint).not.toHaveBeenCalled();
			expect(convergence.currentRevision()).toBe(0);
		});
	});

	it("reports a failed inner call, keeps what completed, and still saves once", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000053");
		await runInDurableObject(agent, async (instance) => {
			const { checkpoint, convergence, build } = install(instance, {
				partial: async (cms) => {
					await cms.content_create!({ collection: "posts", slug: "rye", data: { title: "Rye" } });
					await cms.content_create!({ collection: "posts", slug: "bad", data: { title: "Bad" } });
					return "unreachable";
				},
			});

			const output = await (await build()).run_cms_script!.execute({ code: "partial" }, options);

			expect(output).toMatchObject({
				success: false,
				changed: true,
				error: expect.stringContaining("content_create failed: [VALIDATION_ERROR]"),
			});
			expect(output.log).toEqual([
				{ tool: "content_create", ok: true, ref: "rye" },
				expect.objectContaining({ tool: "content_create", ok: false }),
			]);
			expect(checkpoint).toHaveBeenCalledOnce();
			// The failed entity still forces a direct repair next step.
			expect(convergence.hasUnresolvedFailures()).toBe(true);
		});
	});

	it("reuses an identical successful program instead of running it again", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000054");
		await runInDurableObject(agent, async (instance) => {
			const { calls, build } = install(instance, {
				once: async (cms) => cms.settings_update!({ title: "Crumb & Co." }),
			});
			const tools = await build();

			await tools.run_cms_script!.execute({ code: "once" }, options);
			const again = await tools.run_cms_script!.execute({ code: "once" }, options);

			expect(again).toMatchObject({ cached: true, changed: false });
			expect(calls).toHaveLength(1);
		});
	});

	it("is offered only when the loader and the switch are both present", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000055");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as {
				createCmsScriptExecutor: () => Promise<Executor | undefined>;
			};
			await expect(harness.createCmsScriptExecutor()).resolves.toBeDefined();
			const agentEnv = Reflect.get(instance, "env") as Record<string, unknown>;
			const flag = agentEnv.ENABLE_CMS_SCRIPTS;
			agentEnv.ENABLE_CMS_SCRIPTS = "false";
			try {
				await expect(harness.createCmsScriptExecutor()).resolves.toBeUndefined();
			} finally {
				agentEnv.ENABLE_CMS_SCRIPTS = flag;
			}
		});
	});
});

describe("CMS program sandbox", () => {
	it("runs a program in a Dynamic Worker with no network and returns its result", async () => {
		const executor = await createCmsScriptExecutor(testEnv.LOADER);
		const fns = { echo: async (input: unknown) => input };

		const echoed = await executor.execute(
			"async () => { console.log('hi'); return await cms.echo({ a: 1 }); }",
			[{ name: "cms", fns: fns as Record<string, (...args: unknown[]) => Promise<unknown>> }],
		);
		expect(echoed).toMatchObject({ result: { a: 1 } });
		expect(echoed.logs?.join("\n")).toContain("hi");

		const offline = await executor.execute(
			"async () => { await fetch('https://example.com'); return 'reached'; }",
			[{ name: "cms", fns: {} }],
		);
		expect(offline.result).not.toBe("reached");
		expect(offline.error).toBeTruthy();
	});

	it("reports anything a program throws as a failure", async () => {
		const executor = await createCmsScriptExecutor(testEnv.LOADER);
		const run = (code: string) => executor.execute(code, [{ name: "cms", fns: {} }]);

		await expect(run('async () => { throw "boom"; }')).resolves.toMatchObject({
			error: expect.stringContaining("boom"),
		});
		expect((await run("async () => { throw new Error(); }")).error).toBeTruthy();
		// Statement lists are still wrapped into a function before the guard.
		await expect(run("const a = 1;\na + 1")).resolves.toMatchObject({ result: 2 });
		await expect(run("async () => 3 // done")).resolves.toMatchObject({ result: 3 });
		await expect(run("async () => { return 4; };")).resolves.toMatchObject({ result: 4 });
	});
});
