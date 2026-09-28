// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppearance } from "../src/client/appearance.js";

let prefersDark = false;
const mediaListeners = new Set<() => void>();

beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			get matches() {
				return query === "(prefers-color-scheme: dark)" && prefersDark;
			},
			addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
			removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
		})),
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	delete document.documentElement.dataset.mode;
	mediaListeners.clear();
	prefersDark = false;
});

describe("appearance", () => {
	it("follows the system setting until overridden", () => {
		const { result } = renderHook(() => useAppearance());
		expect(result.current.appearance).toBe("system");
		expect(document.documentElement.dataset.mode).toBe("light");

		act(() => {
			prefersDark = true;
			for (const listener of mediaListeners) listener();
		});
		expect(document.documentElement.dataset.mode).toBe("dark");

		act(() => result.current.updateAppearance("light"));
		expect(document.documentElement.dataset.mode).toBe("light");
		expect(localStorage.getItem("emdash-build:appearance")).toBe("light");

		act(() => {
			prefersDark = false;
			for (const listener of mediaListeners) listener();
		});
		expect(document.documentElement.dataset.mode).toBe("light");
	});

	it("restores the saved dark setting", () => {
		localStorage.setItem("emdash-build:appearance", "dark");
		const { result } = renderHook(() => useAppearance());
		expect(result.current.appearance).toBe("dark");
		expect(document.documentElement.dataset.mode).toBe("dark");
	});
});
