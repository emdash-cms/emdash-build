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
				sandboxOps: () => { exec: typeof exec };
				ensureArtifactsRepo: () => Promise<{ remote: string; token: string }>;
				backupSite: (options?: { quiet?: boolean; skipIfUnchanged?: boolean }) => Promise<void>;
				retrySessionSave: () => Promise<boolean>;
			};
			harness.sandboxOps = () => ({ exec });
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
				sandboxOps: () => { exec: typeof exec };
				ensureArtifactsRepo: () => Promise<{ remote: string; token: string }>;
				backupSite: (options?: { quiet?: boolean }) => Promise<void>;
			};
			harness.sandboxOps = () => ({ exec });
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
				sandboxOps: () => { exec: typeof exec };
				ensureArtifactsRepo: typeof ensureArtifactsRepo;
				backupSite: (options?: { quiet?: boolean }) => Promise<string | undefined>;
			};
			harness.sandboxOps = () => ({ exec });
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
				sandboxOps: () => { exec: typeof exec };
				ensureArtifactsRepo: () => Promise<{ remote: string; token: string }>;
				backupSite: () => Promise<void>;
			};
			harness.sandboxOps = () => ({ exec });
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

describe("background session uploads", () => {
	beforeEach(async () => {
		await reset();
	});

	type Harness = {
		sandboxOps: () => unknown;
		ensureArtifactsRepo: () => Promise<{ remote: string; token: string }>;
		checkpointSite: () => Promise<string | undefined>;
		backupSite: (options?: {
			quiet?: boolean;
			skipIfUnchanged?: boolean;
		}) => Promise<string | undefined>;
	};

	function install(instance: BuilderAgent, sandbox: unknown, generation = () => 3) {
		instance.setState({ ...instance.state, siteReady: true });
		Reflect.set(Reflect.get(instance, "env") as object, "Sandbox", {
			getByName: () => ({ getPreviewGeneration: async () => generation() }),
		});
		const harness = instance as unknown as Harness;
		harness.sandboxOps = () => sandbox;
		harness.ensureArtifactsRepo = async () => ({
			remote: "https://artifacts.example/git/site.git",
			token: "test-token",
		});
		return harness;
	}

	function deferredPushes() {
		const releases: Array<(result: unknown) => void> = [];
		const exec = vi.fn((command: string) =>
			command.includes("git push")
				? new Promise((resolve) => releases.push(resolve))
				: Promise.resolve({ success: true, stdout: "", stderr: "" }),
		);
		const pushes = () => exec.mock.calls.filter(([command]) => command.includes("git push"));
		return { exec, releases, pushes };
	}

	const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

	it("returns from a tool checkpoint before the upload finishes, and the turn waits for it", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000021");
		await runInDurableObject(agent, async (instance) => {
			const { exec, releases, pushes } = deferredPushes();
			const harness = install(instance, { exec });

			await harness.checkpointSite();
			await settle();
			expect(pushes()).toHaveLength(1);

			let saved = false;
			const final = harness.backupSite({ skipIfUnchanged: true }).then((error) => {
				saved = true;
				return error;
			});
			await settle();
			expect(saved).toBe(false);

			releases[0]!({ success: true, stdout: "abc\n", stderr: "" });
			await expect(final).resolves.toBeUndefined();
			// The upload covered the unchanged generation, so the final save had nothing left.
			expect(pushes()).toHaveLength(1);
			expect(exec).toHaveBeenCalledTimes(3);
		});
	});

	it("sends one upload for checkpoints queued behind a slow one", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000022");
		await runInDurableObject(agent, async (instance) => {
			const { exec, releases, pushes } = deferredPushes();
			let generation = 3;
			const harness = install(instance, { exec }, () => generation);

			await harness.checkpointSite();
			generation += 1;
			await harness.checkpointSite();
			generation += 1;
			await harness.checkpointSite();
			await settle();
			// The later snapshots wait for the upload in flight.
			expect(pushes()).toHaveLength(1);

			releases[0]!({ success: true, stdout: "", stderr: "" });
			await settle();
			// One upload carries the newest snapshot; the middle one is never sent alone.
			expect(pushes()).toHaveLength(2);
			releases[1]!({ success: true, stdout: "", stderr: "" });
			await expect(harness.backupSite({ skipIfUnchanged: true })).resolves.toBeUndefined();
			expect(pushes()).toHaveLength(2);
		});
	});

	it("surfaces a failed background upload as a persistence error", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000024");
		await runInDurableObject(agent, async (instance) => {
			const exec = vi.fn(async (command: string) =>
				command.includes("git push")
					? { success: false, exitCode: 128, stdout: "", stderr: "fatal: 403" }
					: { success: true, stdout: "", stderr: "" },
			);
			const harness = install(instance, { exec });

			await expect(harness.checkpointSite()).resolves.toBeUndefined();
			await settle();

			expect(instance.state.persistenceError).toBe(
				"The latest session checkpoint could not be saved.",
			);
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
			sandboxOps: () => unknown;
			ensureArtifactsRepo: () => Promise<{ remote: string; token: string }>;
			checkpointSite: () => Promise<string | undefined>;
			backupSite: (options?: { quiet?: boolean }) => Promise<string | undefined>;
		};
		harness.sandboxOps = () => ({ exec });
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

	it("pushes from a directory the next checkpoint does not rebuild", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000026");
		await runInDurableObject(agent, async (instance) => {
			const exec = vi.fn(async (_command: string, _options?: { cwd?: string }) => ({
				success: true,
				exitCode: 0,
				stdout: "",
				stderr: "",
			}));
			const harness = setUp(instance, exec);

			await harness.backupSite();

			const push = exec.mock.calls.find(([command]) => String(command).includes("git push"));
			expect(push?.[1]?.cwd).not.toContain("session-snapshot");
		});
	});

	it("keeps a newer checkpoint's failure visible when an older upload succeeds", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000027");
		await runInDurableObject(agent, async (instance) => {
			let releasePush!: (result: unknown) => void;
			let stagings = 0;
			const exec = vi.fn((command: string) => {
				if (command.includes("git push")) {
					return new Promise((resolve) => {
						releasePush = resolve;
					});
				}
				if (command.includes("sqlite3")) {
					stagings += 1;
					// The second checkpoint's staging fails, twice (with its one retry).
					if (stagings >= 2) {
						return Promise.resolve({
							success: false,
							exitCode: 1,
							stdout: "",
							stderr: "disk full",
						});
					}
				}
				return Promise.resolve({ success: true, exitCode: 0, stdout: "", stderr: "" });
			});
			const harness = setUp(instance, exec);

			await harness.checkpointSite();
			await harness.checkpointSite();
			expect(instance.state.persistenceError).toBe(
				"The latest session checkpoint could not be saved.",
			);
			releasePush({ success: true, exitCode: 0, stdout: "", stderr: "" });
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(instance.state.persistenceError).toBe(
				"The latest session checkpoint could not be saved.",
			);
		});
	});
});
