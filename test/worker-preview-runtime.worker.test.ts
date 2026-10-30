import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";
import { CANONICAL_WORKER_TS, SITE_PATH } from "../src/worker/tools.js";

const PROJECT_ID = "88888888-8888-4888-8888-888888888888";
const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

/**
 * A container whose processes outlive the BuilderAgent instance that started
 * them, as after a deploy or an eviction. Port 4321 answers while a dev server runs.
 */
function container() {
	const running = new Map<string, string>();
	const files = new Map<string, string>();
	const listening = () => [...running.values()].some((command) => command.includes("pnpm dev"));
	const ops = {
		readFile: async (path: string) => ({
			success: files.has(path),
			content: files.get(path) ?? "",
		}),
		writeFile: async (path: string, content: string) => {
			files.set(path, content);
			return { success: true };
		},
		exec: async (command: string) => {
			// Stopping waits for the port to close; starting and recovery probe it.
			const port = command.includes("/dev/tcp/127.0.0.1/4321");
			const success = port && (command.includes("if ! timeout") ? !listening() : listening());
			return { success, exitCode: success ? 0 : 1, stdout: "", stderr: "" };
		},
		startProcess: async (id: string, command: string) => void running.set(id, command),
		followProcessLogs: async () =>
			new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
		stopProcess: async (id: string) => void running.delete(id),
		stopProcesses: async (prefix: string) => {
			for (const id of running.keys()) if (id.startsWith(prefix)) running.delete(id);
		},
	};
	return { ops, running, files };
}

/** A container whose dev server answers, and what recovering it does, in order. */
function warmSite(
	instance: BuilderAgent,
	site: {
		runtime: string;
		quickTunnel?: boolean;
		previousUrl: string;
		url: string;
		mcpConnects?: boolean;
	},
) {
	const steps: unknown[] = [];
	instance.setState({ ...instance.state, previewUrl: site.previousUrl });
	Object.assign(instance, {
		waitForSandbox: async () => ({ ok: true }),
		execRecoveryCommand: async () => ({ success: true, exitCode: 0, stdout: "", stderr: "" }),
		sandboxOps: () => ({ readFile: async () => ({ success: true, content: site.runtime }) }),
		exposePreview: async () => ({ url: site.url }),
		usesQuickTunnelPreview: () => site.quickTunnel ?? false,
		stopDevServer: async () => void steps.push("stop the dev server"),
		startDevServer: async (url: string) => void steps.push(["start the dev server", url]),
		refreshPreviewCache: async () => void steps.push("refresh the preview"),
		broadcast: (message: string) => {
			if (message === '{"type":"reload"}') steps.push("reload the preview");
		},
		getApiToken: () => "test-token",
		connectMcp: async (url: string, token: string) => {
			steps.push(["connect MCP", url, token]);
			return site.mcpConnects ?? true;
		},
	});
	return steps;
}

function recoverSite(instance: BuilderAgent, reconnectMcp = false) {
	const internals = instance as unknown as {
		recoverSite(hostname: string, reconnectMcp: boolean): Promise<unknown>;
	};
	return internals.recoverSite("build.example.test", reconnectMcp);
}

describe("Worker Preview runtime", () => {
	beforeEach(async () => {
		await reset();
	});

	it("notifies connected previews when a stopped dev server recovers", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as {
				execRecoveryCommand(command: string, timeout: number): Promise<{ success: boolean }>;
				sandboxOps(): object;
				getApiToken(): string | undefined;
				connectMcp(url: string, token: string): Promise<boolean>;
				exposePreview(hostname: string): Promise<{ url: string }>;
				startDevServer(url: string): Promise<void>;
				refreshPreviewSnapshots(): Promise<void>;
				sendConsole(message: string): void;
				markMilestone(name: string): void;
				broadcast(message: string): void;
				doRecoverSite(hostname: string): Promise<{ ready: boolean; previewUrl?: string }>;
			};
			const commands = vi
				.fn()
				.mockResolvedValueOnce({ success: false })
				.mockResolvedValueOnce({ success: true });
			const startDevServer = vi.fn(async () => undefined);
			const refreshPreviewSnapshots = vi.fn(async () => undefined);
			const broadcast = vi.fn();
			internals.execRecoveryCommand = commands;
			internals.sandboxOps = () => ({
				ensureRunning: async () => ({ ok: true }),
				cancelStart: async () => {},
			});
			internals.getApiToken = () => "test-token";
			internals.connectMcp = async () => {
				expect(broadcast).toHaveBeenCalledWith('{"type":"reload"}');
				return true;
			};
			internals.exposePreview = async () => ({ url: "https://preview.example.test/" });
			internals.startDevServer = startDevServer;
			internals.refreshPreviewSnapshots = refreshPreviewSnapshots;
			internals.sendConsole = () => undefined;
			internals.markMilestone = () => undefined;
			internals.broadcast = broadcast;

			expect(await internals.doRecoverSite("build.example.test")).toEqual({
				ready: true,
				previewUrl: "https://preview.example.test/",
			});
			expect(commands).toHaveBeenCalledTimes(2);
			expect(startDevServer).toHaveBeenCalledWith("https://preview.example.test/");
			expect(refreshPreviewSnapshots).toHaveBeenCalledOnce();
			expect(broadcast).toHaveBeenCalledWith('{"type":"reload"}');
		});
	});

	it.each([
		{
			change: "the protected runtime changed",
			runtime: "// The runtime an older builder wrote",
			previousUrl: "https://preview.example.test/",
			url: "https://preview.example.test/",
		},
		{
			change: "the quick tunnel changed",
			runtime: CANONICAL_WORKER_TS,
			quickTunnel: true,
			previousUrl: "https://old-tunnel.trycloudflare.com/",
			url: "https://new-tunnel.trycloudflare.com/",
		},
	])("reconnects MCP when a warm recovery restarts the dev server: $change", async (site) => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		const steps = await runInDurableObject(agent, async (instance) => {
			const steps = warmSite(instance, site);
			steps.push(await recoverSite(instance));
			return steps;
		});

		// The preview comes back first, as on a restored site.
		expect(steps).toEqual([
			"stop the dev server",
			["start the dev server", site.url],
			"refresh the preview",
			"reload the preview",
			["connect MCP", site.url, "test-token"],
			{ ready: true, previewUrl: site.url },
		]);
	});

	it("reconnects MCP once when the caller asked for it and the dev server restarts", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		const steps = await runInDurableObject(agent, async (instance) => {
			const steps = warmSite(instance, {
				runtime: "// The runtime an older builder wrote",
				previousUrl: "https://preview.example.test/",
				url: "https://preview.example.test/",
			});
			steps.push(await recoverSite(instance, true));
			return steps;
		});

		// A caller that needs MCP back hears of a failed reconnect before the preview reloads.
		expect(steps).toEqual([
			"stop the dev server",
			["start the dev server", "https://preview.example.test/"],
			"refresh the preview",
			["connect MCP", "https://preview.example.test/", "test-token"],
			"reload the preview",
			{ ready: true, previewUrl: "https://preview.example.test/" },
		]);
	});

	it("leaves MCP alone when a warm recovery keeps its dev server", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		const steps = await runInDurableObject(agent, async (instance) => {
			const steps = warmSite(instance, {
				runtime: CANONICAL_WORKER_TS,
				previousUrl: "https://preview.example.test/",
				url: "https://preview.example.test/",
			});
			steps.push(await recoverSite(instance));
			return steps;
		});

		expect(steps).toEqual([
			"refresh the preview",
			"reload the preview",
			{ ready: true, previewUrl: "https://preview.example.test/" },
		]);
	});

	it("keeps the preview a restarted dev server recovered when MCP does not reconnect", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		const outcome = await runInDurableObject(agent, async (instance) => {
			const steps = warmSite(instance, {
				runtime: CANONICAL_WORKER_TS,
				quickTunnel: true,
				previousUrl: "https://old-tunnel.trycloudflare.com/",
				url: "https://new-tunnel.trycloudflare.com/",
				mcpConnects: false,
			});
			const recovered = await recoverSite(instance);
			return { steps, recovered, previewUrl: instance.state.previewUrl };
		});

		expect(outcome).toEqual({
			steps: expect.arrayContaining([
				["connect MCP", "https://new-tunnel.trycloudflare.com/", "test-token"],
			]),
			recovered: { ready: true, previewUrl: "https://new-tunnel.trycloudflare.com/" },
			previewUrl: "https://new-tunnel.trycloudflare.com/",
		});
	});

	it.each<{
		restart: string;
		run(instance: BuilderAgent, site: ReturnType<typeof container>): Promise<unknown>;
		result: unknown;
	}>([
		{
			restart: "restartDevServer",
			run: (instance) => {
				Object.assign(instance, {
					refreshPreviewSnapshots: async () => {},
					// The restart must stop the old server itself, not fall back to recovery.
					recoverSite: async () => ({ ready: false, error: "Recovery is not under test." }),
				});
				return (instance as unknown as { restartDevServer(): Promise<unknown> }).restartDevServer();
			},
			result: { success: true },
		},
		{
			restart: "a warm recovery after a deploy changed the protected runtime",
			run: (instance, site) => {
				site.files.set(`${SITE_PATH}/src/worker.ts`, "// The runtime an older builder wrote");
				Object.assign(instance, {
					waitForSandbox: async () => ({ ok: true }),
					exposePreview: async () => ({ url: "https://preview.example.test/" }),
					refreshPreviewCache: async () => {},
				});
				return recoverSite(instance);
			},
			result: { ready: true, previewUrl: "https://preview.example.test/" },
		},
	])("stops the dev server an earlier instance started: $restart", async ({ run, result }) => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		const site = container();
		await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as {
				sandboxOps(): typeof site.ops;
				startDevServer(url: string): Promise<void>;
			};
			internals.sandboxOps = () => site.ops;
			await internals.startDevServer("https://preview.example.test/");
		});
		const [earlier] = site.running.keys();
		expect(earlier).toMatch(/^dev-/);
		// The instance goes, and its server keeps running in the container.
		await evictDurableObject(agent);

		const restarted = await runInDurableObject(agent, (instance) => {
			(instance as unknown as { sandboxOps(): typeof site.ops }).sandboxOps = () => site.ops;
			return run(instance, site);
		});

		expect(restarted).toEqual(result);
		// The new instance's server is the only one left.
		expect(site.running.has(earlier!)).toBe(false);
		expect([...site.running.keys()]).toEqual([expect.stringMatching(/^dev-/)]);
	});

	it("uses a quick tunnel without exposing the production preview hostname", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			const sandbox = {
				openTunnel: vi.fn(async () => ({ url: "https://branch-preview.trycloudflare.com/" })),
				exposePort: vi.fn(),
			};
			const internals = instance as unknown as {
				env: Record<string, unknown>;
				sandboxOps(): typeof sandbox;
				exposePreview(hostname: string): Promise<{ url: string }>;
			};
			const originalMode = internals.env.SANDBOX_PREVIEW_MODE;
			try {
				internals.env.SANDBOX_PREVIEW_MODE = "quick-tunnel";
				internals.sandboxOps = () => sandbox;

				await expect(internals.exposePreview("build.emdashcms.com")).resolves.toEqual({
					url: "https://branch-preview.trycloudflare.com/",
				});
				expect(sandbox.openTunnel).toHaveBeenCalledWith(4321);
				expect(sandbox.exposePort).not.toHaveBeenCalled();
			} finally {
				internals.env.SANDBOX_PREVIEW_MODE = originalMode;
			}
		});
	});
});
