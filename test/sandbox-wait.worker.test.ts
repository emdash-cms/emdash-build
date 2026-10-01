import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent, BuilderState } from "../src/worker/agent.js";
import type { SandboxStart } from "../src/worker/sandbox-ops.js";

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
