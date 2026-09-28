import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";

const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

describe("session backup after a stalled upload", () => {
	beforeEach(async () => {
		await reset();
	});

	it("backs off repeated tool checkpoints but retries at the completed turn", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000012");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			let previewGeneration = 3;
			Reflect.set(Reflect.get(instance, "env") as object, "Sandbox", {
				getByName: () => ({ getPreviewGeneration: async () => previewGeneration }),
			});
			const exec = vi
				.fn()
				.mockResolvedValueOnce({ success: true }) // Stage first snapshot.
				.mockResolvedValueOnce({ success: false, exitCode: 124, stderr: "", stdout: "" })
				.mockResolvedValueOnce({ success: true }) // Stage final snapshot.
				.mockResolvedValueOnce({ success: true });
			const harness = instance as unknown as {
				getOrCreateSandbox: () => { exec: typeof exec };
				ensureArtifactsRepo: () => Promise<{ remote: string; token: string }>;
				backupSite: (options?: { quiet?: boolean; skipIfUnchanged?: boolean }) => Promise<void>;
				retrySessionSave: () => Promise<boolean>;
			};
			harness.getOrCreateSandbox = () => ({ exec });
			harness.ensureArtifactsRepo = async () => ({
				remote: "https://artifacts.example/git/site.git",
				token: "test-token",
			});

			await harness.backupSite({ quiet: true });
			expect(instance.state.persistenceError).toBe(
				"The latest session checkpoint could not be saved.",
			);
			await harness.backupSite({ quiet: true });
			expect(exec).toHaveBeenCalledTimes(2);

			expect(await harness.retrySessionSave()).toBe(true);
			expect(exec).toHaveBeenCalledTimes(4);
			expect(instance.state.persistenceError).toBeUndefined();
			await harness.backupSite({ skipIfUnchanged: true });
			expect(exec).toHaveBeenCalledTimes(4);
			previewGeneration += 1;
			exec.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: true });
			await harness.backupSite({ skipIfUnchanged: true });
			expect(exec).toHaveBeenCalledTimes(6);
			expect(exec.mock.calls[1]?.[0]).toContain("timeout --signal=TERM --kill-after=2s");
		});
	});

	it("retries one transient Artifacts disconnect immediately", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000013");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			const exec = vi
				.fn()
				.mockResolvedValueOnce({ success: true })
				.mockResolvedValueOnce({
					success: false,
					exitCode: 1,
					stderr: "RPC failed; HTTP 500\nsend-pack: unexpected disconnect",
					stdout: "",
				})
				.mockResolvedValueOnce({ success: true });
			const harness = instance as unknown as {
				getOrCreateSandbox: () => { exec: typeof exec };
				ensureArtifactsRepo: () => Promise<{ remote: string; token: string }>;
				backupSite: (options?: { quiet?: boolean }) => Promise<void>;
			};
			harness.getOrCreateSandbox = () => ({ exec });
			harness.ensureArtifactsRepo = async () => ({
				remote: "https://artifacts.example/git/site.git",
				token: "test-token",
			});

			await harness.backupSite();
			expect(exec).toHaveBeenCalledTimes(3);
			expect(instance.state.persistenceError).toBeUndefined();
		});
	});

	it("retries a staging race before exposing a persistence error", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000014");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			const exec = vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					exitCode: 1,
					stderr: "cp: cannot stat 'content.sqlite-wal': No such file or directory",
					stdout: "",
				})
				.mockResolvedValueOnce({ success: true })
				.mockResolvedValueOnce({ success: true });
			const harness = instance as unknown as {
				getOrCreateSandbox: () => { exec: typeof exec };
				ensureArtifactsRepo: () => Promise<{ remote: string; token: string }>;
				backupSite: () => Promise<void>;
			};
			harness.getOrCreateSandbox = () => ({ exec });
			harness.ensureArtifactsRepo = async () => ({
				remote: "https://artifacts.example/git/site.git",
				token: "test-token",
			});

			await harness.backupSite();

			expect(exec).toHaveBeenCalledTimes(3);
			expect(instance.state.persistenceError).toBeUndefined();
		});
	});
});
