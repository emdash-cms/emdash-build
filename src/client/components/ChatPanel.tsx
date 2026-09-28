import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { Stop } from "@phosphor-icons/react/Stop";
import { Fragment, useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import type { useAgentChat } from "@cloudflare/ai-chat/react";
import type { FileUIPart } from "ai";
import type { InitialGeneration } from "../../shared/initial-generation.js";
import type { Suggestion } from "../../worker/suggestions.js";
import {
	initialGenerationForDisplay,
	isInitialGenerationActive,
	projectInitialGeneration,
} from "../initial-generation.js";
import {
	createQuestionAnswers,
	findPendingQuestionnaire,
	findQuestionnaireResponse,
	formatQuestionnaireResponse,
	isAskQuestionsToolPart,
	type PendingQuestionnaire,
	type QuestionAnswer,
	type QuestionnaireSubmission,
} from "../../shared/questionnaire.js";
import { ClarifyingQuestions } from "./ClarifyingQuestions.js";
import {
	BuildActivityCard,
	finalTextIndex,
	isActivityTool,
	isTurnActive,
	setupAnswerSummaryForDetails,
	withoutEmptyReplies,
} from "./BuildDetails.js";
import { ShimmerText } from "./ShimmerText.js";
import { Markdown } from "./Markdown.js";
import { Composer } from "./Composer.js";
import { storedPhotos } from "../photo-attachments.js";
import {
	messageDeliveryStatus,
	readClientRecoveryState,
	stopDeliveryStatus,
	type ClientRecoveryState,
} from "../../shared/client-recovery.js";
import { toasts } from "../toasts.js";

type Chat = ReturnType<typeof useAgentChat>;

const withPhotos = (text: string, photos: FileUIPart[]) =>
	photos.length ? { text, files: photos } : { text };

function scrollSuggestionsHorizontally(row: HTMLDivElement, event: WheelEvent) {
	if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.deltaY === 0) return;
	const maxScroll = row.scrollWidth - row.clientWidth;
	if (maxScroll <= 0) return;
	const delta =
		event.deltaMode === WheelEvent.DOM_DELTA_LINE
			? event.deltaY * 24
			: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
				? event.deltaY * row.clientWidth
				: event.deltaY;
	const nextScroll = Math.min(maxScroll, Math.max(0, row.scrollLeft + delta));
	if (nextScroll === row.scrollLeft) return;
	event.preventDefault();
	row.scrollLeft = nextScroll;
}

// Photos are stored under their own key so typing doesn't rewrite them.
const photosKey = (key: string) => `${key}:photos`;
const activityTimerKey = (key: string, activity: string) => `${key}:activity-start:${activity}`;

function storedActivityStart(key: string | undefined, now: number): number | undefined {
	if (!key) return;
	try {
		const stored = Number(localStorage.getItem(key));
		if (Number.isFinite(stored) && stored > 0 && stored <= now) return stored;
	} catch {}
}

function readComposerDraft(key: string | undefined) {
	const draft = {
		input: "",
		queued: null as string | null,
		photos: [] as FileUIPart[],
		queuedPhotos: [] as FileUIPart[],
	};
	if (!key) return draft;
	try {
		const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as {
			input?: unknown;
			queued?: unknown;
		} | null;
		const stored = JSON.parse(sessionStorage.getItem(photosKey(key)) ?? "null") as {
			photos?: unknown;
			queuedPhotos?: unknown;
		} | null;
		if (typeof value?.input === "string") draft.input = value.input;
		if (typeof value?.queued === "string") draft.queued = value.queued;
		draft.photos = storedPhotos(stored?.photos);
		// Queued photos only mean something alongside their queued text.
		if (draft.queued) draft.queuedPhotos = storedPhotos(stored?.queuedPhotos);
	} catch {}
	return draft;
}

export function ChatPanel({
	chat,
	status,
	serverTurnActive = false,
	provisionError,
	buildStarted = false,
	buildComplete = false,
	initialGeneration,
	buildDurationMs,
	suggestions = [],
	draftStorageKey,
	onStopGeneration,
	loadRecoveryState,
	loadPreviewThumbnail,
	onPreviewSite,
	onOpenDetails,
	selectedDetailsId,
}: {
	chat: Chat;
	status?: string;
	/** The agent reports a chat turn running, even before its stream reaches this tab. */
	serverTurnActive?: boolean;
	provisionError?: string;
	buildStarted?: boolean;
	buildComplete?: boolean;
	initialGeneration?: InitialGeneration;
	buildDurationMs?: number;
	/** Next-step prompts from the agent, shown as pills above the composer. */
	suggestions?: readonly Suggestion[];
	draftStorageKey?: string;
	onStopGeneration?: () => Promise<unknown>;
	loadRecoveryState?: () => Promise<ClientRecoveryState>;
	loadPreviewThumbnail?: (
		shotId: string,
	) => Promise<{ base64: string; mediaType: "image/png" } | null>;
	onPreviewSite?: () => void;
	onOpenDetails?: (messageId: string) => void;
	selectedDetailsId?: string | null;
}) {
	const messages = useMemo(
		() => withoutEmptyReplies(chat.messages, chat.isStreaming),
		[chat.messages, chat.isStreaming],
	);
	const pendingQuestionnaire = useMemo(() => findPendingQuestionnaire(messages), [messages]);
	const questionnaireResponse = useMemo(() => findQuestionnaireResponse(messages), [messages]);
	const turnActive = isTurnActive(chat, serverTurnActive);
	const displayedInitialGeneration = useMemo(
		() =>
			initialGenerationForDisplay(messages, initialGeneration, {
				buildStarted,
				buildComplete,
				awaitingAnswers: Boolean(pendingQuestionnaire),
				active: turnActive,
			}),
		[buildComplete, buildStarted, initialGeneration, messages, pendingQuestionnaire, turnActive],
	);
	const initialView = useMemo(
		() => projectInitialGeneration(messages, displayedInitialGeneration),
		[messages, displayedInitialGeneration],
	);
	const [initialDraft] = useState(() => readComposerDraft(draftStorageKey));
	const [input, setInput] = useState(initialDraft.input);
	const [stopping, setStopping] = useState(false);
	const [queued, setQueued] = useState<string | null>(initialDraft.queued);
	const [photos, setPhotos] = useState(initialDraft.photos);
	const [queuedPhotos, setQueuedPhotos] = useState(initialDraft.queuedPhotos);
	const [photosPending, setPhotosPending] = useState(false);
	const [queueAcknowledged, setQueueAcknowledged] = useState(false);
	const [queuedQuestionnaireToolCallId, setQueuedQuestionnaireToolCallId] = useState<string>();
	const [displayedQuestionnaire, setDisplayedQuestionnaire] = useState<
		PendingQuestionnaire | undefined
	>(pendingQuestionnaire);
	const [questionnaireSubmission, setQuestionnaireSubmission] = useState<{ toolCallId: string }>();
	const questionnaireLockRef = useRef<string | undefined>(undefined);
	const scrollRef = useRef<HTMLDivElement>(null);
	const suggestionsRef = useRef<HTMLDivElement>(null);
	const activityTimerRef = useRef<{ key: string; startedAt: number } | undefined>(undefined);
	const activityStorageKeyRef = useRef<string | undefined>(undefined);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const queueFeedbackTimeoutRef = useRef<number | undefined>(undefined);
	const recoveryToastIdsRef = useRef(new Set<string>());
	const recoveryEpochRef = useRef(0);
	const questionnaireRecoveryRef = useRef(new Map<string, string>());
	// Whether the view is pinned to the bottom. Stays true while the user is
	// near the bottom; goes false once they scroll up to read so we never yank
	// them back down mid-turn.
	const stickRef = useRef(true);

	type SendPayload = {
		text: string;
		files?: FileUIPart[];
		metadata?: { questionnaire: QuestionnaireSubmission };
	};
	type RecoverableSend = {
		messageId: string;
		recoveryEpoch: number;
		payload: SendPayload;
		onReceived?: () => void;
		onSuccess?: () => void;
		onNotReceived?: () => void;
		retry?: () => void;
	};
	const recoveryToastId = (messageId: string) =>
		`chat-send-error:${draftStorageKey ?? "current"}:${messageId}`;
	const stopToastId = `chat-stop-error:${draftStorageKey ?? "current"}`;
	const closeRecoveryToast = (messageId: string) => {
		const toastId = recoveryToastId(messageId);
		toasts.close(toastId);
		recoveryToastIdsRef.current.delete(toastId);
	};
	useEffect(() => {
		const epoch = ++recoveryEpochRef.current;
		return () => {
			if (recoveryEpochRef.current === epoch) recoveryEpochRef.current += 1;
			for (const toastId of recoveryToastIdsRef.current) toasts.close(toastId);
			recoveryToastIdsRef.current.clear();
			questionnaireRecoveryRef.current.clear();
			toasts.close(stopToastId);
		};
	}, [stopToastId]);
	const syncRecoveryState = async (recoveryEpoch: number) => {
		if (!loadRecoveryState) return undefined;
		const recovered = await readClientRecoveryState(loadRecoveryState);
		if (recoveryEpoch !== recoveryEpochRef.current) return undefined;
		if (recovered) {
			chat.setMessages(recovered.messages);
			chat.clearError();
		}
		return recovered;
	};
	const reconcileMessage = async (pending: RecoverableSend) => {
		if (pending.recoveryEpoch !== recoveryEpochRef.current) return;
		const recovered = await syncRecoveryState(pending.recoveryEpoch);
		if (pending.recoveryEpoch !== recoveryEpochRef.current) return;
		const delivery = messageDeliveryStatus(recovered, pending.messageId);
		if (delivery === "received") {
			closeRecoveryToast(pending.messageId);
			pending.onReceived?.();
			return;
		}
		if (delivery === "not-received") pending.onNotReceived?.();
		const retry = pending.retry ?? (() => sendRecoverably(pending));
		const toastId = recoveryToastId(pending.messageId);
		recoveryToastIdsRef.current.add(toastId);
		let actionUsed = false;
		toasts.add({
			id: toastId,
			title: delivery === "not-received" ? "Message was not sent" : "Connection interrupted",
			description:
				delivery === "not-received"
					? "Your message is unchanged and ready to retry."
					: "Check whether the message reached your site before retrying.",
			variant: "error",
			priority: "high",
			timeout: 0,
			actions: [
				{
					children: delivery === "not-received" ? "Retry" : "Check again",
					onClick: () => {
						if (pending.recoveryEpoch !== recoveryEpochRef.current) return;
						if (actionUsed) return;
						actionUsed = true;
						closeRecoveryToast(pending.messageId);
						if (delivery === "not-received") retry();
						else void reconcileMessage(pending);
					},
					variant: "secondary",
					size: "sm",
				},
			],
		});
	};
	const sendRecoverably = (pending: RecoverableSend) => {
		if (pending.recoveryEpoch !== recoveryEpochRef.current) return;
		const message = {
			id: pending.messageId,
			role: "user" as const,
			parts: [
				...(pending.payload.files ?? []),
				{ type: "text" as const, text: pending.payload.text },
			],
			...(pending.payload.metadata ? { metadata: pending.payload.metadata } : {}),
		};
		void Promise.resolve()
			.then(() => chat.sendMessage(message))
			.then(() => {
				closeRecoveryToast(pending.messageId);
				pending.onSuccess?.();
			})
			.catch(() => reconcileMessage(pending));
	};
	const sendMessage = (payload: SendPayload) => {
		sendRecoverably({
			messageId: crypto.randomUUID(),
			recoveryEpoch: recoveryEpochRef.current,
			payload,
		});
	};

	const beginQuestionnaireSend = (
		toolCallId: string,
		text: string,
		submission?: QuestionnaireSubmission,
		files: FileUIPart[] = [],
		messageId = crypto.randomUUID(),
	) => {
		if (questionnaireLockRef.current) return;
		const previousMessageId = questionnaireRecoveryRef.current.get(toolCallId);
		if (previousMessageId && previousMessageId !== messageId) {
			closeRecoveryToast(previousMessageId);
		}
		questionnaireRecoveryRef.current.set(toolCallId, messageId);
		questionnaireLockRef.current = toolCallId;
		setQuestionnaireSubmission({ toolCallId });
		stickRef.current = true;
		inputRef.current?.focus();
		const release = () => {
			setQuestionnaireSubmission(undefined);
			questionnaireLockRef.current = undefined;
		};
		const settle = () => {
			if (questionnaireRecoveryRef.current.get(toolCallId) === messageId) {
				questionnaireRecoveryRef.current.delete(toolCallId);
			}
		};
		const payload: SendPayload = {
			...withPhotos(text, files),
			...(submission ? { metadata: { questionnaire: submission } } : {}),
		};
		sendRecoverably({
			messageId,
			recoveryEpoch: recoveryEpochRef.current,
			payload,
			onReceived: () => {
				settle();
				release();
			},
			onSuccess: settle,
			onNotReceived: release,
			retry: () => {
				if (questionnaireRecoveryRef.current.get(toolCallId) !== messageId) return;
				beginQuestionnaireSend(toolCallId, text, submission, files, messageId);
			},
		});
	};

	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
	};

	// Auto-scroll only when pinned to the bottom (and only when content
	// actually changes -- idle sessions never scroll).
	useEffect(() => {
		if (!stickRef.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	// Focus the input when the build view mounts
	useEffect(() => {
		if (!pendingQuestionnaire) inputRef.current?.focus();
	}, []);

	useEffect(() => () => window.clearTimeout(queueFeedbackTimeoutRef.current), []);

	useLayoutEffect(() => {
		if (!draftStorageKey) return;
		try {
			if (input || queued)
				sessionStorage.setItem(draftStorageKey, JSON.stringify({ input, queued }));
			else sessionStorage.removeItem(draftStorageKey);
		} catch {}
	}, [draftStorageKey, input, queued]);

	useLayoutEffect(() => {
		if (!draftStorageKey) return;
		try {
			// Remove first so a write that fails on quota can't leave old photos to restore.
			sessionStorage.removeItem(photosKey(draftStorageKey));
			if (photos.length || queuedPhotos.length)
				sessionStorage.setItem(
					photosKey(draftStorageKey),
					JSON.stringify({ photos, queuedPhotos }),
				);
		} catch {}
	}, [draftStorageKey, photos, queuedPhotos]);

	// A sent request is busy before its first chunk: queue behind it and offer Stop.
	const composerBusy = isTurnActive(chat);

	// Flush a queued message once the current turn finishes.
	useEffect(() => {
		if (!composerBusy && queued) {
			const text = queued;
			const files = queuedPhotos;
			const questionnaireToolCallId =
				queuedQuestionnaireToolCallId ?? pendingQuestionnaire?.toolCallId;
			setQueued(null);
			setQueuedPhotos([]);
			setQueuedQuestionnaireToolCallId(undefined);
			if (questionnaireToolCallId) {
				beginQuestionnaireSend(questionnaireToolCallId, text, undefined, files);
			} else {
				sendMessage(withPhotos(text, files));
			}
		}
	}, [
		composerBusy,
		queued,
		queuedPhotos,
		queuedQuestionnaireToolCallId,
		pendingQuestionnaire,
		chat,
	]);

	useEffect(() => {
		if (
			pendingQuestionnaire &&
			pendingQuestionnaire.toolCallId !== displayedQuestionnaire?.toolCallId
		) {
			setDisplayedQuestionnaire(pendingQuestionnaire);
			if (questionnaireLockRef.current === pendingQuestionnaire.toolCallId) return;
			setQuestionnaireSubmission(undefined);
			questionnaireLockRef.current = undefined;
		}
	}, [displayedQuestionnaire?.toolCallId, pendingQuestionnaire]);

	useEffect(() => {
		if (!questionnaireSubmission) return;
		if (chat.status === "ready" && !chat.isStreaming && !pendingQuestionnaire) {
			setQuestionnaireSubmission(undefined);
			questionnaireLockRef.current = undefined;
			inputRef.current?.focus();
		}
	}, [chat.isStreaming, chat.status, pendingQuestionnaire, questionnaireSubmission]);

	const sendQuestionnaireResponse = (answers?: QuestionAnswer[]) => {
		const questionnaire = pendingQuestionnaire;
		if (
			!questionnaire ||
			questionnaireLockRef.current === questionnaire.toolCallId ||
			chat.isStreaming ||
			chat.status !== "ready" ||
			queued
		) {
			return;
		}
		const submission = {
			toolCallId: questionnaire.toolCallId,
			answers: answers ?? createQuestionAnswers(questionnaire.questions),
		};
		beginQuestionnaireSend(
			questionnaire.toolCallId,
			formatQuestionnaireResponse(submission.answers),
			submission,
		);
	};

	const retryIncompleteBuild = () => {
		if (
			(!questionnaireResponse && !initialView) ||
			questionnaireLockRef.current ||
			chat.isStreaming ||
			chat.status !== "ready" ||
			queued
		) {
			return;
		}
		beginQuestionnaireSend(
			questionnaireResponse?.toolCallId ?? initialView!.id,
			questionnaireResponse && !initialGeneration
				? "Resume the initial build using my questionnaire answers above. Reuse the existing work; before finishing, run validate_site until it passes, then inspect the final preview."
				: "Resume the initial build using the brief and answers above. Reuse the existing work; before finishing, run validate_site until it passes, then inspect the final preview.",
		);
	};

	const stopGeneration = () => {
		if (stopping) return;
		toasts.close(stopToastId);
		setStopping(true);
		setQueued(null);
		setQueuedPhotos([]);
		setQueuedQuestionnaireToolCallId(undefined);
		window.clearTimeout(queueFeedbackTimeoutRef.current);
		setQueueAcknowledged(false);
		void (async () => {
			const recoveryEpoch = recoveryEpochRef.current;
			const generationId =
				displayedInitialGeneration && isInitialGenerationActive(displayedInitialGeneration.status)
					? displayedInitialGeneration.id
					: undefined;
			try {
				await chat.stop();
				await onStopGeneration?.();
				toasts.close(stopToastId);
			} catch {
				const reconcileStop = async () => {
					if (recoveryEpoch !== recoveryEpochRef.current) return;
					const recovered = await syncRecoveryState(recoveryEpoch);
					if (recoveryEpoch !== recoveryEpochRef.current) return;
					const outcome = stopDeliveryStatus(recovered, generationId);
					if (outcome === "stopped") {
						toasts.close(stopToastId);
						return;
					}
					let actionUsed = false;
					toasts.add({
						id: stopToastId,
						title: outcome === "pending" ? "Stop is still finishing" : "Connection interrupted",
						description:
							outcome === "pending"
								? "The current work is settling before it stops."
								: "Check whether the build stopped before trying again.",
						variant: "error",
						priority: "high",
						timeout: 0,
						actions: [
							{
								children: outcome === "pending" ? "Stop again" : "Check again",
								onClick: () => {
									if (recoveryEpoch !== recoveryEpochRef.current) return;
									if (actionUsed) return;
									actionUsed = true;
									toasts.close(stopToastId);
									if (outcome === "pending") stopGeneration();
									else void reconcileStop();
								},
								variant: "secondary",
								size: "sm",
							},
						],
					});
				};
				await reconcileStop();
			} finally {
				setStopping(false);
			}
		})();
		inputRef.current?.focus();
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (photosPending) return;
		const text = input.trim();
		if (!text) return;
		const files = photos;
		setInput("");
		setPhotos([]);
		// Pin to bottom: the user just acted, so follow the new output.
		stickRef.current = true;
		if (composerBusy) {
			// A turn is in flight -- queue this message and send it when the
			// current turn ends, rather than dropping or interleaving it.
			setQueued((q) => (q ? `${q}\n${text}` : text));
			setQueuedPhotos((queuedFiles) => [...queuedFiles, ...files]);
			window.clearTimeout(queueFeedbackTimeoutRef.current);
			setQueueAcknowledged(true);
			queueFeedbackTimeoutRef.current = window.setTimeout(() => setQueueAcknowledged(false), 500);
			if (pendingQuestionnaire) {
				setQueuedQuestionnaireToolCallId(pendingQuestionnaire.toolCallId);
			}
		} else if (pendingQuestionnaire) {
			beginQuestionnaireSend(pendingQuestionnaire.toolCallId, text, undefined, files);
		} else {
			sendMessage(withPhotos(text, files));
		}
		inputRef.current?.focus();
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit(e);
		}
	};

	// "Thinking" = the model is working but hasn't produced visible output yet
	// (request submitted, or streaming reasoning before any text/tool part).
	// Once text or a tool card appears, we show that instead.
	const last = messages[messages.length - 1];
	const assistantHasContent =
		last?.role === "assistant" &&
		(last.parts?.some((p) => {
			const text = (p as { text?: string }).text;
			if ((p.type === "text" || p.type === "reasoning") && typeof text === "string") {
				return text.trim().length > 0;
			}
			return isActivityTool(p);
		}) ??
			false);
	// isStreaming covers both client- and server-initiated turns (including the
	// auto-build), so the indicator/stop button track the full turn window. The
	// status line is session-wide (opening a site restores its preview), so it
	// only describes the latest turn while that turn is running.
	const turnStatus = turnActive ? status : undefined;
	const isThinking = turnActive && !turnStatus && !assistantHasContent;
	const latestAssistantId = last?.role === "assistant" ? last.id : undefined;
	const showQueueFeedback = queueAcknowledged && !input.trim();
	const generationActive = Boolean(
		initialView &&
		displayedInitialGeneration &&
		isInitialGenerationActive(displayedInitialGeneration.status) &&
		(initialGeneration || turnActive),
	);
	const latestUserId = [...messages].reverse().find((message) => message.role === "user")?.id;
	const currentActivityKey = generationActive
		? `initial:${initialView!.id}:${latestUserId ?? initialView!.id}`
		: turnActive && latestUserId
			? `turn:${latestUserId}`
			: undefined;
	const activityStorageKey =
		currentActivityKey && draftStorageKey
			? activityTimerKey(draftStorageKey, currentActivityKey)
			: undefined;
	if (currentActivityKey && activityTimerRef.current?.key !== currentActivityKey) {
		const now = Date.now();
		activityTimerRef.current = {
			key: currentActivityKey,
			startedAt: storedActivityStart(activityStorageKey, now) ?? now,
		};
	} else if (!currentActivityKey) {
		activityTimerRef.current = undefined;
	}
	const activityStartedAt = activityTimerRef.current?.startedAt;
	useEffect(() => {
		const previousKey = activityStorageKeyRef.current;
		if (previousKey && previousKey !== activityStorageKey) {
			try {
				localStorage.removeItem(previousKey);
			} catch {}
		}
		activityStorageKeyRef.current = activityStorageKey;
		if (!activityStorageKey || activityStartedAt === undefined) return;
		try {
			if (localStorage.getItem(activityStorageKey) === null) {
				localStorage.setItem(activityStorageKey, String(activityStartedAt));
			}
		} catch {}
	}, [activityStartedAt, activityStorageKey]);
	const showSendAction =
		(!composerBusy && !generationActive) || Boolean(input.trim()) || showQueueFeedback;
	const actionLabel = showQueueFeedback
		? "Message queued"
		: !showSendAction
			? "Stop generating"
			: composerBusy
				? "Queue message"
				: "Send message";
	const showSuggestions =
		buildComplete &&
		suggestions.length > 0 &&
		!input.trim() &&
		!queued &&
		!displayedQuestionnaire &&
		!composerBusy &&
		chat.status === "ready";
	useEffect(() => {
		if (!showSuggestions) return;
		const row = suggestionsRef.current;
		if (!row) return;
		const onWheel = (event: WheelEvent) => scrollSuggestionsHorizontally(row, event);
		row.addEventListener("wheel", onWheel, { passive: false });
		return () => row.removeEventListener("wheel", onWheel);
	}, [showSuggestions]);
	const questionnaireOpen =
		Boolean(displayedQuestionnaire) &&
		pendingQuestionnaire?.toolCallId === displayedQuestionnaire?.toolCallId;
	const questionnaireSubmitting =
		questionnaireSubmission?.toolCallId === displayedQuestionnaire?.toolCallId;
	const showIncompleteBuild = Boolean(
		(questionnaireResponse || initialView) &&
		(buildStarted ||
			initialGeneration?.status === "stopped" ||
			initialGeneration?.status === "failed") &&
		!buildComplete &&
		!pendingQuestionnaire &&
		!questionnaireSubmission &&
		(!provisionError || initialGeneration?.status === "failed") &&
		(!status ||
			initialGeneration?.status === "failed" ||
			initialGeneration?.status === "stopped") &&
		!chat.isStreaming &&
		chat.status === "ready",
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* Messages */}
			<div
				ref={scrollRef}
				onScroll={onScroll}
				className="chat-messages-scroll flex-1 overflow-y-auto py-4 ps-4 pe-2 [scrollbar-gutter:stable]"
			>
				{messages.length === 0 && (
					<div className="flex h-full items-center justify-center">
						<p className="max-w-[280px] text-center text-sm leading-relaxed text-text-tertiary">
							Describe the site you want to build. The agent will design its content model, pages,
							and visual direction.
						</p>
					</div>
				)}

				{messages.map((message, index) => {
					if (initialView && message.id === initialView.id) {
						return (
							<Fragment key={message.id}>
								<MessageBubble
									message={message}
									allMessages={messages}
									streaming={false}
									selected={false}
								/>
								<BuildActivityCard
									message={initialView.message}
									active={generationActive}
									status={generationActive ? status : undefined}
									initialGeneration={displayedInitialGeneration}
									buildDurationMs={buildDurationMs}
									startedAt={activityStartedAt}
									loadPreviewThumbnail={loadPreviewThumbnail}
									onPreview={onPreviewSite}
									selected={selectedDetailsId === initialView.id}
									onSelect={() => onOpenDetails?.(initialView.id)}
								/>
							</Fragment>
						);
					}
					if (initialView?.answerMessageIds.has(message.id)) return null;
					if (initialView?.groupedMessageIds.has(message.id)) {
						const holdingReply =
							(message.metadata as { initialGenerationReply?: unknown } | undefined)
								?.initialGenerationReply === "holding";
						const precedingUser = messages
							.slice(0, index)
							.reverse()
							.find((candidate) => candidate.role === "user");
						if (
							!holdingReply ||
							(precedingUser && initialView.answerMessageIds.has(precedingUser.id))
						) {
							return null;
						}
						const finalPart = message.parts?.[finalTextIndex(message.parts ?? [])];
						return finalPart?.type === "text" ? (
							<div key={message.id} className="mb-3 text-sm leading-relaxed">
								<Markdown text={finalPart.text} state={(finalPart as { state?: string }).state} />
							</div>
						) : null;
					}
					return (
						<MessageBubble
							key={message.id}
							message={message}
							allMessages={messages}
							status={index === messages.length - 1 ? turnStatus : undefined}
							startedAt={index === messages.length - 1 ? activityStartedAt : undefined}
							onOpenDetails={onOpenDetails}
							selected={selectedDetailsId === message.id}
							streaming={
								chat.isStreaming && index === messages.length - 1 && message.role === "assistant"
							}
						/>
					);
				})}

				{(turnStatus || isThinking) &&
				!latestAssistantId &&
				last?.role === "user" &&
				(!initialView || displayedInitialGeneration?.status === "ready") ? (
					<BuildActivityCard
						active
						status={turnStatus}
						startedAt={activityStartedAt}
						selected={selectedDetailsId === last.id}
						onSelect={() => onOpenDetails?.(last.id)}
					/>
				) : (status || isThinking) && !last ? (
					<div className="py-1 text-[13px] text-text-secondary" role="status">
						<ShimmerText>{status || "Thinking"}</ShimmerText>
					</div>
				) : null}
			</div>

			<div className="shrink-0 bg-surface px-3 pt-2.5 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
				{displayedQuestionnaire ? (
					<ClarifyingQuestions
						key={displayedQuestionnaire.toolCallId}
						toolCallId={displayedQuestionnaire.toolCallId}
						questions={displayedQuestionnaire.questions}
						open={questionnaireOpen}
						disabled={chat.isStreaming || chat.status !== "ready" || Boolean(queued)}
						submitting={questionnaireSubmitting}
						onSubmit={sendQuestionnaireResponse}
						onDismiss={() => sendQuestionnaireResponse()}
					/>
				) : null}

				{/* Input */}
				<form onSubmit={handleSubmit}>
					{showIncompleteBuild ? (
						<div className="mb-2 flex items-center gap-2 rounded-[20px] border border-warning/30 bg-warning-light px-2.5 py-1.5 text-[11px] leading-relaxed text-warning">
							<span>
								{questionnaireResponse
									? "Answers received, but the build did not finish"
									: "Initial build did not finish"}
							</span>
							<button
								type="button"
								onClick={retryIncompleteBuild}
								disabled={Boolean(questionnaireSubmission)}
								className="ml-auto shrink-0 rounded-xl px-2 py-1 font-medium ring-1 ring-warning/30 hover:bg-warning/10 disabled:opacity-50"
							>
								Retry build
							</button>
						</div>
					) : null}
					{queued ? (
						<div
							role="status"
							className="mb-2 flex items-center gap-2 rounded-[20px] bg-surface-sunken px-2.5 py-1.5 text-xs text-text-secondary"
						>
							<span className="shrink-0 font-medium">Queued</span>
							<span className="truncate">{queued}</span>
							{queuedPhotos.length ? (
								<span className="shrink-0 text-text-tertiary">
									+ {queuedPhotos.length} {queuedPhotos.length === 1 ? "photo" : "photos"}
								</span>
							) : null}
							<button
								type="button"
								onClick={() => {
									setQueued(null);
									setQueuedPhotos([]);
									setQueuedQuestionnaireToolCallId(undefined);
									window.clearTimeout(queueFeedbackTimeoutRef.current);
									setQueueAcknowledged(false);
								}}
								className="ml-auto shrink-0 rounded-xl px-1 text-text-tertiary hover:text-text-primary"
								title="Cancel queued message"
								aria-label="Cancel queued message"
							>
								&times;
							</button>
						</div>
					) : null}
					{showSuggestions ? (
						<div
							ref={suggestionsRef}
							role="group"
							aria-label="Suggested next actions"
							className="-mx-3 mb-1.5 flex min-w-0 touch-pan-x gap-2 overflow-x-auto overscroll-x-contain px-3 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
						>
							{suggestions.map((suggestion, index) => (
								<button
									key={suggestion.label}
									type="button"
									title={suggestion.prompt}
									onClick={() => {
										setInput(suggestion.prompt);
										inputRef.current?.focus();
									}}
									className={`h-8 shrink-0 rounded-full border border-border bg-surface-raised px-3.5 text-sm whitespace-nowrap transition-transform duration-150 hover:border-border-strong hover:text-text-primary active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${index === 0 ? "text-text-primary" : "text-text-secondary"}`}
								>
									{suggestion.label}
								</button>
							))}
						</div>
					) : null}
					<Composer
						inputRef={inputRef}
						value={input}
						onValueChange={setInput}
						onKeyDown={handleKeyDown}
						photos={photos}
						onPhotosChange={setPhotos}
						onPhotosPendingChange={setPhotosPending}
						photosDisabled={queuedPhotos.length > 0}
						placeholder={composerBusy ? "Queue a change..." : "Ask EmDash to change the site…"}
						label="Message EmDash"
						describedBy="chat-composer-hint"
						actions={
							<>
								{(composerBusy || generationActive) && showSendAction ? (
									<button
										type="button"
										onClick={stopGeneration}
										disabled={stopping}
										className="flex size-8 items-center justify-center rounded-full text-danger hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
										aria-label="Stop generating"
										title="Stop generating"
									>
										<Stop size={12} weight="fill" aria-hidden="true" />
									</button>
								) : null}
								<button
									type={showSendAction ? "submit" : "button"}
									onClick={
										showSendAction
											? undefined
											: () => {
													stopGeneration();
												}
									}
									disabled={
										stopping ||
										showQueueFeedback ||
										(showSendAction && (photosPending || !input.trim()))
									}
									className={`flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,scale] duration-150 active:scale-[0.94] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${showQueueFeedback ? "cursor-default bg-accent-light text-accent-text" : showSendAction ? "bg-text-primary text-surface-raised hover:opacity-90 disabled:cursor-not-allowed disabled:bg-border disabled:text-text-tertiary disabled:active:scale-100" : "border border-danger/30 bg-danger-light text-danger hover:bg-danger/10"}`}
									aria-label={actionLabel}
									title={actionLabel}
								>
									{showSendAction ? (
										<ArrowUp size={15} weight="bold" aria-hidden="true" />
									) : (
										<Stop size={12} weight="fill" aria-hidden="true" />
									)}
								</button>
							</>
						}
					/>
					<span id="chat-composer-hint" className="sr-only">
						{composerBusy
							? "Enter to send after the current response. Shift + Enter for a new line."
							: "Enter to send. Shift + Enter for a new line."}
					</span>
				</form>
			</div>
		</div>
	);
}

type MessagePart = NonNullable<Chat["messages"][number]["parts"]>[number];

function MessageBubble({
	message,
	allMessages,
	streaming,
	status,
	startedAt,
	onOpenDetails,
	selected,
}: {
	message: Chat["messages"][number];
	allMessages: Chat["messages"];
	streaming: boolean;
	status?: string;
	startedAt?: number;
	onOpenDetails?: (messageId: string) => void;
	selected: boolean;
}) {
	const isUser = message.role === "user";
	const answerSummary = useMemo(
		() => (isUser ? undefined : setupAnswerSummaryForDetails(allMessages, message.id)),
		[allMessages, isUser, message.id],
	);
	const parts: MessagePart[] = message.parts ?? [];
	const photos = isUser
		? parts.filter(
				(part): part is FileUIPart => part.type === "file" && part.mediaType.startsWith("image/"),
			)
		: [];
	const finalIndex = finalTextIndex(parts);
	const finalText = finalIndex >= 0 ? parts[finalIndex] : undefined;
	const showDetails =
		!isUser &&
		(streaming ||
			parts.some(
				(part) => part.type === "reasoning" || isActivityTool(part) || isAskQuestionsToolPart(part),
			) ||
			Boolean(status) ||
			finalIndex >= 0);

	return (
		<div className={`mb-3 ${isUser ? "flex justify-end" : ""}`}>
			{isUser ? (
				<div className="flex max-w-[85%] flex-col items-end gap-1.5">
					{photos.length ? (
						<div className="flex flex-wrap justify-end gap-1.5">
							{photos.map((photo, i) => (
								<img
									key={i}
									src={photo.url}
									alt={photo.filename ?? "Attached photo"}
									className="size-24 rounded-xl border border-border object-cover"
								/>
							))}
						</div>
					) : null}
					{parts.some((part) => part.type === "text") ? (
						<div className="rounded-2xl rounded-br-sm border border-border bg-surface-raised px-3.5 py-2 text-sm leading-relaxed">
							{parts.map((part, i) =>
								part.type === "text" ? <span key={i}>{part.text}</span> : null,
							)}
						</div>
					) : null}
				</div>
			) : (
				<div className="max-w-full text-sm leading-relaxed">
					{showDetails ? (
						<BuildActivityCard
							message={message}
							active={streaming || Boolean(status)}
							status={status}
							startedAt={startedAt}
							selected={selected}
							answerSummary={answerSummary}
							onSelect={() => onOpenDetails?.(message.id)}
						/>
					) : null}
					{finalText?.type === "text" ? (
						<Markdown text={finalText.text} state={(finalText as { state?: string }).state} />
					) : null}
				</div>
			)}
		</div>
	);
}
