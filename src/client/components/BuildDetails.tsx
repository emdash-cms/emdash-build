import { ArrowLeft } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { Check } from "@phosphor-icons/react/Check";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleDashed } from "@phosphor-icons/react/CircleDashed";
import { Database } from "@phosphor-icons/react/Database";
import { FileCode } from "@phosphor-icons/react/FileCode";
import { ImageSquare } from "@phosphor-icons/react/ImageSquare";
import { Lightbulb } from "@phosphor-icons/react/Lightbulb";
import { Question } from "@phosphor-icons/react/Question";
import { Stop } from "@phosphor-icons/react/Stop";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { X } from "@phosphor-icons/react/X";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { useAgentChat } from "@cloudflare/ai-chat/react";
import { getReasoningDurationMs } from "../../shared/reasoning.js";
import type { InitialGeneration } from "../../shared/initial-generation.js";
import type { QuestionnaireSubmission } from "../../shared/questionnaire.js";
import { isInitialGenerationActive, projectInitialGeneration } from "../initial-generation.js";
import {
	findQuestionnaireResponse,
	isAskQuestionsToolPart,
	parseClarifyingQuestions,
} from "../../shared/questionnaire.js";
import { Markdown } from "./Markdown.js";
import { ReasoningBlock } from "./ReasoningBlock.js";
import { ShimmerText } from "./ShimmerText.js";
import { getUploadImages, thumbUrl, ToolCard, type ToolCorrectionState } from "./ToolCard.js";

type Chat = ReturnType<typeof useAgentChat>;

/** How long nothing may visibly move before the timeline says work continues. */
const IDLE_ROW_DELAY_MS = 300;
export type ChatMessage = Chat["messages"][number];
type MessagePart = NonNullable<ChatMessage["parts"]>[number];

/**
 * A server turn that ends without a chunk (a skipped auto-build) leaves an
 * empty assistant message on watching tabs. It is not a reply, so it must not
 * stand in for a turn's response or hide its working card. The last one stays
 * while streaming: a reconnect replay empties the running reply to refill it.
 */
export function withoutEmptyReplies(messages: ChatMessage[], streaming: boolean): ChatMessage[] {
	const kept = messages.filter(
		(message, index) =>
			message.role !== "assistant" ||
			(message.parts?.length ?? 0) > 0 ||
			(streaming && index === messages.length - 1),
	);
	return kept.length === messages.length ? messages : kept;
}

export function resolveDetails(
	messages: ChatMessage[],
	selectedId: string | null,
	fallback?: { index: number; role: "user" | "assistant" } | null,
	initialGeneration?: InitialGeneration,
) {
	if (selectedId && selectedId === initialGeneration?.id) {
		const group = projectInitialGeneration(messages, initialGeneration);
		if (group) {
			return {
				message: group.message,
				isLatestTurn: !["ready", "stopped", "failed"].includes(initialGeneration.status),
			};
		}
	}
	let index = messages.findIndex((message) => message.id === selectedId);
	if (selectedId && index < 0 && fallback && messages[fallback.index]?.role === fallback.role) {
		index = fallback.index;
	}
	if (index < 0) return { message: undefined, isLatestTurn: false };
	const selected = messages[index];
	if (selected?.role === "assistant") {
		return { message: selected, isLatestTurn: index === messages.length - 1 };
	}
	if (selected?.role !== "user") return { message: undefined, isLatestTurn: false };
	let response: ChatMessage | undefined;
	for (let next = index + 1; next < messages.length; next++) {
		if (messages[next]?.role === "user") return { message: response, isLatestTurn: false };
		if (messages[next]?.role === "assistant") response = messages[next];
	}
	return { message: response, isLatestTurn: true };
}

/**
 * A turn is working from the moment it is sent, not from its first chunk. The
 * agent's `turnActive` flag covers tabs that did not send it (a reload, a
 * second tab, a server-started turn) before its stream reaches them.
 */
export function isTurnActive(
	chat: Pick<Chat, "isStreaming" | "status">,
	serverTurnActive = false,
): boolean {
	return chat.isStreaming || chat.status === "submitted" || serverTurnActive;
}

/**
 * Decide what the details page may animate. The agent's status line is
 * session-wide (preview restores set it too), so it only belongs to the
 * selected turn while that turn is genuinely running.
 */
export function detailsActivity({
	turnActive,
	isStreaming,
	isLatestTurn,
	message,
	initialGeneration,
	status,
}: {
	turnActive: boolean;
	isStreaming: boolean;
	isLatestTurn: boolean;
	message?: ChatMessage;
	initialGeneration?: InitialGeneration;
	status: string;
}) {
	const generationActive =
		initialGeneration !== undefined &&
		message?.id === initialGeneration.id &&
		isInitialGenerationActive(initialGeneration.status);
	const live = isLatestTurn && (turnActive || generationActive);
	return {
		live,
		streaming: isLatestTurn && isStreaming,
		status: live && status ? status : undefined,
	};
}

export function setupAnswerForDetails(messages: ChatMessage[], selectedId: string | null) {
	const selectedIndex = messages.findIndex((message) => message.id === selectedId);
	if (selectedIndex < 0) return undefined;
	const response = findQuestionnaireResponse(messages.slice(0, selectedIndex + 1));
	const answerIndex = messages.findIndex((message) => message.id === response?.answerMessageId);
	if (answerIndex < 0 || selectedIndex < answerIndex) return undefined;
	if (
		messages.slice(answerIndex + 1, selectedIndex + 1).some((message) => message.role === "user")
	) {
		return undefined;
	}
	return messages[answerIndex]?.parts
		?.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function parseSetupAnswers(text: string) {
	return [
		...text.matchAll(
			/(?:^|\n\n)Q: ([^\n]+)\nA: ([\s\S]*?)(?=\n\nQ: |\n\nUse your recommended defaults|$)/g,
		),
	].map((match) => ({ question: match[1]?.trim() ?? "", answer: match[2]?.trim() ?? "" }));
}

export function setupAnswerSummaryForDetails(messages: ChatMessage[], selectedId: string | null) {
	const text = setupAnswerForDetails(messages, selectedId);
	if (!text) return undefined;
	const answers = parseSetupAnswers(text);
	return (
		answers.find(({ question }) => /\b(design|direction|style|visual)\b/i.test(question)) ??
		answers[0]
	);
}

export function isActivityTool(part: MessagePart): boolean {
	return (
		(part.type === "dynamic-tool" || part.type.startsWith("tool-")) && !isAskQuestionsToolPart(part)
	);
}

function activityToolName(part: MessagePart): string {
	return part.type === "dynamic-tool" ? String(part.toolName ?? "") : part.type.slice(5);
}

function ToolMarker({ part }: { part: MessagePart }) {
	const name = activityToolName(part);
	const Icon = ["search_unsplash", "upload_media", "view_preview", "media_list"].includes(name)
		? ImageSquare
		: /^(content_|schema_|settings_|menu_|taxonomy_|byline_)/.test(name) ||
			  ["create_entries_batch", "apply_schema_plan", "update_blocks_field", "search"].includes(
					name,
			  )
			? Database
			: FileCode;
	return <Icon size={15} className="build-details-marker" aria-hidden="true" />;
}

function isToolDone(part: MessagePart): boolean {
	const state = (part as { state?: string }).state;
	return ["output-available", "output-error", "output-denied", "result"].includes(state ?? "");
}

const CORRECTABLE_SOURCE_TOOLS = new Set(["write_file", "write_files", "edit_file", "edit_files"]);

function toolOutput(part: MessagePart): Record<string, unknown> {
	const candidate =
		(part as { output?: unknown; result?: unknown }).output ??
		(part as { result?: unknown }).result;
	return candidate && typeof candidate === "object" && !Array.isArray(candidate)
		? (candidate as Record<string, unknown>)
		: {};
}

function isSuccessfulSourceMutation(part: MessagePart): boolean {
	if (
		!isActivityTool(part) ||
		!isToolDone(part) ||
		!CORRECTABLE_SOURCE_TOOLS.has(activityToolName(part))
	) {
		return false;
	}
	const output = toolOutput(part);
	return output.success === true && output.changed === true;
}

function correctionStates(
	parts: MessagePart[],
	live: boolean,
	liveFromPart: number,
): Map<number, ToolCorrectionState> {
	let latestSuccessfulValidation = -1;
	let latestSuccessfulPreview = -1;
	for (const [index, part] of parts.entries()) {
		if (!isActivityTool(part) || !isToolDone(part) || toolOutput(part).success !== true) continue;
		const name = activityToolName(part);
		if (name === "validate_site") latestSuccessfulValidation = index;
		if (name === "view_preview") latestSuccessfulPreview = index;
	}

	const states = new Map<number, ToolCorrectionState>();
	for (const [index, part] of parts.entries()) {
		if (!isActivityTool(part) || !isToolDone(part)) continue;
		const name = activityToolName(part);
		const output = toolOutput(part);
		const interrupted =
			(part as { state?: string }).state === "output-error" ||
			(output.success === false && output.retryable === true);
		const laterSuccessfulRetry =
			name === "validate_site"
				? latestSuccessfulValidation
				: name === "view_preview"
					? latestSuccessfulPreview
					: -1;
		if ((name === "validate_site" || name === "view_preview") && interrupted) {
			if (index < laterSuccessfulRetry) states.set(index, "retried");
			else if (live && index >= liveFromPart) states.set(index, "retrying");
			continue;
		}
		if (name === "view_preview" && output.success === false) {
			if (index < latestSuccessfulPreview) states.set(index, "retried");
			else if (live && index >= liveFromPart) states.set(index, "retrying");
			continue;
		}
		const validationFailure =
			name === "validate_site" && output.success === false && output.retryable !== true;
		const sourceFailure =
			CORRECTABLE_SOURCE_TOOLS.has(name) && output.success === false && output.changed === false;
		const correctable = validationFailure || sourceFailure;
		if (!correctable) continue;
		const sourceWasRetried =
			!sourceFailure ||
			parts
				.slice(index + 1, latestSuccessfulValidation)
				.some((candidate) => isSuccessfulSourceMutation(candidate));
		if (index < latestSuccessfulValidation && sourceWasRetried) states.set(index, "recovered");
		else if (live && index >= liveFromPart) states.set(index, "recovering");
	}
	return states;
}

/** Executing, not still streaming its input: only then can it set the status line. */
function isToolExecuting(part: MessagePart): boolean {
	const state = (part as { state?: string }).state;
	return !isToolDone(part) && state !== "input-streaming" && state !== "partial-call";
}

/**
 * A live line on the timeline's marker and label columns, sized like a step.
 * Visual only: one persistent region announces the status so updates are not
 * lost when this row mounts or gives way to a running step.
 */
function LiveStep({ children, shimmer = true }: { children: string; shimmer?: boolean }) {
	return (
		<div className="build-details-step relative mb-3" data-live-step>
			<CircleDashed size={15} className="build-details-marker" aria-hidden="true" />
			<div className="my-1 border border-transparent px-4 py-1.5">
				<div className="flex min-h-7 min-w-0 items-center">
					{/* Keyed so a new line fades in; the fade sits outside the shimmer's animation. */}
					<span key={children} className="build-details-live-label flex min-w-0">
						{shimmer ? (
							<ShimmerText className="min-w-0 truncate text-[13px] leading-snug">
								{children}
							</ShimmerText>
						) : (
							<span className="min-w-0 truncate text-[13px] leading-snug text-text-tertiary">
								{children}
							</span>
						)}
					</span>
				</div>
			</div>
		</div>
	);
}

/**
 * The one live line at the end of the timeline. It stays mounted and opens
 * or folds away, so work starting or finishing never makes the list jump.
 */
function LiveRow({ open, label }: { open: boolean; label: string }) {
	const [shown, setShown] = useState(label);
	if (open && shown !== label) setShown(label);
	return (
		<div className="build-details-live-row" data-live-row data-open={open}>
			<div className="build-details-live-row-clip" aria-hidden={open ? undefined : true}>
				{/* A folding row fades out with its last words, no longer animating. */}
				<LiveStep shimmer={open}>{shown}</LiveStep>
			</div>
		</div>
	);
}

/**
 * Row identity that survives the list shifting: a tool call by its id, other
 * rows by their place among rows of their type since the last tool call. A
 * removed or collapsed note then renumbers only the notes beside it, never a
 * step or the notes after a later step.
 */
function partKeys(parts: MessagePart[]): string[] {
	let anchor = "start";
	let seen = new Map<string, number>();
	return parts.map((part, index) => {
		const callId = (part as { toolCallId?: unknown }).toolCallId;
		if (typeof callId === "string") {
			anchor = callId;
			seen = new Map();
			return `${part.type}:${callId}`;
		}
		// Only notes that render take a number: the server's copy of a reply
		// drops empty reasoning, and must not renumber the notes after it.
		const text = (part as { text?: unknown }).text;
		if (typeof text === "string" && !text.trim()) return `${part.type}@${anchor}~${index}`;
		const count = seen.get(part.type) ?? 0;
		seen.set(part.type, count + 1);
		return `${part.type}@${anchor}#${count}`;
	});
}

export function finalTextIndex(parts: MessagePart[]): number {
	let lastActionIndex = -1;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (part && isActivityTool(part)) lastActionIndex = index;
	}
	for (let index = parts.length - 1; index >= 0; index--) {
		if (
			parts[index]?.type === "text" &&
			(parts[index] as { text?: string }).text?.trim() &&
			!isInternalBuildText(parts, index)
		) {
			return index > lastActionIndex ? index : -1;
		}
	}
	return -1;
}

function markdownOutsideFences(text: string): string {
	let fenceLength = 0;
	const visible: string[] = [];
	for (const line of text.split("\n")) {
		if (fenceLength > 0) {
			const close = /^ {0,3}(`{3,})[\t ]*$/.exec(line)?.[1];
			if (close?.length === fenceLength) fenceLength = 0;
			continue;
		}
		const open = /^ {0,3}(`{3,})[^`]*$/.exec(line)?.[1];
		if (open) {
			fenceLength = open.length;
			continue;
		}
		visible.push(line);
	}
	return visible.join("\n");
}

function isLeakedToolSyntax(text: string): boolean {
	return /(?:^|\n)\s*(?:to|recipient)=functions\.[^\n]*/.test(markdownOutsideFences(text));
}

function jsonObjectText(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return;
	}
}

const TOOL_PROTOCOL_KEYS = new Set([
	"arguments",
	"parameters",
	"recipient",
	"recipientname",
	"toolcall",
	"toolcalls",
	"tooluse",
	"tooluses",
]);
const TOOL_RESULT_KEYS = new Set(["changed", "error", "retryable", "success"]);

function normalizedJsonKey(key: string): string {
	return key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

function normalizedJsonObject(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [normalizedJsonKey(key), item]),
	);
}

function isProjectFilePath(value: unknown): boolean {
	return (
		typeof value === "string" &&
		!value.startsWith("/") &&
		(value.includes("/") || /\.[a-z0-9]+$/i.test(value))
	);
}

function hasSourceFileShape(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const object = normalizedJsonObject(value as Record<string, unknown>);
	return (
		isProjectFilePath(object.path) &&
		("content" in object || "oldtext" in object || "newtext" in object)
	);
}

function isToolProtocolObject(value: Record<string, unknown>): boolean {
	const object = normalizedJsonObject(value);
	const keys = Object.keys(object);
	if (keys.length === 0 || keys.some((key) => TOOL_PROTOCOL_KEYS.has(key))) return true;
	if (keys.some((key) => TOOL_RESULT_KEYS.has(key))) return true;
	if ("command" in object || "cmd" in object) return true;
	if (isProjectFilePath(object.path)) return true;
	if (
		typeof object.query === "string" &&
		(keys.length === 1 || ["count", "orientation", "page", "perpage"].some((key) => key in object))
	) {
		return true;
	}
	if (
		Array.isArray(object.paths) &&
		object.paths.length > 0 &&
		object.paths.every(isProjectFilePath)
	) {
		return true;
	}
	if (Array.isArray(object.files) && object.files.some(hasSourceFileShape)) return true;
	if (Array.isArray(object.edits) && object.edits.some(hasSourceFileShape)) return true;
	if (
		keys.length === 1 &&
		"images" in object &&
		Array.isArray(object.images) &&
		object.images.some((image) => {
			if (!image || typeof image !== "object" || Array.isArray(image)) return false;
			const item = normalizedJsonObject(image as Record<string, unknown>);
			return typeof item.url === "string" && ("alt" in item || "filename" in item);
		})
	) {
		return true;
	}
	return false;
}

function isInternalBuildText(
	parts: MessagePart[],
	index: number,
	{
		stillStreaming = false,
		hideSettledLongText = false,
	}: { stillStreaming?: boolean; hideSettledLongText?: boolean } = {},
): boolean {
	const part = parts[index];
	if (part?.type !== "text") return false;
	if (isLeakedToolSyntax(part.text)) return true;
	const object = jsonObjectText(part.text);
	if (part.text.trim().startsWith("{") && !object) return true;
	const previous = parts[index - 1];
	if (
		object &&
		(isToolProtocolObject(object) ||
			(previous?.type === "text" && isLeakedToolSyntax(previous.text)))
	) {
		return true;
	}
	return hideSettledLongText && !stillStreaming && part.text.length > 1_800;
}

export function initialGenerationFinalTextIndex(parts: MessagePart[]): number {
	let lastActionIndex = -1;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (part && isActivityTool(part)) lastActionIndex = index;
	}
	for (let index = parts.length - 1; index > lastActionIndex; index--) {
		const part = parts[index];
		if (
			part?.type === "text" &&
			part.text.trim() &&
			!isInternalBuildText(parts, index, { hideSettledLongText: true })
		) {
			return index;
		}
	}
	return -1;
}

function formatBuildDuration(durationMs: number): string {
	const seconds = Math.max(1, Math.round(durationMs / 1000));
	return formatDurationSeconds(seconds);
}

function formatDurationSeconds(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function useElapsedTime(active: boolean, startedAt?: number): string | undefined {
	const fallbackStartedAt = useRef<number | undefined>(undefined);
	const [now, setNow] = useState(Date.now);
	if (active && startedAt === undefined && fallbackStartedAt.current === undefined) {
		fallbackStartedAt.current = Date.now();
	}
	if (!active) fallbackStartedAt.current = undefined;
	const effectiveStartedAt = startedAt ?? fallbackStartedAt.current;

	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [active, startedAt]);

	return active && effectiveStartedAt !== undefined
		? formatDurationSeconds(Math.max(0, Math.floor((now - effectiveStartedAt) / 1_000)))
		: undefined;
}

export function activityImage(message?: ChatMessage) {
	for (const part of [...(message?.parts ?? [])].reverse()) {
		if (
			(part.type !== "tool-upload_media" &&
				!(part.type === "dynamic-tool" && part.toolName === "upload_media")) ||
			part.state === "output-error"
		) {
			continue;
		}
		const input = (part.input ?? {}) as Record<string, unknown>;
		const output = (part.output ?? {}) as {
			success?: boolean;
			results?: { url?: string; success?: boolean }[];
		};
		if (output.success === false) continue;
		const successfulUrls = new Set(
			output.results?.filter((item) => item.success).map((item) => item.url),
		);
		if (output.results?.length && successfulUrls.size === 0) continue;
		for (const image of getUploadImages(input)) {
			if (!image.url || (successfulUrls.size > 0 && !successfulUrls.has(image.url))) continue;
			try {
				if (new URL(image.url).protocol === "https:") {
					return { url: thumbUrl(image.url, 600), alt: image.alt || "Image added to the site" };
				}
			} catch {
				continue;
			}
		}
	}
	return undefined;
}

function activityTitle(message: ChatMessage | undefined, active: boolean): string {
	if (active) return "Working on your request";
	const parts = message?.parts ?? [];
	const finalIndex = finalTextIndex(parts);
	const finalText = finalIndex >= 0 ? parts[finalIndex] : undefined;
	return finalText?.type === "text" ? "Update complete" : "Activity";
}

type ProgressPhaseState = "active" | "complete" | "pending" | "failed";

interface ProgressPhase {
	id: "direction" | "build" | "review" | "change" | "check" | "failure";
	label: string;
	state: ProgressPhaseState;
}

function ProgressPhaseIcon({ state, step }: { state: ProgressPhaseState; step: number }) {
	const showRing = state === "active" || state === "pending";
	return (
		<span
			aria-hidden="true"
			data-phase-icon={state}
			className="relative inline-flex size-6 shrink-0 items-center justify-center"
		>
			<svg
				viewBox="0 0 24 24"
				className={`absolute inset-0 size-6 text-text-tertiary/45 motion-safe:transition-opacity motion-safe:duration-200 ${showRing ? "opacity-100" : "opacity-0"}`}
			>
				<circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
			</svg>
			<svg
				viewBox="0 0 24 24"
				className={`absolute inset-0 size-6 text-accent-text motion-safe:transition-opacity motion-safe:duration-200 ${state === "active" ? "opacity-100 motion-safe:animate-spin" : "opacity-0"}`}
			>
				<circle
					cx="12"
					cy="12"
					r="10.5"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeDasharray="17 49"
				/>
			</svg>
			<span
				className={`relative text-[10px] font-semibold tabular-nums motion-safe:transition-opacity motion-safe:duration-200 ${showRing ? "opacity-100" : "opacity-0"} ${state === "active" ? "text-text-primary" : "text-text-tertiary"}`}
			>
				{step}
			</span>
			<span
				className={`absolute inset-0 flex items-center justify-center motion-safe:transition-[opacity,scale,filter] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${state === "complete" ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]"}`}
			>
				<span className="flex size-[22px] items-center justify-center rounded-full bg-success text-sidebar">
					<Check size={12} weight="bold" />
				</span>
			</span>
			<span
				className={`absolute inset-0 flex items-center justify-center motion-safe:transition-[opacity,scale,filter] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${state === "failed" ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]"}`}
			>
				<span className="flex size-[22px] items-center justify-center rounded-full bg-danger text-sidebar">
					<X size={11} weight="bold" />
				</span>
			</span>
		</span>
	);
}

function ProgressPhaseRows({ label, phases }: { label: string; phases: ProgressPhase[] }) {
	const stateLabel = {
		active: "In progress",
		complete: "Completed",
		pending: "Upcoming",
		failed: "Failed",
	};

	return (
		<ol aria-label={label} className="space-y-1">
			{phases.map((phase, index) => (
				<li
					key={phase.id}
					data-phase-state={phase.state}
					aria-current={phase.state === "active" ? "step" : undefined}
					className={`flex min-h-10 min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-1.5 ${phase.state === "active" ? "bg-surface-sunken" : ""}`}
				>
					<ProgressPhaseIcon state={phase.state} step={index + 1} />
					<span className="sr-only">{stateLabel[phase.state]}: </span>
					<span
						className={`min-w-0 truncate text-[13px] leading-snug ${phase.state === "active" ? "font-medium text-text-primary" : phase.state === "failed" ? "font-medium text-danger" : phase.state === "complete" ? "text-text-secondary" : "text-text-tertiary opacity-65"}`}
					>
						{phase.label}
					</span>
				</li>
			))}
		</ol>
	);
}

function initialProgressPhases(phase: InitialGeneration["status"] | undefined): ProgressPhase[] {
	if (phase === "failed") {
		return [{ id: "failure", label: "Couldn’t finish the build", state: "failed" }];
	}
	if (phase === "preparing") {
		return [
			{ id: "direction", label: "Confirming your direction", state: "active" },
			{ id: "build", label: "Building content and pages", state: "pending" },
			{ id: "review", label: "Reviewing the site", state: "pending" },
		];
	}
	if (phase === "building") {
		return [
			{ id: "direction", label: "Direction confirmed", state: "complete" },
			{ id: "build", label: "Building content and pages", state: "active" },
			{ id: "review", label: "Reviewing the site", state: "pending" },
		];
	}
	if (phase === "checking") {
		return [
			{ id: "direction", label: "Direction confirmed", state: "complete" },
			{ id: "build", label: "Content and pages built", state: "complete" },
			{ id: "review", label: "Reviewing the site", state: "active" },
		];
	}
	return [];
}

function isReviewActivity(part: MessagePart): boolean {
	if (!isActivityTool(part)) return false;
	const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
	return name === "validate_site" || name === "view_preview";
}

function followUpProgressPhases(message?: ChatMessage, status?: string): ProgressPhase[] {
	const latestActivity = [...(message?.parts ?? [])].reverse().find(isActivityTool);
	const checking = latestActivity
		? isReviewActivity(latestActivity)
		: /^(checking|reviewing|validating)\b/i.test(status ?? "");
	return checking
		? [
				{ id: "change", label: "Working on your request", state: "complete" },
				{ id: "check", label: "Checking the site", state: "active" },
			]
		: [
				{ id: "change", label: "Working on your request", state: "active" },
				{ id: "check", label: "Checking the site", state: "pending" },
			];
}

export function BuildActivityCard({
	message,
	active,
	status,
	selected = false,
	answerSummary,
	initialGeneration,
	buildDurationMs,
	startedAt,
	loadPreviewThumbnail,
	onPreview,
	onSelect,
}: {
	message?: ChatMessage;
	active: boolean;
	status?: string;
	selected?: boolean;
	answerSummary?: { question: string; answer: string };
	initialGeneration?: InitialGeneration;
	buildDurationMs?: number;
	startedAt?: number;
	loadPreviewThumbnail?: (
		shotId: string,
	) => Promise<{ base64: string; mediaType: "image/png" } | null>;
	onPreview?: () => void;
	onSelect: () => void;
}) {
	const image = initialGeneration ? undefined : activityImage(message);
	const phase = initialGeneration?.status;
	const buildTime =
		phase === "ready" &&
		typeof buildDurationMs === "number" &&
		Number.isFinite(buildDurationMs) &&
		buildDurationMs >= 0
			? `Built in ${formatBuildDuration(buildDurationMs)}`
			: undefined;
	const acceptedShotId = phase === "ready" ? initialGeneration?.previewShotId : undefined;
	const [previewImage, setPreviewImage] = useState<{
		shotId: string;
		src?: string;
		unavailable?: boolean;
	}>();
	useEffect(() => {
		if (!acceptedShotId || !loadPreviewThumbnail) return;
		let cancelled = false;
		void loadPreviewThumbnail(acceptedShotId)
			.then((shot) => {
				if (cancelled) return;
				setPreviewImage(
					shot?.mediaType === "image/png" && shot.base64
						? { shotId: acceptedShotId, src: `data:image/png;base64,${shot.base64}` }
						: { shotId: acceptedShotId, unavailable: true },
				);
			})
			.catch(() => {
				if (!cancelled) setPreviewImage({ shotId: acceptedShotId, unavailable: true });
			});
		return () => {
			cancelled = true;
		};
	}, [acceptedShotId, loadPreviewThumbnail]);
	const title = phase
		? {
				preparing: active ? "Preparing your site" : "Build pending",
				awaiting_answers: "Waiting for your answers",
				building: "Building your site",
				checking: "Checking your site",
				stopping: "Stopping build",
				ready: "Your site is ready",
				stopped: "Build stopped",
				failed: "Build needs attention",
			}[phase]
		: activityTitle(message, active);
	const working =
		phase === "stopping" ||
		(active && phase !== "failed" && phase !== "stopped" && phase !== "awaiting_answers");
	const elapsedTime = useElapsedTime(working, startedAt);
	const progressPhases = initialGeneration
		? working || phase === "failed"
			? initialProgressPhases(phase)
			: []
		: working
			? followUpProgressPhases(message, status)
			: [];
	const titleId = useId();
	return (
		<div
			className={`my-3 w-full max-w-[420px] overflow-hidden rounded-2xl border bg-surface-raised shadow-sm ${selected ? "border-accent/60 ring-1 ring-accent/30" : "border-border"}`}
		>
			<div className="flex min-h-11 items-center gap-2 border-b border-border px-3.5 py-2.5 text-[13px] font-medium text-text-primary">
				{phase === "failed" ? (
					<WarningCircle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
				) : phase === "stopped" || phase === "stopping" ? (
					<Stop size={16} className="mt-0.5 shrink-0 text-text-secondary" aria-hidden="true" />
				) : phase === "awaiting_answers" ? (
					<Question size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
				) : phase === "preparing" && !working ? (
					<CircleDashed
						size={16}
						className="mt-0.5 shrink-0 text-text-tertiary"
						aria-hidden="true"
					/>
				) : working ? (
					<CircleDashed size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
				) : (
					<CheckCircle size={16} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
				)}
				<span id={titleId} className="min-w-0 flex-1 line-clamp-2 leading-snug">
					{working ? <ShimmerText>{title}</ShimmerText> : title}
				</span>
				{elapsedTime ? (
					<span
						aria-label={`Elapsed time ${elapsedTime}`}
						className="shrink-0 text-xs font-normal tabular-nums text-text-tertiary"
					>
						{elapsedTime}
					</span>
				) : null}
			</div>
			{answerSummary ? (
				<div className="border-b border-border px-3.5 py-2.5">
					<p className="line-clamp-2 text-[11px] text-text-tertiary">{answerSummary.question}</p>
					<p className="mt-1 line-clamp-2 text-xs font-medium text-text-primary">
						• {answerSummary.answer}
					</p>
				</div>
			) : null}
			<div className="px-3.5 py-2.5">
				{buildTime ? <p className="text-xs text-text-secondary">{buildTime}</p> : null}
				{phase === "awaiting_answers" ? (
					<p className="line-clamp-2 text-xs leading-relaxed text-text-secondary">
						Answer the design questions to continue.
					</p>
				) : null}
				{progressPhases.length ? (
					<div className={buildTime || phase === "awaiting_answers" ? "mt-2.5" : undefined}>
						<ProgressPhaseRows
							label={initialGeneration ? "Build progress" : "Change progress"}
							phases={progressPhases}
						/>
					</div>
				) : null}
				{image ? (
					<figure className="mt-2.5">
						<img
							src={image.url}
							alt={image.alt}
							loading="lazy"
							className="aspect-[16/9] w-full rounded-lg border border-border object-cover"
						/>
						<figcaption className="mt-1 text-[11px] text-text-tertiary">
							Image added to the site
						</figcaption>
					</figure>
				) : null}
				{acceptedShotId && previewImage?.shotId === acceptedShotId && previewImage.src ? (
					<figure className="mt-2.5">
						<img
							src={previewImage.src}
							alt="Screenshot of your generated site"
							className="aspect-[16/9] w-full rounded-lg border border-border object-cover"
							loading="lazy"
						/>
						<figcaption className="mt-1 text-[11px] text-text-tertiary">Site preview</figcaption>
					</figure>
				) : acceptedShotId &&
				  previewImage?.shotId === acceptedShotId &&
				  previewImage.unavailable ? (
					<p className="mt-2 text-xs text-text-secondary">Preview image unavailable</p>
				) : null}
				<div className="mt-3 flex min-h-9 items-center justify-end gap-2">
					{phase === "ready" && onPreview ? (
						<button
							type="button"
							onClick={onPreview}
							className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-accent px-3 text-xs font-medium text-white transition-[background-color,scale] duration-150 hover:bg-accent-hover active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
						>
							Preview site <ArrowRight size={14} aria-hidden="true" />
						</button>
					) : null}
					<button
						type="button"
						onClick={onSelect}
						aria-current={selected ? "true" : undefined}
						aria-describedby={titleId}
						className="group/activity inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-border px-3 text-xs font-medium text-text-primary transition-[background-color,color,scale] duration-150 hover:bg-surface-sunken hover:text-accent-text active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						View activity
						<ArrowRight
							size={14}
							className="transition-transform duration-150 group-hover/activity:translate-x-0.5 motion-reduce:transition-none"
							aria-hidden="true"
						/>
					</button>
				</div>
			</div>
		</div>
	);
}

function QuestionsAnswered({
	answers,
	usingDefaults,
	rawText,
	className = "",
}: {
	answers: { question: string; answer: string }[];
	usingDefaults: boolean;
	rawText?: string;
	className?: string;
}) {
	return (
		<div className={`build-details-step relative mb-4 ${className}`.trim()}>
			<Question size={15} className="build-details-marker" aria-hidden="true" />
			<div className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm shadow-sm">
				<h3 className="font-medium text-text-primary">Questions answered</h3>
				{answers.length ? (
					<dl className="mt-3 space-y-3">
						{answers.map(({ question, answer }) => (
							<div key={question}>
								<dt className="text-xs text-text-secondary">{question}</dt>
								<dd className="mt-1 whitespace-pre-wrap font-medium text-text-primary">{answer}</dd>
							</div>
						))}
					</dl>
				) : rawText && !usingDefaults ? (
					<p className="mt-2 whitespace-pre-wrap text-text-secondary">{rawText}</p>
				) : null}
				{usingDefaults ? (
					<p className="mt-3 text-xs text-text-secondary">
						{answers.length
							? "Use recommended defaults for questions not answered."
							: "Using recommended defaults."}
					</p>
				) : null}
			</div>
		</div>
	);
}

export function BuildDetails({
	message,
	status,
	streaming,
	live: liveProp,
	resumingPreview = false,
	setupAnswer,
	loadPreviewThumbnail,
	onClose,
}: {
	message?: ChatMessage;
	status?: string;
	/** The selected turn's stream is open, so its unfinished parts are running. */
	streaming: boolean;
	/** The selected turn is working, including before its first chunk arrives. */
	live?: boolean;
	/** This tab is reopening the preview, which owns the status line meanwhile. */
	resumingPreview?: boolean;
	setupAnswer?: string;
	loadPreviewThumbnail?: (
		shotId: string,
	) => Promise<{ base64: string; mediaType: "image/png" } | null>;
	onClose: () => void;
}) {
	const live = liveProp ?? (streaming || Boolean(status));
	const scrollRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const followRef = useRef(live);
	const liveRef = useRef(live);
	const measured = useRef({ height: 0, live });
	const rawParts = message?.parts ?? [];
	const metadata = message?.metadata as
		| { initialGenerationStatus?: unknown; liveFromPart?: unknown; liveMessageId?: unknown }
		| undefined;
	const groupedStatus = metadata?.initialGenerationStatus;
	// The reply that can still stream: the message itself, or a grouped first
	// build's newest reply.
	const replyId = groupedStatus
		? typeof metadata?.liveMessageId === "string"
			? metadata.liveMessageId
			: undefined
		: message?.id;
	// A grouped first build can hold an earlier stopped attempt whose unfinished
	// parts must stay stopped while the retry streams.
	const liveFromPart = typeof metadata?.liveFromPart === "number" ? metadata.liveFromPart : 0;
	// A reconnect replays the running reply: it empties, then refills at once.
	// Keep what was shown only for that shape (the same reply, now without any
	// parts of its own, after rows that did not change); any other shrink, such
	// as a collapsed duplicate note, shows as it is so live text never freezes.
	const shown = useRef<{ replyId?: string; parts: MessagePart[]; keys: string[] }>({
		parts: [],
		keys: [],
	});
	const rawKeys = partKeys(rawParts);
	const replaying =
		live &&
		replyId !== undefined &&
		replyId === shown.current.replyId &&
		rawParts.length === liveFromPart &&
		rawKeys.length < shown.current.keys.length &&
		rawKeys.every((key, index) => key === shown.current.keys[index]);
	const parts = replaying ? shown.current.parts : rawParts;
	const keys = replaying ? shown.current.keys : rawKeys;
	// Rows already there when the page opened do not animate; later ones do.
	const [openedWith] = useState(() => new Set(keys));
	const enterClass = (key: string) => (openedWith.has(key) ? "" : " timeline-row-in");
	const answers = setupAnswer ? parseSetupAnswers(setupAnswer) : [];
	const groupedReady = groupedStatus === "ready";
	const finalIndex = groupedReady ? initialGenerationFinalTextIndex(parts) : -1;
	const hasContent =
		Boolean(setupAnswer) ||
		parts.some(
			(part, index) =>
				isActivityTool(part) ||
				isAskQuestionsToolPart(part) ||
				part.type === "data-questionnaire-answers" ||
				((part.type === "text" || part.type === "reasoning") &&
					Boolean((part as { text?: string }).text?.trim()) &&
					!(
						part.type === "text" &&
						isInternalBuildText(parts, index, {
							stillStreaming:
								streaming &&
								index >= liveFromPart &&
								(part as { state?: string }).state === "streaming",
							hideSettledLongText: Boolean(groupedStatus),
						})
					)),
		);
	const corrections = correctionStates(parts, live, liveFromPart);
	// The status line has no tool identity. When exactly one step is executing
	// it can only describe that step, so show it there, not twice, unless a
	// preview restore (a reload mid-turn) is what set it.
	const runningTools = streaming
		? parts.flatMap((part, index) =>
				index >= liveFromPart && isActivityTool(part) && isToolExecuting(part) ? [index] : [],
			)
		: [];
	const soleRunning = runningTools.length === 1 ? runningTools[0]! : -1;
	const statusStep = live && status && !resumingPreview && soleRunning >= 0 ? soleRunning : -1;
	// Something on screen already moves (a running step, streaming words);
	// otherwise the live row says work continues between steps.
	const visiblyInProgress =
		streaming &&
		parts.some((part, index) => {
			if (index < liveFromPart) return false;
			if (isActivityTool(part) || isAskQuestionsToolPart(part)) return !isToolDone(part);
			const { state, text } = part as { state?: string; text?: string };
			return (
				(part.type === "text" || part.type === "reasoning") &&
				state === "streaming" &&
				Boolean(text?.trim()) &&
				!(
					part.type === "text" &&
					isInternalBuildText(parts, index, {
						stillStreaming: true,
						hideSettledLongText: Boolean(groupedStatus),
					})
				)
			);
		});
	const rowStatus = live && status && statusStep < 0 ? status : undefined;
	// Steps hand over in well under a second (a tool ends, the next text starts
	// empty); only a pause that lasts gets the row, so it never blinks.
	const holdOpen = Boolean(rowStatus) || (live && !hasContent);
	const idle = live && !visiblyInProgress;
	const [idleShown, setIdleShown] = useState(idle);
	// A row already open for a status or "Getting started…" hands over to
	// "Working…" without folding in between.
	if (idle && holdOpen && !idleShown) setIdleShown(true);
	useEffect(() => {
		if (!idle) {
			setIdleShown(false);
			return;
		}
		if (idleShown) return;
		const timer = window.setTimeout(() => setIdleShown(true), IDLE_ROW_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [idle, idleShown]);
	const liveOpen = holdOpen || (idle && idleShown);
	const liveLabel = rowStatus ?? (hasContent ? "Working…" : "Getting started…");

	useLayoutEffect(() => {
		shown.current = { replyId, parts, keys };
		liveRef.current = live;
		const element = scrollRef.current;
		if (!element) return;
		const previous = measured.current;
		// Work that starts after the page opened is followed unless the reader
		// had scrolled away (measured before this render's content grew).
		if (live && !previous.live) {
			followRef.current = previous.height - element.scrollTop - element.clientHeight < 80;
		}
		if (followRef.current) element.scrollTop = element.scrollHeight;
		measured.current = { height: element.scrollHeight, live };
	});

	// Rows also grow after render (a disclosure opening, the live row unfolding).
	useEffect(() => {
		const element = scrollRef.current;
		const list = listRef.current;
		if (!element || !list || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (followRef.current && liveRef.current) element.scrollTop = element.scrollHeight;
		});
		observer.observe(list);
		return () => observer.disconnect();
	}, []);

	return (
		<section
			aria-label="Build activity"
			className="build-details absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-surface"
		>
			<header className="build-details-header relative flex min-h-12 shrink-0 items-center gap-3 border-b border-border px-4">
				<button
					type="button"
					onClick={onClose}
					className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-text-secondary transition-[background-color,color] duration-150 hover:bg-surface-sunken hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				>
					<ArrowLeft size={15} aria-hidden="true" />
					Back to site
				</button>
				<h2 className="build-details-title absolute left-1/2 -translate-x-1/2 text-sm font-medium text-text-primary">
					Activity
				</h2>
			</header>
			<div
				ref={scrollRef}
				onScroll={(event) => {
					const element = event.currentTarget;
					followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
				}}
				className="min-h-0 flex-1 overflow-y-auto px-5 py-5 [scrollbar-gutter:stable]"
			>
				<div
					ref={listRef}
					// Opening a step is reading it: stop following until the reader
					// scrolls back to the end, so the row they opened stays put. Keyboard
					// activation of these controls also arrives as a click.
					onClickCapture={(event) => {
						if ((event.target as Element).closest("button, summary")) {
							followRef.current = false;
						}
					}}
					className="w-full border-l border-border pl-5"
				>
					{setupAnswer ? (
						<QuestionsAnswered
							answers={answers}
							usingDefaults={setupAnswer.includes(
								"Use your recommended defaults for any questions I skipped.",
							)}
							rawText={setupAnswer}
						/>
					) : null}
					{parts.map((part, index) => {
						const key = keys[index]!;
						if (part.type === "data-questionnaire-answers") {
							const submission = part.data as QuestionnaireSubmission;
							const answered = submission.answers.flatMap(({ question, selected, custom }) => {
								const values = [...selected, custom.trim()].filter(Boolean);
								return values.length ? [{ question, answer: values.join(", ") }] : [];
							});
							return (
								<QuestionsAnswered
									key={key}
									className={enterClass(key)}
									answers={answered}
									usingDefaults={answered.length < submission.answers.length}
								/>
							);
						}
						if (isAskQuestionsToolPart(part)) {
							const questions = parseClarifyingQuestions(
								(part as { input?: unknown; args?: unknown }).input ??
									(part as { args?: unknown }).args,
							);
							return (
								<div key={key} className={`build-details-step relative mb-4${enterClass(key)}`}>
									<Question size={15} className="build-details-marker" aria-hidden="true" />
									<div className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm shadow-sm">
										<h3 className="font-medium text-text-primary">Design questions</h3>
										{questions.length ? (
											<ul className="mt-2 list-disc space-y-1 pl-5 text-text-secondary">
												{questions.map((question) => (
													<li key={question.question}>{question.question}</li>
												))}
											</ul>
										) : (
											<p className="mt-2 text-text-secondary">Preparing questions…</p>
										)}
									</div>
								</div>
							);
						}
						if (part.type === "reasoning" && (part as { text?: string }).text?.trim()) {
							return (
								<div key={key} className={`build-details-step relative mb-3${enterClass(key)}`}>
									<Lightbulb size={15} className="build-details-marker" aria-hidden="true" />
									<ReasoningBlock
										text={(part as { text?: string }).text ?? ""}
										durationMs={getReasoningDurationMs(part)}
										streaming={
											streaming &&
											index >= liveFromPart &&
											(part as { state?: string }).state === "streaming"
										}
									/>
								</div>
							);
						}
						if (isActivityTool(part)) {
							return (
								<div key={key} className={`build-details-step relative mb-3${enterClass(key)}`}>
									<ToolMarker part={part} />
									<ToolCard
										part={part as Record<string, unknown>}
										active={streaming && index >= liveFromPart}
										liveLabel={index === statusStep ? status : undefined}
										correctionState={corrections.get(index)}
										variant="timeline"
										loadPreviewThumbnail={loadPreviewThumbnail}
									/>
								</div>
							);
						}
						if (part.type === "text" && part.text.trim()) {
							const stillStreaming =
								streaming &&
								index >= liveFromPart &&
								(part as { state?: string }).state === "streaming";
							if (
								isInternalBuildText(parts, index, {
									stillStreaming,
									hideSettledLongText: Boolean(groupedStatus),
								})
							) {
								return null;
							}
							if (!groupedReady && index === finalIndex) return null;
							const buildSummary = groupedReady && index === finalIndex;
							return (
								<div key={key} className={`build-details-step relative mb-3${enterClass(key)}`}>
									<span
										className="build-details-marker size-2.5 rounded-full bg-accent"
										aria-hidden="true"
									/>
									<div className="rounded-xl border border-border bg-surface-raised px-4 py-3 text-sm leading-relaxed shadow-sm">
										{buildSummary ? (
											<h3 className="mb-2 font-medium text-text-primary">Build summary</h3>
										) : null}
										<Markdown text={part.text} state={(part as { state?: string }).state} />
									</div>
								</div>
							);
						}
						return null;
					})}
					<p role="status" className="sr-only">
						{live ? status || (hasContent ? "" : "Getting started…") : ""}
					</p>
					<LiveRow open={liveOpen} label={liveLabel} />
					{!live && !hasContent ? (
						<p className="text-sm text-text-tertiary">No activity recorded for this response.</p>
					) : null}
				</div>
			</div>
		</section>
	);
}
