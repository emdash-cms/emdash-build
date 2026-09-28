// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClarifyingQuestions } from "../src/client/components/ClarifyingQuestions.js";
import { ChatPanel } from "../src/client/components/ChatPanel.js";
import { toasts } from "../src/client/toasts.js";
import type { ClarifyingQuestion } from "../src/shared/questionnaire.js";

const questions: ClarifyingQuestion[] = [
	{
		question: "Which tone fits best?",
		options: ["Editorial", "Playful"],
		allow_custom: true,
	},
	{
		question: "Which pages matter most?",
		options: ["About", "Journal", "Contact"],
		allow_multiple: true,
		allow_custom: true,
	},
	{
		question: "What must visitors remember?",
		allow_custom: true,
	},
];

afterEach(() => {
	cleanup();
	sessionStorage.clear();
});

let reducedMotion = false;

beforeEach(() => {
	reducedMotion = false;
});

beforeAll(() => {
	Object.defineProperty(window, "CSS", {
		configurable: true,
		value: { escape: (value: string) => value },
	});
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches: reducedMotion && query === "(prefers-reduced-motion: reduce)",
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	});
});

function finishQuestionTransition() {
	const outgoing = screen.getByRole("group");
	endAnimation(outgoing);
	const incoming = screen.getByRole("group");
	endAnimation(incoming);
}

function endAnimation(element: Element) {
	// jsdom has no AnimationEvent, so React installs its vendor-prefixed fallback.
	fireEvent(element, new Event("webkitAnimationEnd", { bubbles: true }));
}

function renderQuestions(
	overrides: Partial<React.ComponentProps<typeof ClarifyingQuestions>> = {},
) {
	const onSubmit = vi.fn();
	const onDismiss = vi.fn();
	render(
		<ClarifyingQuestions
			toolCallId="questionnaire-1"
			questions={questions}
			onSubmit={onSubmit}
			onDismiss={onDismiss}
			{...overrides}
		/>,
	);
	return { onSubmit, onDismiss };
}

describe("ClarifyingQuestions", () => {
	it("renders the exact first-step hierarchy with non-submit buttons", () => {
		renderQuestions();

		expect(screen.getByText("Clarifying questions")).toBeTruthy();
		expect(screen.getByText("Answer to help me build what you want.")).toBeTruthy();
		expect(screen.getByText("1/3")).toBeTruthy();
		expect(screen.getByText("Question 1 of 3")).toBeTruthy();
		expect(screen.getByText(questions[0]!.question)).toBe(document.activeElement);
		expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
		expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true);
		for (const button of screen.getAllByRole("button")) {
			expect(button.getAttribute("type")).toBe("button");
		}
	});

	it("keeps space between the progress counter and close action", () => {
		renderQuestions();

		const counter = screen.getByText("1/3");
		const close = screen.getByRole("button", { name: "Skip all questions" });
		expect(counter.parentElement).toBe(close.parentElement);
		expect(counter.parentElement?.classList.contains("gap-2")).toBe(true);
	});

	it("navigates, preserves answers, and keeps custom input exclusive", async () => {
		const user = userEvent.setup();
		renderQuestions();

		await user.click(screen.getByRole("radio", { name: "Editorial" }));
		expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
		await user.click(screen.getByRole("button", { name: "Next" }));
		finishQuestionTransition();
		expect(screen.getByText("2/3")).toBeTruthy();

		await user.click(screen.getByRole("checkbox", { name: "About" }));
		await user.click(screen.getByRole("checkbox", { name: "Journal" }));
		await user.type(screen.getByPlaceholderText("Or add your own answer"), "A press page");
		expect((screen.getByRole("checkbox", { name: "About" }) as HTMLInputElement).checked).toBe(
			false,
		);
		expect((screen.getByRole("checkbox", { name: "Journal" }) as HTMLInputElement).checked).toBe(
			false,
		);

		await user.click(screen.getByRole("button", { name: "Back" }));
		finishQuestionTransition();
		expect((screen.getByRole("radio", { name: "Editorial" }) as HTMLInputElement).checked).toBe(
			true,
		);
		await user.click(screen.getByRole("button", { name: "Skip" }));
		finishQuestionTransition();
		await user.click(screen.getByRole("button", { name: "Back" }));
		finishQuestionTransition();
		expect((screen.getByRole("radio", { name: "Editorial" }) as HTMLInputElement).checked).toBe(
			true,
		);
	});

	it("submits all steps and dismisses through the explicit close control", async () => {
		const user = userEvent.setup();
		const { onSubmit, onDismiss } = renderQuestions();

		await user.click(screen.getByRole("radio", { name: "Editorial" }));
		await user.click(screen.getByRole("button", { name: "Next" }));
		finishQuestionTransition();
		await user.click(screen.getByRole("button", { name: "Skip" }));
		finishQuestionTransition();
		await user.type(screen.getByPlaceholderText("Type your answer"), "Trustworthy");
		await user.click(screen.getByRole("button", { name: "Submit" }));

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit.mock.calls[0]?.[0]).toEqual([
			{ question: questions[0]!.question, selected: ["Editorial"], custom: "" },
			{ question: questions[1]!.question, selected: [], custom: "" },
			{ question: questions[2]!.question, selected: [], custom: "Trustworthy" },
		]);

		await user.click(screen.getByRole("button", { name: "Skip all questions" }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("disables every action while the submission is unavailable", () => {
		renderQuestions({ disabled: true, submitting: true });
		for (const button of screen.getAllByRole("button")) {
			expect(button.hasAttribute("disabled")).toBe(true);
		}
		expect((screen.getByRole("radio", { name: "Editorial" }) as HTMLInputElement).disabled).toBe(
			true,
		);
	});

	it("supports native radio and checkbox keyboard interaction", async () => {
		const user = userEvent.setup();
		renderQuestions();

		const editorial = screen.getByRole("radio", { name: "Editorial" });
		const playful = screen.getByRole("radio", { name: "Playful" }) as HTMLInputElement;
		await user.tab();
		expect(document.activeElement).toBe(editorial);
		await user.keyboard("{ArrowDown}");
		expect(playful.checked).toBe(true);

		screen.getByRole("button", { name: "Next" }).focus();
		await user.keyboard("{Enter}");
		finishQuestionTransition();
		const about = screen.getByRole("checkbox", { name: "About" }) as HTMLInputElement;
		about.focus();
		await user.keyboard(" ");
		expect(about.checked).toBe(true);
	});

	it("runs one outgoing and incoming animation, then settles", async () => {
		const user = userEvent.setup();
		renderQuestions();
		const initial = screen.getByRole("group");
		endAnimation(initial);
		expect(initial.className).not.toContain("questionnaire-question-initial");

		await user.click(screen.getByRole("radio", { name: "Editorial" }));
		await user.click(screen.getByRole("button", { name: "Next" }));
		const outgoing = screen.getByRole("group");
		expect(outgoing.className).toContain("questionnaire-question-exit-forward");
		endAnimation(outgoing);
		const incoming = screen.getByRole("group");
		expect(incoming.className).toContain("questionnaire-question-enter-forward");
		endAnimation(incoming);
		expect(screen.getByRole("group").className).not.toContain("questionnaire-question-enter");
	});

	it("changes questions immediately when reduced motion is requested", async () => {
		reducedMotion = true;
		const user = userEvent.setup();
		renderQuestions();
		await user.click(screen.getByRole("radio", { name: "Editorial" }));
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(screen.getByText("2/3")).toBeTruthy();
	});
});

function askMessage() {
	return {
		id: "assistant-ask",
		role: "assistant" as const,
		parts: [
			{
				type: "tool-ask_questions",
				toolCallId: "ask-1",
				state: "output-available",
				input: {
					questions: [
						{
							question: "Which tone fits best?",
							options: ["Editorial", "Playful"],
							allow_custom: false,
						},
					],
				},
			},
		],
	};
}

function chatStub(
	messages: unknown[],
	overrides: Record<string, unknown> = {},
): React.ComponentProps<typeof ChatPanel>["chat"] {
	return {
		messages,
		status: "ready",
		isStreaming: false,
		error: undefined,
		sendMessage: vi.fn(async () => {}),
		stop: vi.fn(),
		...overrides,
	} as unknown as React.ComponentProps<typeof ChatPanel>["chat"];
}

describe("ChatPanel questionnaire integration", () => {
	it("keeps focus on the current question when the questionnaire opens", async () => {
		render(<ChatPanel chat={chatStub([askMessage()])} />);

		const question = await screen.findByText("Which tone fits best?");
		await waitFor(() => expect(document.activeElement).toBe(question));
	});

	it("mounts outside the composer and submits only once", async () => {
		const user = userEvent.setup();
		const chat = chatStub([askMessage()]);
		render(<ChatPanel chat={chat} />);

		const heading = await screen.findByRole("heading", { name: "Clarifying questions" });
		expect(heading.closest("form")).toBeNull();
		expect(screen.queryByText("ask_questions")).toBeNull();
		await user.click(screen.getByRole("radio", { name: "Editorial" }));
		const submit = screen.getByRole("button", { name: "Submit" });
		await user.click(submit);
		expect(document.activeElement).toBe(
			screen.getByPlaceholderText("Ask EmDash to change the site…"),
		);
		await user.click(submit);
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(chat.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				parts: [
					{
						type: "text",
						text: "Here are my answers:\n\nQ: Which tone fits best?\nA: Editorial",
					},
				],
				metadata: {
					questionnaire: {
						toolCallId: "ask-1",
						answers: [{ question: "Which tone fits best?", selected: ["Editorial"], custom: "" }],
					},
				},
			}),
		);
	});

	it("reconciles a received questionnaire submission without sending it again", async () => {
		const user = userEvent.setup();
		let messageId = "";
		const sendMessage = vi.fn(async (message: { id?: string }) => {
			messageId = message.id ?? "";
			throw new Error("connection lost");
		});
		const setMessages = vi.fn();
		const clearError = vi.fn();
		const loadRecoveryState = vi.fn(async () => ({
			messages: [
				askMessage(),
				{
					id: messageId,
					role: "user" as const,
					parts: [{ type: "text" as const, text: "Answer" }],
				},
			] as never,
			turnActive: true,
		}));
		render(
			<ChatPanel
				chat={chatStub([askMessage()], { sendMessage, setMessages, clearError })}
				loadRecoveryState={loadRecoveryState}
			/>,
		);

		await screen.findByRole("heading", { name: "Clarifying questions" });
		await user.click(screen.getByRole("radio", { name: "Editorial" }));
		await user.click(screen.getByRole("button", { name: "Submit" }));

		await waitFor(() => expect(loadRecoveryState).toHaveBeenCalledTimes(1));
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(setMessages).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: messageId })]),
		);
		expect(clearError).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(/connection lost/i)).toBeNull();
	});

	it("submits an explicit structured skip only once", async () => {
		const user = userEvent.setup();
		const chat = chatStub([askMessage()]);
		render(<ChatPanel chat={chat} />);
		await user.click(await screen.findByRole("button", { name: "Skip all questions" }));
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(chat.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				parts: [
					{
						type: "text",
						text: "I skipped the clarifying questions. Use your recommended defaults and start building.",
					},
				],
				metadata: {
					questionnaire: {
						toolCallId: "ask-1",
						answers: [{ question: "Which tone fits best?", selected: [], custom: "" }],
					},
				},
			}),
		);
	});

	it("retries a confirmed-unsent freeform answer with the same message id", async () => {
		const user = userEvent.setup();
		const add = vi.spyOn(toasts, "add");
		const sendMessage = vi
			.fn()
			.mockRejectedValueOnce(new Error("connection lost"))
			.mockResolvedValueOnce(undefined);
		const chat = chatStub([askMessage()], {
			sendMessage,
			setMessages: vi.fn(),
			clearError: vi.fn(),
		});
		render(
			<ChatPanel
				chat={chat}
				loadRecoveryState={async () => ({ messages: [askMessage()] as never, turnActive: false })}
			/>,
		);

		await screen.findByRole("heading", { name: "Clarifying questions" });
		const composer = screen.getByPlaceholderText("Ask EmDash to change the site…");
		await user.type(composer, "Use a calm editorial style{Enter}");
		await waitFor(() =>
			expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "Message was not sent" })),
		);
		const first = sendMessage.mock.calls[0]![0] as { id: string; parts: unknown[] };
		const toast = add.mock.calls.at(-1)?.[0] as { actions?: Array<{ onClick?: () => void }> };
		toast.actions?.[0]?.onClick?.();
		toast.actions?.[0]?.onClick?.();
		await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
		expect(sendMessage.mock.calls[1]?.[0]).toMatchObject(first);
		add.mockRestore();
		toasts.close();
	});

	it("invalidates an older questionnaire Retry when a replacement is submitted", async () => {
		const user = userEvent.setup();
		const add = vi.spyOn(toasts, "add");
		const sendMessage = vi
			.fn()
			.mockRejectedValueOnce(new Error("connection lost"))
			.mockResolvedValue(undefined);
		render(
			<ChatPanel
				chat={chatStub([askMessage()], {
					sendMessage,
					setMessages: vi.fn(),
					clearError: vi.fn(),
				})}
				loadRecoveryState={async () => ({ messages: [askMessage()] as never, turnActive: false })}
			/>,
		);
		const composer = await screen.findByPlaceholderText("Ask EmDash to change the site…");

		await user.type(composer, "First answer{Enter}");
		await waitFor(() =>
			expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: "Message was not sent" })),
		);
		const oldToast = add.mock.calls.at(-1)?.[0] as { actions?: Array<{ onClick?: () => void }> };
		await user.type(composer, "Replacement answer{Enter}");
		await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
		oldToast.actions?.[0]?.onClick?.();
		await Promise.resolve();
		expect(sendMessage).toHaveBeenCalledTimes(2);
		add.mockRestore();
		toasts.close();
	});

	it("keeps queued-answer transport errors out of the composer", async () => {
		const user = userEvent.setup();
		const sendMessage = vi.fn(async () => {});
		const view = render(
			<ChatPanel chat={chatStub([], { sendMessage, status: "streaming", isStreaming: true })} />,
		);

		await user.type(screen.getByPlaceholderText("Queue a change..."), "Use editorial{Enter}");
		view.rerender(<ChatPanel chat={chatStub([askMessage()], { sendMessage })} />);
		await waitFor(() =>
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ parts: [{ type: "text", text: "Use editorial" }] }),
			),
		);

		view.rerender(
			<ChatPanel
				chat={chatStub(
					[
						askMessage(),
						{ id: "answer", role: "user", parts: [{ type: "text", text: "Use editorial" }] },
					],
					{ sendMessage, status: "error", error: new Error("connection lost") },
				)}
			/>,
		);

		expect(screen.queryByText(/connection lost/i)).toBeNull();
		expect(screen.getByRole("textbox", { name: "Message EmDash" })).toBeTruthy();
	});

	it("offers a safe retry for an inactive incomplete initial build", async () => {
		const user = userEvent.setup();
		const chat = chatStub([
			askMessage(),
			{ id: "answer", role: "user", parts: [{ type: "text", text: "Answer" }] },
			{ id: "holding", role: "assistant", parts: [{ type: "text", text: "Got it." }] },
		]);
		render(<ChatPanel chat={chat} buildStarted buildComplete={false} />);

		expect(await screen.findByText("Answers received, but the build did not finish")).toBeTruthy();
		await user.dblClick(screen.getByRole("button", { name: "Retry build" }));
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(chat.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				parts: [
					{
						type: "text",
						text: "Resume the initial build using my questionnaire answers above. Reuse the existing work; before finishing, run validate_site until it passes, then inspect the final preview.",
					},
				],
			}),
		);
	});

	it("reconciles a received incomplete-build retry without duplicating it", async () => {
		const user = userEvent.setup();
		const messages = [
			askMessage(),
			{ id: "answer", role: "user", parts: [{ type: "text", text: "Answer" }] },
			{ id: "holding", role: "assistant", parts: [{ type: "text", text: "Got it." }] },
		];
		let messageId = "";
		const sendMessage = vi.fn(async (message: { id?: string }) => {
			messageId = message.id ?? "";
			throw new Error("connection lost");
		});
		const setMessages = vi.fn();
		const loadRecoveryState = vi.fn(async () => ({
			messages: [
				...messages,
				{ id: messageId, role: "user" as const, parts: [{ type: "text" as const, text: "Retry" }] },
			] as never,
			turnActive: true,
		}));
		render(
			<ChatPanel
				chat={chatStub(messages, { sendMessage, setMessages, clearError: vi.fn() })}
				buildStarted
				buildComplete={false}
				loadRecoveryState={loadRecoveryState}
			/>,
		);
		await user.click(await screen.findByRole("button", { name: "Retry build" }));
		await waitFor(() => expect(loadRecoveryState).toHaveBeenCalledTimes(1));
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(setMessages).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: messageId })]),
		);
		expect(screen.queryByText(/connection lost/i)).toBeNull();
	});
});

describe("ChatPanel composer", () => {
	it("restores an unsent project draft after the editor auth round trip", async () => {
		const user = userEvent.setup();
		const draftStorageKey = "emdash-build:chat-draft:project";
		const view = render(<ChatPanel chat={chatStub([])} draftStorageKey={draftStorageKey} />);
		await user.type(screen.getByRole("textbox", { name: "Message EmDash" }), "Keep this draft");

		view.unmount();
		render(<ChatPanel chat={chatStub([])} draftStorageKey={draftStorageKey} />);
		expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Message EmDash" }).value).toBe(
			"Keep this draft",
		);
	});

	it("restores and flushes a queued project message after the editor auth round trip", async () => {
		const user = userEvent.setup();
		const draftStorageKey = "emdash-build:chat-draft:project";
		const streaming = chatStub([], { isStreaming: true, status: "streaming" });
		const view = render(<ChatPanel chat={streaming} draftStorageKey={draftStorageKey} />);
		await user.type(
			screen.getByRole("textbox", { name: "Message EmDash" }),
			"Send this next{Enter}",
		);

		view.unmount();
		const resumed = chatStub([]);
		render(<ChatPanel chat={resumed} draftStorageKey={draftStorageKey} />);
		await waitFor(() =>
			expect(resumed.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ parts: [{ type: "text", text: "Send this next" }] }),
			),
		);
	});

	it("omits the redundant build and preview status header", () => {
		render(<ChatPanel chat={chatStub([])} />);

		const transcript = document.querySelector(".chat-messages-scroll");
		expect(screen.queryByText("Build")).toBeNull();
		expect(screen.queryByText("Preview ready")).toBeNull();
		expect(transcript?.parentElement?.firstElementChild).toBe(transcript);
	});

	it("reserves a stable gutter so the scrollbar does not reflow the transcript", () => {
		render(<ChatPanel chat={chatStub([])} />);

		const transcript = document.querySelector(".chat-messages-scroll");
		expect(transcript?.classList.contains("ps-4")).toBe(true);
		expect(transcript?.classList.contains("pe-2")).toBe(true);
		expect(transcript?.classList.contains("[scrollbar-gutter:stable]")).toBe(true);
		expect(transcript?.classList.contains("px-4")).toBe(false);
	});

	it("keeps the compact composer labeled and its keyboard hint available to screen readers", () => {
		render(<ChatPanel chat={chatStub([])} />);

		const composer = screen.getByRole("textbox", { name: "Message EmDash" });
		const hintId = composer.getAttribute("aria-describedby");
		const send = screen.getByRole("button", { name: "Send message" });

		expect(hintId).toBe("chat-composer-hint");
		expect(document.getElementById(hintId!)?.classList.contains("sr-only")).toBe(true);
		expect(send.closest("form")).toBe(composer.closest("form"));
		expect(send.getAttribute("type")).toBe("submit");
	});

	it("inserts a newline with Shift+Enter and sends the complete message with Enter", async () => {
		const user = userEvent.setup();
		const chat = chatStub([]);
		render(<ChatPanel chat={chat} />);
		const composer = screen.getByRole("textbox", { name: "Message EmDash" });

		await user.type(composer, "First line{Shift>}{Enter}{/Shift}Second line");
		expect(chat.sendMessage).not.toHaveBeenCalled();
		expect((composer as HTMLTextAreaElement).value).toBe("First line\nSecond line");

		await user.type(composer, "{Enter}");
		expect(chat.sendMessage).toHaveBeenCalledTimes(1);
		expect(chat.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ parts: [{ type: "text", text: "First line\nSecond line" }] }),
		);
	});

	it("replaces send with an explicit stop action while streaming", async () => {
		const user = userEvent.setup();
		const chat = chatStub([], { isStreaming: true, status: "streaming" });
		render(<ChatPanel chat={chat} />);

		expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
		const stop = screen.getByRole("button", { name: "Stop generating" });
		expect(stop.getAttribute("type")).toBe("button");
		await user.click(stop);
		expect(chat.stop).toHaveBeenCalledTimes(1);
	});
});
