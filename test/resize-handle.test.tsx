// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResizeHandle } from "../src/client/components/ResizeHandle.js";

afterEach(cleanup);

describe("ResizeHandle", () => {
	it("exposes the chat width and supports keyboard adjustments", () => {
		const onResize = vi.fn();
		render(
			<ResizeHandle
				direction="horizontal"
				onResize={onResize}
				value={440}
				min={320}
				max={580}
				controls="project-chat"
				label="Chat width"
			/>,
		);
		const handle = screen.getByRole("separator", { name: "Chat width" });
		expect(handle.getAttribute("aria-orientation")).toBe("vertical");
		expect(handle.getAttribute("aria-controls")).toBe("project-chat");
		expect(handle.getAttribute("aria-valuenow")).toBe("440");
		expect(handle.classList.contains("w-2.5")).toBe(true);
		expect(handle.classList.contains("-me-2.5")).toBe(true);
		expect(handle.querySelector("span")?.classList.contains("start-0")).toBe(true);

		fireEvent.keyDown(handle, { key: "ArrowRight" });
		fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
		fireEvent.keyDown(handle, { key: "Home" });
		fireEvent.keyDown(handle, { key: "End" });
		expect(onResize.mock.calls.map(([delta]) => delta)).toEqual([16, -40, -120, 140]);
	});

	it("adjusts the activity height in the expected direction", () => {
		const onResize = vi.fn();
		render(
			<ResizeHandle
				direction="vertical"
				onResize={onResize}
				value={280}
				min={100}
				max={500}
				controls="activity-panel"
				label="Activity height"
			/>,
		);
		const handle = screen.getByRole("separator", { name: "Activity height" });
		expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
		expect(handle.classList.contains("-me-2.5")).toBe(false);
		fireEvent.keyDown(handle, { key: "ArrowUp" });
		fireEvent.keyDown(handle, { key: "ArrowDown", shiftKey: true });
		fireEvent.keyDown(handle, { key: "Home" });
		fireEvent.keyDown(handle, { key: "End" });
		expect(onResize.mock.calls.map(([delta]) => delta)).toEqual([-16, 40, 180, -220]);
	});

	it("restores document and iframe styles after cancel or unmount", () => {
		const frame = document.createElement("iframe");
		frame.style.pointerEvents = "auto";
		document.body.appendChild(frame);
		document.body.style.cursor = "crosshair";
		document.body.style.userSelect = "text";
		const onResize = vi.fn();
		const { unmount } = render(
			<ResizeHandle
				direction="horizontal"
				onResize={onResize}
				value={440}
				min={320}
				max={580}
				controls="project-chat"
				label="Chat width"
			/>,
		);
		const handle = screen.getByRole("separator", { name: "Chat width" });
		fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 });
		expect(document.body.style.cursor).toBe("col-resize");
		expect(document.body.style.userSelect).toBe("none");
		expect(frame.style.pointerEvents).toBe("none");
		fireEvent.pointerMove(handle, { pointerId: 1, clientX: 124 });
		expect(onResize).toHaveBeenCalledWith(24);
		fireEvent.pointerCancel(handle, { pointerId: 1 });
		expect(document.body.style.cursor).toBe("crosshair");
		expect(document.body.style.userSelect).toBe("text");
		expect(frame.style.pointerEvents).toBe("auto");

		fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 124 });
		unmount();
		expect(document.body.style.cursor).toBe("crosshair");
		expect(frame.style.pointerEvents).toBe("auto");
		frame.remove();
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
	});

	it.each(["missing", "throwing"] as const)(
		"continues and ends a drag outside the handle when pointer capture is %s",
		(captureMode) => {
			const frame = document.createElement("iframe");
			frame.style.pointerEvents = "auto";
			document.body.appendChild(frame);
			const onResize = vi.fn();
			const props = {
				direction: "horizontal" as const,
				onResize,
				min: 320,
				max: 580,
				controls: "project-chat",
				label: "Chat width",
			};
			const { unmount, rerender } = render(<ResizeHandle {...props} value={440} />);
			try {
				const handle = screen.getByRole("separator", { name: "Chat width" });
				Object.defineProperty(handle, "setPointerCapture", {
					configurable: true,
					value:
						captureMode === "throwing"
							? () => {
									throw new Error("Pointer capture unavailable");
								}
							: undefined,
				});
				fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 });
				expect(document.body.style.cursor).toBe("col-resize");
				expect(frame.style.pointerEvents).toBe("none");
				fireEvent.pointerMove(document, { pointerId: 1, clientX: 300 });
				expect(onResize).toHaveBeenLastCalledWith(200);
				rerender(<ResizeHandle {...props} value={580} />);
				fireEvent.pointerMove(document, { pointerId: 1, clientX: 250 });
				expect(onResize).toHaveBeenLastCalledWith(10);
				fireEvent.pointerMove(document, { pointerId: 1, clientX: 230 });
				expect(onResize).toHaveBeenLastCalledWith(-10);
				fireEvent.pointerUp(document, { pointerId: 2 });
				expect(document.body.style.cursor).toBe("col-resize");
				fireEvent.pointerUp(document, { pointerId: 1 });
				expect(document.body.style.cursor).toBe("");
				expect(document.body.style.userSelect).toBe("");
				expect(frame.style.pointerEvents).toBe("auto");
				fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 100 });
				expect(document.body.style.cursor).toBe("col-resize");
				fireEvent.pointerCancel(document, { pointerId: 3 });
				expect(document.body.style.cursor).toBe("");
			} finally {
				unmount();
				frame.remove();
			}
		},
	);

	it("does not retreat from the maximum until the pointer crosses the limit", () => {
		const onResize = vi.fn();
		const props = {
			direction: "horizontal" as const,
			onResize,
			min: 320,
			max: 580,
			controls: "project-chat",
			label: "Chat width",
		};
		const { rerender } = render(<ResizeHandle {...props} value={440} />);
		const handle = screen.getByRole("separator", { name: "Chat width" });
		fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 });
		fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300 });
		expect(onResize).toHaveBeenLastCalledWith(200);
		rerender(<ResizeHandle {...props} value={580} />);
		fireEvent.pointerMove(handle, { pointerId: 1, clientX: 250 });
		expect(onResize).toHaveBeenLastCalledWith(10);
		fireEvent.pointerMove(handle, { pointerId: 1, clientX: 230 });
		expect(onResize).toHaveBeenLastCalledWith(-10);
		fireEvent.pointerUp(handle, { pointerId: 1 });
	});

	it("ignores a second drag until the first handle restores shared styles", () => {
		const onChatResize = vi.fn();
		const onActivityResize = vi.fn();
		render(
			<>
				<ResizeHandle
					direction="horizontal"
					onResize={onChatResize}
					value={440}
					min={320}
					max={580}
					controls="project-chat"
					label="Chat width"
				/>
				<ResizeHandle
					direction="vertical"
					onResize={onActivityResize}
					value={280}
					min={100}
					max={500}
					controls="activity-panel"
					label="Activity height"
				/>
			</>,
		);
		const chat = screen.getByRole("separator", { name: "Chat width" });
		const activity = screen.getByRole("separator", { name: "Activity height" });
		fireEvent.pointerDown(chat, { button: 0, pointerId: 1, clientX: 100 });
		fireEvent.pointerDown(activity, { button: 0, pointerId: 2, clientY: 100 });
		fireEvent.pointerMove(activity, { pointerId: 2, clientY: 140 });
		expect(document.body.style.cursor).toBe("col-resize");
		expect(onActivityResize).not.toHaveBeenCalled();
		fireEvent.pointerUp(chat, { pointerId: 1 });
		expect(document.body.style.cursor).toBe("");
		fireEvent.pointerDown(activity, { button: 0, pointerId: 2, clientY: 100 });
		fireEvent.pointerMove(activity, { pointerId: 2, clientY: 140 });
		expect(onActivityResize).toHaveBeenCalledWith(40);
		fireEvent.pointerUp(activity, { pointerId: 2 });
		expect(document.body.style.cursor).toBe("");
	});
});
