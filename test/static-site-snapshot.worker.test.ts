import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";

const PROJECT_ID = "77777777-7777-4777-8777-777777777777";
const PREVIEW_ORIGIN = "https://4321-project-preview.example.test";
const LIVE_ORIGIN = "https://s-77777777777747778777777777777777.sites.example.test";

const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

function emptyLogStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
}

function harnessSandbox(buildExitCode = 0) {
	const stopped: string[] = [];
	const builtCss = "h1{color:red}";
	const startProcess = vi.fn(
		async (_id: string, _command: string, _options?: { cwd?: string }) => undefined,
	);
	const commandOf = (id: string) =>
		startProcess.mock.calls.find(([started]) => started === id)?.[1] ?? "";
	const fetchPort = vi.fn(async (_port: number, url: string, _init?: RequestInit) => {
		const path = new URL(url).pathname;
		if (path === "/") {
			return new Response(
				'<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body><h1>Published</h1></body></html>',
				{ headers: { "content-type": "text/html" } },
			);
		}
		return new Response("Not found", { status: 404 });
	});
	const exec = vi.fn(async (command: string) => {
		if (command.includes("wc -c")) {
			return { success: true, stdout: String(builtCss.length), stderr: "" };
		}
		if (command.includes("head -c")) {
			return { success: true, stdout: btoa(builtCss), stderr: "" };
		}
		return { success: true, stdout: "", stderr: "" };
	});
	const writeFile = vi.fn(async () => ({ success: true }));
	return {
		stopped,
		startProcess,
		fetchPort,
		exec,
		writeFile,
		sandbox: {
			startProcess,
			followProcessLogs: async () => emptyLogStream(),
			waitForProcessExit: async (id: string) => ({
				exitCode: commandOf(id).includes("pnpm build") ? buildExitCode : 0,
			}),
			exec,
			stopProcess: async (id: string) => {
				stopped.push(id);
			},
			fetchPort,
			readFile: async (path: string, options?: { encoding?: string }) => {
				if (path.endsWith("/.dev.vars"))
					return { success: true, content: "EMDASH_SITE_URL=http://localhost:4321\n" };
				if (path.endsWith("/dist/client/assets/app.css")) {
					return {
						success: true,
						content: options?.encoding === "base64" ? btoa(builtCss) : builtCss,
					};
				}
				return { success: false, content: "" };
			},
			writeFile,
		},
	};
}

describe("Builder production snapshot preparation", () => {
	beforeEach(async () => {
		await reset();
	});

	it("stops an untracked Astro listener before starting another dev server", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			const exec = vi.fn(async () => ({ success: true, stdout: "", stderr: "" }));
			const stopProcess = vi.fn(async () => undefined);
			const harness = instance as unknown as {
				devServerProcessId?: string;
				sandboxOps: () => { exec: typeof exec; stopProcess: typeof stopProcess };
				stopDevServer(): Promise<void>;
			};
			harness.devServerProcessId = undefined;
			harness.sandboxOps = () => ({ exec, stopProcess });

			await harness.stopDevServer();

			expect(stopProcess).not.toHaveBeenCalled();
			expect(exec).toHaveBeenCalledWith(expect.stringContaining("pkill"), {
				cwd: "/home/user/site",
				timeout: 5000,
			});
		});
	});

	it("builds from a frozen checkpoint without interrupting authoring", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				previewUrl: PREVIEW_ORIGIN,
			});
			const runtime = harnessSandbox();
			const execRecoveryCommand = vi.fn(async () => ({ success: true }));
			const stopDevServer = vi.fn(async () => undefined);
			const startDevServer = vi.fn(async () => undefined);
			const refreshPreviewSnapshots = vi.fn(async () => undefined);
			const harness = instance as unknown as {
				sandboxOps: () => typeof runtime.sandbox;
				execRecoveryCommand: typeof execRecoveryCommand;
				backupSite: () => Promise<string | undefined>;
				stopDevServer: typeof stopDevServer;
				startDevServer: typeof startDevServer;
				refreshPreviewSnapshots: typeof refreshPreviewSnapshots;
				prepareStaticSiteSnapshot(liveOrigin: string): Promise<{
					sourceRevision: string;
					routes: Array<{ path: string }>;
				}>;
			};
			harness.sandboxOps = () => runtime.sandbox;
			harness.execRecoveryCommand = execRecoveryCommand;
			harness.backupSite = async () => undefined;
			harness.stopDevServer = stopDevServer;
			harness.startDevServer = startDevServer;
			harness.refreshPreviewSnapshots = refreshPreviewSnapshots;
			let generationReads = 0;
			Reflect.set(Reflect.get(instance, "env") as object, "Sandbox", {
				getByName: () => ({
					getPreviewGeneration: async () => {
						generationReads += 1;
						return 4;
					},
				}),
			});

			const snapshot = await harness.prepareStaticSiteSnapshot(LIVE_ORIGIN);

			expect(snapshot.sourceRevision).toMatch(/^sha256:/);
			expect(snapshot.routes).toMatchObject([{ path: "/" }]);
			expect(stopDevServer).not.toHaveBeenCalled();
			expect(startDevServer).not.toHaveBeenCalled();
			expect(refreshPreviewSnapshots).not.toHaveBeenCalled();
			expect(generationReads).toBe(3);
			// The build exited by itself; only the production runner is stopped.
			expect(runtime.stopped).toEqual([runtime.startProcess.mock.calls[1]?.[0]]);
			expect(runtime.startProcess.mock.calls[0]?.[1]).toContain("pnpm build");
			expect(runtime.startProcess.mock.calls[0]?.[2]).toEqual({
				cwd: "/tmp/emdash-build-publish",
			});
			expect(runtime.startProcess.mock.calls[1]?.[1]).toContain("wrangler dev");
			expect(runtime.startProcess.mock.calls[1]?.[1]).toContain("--persist-to .wrangler/state");
			expect(runtime.startProcess.mock.calls[1]?.[2]).toEqual({
				cwd: "/tmp/emdash-build-publish",
			});
			const stagingCommand = runtime.exec.mock.calls.find(([command]) =>
				command.includes("timeout --signal=TERM"),
			)?.[0];
			expect(stagingCommand).toContain("/tmp/emdash-build-session-snapshot");
			expect(stagingCommand).toContain("/tmp/emdash-build-publish");
			expect(stagingCommand).toContain(".vite");
			expect(stagingCommand).not.toContain("ln -s");
			expect(runtime.writeFile).toHaveBeenCalledWith(
				"/tmp/emdash-build-publish/.dev.vars",
				expect.stringContaining(`EMDASH_SITE_URL=${LIVE_ORIGIN}`),
			);
			expect(runtime.fetchPort.mock.calls[0]?.[0]).toBe(4322);
			expect(runtime.fetchPort.mock.calls[0]?.[1]).toBe(`${LIVE_ORIGIN}/`);
			expect(runtime.fetchPort.mock.calls[0]?.[2]).not.toHaveProperty("signal");
		});
	});

	it("restores a cold site before checkpointing", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				previewUrl: PREVIEW_ORIGIN,
				initialGeneration: { id: "generation", status: "ready" },
			});
			const runtime = harnessSandbox();
			const recoverSite = vi.fn(async () => ({ ready: true, previewUrl: PREVIEW_ORIGIN }));
			const backupSite = vi.fn(async () => undefined);
			const execRecoveryCommand = vi
				.fn<() => Promise<{ success: boolean }>>()
				.mockResolvedValueOnce({ success: false })
				.mockResolvedValueOnce({ success: true });
			const harness = instance as unknown as {
				sandboxOps: () => typeof runtime.sandbox;
				execRecoveryCommand: typeof execRecoveryCommand;
				recoverSite: typeof recoverSite;
				backupSite: typeof backupSite;
				prepareStaticSiteSnapshot(liveOrigin: string): Promise<unknown>;
			};
			harness.sandboxOps = () => runtime.sandbox;
			harness.execRecoveryCommand = execRecoveryCommand;
			harness.recoverSite = recoverSite;
			harness.backupSite = backupSite;
			Reflect.set(Reflect.get(instance, "env") as object, "Sandbox", {
				getByName: () => ({ getPreviewGeneration: async () => 4 }),
			});

			await expect(harness.prepareStaticSiteSnapshot(LIVE_ORIGIN)).resolves.toBeDefined();

			expect(recoverSite).toHaveBeenCalledOnce();
			expect(execRecoveryCommand).toHaveBeenCalledTimes(2);
			expect(backupSite).toHaveBeenCalledOnce();
		});
	});

	it("fails before checkpointing when cold-site recovery rejects", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				previewUrl: PREVIEW_ORIGIN,
				initialGeneration: { id: "generation", status: "ready" },
			});
			const runtime = harnessSandbox();
			const backupSite = vi.fn(async () => undefined);
			const harness = instance as unknown as {
				sandboxOps: () => typeof runtime.sandbox;
				execRecoveryCommand: () => Promise<{ success: boolean }>;
				recoverSite: () => Promise<never>;
				backupSite: typeof backupSite;
				prepareStaticSiteSnapshot(liveOrigin: string): Promise<unknown>;
			};
			harness.sandboxOps = () => runtime.sandbox;
			harness.execRecoveryCommand = async () => ({ success: false });
			harness.recoverSite = async () => {
				throw new Error("sandbox wake failed");
			};
			harness.backupSite = backupSite;

			await expect(harness.prepareStaticSiteSnapshot(LIVE_ORIGIN)).rejects.toMatchObject({
				code: "SITE_NOT_READY",
				message: "The saved site could not be restored before publishing.",
			});

			expect(backupSite).not.toHaveBeenCalled();
		});
	});

	it("rejects a generation change without restarting the authoring preview", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				previewUrl: PREVIEW_ORIGIN,
				initialGeneration: { id: "generation", status: "ready" },
			});
			const runtime = harnessSandbox();
			const startDevServer = vi.fn(async () => undefined);
			const harness = instance as unknown as {
				sandboxOps: () => typeof runtime.sandbox;
				backupSite: () => Promise<string | undefined>;
				stopDevServer: () => Promise<void>;
				startDevServer: typeof startDevServer;
				refreshPreviewSnapshots: () => Promise<void>;
				prepareStaticSiteSnapshot(liveOrigin: string): Promise<unknown>;
			};
			harness.sandboxOps = () => runtime.sandbox;
			harness.backupSite = async () => undefined;
			harness.stopDevServer = async () => undefined;
			harness.startDevServer = startDevServer;
			harness.refreshPreviewSnapshots = async () => undefined;
			const generations = [4, 4, 5];
			Reflect.set(Reflect.get(instance, "env") as object, "Sandbox", {
				getByName: () => ({ getPreviewGeneration: async () => generations.shift() }),
			});

			await expect(harness.prepareStaticSiteSnapshot(LIVE_ORIGIN)).rejects.toMatchObject({
				code: "SITE_CHANGED_DURING_PUBLISH",
			});
			expect(startDevServer).not.toHaveBeenCalled();
			expect(runtime.stopped).toEqual([runtime.startProcess.mock.calls[1]?.[0]]);
		});
	});

	it("leaves the authoring preview running when the production build fails", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			instance.setState({
				...instance.state,
				siteReady: true,
				previewUrl: PREVIEW_ORIGIN,
				initialGeneration: { id: "generation", status: "ready" },
			});
			const runtime = harnessSandbox(1);
			const startDevServer = vi.fn(async () => undefined);
			const harness = instance as unknown as {
				sandboxOps: () => typeof runtime.sandbox;
				backupSite: () => Promise<string | undefined>;
				stopDevServer: () => Promise<void>;
				startDevServer: typeof startDevServer;
				refreshPreviewSnapshots: () => Promise<void>;
				prepareStaticSiteSnapshot(liveOrigin: string): Promise<unknown>;
			};
			harness.sandboxOps = () => runtime.sandbox;
			harness.backupSite = async () => undefined;
			harness.stopDevServer = async () => undefined;
			harness.startDevServer = startDevServer;
			harness.refreshPreviewSnapshots = async () => undefined;
			Reflect.set(Reflect.get(instance, "env") as object, "Sandbox", {
				getByName: () => ({ getPreviewGeneration: async () => 4 }),
			});

			await expect(harness.prepareStaticSiteSnapshot(LIVE_ORIGIN)).rejects.toThrow(/build failed/i);
			expect(startDevServer).not.toHaveBeenCalled();
			expect(runtime.stopped).toEqual([]);
		});
	});
});
