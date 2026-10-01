// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_HEARTBEAT_MS, useSandboxHeartbeat } from "../src/client/sandbox-heartbeat.js";

let visibility: DocumentVisibilityState = "visible";
let focused = true;

beforeEach(() => {
	vi.useFakeTimers();
	visibility = "visible";
	focused = true;
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
	vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("sandbox heartbeat", () => {
	it("tells BuilderAgent the owner is here while the builder is seen and in use", () => {
		const call = vi.fn(async () => undefined);
		renderHook(() => useSandboxHeartbeat({ call }));

		vi.advanceTimersByTime(SANDBOX_HEARTBEAT_MS);
		expect(call).toHaveBeenCalledWith("keepSandboxAwake");

		// Another app in front, or the tab hidden: the owner is away.
		focused = false;
		vi.advanceTimersByTime(SANDBOX_HEARTBEAT_MS);
		visibility = "hidden";
		focused = true;
		vi.advanceTimersByTime(SANDBOX_HEARTBEAT_MS);
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("beats more often than the ten-minute idle stop", () => {
		expect(SANDBOX_HEARTBEAT_MS).toBeLessThan(10 * 60_000);
	});
});
