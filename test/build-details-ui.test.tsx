// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityImage,
	BuildDetails,
	detailsActivity,
	isTurnActive,
	resolveDetails,
	setupAnswerForDetails,
	setupAnswerSummaryForDetails,
	withoutEmptyReplies,
} from "../src/client/components/BuildDetails.js";
import { ChatPanel } from "../src/client/components/ChatPanel.js";
import { PreviewDetailsStage } from "../src/client/components/PreviewDetailsStage.js";
import {
	initialGenerationForDisplay,
	projectInitialGeneration,
} from "../src/client/initial-generation.js";
import type { InitialGeneration } from "../src/shared/initial-generation.js";

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
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
	Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function chat(messages: unknown[], isStreaming = false) {
	return {
		messages,
		isStreaming,
		status: isStreaming ? "streaming" : "ready",
		sendMessage: vi.fn(async () => {}),
		stop: vi.fn(),
	} as unknown as React.ComponentProps<typeof ChatPanel>["chat"];
}

/** The live row's words while it is open; a folded row keeps its last words but says nothing. */
function openLiveRow(root: { querySelector(selector: string): Element | null } = document) {
	return root.querySelector('[data-live-row][data-open="true"]')?.textContent ?? undefined;
}

const firstMessage = {
	id: "user-1",
	role: "user",
	parts: [{ type: "text", text: "Build my site" }],
};
const buildMessage = {
	id: "assistant-1",
	role: "assistant",
	parts: [
		{ type: "reasoning", text: "Planning the site", state: "done" },
		{ type: "text", text: "Writing the first page." },
		{
			type: "tool-write_file",
			toolCallId: "write-1",
			state: "output-available",
			input: { path: "src/pages/index.astro" },
			output: { success: true },
		},
		{ type: "text", text: "Your site is ready." },
	],
};

function Workspace({
	messages,
	status = "",
	initialGeneration,
	buildDurationMs,
	streaming = Boolean(status),
	chatStatus,
	serverTurnActive = false,
}: {
	messages: unknown[];
	status?: string;
	initialGeneration?: InitialGeneration;
	buildDurationMs?: number;
	streaming?: boolean;
	chatStatus?: "submitted" | "streaming" | "ready";
	serverTurnActive?: boolean;
}) {
	const [detailsId, setDetailsId] = useState<string | null>(null);
	const detailsAnchor = useRef<{ index: number; role: "user" | "assistant" } | null>(null);
	const base = chat(messages, streaming);
	const conversation = chatStatus ? { ...base, status: chatStatus } : base;
	// Mirrors App: details resolve against the list without empty replies.
	const replyMessages = withoutEmptyReplies(conversation.messages, conversation.isStreaming);
	const { message: selected, isLatestTurn } = resolveDetails(
		replyMessages,
		detailsId,
		detailsAnchor.current,
		initialGeneration,
	);
	const activity = detailsActivity({
		turnActive: isTurnActive(conversation, serverTurnActive),
		isStreaming: conversation.isStreaming,
		isLatestTurn,
		message: selected,
		initialGeneration,
		status,
	});
	return (
		<div>
			<ChatPanel
				chat={conversation}
				status={status}
				serverTurnActive={serverTurnActive}
				initialGeneration={initialGeneration}
				buildDurationMs={buildDurationMs}
				onOpenDetails={(messageId) => {
					if (detailsId === messageId || selected?.id === messageId) {
						return;
					}
					const index = replyMessages.findIndex((message) => message.id === messageId);
					const role = replyMessages[index]?.role;
					detailsAnchor.current =
						index >= 0 && (role === "user" || role === "assistant") ? { index, role } : null;
					setDetailsId(messageId);
				}}
				selectedDetailsId={selected?.id ?? detailsId}
			/>
			<div className="relative">
				<PreviewDetailsStage
					details={
						detailsId ? (
							<BuildDetails
								message={selected}
								streaming={activity.streaming}
								live={activity.live}
								status={activity.status}
								onClose={() => {
									detailsAnchor.current = null;
									setDetailsId(null);
								}}
							/>
						) : null
					}
				>
					<iframe title="Site preview" src="about:blank" />
				</PreviewDetailsStage>
			</div>
		</div>
	);
}

const interviewMessage = {
	id: "assistant-interview",
	role: "assistant",
	metadata: { initialGenerationId: "user-1" },
	parts: [
		{ type: "text", text: "A quick design question." },
		{
			type: "tool-ask_questions",
			toolCallId: "ask-1",
			state: "output-available",
			input: {
				questions: [{ question: "Which style?", options: ["Editorial", "Playful"] }],
			},
		},
	],
};
const structuredAnswer = {
	id: "user-answer",
	role: "user",
	metadata: {
		questionnaire: {
			toolCallId: "ask-1",
			answers: [{ question: "Which style?", selected: ["Editorial"], custom: "" }],
		},
	},
	parts: [{ type: "text", text: "Here are my answers:\n\nQ: Which style?\nA: Editorial" }],
};
const holdingMessage = {
	id: "assistant-holding",
	role: "assistant",
	metadata: { initialGenerationId: "user-1" },
	parts: [{ type: "text", text: "I have your direction; setup is finishing." }],
};
const generatedMessage = {
	...buildMessage,
	id: "assistant-build",
	metadata: { initialGenerationId: "user-1" },
};

describe("initial generation activity", () => {
	it("shows stable follow-up phases and a live elapsed timer while work is running", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
		try {
			const request = {
				id: "user-running",
				role: "user",
				parts: [{ type: "text", text: "Polish the layout" }],
			};
			const running = {
				id: "assistant-running",
				role: "assistant",
				parts: [
					{
						type: "tool-write_file",
						toolCallId: "write-done",
						state: "output-available",
						input: { path: "src/pages/index.astro" },
						output: { success: true, changed: true },
					},
					{
						type: "tool-edit_file",
						toolCallId: "edit-running",
						state: "input-available",
						input: { path: "src/styles/global.css" },
					},
				],
			};
			const view = render(
				<Workspace
					messages={[firstMessage, buildMessage, request]}
					streaming={false}
					chatStatus="submitted"
				/>,
			);
			expect(screen.getByLabelText("Elapsed time 0s")).toBeTruthy();
			act(() => vi.advanceTimersByTime(10_000));
			expect(screen.getByLabelText("Elapsed time 10s")).toBeTruthy();

			view.rerender(
				<Workspace
					messages={[firstMessage, buildMessage, request, running]}
					status="Adjusting the layout…"
					streaming
				/>,
			);
			const progress = screen.getByRole("list", { name: "Change progress" });
			expect(within(progress).getByText("Working on your request")).toBeTruthy();
			const activeIcon = progress.querySelector('[data-phase-icon="active"]');
			expect(
				activeIcon?.querySelectorAll("svg")[1]?.classList.contains("motion-safe:animate-spin"),
			).toBe(true);
			expect(within(progress).getByText("Checking the site")).toBeTruthy();
			expect(progress.querySelector('[data-phase-icon="pending"]')?.textContent).toBe("2");
			expect(progress.querySelectorAll('[data-phase-state="active"]')).toHaveLength(1);
			expect(within(progress).queryByText("Wrote")).toBeNull();
			expect(within(progress).queryByText("Editing file")).toBeNull();

			view.rerender(
				<Workspace
					messages={[
						firstMessage,
						buildMessage,
						request,
						{
							...running,
							parts: [
								...running.parts,
								{
									type: "tool-view_preview",
									toolCallId: "review-running",
									state: "input-available",
									input: {},
								},
							],
						},
					]}
					status="Reviewing the preview…"
					streaming
				/>,
			);
			const checking = screen.getByRole("list", { name: "Change progress" });
			expect(within(checking).getByText("Checking the site")).toBeTruthy();
			expect(checking.querySelectorAll('[data-phase-icon="complete"]')).toHaveLength(1);
			expect(checking.querySelectorAll('[data-phase-icon="active"]')).toHaveLength(1);
			expect(
				within(checking)
					.getByText("Working on your request")
					.closest("[data-phase-state]")
					?.getAttribute("data-phase-state"),
			).toBe("complete");
			act(() => vi.advanceTimersByTime(64_000));
			expect(screen.getByLabelText("Elapsed time 1m 14s")).toBeTruthy();
			expect(screen.queryByText("Live")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the observed start time across reloads and tabs", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
		const draftStorageKey = "activity-timer-test";
		const stored = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => stored.get(key) ?? null,
			setItem: (key: string, value: string) => stored.set(key, value),
			removeItem: (key: string) => stored.delete(key),
		});
		try {
			const request = {
				id: "user-running",
				role: "user",
				parts: [{ type: "text", text: "Polish the layout" }],
			};
			const props = {
				chat: { ...chat([firstMessage, buildMessage, request]), status: "submitted" as const },
				draftStorageKey,
			};
			const firstTab = render(<ChatPanel {...props} />);
			expect(screen.getByLabelText("Elapsed time 0s")).toBeTruthy();
			act(() => vi.advanceTimersByTime(10_000));

			const secondTab = render(<ChatPanel {...props} />);
			expect(screen.getAllByLabelText("Elapsed time 10s")).toHaveLength(2);
			firstTab.unmount();
			secondTab.unmount();

			render(<ChatPanel {...props} />);
			expect(screen.getByLabelText("Elapsed time 10s")).toBeTruthy();
		} finally {
			stored.delete(`${draftStorageKey}:activity-start:turn:user-running`);
			vi.useRealTimers();
		}
	});

	it("returns to making changes when an edit follows a preview review", () => {
		const request = {
			id: "user-edit-after-review",
			role: "user",
			parts: [{ type: "text", text: "Polish the layout" }],
		};
		const reply = {
			id: "assistant-edit-after-review",
			role: "assistant",
			parts: [
				{ type: "tool-view_preview", toolCallId: "preview-1", state: "output-available" },
				{ type: "tool-edit_file", toolCallId: "edit-2", state: "input-available" },
			],
		};
		render(
			<Workspace
				messages={[firstMessage, buildMessage, request, reply]}
				status="Reviewing the preview…"
			/>,
		);
		const progress = screen.getByRole("list", { name: "Change progress" });
		expect(
			within(progress)
				.getByText("Working on your request")
				.closest("li")
				?.getAttribute("data-phase-state"),
		).toBe("active");
		expect(
			within(progress)
				.getByText("Checking the site")
				.closest("li")
				?.getAttribute("data-phase-state"),
		).toBe("pending");
	});

	it("does not claim an edit happened when review comes first", () => {
		const request = {
			id: "user-review-first",
			role: "user",
			parts: [{ type: "text", text: "Adjust this page" }],
		};
		const review = {
			id: "assistant-review-first",
			role: "assistant",
			parts: [{ type: "tool-view_preview", toolCallId: "preview-1", state: "output-available" }],
		};
		const view = render(
			<Workspace messages={[firstMessage, buildMessage, request, review]} status="Reviewing…" />,
		);
		const progress = screen.getByRole("list", { name: "Change progress" });
		expect(within(progress).getByText("Working on your request")).toBeTruthy();
		expect(
			within(progress)
				.getByText("Checking the site")
				.closest("li")
				?.getAttribute("data-phase-state"),
		).toBe("active");
		expect(within(progress).queryByText("Making your changes")).toBeNull();

		view.rerender(
			<Workspace
				messages={[
					firstMessage,
					buildMessage,
					request,
					{
						...review,
						parts: [
							...review.parts,
							{ type: "tool-read_file", toolCallId: "read-2", state: "input-available" },
						],
					},
				]}
				status="Reviewing…"
			/>,
		);
		expect(
			within(progress)
				.getByText("Working on your request")
				.closest("li")
				?.getAttribute("data-phase-state"),
		).toBe("active");
	});

	it("keeps stopped tools out of the initial build phases when retrying", () => {
		const stoppedAttempt = {
			id: "assistant-build-1",
			role: "assistant",
			metadata: { initialGenerationId: "user-1" },
			parts: [
				{
					type: "tool-write_file",
					toolCallId: "old-write",
					state: "input-available",
					input: { path: "src/pages/old.astro" },
				},
			],
		};
		const retry = {
			id: "user-retry",
			role: "user",
			parts: [{ type: "text", text: "Retry the initial build." }],
		};
		render(
			<Workspace
				messages={[firstMessage, stoppedAttempt, retry]}
				initialGeneration={{ id: "user-1", status: "building" }}
			/>,
		);
		const progress = screen.getByRole("list", { name: "Build progress" });
		expect(within(progress).getByText("Direction confirmed")).toBeTruthy();
		expect(within(progress).getByText("Building content and pages")).toBeTruthy();
		expect(progress.querySelectorAll('[data-phase-icon="active"]')).toHaveLength(1);
		expect(within(progress).getByText("Reviewing the site")).toBeTruthy();
		expect(progress.querySelectorAll('[data-phase-state="active"]')).toHaveLength(1);
		expect(progress.textContent).not.toContain("old.astro");
	});

	it("moves the initial card through three deterministic phases", () => {
		const view = render(
			<Workspace
				messages={[firstMessage]}
				initialGeneration={{ id: "user-1", status: "preparing" }}
			/>,
		);
		const progress = () => screen.getByRole("list", { name: "Build progress" });
		expect(within(progress()).getByText("Confirming your direction")).toBeTruthy();
		expect(progress().querySelector('[data-phase-icon="pending"]')?.textContent).toBe("2");
		expect(progress().querySelectorAll('[data-phase-state="active"]')).toHaveLength(1);

		view.rerender(
			<Workspace
				messages={[firstMessage, generatedMessage]}
				initialGeneration={{ id: "user-1", status: "building" }}
			/>,
		);
		expect(within(progress()).getByText("Direction confirmed")).toBeTruthy();
		expect(within(progress()).getByText("Building content and pages")).toBeTruthy();
		expect(progress().querySelectorAll('[data-phase-icon="complete"]')).toHaveLength(1);
		const buildIcon = progress().querySelector('[data-phase-state="active"] [data-phase-icon]');

		view.rerender(
			<Workspace
				messages={[firstMessage, generatedMessage]}
				initialGeneration={{ id: "user-1", status: "checking" }}
			/>,
		);
		expect(within(progress()).getByText("Content and pages built")).toBeTruthy();
		expect(within(progress()).getByText("Reviewing the site")).toBeTruthy();
		expect(progress().querySelector('[data-phase-state="complete"] + li [data-phase-icon]')).toBe(
			buildIcon,
		);
		expect(progress().querySelectorAll('[data-phase-icon="complete"]')).toHaveLength(2);
		expect(
			progress().querySelectorAll('[data-phase-icon="complete"] .bg-success svg'),
		).toHaveLength(2);
		expect(progress().querySelectorAll('[data-phase-state="active"]')).toHaveLength(1);
	});

	it("shows an X only for a failed initial build", () => {
		render(
			<Workspace
				messages={[firstMessage, generatedMessage]}
				initialGeneration={{ id: "user-1", status: "failed" }}
			/>,
		);
		const progress = screen.getByRole("list", { name: "Build progress" });
		expect(within(progress).getByText("Couldn’t finish the build")).toBeTruthy();
		expect(progress.querySelectorAll('[data-phase-icon="failed"]')).toHaveLength(1);
		expect(progress.querySelector('[data-phase-icon="failed"] .bg-danger svg')).toBeTruthy();
		expect(progress.querySelectorAll('[data-phase-icon="active"]')).toHaveLength(0);
	});

	it("uses a compact completed update card for follow-up work", () => {
		render(<Workspace messages={[firstMessage, buildMessage]} />);
		expect(screen.getByText("Update complete")).toBeTruthy();
		expect(screen.queryByRole("list", { name: "Change progress" })).toBeNull();
		expect(screen.queryByText("Your site is ready")).toBeNull();
	});

	it("keeps the full completion in details and shows saved build time on the card", async () => {
		const user = userEvent.setup();
		const summary = "Created editable projects and pages for your site. ".repeat(18);
		const message = {
			id: "assistant-long-completion",
			role: "assistant",
			metadata: { initialGenerationId: "user-1" },
			parts: [
				{ type: "tool-view_preview", state: "output-available", output: { success: true } },
				{ type: "text", text: summary },
			],
		};
		render(
			<Workspace
				messages={[firstMessage, message]}
				initialGeneration={{ id: "user-1", status: "ready" }}
				buildDurationMs={432_465}
			/>,
		);
		expect(screen.getByText("Built in 7m 12s")).toBeTruthy();
		expect(screen.queryByText(summary)).toBeNull();
		expect(screen.queryByText(/steps in the timeline/)).toBeNull();
		await user.click(screen.getByRole("button", { name: "View activity" }));
		const details = screen.getByRole("region", { name: "Build activity" });
		expect(within(details).getByText("Build summary")).toBeTruthy();
		expect(details.textContent).toContain(summary.trim());
	});
	it("omits leaked tool syntax and its adjacent JSON from completed activity", async () => {
		const user = userEvent.setup();
		const argumentsOnly = '{"socialLinks":[{"platform":"instagram"}]}';
		const message = {
			id: "assistant-complete",
			role: "assistant",
			metadata: { initialGenerationId: "user-1" },
			parts: [
				{ type: "tool-view_preview", state: "output-available", output: { success: true } },
				{ type: "text", text: "Your site is ready." },
				{ type: "text", text: "to=functions.settingsupdate code:" },
				{ type: "text", text: argumentsOnly },
			],
		};
		render(
			<Workspace
				messages={[firstMessage, message]}
				initialGeneration={{ id: "user-1", status: "ready" }}
			/>,
		);
		expect(screen.queryByText("Your site is ready.")).toBeNull();
		expect(screen.queryByText(/to=functions\.editfile/)).toBeNull();
		await user.click(screen.getByRole("button", { name: "View activity" }));
		expect(screen.getByText("Build summary")).toBeTruthy();
		expect(screen.getAllByText("Your site is ready.")).toHaveLength(1);
		expect(screen.queryByText("Verbose build notes")).toBeNull();
		expect(screen.queryByText(/to=functions\.settingsupdate/)).toBeNull();
		expect(screen.queryByText(argumentsOnly)).toBeNull();
	});

	it("omits settled long internal prose while keeping the real build plan visible", () => {
		const verbose = ".home-hero { padding: 3rem; }\n".repeat(100);
		render(
			<BuildDetails
				message={
					chat([
						{
							id: "user-1",
							role: "assistant",
							metadata: { initialGenerationStatus: "building" },
							parts: [
								{ type: "text", text: "Building the homepage." },
								{ type: "text", text: verbose },
							],
						},
					]).messages[0]
				}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByText("Building the homepage.")).toBeTruthy();
		expect(screen.queryByText("Verbose build notes")).toBeNull();
		expect(document.querySelector(".build-details")?.textContent).not.toContain(".home-hero");
	});

	it("presents repaired source and validation failures as recovered", async () => {
		const user = userEvent.setup();
		const failedAudit = {
			success: false,
			issues: [{ path: "/", reason: "http-status", status: 500 }],
			checkedPaths: [],
		};
		render(
			<BuildDetails
				message={
					chat([
						{
							id: "assistant-repaired",
							role: "assistant",
							metadata: { initialGenerationStatus: "ready" },
							parts: [
								{
									type: "tool-write_files",
									toolCallId: "write-failed",
									state: "output-available",
									input: { files: [{ path: "src/pages/menu.astro", content: "menu" }] },
									output: { success: false, changed: false, error: "File not found" },
								},
								{
									type: "tool-write_file",
									toolCallId: "single-write-failed",
									state: "output-available",
									input: { path: "src/pages/index.astro", content: "page" },
									output: { success: false, changed: false, error: "File not found" },
								},
								{
									type: "tool-validate_site",
									toolCallId: "validate-failed",
									state: "output-available",
									output: { success: false, publicSiteAudit: failedAudit },
								},
								{
									type: "tool-edit_file",
									toolCallId: "repair",
									state: "output-available",
									input: { path: "src/pages/index.astro" },
									output: { success: true, changed: true },
								},
								{
									type: "tool-validate_site",
									toolCallId: "validate-passed",
									state: "output-available",
									output: {
										success: true,
										publicSiteAudit: { success: true, checkedPaths: ["/"], issues: [] },
									},
								},
								{ type: "text", text: "Your site is ready." },
							],
						},
					]).messages[0]
				}
				streaming={false}
				live={false}
				onClose={vi.fn()}
			/>,
		);

		const corrected = screen.getByRole("button", { name: "File update corrected · 1 file" });
		const correctedSingle = screen.getByRole("button", {
			name: "File update corrected · src/pages/index.astro",
		});
		const fixed = screen.getByRole("button", { name: "Fixed a site issue" });
		expect(corrected.closest('[data-tool-state="complete"]')).toBeTruthy();
		expect(correctedSingle.closest('[data-tool-state="complete"]')).toBeTruthy();
		expect(fixed.closest('[data-tool-state="complete"]')).toBeTruthy();
		expect(screen.queryByText("Up to date")).toBeNull();
		expect(screen.queryByRole("button", { name: /Failed to write files/ })).toBeNull();
		expect(screen.queryByRole("button", { name: "Site validation failed" })).toBeNull();
		await user.click(corrected);
		expect(screen.queryByText("File not found")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Technical details" }));
		expect(screen.getByText(/File not found/)).toBeTruthy();
		await user.click(fixed);
		expect(screen.getByText("A later validation passed.")).toBeTruthy();
	});

	it("does not relabel a stopped attempt's historical failure as recovering", () => {
		render(
			<BuildDetails
				message={
					chat([
						{
							id: "assistant-retry",
							role: "assistant",
							metadata: { initialGenerationStatus: "building", liveFromPart: 1 },
							parts: [
								{
									type: "tool-validate_site",
									toolCallId: "old-validation",
									state: "output-available",
									output: { success: false },
								},
								{ type: "reasoning", text: "Retrying the build", state: "streaming" },
							],
						},
					]).messages[0]
				}
				streaming
				live
				onClose={vi.fn()}
			/>,
		);

		const oldFailure = screen.getByRole("button", { name: "Site validation failed" });
		expect(oldFailure.closest('[data-tool-state="error"]')).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Found a site issue · fixing" })).toBeNull();
	});

	it("settles interrupted validation attempts after a later pass", async () => {
		const user = userEvent.setup();
		render(
			<BuildDetails
				message={
					chat([
						{
							id: "assistant-validation-transport",
							role: "assistant",
							metadata: { initialGenerationStatus: "ready" },
							parts: [
								{
									type: "tool-validate_site",
									toolCallId: "timed-out",
									state: "output-error",
									errorText: "Timed out",
								},
								{
									type: "tool-validate_site",
									toolCallId: "retryable",
									state: "output-available",
									output: { success: false, retryable: true, error: "The site is still changing" },
								},
								{
									type: "tool-validate_site",
									toolCallId: "passed",
									state: "output-available",
									output: {
										success: true,
										publicSiteAudit: { success: true, checkedPaths: ["/"], issues: [] },
									},
								},
							],
						},
					]).messages[0]
				}
				streaming={false}
				live={false}
				onClose={vi.fn()}
			/>,
		);

		const retries = screen.getAllByRole("button", { name: "Validation retry succeeded" });
		expect(retries).toHaveLength(2);
		expect(screen.queryByRole("button", { name: "Fixed a site issue" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Site validation failed" })).toBeNull();
		await user.click(retries[0]!);
		expect(screen.getByText("A later validation completed successfully.")).toBeTruthy();
		expect(screen.queryByText("Timed out")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Technical details" }));
		expect(screen.getByText(/Timed out/)).toBeTruthy();
	});

	it("settles preview connection failures after a later successful review", async () => {
		const user = userEvent.setup();
		render(
			<BuildDetails
				message={
					chat([
						{
							id: "assistant-preview-retry",
							role: "assistant",
							metadata: { initialGenerationStatus: "ready" },
							parts: [
								{
									type: "tool-view_preview",
									toolCallId: "preview-failed",
									state: "output-available",
									output: { success: false, error: "Connection refused" },
								},
								{
									type: "tool-view_preview",
									toolCallId: "preview-passed",
									state: "output-available",
									output: { success: true, shotId: "shot-1" },
								},
							],
						},
					]).messages[0]
				}
				streaming={false}
				live={false}
				onClose={vi.fn()}
			/>,
		);

		const retry = screen.getByRole("button", { name: "Preview retry succeeded" });
		expect(retry.closest('[data-tool-state="complete"]')).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Preview review failed" })).toBeNull();
		await user.click(retry);
		expect(screen.queryByText("Connection refused")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Technical details" }));
		expect(screen.getByText(/Connection refused/)).toBeTruthy();
	});

	it("uses retrying copy for current validation and preview interruptions", () => {
		render(
			<BuildDetails
				message={
					chat([
						{
							id: "assistant-interrupted-tools",
							role: "assistant",
							metadata: { initialGenerationStatus: "building" },
							parts: [
								{
									type: "tool-validate_site",
									toolCallId: "validation-interrupted",
									state: "output-error",
									errorText: "Timed out",
								},
								{
									type: "tool-view_preview",
									toolCallId: "preview-interrupted",
									state: "output-available",
									output: { success: false, error: "Connection refused" },
								},
							],
						},
					]).messages[0]
				}
				streaming
				live
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Validation interrupted · retrying" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Preview interrupted · retrying" })).toBeTruthy();
		expect(document.querySelector('[data-tool-state="error"]')).toBeNull();
	});

	it("keeps ambiguous, post-validation, and non-source failures terminal", () => {
		render(
			<BuildDetails
				message={
					chat([
						{
							id: "assistant-terminal",
							role: "assistant",
							metadata: { initialGenerationStatus: "ready" },
							parts: [
								{
									type: "tool-write_files",
									toolCallId: "skipped-write",
									state: "output-available",
									input: { files: [{ path: "src/pages/menu.astro", content: "menu" }] },
									output: { success: false, changed: false, error: "File not found" },
								},
								{
									type: "tool-write_files",
									toolCallId: "ambiguous-write",
									state: "output-available",
									input: { files: [{ path: "src/pages/index.astro", content: "page" }] },
									output: { success: false, changed: true, error: "Checkpoint failed" },
								},
								{
									type: "tool-validate_site",
									toolCallId: "validate-passed",
									state: "output-available",
									output: {
										success: true,
										publicSiteAudit: { success: true, checkedPaths: ["/"], issues: [] },
									},
								},
								{
									type: "tool-edit_files",
									toolCallId: "late-edit",
									state: "output-available",
									input: { edits: [{ path: "src/pages/index.astro" }] },
									output: { success: false, changed: false, error: "Exact text not found" },
								},
								{
									type: "tool-content_update",
									toolCallId: "cms-failed",
									state: "output-available",
									input: { collection: "pages", id: "home" },
									output: { success: false, error: "Conflict" },
								},
							],
						},
					]).messages[0]
				}
				streaming={false}
				live={false}
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getAllByRole("button", { name: /Failed to write files/ })).toHaveLength(2);
		expect(screen.getByRole("button", { name: /Failed to edit files/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Failed to update Home page" })).toBeTruthy();
		expect(document.querySelectorAll('[data-tool-state="error"]')).toHaveLength(4);
	});

	it("uses neutral correction copy while a correctable failure is still being repaired", () => {
		render(
			<BuildDetails
				message={
					chat([
						{
							id: "assistant-recovering",
							role: "assistant",
							metadata: { initialGenerationStatus: "building" },
							parts: [
								{
									type: "tool-write_files",
									toolCallId: "write-failed",
									state: "output-available",
									input: { files: [{ path: "src/pages/menu.astro", content: "menu" }] },
									output: { success: false, changed: false, error: "File not found" },
								},
								{
									type: "tool-validate_site",
									toolCallId: "validate-failed",
									state: "output-available",
									output: { success: false },
								},
							],
						},
					]).messages[0]
				}
				streaming
				live
				onClose={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Adjusting file update · 1 file" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Found a site issue · fixing" })).toBeTruthy();
		expect(document.querySelector('[data-tool-state="error"]')).toBeNull();
	});

	it("keeps an unresolved validation terminal and describes its route plainly", async () => {
		const user = userEvent.setup();
		render(
			<BuildDetails
				message={
					chat([
						{
							id: "assistant-failed",
							role: "assistant",
							metadata: { initialGenerationStatus: "failed" },
							parts: [
								{
									type: "tool-validate_site",
									toolCallId: "validate-failed",
									state: "output-available",
									output: {
										success: false,
										publicSiteAudit: {
											success: false,
											checkedPaths: [],
											issues: [{ path: "/", reason: "http-status", status: 500 }],
										},
									},
								},
							],
						},
					]).messages[0]
				}
				streaming={false}
				live={false}
				onClose={vi.fn()}
			/>,
		);

		const failed = screen.getByRole("button", { name: "Site validation failed" });
		expect(failed.closest('[data-tool-state="error"]')).toBeTruthy();
		await user.click(failed);
		expect(screen.getByText("The homepage could not render (HTTP 500).")).toBeTruthy();
		expect(screen.queryByText("/: http-status")).toBeNull();
	});

	it("shows the accepted site screenshot and opens the live preview", async () => {
		const user = userEvent.setup();
		const screenshot = "cGljdHVyZQ==";
		const loadPreviewThumbnail = vi.fn(async () => ({
			base64: screenshot,
			mediaType: "image/png" as const,
		}));
		const onPreviewSite = vi.fn();
		render(
			<ChatPanel
				chat={chat([firstMessage, generatedMessage])}
				initialGeneration={{ id: "user-1", status: "ready", previewShotId: "shot-1" }}
				loadPreviewThumbnail={loadPreviewThumbnail}
				onPreviewSite={onPreviewSite}
			/>,
		);
		const image = await screen.findByRole("img", { name: "Screenshot of your generated site" });
		expect(image.getAttribute("src")).toBe(`data:image/png;base64,${screenshot}`);
		expect(loadPreviewThumbnail).toHaveBeenCalledExactlyOnceWith("shot-1");
		await user.click(screen.getByRole("button", { name: "Preview site" }));
		expect(onPreviewSite).toHaveBeenCalledTimes(1);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
	});

	it("keeps a live preview action when the retained screenshot is unavailable", async () => {
		const loadPreviewThumbnail = vi.fn(async () => null);
		render(
			<ChatPanel
				chat={chat([firstMessage, generatedMessage])}
				initialGeneration={{ id: "user-1", status: "ready", previewShotId: "shot-1" }}
				loadPreviewThumbnail={loadPreviewThumbnail}
				onPreviewSite={vi.fn()}
			/>,
		);
		expect(await screen.findByText("Preview image unavailable")).toBeTruthy();
		expect(screen.queryByRole("img", { name: "Screenshot of your generated site" })).toBeNull();
		expect(screen.getByRole("button", { name: "Preview site" })).toBeTruthy();
	});

	it("keeps a direct setup answer in chat alongside the same activity card", () => {
		const directQuestion = {
			id: "user-question",
			role: "user",
			parts: [{ type: "text", text: "Will I be able to edit the posts later?" }],
		};
		const directReply = {
			id: "assistant-answer",
			role: "assistant",
			metadata: { initialGenerationId: "user-1", initialGenerationReply: "holding" },
			parts: [{ type: "text", text: "Yes, the posts will be editable in EmDash." }],
		};
		render(
			<ChatPanel
				chat={chat([firstMessage, interviewMessage, directQuestion, directReply])}
				initialGeneration={{ id: "user-1", status: "preparing" }}
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		expect(screen.getByText("Will I be able to edit the posts later?")).toBeTruthy();
		expect(screen.getByText("Yes, the posts will be editable in EmDash.")).toBeTruthy();
	});

	it("keeps a long conversational setup answer visible in chat", () => {
		const longAnswer = `Yes, posts stay editable in EmDash. ${"You can revise each post later. ".repeat(70)}`;
		const question = {
			id: "user-question",
			role: "user",
			parts: [{ type: "text", text: "How will the editing workflow work?" }],
		};
		const holding = {
			id: "assistant-answer",
			role: "assistant",
			metadata: { initialGenerationId: "user-1", initialGenerationReply: "holding" },
			parts: [{ type: "text", text: longAnswer }],
		};
		const view = render(
			<ChatPanel
				chat={chat([firstMessage, interviewMessage, question, holding])}
				initialGeneration={{ id: "user-1", status: "preparing" }}
			/>,
		);
		expect(view.container.querySelector(".chat-messages-scroll")?.textContent).toContain(
			longAnswer,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
	});

	it("discards a locally queued change when the user presses Stop", async () => {
		const user = userEvent.setup();
		const initial = chat([firstMessage, generatedMessage], true);
		const view = render(
			<ChatPanel
				chat={initial}
				initialGeneration={{ id: "user-1", status: "building" }}
				onStopGeneration={vi.fn(async () => {})}
			/>,
		);
		const input = screen.getByRole("textbox", { name: "Message EmDash" });
		await user.type(input, "Add a gallery{Enter}");
		expect(screen.getByRole("button", { name: "Message queued" })).toBeTruthy();
		await user.click(await screen.findByRole("button", { name: "Stop generating" }));
		view.rerender(
			<ChatPanel
				chat={{ ...initial, isStreaming: false, status: "ready" }}
				initialGeneration={{ id: "user-1", status: "stopped" }}
			/>,
		);
		expect(initial.sendMessage).not.toHaveBeenCalled();
	});

	it("keeps a no-question auto-build in one stable card and retains keyboard focus", () => {
		const view = render(
			<ChatPanel
				chat={chat([firstMessage])}
				status="Starting the blank canvas…"
				initialGeneration={{ id: "user-1", status: "preparing" }}
			/>,
		);
		const action = screen.getByRole("button", { name: "View activity" });
		action.focus();
		view.rerender(
			<ChatPanel
				chat={chat([firstMessage, generatedMessage])}
				initialGeneration={{ id: "user-1", status: "ready" }}
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		expect(screen.getByRole("button", { name: "View activity" })).toBe(action);
		expect(document.activeElement).toBe(action);
		expect(screen.queryByText("Your site is ready.")).toBeNull();
	});

	it("keeps an initial reply in one card while its generation metadata is still missing", async () => {
		const user = userEvent.setup();
		const untagged = {
			id: "assistant-untagged-build",
			role: "assistant",
			parts: [{ type: "text", text: "Creating the homepage." }],
		};
		const view = render(
			<Workspace
				messages={[firstMessage, untagged]}
				status="Starting dev server..."
				initialGeneration={{ id: "user-1", status: "preparing" }}
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		await user.click(screen.getByRole("button", { name: "View activity" }));
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).toContain(
			"Creating the homepage.",
		);
		view.rerender(
			<Workspace
				messages={[firstMessage, untagged]}
				initialGeneration={{ id: "user-1", status: "ready" }}
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
	});

	it("does not fold a later untagged follow-up into the initial build", () => {
		const followUp = {
			id: "user-follow-up",
			role: "user",
			parts: [{ type: "text", text: "Add a contact page." }],
		};
		const laterReply = {
			id: "assistant-follow-up",
			role: "assistant",
			parts: [{ type: "text", text: "I'll add a contact page." }],
		};
		render(
			<ChatPanel
				chat={chat([firstMessage, interviewMessage, followUp, laterReply])}
				initialGeneration={{ id: "user-1", status: "ready" }}
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(2);
		expect(screen.getByText("I'll add a contact page.")).toBeTruthy();
	});

	it("groups an untagged build reply after structured setup answers", () => {
		const untagged = {
			id: "assistant-building",
			role: "assistant",
			parts: [{ type: "text", text: "Building the project pages." }],
		};
		render(
			<ChatPanel
				chat={chat([firstMessage, interviewMessage, structuredAnswer, untagged])}
				initialGeneration={{ id: "user-1", status: "building" }}
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		expect(screen.queryByText("1 question answered")).toBeNull();
	});

	it("keeps one initial card when durable generation state is missing", () => {
		const messages = [
			firstMessage,
			interviewMessage,
			structuredAnswer,
			holdingMessage,
			generatedMessage,
		];
		render(<ChatPanel chat={chat(messages)} buildStarted buildComplete />);

		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		expect(screen.getByText("Your site is ready")).toBeTruthy();
		expect(screen.queryByText(/Here are my answers/)).toBeNull();
		expect(screen.queryByText("A quick design question.")).toBeNull();
		expect(screen.queryByText("I have your direction; setup is finishing.")).toBeNull();

		const displayed = initialGenerationForDisplay(chat(messages).messages, undefined, {
			buildStarted: true,
			buildComplete: true,
			awaitingAnswers: false,
			active: false,
		});
		const projection = projectInitialGeneration(chat(messages).messages, displayed);
		expect(projection?.answerMessageIds.has(structuredAnswer.id)).toBe(true);
		expect(
			projection?.message.parts?.some((part) => part.type === "data-questionnaire-answers"),
		).toBe(true);
	});

	it("does not claim an incomplete idle build is ready when generation state is missing", () => {
		render(
			<ChatPanel
				chat={chat([firstMessage, interviewMessage, structuredAnswer, generatedMessage])}
				buildStarted
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		expect(screen.getByText("Build needs attention")).toBeTruthy();
		expect(screen.queryByText("Your site is ready")).toBeNull();
		expect(screen.queryByRole("button", { name: "Preview site" })).toBeNull();
	});

	it("keeps the interview-to-build handoff neutral before generation state arrives", () => {
		render(
			<ChatPanel chat={chat([firstMessage, interviewMessage, structuredAnswer, holdingMessage])} />,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		const headerIcon = screen.getByText("Build pending").parentElement?.querySelector("svg");
		expect(headerIcon?.classList.contains("text-text-tertiary")).toBe(true);
		expect(headerIcon?.classList.contains("text-accent-text")).toBe(false);
		expect(screen.queryByText("Build needs attention")).toBeNull();
		expect(screen.queryByRole("list", { name: "Build progress" })).toBeNull();
		expect(screen.queryByLabelText(/Elapsed time/)).toBeNull();
		expect(screen.queryByText(/Here are my answers/)).toBeNull();
	});

	it("keeps one card per real prompt when generation state is missing", () => {
		const followUp = {
			id: "user-follow-up",
			role: "user",
			parts: [{ type: "text", text: "Add a contact page." }],
		};
		const reply = {
			id: "assistant-follow-up",
			role: "assistant",
			parts: [{ type: "text", text: "Contact page added." }],
		};
		render(
			<ChatPanel
				chat={chat([
					firstMessage,
					interviewMessage,
					structuredAnswer,
					holdingMessage,
					generatedMessage,
					followUp,
					reply,
				])}
				buildStarted
				buildComplete
			/>,
		);

		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(2);
		expect(screen.getByText("Add a contact page.")).toBeTruthy();
		expect(screen.getByText("Contact page added.")).toBeTruthy();
		expect(screen.queryByText(/Here are my answers/)).toBeNull();
	});

	it("puts the live status on the same marker and label columns as timeline steps", async () => {
		const view = render(
			<BuildDetails
				message={undefined}
				streaming
				status="Running initial setup..."
				onClose={vi.fn()}
			/>,
		);
		const expectStepGeometry = (row: HTMLElement, text: string) => {
			expect(row.textContent).toBe(text);
			expect(row.classList.contains("build-details-step")).toBe(true);
			expect(row.querySelector(":scope > .build-details-marker")).toBeTruthy();
			const label = row.querySelector<HTMLElement>(".shimmer-text")!;
			expect(label.textContent).toBe(text);
			// Mirrors a tool row: my-1, a 1px border, and px-4 py-1.5 around a min-h-7 line.
			const line = label.closest<HTMLElement>(".min-h-7")!;
			const box = line.parentElement!;
			for (const name of ["my-1", "border", "border-transparent", "px-4", "py-1.5"]) {
				expect(box.classList).toContain(name);
			}
			expect(line.classList).toContain("flex");
			expect(row.querySelector(".animate-spin")).toBeNull();
		};
		const liveStep = () => document.querySelector<HTMLElement>("[data-live-step]")!;
		expectStepGeometry(liveStep(), "Running initial setup...");
		expect(screen.getByRole("status").textContent).toBe("Running initial setup...");
		view.rerender(<BuildDetails message={undefined} streaming onClose={vi.fn()} />);
		expectStepGeometry(liveStep(), "Getting started…");
		expect(screen.getByRole("status").textContent).toBe("Getting started…");
	});

	it("shows a step's live status in that step instead of a second row", () => {
		const batch = {
			type: "tool-create_entries_batch",
			toolCallId: "batch-1",
			state: "input-available",
			input: { collection: "articles", entries: [1, 2, 3, 4, 5].map((n) => ({ title: `${n}` })) },
		};
		const read = {
			type: "tool-read_file",
			toolCallId: "read-1",
			state: "input-available",
			input: { path: "src/pages/index.astro" },
		};
		const message = (parts: unknown[]) =>
			chat([{ id: "assistant-live", role: "assistant", parts }]).messages[0];
		const view = render(
			<BuildDetails
				message={message([batch])}
				streaming
				status="Writing 5 entries..."
				onClose={vi.fn()}
			/>,
		);
		const details = screen.getByRole("region", { name: "Build activity" });
		expect(details.querySelectorAll(".build-details-step:not([data-live-step])")).toHaveLength(1);
		const step = details.querySelector('[data-tool-state="active"]')!;
		// The step keeps what it is doing and adds the agent's current progress.
		expect(step.querySelector(".shimmer-text")?.textContent).toBe("Adding 5 entries to Articles");
		expect(step.querySelector("[data-live-detail]")?.textContent).toBe("· Writing 5 entries...");
		const announcement = within(details).getByRole("status");
		expect(announcement.textContent).toBe("Writing 5 entries...");
		expect(announcement.classList).toContain("sr-only");
		expect(openLiveRow(details)).toBeUndefined();

		// Two running steps: the status cannot be attributed, so it gets its own row.
		view.rerender(
			<BuildDetails
				message={message([read, batch])}
				streaming
				status="Writing 5 entries..."
				onClose={vi.fn()}
			/>,
		);
		expect(details.querySelectorAll(".build-details-step:not([data-live-step])")).toHaveLength(2);
		expect(openLiveRow(details)).toBe("Writing 5 entries...");
		// The same announcement region stays mounted as the row appears.
		expect(within(details).getByRole("status")).toBe(announcement);
		expect(details.querySelector('[data-tool-state="active"] .shimmer-text')?.textContent).toBe(
			"Reading file",
		);
	});

	it("attributes the status only to an executing step of the streaming reply", () => {
		// Editing the Astro config restarts the dev server from inside the step.
		const edit = {
			type: "tool-edit_file",
			toolCallId: "edit-1",
			state: "input-available",
			input: { path: "astro.config.mjs" },
		};
		const render_ = (
			parts: unknown[],
			props: { streaming: boolean; liveFromPart?: number; resumingPreview?: boolean },
		) => (
			<BuildDetails
				message={
					chat([
						{
							id: "assistant-live",
							role: "assistant",
							metadata: { liveFromPart: props.liveFromPart ?? 0 },
							parts,
						},
					]).messages[0]
				}
				streaming={props.streaming}
				live
				resumingPreview={props.resumingPreview}
				status="Restarting dev server..."
				onClose={vi.fn()}
			/>
		);
		const detail = () =>
			document.querySelector('[data-tool-state="active"] [data-live-detail]')?.textContent;
		const liveRow = () => openLiveRow();

		// The step that restarted the server carries its status.
		const view = render(render_([edit], { streaming: true }));
		expect(detail()).toBe("· Restarting dev server...");
		expect(
			document.querySelector('[data-live-detail] [aria-hidden="true"]')?.textContent?.trim(),
		).toBe("·");
		expect(liveRow()).toBeUndefined();

		// A stopped attempt's unfinished step does not count as running.
		const stale = { ...edit, toolCallId: "stale-edit" };
		view.rerender(render_([stale, edit], { streaming: true, liveFromPart: 1 }));
		expect(detail()).toBe("· Restarting dev server...");
		expect(liveRow()).toBeUndefined();

		// A step still streaming its input cannot have set the status.
		view.rerender(render_([{ ...edit, state: "input-streaming" }], { streaming: true }));
		expect(detail()).toBeUndefined();
		expect(liveRow()).toBe("Restarting dev server...");

		// While this tab reopens the preview after a reload, the status is the restore's.
		view.rerender(render_([edit], { streaming: true, resumingPreview: true }));
		expect(detail()).toBeUndefined();
		expect(liveRow()).toBe("Restarting dev server...");

		// Before the stream reaches this tab, no step is running yet.
		view.rerender(render_([edit], { streaming: false }));
		expect(document.querySelector('[data-tool-state="active"]')).toBeNull();
		expect(liveRow()).toBe("Restarting dev server...");

		// A restart step's status restates its label: one row, no repeated detail.
		const restart = {
			type: "tool-restart_dev_server",
			toolCallId: "restart-1",
			state: "input-available",
		};
		view.rerender(render_([restart], { streaming: true }));
		expect(document.querySelector('[data-tool-state="active"]')?.textContent).toBe(
			"Restarting dev server…",
		);
		expect(detail()).toBeUndefined();
		expect(liveRow()).toBeUndefined();
	});

	it("marks content and media steps with their own icons", () => {
		const markerFor = (type: string) => {
			const view = render(
				<BuildDetails
					message={
						chat([
							{
								id: `assistant-${type}`,
								role: "assistant",
								parts: [{ type, toolCallId: type, state: "output-available", output: {} }],
							},
						]).messages[0]
					}
					streaming={false}
					onClose={vi.fn()}
				/>,
			);
			const html = view.container.querySelector(".build-details-marker")?.innerHTML;
			view.unmount();
			return html;
		};
		const database = markerFor("tool-content_get");
		const image = markerFor("tool-upload_media");
		const file = markerFor("tool-write_file");
		expect(new Set([database, image, file]).size).toBe(3);
		for (const type of [
			"tool-create_entries_batch",
			"tool-apply_schema_plan",
			"tool-update_blocks_field",
			"tool-search",
		]) {
			expect(markerFor(type)).toBe(database);
		}
		expect(markerFor("tool-media_list")).toBe(image);
	});

	it("keeps interview, answers, holding, setup, build and completion in one card", async () => {
		const user = userEvent.setup();
		const preparing: InitialGeneration = { id: "user-1", status: "preparing" };
		const view = render(
			<Workspace
				messages={[firstMessage]}
				status="Setting up your site…"
				initialGeneration={preparing}
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		await user.click(screen.getByRole("button", { name: "View activity" }));
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).toContain(
			"Setting up your site",
		);

		view.rerender(
			<Workspace
				messages={[firstMessage, interviewMessage]}
				initialGeneration={{ id: "user-1", status: "awaiting_answers" }}
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		expect(screen.getByText("Waiting for your answers")).toBeTruthy();
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).toContain(
			"Design questions",
		);

		const messages = [
			firstMessage,
			interviewMessage,
			structuredAnswer,
			holdingMessage,
			generatedMessage,
		];
		view.rerender(
			<Workspace
				messages={messages}
				status="Checking pages…"
				initialGeneration={{ id: "user-1", status: "checking" }}
			/>,
		);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
		expect(screen.queryByText(/Here are my answers/)).toBeNull();
		expect(screen.queryByText("1 question answered")).toBeNull();
		const timeline = screen.getByRole("region", { name: "Build activity" });
		expect(within(timeline).getByText("Questions answered")).toBeTruthy();
		expect(within(timeline).getByText("Editorial")).toBeTruthy();
		expect(within(timeline).queryByText("Design questions")).toBeNull();
		expect(timeline.textContent).toContain("setup is finishing");
		expect(timeline.textContent).toContain("Writing the first page");

		view.rerender(
			<Workspace
				messages={JSON.parse(JSON.stringify(messages))}
				initialGeneration={{ id: "user-1", status: "ready" }}
			/>,
		);
		expect(screen.getByText("Your site is ready")).toBeTruthy();
		expect(screen.getAllByText("Your site is ready.")).toHaveLength(1);
		expect(screen.getByRole("button", { name: "View activity" }).getAttribute("aria-current")).toBe(
			"true",
		);
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).toContain(
			"Your site is ready.",
		);
		await user.click(screen.getByRole("button", { name: "Back to site" }));
		expect(screen.queryByRole("region", { name: "Build activity" })).toBeNull();
		expect(screen.queryByText("Your site is ready.")).toBeNull();
	});

	it("keeps later edits and typed or mismatched messages visible", async () => {
		const user = userEvent.setup();
		const laterUser = {
			id: "user-later",
			role: "user",
			parts: [{ type: "text", text: "Add a gallery" }],
		};
		const laterAssistant = {
			id: "assistant-later",
			role: "assistant",
			parts: [{ type: "text", text: "Gallery ready." }],
		};
		const mixed = {
			...structuredAnswer,
			id: "user-mixed",
			parts: [
				{
					type: "text",
					text: "Here are my answers:\n\nQ: Which style?\nA: Editorial\nAlso add a gallery",
				},
			],
		};
		const messages = [
			firstMessage,
			interviewMessage,
			structuredAnswer,
			holdingMessage,
			generatedMessage,
			mixed,
			laterUser,
			laterAssistant,
		];
		render(<Workspace messages={messages} initialGeneration={{ id: "user-1", status: "ready" }} />);
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(2);
		expect(screen.getByText(/Also add a gallery/)).toBeTruthy();
		expect(screen.getByText("Add a gallery")).toBeTruthy();
		await user.click(screen.getAllByRole("button", { name: "View activity" })[1]!);
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).toContain(
			"Gallery ready",
		);
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).not.toContain(
			"Writing the first page",
		);
	});

	it("never hides a typed answer or an altered form payload", () => {
		const typed = {
			id: "typed-answer",
			role: "user",
			parts: [{ type: "text", text: "Editorial, with a gallery too" }],
		};
		const view = render(
			<ChatPanel
				chat={chat([firstMessage, interviewMessage, typed])}
				initialGeneration={{ id: "user-1", status: "building" }}
			/>,
		);
		expect(screen.getByText("Editorial, with a gallery too")).toBeTruthy();
		const altered = {
			...structuredAnswer,
			parts: [{ type: "text", text: `${structuredAnswer.parts[0]!.text}\nAlso add a gallery` }],
		};
		view.rerender(
			<ChatPanel
				chat={chat([firstMessage, interviewMessage, altered])}
				initialGeneration={{ id: "user-1", status: "building" }}
			/>,
		);
		expect(screen.getByText(/Also add a gallery/)).toBeTruthy();
		expect(screen.getAllByRole("button", { name: "View activity" })).toHaveLength(1);
	});

	it("keeps a real Stop action and retries stopped or failed builds without questions", async () => {
		const user = userEvent.setup();
		const conversation = chat([firstMessage]);
		const onStopGeneration = vi.fn(async () => {});
		const view = render(
			<ChatPanel
				chat={conversation}
				initialGeneration={{ id: "user-1", status: "preparing" }}
				onStopGeneration={onStopGeneration}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Stop generating" }));
		expect(conversation.stop).toHaveBeenCalledTimes(1);
		expect(onStopGeneration).toHaveBeenCalledTimes(1);
		view.rerender(
			<ChatPanel
				chat={conversation}
				initialGeneration={{ id: "user-1", status: "stopping" }}
				onStopGeneration={onStopGeneration}
			/>,
		);
		expect(screen.getByText("Stopping build")).toBeTruthy();
		view.rerender(
			<ChatPanel
				chat={conversation}
				initialGeneration={{ id: "user-1", status: "stopped" }}
				onStopGeneration={onStopGeneration}
			/>,
		);
		expect(screen.getByText("Build stopped")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Retry build" }));
		expect(conversation.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				parts: [
					{
						type: "text",
						text: "Resume the initial build using the brief and answers above. Reuse the existing work; before finishing, run validate_site until it passes, then inspect the final preview.",
					},
				],
			}),
		);
		view.rerender(
			<ChatPanel
				chat={chat([firstMessage])}
				initialGeneration={{ id: "user-1", status: "failed" }}
			/>,
		);
		expect(screen.getByText("Build needs attention")).toBeTruthy();
	});

	it("uses recommended defaults for a structured skip without hiding legacy text", async () => {
		const skipped = {
			...structuredAnswer,
			metadata: {
				questionnaire: {
					toolCallId: "ask-1",
					answers: [{ question: "Which style?", selected: [], custom: "" }],
				},
			},
			parts: [
				{
					type: "text",
					text: "I skipped the clarifying questions. Use your recommended defaults and start building.",
				},
			],
		};
		const legacy = {
			id: "user-legacy",
			role: "user",
			parts: [{ type: "text", text: "Actually make it colourful" }],
		};
		const messages = [firstMessage, interviewMessage, skipped, legacy, generatedMessage];
		const projection = projectInitialGeneration(chat(messages).messages, {
			id: "user-1",
			status: "ready",
		});
		expect(projection?.usingDefaults).toBe(true);
		expect(projection?.answerMessageIds.has(skipped.id)).toBe(true);
		const user = userEvent.setup();
		render(<Workspace messages={messages} initialGeneration={{ id: "user-1", status: "ready" }} />);
		expect(screen.queryByText("Using recommended defaults")).toBeNull();
		expect(screen.getByText("Actually make it colourful")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "View activity" }));
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).toContain(
			"Using recommended defaults",
		);
	});
});

describe("build details handoff", () => {
	it("opens during initial setup and follows the first streamed assistant response", async () => {
		const user = userEvent.setup();
		const view = render(
			<Workspace messages={[firstMessage]} status="Opening a blank site canvas…" />,
		);
		const preview = screen.getByTitle("Site preview");
		await user.click(screen.getByRole("button", { name: "View activity" }));
		expect(screen.getByRole("status").textContent).toContain("Opening a blank site canvas");
		expect(preview.parentElement?.hasAttribute("inert")).toBe(true);
		expect(preview.parentElement?.getAttribute("aria-hidden")).toBe("true");

		view.rerender(
			<Workspace messages={[firstMessage, buildMessage]} status="Reviewing the preview…" />,
		);
		expect(screen.getByRole("button", { name: "Wrote src/pages/index.astro" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Thought" })).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain("Reviewing the preview");
		expect(screen.getByTitle("Site preview")).toBe(preview);

		await user.click(screen.getByRole("button", { name: "Back to site" }));
		expect(screen.queryByRole("region", { name: "Build activity" })).toBeNull();
		expect(preview.parentElement?.hasAttribute("inert")).toBe(false);
		expect(screen.getByTitle("Site preview")).toBe(preview);
	});

	it("keeps the selected timeline when a streamed response gets its persisted id", async () => {
		const user = userEvent.setup();
		const streamingMessage = { ...buildMessage, id: "temporary-assistant" };
		const view = render(
			<Workspace messages={[firstMessage, streamingMessage]} status="Finishing the site…" />,
		);
		await user.click(screen.getByRole("button", { name: "View activity" }));
		expect(screen.getByRole("button", { name: "Wrote src/pages/index.astro" })).toBeTruthy();

		view.rerender(
			<Workspace messages={[firstMessage, { ...buildMessage, id: "persisted-assistant" }]} />,
		);
		expect(screen.getByRole("button", { name: "View activity" }).getAttribute("aria-current")).toBe(
			"true",
		);
		expect(screen.getByRole("button", { name: "Wrote src/pages/index.astro" })).toBeTruthy();
		expect(screen.queryByText("No activity recorded for this response.")).toBeNull();
	});

	it("selects another turn without closing Activity when the selected action is clicked again", async () => {
		const user = userEvent.setup();
		const nextRequest = {
			id: "user-2",
			role: "user",
			parts: [{ type: "text", text: "Update the gallery" }],
		};
		const nextResponse = {
			id: "assistant-2",
			role: "assistant",
			parts: [{ type: "text", text: "I am updating the gallery now." }],
		};
		render(<Workspace messages={[firstMessage, buildMessage, nextRequest, nextResponse]} />);

		const actions = screen.getAllByRole("button", { name: "View activity" });
		expect(
			document.getElementById(actions[0]!.getAttribute("aria-describedby")!)?.textContent,
		).toBe("Update complete");
		await user.click(actions[0]!);
		expect(actions[0]!.getAttribute("aria-current")).toBe("true");
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).toContain(
			"Writing the first page.",
		);

		await user.click(actions[1]!);
		expect(actions[0]!.hasAttribute("aria-current")).toBe(false);
		expect(actions[1]!.getAttribute("aria-current")).toBe("true");
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).toContain(
			"I am updating the gallery now.",
		);
		await user.click(actions[1]!);
		expect(screen.getByRole("region", { name: "Build activity" })).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Back to site" }));
		expect(screen.queryByRole("region", { name: "Build activity" })).toBeNull();
	});

	it("keeps working prose in the timeline and final response in chat", async () => {
		const user = userEvent.setup();
		render(<Workspace messages={[firstMessage, buildMessage]} />);
		expect(screen.getByText("Your site is ready.")).toBeTruthy();
		expect(screen.queryByText("Writing the first page.")).toBeNull();
		expect(screen.queryByText("Wrote src/pages/index.astro")).toBeNull();
		await user.click(screen.getByRole("button", { name: "View activity" }));
		expect(screen.getByText("Writing the first page.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Wrote src/pages/index.astro" })).toBeTruthy();
		expect(screen.getAllByText("Your site is ready.")).toHaveLength(2);
		const partial = render(
			<ChatPanel
				chat={chat([firstMessage, { ...buildMessage, parts: buildMessage.parts.slice(0, 3) }])}
			/>,
		);
		expect(within(partial.container).queryByText("Writing the first page.")).toBeNull();
	});

	it("does not yank a reader to the bottom when new activity streams", () => {
		const message = chat([buildMessage]).messages[0];
		const view = render(
			<BuildDetails message={message} streaming status="Checking pages…" onClose={vi.fn()} />,
		);
		const scroll = view.container.querySelector<HTMLElement>(".build-details > div:last-child")!;
		Object.defineProperties(scroll, {
			scrollHeight: { configurable: true, value: 1000 },
			clientHeight: { configurable: true, value: 200 },
		});
		scroll.scrollTop = 100;
		fireEvent.scroll(scroll);
		view.rerender(
			<BuildDetails message={message} streaming status="Finishing pages…" onClose={vi.fn()} />,
		);
		expect(scroll.scrollTop).toBe(100);
	});

	it("binds pending setup details to the new request, not the previous response", async () => {
		const user = userEvent.setup();
		const nextRequest = {
			id: "user-2",
			role: "user",
			parts: [{ type: "text", text: "Add a gallery" }],
		};
		const view = render(
			<Workspace
				messages={[firstMessage, buildMessage, nextRequest]}
				status="Starting the gallery…"
			/>,
		);
		await user.click(screen.getAllByRole("button", { name: "View activity" })[1]!);
		expect(screen.getByRole("status").textContent).toContain("Starting the gallery");
		expect(screen.queryByText("Writing the first page.")).toBeNull();
		const galleryResponse = {
			id: "assistant-2",
			role: "assistant",
			parts: [{ type: "text", text: "Gallery ready." }],
		};
		view.rerender(
			<Workspace
				messages={[firstMessage, buildMessage, nextRequest, galleryResponse]}
				status="Final checks…"
			/>,
		);
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).toContain(
			"Gallery ready.",
		);
		expect(screen.getByRole("region", { name: "Build activity" }).textContent).not.toContain(
			"Writing the first page.",
		);
	});

	it("shows design questions and keeps answers in only the setup turn", () => {
		const question = {
			id: "assistant-questions",
			role: "assistant",
			parts: [
				{
					type: "tool-ask_questions",
					toolCallId: "ask-1",
					state: "output-available",
					input: {
						questions: [{ question: "Which style should I build?", options: ["Editorial"] }],
					},
				},
			],
		};
		const answer = {
			id: "user-answer",
			role: "user",
			parts: [{ type: "text", text: "Editorial" }],
		};
		const response = { id: "assistant-build", role: "assistant", parts: [] };
		const later = { id: "user-later", role: "user", parts: [{ type: "text", text: "New page" }] };
		const messages = chat([firstMessage, question, answer, response, later]).messages;
		expect(setupAnswerForDetails(messages, "assistant-build")).toBe("Editorial");
		expect(setupAnswerForDetails(messages, "user-later")).toBeUndefined();
		const laterQuestion = {
			...question,
			id: "assistant-later-question",
			parts: [{ ...question.parts[0], toolCallId: "ask-2" }],
		};
		const laterAnswer = {
			id: "user-later-answer",
			role: "user",
			parts: [{ type: "text", text: "Modern" }],
		};
		const laterResponse = { id: "assistant-later-build", role: "assistant", parts: [] };
		const withLaterQuestionnaire = chat([
			...messages,
			laterQuestion,
			laterAnswer,
			laterResponse,
		]).messages;
		expect(setupAnswerForDetails(withLaterQuestionnaire, "assistant-build")).toBe("Editorial");
		expect(setupAnswerForDetails(withLaterQuestionnaire, "assistant-later-build")).toBe("Modern");
		const view = render(<BuildDetails message={messages[1]} streaming={false} onClose={vi.fn()} />);
		expect(screen.getByText("Design questions")).toBeTruthy();
		expect(screen.getByText("Which style should I build?")).toBeTruthy();
		view.rerender(
			<BuildDetails
				message={messages[3]}
				streaming={false}
				setupAnswer="Editorial"
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByText("Questions answered")).toBeTruthy();
		expect(screen.getByText("Editorial")).toBeTruthy();
		view.rerender(
			<BuildDetails
				message={messages[3]}
				streaming={false}
				setupAnswer={
					"Here are my answers:\n\nQ: Which style should I build?\nA: Dramatic one-sheet"
				}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByText("Which style should I build?")).toBeTruthy();
		expect(screen.getByText("Dramatic one-sheet")).toBeTruthy();
		expect(screen.queryByText(/Here are my answers/)).toBeNull();
		view.rerender(
			<BuildDetails
				message={messages[3]}
				streaming={false}
				setupAnswer={
					"Here are my answers:\n\nQ: Which style?\nA: Warm and quiet\n\nWith a long introduction\n\nQ: Which audience?\nA: Readers\n\nUse your recommended defaults for any questions I skipped."
				}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByText(/Warm and quiet\s+With a long introduction/)).toBeTruthy();
		expect(screen.getByText("Use recommended defaults for questions not answered.")).toBeTruthy();
	});

	it("shows the chosen design direction in the response card without echoing the full questionnaire", () => {
		const question = {
			id: "assistant-question",
			role: "assistant",
			parts: [
				{
					type: "tool-ask_questions",
					toolCallId: "ask-1",
					state: "output-available",
					input: {
						questions: [
							{ question: "What name should appear?", options: ["Slow Light"] },
							{
								question: "Which design direction should I build?",
								options: ["Dramatic one-sheet"],
							},
						],
					},
				},
			],
		};
		const answer = {
			id: "user-answer",
			role: "user",
			parts: [
				{
					type: "text",
					text: "Here are my answers:\n\nQ: What name should appear?\nA: Slow Light\n\nQ: Which design direction should I build?\nA: Dramatic one-sheet",
				},
			],
		};
		const response = {
			id: "assistant-build",
			role: "assistant",
			parts: [{ type: "text", text: "Your blog is ready." }],
		};
		const messages = chat([firstMessage, question, answer, response]).messages;
		expect(setupAnswerSummaryForDetails(messages, response.id)).toEqual({
			question: "Which design direction should I build?",
			answer: "Dramatic one-sheet",
		});
		const card = render(
			<ChatPanel chat={chat(messages)} />,
		).container.querySelectorAll<HTMLElement>(".my-3")[1]!;
		expect(within(card).getByText("Which design direction should I build?")).toBeTruthy();
		expect(within(card).getByText("• Dramatic one-sheet")).toBeTruthy();
		expect(within(card).queryByText("What name should appear?")).toBeNull();
		expect(setupAnswerSummaryForDetails(messages, question.id)).toBeUndefined();
	});

	it("uses a successful uploaded image for the card without pretending it is a screenshot", () => {
		const mediaMessage = {
			...buildMessage,
			parts: [
				...buildMessage.parts,
				{
					type: "tool-view_preview",
					state: "output-available",
					output: { success: true, shotId: "shot-1" },
				},
				{
					type: "tool-upload_media",
					state: "output-available",
					input: {
						images: [{ url: "https://images.unsplash.com/photo-123?w=1200", alt: "Iceland coast" }],
					},
					output: {
						success: true,
						results: [{ url: "https://images.unsplash.com/photo-123?w=1200", success: true }],
					},
				},
			],
		};
		const message = chat([mediaMessage]).messages[0];
		expect(activityImage(message)?.alt).toBe("Iceland coast");
		const failed = chat([
			{
				...mediaMessage,
				parts: mediaMessage.parts.map((part) =>
					part.type === "tool-upload_media"
						? {
								...part,
								output: {
									success: true,
									results: [
										{ url: "https://images.unsplash.com/photo-123?w=1200", success: false },
									],
								},
							}
						: part,
				),
			},
		]).messages[0];
		expect(activityImage(failed)).toBeUndefined();
		render(<ChatPanel chat={chat([firstMessage, mediaMessage])} />);
		expect(screen.getByRole("img", { name: "Iceland coast" })).toBeTruthy();
		expect(screen.getByText("Image added to the site")).toBeTruthy();
		expect(screen.getByRole("button", { name: "View activity" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Preview current site" })).toBeNull();
	});

	it("keeps captured screenshots in their timeline steps rather than the chat card", async () => {
		const user = userEvent.setup();
		const screenshotMessage = {
			...buildMessage,
			parts: [
				{
					type: "tool-view_preview",
					state: "output-available",
					output: { success: true, shotId: "shot-1" },
				},
				{ type: "text", text: "Your site is ready." },
			],
		};
		const loadPreviewThumbnail = vi.fn(async () => ({
			base64: "cGljdHVyZQ==",
			mediaType: "image/png" as const,
		}));
		render(
			<>
				<ChatPanel chat={chat([firstMessage, screenshotMessage])} />
				<BuildDetails
					message={chat([screenshotMessage]).messages[0]}
					streaming={false}
					loadPreviewThumbnail={loadPreviewThumbnail}
					onClose={vi.fn()}
				/>
			</>,
		);
		expect(
			screen.queryByRole("img", { name: "Site screenshot captured during this response" }),
		).toBeNull();
		expect(loadPreviewThumbnail).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Reviewed the preview" }));
		const image = await screen.findByRole("img", {
			name: "Preview screenshot captured during this step",
		});
		expect(image.getAttribute("src")).toBe("data:image/png;base64,cGljdHVyZQ==");
		expect(loadPreviewThumbnail).toHaveBeenCalledWith("shot-1");
	});

	it("shows one timeline of every step with no view switcher", () => {
		render(
			<BuildDetails
				message={chat([buildMessage]).messages[0]}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("tablist")).toBeNull();
		expect(screen.queryByRole("tab")).toBeNull();
		expect(screen.getByRole("button", { name: "Thought" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Wrote src/pages/index.astro" })).toBeTruthy();
	});
});

describe("live activity", () => {
	const unfinishedBuild = {
		id: "assistant-1",
		role: "assistant",
		parts: [
			{ type: "reasoning", text: "Planning the entries", state: "streaming" },
			{
				type: "tool-create_entries_batch",
				toolCallId: "batch-1",
				state: "input-available",
				input: { collection: "articles", entries: [{ title: "One", brief: "First" }] },
			},
			{ type: "text", text: "Your site is ready." },
		],
	};

	it("does not animate a finished turn while the server restores the preview", async () => {
		const user = userEvent.setup();
		render(
			<Workspace
				messages={[firstMessage, unfinishedBuild]}
				status="Restoring preview..."
				streaming={false}
			/>,
		);
		expect(screen.queryByText("Building your site")).toBeNull();
		expect(document.querySelector(".animate-spin")).toBeNull();
		await user.click(screen.getByRole("button", { name: "View activity" }));
		const details = screen.getByRole("region", { name: "Build activity" });
		expect(details.querySelector('[data-tool-state="interrupted"]')).toBeTruthy();
		expect(details.querySelector('[data-tool-state="active"]')).toBeNull();
		expect(details.querySelector(".shimmer-text")).toBeNull();
		expect(within(details).getByRole("status").textContent).toBe("");
		expect(openLiveRow(details)).toBeUndefined();
		expect(within(details).queryByText("Live")).toBeNull();
		expect(within(details).queryByText("Restoring preview...")).toBeNull();
		expect(within(details).getByRole("button", { name: "Thought" })).toBeTruthy();
	});

	it("shows a sent follow-up as working before its first streamed chunk", async () => {
		const user = userEvent.setup();
		const nextRequest = {
			id: "user-2",
			role: "user",
			parts: [{ type: "text", text: "Add a gallery" }],
		};
		const view = render(
			<Workspace
				messages={[firstMessage, buildMessage, nextRequest]}
				streaming={false}
				chatStatus="submitted"
			/>,
		);
		const pending = within(screen.getByRole("list", { name: "Change progress" })).getByText(
			"Working on your request",
		);
		expect(pending.closest('[data-phase-state="active"]')).toBeTruthy();
		view.rerender(
			<Workspace
				messages={[firstMessage, buildMessage, nextRequest]}
				status="Restoring session..."
				streaming={false}
				chatStatus="submitted"
			/>,
		);
		await user.click(screen.getAllByRole("button", { name: "View activity" })[1]!);
		const details = screen.getByRole("region", { name: "Build activity" });
		expect(within(details).getByRole("status").textContent).toBe("Restoring session...");
		const row = details.querySelector('[data-live-row][data-open="true"]')!;
		expect(row.textContent).toBe("Restoring session...");
		expect(row.querySelector(".shimmer-text")).toBeTruthy();
		expect(within(details).queryByText("Live")).toBeNull();
	});

	it("keeps a reloaded tab's pending turn live before its stream reaches the tab", async () => {
		const user = userEvent.setup();
		const nextRequest = {
			id: "user-2",
			role: "user",
			parts: [{ type: "text", text: "Add a gallery" }],
		};
		render(
			<Workspace
				messages={[firstMessage, buildMessage, nextRequest]}
				status="Installing dependencies..."
				streaming={false}
				serverTurnActive
			/>,
		);
		await user.click(screen.getAllByRole("button", { name: "View activity" })[1]!);
		const details = screen.getByRole("region", { name: "Build activity" });
		expect(within(details).getByRole("status").textContent).toBe("Installing dependencies...");
		expect(within(details).queryByText("Live")).toBeNull();
	});

	it("follows the first build's phase while no chat turn is streaming", async () => {
		const user = userEvent.setup();
		const view = render(
			<Workspace
				messages={[firstMessage, interviewMessage]}
				status="Starting dev server..."
				streaming={false}
				initialGeneration={{ id: "user-1", status: "preparing" }}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "View activity" }));
		const details = screen.getByRole("region", { name: "Build activity" });
		expect(within(details).getByRole("status").textContent).toBe("Starting dev server...");
		view.rerender(
			<Workspace
				messages={[firstMessage, interviewMessage]}
				status="Starting dev server..."
				streaming={false}
				initialGeneration={{ id: "user-1", status: "awaiting_answers" }}
			/>,
		);
		expect(within(details).getByRole("status").textContent).toBe("");
		expect(openLiveRow(details)).toBeUndefined();
		expect(within(details).queryByText("Live")).toBeNull();
	});

	it("only lets the retried build animate, not the stopped attempt before it", async () => {
		const user = userEvent.setup();
		const stoppedAttempt = {
			id: "assistant-build-1",
			role: "assistant",
			metadata: { initialGenerationId: "user-1" },
			parts: [
				{ type: "reasoning", text: "Old plan", state: "streaming" },
				{
					type: "tool-write_file",
					toolCallId: "old-write",
					state: "input-available",
					input: { path: "src/pages/old.astro" },
				},
			],
		};
		const retry = {
			id: "user-retry",
			role: "user",
			parts: [{ type: "text", text: "Retry the initial build using the brief and answers above." }],
		};
		const retried = {
			id: "assistant-build-2",
			role: "assistant",
			metadata: { initialGenerationId: "user-1" },
			parts: [
				{
					type: "tool-write_file",
					toolCallId: "new-write",
					state: "input-available",
					input: { path: "src/pages/new.astro" },
				},
			],
		};
		const building: InitialGeneration = { id: "user-1", status: "building" };
		const view = render(
			<Workspace
				messages={[firstMessage, stoppedAttempt, retry, retried]}
				initialGeneration={building}
				streaming
			/>,
		);
		await user.click(screen.getByRole("button", { name: "View activity" }));
		const details = screen.getByRole("region", { name: "Build activity" });
		const states = [...details.querySelectorAll("[data-tool-state]")].map((row) =>
			row.getAttribute("data-tool-state"),
		);
		expect(states).toEqual(["interrupted", "active"]);
		expect(within(details).queryByText("Thinking")).toBeNull();
		expect(within(details).getByRole("button", { name: "Thought" })).toBeTruthy();

		view.rerender(
			<Workspace
				messages={[firstMessage, stoppedAttempt, retry]}
				initialGeneration={building}
				streaming
			/>,
		);
		expect(
			[...details.querySelectorAll("[data-tool-state]")].map((row) =>
				row.getAttribute("data-tool-state"),
			),
		).toEqual(["interrupted"]);
	});

	it("shimmers the working card title instead of spinning an icon", () => {
		render(
			<ChatPanel
				chat={chat([firstMessage, generatedMessage], true)}
				initialGeneration={{ id: "user-1", status: "building" }}
			/>,
		);
		expect(screen.getByText("Building your site").classList.contains("shimmer-text")).toBe(true);
		expect(document.querySelector(".animate-spin")).toBeNull();
	});
});

describe("live timeline", () => {
	const reply = (parts: unknown[], metadata?: Record<string, unknown>) =>
		chat([{ id: "assistant-live", role: "assistant", metadata, parts }]).messages[0];
	const done = {
		type: "tool-read_file",
		toolCallId: "read-done",
		state: "output-available",
		input: { path: "src/pages/index.astro" },
		output: { success: true },
	};
	const running = {
		...done,
		toolCallId: "read-running",
		state: "input-available",
		output: undefined,
	};
	const liveRow = () => document.querySelector<HTMLElement>("[data-live-row]")!;

	it("keeps a working row between steps and folds it away while a step shows progress", () => {
		vi.useFakeTimers();
		try {
			const details = (parts: unknown[], live = true) => (
				<BuildDetails message={reply(parts)} streaming={live} live={live} onClose={vi.fn()} />
			);
			// Opened during a pause: the row is already there.
			const view = render(details([done]));
			expect(liveRow().dataset.open).toBe("true");
			expect(liveRow().textContent).toBe("Working…");

			view.rerender(details([done, running]));
			expect(liveRow().dataset.open).toBe("false");
			// The closing row keeps its last words while it collapses.
			expect(liveRow().textContent).toBe("Working…");

			view.rerender(details([done, { type: "reasoning", text: "Checking", state: "streaming" }]));
			expect(liveRow().dataset.open).toBe("false");

			// A hand-over between steps (reasoning with no summary yet, an empty
			// new text part) does not blink the row open...
			view.rerender(details([done, { type: "reasoning", text: "", state: "streaming" }]));
			expect(liveRow().dataset.open).toBe("false");
			act(() => vi.advanceTimersByTime(200));
			view.rerender(details([done, { type: "text", text: "Now the pages", state: "streaming" }]));
			act(() => vi.advanceTimersByTime(200));
			expect(liveRow().dataset.open).toBe("false");

			// ...but a pause that lasts does open it.
			view.rerender(details([done, { type: "reasoning", text: "", state: "streaming" }]));
			act(() => vi.advanceTimersByTime(300));
			expect(liveRow().dataset.open).toBe("true");

			// Preparing questions is visible progress of its own.
			view.rerender(
				details([
					done,
					{ type: "tool-ask_questions", toolCallId: "ask", state: "input-streaming" },
				]),
			);
			act(() => vi.advanceTimersByTime(300));
			expect(liveRow().dataset.open).toBe("false");

			view.rerender(details([done], false));
			expect(liveRow().dataset.open).toBe("false");
			expect(screen.getByRole("status").textContent).toBe("");
		} finally {
			vi.useRealTimers();
		}
	});

	it("hands an open status row over to Working… without folding it", () => {
		vi.useFakeTimers();
		try {
			const details = (status?: string) => (
				<BuildDetails message={reply([done])} streaming live status={status} onClose={vi.fn()} />
			);
			const view = render(details("Connecting to CMS..."));
			expect(liveRow().dataset.open).toBe("true");
			view.rerender(details());
			expect(liveRow().dataset.open).toBe("true");
			expect(liveRow().textContent).toBe("Working…");
		} finally {
			vi.useRealTimers();
		}
	});

	it("omits a stopped attempt's settled long prose", () => {
		const long = "Writing the gallery page with care. ".repeat(60);
		render(
			<BuildDetails
				message={reply([{ type: "text", text: long, state: "streaming" }], {
					initialGenerationStatus: "stopped",
				})}
				streaming={false}
				live={false}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.queryByText("Verbose build notes")).toBeNull();
		expect(document.querySelector(".build-details")?.textContent).not.toContain(
			"Writing the gallery",
		);
	});

	it("does not scroll when a reader opens a step", () => {
		const observers: Array<() => void> = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					observers.push(callback);
				}
				observe() {}
				disconnect() {}
			},
		);
		const finished = render(
			<BuildDetails message={reply([done])} streaming={false} live={false} onClose={vi.fn()} />,
		);
		const scroll = () => document.querySelector<HTMLElement>(".build-details > div:last-child")!;
		let height = 900;
		Object.defineProperties(scroll(), {
			scrollHeight: { configurable: true, get: () => height },
			clientHeight: { configurable: true, value: 200 },
		});
		scroll().scrollTop = 700;
		fireEvent.scroll(scroll());
		height = 1400;
		for (const notify of observers) notify();
		expect(scroll().scrollTop).toBe(700);
		finished.unmount();

		// While following live work, selecting text keeps following...
		render(<BuildDetails message={reply([done, running])} streaming live onClose={vi.fn()} />);
		height = 900;
		Object.defineProperties(scroll(), {
			scrollHeight: { configurable: true, get: () => height },
			clientHeight: { configurable: true, value: 200 },
		});
		scroll().scrollTop = 700;
		fireEvent.scroll(scroll());
		fireEvent.click(screen.getByText("Reading file"));
		height = 1100;
		for (const notify of observers) notify();
		expect(scroll().scrollTop).toBe(1100);
		// ...but opening a step stops it.
		fireEvent.click(screen.getByRole("button", { name: "Read file src/pages/index.astro" }));
		height = 1600;
		for (const notify of observers) notify();
		expect(scroll().scrollTop).toBe(1100);
	});

	it("keeps streaming prose readable until it settles out of customer activity", () => {
		const long = "Writing the gallery page with care. ".repeat(60);
		const grouped = (state: string) =>
			reply([{ type: "text", text: long, state }], { initialGenerationStatus: "building" });
		const view = render(
			<BuildDetails message={grouped("streaming")} streaming live onClose={vi.fn()} />,
		);
		expect(screen.queryByText("Verbose build notes")).toBeNull();
		expect(document.querySelector(".build-details")?.textContent).toContain("Writing the gallery");
		view.rerender(
			<BuildDetails message={grouped("done")} streaming={false} live={false} onClose={vi.fn()} />,
		);
		expect(screen.queryByText("Verbose build notes")).toBeNull();
		expect(document.querySelector(".build-details")?.textContent).not.toContain(
			"Writing the gallery",
		);
	});

	it("follows new work that starts after opening an idle, short timeline", () => {
		let height = 200;
		const view = render(
			<BuildDetails message={reply([done])} streaming={false} live={false} onClose={vi.fn()} />,
		);
		const scroll = view.container.querySelector<HTMLElement>(".build-details > div:last-child")!;
		Object.defineProperties(scroll, {
			scrollHeight: { configurable: true, get: () => height },
			clientHeight: { configurable: true, value: 200 },
		});
		height = 900;
		view.rerender(
			<BuildDetails message={reply([done, running])} streaming live onClose={vi.fn()} />,
		);
		expect(scroll.scrollTop).toBe(900);
	});

	it("uses the active row instead of a redundant Live badge", () => {
		render(<BuildDetails message={reply([running])} streaming live onClose={vi.fn()} />);
		expect(screen.queryByText("Live")).toBeNull();
		expect(document.querySelector('[data-tool-state="active"] .shimmer-text')).toBeTruthy();
	});
});

describe("streamed rows", () => {
	const reply = (parts: unknown[], metadata?: Record<string, unknown>) =>
		chat([{ id: "assistant-rows", role: "assistant", metadata, parts }]).messages[0];
	const wrote = (n: number) => ({
		type: "tool-write_file",
		toolCallId: `write-${n}`,
		state: "output-available",
		input: { path: `src/pages/page-${n}.astro` },
		output: { success: true },
	});

	it("keeps a step's identity and open state when an earlier row goes away", async () => {
		const user = userEvent.setup();
		const first = { type: "text", text: "First note." };
		const second = { type: "text", text: "Second note." };
		const view = render(
			<BuildDetails
				message={reply([first, second, wrote(1)])}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		const step = screen.getByRole("button", { name: "Wrote src/pages/page-1.astro" });
		await user.click(step);
		expect(step.getAttribute("aria-expanded")).toBe("true");
		view.rerender(
			<BuildDetails message={reply([second, wrote(1)])} streaming={false} onClose={vi.fn()} />,
		);
		expect(screen.getByRole("button", { name: "Wrote src/pages/page-1.astro" })).toBe(step);
		expect(step.getAttribute("aria-expanded")).toBe("true");
	});

	it("keeps a note's open state when a note before an earlier step goes away", async () => {
		const user = userEvent.setup();
		const thought = (text: string) => ({ type: "reasoning", text, state: "done" });
		const view = render(
			<BuildDetails
				message={reply([thought("Plan"), wrote(1), thought("Check the page")])}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		const later = screen.getAllByRole("button", { name: "Thought" })[1]!;
		await user.click(later);
		expect(later.getAttribute("aria-expanded")).toBe("true");
		view.rerender(
			<BuildDetails
				message={reply([wrote(1), thought("Check the page")])}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "Thought" })).toBe(later);
		expect(later.getAttribute("aria-expanded")).toBe("true");

		// The server's copy of a reply drops empty reasoning that this tab kept.
		view.rerender(
			<BuildDetails
				message={reply([wrote(1), thought(""), thought("Check the page")])}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		view.rerender(
			<BuildDetails
				message={reply([wrote(1), thought("Check the page")])}
				streaming={false}
				onClose={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "Thought" })).toBe(later);
		expect(later.getAttribute("aria-expanded")).toBe("true");
	});

	it("animates only rows that arrive after the timeline opens", () => {
		const view = render(
			<BuildDetails message={reply([wrote(1)])} streaming live onClose={vi.fn()} />,
		);
		const rowOf = (n: number) =>
			screen
				.getByRole("button", { name: `Wrote src/pages/page-${n}.astro` })
				.closest(".build-details-step")!;
		expect(rowOf(1).classList).not.toContain("timeline-row-in");
		view.rerender(
			<BuildDetails message={reply([wrote(1), wrote(2)])} streaming live onClose={vi.fn()} />,
		);
		expect(rowOf(1).classList).not.toContain("timeline-row-in");
		expect(rowOf(2).classList).toContain("timeline-row-in");
	});

	it("holds rows while a reconnect replays the running reply", () => {
		const earlier = wrote(1);
		const latest = wrote(2);
		const view = render(
			<BuildDetails message={reply([earlier, latest])} streaming live onClose={vi.fn()} />,
		);
		const names = () =>
			[...document.querySelectorAll("[data-tool-state] button")].map((button) =>
				button.getAttribute("aria-label"),
			);
		expect(names()).toHaveLength(2);
		// The replay empties the streaming reply before refilling it at once.
		view.rerender(<BuildDetails message={reply([])} streaming live onClose={vi.fn()} />);
		expect(names()).toHaveLength(2);
		view.rerender(
			<BuildDetails
				message={reply([earlier, latest, wrote(3)])}
				streaming
				live
				onClose={vi.fn()}
			/>,
		);
		expect(names()).toHaveLength(3);
		// A reply that still has parts shows them as they are, never a stale copy:
		// the library collapses a replayed duplicate note, and text keeps streaming.
		const note = (text: string) => ({ type: "text", text, state: "streaming" });
		view.rerender(
			<BuildDetails
				message={reply([earlier, note("Adding"), note("Adding the map")])}
				streaming
				live
				onClose={vi.fn()}
			/>,
		);
		view.rerender(
			<BuildDetails
				message={reply([earlier, note("Adding the map")])}
				streaming
				live
				onClose={vi.fn()}
			/>,
		);
		view.rerender(
			<BuildDetails
				message={reply([earlier, note("Adding the map and its pins")])}
				streaming
				live
				onClose={vi.fn()}
			/>,
		);
		const text = document.querySelector(".build-details")!.textContent!;
		// Streaming prose reveals a word once the next one starts.
		expect(text).toContain("Adding the map and its");
		expect(text.match(/Adding/g)).toHaveLength(1);
		// A settled reply shows what it has.
		view.rerender(
			<BuildDetails message={reply([earlier])} streaming={false} live={false} onClose={vi.fn()} />,
		);
		expect(names()).toHaveLength(1);
	});
});

describe("empty replies", () => {
	it("keeps the working card selected while its details are open", async () => {
		const user = userEvent.setup();
		const request = { id: "user-2", role: "user", parts: [{ type: "text", text: "Add a map" }] };
		const empty = { id: "empty-reply", role: "assistant", parts: [] };
		render(
			<Workspace
				messages={[firstMessage, buildMessage, request, empty]}
				streaming={false}
				serverTurnActive
			/>,
		);
		const actions = screen.getAllByRole("button", { name: "View activity" });
		await user.click(actions[1]!);
		expect(actions[1]!.getAttribute("aria-current")).toBe("true");
		expect(
			within(screen.getByRole("region", { name: "Build activity" })).queryByText(
				"No activity recorded for this response.",
			),
		).toBeNull();
	});
});

describe("streamed rows in the first build", () => {
	it("holds a grouped build's rows while its newest reply replays", async () => {
		const user = userEvent.setup();
		const building: InitialGeneration = { id: "user-1", status: "building" };
		const build = {
			id: "assistant-build",
			role: "assistant",
			metadata: { initialGenerationId: "user-1" },
			parts: [
				{
					type: "tool-write_file",
					toolCallId: "write-grouped",
					state: "output-available",
					input: { path: "src/pages/index.astro" },
					output: { success: true },
				},
			],
		};
		const messages = (reply: typeof build) => [
			firstMessage,
			interviewMessage,
			structuredAnswer,
			reply,
		];
		const view = render(
			<Workspace messages={messages(build)} initialGeneration={building} streaming />,
		);
		await user.click(screen.getByRole("button", { name: "View activity" }));
		const details = screen.getByRole("region", { name: "Build activity" });
		expect(within(details).getByText("Questions answered")).toBeTruthy();
		expect(
			within(details).getByRole("button", { name: "Wrote src/pages/index.astro" }),
		).toBeTruthy();
		view.rerender(
			<Workspace
				messages={messages({ ...build, parts: [] })}
				initialGeneration={building}
				streaming
			/>,
		);
		expect(
			within(details).getByRole("button", { name: "Wrote src/pages/index.astro" }),
		).toBeTruthy();
	});
});
