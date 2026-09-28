import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "../src/worker/serial-task-queue.js";

describe("SerialTaskQueue", () => {
	it("runs concurrent submissions one at a time in FIFO order", async () => {
		const queue = new SerialTaskQueue();
		const events: string[] = [];
		let active = 0;
		let maxActive = 0;
		const run = (name: string, delay: number) =>
			queue.run(async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				events.push(`start:${name}`);
				await new Promise((resolve) => setTimeout(resolve, delay));
				events.push(`end:${name}`);
				active--;
				return name;
			});

		await expect(Promise.all([run("a", 5), run("b", 0), run("c", 0)])).resolves.toEqual([
			"a",
			"b",
			"c",
		]);
		expect(maxActive).toBe(1);
		expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
	});

	it("continues after a failed task", async () => {
		const queue = new SerialTaskQueue();
		const failed = queue.run(async () => {
			throw new Error("failed");
		});
		const next = queue.run(async () => "ok");
		await expect(failed).rejects.toThrow("failed");
		await expect(next).resolves.toBe("ok");
	});
});
