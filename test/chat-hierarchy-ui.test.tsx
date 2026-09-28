// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../src/client/components/ChatPanel.js";
import { BuildDetails } from "../src/client/components/BuildDetails.js";

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function tool(index: number, overrides: Record<string, unknown> = {}) {
	return {
		type: "tool-write_file",
		toolCallId: `write-${index}`,
		state: "output-available",
		input: { path: `src/page-${index}.astro` },
		output: { success: true },
		...overrides,
	};
}

function chat(parts: unknown[], overrides: Record<string, unknown> = {}) {
	return {
		messages: [{ id: "assistant-1", role: "assistant", parts }],
		isStreaming: false,
		status: "ready",
		sendMessage: vi.fn(async () => {}),
		stop: vi.fn(),
		...overrides,
	} as unknown as React.ComponentProps<typeof ChatPanel>["chat"];
}

describe("chat transcript", () => {
	it("keeps protocol-shaped plaintext out of follow-up replies and activity", () => {
		const parts = [
			{
				type: "tool-read_file",
				toolCallId: "read-home",
				state: "output-available",
				input: { path: "src/pages/index.astro" },
				output: { success: true },
			},
			{ type: "text", text: "I’ve verified the current homepage source." },
			{
				type: "text",
				text: '{"path":"src/components/blocks/index.ts","content":"export default {}"}',
			},
			{ type: "reasoning", text: "Checking the resulting layout.", state: "done" },
			{ type: "text", text: "The homepage hero update is ready." },
			{ type: "text", text: "to=functions.settingsupdate code:" },
			{ type: "text", text: '{"socialLinks":[{"platform":"instagram"}]}' },
			{ type: "text", text: "{}" },
			{ type: "text", text: "{}" },
			{ type: "text", text: '{"success":true}' },
			{ type: "text", text: '{"command":"pnpm check"}' },
			{ type: "text", text: '{"query":"iceland","count":5}' },
			{
				type: "text",
				text: '{"tooluses":{"recipientname":"functions.validatesite","parameters":{}}}',
			},
			{
				type: "text",
				text: '{"tooluses":{"recipientname":"functions.validatesite","parameters":',
			},
			{ type: "text", text: '{"path":"src/components/blocks/ind' },
			{ type: "text", text: '{}\n{"success":true}' },
			{
				type: "text",
				text: '{"paths":["src/pages/index.astro","src/layouts/Layout.astro"]}',
			},
			{ type: "text", text: '{"query":"iceland landscape"}' },
		];
		const assistant = chat(parts).messages[0];
		const transcript = render(<ChatPanel chat={chat(parts)} />);

		expect(screen.getByText("The homepage hero update is ready.")).toBeTruthy();
		expect(screen.queryByText(/recipientname/)).toBeNull();
		expect(screen.queryByText(/src\/components\/blocks\/ind/)).toBeNull();
		expect(screen.queryByText(/\{"success":true\}/)).toBeNull();
		expect(screen.queryByText(/src\/layouts\/Layout\.astro/)).toBeNull();
		expect(screen.queryByText(/iceland landscape/)).toBeNull();
		transcript.unmount();

		render(<BuildDetails message={assistant} streaming={false} onClose={vi.fn()} />);
		expect(screen.getByRole("button", { name: "Read file src/pages/index.astro" })).toBeTruthy();
		expect(screen.getByText("I’ve verified the current homepage source.")).toBeTruthy();
		expect(screen.getByText("The homepage hero update is ready.")).toBeTruthy();
		expect(screen.queryAllByText("{}")).toHaveLength(0);
		expect(screen.queryByText(/src\/components\/blocks\/index\.ts/)).toBeNull();
		expect(screen.queryByText(/to=functions\.settingsupdate/)).toBeNull();
		expect(screen.queryByText(/socialLinks/)).toBeNull();
		expect(screen.queryByText('{"success":true}')).toBeNull();
		expect(screen.queryByText(/pnpm check/)).toBeNull();
		expect(screen.queryByText(/iceland/)).toBeNull();
		expect(screen.queryByText(/recipientname/)).toBeNull();
	});

	it("keeps partial protocol envelopes hidden while streaming, replaying, and persisted", () => {
		const prefixes = [
			"{",
			'{"path":"src/components/blocks/ind',
			'{"success":tr',
			'{"command":"pnpm ch',
			'{"files":[{"path":"src/a.ts","content":"x"}',
			'{"images":[{"url":"https://example.com/a.jpg","alt":"A"}',
			'{"success":true,}',
			'{}\n{"success":true}',
			'{"toolu',
			'{"tooluses"',
			'{"tooluses":',
			'{"tooluses":{"recipientname":"functions.validatesite","parameters":',
		];
		const activeParts = (text: string) => [
			{ type: "text", text: "Checking the site now." },
			{ type: "text", text, state: "streaming" },
		];
		const view = render(
			<BuildDetails
				message={chat(activeParts(prefixes[0]!)).messages[0]}
				streaming
				live
				onClose={vi.fn()}
			/>,
		);

		for (const prefix of prefixes) {
			view.rerender(
				<BuildDetails
					message={chat(activeParts(prefix)).messages[0]}
					streaming
					live
					onClose={vi.fn()}
				/>,
			);
			expect(view.container.textContent).not.toContain(prefix);
		}
		view.rerender(<BuildDetails message={chat([]).messages[0]} streaming live onClose={vi.fn()} />);
		expect(view.container.textContent).not.toContain("recipientname");
		view.rerender(
			<BuildDetails
				message={
					chat([
						{ type: "text", text: "Checking the site now." },
						{ type: "text", text: '{"success":true,}', state: "done" },
					]).messages[0]
				}
				streaming={false}
				live={false}
				onClose={vi.fn()}
			/>,
		);
		expect(view.container.textContent).not.toContain("recipientname");
		expect(view.container.textContent).not.toContain("success");
	});

	it("keeps legitimate site JSON visible in replies and activity", () => {
		for (const [json, key, expectedValue] of [
			['{"label":"Pricing","url":"/pricing"}', "label", "Pricing"],
			['{"path":"/journal","title":"Journal"}', "path", "/journal"],
			['{"images":["hero.jpg"]}', "images", "hero.jpg"],
			[
				'{"images":[{"url":"https://example.com/hero.jpg","alt":"Hero"}],"layout":"full"}',
				"images",
				"Hero",
			],
		]) {
			const transcript = render(<ChatPanel chat={chat([{ type: "text", text: json }])} />);
			expect(transcript.container.textContent).toContain(`"${key}"`);
			expect(transcript.container.textContent).toContain(expectedValue);
			transcript.unmount();

			const details = render(
				<BuildDetails
					message={chat([{ type: "text", text: json }]).messages[0]}
					streaming={false}
					onClose={vi.fn()}
				/>,
			);
			expect(details.container.textContent).toContain(`"${key}"`);
			expect(details.container.textContent).toContain(expectedValue);
			details.unmount();
		}
	});

	it("keeps long follow-up prose and fenced JSON visible", () => {
		const longProse = `A detailed explanation that remains useful to the user. ${"More context. ".repeat(160)}`;
		const plainJson = '{"theme":"dark"}';
		const fencedJson = 'Configuration:\n\n```json\n{"theme":"warm"}\n```';
		const fencedProtocol =
			"Protocol example:\n\n````text\n```\nto=functions.validatesite code:\n{}\n````\n\nShown for debugging.";
		const longerFenceLine =
			"Renderer boundary:\n\n```text\n````\nto=functions.readfile code:\n{}\n```\n\nStill debugging.";
		const tildeProtocol = "~~~text\nto=functions.editfile code:\n{}\n~~~";

		render(
			<BuildDetails
				message={
					chat([
						{ type: "text", text: longProse },
						{ type: "text", text: plainJson },
						{ type: "text", text: fencedJson },
						{ type: "text", text: fencedProtocol },
						{ type: "text", text: longerFenceLine },
						{ type: "text", text: tildeProtocol },
					]).messages[0]
				}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByText(/A detailed explanation/).textContent).toContain("More context.");
		expect(screen.getByText('{"theme":"dark"}').tagName).toBe("P");
		expect(screen.getByText('{"theme":"warm"}').tagName).toBe("CODE");
		expect(screen.getByText(/to=functions\.validatesite/).tagName).toBe("CODE");
		expect(screen.getByText(/to=functions\.readfile/).tagName).toBe("CODE");
		expect(screen.queryByText(/to=functions\.editfile/)).toBeNull();
		expect(screen.getByText("Shown for debugging.")).toBeTruthy();
	});

	it("shows every completed action separately across stream boundaries", async () => {
		const user = userEvent.setup();
		const onOpenDetails = vi.fn();
		const view = render(
			<ChatPanel
				onOpenDetails={onOpenDetails}
				chat={chat([
					tool(1),
					{ type: "step-start" },
					tool(2),
					{ type: "step-start" },
					tool(3),
					{ type: "text", text: "Done." },
				])}
			/>,
		);

		expect(view.container.querySelectorAll("[data-tool-state]")).toHaveLength(0);
		await user.click(screen.getByRole("button", { name: "View activity" }));
		expect(onOpenDetails).toHaveBeenCalledWith("assistant-1");
		expect(screen.queryByText(/completed steps/)).toBeNull();
		expect(screen.getByText("Done.")).toBeTruthy();
		view.unmount();
		const detail = render(
			<BuildDetails
				message={
					chat([tool(1), { type: "step-start" }, tool(2), { type: "step-start" }, tool(3)])
						.messages[0]
				}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		expect(
			[...detail.container.querySelectorAll('[data-tool-state="complete"] button')].map((button) =>
				button.textContent?.trim(),
			),
		).toEqual(["Wrotepage-1.astro", "Wrotepage-2.astro", "Wrotepage-3.astro"]);
	});

	it("keeps expanded action details stable as new actions arrive", async () => {
		const user = userEvent.setup();
		const view = render(
			<BuildDetails
				message={chat([tool(1), tool(2)]).messages[0]}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		const expanded = screen.getByRole("button", { name: "Wrote src/page-2.astro" });
		await user.click(expanded);

		view.rerender(
			<BuildDetails
				message={chat([tool(1), tool(2), { type: "step-start" }, tool(3)]).messages[0]}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "Wrote src/page-2.astro" })).toBe(expanded);
		expect(expanded.getAttribute("aria-expanded")).toBe("true");
		expect(screen.queryByText("Input")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Technical details" }));
		expect(screen.getByText("Input")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Wrote src/page-3.astro" })).toBeTruthy();
	});

	it("keeps failures and active actions visible while media expands on demand", async () => {
		const user = userEvent.setup();
		render(
			<BuildDetails
				message={
					chat(
						[
							tool(1),
							tool(2, { state: "output-error", errorText: "Permission denied" }),
							tool(3, {
								type: "tool-upload_media",
								input: { images: [{ url: "https://example.com/image.jpg", alt: "Bread" }] },
							}),
							tool(4, { type: "tool-view_preview", output: { success: true, base64: "eA==" } }),
							tool(5, { state: "input-available" }),
						],
						{ isStreaming: true, status: "streaming" },
					).messages[0]
				}
				streaming
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Wrote src/page-1.astro" })).toBeTruthy();
		const failedButton = screen.getByRole("button", {
			name: "Failed to write file src/page-2.astro",
		});
		expect(screen.getByText("Failed to write file").classList).toContain("text-danger");
		expect(
			failedButton.closest('[data-tool-state="error"]')?.querySelector('span[aria-hidden="true"]'),
		).toBe(null);
		expect(screen.queryByText("Bread")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Added images Bread" }));
		expect(screen.getByText("Bread").closest("li")?.querySelector("img")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Reviewed the preview" }));
		expect(screen.getByRole("img", { name: "Preview screenshot the agent reviewed" })).toBeTruthy();
		expect(screen.getByText("Writing file")).toBeTruthy();
	});

	it("keeps questionnaire calls out of the transcript", () => {
		const question = {
			type: "tool-ask_questions",
			state: "output-available",
			input: { questions: [] },
			output: { success: true },
		};
		render(<ChatPanel chat={chat([question, question, question])} />);
		expect(screen.queryByText(/ask questions/i)).toBeNull();
	});

	it("keeps Stop available while typing or queuing and discards queued changes", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		const stop = vi.fn();
		const onStopGeneration = vi.fn(async () => {});
		const view = render(
			<ChatPanel
				chat={chat([], { isStreaming: true, status: "streaming", sendMessage, stop })}
				onStopGeneration={onStopGeneration}
			/>,
		);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });
		const action = screen.getByRole("button", { name: "Stop generating" });
		expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
		expect(
			screen.getByText("Enter to send after the current response. Shift + Enter for a new line."),
		).toBeTruthy();

		await user.type(composer, "Change the menu");
		expect(screen.getByRole("button", { name: "Queue message" })).toBe(action);
		expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
		await user.click(action);
		expect(screen.getByRole("status").textContent).toContain("Change the menu");
		expect(sendMessage).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(composer);
		expect(screen.getByRole("button", { name: "Message queued" })).toBe(action);
		expect(action.hasAttribute("disabled")).toBe(true);

		await user.click(screen.getByRole("button", { name: "Stop generating" }));
		expect(stop).toHaveBeenCalledOnce();
		expect(onStopGeneration).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(composer);
		view.rerender(<ChatPanel chat={chat([], { sendMessage, stop })} />);
		expect(sendMessage).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Send message" })).toBe(action);
	});

	it("keeps Stop when streaming input is only whitespace", async () => {
		const user = userEvent.setup();
		render(<ChatPanel chat={chat([], { isStreaming: true, status: "streaming" })} />);
		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "   ");
		expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
	});

	it("does not turn a double-click on Queue into Stop", async () => {
		const user = userEvent.setup();
		const stop = vi.fn();
		render(<ChatPanel chat={chat([], { isStreaming: true, status: "streaming", stop })} />);
		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "Change the menu");
		await user.dblClick(screen.getByRole("button", { name: "Queue message" }));

		expect(screen.getByRole("status").textContent).toContain("Change the menu");
		expect(screen.getByRole("button", { name: "Message queued" }).hasAttribute("disabled")).toBe(
			true,
		);
		expect(stop).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy(),
		);
		await user.click(screen.getByRole("button", { name: "Stop generating" }));
		expect(stop).toHaveBeenCalledOnce();
	});

	it("keeps the acknowledgement through the next turn starting", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		const stop = vi.fn();
		const view = render(
			<ChatPanel chat={chat([], { isStreaming: true, status: "streaming", sendMessage, stop })} />,
		);
		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "Change the menu");
		await user.click(screen.getByRole("button", { name: "Queue message" }));
		view.rerender(<ChatPanel chat={chat([], { sendMessage, stop })} />);
		await waitFor(() =>
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ parts: [{ type: "text", text: "Change the menu" }] }),
			),
		);
		view.rerender(
			<ChatPanel chat={chat([], { isStreaming: true, status: "streaming", sendMessage, stop })} />,
		);

		const acknowledgement = screen.getByRole("button", { name: "Message queued" });
		expect(acknowledgement.hasAttribute("disabled")).toBe(true);
		await user.click(acknowledgement);
		expect(stop).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy(),
		);
		await user.click(screen.getByRole("button", { name: "Stop generating" }));
		expect(stop).toHaveBeenCalledOnce();
	});

	it("restores Stop immediately if a queued message is canceled", async () => {
		const user = userEvent.setup();
		render(<ChatPanel chat={chat([], { isStreaming: true, status: "streaming" })} />);
		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "Change the menu");
		await user.click(screen.getByRole("button", { name: "Queue message" }));
		await user.click(screen.getByRole("button", { name: "Cancel queued message" }));
		expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("treats a sent request as busy before its first chunk", async () => {
		const user = userEvent.setup();
		const sent = {
			messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Add a gallery" }] }],
		};
		const submitted = chat([], { ...sent, status: "submitted" });
		const view = render(<ChatPanel chat={submitted} />);
		expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "And a map{Enter}");
		expect(screen.getByRole("button", { name: "Message queued" })).toBeTruthy();
		expect(submitted.sendMessage).not.toHaveBeenCalled();
		view.rerender(<ChatPanel chat={{ ...submitted, status: "ready" }} />);
		await waitFor(() =>
			expect(submitted.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ parts: [{ type: "text", text: "And a map" }] }),
			),
		);
	});

	it("does not let an empty reply hide the next turn's working card", () => {
		const messages = [
			{ id: "user-1", role: "user", parts: [{ type: "text", text: "Build a journal" }] },
			{ id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "Done." }] },
			{ id: "user-2", role: "user", parts: [{ type: "text", text: "Add a map" }] },
			// A server turn that ends without a chunk leaves this on watching tabs.
			{ id: "empty-reply", role: "assistant", parts: [] },
		];
		const view = render(<ChatPanel chat={chat([], { messages })} serverTurnActive />);
		expect(
			screen
				.getByRole("list", { name: "Change progress" })
				.querySelector('[data-phase-state="active"]')?.textContent,
		).toContain("Working on your request");
		expect(view.container.querySelectorAll(".chat-messages-scroll > .mb-3")).toHaveLength(3);
	});

	it("returns focus to the composer after sending", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		render(<ChatPanel chat={chat([], { sendMessage })} />);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });
		await user.type(composer, "Make the header smaller");
		await user.click(screen.getByRole("button", { name: "Send message" }));
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ parts: [{ type: "text", text: "Make the header smaller" }] }),
		);
		expect(document.activeElement).toBe(composer);
	});
});
