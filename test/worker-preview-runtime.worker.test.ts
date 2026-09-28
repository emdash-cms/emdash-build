import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";

const PROJECT_ID = "88888888-8888-4888-8888-888888888888";
const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

describe("Worker Preview runtime", () => {
	beforeEach(async () => {
		await reset();
	});

	it("notifies connected previews when a stopped dev server recovers", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			const internals = instance as unknown as {
				execRecoveryCommand(command: string, timeout: number): Promise<{ success: boolean }>;
				getOrCreateSandbox(): object;
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
			internals.getOrCreateSandbox = () => ({});
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

	it("uses a quick tunnel without exposing the production preview hostname", async () => {
		const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
		await runInDurableObject(agent, async (instance) => {
			const tunnelProcess = {
				command: "cloudflared tunnel --url http://127.0.0.1:4321",
				status: "running" as const,
				getStatus: vi.fn(async () => "running" as const),
				getLogs: vi.fn(async () => ({ stdout: "", stderr: "" })),
				waitForLog: vi.fn(async () => ({
					line: "Visit https://branch-preview.trycloudflare.com",
					match: ["https://branch-preview.trycloudflare.com"],
				})),
				kill: vi.fn(async () => undefined),
			};
			const tunnelSession = {
				listProcesses: vi.fn(async () => []),
				startProcess: vi.fn(async () => tunnelProcess),
			};
			const exposePort = vi.fn();
			const sandbox = {
				createSession: vi.fn(async () => tunnelSession),
				exposePort,
			};
			const internals = instance as unknown as {
				env: Record<string, unknown>;
				getOrCreateSandbox(): typeof sandbox;
				exposePreview(hostname: string): Promise<{ url: string }>;
			};
			const originalMode = internals.env.SANDBOX_PREVIEW_MODE;
			try {
				internals.env.SANDBOX_PREVIEW_MODE = "quick-tunnel";
				internals.getOrCreateSandbox = () => sandbox;

				await expect(internals.exposePreview("build.emdashcms.com")).resolves.toEqual({
					url: "https://branch-preview.trycloudflare.com/",
				});
				expect(sandbox.createSession).toHaveBeenCalledWith({ id: "builder-tunnel" });
				expect(tunnelSession.startProcess).toHaveBeenCalledWith(
					expect.stringContaining("cloudflared tunnel"),
					{ cwd: "/home/user/site" },
				);
				expect(exposePort).not.toHaveBeenCalled();
			} finally {
				internals.env.SANDBOX_PREVIEW_MODE = originalMode;
			}
		});
	});
});
