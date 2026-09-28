import { describe, expect, it, vi } from "vitest";
import { isTransientResponse, retryTransient } from "../src/client/retry.js";

describe("bounded client retries", () => {
	it("retries network failures and transient results only within the supplied bound", async () => {
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("network lost"))
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));

		const response = await retryTransient(operation, isTransientResponse, [0, 0]);

		expect(response.status).toBe(200);
		expect(operation).toHaveBeenCalledTimes(3);
	});

	it("returns validation failures immediately and stops after the final transient attempt", async () => {
		const invalid = vi.fn(async () => new Response(null, { status: 400 }));
		expect((await retryTransient(invalid, isTransientResponse, [0, 0])).status).toBe(400);
		expect(invalid).toHaveBeenCalledTimes(1);

		const unavailable = vi.fn(async () => new Response(null, { status: 503 }));
		expect((await retryTransient(unavailable, isTransientResponse, [0, 0])).status).toBe(503);
		expect(unavailable).toHaveBeenCalledTimes(3);
	});

	it("does not retry an aborted operation", async () => {
		const operation = vi.fn(async () => {
			throw new DOMException("closed", "AbortError");
		});

		await expect(
			retryTransient(operation, isTransientResponse, [0, 0], (error) => {
				return !(error instanceof DOMException && error.name === "AbortError");
			}),
		).rejects.toThrow("closed");
		expect(operation).toHaveBeenCalledTimes(1);
	});
});
