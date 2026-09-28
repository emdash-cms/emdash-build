// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConsolePanel } from "../src/client/components/ConsolePanel.js";

afterEach(cleanup);

describe("console ANSI output", () => {
	it("keeps bright 256-colour text legible on the terminal canvas", () => {
		render(<ConsolePanel lines={["\x1b[38;5;231mbright\x1b[0m"]} />);
		const text = screen.getByText("bright");
		const canvas = text.parentElement?.parentElement;

		expect(text.style.color).toBe("rgb(255, 255, 255)");
		expect(canvas?.classList.contains("bg-[#0d1117]")).toBe(true);
	});

	it("does not pull the reader down when new output arrives", () => {
		const view = render(<ConsolePanel lines={["First line"]} />);
		const canvas = screen.getByText("First line").parentElement!;
		Object.defineProperties(canvas, {
			scrollHeight: { configurable: true, value: 500 },
			clientHeight: { configurable: true, value: 100 },
		});
		canvas.scrollTop = 120;
		fireEvent.scroll(canvas);

		view.rerender(<ConsolePanel lines={["First line", "Second line"]} />);
		expect(canvas.scrollTop).toBe(120);

		canvas.scrollTop = 390;
		fireEvent.scroll(canvas);
		view.rerender(<ConsolePanel lines={["First line", "Second line", "Third line"]} />);
		expect(canvas.scrollTop).toBe(500);
	});
});
