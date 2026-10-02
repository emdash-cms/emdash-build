import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent, BuilderState } from "../src/worker/agent.js";
import { NOT_RUNNING, type SandboxOps, type SandboxStart } from "../src/worker/sandbox-ops.js";

const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

type Harness = {
	sandboxOps: () => {
		ensureRunning: () => Promise<SandboxStart>;
		cancelStart: () => Promise<void>;
	};
	waitForSandbox: (signal?: AbortSignal) => Promise<{ ok: boolean; error?: string }>;
	doRecoverSite: (hostname: string) => Promise<{ ready: boolean; error?: string }>;
	state: BuilderState;
};

const queued = (position: number): SandboxStart => ({
	ok: false,
	reason: "capacity",
	position,
	retryAfterMs: 1,
});

describe("waiting for a sandbox slot", () => {
	beforeEach(async () => {
		await reset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows the site's place in the queue until a slot frees up", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000001");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as Harness;
			const seen: Array<{ wait: BuilderState["sandboxWait"]; status?: string }> = [];
			// Unchanged positions are not written again.
			const results = [queued(3), queued(1), { ok: true } as const];
			const cancelStart = vi.fn(async () => {});
			harness.sandboxOps = () => ({
				ensureRunning: async () => {
					seen.push({ wait: harness.state.sandboxWait, status: harness.state.status });
					return results.shift()!;
				},
				cancelStart,
			});
			instance.setState({ ...instance.state, status: "Restoring preview..." });

			await expect(harness.waitForSandbox()).resolves.toEqual({ ok: true });

			expect(seen[1]).toEqual({
				wait: { ahead: 2 },
				status: "Waiting for a free build slot (2 ahead)...",
			});
			expect(seen[2]).toEqual({
				wait: { ahead: 0 },
				status: "Waiting for a free build slot...",
			});
			// A site that got its container has no place in the queue to give up.
			expect(cancelStart).not.toHaveBeenCalled();
			// The queue entry and its status line go once the container runs.
			expect(harness.state.sandboxWait).toBeUndefined();
			expect(harness.state.status).toBe("Restoring preview...");
		});
	});

	it("gives up after the longest wait, and recovery reports it without touching the site", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000002");
		await runInDurableObject(agent, async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(1_000_000);
			const harness = instance as unknown as Harness;
			let calls = 0;
			const cancelStart = vi.fn(async () => {});
			harness.sandboxOps = () => ({
				ensureRunning: async () => {
					calls += 1;
					vi.setSystemTime(1_000_000 + calls * 4 * 60_000);
					return queued(5);
				},
				cancelStart,
			});

			await expect(harness.doRecoverSite("build.example.test")).resolves.toEqual({
				ready: false,
				error: "Every build slot is still busy. Try again in a few minutes.",
			});
			expect(calls).toBe(3);
			// The place in the queue goes to the next site, and the preview says why it stopped.
			expect(cancelStart).toHaveBeenCalledOnce();
			expect(harness.state.sandboxWait).toEqual({ gaveUp: true });
		});
	});

	it("stops waiting on Stop", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000003");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as Harness;
			const controller = new AbortController();
			const cancelStart = vi.fn(async () => {});
			harness.sandboxOps = () => ({
				ensureRunning: async () => ({ ...queued(2), retryAfterMs: 60_000 }),
				cancelStart,
			});

			const waiting = harness.waitForSandbox(controller.signal);
			await new Promise((resolve) => setTimeout(resolve, 10));
			controller.abort();

			await expect(waiting).rejects.toThrow();
			expect(cancelStart).toHaveBeenCalledOnce();
			expect(harness.state.sandboxWait).toBeUndefined();
		});
	});
});

describe("stopping an idle container", () => {
	beforeEach(async () => {
		await reset();
	});

	type StopHarness = {
		prepareSandboxStop: (idleForMs?: number) => Promise<{ busy: boolean }>;
		markSandboxStopped: () => Promise<void>;
		backupSite: (options?: unknown) => Promise<string | undefined>;
		beginOwnerActivity: (id: string, kind: string) => void;
		finishOwnerActivity: (id: string) => void;
		waitForSandbox: () => Promise<{ ok: boolean }>;
		sandboxOps: () => {
			ensureRunning: () => Promise<SandboxStart>;
			cancelStart: () => Promise<void>;
		};
		state: BuilderState;
	};

	it("keeps it while work is under way, and otherwise saves the site first", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000004");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			const harness = instance as unknown as StopHarness;
			const backupSite = vi.fn(async (_options?: unknown) => undefined as string | undefined);
			harness.backupSite = backupSite;

			harness.beginOwnerActivity("chat:1", "chat");
			await expect(harness.prepareSandboxStop(20 * 60_000)).resolves.toEqual({ busy: true });
			expect(backupSite).not.toHaveBeenCalled();
			harness.finishOwnerActivity("chat:1");

			await expect(harness.prepareSandboxStop(20 * 60_000)).resolves.toEqual({ busy: false });
			expect(backupSite).toHaveBeenCalledWith({ quiet: true, skipIfUnchanged: true });
			// The Sandbox may still find the owner back, so only its stop pauses the preview.
			expect(harness.state.sandboxPaused).toBeUndefined();
			await harness.markSandboxStopped();
			expect(harness.state.sandboxPaused).toBe(true);

			// Starting again clears the pause.
			harness.sandboxOps = () => ({
				ensureRunning: async () => ({ ok: true }),
				cancelStart: async () => {},
			});
			await harness.waitForSandbox();
			expect(harness.state.sandboxPaused).toBeUndefined();
		});
	});

	it("keeps it when work starts during the save", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000010");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			const harness = instance as unknown as StopHarness;
			harness.backupSite = async () => {
				// The owner sends a message while the checkpoint uploads.
				harness.beginOwnerActivity("chat:2", "chat");
				return undefined;
			};

			await expect(harness.prepareSandboxStop(20 * 60_000)).resolves.toEqual({ busy: true });
			harness.finishOwnerActivity("chat:2");
		});
	});

	it("runs one stop check at a time, so slow saves do not pile up", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000011");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			const harness = instance as unknown as StopHarness;
			let finish!: () => void;
			const saved = new Promise<undefined>((resolve) => (finish = () => resolve(undefined)));
			const backupSite = vi.fn(async () => saved);
			harness.backupSite = backupSite;

			// An alarm gave up waiting and asks again while the first save still runs.
			const first = harness.prepareSandboxStop(20 * 60_000);
			const second = harness.prepareSandboxStop(21 * 60_000);
			finish();

			await expect(Promise.all([first, second])).resolves.toEqual([
				{ busy: false },
				{ busy: false },
			]);
			expect(backupSite).toHaveBeenCalledOnce();
			// Once it settles, the next check runs afresh.
			await harness.prepareSandboxStop(22 * 60_000);
			expect(backupSite).toHaveBeenCalledTimes(2);
		});
	});

	it("holds it while the save fails, for at most an hour", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000005");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			const harness = instance as unknown as StopHarness;
			harness.backupSite = async () => "The latest session checkpoint could not be saved.";

			await expect(harness.prepareSandboxStop(30 * 60_000)).resolves.toEqual({ busy: true });
			await expect(harness.prepareSandboxStop(61 * 60_000)).resolves.toEqual({ busy: false });

			// A save skipped during the failure cooldown is no save either.
			harness.backupSite = async () => undefined;
			instance.setState({ ...instance.state, persistenceError: "Not saved." });
			await expect(harness.prepareSandboxStop(30 * 60_000)).resolves.toEqual({ busy: true });
		});
	});

	it("keeps a container through a long turn, and makes the next turn recover after a stop", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000008");
		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true });
			const harness = instance as unknown as StopHarness & {
				sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
				provisionPromise: Promise<unknown> | null;
				settledProvision: Promise<unknown> | null;
			};
			harness.backupSite = async () => undefined;
			// This instance is still running a turn that started over an hour ago.
			harness.beginOwnerActivity("chat:long", "chat");
			harness.sql`UPDATE owner_activity SET started_at = ${Date.now() - 2 * 60 * 60_000}`;
			await expect(harness.prepareSandboxStop(20 * 60_000)).resolves.toEqual({ busy: true });
			harness.finishOwnerActivity("chat:long");

			// A provision that finished before the questions were answered.
			const provision = Promise.resolve({ ready: true });
			harness.provisionPromise = provision;
			harness.settledProvision = provision;
			await expect(harness.prepareSandboxStop(20 * 60_000)).resolves.toEqual({ busy: false });
			await harness.markSandboxStopped();
			expect(harness.provisionPromise).toBeNull();
		});
	});

	it("ignores work rows left from long ago, and pauses only a site that exists", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000006");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as StopHarness & {
				sql: <T>(strings: TemplateStringsArray, ...values: unknown[]) => T[];
				ensureOwnerActivityTable: () => void;
			};
			harness.ensureOwnerActivityTable();
			harness.sql`INSERT INTO owner_activity (id, kind, started_at) VALUES ('chat:hung', 'chat', ${Date.now() - 2 * 60 * 60_000})`;

			await expect(harness.prepareSandboxStop(20 * 60_000)).resolves.toEqual({ busy: false });
			await harness.markSandboxStopped();
			expect(harness.state.sandboxPaused).toBeUndefined();
		});
	});
});

describe("tool calls that find the container stopped", () => {
	beforeEach(async () => {
		await reset();
	});

	it("restore the site and report every call that may need redoing, a read included", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000007");
		await runInDurableObject(agent, async (instance) => {
			let running = false;
			const notRunning = () => Promise.reject(new Error(NOT_RUNNING));
			const writeFile = vi.fn(async (_path: string, _content: string) => ({ success: true }));
			const harness = instance as unknown as {
				sandboxOps: () => unknown;
				recoverSite: (hostname: string, reconnect: boolean) => Promise<{ ready: boolean }>;
				toolSandboxOps: () => {
					readFile: (path: string) => Promise<{ success: boolean; content: string }>;
					writeFile: (path: string, content: string) => Promise<{ success: boolean }>;
				};
			};
			harness.sandboxOps = () => ({
				readFile: async () => (running ? { success: true, content: "restored" } : notRunning()),
				writeFile: async (...args: [string, string]) =>
					running ? writeFile(...args) : notRunning(),
			});
			const recoverSite = vi.fn(async () => {
				running = true;
				return { ready: true };
			});
			harness.recoverSite = recoverSite;

			// What it reads now may be older than changes the model was told were saved.
			await expect(harness.toolSandboxOps().readFile("/home/user/site/a.astro")).rejects.toThrow(
				"restored from its last checkpoint",
			);
			expect(recoverSite).toHaveBeenCalledOnce();
			await expect(harness.toolSandboxOps().readFile("/home/user/site/a.astro")).resolves.toEqual({
				success: true,
				content: "restored",
			});

			running = false;
			await expect(
				harness.toolSandboxOps().writeFile("/home/user/site/b.astro", "x"),
			).rejects.toThrow("restored from its last checkpoint");
			// The write is not repeated on its own: earlier steps of the tool may be gone.
			expect(writeFile).not.toHaveBeenCalled();
		});
	});

	it("wait for a restore under way instead of running on the half-restored site", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000008");
		await runInDurableObject(agent, async (instance) => {
			const written: string[] = [];
			let finishRestore!: () => void;
			const harness = instance as unknown as {
				sandboxOps: () => unknown;
				recoveryPromise: Promise<{ ready: boolean }> | null;
				toolSandboxOps: () => {
					writeFile: (path: string, content: string) => Promise<{ success: boolean }>;
				};
			};
			harness.sandboxOps = () => ({
				writeFile: async (path: string) => {
					written.push(path);
					return { success: true };
				},
			});
			// Another tool's call found the container stopped; its restore is still cloning.
			harness.recoveryPromise = new Promise((resolve) => {
				finishRestore = () => resolve({ ready: true });
			});

			const write = harness.toolSandboxOps().writeFile("/home/user/site/b.astro", "x");
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(written).toEqual([]);
			finishRestore();

			await expect(write).resolves.toEqual({ success: true });
			expect(written).toEqual(["/home/user/site/b.astro"]);
		});
	});
});

describe("installing dependencies", () => {
	beforeEach(async () => {
		await reset();
	});

	it("stops an install that outlives its wait instead of following it forever", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000020");
		await runInDurableObject(agent, async (instance) => {
			let endLogs!: () => void;
			const stopped: string[] = [];
			const harness = instance as unknown as {
				sandboxOps: () => unknown;
				installDeps: () => Promise<number>;
			};
			harness.sandboxOps = () => ({
				startProcess: async () => undefined,
				// The output stream lasts as long as the install does.
				followProcessLogs: async () =>
					new ReadableStream<Uint8Array>({
						start(controller) {
							endLogs = () => controller.close();
						},
					}),
				waitForProcessExit: async (id: string) => {
					throw new Error(`Process ${id} did not exit within 300000ms.`);
				},
				stopProcess: async (id: string) => {
					stopped.push(id);
					endLogs();
				},
			});

			await expect(harness.installDeps()).rejects.toThrow("did not exit");
			expect(stopped).toHaveLength(1);
			expect(stopped[0]).toMatch(/^install-/);
		});
	});
});

describe("the tools' view of the Sandbox", () => {
	beforeEach(async () => {
		await reset();
	});

	it("calls the Sandbox's own stub, which has no apply, bind or call", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000030");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as { toolSandboxOps(): SandboxOps };

			// An RPC stub answers every property with a remote method, apply included.
			const exposed = await harness
				.toolSandboxOps()
				.exposePort(4321, { hostname: "localhost:5173", token: "tok" });

			expect(exposed.url).toBe(
				"http://4321-99999999-9999-4999-8999-000000000030-tok.localhost:5173/",
			);
		});
	});
});

describe("the owner's heartbeat", () => {
	beforeEach(async () => {
		await reset();
	});

	it("keeps the Sandbox's container from its idle stop once the site exists", async () => {
		const agent = testEnv.BuilderAgent.getByName("99999999-9999-4999-8999-000000000040");
		await runInDurableObject(agent, async (instance) => {
			const touch = vi.fn(async () => undefined);
			Reflect.set(Reflect.get(instance, "env") as object, "Sandbox", {
				getByName: () => ({ touch }),
			});
			const harness = instance as unknown as { keepSandboxAwake(): Promise<void> };

			await harness.keepSandboxAwake();
			expect(touch).not.toHaveBeenCalled();

			instance.setState({ ...instance.state, siteReady: true });
			await harness.keepSandboxAwake();
			expect(touch).toHaveBeenCalledOnce();
		});
	});
});
