import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";

const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

interface Harness {
	refreshAndReloadPreview: (initialBuild?: boolean) => Promise<void>;
	callMcpTool: (
		name: string,
		serverId: string,
		inputSchema: unknown,
		args: Record<string, unknown>,
	) => Promise<unknown>;
	broadcast: (message: string) => void;
}

function deferredSandbox() {
	const renders: Array<() => void> = [];
	const stub = {
		invalidatePreviewSnapshots: vi.fn(async () => 1),
		refreshPreviews: vi.fn(
			(_paths: string[], _options?: { invalidate?: boolean }) =>
				new Promise<Array<{ path: string; success: boolean }>>((resolve) => {
					renders.push(() => resolve([{ path: "/", success: true }]));
				}),
		),
	};
	return { stub, renders };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function install(instance: BuilderAgent, stub: unknown) {
	instance.setState({ ...instance.state, siteReady: true });
	Reflect.set(Reflect.get(instance, "env") as object, "Sandbox", { getByName: () => stub });
	const harness = instance as unknown as Harness;
	const broadcasts: string[] = [];
	harness.broadcast = (message) => broadcasts.push(message);
	return { harness, broadcasts };
}

describe("preview refresh after a mutation", () => {
	beforeEach(async () => {
		await reset();
	});

	it("marks snapshots stale before returning and renders in the background", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000041");
		await runInDurableObject(agent, async (instance) => {
			const { stub, renders } = deferredSandbox();
			const { harness, broadcasts } = install(instance, stub);

			await harness.refreshAndReloadPreview();

			expect(stub.invalidatePreviewSnapshots).toHaveBeenCalledOnce();
			await settle();
			expect(stub.refreshPreviews).toHaveBeenCalledOnce();
			// Already invalidated: the render must not bump the generation again.
			expect(stub.refreshPreviews.mock.calls[0]?.[1]?.invalidate).not.toBe(true);
			expect(broadcasts).toEqual([]);
			renders[0]!();
			await settle();
			expect(broadcasts).toEqual([JSON.stringify({ type: "reload" })]);
		});
	});

	it("renders once more for mutations that landed during a render", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000042");
		await runInDurableObject(agent, async (instance) => {
			const { stub, renders } = deferredSandbox();
			const { harness } = install(instance, stub);

			await harness.refreshAndReloadPreview();
			await settle();
			await harness.refreshAndReloadPreview();
			await harness.refreshAndReloadPreview();
			await settle();
			expect(stub.refreshPreviews).toHaveBeenCalledOnce();

			renders[0]!();
			await settle();
			expect(stub.refreshPreviews).toHaveBeenCalledTimes(2);
			renders[1]!();
			await settle();
			expect(stub.refreshPreviews).toHaveBeenCalledTimes(2);
			expect(stub.invalidatePreviewSnapshots).toHaveBeenCalledTimes(3);
		});
	});

	it("holds CMS calls until a background render finishes", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000043");
		await runInDurableObject(agent, async (instance) => {
			const { stub, renders } = deferredSandbox();
			const { harness } = install(instance, stub);
			const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] }));
			Reflect.set(instance, "mcp", { callTool });

			await harness.refreshAndReloadPreview();
			await settle();
			const call = harness.callMcpTool("content_get", "emdash", { type: "object" }, {});
			await settle();
			// The dev server stalls under concurrent renders and CMS requests.
			expect(callTool).not.toHaveBeenCalled();

			renders[0]!();
			await expect(call).resolves.toMatchObject({ status: "ok" });
			expect(callTool).toHaveBeenCalledOnce();
		});
	});
});

describe("preview refresh loop robustness", () => {
	beforeEach(async () => {
		await reset();
	});

	it("starts a new render for a refresh queued as the previous loop finishes", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000045");
		await runInDurableObject(agent, async (instance) => {
			const { stub, renders } = deferredSandbox();
			const { harness } = install(instance, stub);

			await harness.refreshAndReloadPreview();
			await settle();
			renders[0]!();
			// Queued in the same tick the loop drains.
			const next = harness.refreshAndReloadPreview();
			await next;
			await settle();

			expect(stub.refreshPreviews).toHaveBeenCalledTimes(2);
		});
	});

	it("keeps refreshing after a render throws", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000046");
		await runInDurableObject(agent, async (instance) => {
			let calls = 0;
			const stub = {
				invalidatePreviewSnapshots: vi.fn(async () => 1),
				refreshPreviews: vi.fn(async () => {
					calls += 1;
					if (calls === 1) throw new Error("render crashed");
					return [{ path: "/", success: true }];
				}),
			};
			const { harness, broadcasts } = install(instance, stub);

			await harness.refreshAndReloadPreview();
			await settle();
			await harness.refreshAndReloadPreview();
			await settle();

			expect(stub.refreshPreviews).toHaveBeenCalledTimes(2);
			expect(broadcasts.length).toBeGreaterThan(0);
		});
	});

	it("lets a CMS call proceed after a bounded wait and at once on Stop", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000047");
		await runInDurableObject(agent, async (instance) => {
			const { stub } = deferredSandbox();
			const { harness } = install(instance, stub);
			const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] }));
			Reflect.set(instance, "mcp", { callTool });
			Reflect.set(instance, "previewRenderWaitMs", 50);

			// The render never finishes.
			await harness.refreshAndReloadPreview();
			await settle();
			await expect(
				harness.callMcpTool("content_get", "emdash", { type: "object" }, {}),
			).resolves.toMatchObject({ status: "ok" });

			const controller = new AbortController();
			Reflect.set(instance, "previewRenderWaitMs", 60_000);
			const stopped = (
				harness.callMcpTool as unknown as (
					...args: [string, string, unknown, Record<string, unknown>, AbortSignal]
				) => Promise<unknown>
			)("content_get", "emdash", { type: "object" }, {}, controller.signal);
			controller.abort();
			await expect(stopped).rejects.toThrow();
		});
	});

	it("holds one CMS call for a render that outlasts the wait, not each", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000048");
		await runInDurableObject(agent, async (instance) => {
			const { stub } = deferredSandbox();
			const { harness } = install(instance, stub);
			const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] }));
			Reflect.set(instance, "mcp", { callTool });
			Reflect.set(instance, "previewRenderWaitMs", 300);
			const timedCall = async () => {
				const started = Date.now();
				await harness.callMcpTool("content_get", "emdash", { type: "object" }, {});
				return Date.now() - started;
			};

			// The render never finishes.
			await harness.refreshAndReloadPreview();
			await settle();

			expect(await timedCall()).toBeGreaterThanOrEqual(290);
			expect(await timedCall()).toBeLessThan(150);
		});
	});
});

describe("dependencies for a restored site", () => {
	beforeEach(async () => {
		await reset();
	});

	it("reuses the image's dependencies and installs only when the lockfile changed", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000044");
		await runInDurableObject(agent, async (instance) => {
			let preparedExit = 0;
			const exec = vi.fn(async (command: string) => ({
				success: !command.includes("cmp -s") || preparedExit === 0,
				exitCode: command.includes("cmp -s") ? preparedExit : 0,
				stdout: "",
				stderr: "",
			}));
			const installDeps = vi.fn(async () => 0);
			const harness = instance as unknown as {
				sandboxOps: () => unknown;
				installDeps: typeof installDeps;
				restoreDependencies: () => Promise<number>;
			};
			harness.sandboxOps = () => ({ exec });
			harness.installDeps = installDeps;

			await expect(harness.restoreDependencies()).resolves.toBe(0);
			expect(installDeps).not.toHaveBeenCalled();
			expect(String(exec.mock.calls[0]?.[0])).toContain("builder-cloudflare.tgz");

			preparedExit = 1;
			await expect(harness.restoreDependencies()).resolves.toBe(0);
			expect(installDeps).toHaveBeenCalledOnce();
		});
	});
});
