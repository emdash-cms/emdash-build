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
				.mockResolvedValueOnce({ success: true }) // Commit it.
				.mockResolvedValueOnce({ success: false, exitCode: 124, stderr: "", stdout: "" })
				.mockResolvedValueOnce({ success: true }) // Stage final snapshot.
				.mockResolvedValueOnce({ success: true })
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
			expect(exec).toHaveBeenCalledTimes(3);

			expect(await harness.retrySessionSave()).toBe(true);
			expect(exec).toHaveBeenCalledTimes(6);
			expect(instance.state.persistenceError).toBeUndefined();
			await harness.backupSite({ skipIfUnchanged: true });
			expect(exec).toHaveBeenCalledTimes(6);
			previewGeneration += 1;
			exec
				.mockResolvedValueOnce({ success: true })
				.mockResolvedValueOnce({ success: true })
				.mockResolvedValueOnce({ success: true });
			await harness.backupSite({ skipIfUnchanged: true });
			expect(exec).toHaveBeenCalledTimes(9);
			expect(exec.mock.calls[1]?.[0]).toContain("git commit-tree");
			expect(exec.mock.calls[2]?.[0]).toContain("timeout --signal=TERM --kill-after=2s");
		});
	});

	it("retries one transient Artifacts disconnect immediately", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000013");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			const exec = vi
				.fn()
				.mockResolvedValueOnce({ success: true })
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
			// Only the push is retried; the snapshot was committed once.
			expect(exec).toHaveBeenCalledTimes(4);
			expect(
				exec.mock.calls.filter(([command]) => String(command).includes("commit-tree")),
			).toHaveLength(1);
			expect(instance.state.persistenceError).toBeUndefined();
		});
	});

	it("reuses a write token across checkpoints until a push fails", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000015");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			const exec = vi.fn().mockResolvedValue({ success: true });
			const ensureArtifactsRepo = vi.fn(async () => ({
				remote: "https://artifacts.example/git/site.git",
				token: "test-token",
				ttlSeconds: 900,
			}));
			const harness = instance as unknown as {
				getOrCreateSandbox: () => { exec: typeof exec };
				ensureArtifactsRepo: typeof ensureArtifactsRepo;
				backupSite: (options?: { quiet?: boolean }) => Promise<string | undefined>;
			};
			harness.getOrCreateSandbox = () => ({ exec });
			harness.ensureArtifactsRepo = ensureArtifactsRepo;

			await harness.backupSite();
			await harness.backupSite();
			expect(ensureArtifactsRepo).toHaveBeenCalledOnce();

			exec
				.mockResolvedValueOnce({ success: true })
				.mockResolvedValueOnce({ success: true })
				.mockResolvedValueOnce({ success: false, exitCode: 128, stderr: "403", stdout: "" });
			await expect(harness.backupSite()).resolves.toBe(
				"The latest session checkpoint could not be saved.",
			);
			await harness.backupSite();
			expect(ensureArtifactsRepo).toHaveBeenCalledTimes(2);

			// A token of unknown lifetime, such as the one a new repository comes with, is not kept.
			ensureArtifactsRepo.mockImplementation(async () => ({
				remote: "https://artifacts.example/git/site.git",
				token: "first-token",
				ttlSeconds: undefined as unknown as number,
			}));
			Reflect.set(instance, "artifactsWriteAccess", undefined);
			await harness.backupSite();
			await harness.backupSite();
			expect(ensureArtifactsRepo).toHaveBeenCalledTimes(4);
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

			expect(exec).toHaveBeenCalledTimes(4);
			expect(instance.state.persistenceError).toBeUndefined();
		});
	});
});

describe("session upload recovery", () => {
	beforeEach(async () => {
		await reset();
	});

	function setUp(instance: BuilderAgent, exec: ReturnType<typeof vi.fn>) {
		instance.setState({ ...instance.state, siteReady: true });
		Reflect.set(Reflect.get(instance, "env") as object, "Sandbox", {
			getByName: () => ({ getPreviewGeneration: async () => 3 }),
		});
		const harness = instance as unknown as {
			getOrCreateSandbox: () => unknown;
			ensureArtifactsRepo: () => Promise<{ remote: string; token: string }>;
			checkpointSite: () => Promise<string | undefined>;
			backupSite: (options?: { quiet?: boolean }) => Promise<string | undefined>;
		};
		harness.getOrCreateSandbox = () => ({ exec });
		harness.ensureArtifactsRepo = async () => ({
			remote: "https://artifacts.example/git/site.git",
			token: "test-token",
		});
		return harness;
	}

	it("rebuilds a damaged snapshot repository once when a commit fails", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000025");
		await runInDurableObject(agent, async (instance) => {
			let commits = 0;
			const exec = vi.fn(async (command: string) => {
				if (command.includes("commit-tree")) {
					commits += 1;
					return commits === 1
						? { success: false, exitCode: 128, stdout: "", stderr: "fatal: bad object HEAD" }
						: { success: true, exitCode: 0, stdout: "abc\n", stderr: "" };
				}
				return { success: true, exitCode: 0, stdout: "", stderr: "" };
			});
			const harness = setUp(instance, exec);

			await expect(harness.backupSite()).resolves.toBeUndefined();

			const commands = exec.mock.calls.map(([command]) => String(command));
			const reset = commands.findIndex(
				(command) => command.startsWith("rm -rf") && command.includes("session-git"),
			);
			expect(reset).toBeGreaterThan(-1);
			expect(commits).toBe(2);
			expect(instance.state.persistenceError).toBeUndefined();
		});
	});
});
