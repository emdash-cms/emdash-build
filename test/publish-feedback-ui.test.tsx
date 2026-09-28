// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloneCard, ExportPanel, type CloneInfo } from "../src/client/components/CloneCard.js";
import { DeployCard } from "../src/client/components/DeployCard.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("clone feedback", () => {
	it("opens Export beside its trigger without moving the workspace and refreshes the link on reopen", async () => {
		const user = userEvent.setup();
		const fetchCloneInfo = vi.fn(async () => ({ ok: true, command: "git clone example" }));
		function Harness() {
			const [open, setOpen] = useState(false);
			return (
				<div data-testid="workspace">
					<button type="button" onClick={() => setOpen(true)}>
						Offer clone
					</button>
					<ExportPanel open={open} onOpenChange={setOpen} fetchCloneInfo={fetchCloneInfo} />
					<div data-testid="preview">Site preview</div>
				</div>
			);
		}
		render(<Harness />);
		expect(fetchCloneInfo).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Export" }));
		const dialog = await screen.findByRole("dialog", { name: "Export site" });
		expect(screen.getByTestId("workspace").contains(dialog)).toBe(false);
		expect(await screen.findByText("git clone example")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Dismiss clone details" }));
		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Export site" })).toBeNull());
		await user.click(screen.getByRole("button", { name: "Offer clone" }));
		expect(await screen.findByText("git clone example")).toBeTruthy();
		expect(fetchCloneInfo).toHaveBeenCalledTimes(2);
	});

	it("refreshes the clone link when Export reopens during its exit animation", async () => {
		const user = userEvent.setup();
		const second = deferred<CloneInfo>();
		const fetchCloneInfo = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, command: "git clone OLD" })
			.mockReturnValueOnce(second.promise);
		function Harness() {
			const [open, setOpen] = useState(false);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Offer clone
					</button>
					<ExportPanel open={open} onOpenChange={setOpen} fetchCloneInfo={fetchCloneInfo} />
				</>
			);
		}
		render(<Harness />);
		await user.click(screen.getByRole("button", { name: "Export" }));
		expect(await screen.findByText("git clone OLD")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Dismiss clone details" }));
		await user.click(screen.getByRole("button", { name: "Offer clone" }));
		await waitFor(() => expect(fetchCloneInfo).toHaveBeenCalledTimes(2));
		expect(screen.queryByText("git clone OLD")).toBeNull();
		second.resolve({ ok: true, command: "git clone NEW" });
		expect(await screen.findByText("git clone NEW")).toBeTruthy();
	});

	it("refreshes an export card that remains mounted while closed", async () => {
		const second = deferred<CloneInfo>();
		const fetchCloneInfo = vi
			.fn()
			.mockResolvedValueOnce({ ok: true, command: "git clone OLD" })
			.mockReturnValueOnce(second.promise);
		const view = render(<CloneCard active fetchCloneInfo={fetchCloneInfo} onDismiss={vi.fn()} />);
		expect(await screen.findByText("git clone OLD")).toBeTruthy();
		view.rerender(<CloneCard active={false} fetchCloneInfo={fetchCloneInfo} onDismiss={vi.fn()} />);
		view.rerender(<CloneCard active fetchCloneInfo={fetchCloneInfo} onDismiss={vi.fn()} />);
		await waitFor(() => expect(fetchCloneInfo).toHaveBeenCalledTimes(2));
		expect(screen.queryByText("git clone OLD")).toBeNull();
		second.resolve({ ok: true, command: "git clone NEW" });
		expect(await screen.findByText("git clone NEW")).toBeTruthy();
	});

	it("keeps the newest clone link when a prior request finishes late", async () => {
		const first = deferred<CloneInfo>();
		const second = deferred<CloneInfo>();
		const view = render(<CloneCard fetchCloneInfo={() => first.promise} onDismiss={vi.fn()} />);
		view.rerender(<CloneCard fetchCloneInfo={() => second.promise} onDismiss={vi.fn()} />);
		second.resolve({ ok: true, command: "git clone NEW" });
		expect(await screen.findByText("git clone NEW")).toBeTruthy();

		first.resolve({ ok: true, command: "git clone OLD" });
		await Promise.resolve();
		expect(screen.getByText("git clone NEW")).toBeTruthy();
		expect(screen.queryByText("git clone OLD")).toBeNull();
	});

	it("shows copy failure without hiding the selectable command", async () => {
		const user = userEvent.setup();
		vi.stubGlobal("navigator", {
			...navigator,
			clipboard: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) },
		});
		render(
			<CloneCard
				fetchCloneInfo={async () => ({ ok: true, command: "git clone example" })}
				onDismiss={vi.fn()}
			/>,
		);
		await user.click(await screen.findByRole("button", { name: "Copy" }));
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"Could not copy. Select the command and copy it.",
		);
		expect(screen.getByText("git clone example")).toBeTruthy();
	});

	it("confirms a successful copy and keeps the command in view", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		render(
			<CloneCard
				fetchCloneInfo={async () => ({ ok: true, command: "git clone example" })}
				onDismiss={vi.fn()}
			/>,
		);
		await user.click(await screen.findByRole("button", { name: "Copy" }));
		expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
		expect(writeText).toHaveBeenCalledWith("git clone example");
	});

	it("does not show a stale success after a later copy fails", async () => {
		const user = userEvent.setup();
		const writeText = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Denied"));
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		render(
			<CloneCard
				fetchCloneInfo={async () => ({ ok: true, command: "git clone example" })}
				onDismiss={vi.fn()}
			/>,
		);
		await user.click(await screen.findByRole("button", { name: "Copy" }));
		await user.click(await screen.findByRole("button", { name: "Copied" }));
		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
	});
});

describe("deployment feedback", () => {
	it("keeps the claim action orange and readable at narrow widths", () => {
		const onDismiss = vi.fn();
		render(
			<DeployCard
				deploy={{
					at: Date.now(),
					claimUrl: "https://example.com/claim",
					liveUrl: "https://example.com/site",
				}}
				onDismiss={onDismiss}
				onClone={vi.fn()}
			/>,
		);
		const claim = screen.getByRole("link", { name: "Claim on Cloudflare" });
		expect(claim.classList.contains("bg-accent")).toBe(true);
		expect(claim.parentElement?.classList.contains("flex-wrap")).toBe(true);
		expect(screen.getByRole("button", { name: "Dismiss deployment details" })).toBeTruthy();
	});

	it("removes the claim action when the claim window expired", () => {
		render(
			<DeployCard
				deploy={{ at: Date.now() - 61 * 60_000, claimUrl: "https://example.com/claim" }}
				onDismiss={vi.fn()}
				onClone={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("link", { name: "Claim on Cloudflare" })).toBeNull();
		expect(screen.getByText("Deploy expired")).toBeTruthy();
	});
});
