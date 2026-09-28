import { describe, expect, it, vi } from "vitest";
import {
	messageDeliveryStatus,
	readClientRecoveryState,
	stopDeliveryStatus,
} from "../src/shared/client-recovery.js";

const state = (overrides: Record<string, unknown> = {}) => ({
	messages: [],
	turnActive: false,
	...overrides,
});

describe("client recovery", () => {
	it("retries a dropped recovery read without repeating the user action", async () => {
		const load = vi
			.fn()
			.mockRejectedValueOnce(new Error("socket closed"))
			.mockRejectedValueOnce(new Error("still reconnecting"))
			.mockResolvedValue(state({ messages: [{ id: "message-1" }] }));

		await expect(readClientRecoveryState(load, [0, 0])).resolves.toMatchObject({
			messages: [{ id: "message-1" }],
		});
		expect(load).toHaveBeenCalledTimes(3);
	});

	it("leaves an outcome unknown when recovery is still unreachable", async () => {
		const load = vi.fn().mockRejectedValue(new Error("offline"));

		await expect(readClientRecoveryState(load, [0, 0])).resolves.toBeUndefined();
		expect(load).toHaveBeenCalledTimes(3);
	});

	it("distinguishes a durably received message from one that never arrived", () => {
		expect(messageDeliveryStatus(state({ messages: [{ id: "message-1" }] }), "message-1")).toBe(
			"received",
		);
		expect(messageDeliveryStatus(state(), "message-1")).toBe("not-received");
		expect(messageDeliveryStatus(state({ turnActive: true }), "message-1")).toBe("unknown");
		expect(messageDeliveryStatus(undefined, "message-1")).toBe("unknown");
	});

	it("confirms Stop only after the durable turn is inactive", () => {
		expect(stopDeliveryStatus(state({ turnActive: true }), undefined)).toBe("pending");
		expect(
			stopDeliveryStatus(
				state({ initialGeneration: { id: "generation-1", status: "building" } }),
				"generation-1",
			),
		).toBe("pending");
		expect(
			stopDeliveryStatus(
				state({
					turnActive: true,
					initialGeneration: { id: "generation-1", status: "stopped" },
				}),
				"generation-1",
			),
		).toBe("stopped");
		expect(stopDeliveryStatus(state(), undefined)).toBe("stopped");
		expect(stopDeliveryStatus(undefined, undefined)).toBe("unknown");
	});
});
