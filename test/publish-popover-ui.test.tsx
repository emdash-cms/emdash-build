// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PublishPanel } from "../src/client/components/PublishPanel.js";
import type { PublishState } from "../src/platform/publish-state.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

it("chooses a named address in a right-anchored popover and keeps publishing after close", async () => {
	const user = userEvent.setup();
	const onPublish = vi.fn();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ namedPublishing: true })),
	);
	function Harness({ state }: { state: PublishState }) {
		const [open, setOpen] = useState(false);
		return (
			<PublishPanel
				projectId="99999999-9999-4999-8999-999999999999"
				open={open}
				onOpenChange={setOpen}
				state={state}
				onPublish={onPublish}
				onSignIn={vi.fn()}
			/>
		);
	}
	const view = render(<Harness state={{ stage: "ready" }} />);
	await user.click(screen.getByRole("button", { name: "Publish" }));
	const input = await screen.findByRole("textbox", { name: "Site address" });
	await user.type(input, "quiet-iceland");
	await user.click(screen.getByRole("button", { name: "Publish site" }));
	expect(onPublish).toHaveBeenCalledWith("quiet-iceland");
	view.rerender(<Harness state={{ stage: "publishing", progress: "Uploading the release…" }} />);
	expect(screen.getByRole("button", { name: "Publishing…" })).toBeTruthy();
	await user.click(screen.getByRole("button", { name: "Close publish panel" }));
	expect(screen.queryByRole("textbox", { name: "Site address" })).toBeNull();
	expect(onPublish).toHaveBeenCalledTimes(1);
});

it("uses the confirmed address from another tab for display, copy and republish", async () => {
	const user = userEvent.setup();
	const onPublish = vi.fn();
	let details = {
		namedPublishing: true,
		slug: "old-choice",
		active: false,
		liveUrl: undefined as string | undefined,
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json(details)),
	);
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<PublishPanel
				projectId="99999999-9999-4999-8999-999999999999"
				open={open}
				onOpenChange={setOpen}
				state={{ stage: "live", liveUrl: "https://s-uuid.build.emdashcms.com" }}
				onPublish={onPublish}
				onSignIn={vi.fn()}
			/>
		);
	}
	const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
	render(<Harness />);
	await user.click(screen.getByRole("button", { name: "Publish" }));
	const input = await screen.findByRole("textbox", { name: "Site address" });
	await user.clear(input);
	await user.type(input, "stale-choice");
	await user.click(screen.getByRole("button", { name: "Close publish panel" }));
	details = {
		namedPublishing: true,
		slug: "quiet-iceland",
		active: true,
		liveUrl: "https://quiet-iceland.em-da.sh",
	};
	await user.click(screen.getByRole("button", { name: "Publish" }));
	const publicLink = await screen.findByRole("link", { name: "quiet-iceland.em-da.sh" });
	expect(publicLink.getAttribute("href")).toBe("https://quiet-iceland.em-da.sh");
	await user.click(screen.getByRole("button", { name: "Copy link" }));
	expect(copy).toHaveBeenCalledWith("https://quiet-iceland.em-da.sh");
	await user.click(screen.getByRole("button", { name: "Publish again" }));
	expect(onPublish).toHaveBeenCalledWith("quiet-iceland");
	copy.mockRestore();
});

it("retries address lookup in place without asking the user to reopen Publish", async () => {
	const user = userEvent.setup();
	let available = false;
	const fetchMock = vi.fn(async () =>
		available
			? Response.json({ namedPublishing: true })
			: Response.json({ error: "raw provider detail" }, { status: 503 }),
	);
	vi.stubGlobal("fetch", fetchMock);
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<PublishPanel
				projectId="99999999-9999-4999-8999-999999999999"
				open={open}
				onOpenChange={setOpen}
				state={{ stage: "ready" }}
				onPublish={vi.fn()}
				onSignIn={vi.fn()}
			/>
		);
	}
	render(<Harness />);
	await user.click(screen.getByRole("button", { name: "Publish" }));

	expect(await screen.findByText("Could not check your site address.")).toBeTruthy();
	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(screen.queryByText(/raw provider detail|close and reopen/i)).toBeNull();
	available = true;
	await user.click(screen.getByRole("button", { name: "Retry" }));

	expect(await screen.findByRole("textbox", { name: "Site address" })).toBeTruthy();
	expect(fetchMock).toHaveBeenCalledTimes(4);
});
