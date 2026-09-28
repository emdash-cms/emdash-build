// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/client/components/ErrorBoundary.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

it("keeps React exception details out of the recovery view", () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	function Broken(): never {
		throw new Error("raw internal component secret");
	}

	render(
		<ErrorBoundary>
			<Broken />
		</ErrorBoundary>,
	);

	expect(screen.getByText("Something went wrong rendering this view.")).toBeTruthy();
	expect(screen.getByText("Reload to continue.")).toBeTruthy();
	expect(screen.queryByText(/raw internal component secret/i)).toBeNull();
	expect(log).toHaveBeenCalledWith(
		"[ErrorBoundary]",
		"raw internal component secret",
		"\ncomponentStack:",
		expect.any(String),
	);
});
