// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toasty } from "@cloudflare/kumo";
import { ChatPanel } from "../src/client/components/ChatPanel.js";
import { Composer } from "../src/client/components/Composer.js";
import { toasts } from "../src/client/toasts.js";

const bitmap = { width: 4000, height: 2000, close: vi.fn() };
const drawImage = vi.fn();
const PHOTO_URL = "data:image/jpeg;base64,cGhvdG8=";

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"createImageBitmap",
		vi.fn(async () => bitmap),
	);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage,
		fillRect: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(PHOTO_URL);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	drawImage.mockClear();
	sessionStorage.clear();
});

function chat(overrides: Record<string, unknown> = {}) {
	return {
		messages: [],
		isStreaming: false,
		status: "ready",
		sendMessage: vi.fn(async () => {}),
		stop: vi.fn(),
		...overrides,
	} as unknown as React.ComponentProps<typeof ChatPanel>["chat"];
}

const photo = () => new File(["pixels"], "storefront.png", { type: "image/png" });
const pastePhotos = (...files: File[]) =>
	fireEvent.paste(screen.getByRole("textbox", { name: "Message EmDash" }), {
		clipboardData: { files, getData: () => "" },
	});
const sentPhoto = {
	type: "file",
	mediaType: "image/jpeg",
	filename: "storefront.png",
	url: PHOTO_URL,
};

describe("chat composer photos", () => {
	it("sends a downscaled photo with the message and clears it", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		render(<ChatPanel chat={chat({ sendMessage })} />);

		pastePhotos(photo());
		expect(await screen.findByRole("img", { name: "storefront.png" })).toBeTruthy();
		expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1024, 512);

		await user.type(
			screen.getByRole("textbox", { name: "Message EmDash" }),
			"Use this as the hero",
		);
		await user.click(screen.getByRole("button", { name: "Send message" }));
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				id: expect.any(String),
				role: "user",
				parts: [sentPhoto, { type: "text", text: "Use this as the hero" }],
			}),
		);
		expect(screen.queryByRole("img", { name: "storefront.png" })).toBeNull();
	});

	it("selects multiple photos from the file system", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		render(<ChatPanel chat={chat({ sendMessage })} />);
		const picker = screen.getByLabelText("Add photos") as HTMLInputElement;
		const menu = new File(["pixels"], "menu.png", { type: "image/png" });

		expect(picker.accept).toBe("image/*");
		expect(picker.multiple).toBe(true);
		await user.upload(picker, [photo(), menu]);
		expect(await screen.findByRole("img", { name: "storefront.png" })).toBeTruthy();
		expect(screen.getByRole("img", { name: "menu.png" })).toBeTruthy();

		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "Use these photos");
		await user.click(screen.getByRole("button", { name: "Send message" }));
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				parts: [
					sentPhoto,
					{ ...sentPhoto, filename: "menu.png" },
					{ type: "text", text: "Use these photos" },
				],
			}),
		);
	});

	it("adds photos pasted into the composer without pasting their names", async () => {
		render(<ChatPanel chat={chat()} />);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });
		const menu = new File(["pixels"], "menu.png", { type: "image/png" });

		const pasted = fireEvent.paste(composer, {
			clipboardData: { files: [photo(), menu], getData: () => "storefront.png" },
		});

		expect(pasted).toBe(false);
		expect(await screen.findByRole("img", { name: "storefront.png" })).toBeTruthy();
		expect(screen.getByRole("img", { name: "menu.png" })).toBeTruthy();
	});

	it("keeps the text when the clipboard also carries a picture of it", () => {
		render(<ChatPanel chat={chat()} />);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });
		const cells = new File(["pixels"], "image.png", { type: "image/png" });

		const pasted = fireEvent.paste(composer, {
			clipboardData: { files: [cells], getData: () => "Opening hours\tMon–Fri" },
		});

		expect(pasted).toBe(true);
		expect(screen.queryByRole("img", { name: "image.png" })).toBeNull();
	});

	it("does not send while a pasted photo is still being prepared", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		let decoded!: (value: typeof bitmap) => void;
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(() => new Promise<typeof bitmap>((resolve) => (decoded = resolve))),
		);
		render(<ChatPanel chat={chat({ sendMessage })} />);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });

		await user.type(composer, "Use this");
		pastePhotos(photo());
		await user.type(composer, "{Enter}");
		expect(sendMessage).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(
			true,
		);

		await act(async () => decoded(bitmap));
		await user.type(composer, "{Enter}");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ parts: [sentPhoto, { type: "text", text: "Use this" }] }),
		);
	});

	it("keeps queued photos when the chat remounts", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		const streaming = chat({ isStreaming: true, status: "streaming", sendMessage });
		const first = render(<ChatPanel chat={streaming} draftStorageKey="draft" />);

		pastePhotos(photo());
		await screen.findByRole("img", { name: "storefront.png" });
		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "Match this");
		await user.click(screen.getByRole("button", { name: "Queue message" }));
		first.unmount();

		render(<ChatPanel chat={chat({ sendMessage })} draftStorageKey="draft" />);
		await waitFor(() =>
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ parts: [sentPhoto, { type: "text", text: "Match this" }] }),
			),
		);
	});

	it("attaches the images from a mixed file copy", async () => {
		render(<ChatPanel chat={chat()} />);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });
		const brief = new File(["text"], "brief.pdf", { type: "application/pdf" });

		const pasted = fireEvent.paste(composer, {
			clipboardData: { files: [photo(), brief], getData: () => "storefront.png\nbrief.pdf" },
		});

		expect(pasted).toBe(false);
		expect(await screen.findByRole("img", { name: "storefront.png" })).toBeTruthy();
	});

	it("keeps ordinary text paste", () => {
		render(<ChatPanel chat={chat()} />);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });
		expect(
			fireEvent.paste(composer, { clipboardData: { files: [], getData: () => "Hello" } }),
		).toBe(true);
	});

	it("removes a photo before sending", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		render(<ChatPanel chat={chat({ sendMessage })} />);

		pastePhotos(photo());
		await user.click(await screen.findByRole("button", { name: "Remove photo 1" }));
		expect(screen.queryByRole("img", { name: "storefront.png" })).toBeNull();

		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "No photo{Enter}");
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ parts: [{ type: "text", text: "No photo" }] }),
		);
	});

	it("keeps photos with a message queued behind the current turn", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		const view = render(
			<ChatPanel chat={chat({ isStreaming: true, status: "streaming", sendMessage })} />,
		);

		pastePhotos(photo());
		await screen.findByRole("img", { name: "storefront.png" });
		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "Match this");
		await user.click(screen.getByRole("button", { name: "Queue message" }));
		expect(sendMessage).not.toHaveBeenCalled();

		view.rerender(<ChatPanel chat={chat({ sendMessage })} />);
		await waitFor(() =>
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ parts: [sentPhoto, { type: "text", text: "Match this" }] }),
			),
		);
	});

	it("shows photos in sent messages", () => {
		render(
			<ChatPanel
				chat={chat({
					messages: [
						{
							id: "user-1",
							role: "user",
							parts: [sentPhoto, { type: "text", text: "Use this as the hero" }],
						},
					],
				})}
			/>,
		);
		expect(screen.getByRole("img", { name: "storefront.png" }).getAttribute("src")).toBe(PHOTO_URL);
		expect(screen.getByText("Use this as the hero")).toBeTruthy();
	});
});

describe("chat composer dictation", () => {
	const stopTrack = vi.fn();
	const fetch = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) =>
		Response.json({ text: "Add a contact page" }),
	);

	beforeEach(() => {
		stopTrack.mockClear();
		fetch.mockClear();
		vi.stubGlobal("navigator", {
			...navigator,
			mediaDevices: {
				getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
			},
		});
		vi.stubGlobal(
			"MediaRecorder",
			class {
				constructor(readonly stream: MediaStream) {}
				mimeType = "audio/webm";
				ondataavailable?: (event: { data: Blob }) => void;
				onstop?: () => void;
				start() {}
				stop() {
					this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) });
					this.onstop?.();
				}
			},
		);
		vi.stubGlobal("fetch", fetch);
	});

	it("records, transcribes with the server, and appends the transcript", async () => {
		const user = userEvent.setup();
		render(<ChatPanel chat={chat()} />);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });

		await user.type(composer, "Please");
		await user.click(screen.getByRole("button", { name: "Start dictation" }));
		await user.click(await screen.findByRole("button", { name: "Stop dictation" }));

		await waitFor(() =>
			expect((composer as HTMLTextAreaElement).value).toBe("Please Add a contact page"),
		);
		expect(fetch).toHaveBeenCalledWith(
			"/api/transcribe",
			expect.objectContaining({ method: "POST", headers: { "Content-Type": "audio/webm" } }),
		);
		expect(stopTrack).toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Start dictation" })).toBeTruthy();
	});

	it("reports an empty transcript as a toast, not inside the composer", async () => {
		const user = userEvent.setup();
		fetch.mockResolvedValueOnce(Response.json({ text: "" }));
		render(
			<Toasty toastManager={toasts}>
				<ChatPanel chat={chat()} />
			</Toasty>,
		);

		await user.click(screen.getByRole("button", { name: "Start dictation" }));
		await user.click(await screen.findByRole("button", { name: "Stop dictation" }));

		const notice = await screen.findByText("No speech was detected.");
		expect(notice.closest("form")).toBeNull();
	});

	it("retries transcription with the same recording before showing an error", async () => {
		const user = userEvent.setup();
		fetch
			.mockRejectedValueOnce(new TypeError("network lost"))
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(Response.json({ text: "Recovered transcript" }));
		render(<ChatPanel chat={chat()} />);

		await user.click(screen.getByRole("button", { name: "Start dictation" }));
		await user.click(await screen.findByRole("button", { name: "Stop dictation" }));

		await waitFor(() =>
			expect(
				screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message EmDash" }).value,
			).toBe("Recovered transcript"),
		);
		expect(fetch).toHaveBeenCalledTimes(3);
		const bodies = fetch.mock.calls.map((call) => (call[1] as RequestInit).body);
		expect(bodies[1]).toBe(bodies[0]);
		expect(bodies[2]).toBe(bodies[0]);
		expect(document.querySelector("[data-toast-title]")).toBeNull();
	});

	it("retains the recording for a manual retry after automatic attempts fail", async () => {
		const user = userEvent.setup();
		const add = vi.spyOn(toasts, "add");
		fetch
			.mockRejectedValueOnce(new TypeError("network lost"))
			.mockRejectedValueOnce(new TypeError("network lost"))
			.mockRejectedValueOnce(new TypeError("network lost"))
			.mockResolvedValueOnce(Response.json({ text: "Retried transcript" }));
		render(<ChatPanel chat={chat()} />);

		await user.click(screen.getByRole("button", { name: "Start dictation" }));
		await user.click(await screen.findByRole("button", { name: "Stop dictation" }));
		await waitFor(() =>
			expect(add).toHaveBeenCalledWith(
				expect.objectContaining({ title: "Could not transcribe the recording", timeout: 0 }),
			),
		);
		const firstBody = (fetch.mock.calls[0]?.[1] as RequestInit).body;
		const toast = add.mock.calls.at(-1)?.[0] as { actions?: Array<{ onClick?: () => void }> };
		toast.actions?.[0]?.onClick?.();
		await waitFor(() =>
			expect(
				screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message EmDash" }).value,
			).toBe("Retried transcript"),
		);
		expect((fetch.mock.calls[3]?.[1] as RequestInit).body).toBe(firstBody);
		add.mockRestore();
		toasts.close();
	});

	it("releases the microphone if the composer unmounts during the permission prompt", async () => {
		const user = userEvent.setup();
		let grant!: (stream: unknown) => void;
		vi.stubGlobal("navigator", {
			...navigator,
			mediaDevices: { getUserMedia: vi.fn(() => new Promise((resolve) => (grant = resolve))) },
		});
		const view = render(<ChatPanel chat={chat()} />);
		await user.click(screen.getByRole("button", { name: "Start dictation" }));
		view.unmount();

		await act(async () => grant({ getTracks: () => [{ stop: stopTrack }] }));
		expect(stopTrack).toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("can still stop a recording after the composer is disabled", async () => {
		const user = userEvent.setup();
		const props = {
			inputRef: { current: null },
			value: "",
			onValueChange: vi.fn(),
			onKeyDown: vi.fn(),
			photos: [],
			onPhotosChange: vi.fn(),
			placeholder: "Message",
			actions: null,
		};
		const view = render(<Composer {...props} />);
		await user.click(screen.getByRole("button", { name: "Start dictation" }));
		view.rerender(<Composer {...props} disabled />);

		const stop = await screen.findByRole("button", { name: "Stop dictation" });
		expect(stop.hasAttribute("disabled")).toBe(false);
	});
});

describe("chat composer sizing", () => {
	it("re-fits its height when its width changes", async () => {
		const onResize = new Map<Element, () => void>();
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(private readonly callback: () => void) {}
				observe(element: Element) {
					onResize.set(element, this.callback);
				}
				unobserve() {}
				disconnect() {}
			},
		);
		render(<ChatPanel chat={chat()} />);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });

		// Narrowing the panel wraps the draft onto more lines.
		Object.defineProperty(composer, "clientWidth", { configurable: true, value: 320 });
		Object.defineProperty(composer, "scrollHeight", { configurable: true, value: 96 });
		act(() => onResize.get(composer)?.());
		await waitFor(() => expect(composer.style.height).toBe("96px"));
	});
});

describe("chat composer suggestions", () => {
	const featuredProjects = {
		label: "Add featured projects",
		prompt: "Add a featured projects section using the existing project content.",
	};

	it("offers the agent's suggestions once the site is built and fills the composer", async () => {
		const user = userEvent.setup();
		const view = render(<ChatPanel chat={chat()} buildComplete />);
		expect(screen.queryByRole("group", { name: "Suggested next actions" })).toBeNull();

		view.rerender(<ChatPanel chat={chat()} buildComplete suggestions={[featuredProjects]} />);
		const suggestions = screen.getByRole("group", { name: "Suggested next actions" });
		await user.click(within(suggestions).getByRole("button", { name: "Add featured projects" }));

		const composer = screen.getByRole("textbox", { name: "Message EmDash" });
		expect((composer as HTMLTextAreaElement).value).toBe(featuredProjects.prompt);
		expect(document.activeElement).toBe(composer);
		expect(screen.queryByRole("group", { name: "Suggested next actions" })).toBeNull();

		view.rerender(
			<ChatPanel
				chat={chat({ isStreaming: true, status: "streaming" })}
				buildComplete
				suggestions={[featuredProjects]}
			/>,
		);
		await user.clear(composer);
		expect(screen.queryByRole("group", { name: "Suggested next actions" })).toBeNull();
	});

	it("keeps overflowing actions on one hidden-scroll row and supports a mouse wheel", () => {
		render(
			<ChatPanel
				chat={chat()}
				buildComplete
				suggestions={[
					featuredProjects,
					{ label: "Build a project archive", prompt: "Build a project archive." },
					{ label: "Add team profiles", prompt: "Add team profiles." },
					{ label: "Refine the case studies", prompt: "Refine the case studies." },
				]}
			/>,
		);
		const suggestions = screen.getByRole("group", { name: "Suggested next actions" });
		Object.defineProperties(suggestions, {
			clientWidth: { configurable: true, value: 300 },
			scrollWidth: { configurable: true, value: 700 },
			scrollLeft: { configurable: true, value: 0, writable: true },
		});

		const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
		fireEvent(suggestions, wheel);

		expect(suggestions.scrollLeft).toBe(80);
		expect(wheel.defaultPrevented).toBe(true);
		expect(suggestions.className).toContain("overflow-x-auto");
		expect(suggestions.className).toContain("[scrollbar-width:none]");
		for (const button of within(suggestions).getAllByRole("button")) {
			expect(button.className).toContain("whitespace-nowrap");
		}

		suggestions.scrollLeft = 0;
		const lineWheel = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaMode: WheelEvent.DOM_DELTA_LINE,
			deltaY: 3,
		});
		fireEvent(suggestions, lineWheel);
		expect(suggestions.scrollLeft).toBe(72);
		expect(lineWheel.defaultPrevented).toBe(true);

		suggestions.scrollLeft = 400;
		const endWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
		fireEvent(suggestions, endWheel);
		expect(endWheel.defaultPrevented).toBe(false);
	});
});

describe("chat action recovery", () => {
	it("accepts a durably received message without sending it twice", async () => {
		const user = userEvent.setup();
		let messageId = "";
		const sendMessage = vi.fn(async (message: { id?: string }) => {
			messageId = message.id ?? "";
			throw new Error("response dropped");
		});
		const setMessages = vi.fn();
		const clearError = vi.fn();
		const loadRecoveryState = vi.fn(async () => ({
			messages: [
				{ id: messageId, role: "user" as const, parts: [{ type: "text" as const, text: "Hello" }] },
			],
			turnActive: true,
		}));
		render(
			<ChatPanel
				chat={chat({ sendMessage, setMessages, clearError })}
				loadRecoveryState={loadRecoveryState}
			/>,
		);

		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "Hello{Enter}");

		await waitFor(() => expect(loadRecoveryState).toHaveBeenCalledTimes(1));
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(setMessages).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: messageId })]),
		);
		expect(clearError).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(/response dropped/i)).toBeNull();
	});

	it("reconciles a dropped Stop response before offering another action", async () => {
		const user = userEvent.setup();
		const add = vi.spyOn(toasts, "add");
		const loadRecoveryState = vi.fn(async () => ({
			messages: [],
			turnActive: false,
			initialGeneration: { id: "generation-1", status: "stopped" as const },
		}));
		render(
			<ChatPanel
				chat={chat({
					isStreaming: true,
					status: "streaming",
					setMessages: vi.fn(),
					clearError: vi.fn(),
				})}
				initialGeneration={{ id: "generation-1", status: "building" }}
				onStopGeneration={async () => {
					throw new Error("RPC response dropped");
				}}
				loadRecoveryState={loadRecoveryState}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Stop generating" }));

		await waitFor(() => expect(loadRecoveryState).toHaveBeenCalledTimes(1));
		expect(add).not.toHaveBeenCalled();
		expect(screen.queryByText(/RPC response dropped/i)).toBeNull();
		add.mockRestore();
	});

	it("keeps an unresolved message retry available after a later send", async () => {
		const user = userEvent.setup();
		const add = vi.spyOn(toasts, "add");
		const sendMessage = vi
			.fn()
			.mockRejectedValueOnce(new Error("response dropped"))
			.mockResolvedValue(undefined);
		render(
			<ChatPanel
				chat={chat({ sendMessage, setMessages: vi.fn(), clearError: vi.fn() })}
				loadRecoveryState={async () => ({ messages: [], turnActive: false })}
			/>,
		);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });

		await user.type(composer, "First message{Enter}");
		await waitFor(() =>
			expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "Message was not sent" })),
		);
		const firstToast = add.mock.calls.at(-1)?.[0] as {
			actions?: Array<{ onClick?: () => void }>;
		};
		const firstId = (sendMessage.mock.calls[0]?.[0] as { id: string }).id;

		await user.type(composer, "Second message{Enter}");
		await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
		firstToast.actions?.[0]?.onClick?.();
		await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
		expect((sendMessage.mock.calls[2]?.[0] as { id: string }).id).toBe(firstId);
		add.mockRestore();
		toasts.close();
	});

	it("does not surface a recovery after its project has been replaced", async () => {
		const user = userEvent.setup();
		const add = vi.spyOn(toasts, "add");
		let finishRecovery!: (value: { messages: []; turnActive: false }) => void;
		const recovery = new Promise<{ messages: []; turnActive: false }>((resolve) => {
			finishRecovery = resolve;
		});
		const firstChat = chat({
			sendMessage: vi.fn(async () => {
				throw new Error("response dropped");
			}),
			setMessages: vi.fn(),
			clearError: vi.fn(),
		});
		const view = render(
			<ChatPanel
				chat={firstChat}
				draftStorageKey="project-one"
				loadRecoveryState={() => recovery}
			/>,
		);
		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "Old project{Enter}");
		await waitFor(() => expect(firstChat.sendMessage).toHaveBeenCalledTimes(1));

		view.rerender(
			<ChatPanel
				chat={chat()}
				draftStorageKey="project-two"
				loadRecoveryState={async () => ({ messages: [], turnActive: false })}
			/>,
		);
		finishRecovery({ messages: [], turnActive: false });
		await Promise.resolve();
		await Promise.resolve();
		expect(add).not.toHaveBeenCalled();
		add.mockRestore();
	});
});
