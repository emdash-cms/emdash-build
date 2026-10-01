import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CAPACITY_LEASE_TTL_MS,
	capacityLimit,
	type SandboxCapacity,
} from "../src/worker/sandbox-capacity.js";

const testEnv = env as typeof env & {
	SandboxCapacity: DurableObjectNamespace<SandboxCapacity>;
};

/** Run against the global instance with a given cap. */
function withCapacity<T>(limit: number, run: (capacity: SandboxCapacity) => T | Promise<T>) {
	return runInDurableObject(testEnv.SandboxCapacity.getByName("global"), async (instance) => {
		const instanceEnv = Reflect.get(instance, "env") as Record<string, unknown>;
		instanceEnv.SANDBOX_MAX_CONCURRENT = String(limit);
		return run(instance);
	});
}

describe("sandbox capacity", () => {
	beforeEach(async () => {
		await reset();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_000_000);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("grants slots up to the cap, then queues in arrival order", async () => {
		await withCapacity(2, (capacity) => {
			expect(capacity.acquire("a")).toMatchObject({ granted: true });
			expect(capacity.acquire("b")).toMatchObject({ granted: true });
			expect(capacity.acquire("c")).toMatchObject({ granted: false, position: 1 });
			vi.setSystemTime(1_000_001);
			expect(capacity.acquire("d")).toMatchObject({ granted: false, position: 2 });

			// A freed slot goes to the first in line, not to whoever asks next.
			capacity.release("a");
			expect(capacity.acquire("d")).toMatchObject({ granted: false, position: 2 });
			expect(capacity.acquire("c")).toMatchObject({ granted: true });
			expect(capacity.acquire("d")).toMatchObject({ granted: false, position: 1 });
			expect(capacity.stats()).toEqual({ limit: 2, active: 2, waiting: 1 });
		});
	});

	it("extends a held slot instead of taking another", async () => {
		await withCapacity(1, (capacity) => {
			expect(capacity.acquire("a")).toMatchObject({ granted: true });
			expect(capacity.acquire("a")).toMatchObject({ granted: true });
			expect(capacity.renew("a")).toBe(true);
			expect(capacity.stats()).toMatchObject({ active: 1 });
		});
	});

	it("frees a slot whose holder stopped renewing it", async () => {
		await withCapacity(1, (capacity) => {
			capacity.acquire("crashed");
			expect(capacity.acquire("next")).toMatchObject({ granted: false, position: 1 });

			// "next" keeps asking while the lease runs out.
			vi.setSystemTime(1_000_000 + CAPACITY_LEASE_TTL_MS - 30_000);
			expect(capacity.acquire("next")).toMatchObject({ granted: false, position: 1 });
			vi.setSystemTime(1_000_000 + CAPACITY_LEASE_TTL_MS);
			expect(capacity.renew("crashed")).toBe(false);
			expect(capacity.acquire("next")).toMatchObject({ granted: true });
		});
	});

	it("drops a waiter that stopped asking, while those still asking keep their order", async () => {
		await withCapacity(1, (capacity) => {
			capacity.acquire("running");
			capacity.acquire("gone");
			vi.setSystemTime(1_000_001);
			expect(capacity.acquire("waiting")).toMatchObject({ position: 2 });
			vi.setSystemTime(1_000_002);
			expect(capacity.acquire("last")).toMatchObject({ position: 3 });

			// "waiting" and "last" keep asking; "gone" does not.
			for (const at of [30_000, 61_000]) {
				vi.setSystemTime(1_000_000 + at);
				capacity.acquire("waiting");
				capacity.acquire("last");
			}
			expect(capacity.acquire("waiting")).toMatchObject({ position: 1 });
			expect(capacity.acquire("last")).toMatchObject({ position: 2 });
			capacity.release("running");
			expect(capacity.acquire("last")).toMatchObject({ granted: false, position: 2 });
			expect(capacity.acquire("waiting")).toMatchObject({ granted: true });
		});
	});

	it("frees a place in the queue as soon as its holder gives up", async () => {
		await withCapacity(1, (capacity) => {
			capacity.acquire("running");
			capacity.acquire("leaving");
			vi.setSystemTime(1_000_001);
			expect(capacity.acquire("staying")).toMatchObject({ position: 2 });

			capacity.release("leaving");
			expect(capacity.acquire("staying")).toMatchObject({ position: 1 });
		});
	});

	it("reads the cap from SANDBOX_MAX_CONCURRENT", () => {
		expect(capacityLimit("25")).toBe(25);
		expect(capacityLimit(undefined)).toBe(100);
		expect(capacityLimit("0")).toBe(100);
		expect(capacityLimit("ten")).toBe(100);
	});
});
