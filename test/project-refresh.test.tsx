// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectListRefresh } from "../src/client/use-project-refresh.js";

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
	vi.useFakeTimers();
	visibility = "visible";
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => visibility,
	});
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("recent sites refresh", () => {
	it("polls often while another site is building, slowly otherwise, and not when hidden", () => {
		const refresh = vi.fn();
		const view = renderHook(({ watching }) => useProjectListRefresh(watching, refresh), {
			initialProps: { watching: false },
		});
		vi.advanceTimersByTime(59_000);
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1_000);
		expect(refresh).toHaveBeenCalledTimes(1);

		view.rerender({ watching: true });
		vi.advanceTimersByTime(15_000);
		expect(refresh).toHaveBeenCalledTimes(2);
		visibility = "hidden";
		vi.advanceTimersByTime(120_000);
		expect(refresh).toHaveBeenCalledTimes(2);

		view.rerender({ watching: false });
		visibility = "visible";
		vi.advanceTimersByTime(45_000);
		expect(refresh).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(15_000);
		expect(refresh).toHaveBeenCalledTimes(3);
	});

	it("refreshes once when the tab becomes visible again", () => {
		const refresh = vi.fn();
		renderHook(() => useProjectListRefresh(false, refresh));
		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(refresh).not.toHaveBeenCalled();
		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
