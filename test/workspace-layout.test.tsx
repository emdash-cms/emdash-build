// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACT_WORKSPACE_QUERY, useWorkspacePreview } from "../src/client/workspace-layout.js";

let compact = false;
const listeners = new Set<() => void>();

beforeEach(() => {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			get matches() {
				return query === COMPACT_WORKSPACE_QUERY && compact;
			},
			addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
			removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
		})),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	listeners.clear();
	compact = false;
});

describe("workspace preview layout", () => {
	it("switches to chat-first at the compact breakpoint and restores split view", () => {
		const onCompactChange = vi.fn();
		const { result } = renderHook(() => useWorkspacePreview(onCompactChange));
		expect(result.current.previewCollapsed).toBe(false);
		expect(onCompactChange).not.toHaveBeenCalled();

		act(() => result.current.toggleExpanded());
		expect(result.current.previewExpanded).toBe(true);
		act(() => {
			compact = true;
			for (const listener of listeners) listener();
		});
		expect(result.current.compact).toBe(true);
		expect(onCompactChange).toHaveBeenCalledWith(true);
		expect(result.current.previewCollapsed).toBe(true);
		expect(result.current.previewExpanded).toBe(false);

		act(() => result.current.showPreview());
		expect(result.current.previewCollapsed).toBe(false);
		act(() => result.current.hidePreview());
		expect(result.current.previewCollapsed).toBe(true);

		act(() => {
			compact = false;
			for (const listener of listeners) listener();
		});
		expect(result.current.previewCollapsed).toBe(false);
		expect(result.current.previewExpanded).toBe(false);
		expect(onCompactChange).toHaveBeenLastCalledWith(false);
	});

	it("starts narrow with the chat visible and remembers an opened preview", () => {
		compact = true;
		const { result } = renderHook(() => useWorkspacePreview());
		expect(result.current.previewCollapsed).toBe(true);

		act(() => result.current.showPreview());
		act(() => {
			compact = false;
			for (const listener of listeners) listener();
		});
		act(() => {
			compact = true;
			for (const listener of listeners) listener();
		});
		expect(result.current.previewCollapsed).toBe(false);
	});
});
