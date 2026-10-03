import {
	useState,
	useEffect,
	useLayoutEffect,
	useCallback,
	useMemo,
	useRef,
	Suspense,
	lazy,
} from "react";
import { flushSync } from "react-dom";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Sidebar, useSidebar } from "@cloudflare/kumo";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { ArrowUpRight } from "@phosphor-icons/react/ArrowUpRight";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { CaretUp } from "@phosphor-icons/react/CaretUp";
import { GithubLogo } from "@phosphor-icons/react/GithubLogo";
import { TerminalWindow } from "@phosphor-icons/react/TerminalWindow";
import type { FileUIPart } from "ai";
import type { BuilderState } from "../worker/agent.js";
import type { InitialGeneration } from "../shared/initial-generation.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { Composer } from "./components/Composer.js";
import {
	BuildDetails,
	detailsActivity,
	isTurnActive,
	resolveDetails,
	setupAnswerForDetails,
	withoutEmptyReplies,
} from "./components/BuildDetails.js";
import { PreviewPanel } from "./components/PreviewPanel.js";
import { PreviewDetailsStage } from "./components/PreviewDetailsStage.js";
import { ConsolePanel } from "./components/ConsolePanel.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { DeployCard, type DeployInfo } from "./components/DeployCard.js";
import { ExportPanel, type CloneInfo } from "./components/CloneCard.js";
import { ProjectHeader } from "./components/ProjectHeader.js";
import {
	ProjectSidebar,
	SidebarAccessibility,
	SidebarKeyboardShortcut,
	type ProjectSummary,
} from "./components/ProjectSidebar.js";
import { PublishPanel } from "./components/PublishPanel.js";
import { AccountControl } from "./components/AccountControl.js";
import { AppearanceControl } from "./components/AppearanceControl.js";
import { AuthComplete } from "./components/AuthComplete.js";
import { useAppearance, type Appearance } from "./appearance.js";
import {
	needsAuthCompletion,
	postAuthDestination,
	revokeAccountSession,
	type AccountStatus,
} from "./account-state.js";
import { reducePublishState, type PublishState } from "../platform/publish-state.js";
import { findPendingQuestionnaire } from "../shared/questionnaire.js";
import { useWorkspacePreview } from "./workspace-layout.js";
import {
	mostRecentProjectId,
	sortProjects,
	upsertActiveProject,
	withoutLiveFlags,
} from "./recent-projects.js";
import { initialGenerationForDisplay, isInitialGenerationActive } from "./initial-generation.js";
import { useProjectListRefresh } from "./use-project-refresh.js";
import { useSandboxHeartbeat } from "./sandbox-heartbeat.js";
import { toasts } from "./toasts.js";
import {
	messageDeliveryStatus,
	readClientRecoveryState,
	type ClientRecoveryState,
} from "../shared/client-recovery.js";
import { fetchWithTransientRetries } from "./retry.js";

const LandingAurora = lazy(() => import("./components/LandingAurora.js"));
const CLAIM_WINDOW_MS = 60 * 60 * 1000;
const PENDING_PROJECT_CREATION_KEY = "emdash-build:pending-project-creation";
const RECENT_PROJECTS_KEY = "emdash-build:recent-projects";
const SIDEBAR_OPEN_KEY = "emdash-build:sidebar-open";

function readSidebarOpen(): boolean {
	try {
		return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
	} catch {
		return true;
	}
}

function persistSidebarOpen(open: boolean) {
	try {
		localStorage.setItem(SIDEBAR_OPEN_KEY, String(open));
	} catch {
		// Storage may be unavailable in a restricted browsing context.
	}
}

function readRecentProjects(): ProjectSummary[] {
	try {
		const stored = localStorage.getItem(RECENT_PROJECTS_KEY);
		if (!stored) return [];
		const value = JSON.parse(stored) as ProjectSummary[];
		return Array.isArray(value) ? withoutLiveFlags(sortProjects(value)).slice(0, 20) : [];
	} catch {
		return [];
	}
}

function persistRecentProjects(projects?: ProjectSummary[]) {
	try {
		if (projects)
			localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(withoutLiveFlags(projects)));
		else localStorage.removeItem(RECENT_PROJECTS_KEY);
	} catch {
		// Storage may be unavailable in a restricted browsing context.
	}
}

function projectTitleFromChat(messages: ReturnType<typeof useAgentChat>["messages"]): string {
	const firstUser = messages.find((message) => message.role === "user");
	const text = firstUser?.parts
		?.filter((part) => part.type === "text")
		.map((part) => (part as { text?: string }).text ?? "")
		.join(" ")
		.trim();
	if (!text) return "Untitled site";
	const words = text.replace(/\s+/g, " ").split(" ").slice(0, 7).join(" ");
	return words.length < text.length ? `${words}…` : words;
}

// A project lives at /s/<uuid>. The URL locates it; the server-issued HttpOnly
// guest cookie proves ownership. The bare landing page remains clean.
function requestedProjectId(): string | undefined {
	const match = window.location.pathname.match(/^\/s\/([0-9a-f-]{36})$/i);
	return match?.[1];
}

interface PendingProjectCreation {
	projectId: string;
	creationToken: string;
}

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pendingProjectCreation(): PendingProjectCreation {
	try {
		const stored = JSON.parse(
			sessionStorage.getItem(PENDING_PROJECT_CREATION_KEY) ?? "null",
		) as Partial<PendingProjectCreation> | null;
		if (
			typeof stored?.projectId === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
				stored.projectId,
			) &&
			typeof stored.creationToken === "string" &&
			/^[0-9a-f]{64}$/i.test(stored.creationToken)
		) {
			return { projectId: stored.projectId, creationToken: stored.creationToken };
		}
		const created = { projectId: crypto.randomUUID(), creationToken: randomHex(32) };
		sessionStorage.setItem(PENDING_PROJECT_CREATION_KEY, JSON.stringify(created));
		return created;
	} catch {
		return { projectId: crypto.randomUUID(), creationToken: randomHex(32) };
	}
}

function clearPendingProjectCreation(projectId?: string): void {
	try {
		const stored = JSON.parse(
			sessionStorage.getItem(PENDING_PROJECT_CREATION_KEY) ?? "null",
		) as Partial<PendingProjectCreation> | null;
		if (!projectId || stored?.projectId === projectId) {
			sessionStorage.removeItem(PENDING_PROJECT_CREATION_KEY);
		}
	} catch {}
}

interface ProjectSession {
	projectId: string;
	resuming: boolean;
	publishingEnabled?: boolean;
	projects?: ProjectSummary[];
	previewUrl?: string;
	initialMessages?: ReturnType<typeof useAgentChat>["messages"];
}

interface AuthToast {
	message: string;
	waitForReady?: boolean;
}

async function preloadProjectSession(projectId: string): Promise<ProjectSession> {
	const response = await fetchWithTransientRetries("/api/project-session", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ projectId }),
	});
	if (!response.ok) throw new Error("This project is unavailable in this browser session.");
	const session = (await response.json()) as ProjectSession;
	if (session.projectId !== projectId)
		throw new Error("The requested project could not be opened.");
	return session;
}

async function readAccountStatus(): Promise<AccountStatus> {
	const response = await fetchWithTransientRetries("/api/auth/account");
	if (!response.ok) throw new Error("Account state is temporarily unavailable.");
	return (await response.json()) as AccountStatus;
}

async function finishPendingDeletion(projectId: string): Promise<boolean> {
	const response = await fetchWithTransientRetries(`/api/projects/${projectId}`, {
		method: "DELETE",
	});
	return response.ok || response.status === 404;
}

async function beginLogin(returnTo: string, popup?: Window | null): Promise<void> {
	const projectIds = [
		...(requestedProjectId() ? [requestedProjectId()!] : []),
		...readRecentProjects().map((project) => project.id),
	].slice(0, 20);
	const response = await fetch("/api/auth/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ returnTo, projectIds }),
	});
	if (!response.ok) throw new Error("Sign in is temporarily unavailable.");
	const result = (await response.json()) as { authenticated?: boolean; url?: string };
	if (result.authenticated) {
		popup?.close();
		window.location.reload();
		return;
	}
	if (!result.url) throw new Error("Sign in is not configured.");
	if (popup && !popup.closed) popup.location.assign(result.url);
	else window.location.assign(result.url);
}

async function signOut(returnTo = "/", preserveRecentProjects = false): Promise<void> {
	await revokeAccountSession();
	if (!preserveRecentProjects) persistRecentProjects();
	window.location.assign(returnTo);
}

export function App() {
	return <BuilderApp />;
}

function BuilderApp() {
	const { appearance, updateAppearance } = useAppearance();
	const [session, setSession] = useState<ProjectSession>();
	const [sessionError, setSessionError] = useState<string>();
	const [deletionPendingId, setDeletionPendingId] = useState<string>();
	const [deleteRetryError, setDeleteRetryError] = useState<string>();
	const [retryingDeletion, setRetryingDeletion] = useState(false);
	const [account, setAccount] = useState<AccountStatus>();
	const [completingAuth, setCompletingAuth] = useState(false);
	const [authCompletionError, setAuthCompletionError] = useState<string>();
	const [authToast, setAuthToast] = useState<AuthToast>();
	const [openingProjectId, setOpeningProjectId] = useState<string>();
	const [bootAttempt, setBootAttempt] = useState(0);
	const creationAttempt = useRef(pendingProjectCreation());
	const loginPopup = useRef<Window | null>(null);
	const sessionRef = useRef(session);
	const navigationSequence = useRef(0);
	const projectPreload = useRef<
		{ projectId: string; promise: Promise<ProjectSession> } | undefined
	>(undefined);
	sessionRef.current = session;

	useEffect(() => {
		if (!authToast || (authToast.waitForReady && !session && !completingAuth)) return;
		toasts.add({
			id: "auth-error",
			title: authToast.message,
			variant: "error",
			priority: "high",
		});
		setAuthToast(undefined);
	}, [authToast, completingAuth, session]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin || event.source !== loginPopup.current) return;
			if (event.data?.type === "emdash-auth-complete") {
				loginPopup.current = null;
				window.location.reload();
			} else if (event.data?.type === "emdash-auth-failed") {
				loginPopup.current = null;
				setAuthToast({ message: "Sign in failed. Please try again." });
			}
		};
		const onFocus = () => {
			if (!loginPopup.current) return;
			void readAccountStatus()
				.then((status) => {
					if (status.authenticated && status.claimStatus === "complete") {
						loginPopup.current = null;
						window.location.reload();
					}
				})
				.catch(() => {});
		};
		window.addEventListener("message", onMessage);
		window.addEventListener("focus", onFocus);
		return () => {
			window.removeEventListener("message", onMessage);
			window.removeEventListener("focus", onFocus);
		};
	}, []);

	const handleSignIn = useCallback((returnTo: string) => {
		if (loginPopup.current && !loginPopup.current.closed) {
			loginPopup.current.focus();
			return;
		}
		let popup: Window | null = null;
		try {
			popup = window.open("", "emdash-sign-in", "popup,width=520,height=700");
		} catch {
			// Browsers that disallow popups can use the same-tab login route.
		}
		loginPopup.current = popup;
		void beginLogin(returnTo, popup).catch((error: unknown) => {
			popup?.close();
			loginPopup.current = null;
			setAuthToast({ message: error instanceof Error ? error.message : "Sign in failed." });
		});
	}, []);

	const preloadProject = useCallback((projectId: string) => {
		const current = projectPreload.current;
		if (current?.projectId === projectId) return current.promise;
		const promise = preloadProjectSession(projectId);
		const entry = { projectId, promise };
		projectPreload.current = entry;
		void promise.then(
			() => {
				if (projectPreload.current === entry) projectPreload.current = undefined;
			},
			() => {
				if (projectPreload.current === entry) projectPreload.current = undefined;
			},
		);
		return promise;
	}, []);

	const handlePreloadProject = useCallback(
		(projectId: string) => {
			if (sessionRef.current?.projectId === projectId) return;
			void preloadProject(projectId).catch(() => {});
		},
		[preloadProject],
	);

	const openProject = useCallback((projectId: string, history: "push" | "pop" = "push") => {
		if (sessionRef.current?.projectId === projectId) {
			navigationSequence.current += 1;
			setOpeningProjectId(undefined);
			return;
		}
		const sequence = ++navigationSequence.current;
		setOpeningProjectId(projectId);
		void preloadProjectSession(projectId)
			.then((nextSession) => {
				if (navigationSequence.current !== sequence) return;
				if (history === "push") window.history.pushState(null, "", `/s/${projectId}`);
				setSession(nextSession);
				window.requestAnimationFrame(() => {
					document.querySelector<HTMLElement>("[data-project-title]")?.focus();
				});
			})
			.catch(() => {
				if (navigationSequence.current !== sequence) return;
				if (history === "push") window.location.assign(`/s/${projectId}`);
				else window.location.reload();
			})
			.finally(() => {
				if (navigationSequence.current === sequence) setOpeningProjectId(undefined);
			});
	}, []);

	useEffect(() => {
		const onPopState = () => {
			const projectId = requestedProjectId();
			if (projectId) openProject(projectId, "pop");
			else window.location.reload();
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [openProject]);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const currentUrl = new URL(window.location.href);
				const createNew = currentUrl.searchParams.get("new") === "1";
				if (currentUrl.searchParams.get("auth") === "failed") {
					if (window.opener && !window.opener.closed) {
						window.opener.postMessage({ type: "emdash-auth-failed" }, window.location.origin);
						window.close();
						return;
					}
					setAuthToast({
						message: "Sign in failed. Please try again.",
						waitForReady: true,
					});
					currentUrl.searchParams.delete("auth");
					window.history.replaceState(null, "", currentUrl.pathname + currentUrl.search);
				}
				const nextAccount = await readAccountStatus();
				if (cancelled) return;
				setAccount(nextAccount);
				if (needsAuthCompletion(nextAccount, window.location.pathname)) {
					setCompletingAuth(true);
					return;
				}
				if (!nextAccount.authenticated && window.location.pathname === "/auth/complete") {
					window.history.replaceState(null, "", "/");
				}
				const projectId = requestedProjectId();
				const creation = projectId ? undefined : creationAttempt.current;
				const createProjectId = creation?.projectId;
				const projectRequest = {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						projectId
							? { projectId }
							: {
									createProjectId,
									creationToken: creation?.creationToken,
									...(createNew ? { createNew: true } : {}),
								},
					),
				};
				const response = await fetchWithTransientRetries("/api/project-session", projectRequest);
				if (!response.ok) {
					if (projectId && response.status === 409) {
						const result = (await response.json().catch(() => ({}))) as { code?: string };
						if (result.code === "PROJECT_DELETION_PENDING") {
							const finished = await finishPendingDeletion(projectId).catch(() => false);
							if (cancelled) return;
							if (finished) window.location.assign("/");
							else setDeletionPendingId(projectId);
							return;
						}
					}
					throw new Error("This project is unavailable in this browser session.");
				}
				const nextSession = (await response.json()) as ProjectSession;
				if (!cancelled) {
					if (nextSession.projectId !== createProjectId)
						clearPendingProjectCreation(createProjectId);
					setSession(nextSession);
				}
			} catch {
				if (!cancelled) {
					setSessionError(
						requestedProjectId() ? "We couldn't open this site." : "We couldn't start a site.",
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [bootAttempt]);

	const finishAuthentication = useCallback(async (returnPath: string) => {
		let recentProjectId: string | undefined;
		if (returnPath === "/") {
			const response = await fetch("/api/projects");
			if (!response.ok) throw new Error("Your projects could not be loaded right now.");
			const result = (await response.json()) as { projects?: ProjectSummary[] };
			recentProjectId = mostRecentProjectId(result.projects ?? []);
		}
		const destination = postAuthDestination(returnPath, recentProjectId);
		if (window.opener && !window.opener.closed) {
			window.opener.postMessage({ type: "emdash-auth-complete" }, window.location.origin);
			window.close();
			return;
		}
		window.location.replace(destination);
	}, []);
	const handleSignOut = useCallback(() => {
		void signOut().catch((error: unknown) => {
			setAuthToast({ message: error instanceof Error ? error.message : "Sign out failed." });
		});
	}, []);
	const handleClaimSignOut = useCallback(() => {
		void signOut(account?.returnPath ?? "/", true).catch((error: unknown) => {
			setAuthCompletionError(error instanceof Error ? error.message : "Sign out failed.");
		});
	}, [account?.returnPath]);

	if (sessionError) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 bg-surface px-6 text-center text-sm text-text-secondary">
				<p>{sessionError}</p>
				<button
					type="button"
					className="primary-button"
					onClick={() => {
						setSessionError(undefined);
						setBootAttempt((attempt) => attempt + 1);
					}}
				>
					Try again
				</button>
				<a className="text-text-primary underline" href="/">
					Back to projects
				</a>
			</div>
		);
	}
	if (deletionPendingId) {
		return (
			<main className="flex h-full flex-col items-center justify-center gap-3 bg-surface px-6 text-center text-sm text-text-secondary">
				<h1 className="text-lg font-semibold text-text-primary">Site deletion did not finish</h1>
				<p>Retry deleting the site and its saved build.</p>
				{deleteRetryError ? (
					<p role="alert" className="text-danger">
						{deleteRetryError}
					</p>
				) : null}
				<button
					type="button"
					className="primary-button"
					disabled={retryingDeletion}
					onClick={() => {
						setRetryingDeletion(true);
						void finishPendingDeletion(deletionPendingId)
							.then(async (finished) => {
								if (!finished) throw new Error("Deletion is still unavailable. Please try again.");
								window.location.assign("/");
							})
							.catch(() => setDeleteRetryError("Deletion is still unavailable. Please try again."))
							.finally(() => setRetryingDeletion(false));
					}}
				>
					{retryingDeletion ? "Deleting…" : "Retry deletion"}
				</button>
				<a className="text-text-primary underline" href="/">
					Back to projects
				</a>
			</main>
		);
	}
	if (account && completingAuth) {
		return (
			<AuthComplete
				initial={account}
				onComplete={finishAuthentication}
				onSignOut={handleClaimSignOut}
				errorMessage={authCompletionError}
			/>
		);
	}
	if (!session) {
		return (
			<div className="flex h-full items-center justify-center bg-surface text-sm text-text-tertiary">
				Connecting...
			</div>
		);
	}

	return (
		<Suspense
			fallback={
				<div className="flex h-full items-center justify-center bg-surface text-sm text-text-tertiary">
					Connecting...
				</div>
			}
		>
			<ErrorBoundary>
				<AppInner
					key={session.projectId}
					session={session}
					openingProjectId={openingProjectId}
					account={account ?? { authenticated: false }}
					appearance={appearance}
					onAppearanceChange={updateAppearance}
					onSignIn={handleSignIn}
					onSignOut={handleSignOut}
					onOpenProject={openProject}
					onPreloadProject={handlePreloadProject}
				/>
			</ErrorBoundary>
		</Suspense>
	);
}

function AppInner({
	session,
	openingProjectId,
	account,
	appearance,
	onAppearanceChange,
	onSignIn,
	onSignOut,
	onOpenProject,
	onPreloadProject,
}: {
	session: ProjectSession;
	openingProjectId?: string;
	account: AccountStatus;
	appearance: Appearance;
	onAppearanceChange: (appearance: Appearance) => void;
	onSignIn: (returnTo: string) => void;
	onSignOut: () => void;
	onOpenProject: (projectId: string) => void;
	onPreloadProject: (projectId: string) => void;
}) {
	const { projectId: sessionId, resuming } = session;
	const publishingEnabled = session.publishingEnabled === true;
	const [started, setStarted] = useState(resuming);
	const [status, setStatus] = useState("");
	const [serverTurnActive, setServerTurnActive] = useState(false);
	const [provisionError, setProvisionError] = useState<string>();
	const [persistenceError, setPersistenceError] = useState<string>();
	const saveRetryInFlight = useRef(false);
	const [consoleLines, setConsoleLines] = useState<string[]>([]);
	const [consoleOpen, setConsoleOpen] = useState(false);
	const [previewUrl, setPreviewUrl] = useState(session.previewUrl);
	const [cmsReady, setCmsReady] = useState(false);
	const [initialBuildStarted, setInitialBuildStarted] = useState(false);
	const [initialBuildComplete, setInitialBuildComplete] = useState(false);
	const [suggestions, setSuggestions] = useState<BuilderState["suggestions"]>();
	const [initialGeneration, setInitialGeneration] = useState<InitialGeneration>();
	const [buildDurationMs, setBuildDurationMs] = useState<number>();
	const [previewRestarting, setPreviewRestarting] = useState(false);
	const [slotWait, setSlotWait] = useState<BuilderState["sandboxWait"]>();
	const [sandboxPaused, setSandboxPaused] = useState(false);
	const sandboxPausedRef = useRef(false);
	const [reopenState, setReopenState] = useState<
		"waking" | "ready" | "failed" | "unknown" | "needsChat" | undefined
	>(resuming && session.previewUrl ? "waking" : undefined);
	// This tab's own reopen request, unlike the synced flag that tool restarts set too.
	const [resumingPreview, setResumingPreview] = useState(Boolean(resuming && session.previewUrl));
	// A dropped socket rejects the call while the server keeps restoring.
	const resumeOutcomeUnknown = useRef(false);
	const waitingForFirstSiteReady = useRef(false);
	const reopenFailed = useRef(false);
	const resumeSawServerWake = useRef(false);
	const resumeInFlight = useRef(false);
	const reloadEvents = useRef(0);
	const reloadAtResume = useRef(0);
	const lastRecoveryState = useRef<BuilderState | undefined>(undefined);
	const verifiedUnknownOnce = useRef(false);
	const retryRecoveryRef = useRef<() => void>(() => {});
	const [deploy, setDeploy] = useState<DeployInfo>();
	const [cloneOpen, setCloneOpen] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);
	const [chatWidth, setChatWidth] = useState(() =>
		Math.min(720, Math.max(440, Math.round(window.innerWidth * 0.3))),
	);
	const [detailsId, setDetailsId] = useState<string | null>(null);
	const detailsAnchor = useRef<{ index: number; role: "user" | "assistant" } | null>(null);
	const thumbnailRequests = useRef(
		new Map<string, Promise<{ base64: string; mediaType: "image/png" } | null>>(),
	);
	const [consoleHeight, setConsoleHeight] = useState(280);
	const [sidebarDefaultOpen] = useState(readSidebarOpen);
	const workspaceRef = useRef<HTMLDivElement>(null);
	const chatRef = useRef<HTMLDivElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);
	const previewTriggerRef = useRef<HTMLButtonElement>(null);
	const detailsReturnFocus = useRef<HTMLElement | null>(null);
	const focusAfterPreviewChange = useRef<"preview" | "trigger" | "layout" | null>(null);
	const onCompactChange = useCallback((next: boolean) => {
		const active = document.activeElement;
		if (
			next &&
			(previewRef.current?.contains(active) ||
				(active?.getAttribute("role") === "separator" &&
					active.getAttribute("aria-label") === "Chat width"))
		) {
			focusAfterPreviewChange.current = "layout";
		} else if (!next && active === previewTriggerRef.current) {
			focusAfterPreviewChange.current = "preview";
		}
	}, []);
	const {
		compact,
		previewCollapsed,
		previewExpanded,
		showPreview,
		hidePreview,
		toggleExpanded,
		restoreExpanded,
	} = useWorkspacePreview(onCompactChange);
	const [workspaceSize, setWorkspaceSize] = useState({ width: 0, height: 0 });
	const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>(
		() => session.projects ?? readRecentProjects(),
	);
	const [projectTitle, setProjectTitle] = useState(
		() =>
			(session.projects ?? readRecentProjects()).find((project) => project.id === sessionId)
				?.title ?? "Untitled site",
	);
	const initialProjectTitle = useRef(projectTitle);
	const customProjectTitle = useRef(false);
	const projectWrite = useRef<Promise<void>>(Promise.resolve());
	const projectUpdateTimer = useRef<number | undefined>(undefined);
	const initialRecoveryToastIds = useRef(new Set<string>());
	const initialRecoveryEpoch = useRef(0);
	const [liveUrl, setLiveUrl] = useState<string>();
	const [publishOpen, setPublishOpen] = useState(false);
	const [publishState, setPublishState] = useState<PublishState>({
		stage: account.authenticated ? "ready" : "authentication-required",
	});
	const publishInFlight = useRef(false);
	const openExport = useCallback(() => {
		setPublishOpen(false);
		setCloneOpen(true);
	}, []);

	// Deploys the user has dismissed, keyed by their `at` timestamp, so a
	// state re-sync doesn't resurrect a closed banner.
	const dismissedDeployAt = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (session.projects) persistRecentProjects(session.projects);
	}, [session.projects]);

	const onMessage = useCallback(
		(event: MessageEvent) => {
			try {
				const data = JSON.parse(event.data) as {
					type?: string;
					text?: string;
				};
				if (data.type === "console") {
					setConsoleLines((prev) => [...prev, data.text ?? ""]);
				} else if (data.type === "reload") {
					reloadEvents.current += 1;
					setReloadKey((k) => k + 1);
					if (reopenFailed.current) {
						reopenFailed.current = false;
						setReopenState("ready");
						setProvisionError(undefined);
					}
				} else if (data.type === "offer-clone") {
					openExport();
				}
			} catch {
				// Not a JSON message we care about
			}
		},
		[openExport],
	);
	const reconcileRecovery = useCallback((state: BuilderState | undefined) => {
		if (!state || (!resumeOutcomeUnknown.current && !waitingForFirstSiteReady.current))
			return false;
		if (waitingForFirstSiteReady.current && !state.siteReady) {
			const initialStatus = state.initialGeneration?.status;
			if (
				initialStatus === "stopped" ||
				initialStatus === "failed" ||
				initialStatus === "awaiting_answers"
			) {
				setResumingPreview(false);
				setReopenState("needsChat");
				return true;
			}
			if (initialStatus && isInitialGenerationActive(initialStatus)) {
				setResumingPreview(true);
				setReopenState("waking");
			}
		}
		const failed = Boolean(state.provisionError);
		const ready = waitingForFirstSiteReady.current
			? Boolean(state.siteReady && state.previewReady)
			: Boolean(
					resumeSawServerWake.current &&
					state.siteReady &&
					state.previewReady &&
					!state.previewRestarting &&
					!state.status,
				);
		if (!failed && !ready) return false;
		resumeOutcomeUnknown.current = false;
		waitingForFirstSiteReady.current = false;
		reopenFailed.current = failed;
		if (failed) resumeSawServerWake.current = false;
		setResumingPreview(false);
		setReopenState(failed ? "failed" : "ready");
		if (ready && reloadEvents.current === reloadAtResume.current) {
			setReloadKey((key) => key + 1);
		}
		return true;
	}, []);
	const verifyUnknownRecovery = useCallback(
		(state: BuilderState | undefined) => {
			if (
				!session.previewUrl ||
				!resumeOutcomeUnknown.current ||
				resumeSawServerWake.current ||
				verifiedUnknownOnce.current ||
				!state?.siteReady ||
				!state.previewReady ||
				state.previewRestarting ||
				state.status ||
				state.provisionError
			)
				return false;
			verifiedUnknownOnce.current = true;
			retryRecoveryRef.current();
			return true;
		},
		[session.previewUrl],
	);

	// Session state (preview URL, status line, deploy info) comes from the
	// agent's synced state rather than one-shot broadcasts, so a client that
	// connects mid-provision -- or refreshes -- always catches up.
	const onStateUpdate = useCallback(
		(state: BuilderState) => {
			lastRecoveryState.current = state;
			// Server progress lines end in "..."; the UI's own labels use an ellipsis.
			const nextStatus = (state.status ?? "").replace(/\.\.\.$/, "…");
			setStatus(nextStatus);
			if (nextStatus) {
				setPublishState((current) =>
					reducePublishState(current, { type: "progress", message: nextStatus }),
				);
			}
			setServerTurnActive(state.turnActive === true);
			setPreviewUrl(state.previewUrl);
			setCmsReady(state.cmsReady ?? state.siteReady);
			setInitialBuildStarted(state.buildStarted ?? false);
			setInitialBuildComplete(state.complete ?? false);
			if (state.initialGeneration || state.buildStarted || state.siteReady) {
				clearPendingProjectCreation(sessionId);
			}
			setSuggestions(state.suggestions);
			setInitialGeneration(state.initialGeneration);
			const buildStart = state.milestones?.buildStarting;
			const buildEnd = state.milestones?.complete;
			setBuildDurationMs(
				typeof buildStart === "number" && typeof buildEnd === "number" && buildEnd >= buildStart
					? buildEnd - buildStart
					: undefined,
			);
			setPreviewRestarting(state.previewRestarting ?? false);
			setSlotWait(state.sandboxWait);
			sandboxPausedRef.current = state.sandboxPaused === true;
			setSandboxPaused(sandboxPausedRef.current);
			if (state.previewRestarting) {
				resumeSawServerWake.current = true;
				if (resumeOutcomeUnknown.current) setReopenState("waking");
			}
			reconcileRecovery(state);
			verifyUnknownRecovery(state);
			if (
				reopenFailed.current &&
				resumeSawServerWake.current &&
				state.siteReady &&
				state.previewReady &&
				!state.previewRestarting &&
				!state.status &&
				!state.provisionError
			) {
				reopenFailed.current = false;
				setReopenState("ready");
				if (reloadEvents.current === reloadAtResume.current) setReloadKey((key) => key + 1);
			}
			setProvisionError(state.provisionError);
			setPersistenceError(state.persistenceError);
			const nextLiveUrl = publishingEnabled
				? (state.publication?.liveUrl ?? state.deploy?.liveUrl)
				: undefined;
			setLiveUrl(nextLiveUrl);
			if (publishingEnabled && state.publication) {
				setPublishState((current) =>
					reducePublishState(current, {
						type: "synced",
						liveUrl: state.publication!.liveUrl,
						releaseId: state.publication!.releaseId,
						publishedAt: state.publication!.at,
					}),
				);
			}
			if (
				publishingEnabled &&
				state.deploy &&
				state.deploy.at !== dismissedDeployAt.current &&
				state.deploy.at + CLAIM_WINDOW_MS > Date.now()
			) {
				setDeploy(state.deploy);
			}
		},
		[publishingEnabled, reconcileRecovery, sessionId, verifyUnknownRecovery],
	);

	const agent = useAgent<BuilderState>({
		agent: "BuilderAgent",
		name: sessionId,
		onMessage,
		onStateUpdate,
	});
	const persistenceToastId = `session-save-error:${sessionId}`;
	useEffect(() => {
		if (!persistenceError) {
			toasts.close(persistenceToastId);
			return;
		}
		const retry = () => {
			if (saveRetryInFlight.current) return;
			saveRetryInFlight.current = true;
			void agent
				.call<boolean>("retrySessionSave")
				.then((saved) => {
					if (saved) toasts.close(persistenceToastId);
				})
				.catch(() => {})
				.finally(() => {
					saveRetryInFlight.current = false;
				});
		};
		toasts.add({
			id: persistenceToastId,
			title: "Session changes could not be saved",
			description: "Your site is still open. Retry the latest checkpoint.",
			variant: "error",
			priority: "high",
			timeout: 0,
			actions: [{ children: "Retry", onClick: retry, variant: "secondary", size: "sm" }],
		});
	}, [agent, persistenceError, persistenceToastId]);
	useEffect(() => () => toasts.close(persistenceToastId), [persistenceToastId]);

	const chat = useAgentChat({
		agent,
		messages: session.initialMessages,
		getInitialMessages: session.initialMessages !== undefined ? null : resuming ? undefined : null,
		// Server-initiated build turns can replay a burst of buffered text/tool
		// parts. Batch external-store notifications so React never receives dozens
		// of nested synchronous message updates ("maximum update depth exceeded").
		experimental_throttle: 50,
		// Switching projects detaches this client without stopping server work.
		// The explicit Stop action still cancels the active server turn.
		cancelOnClientAbort: false,
		// Tell the agent which host the app is loaded from so it can build a
		// preview URL that routes back here. In dev this is localhost:<port>
		// (so the preview proxy hits the local worker); in prod it's the real
		// host. Available on the agent as `options.body.appHost`.
		body: { appHost: window.location.host },
	});
	const loadRecoveryState = useCallback(
		() => agent.call<ClientRecoveryState>("getClientRecoveryState"),
		[agent],
	);
	const sendInitialMessage = useCallback(
		(text: string, files: FileUIPart[]) => {
			const recoveryEpoch = initialRecoveryEpoch.current;
			const messageId = crypto.randomUUID();
			const toastId = `initial-send-error:${sessionId}:${messageId}`;
			const message = {
				id: messageId,
				role: "user" as const,
				parts: [...files, { type: "text" as const, text }],
			};
			const closeToast = () => {
				toasts.close(toastId);
				initialRecoveryToastIds.current.delete(toastId);
			};
			async function reconcile() {
				if (recoveryEpoch !== initialRecoveryEpoch.current) return;
				const recovered = await readClientRecoveryState(loadRecoveryState);
				if (recoveryEpoch !== initialRecoveryEpoch.current) return;
				if (recovered) {
					chat.setMessages(recovered.messages);
					chat.clearError();
				}
				const delivery = messageDeliveryStatus(recovered, messageId);
				if (delivery === "received") {
					closeToast();
					return;
				}
				let actionUsed = false;
				initialRecoveryToastIds.current.add(toastId);
				toasts.add({
					id: toastId,
					title: delivery === "not-received" ? "Message was not sent" : "Connection interrupted",
					description:
						delivery === "not-received"
							? "Your brief and photos are ready to retry."
							: "Check whether your brief reached the site before retrying.",
					variant: "error",
					priority: "high",
					timeout: 0,
					actions: [
						{
							children: delivery === "not-received" ? "Retry" : "Check again",
							onClick: () => {
								if (recoveryEpoch !== initialRecoveryEpoch.current) return;
								if (actionUsed) return;
								actionUsed = true;
								closeToast();
								if (delivery === "not-received") send();
								else void reconcile();
							},
							variant: "secondary",
							size: "sm",
						},
					],
				});
			}
			function send() {
				if (recoveryEpoch !== initialRecoveryEpoch.current) return;
				void Promise.resolve()
					.then(() => chat.sendMessage(message))
					.then(closeToast)
					.catch(reconcile);
			}
			send();
		},
		[chat, loadRecoveryState, sessionId],
	);
	useEffect(() => {
		const recoveryEpoch = ++initialRecoveryEpoch.current;
		return () => {
			if (initialRecoveryEpoch.current === recoveryEpoch) initialRecoveryEpoch.current += 1;
			for (const toastId of initialRecoveryToastIds.current) toasts.close(toastId);
			initialRecoveryToastIds.current.clear();
		};
	}, [sessionId]);

	const publishSite = useCallback(
		async (slug?: string) => {
			if (!account.authenticated || publishInFlight.current) return;
			publishInFlight.current = true;
			setPublishState((state) => reducePublishState(state, { type: "started" }));
			let failureReference: string | undefined;
			try {
				const response = await fetch(`/api/projects/${sessionId}/publish`, {
					method: "POST",
					...(slug
						? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) }
						: {}),
				});
				const body: {
					status?: unknown;
					liveUrl?: unknown;
					releaseId?: unknown;
					publishedAt?: unknown;
					message?: unknown;
					reference?: unknown;
				} = await response
					.json<{
						status?: unknown;
						liveUrl?: unknown;
						releaseId?: unknown;
						publishedAt?: unknown;
						message?: unknown;
						reference?: unknown;
					}>()
					.catch(() => ({}));
				failureReference = typeof body.reference === "string" ? body.reference : undefined;
				if (
					!response.ok ||
					body.status !== "live" ||
					typeof body.liveUrl !== "string" ||
					typeof body.releaseId !== "string" ||
					typeof body.publishedAt !== "number" ||
					!Number.isFinite(body.publishedAt)
				) {
					throw new Error(
						typeof body.message === "string"
							? body.message
							: "Publishing failed. The current Live site was not changed.",
					);
				}
				const publicUrl = new URL(body.liveUrl);
				if (publicUrl.protocol !== "https:" && publicUrl.protocol !== "http:") {
					throw new Error("Publishing returned an invalid public URL.");
				}
				setLiveUrl(publicUrl.href.replace(/\/$/, ""));
				setPublishState((state) =>
					reducePublishState(state, {
						type: "succeeded",
						liveUrl: publicUrl.href.replace(/\/$/, ""),
						releaseId: body.releaseId as string,
						publishedAt: body.publishedAt as number,
					}),
				);
			} catch (error) {
				setPublishState((state) =>
					reducePublishState(state, {
						type: "failed",
						message: error instanceof Error ? error.message : "Publishing failed.",
						reference: failureReference,
					}),
				);
			} finally {
				publishInFlight.current = false;
			}
		},
		[account.authenticated, sessionId],
	);

	// Opening an established project should wake its Sandbox and reactivate the
	// stable preview URL immediately; recovery must not wait for another chat
	// message. The server owns the operation and syncs progress through state.
	const resumeRequested = useRef(false);
	const retryRecovery = useCallback(() => {
		if (resumeInFlight.current) return;
		resumeInFlight.current = true;
		resumeOutcomeUnknown.current = false;
		waitingForFirstSiteReady.current = false;
		reopenFailed.current = false;
		resumeSawServerWake.current = false;
		lastRecoveryState.current = undefined;
		reloadAtResume.current = reloadEvents.current;
		if (session.previewUrl) setReopenState("waking");
		setResumingPreview(true);
		setProvisionError(undefined);
		agent
			.call<{ ready: boolean; error?: string }>("resumePreview", [window.location.host])
			.then((result) => {
				resumeInFlight.current = false;
				setPreviewRestarting(false);
				if (session.previewUrl && !result.ready && result.error === "The site is not ready yet.") {
					waitingForFirstSiteReady.current = true;
					reconcileRecovery(lastRecoveryState.current);
					return;
				}
				setResumingPreview(false);
				reopenFailed.current = Boolean(session.previewUrl && !result.ready);
				if (session.previewUrl) setReopenState(result.ready ? "ready" : "failed");
				if (!result.ready) {
					if (result.error) setProvisionError(result.error);
				} else if (reloadEvents.current === reloadAtResume.current) {
					setReloadKey((key) => key + 1);
				}
			})
			.catch(() => {
				resumeInFlight.current = false;
				resumeOutcomeUnknown.current = true;
				if (reconcileRecovery(lastRecoveryState.current)) return;
				if (verifyUnknownRecovery(lastRecoveryState.current)) return;
				if (session.previewUrl) setReopenState(resumeSawServerWake.current ? "waking" : "unknown");
			});
	}, [agent, session.previewUrl, reconcileRecovery, verifyUnknownRecovery]);
	retryRecoveryRef.current = retryRecovery;
	useEffect(() => {
		if (!resuming || resumeRequested.current) return;
		resumeRequested.current = true;
		retryRecovery();
	}, [resuming, retryRecovery]);
	useSandboxHeartbeat(agent);
	// Coming back to a tab whose idle editor was stopped resumes it.
	useEffect(() => {
		const resumeWhenSeen = () => {
			if (document.visibilityState === "visible" && sandboxPausedRef.current) {
				retryRecoveryRef.current();
			}
		};
		document.addEventListener("visibilitychange", resumeWhenSeen);
		return () => document.removeEventListener("visibilitychange", resumeWhenSeen);
	}, []);
	const projectStatus: ProjectSummary["status"] = provisionError
		? "failed"
		: liveUrl
			? "live"
			: chat.isStreaming || Boolean(status)
				? "building"
				: "draft";
	// The open site shimmers from its live state: a turn in flight (from any
	// tab), or first-build setup reporting progress. A preview restore is not.
	const activeBuilding =
		isTurnActive(chat, serverTurnActive) ||
		(initialGeneration !== undefined &&
			isInitialGenerationActive(initialGeneration.status) &&
			Boolean(status));
	const sidebarProjects = useMemo(
		() =>
			recentProjects.map((project) =>
				project.id === sessionId ? { ...project, building: activeBuilding } : project,
			),
		[recentProjects, sessionId, activeBuilding],
	);
	const activeProject = useRef({ title: projectTitle, status: projectStatus });
	useEffect(() => {
		activeProject.current = { title: projectTitle, status: projectStatus };
	}, [projectTitle, projectStatus]);
	const hasMessages = chat.messages.length > 0;
	// Bumped by local renames and deletions: a refresh that started before one
	// carries the old list and must not undo it.
	const localListChange = useRef(0);
	const refreshRecentProjects = useCallback(async () => {
		const startedAt = localListChange.current;
		const response = await fetch("/api/projects").catch(() => undefined);
		if (!response?.ok) return;
		const result = (await response.json().catch(() => ({}))) as { projects?: ProjectSummary[] };
		if (!Array.isArray(result.projects) || localListChange.current !== startedAt) return;
		const listed = result.projects;
		setRecentProjects(() => {
			// The server's list and flags win; the open site keeps its local name and status.
			const next = hasMessages
				? upsertActiveProject(listed, { id: sessionId, ...activeProject.current }, !resuming)
				: listed;
			persistRecentProjects(next);
			return next;
		});
	}, [hasMessages, resuming, sessionId]);
	useProjectListRefresh(
		recentProjects.some((project) => project.id !== sessionId && project.building),
		() => void refreshRecentProjects(),
	);
	const writeProject = useCallback(
		(title: string, status: ProjectSummary["status"]) => {
			const write = projectWrite.current.then(async () => {
				const response = await fetchWithTransientRetries(`/api/projects/${sessionId}`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title, status }),
				});
				if (!response.ok) throw new Error("Project update failed.");
				toasts.close(`project-update-error:${sessionId}`);
			});
			projectWrite.current = write.catch(() => {});
			return write;
		},
		[sessionId],
	);
	const showProjectWriteFailure = useCallback(
		(title: string, status: ProjectSummary["status"]) => {
			const toastId = `project-update-error:${sessionId}`;
			let actionUsed = false;
			toasts.add({
				id: toastId,
				title: "Site details could not be saved",
				description: "Retry the latest name and status update.",
				variant: "error",
				priority: "high",
				timeout: 0,
				actions: [
					{
						children: "Retry",
						onClick: () => {
							if (actionUsed) return;
							actionUsed = true;
							void writeProject(title, status).catch(() => {
								actionUsed = false;
							});
						},
						variant: "secondary",
						size: "sm",
					},
				],
			});
		},
		[sessionId, writeProject],
	);
	useEffect(() => () => toasts.close(`project-update-error:${sessionId}`), [sessionId]);

	const fetchCloneInfo = useCallback(() => agent.call<CloneInfo>("getCloneInfo"), [agent]);
	const reportPreviewPath = useCallback(
		(path: string) => {
			agent.call("setPreviewPath", [path]).catch(() => {});
		},
		[agent],
	);
	const refreshPreviewRoute = useCallback(
		(path: string) => agent.call<{ refreshed: boolean }>("refreshPreviewRoute", [path]),
		[agent],
	);
	const checkPreviewRoute = useCallback(
		(path: string) =>
			agent.call<"current" | "stale" | "missing">("getPreviewRouteSnapshot", [path]),
		[agent],
	);

	// Console lines arrive as fire-and-forget broadcasts, so a reload starts with
	// an empty panel ("Waiting for output..."). Rehydrate once from the agent's
	// buffer; only seed if we haven't already received live lines.
	const consoleSeeded = useRef(false);
	useEffect(() => {
		if (consoleSeeded.current) return;
		consoleSeeded.current = true;
		agent
			.call<string[]>("getRecentConsole")
			.then((lines) => {
				if (Array.isArray(lines) && lines.length > 0) {
					setConsoleLines((prev) => (prev.length === 0 ? lines : prev));
				}
			})
			.catch(() => {});
	}, [agent]);

	// Track when the first message is sent. Use View Transitions API
	// for the landing → build morph when available.
	useEffect(() => {
		if (chat.messages.length === 0 || started) return;
		if (window.location.pathname !== `/s/${sessionId}`) {
			window.history.replaceState(null, "", `/s/${sessionId}`);
		}
		const doc = document as Document & {
			startViewTransition?: (cb: () => void) => { finished: Promise<void> };
		};
		if (typeof doc.startViewTransition === "function") {
			doc.startViewTransition(() => {
				flushSync(() => setStarted(true));
			});
		} else {
			setStarted(true);
		}
	}, [chat.messages.length, sessionId, started]);

	useEffect(() => {
		if (chat.messages.length === 0) return;
		const title = projectTitleFromChat(chat.messages);
		if (customProjectTitle.current) return;
		if (initialProjectTitle.current !== "Untitled site" && initialProjectTitle.current !== title) {
			customProjectTitle.current = true;
			return;
		}
		setProjectTitle(title);
	}, [chat.messages]);

	useEffect(() => {
		if (chat.messages.length === 0) return;
		setRecentProjects((projects) => {
			const next = upsertActiveProject(
				projects,
				{ id: sessionId, title: projectTitle, status: projectStatus },
				!resuming,
			);
			if (next !== projects) persistRecentProjects(next);
			return next;
		});
	}, [chat.messages.length, projectTitle, projectStatus, sessionId, resuming]);

	useEffect(() => {
		if (chat.messages.length === 0) return;
		projectUpdateTimer.current = window.setTimeout(() => {
			void writeProject(projectTitle, projectStatus).catch(() =>
				showProjectWriteFailure(projectTitle, projectStatus),
			);
		}, 500);
		return () => window.clearTimeout(projectUpdateTimer.current);
	}, [chat.messages.length, projectStatus, projectTitle, showProjectWriteFailure, writeProject]);

	const renameProject = useCallback(
		async (title: string) => {
			window.clearTimeout(projectUpdateTimer.current);
			await writeProject(title, projectStatus);
			customProjectTitle.current = true;
			setProjectTitle(title);
		},
		[projectStatus, writeProject],
	);
	const renameRecentProject = useCallback(
		async (projectId: string, title: string) => {
			localListChange.current += 1;
			if (projectId === sessionId) {
				await renameProject(title);
			} else {
				const response = await fetch(`/api/projects/${projectId}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title }),
				});
				if (!response.ok) throw new Error("Site name could not be saved.");
			}
			localListChange.current += 1;
			setRecentProjects((projects) => {
				const next = projects.map((project) =>
					project.id === projectId ? { ...project, title } : project,
				);
				persistRecentProjects(next);
				return next;
			});
		},
		[renameProject, sessionId],
	);
	const deleteRecentProject = useCallback(
		async (projectId: string) => {
			localListChange.current += 1;
			const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
			if (!response.ok) {
				const result = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(result.error ?? "Could not delete this site. Please retry.");
			}
			localListChange.current += 1;
			setRecentProjects((projects) => {
				const next = projects.filter((project) => project.id !== projectId);
				persistRecentProjects(next);
				return next;
			});
			if (projectId === sessionId) window.location.assign("/");
		},
		[sessionId],
	);

	useEffect(() => {
		if (!started) return;
		const workspace = workspaceRef.current;
		if (!workspace) return;
		const update = () => {
			const width = workspace.clientWidth;
			const height = workspace.clientHeight;
			setWorkspaceSize((previous) =>
				previous.width === width && previous.height === height ? previous : { width, height },
			);
		};
		const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
		observer?.observe(workspace);
		window.addEventListener("resize", update);
		update();
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [started]);

	const maxChatWidth = workspaceSize.width
		? Math.max(320, Math.min(800, workspaceSize.width - 392))
		: 800;
	const visibleChatWidth = Math.min(chatWidth, maxChatWidth);
	const maxConsoleHeight = workspaceSize.height
		? Math.max(100, Math.min(600, workspaceSize.height - 300))
		: 600;
	const visibleConsoleHeight = Math.min(consoleHeight, maxConsoleHeight);

	const onChatResize = useCallback(
		(delta: number) => {
			setChatWidth((width) =>
				Math.round(Math.max(320, Math.min(maxChatWidth, Math.min(width, maxChatWidth) + delta))),
			);
		},
		[maxChatWidth],
	);

	const onConsoleResize = useCallback(
		(delta: number) => {
			setConsoleHeight((height) =>
				Math.round(
					Math.max(100, Math.min(maxConsoleHeight, Math.min(height, maxConsoleHeight) - delta)),
				),
			);
		},
		[maxConsoleHeight],
	);

	const openCompactPreview = useCallback(() => {
		focusAfterPreviewChange.current = "preview";
		showPreview();
	}, [showPreview]);
	const closeCompactPreview = useCallback(() => {
		focusAfterPreviewChange.current = "trigger";
		hidePreview();
	}, [hidePreview]);
	// The list details are resolved against: the anchor's index must match it.
	const replyMessages = useMemo(
		() => withoutEmptyReplies(chat.messages, chat.isStreaming),
		[chat.messages, chat.isStreaming],
	);
	const displayedInitialGeneration = useMemo(
		() =>
			initialGenerationForDisplay(replyMessages, initialGeneration, {
				buildStarted: initialBuildStarted,
				buildComplete: initialBuildComplete,
				awaitingAnswers: Boolean(findPendingQuestionnaire(replyMessages)),
				active: isTurnActive(chat, serverTurnActive),
			}),
		[
			chat.isStreaming,
			chat.status,
			initialBuildComplete,
			initialBuildStarted,
			initialGeneration,
			replyMessages,
			serverTurnActive,
		],
	);
	const openDetails = useCallback(
		(messageId: string) => {
			detailsReturnFocus.current = document.activeElement as HTMLElement;
			const index = replyMessages.findIndex((message) => message.id === messageId);
			const role = replyMessages[index]?.role;
			detailsAnchor.current =
				index >= 0 && (role === "user" || role === "assistant") ? { index, role } : null;
			setDetailsId(messageId);
			restoreExpanded();
			if (compact) showPreview();
		},
		[replyMessages, compact, restoreExpanded, showPreview],
	);
	const closeDetails = useCallback(() => {
		detailsAnchor.current = null;
		setDetailsId(null);
	}, []);
	const selectDetails = useCallback(
		(messageId: string) => {
			if (
				detailsId === messageId ||
				resolveDetails(replyMessages, detailsId, detailsAnchor.current, displayedInitialGeneration)
					.message?.id === messageId
			) {
				return;
			}
			openDetails(messageId);
		},
		[replyMessages, detailsId, openDetails, displayedInitialGeneration],
	);
	useLayoutEffect(() => {
		if (compact && detailsId && previewCollapsed) showPreview();
	}, [compact, detailsId, previewCollapsed, showPreview]);

	useLayoutEffect(() => {
		if (detailsId) {
			previewRef.current?.querySelector<HTMLElement>(".build-details button")?.focus();
		} else if (detailsReturnFocus.current) {
			if (compact) {
				previewRef.current
					?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
					?.focus();
			} else {
				detailsReturnFocus.current.focus();
			}
			detailsReturnFocus.current = null;
		}
	}, [detailsId, compact]);

	useLayoutEffect(() => {
		if (detailsId && !previewCollapsed) {
			if (!previewRef.current?.querySelector(".build-details")?.contains(document.activeElement)) {
				previewRef.current?.querySelector<HTMLElement>(".build-details button")?.focus();
			}
			focusAfterPreviewChange.current = null;
		} else if (focusAfterPreviewChange.current === "layout" && compact) {
			if (previewCollapsed) previewTriggerRef.current?.focus();
			else if (!previewRef.current?.contains(document.activeElement)) {
				previewRef.current
					?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
					?.focus();
			}
			focusAfterPreviewChange.current = null;
		} else if (focusAfterPreviewChange.current === "preview" && !previewCollapsed) {
			previewRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
			focusAfterPreviewChange.current = null;
		} else if (focusAfterPreviewChange.current === "trigger" && previewCollapsed) {
			previewTriggerRef.current?.focus();
			focusAfterPreviewChange.current = null;
		} else if (compact && !previewCollapsed && chatRef.current?.contains(document.activeElement)) {
			previewRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
		}
	}, [compact, previewCollapsed, detailsId]);

	useEffect(() => {
		if (!detailsId && !previewExpanded && (!compact || previewCollapsed)) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			if (detailsId) closeDetails();
			else if (previewExpanded) restoreExpanded();
			else closeCompactPreview();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [
		compact,
		previewCollapsed,
		previewExpanded,
		detailsId,
		closeDetails,
		restoreExpanded,
		closeCompactPreview,
	]);

	const { message: detailsMessage, isLatestTurn } = resolveDetails(
		replyMessages,
		detailsId,
		detailsAnchor.current,
		displayedInitialGeneration,
	);
	const detailsLive = detailsActivity({
		turnActive: isTurnActive(chat, serverTurnActive),
		isStreaming: chat.isStreaming,
		isLatestTurn,
		message: detailsMessage,
		initialGeneration,
		status,
	});
	const stopGeneration = useCallback(async () => {
		const generationId =
			initialGeneration && isInitialGenerationActive(initialGeneration.status)
				? initialGeneration.id
				: undefined;
		const stopped = await agent.call<boolean>("stopGeneration", [generationId]);
		if (!stopped) throw new Error("Could not confirm the build stopped. Check its activity.");
	}, [agent, initialGeneration?.id, initialGeneration?.status]);
	const setupAnswer = setupAnswerForDetails(replyMessages, detailsMessage?.id ?? detailsId);
	const loadPreviewThumbnail = useCallback(
		(shotId: string) => {
			const requests = thumbnailRequests.current;
			const cached = requests.get(shotId);
			if (cached) return cached;
			let request: Promise<{ base64: string; mediaType: "image/png" } | null>;
			request = agent
				.call<{ base64: string; mediaType: "image/png" } | null>("getPreviewThumbnail", [shotId])
				.catch((error: unknown) => {
					if (requests.get(shotId) === request) requests.delete(shotId);
					throw error;
				});
			requests.set(shotId, request);
			if (requests.size > 3) {
				const oldest = requests.keys().next().value;
				if (oldest) requests.delete(oldest);
			}
			return request;
		},
		[agent],
	);

	const recentProjectId = mostRecentProjectId(recentProjects);
	const newSiteRequested = new URLSearchParams(window.location.search).get("new") === "1";
	if (!started && !account.authenticated && !newSiteRequested) {
		return (
			<LandingView
				onSubmitMessage={sendInitialMessage}
				account={account}
				appearance={appearance}
				onAppearanceChange={onAppearanceChange}
				onSignIn={() => onSignIn("/")}
				onSignOut={onSignOut}
				onOpenProjects={recentProjectId ? () => onOpenProject(recentProjectId) : undefined}
			/>
		);
	}

	return (
		<Sidebar.Provider
			defaultOpen={sidebarDefaultOpen}
			onOpenChange={persistSidebarOpen}
			className="relative h-full min-h-0! bg-surface text-text-primary"
		>
			<SidebarAccessibility />
			<SidebarKeyboardShortcut />
			<ProjectSidebar
				projects={sidebarProjects}
				activeProjectId={started ? (openingProjectId ?? sessionId) : ""}
				newProjectActive={!started}
				appearance={appearance}
				onAppearanceChange={onAppearanceChange}
				onNewProject={() => {
					if (started) window.location.assign("/?new=1");
					else
						window.setTimeout(
							() => workspaceRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(),
							0,
						);
				}}
				onOpenProject={onOpenProject}
				onPreloadProject={onPreloadProject}
				onRenameProject={renameRecentProject}
				onDeleteProject={deleteRecentProject}
			/>

			<div
				ref={workspaceRef}
				className="relative flex min-w-0 flex-1 flex-col"
				data-sidebar-workspace
			>
				{!started ? (
					<LandingView
						embedded
						onSubmitMessage={sendInitialMessage}
						account={account}
						appearance={appearance}
						onAppearanceChange={onAppearanceChange}
						onSignIn={() => onSignIn("/")}
						onSignOut={onSignOut}
					/>
				) : (
					<>
						<ProjectHeader
							title={projectTitle}
							previewCollapsed={previewCollapsed}
							onRename={renameProject}
							onTogglePreview={openCompactPreview}
							previewTriggerRef={previewTriggerRef}
							publishControl={
								publishingEnabled ? (
									<PublishPanel
										projectId={sessionId}
										open={publishOpen}
										onOpenChange={(open) => {
											if (open) setCloneOpen(false);
											setPublishOpen(open);
										}}
										state={publishState}
										onPublish={publishSite}
										onSignIn={() => {
											setPublishOpen(false);
											onSignIn(`/s/${sessionId}`);
										}}
									/>
								) : (
									false
								)
							}
							exportControl={
								previewUrl ? (
									<ExportPanel
										open={cloneOpen}
										onOpenChange={(open) => {
											if (open) setPublishOpen(false);
											setCloneOpen(open);
										}}
										fetchCloneInfo={fetchCloneInfo}
									/>
								) : undefined
							}
							accountActions={
								<AccountControl
									authenticated={account.authenticated}
									onSignIn={() => onSignIn(`/s/${sessionId}`)}
									onSignOut={onSignOut}
								/>
							}
						/>
						{deploy ? (
							<DeployCard
								deploy={deploy}
								onDismiss={() => {
									dismissedDeployAt.current = deploy.at;
									setDeploy(undefined);
								}}
								onClone={openExport}
							/>
						) : null}
						<div className="relative flex min-h-0 flex-1">
							{previewExpanded ? null : (
								<div
									ref={chatRef}
									id="project-chat"
									inert={compact && !previewCollapsed}
									aria-hidden={compact && !previewCollapsed ? true : undefined}
									className="project-chat flex shrink-0 flex-col"
									style={{
										width: visibleChatWidth,
										maxWidth: "calc(100% - 392px)",
										viewTransitionName: "chat-shell",
									}}
								>
									<ChatPanel
										chat={chat}
										status={status}
										serverTurnActive={serverTurnActive}
										provisionError={provisionError}
										buildStarted={initialBuildStarted}
										buildComplete={initialBuildComplete}
										initialGeneration={displayedInitialGeneration}
										buildDurationMs={buildDurationMs}
										suggestions={suggestions}
										draftStorageKey={`emdash-build:chat-draft:${sessionId}`}
										onStopGeneration={stopGeneration}
										loadRecoveryState={loadRecoveryState}
										loadPreviewThumbnail={loadPreviewThumbnail}
										onPreviewSite={() => {
											closeDetails();
											openCompactPreview();
										}}
										onOpenDetails={selectDetails}
										selectedDetailsId={detailsMessage?.id ?? detailsId}
									/>
								</div>
							)}

							{compact || previewCollapsed || previewExpanded ? null : (
								<ResizeHandle
									direction="horizontal"
									onResize={onChatResize}
									value={visibleChatWidth}
									min={320}
									max={maxChatWidth}
									controls="project-chat"
									label="Chat width"
								/>
							)}

							<div
								ref={previewRef}
								className={`project-preview relative ${previewCollapsed ? "hidden" : "flex"} min-w-0 flex-1 flex-col`}
								style={{ viewTransitionName: "preview-shell" }}
							>
								<PreviewDetailsStage
									details={
										detailsId ? (
											<BuildDetails
												key={detailsId}
												message={detailsMessage}
												status={detailsLive.status}
												streaming={detailsLive.streaming}
												live={detailsLive.live}
												resumingPreview={resumingPreview}
												setupAnswer={setupAnswer}
												loadPreviewThumbnail={loadPreviewThumbnail}
												onClose={closeDetails}
											/>
										) : null
									}
								>
									<div className="flex min-h-0 flex-1 flex-col">
										<PreviewPanel
											url={previewUrl}
											liveUrl={liveUrl}
											reloadKey={reloadKey}
											cmsReady={cmsReady}
											buildComplete={initialBuildComplete}
											previewRestarting={previewRestarting}
											reopenState={reopenState}
											onRetryRecovery={retryRecovery}
											expanded={previewExpanded}
											compact={compact}
											onToggleExpanded={toggleExpanded}
											onCollapse={closeCompactPreview}
											onPreviewPathChange={reportPreviewPath}
											onRefreshRoute={refreshPreviewRoute}
											onCheckRouteSnapshot={checkPreviewRoute}
											slotWait={slotWait}
											paused={sandboxPaused && !resumingPreview && !provisionError}
										/>
									</div>

									{consoleOpen && (
										<ResizeHandle
											direction="vertical"
											onResize={onConsoleResize}
											value={visibleConsoleHeight}
											min={100}
											max={maxConsoleHeight}
											controls="activity-panel"
											label="Logs height"
										/>
									)}

									<div
										id="activity-panel"
										className="flex shrink-0 flex-col"
										style={{ height: consoleOpen ? visibleConsoleHeight : 36 }}
									>
										<button
											type="button"
											onClick={() => setConsoleOpen((open) => !open)}
											className={`flex h-9 shrink-0 items-center gap-2 px-3 text-[11px] text-text-secondary hover:text-text-primary ${consoleOpen ? "" : "border-t border-border"}`}
										>
											<TerminalWindow size={15} />
											<span className="font-medium">Logs</span>
											{consoleOpen ? (
												<CaretDown className="ml-auto" size={14} />
											) : (
												<CaretUp className="ml-auto" size={14} />
											)}
										</button>
										{consoleOpen ? <ConsolePanel lines={consoleLines} /> : null}
									</div>
								</PreviewDetailsStage>
							</div>
						</div>
					</>
				)}
			</div>
		</Sidebar.Provider>
	);
}

const LANDING_PROMPTS = [
	{
		label: "Photography portfolio",
		prompt:
			"A cinematic photography portfolio for an Iceland landscape photographer, with a dark gallery-led design and projects organised by location.",
	},
	{
		label: "Neighbourhood bakery",
		prompt:
			"A warm editorial website for an artisanal bakery called Crust and Crumb, with a seasonal menu, opening hours, and the story behind the bakery.",
	},
	{
		label: "Independent magazine",
		prompt:
			"An independent culture magazine with long-form essays, interviews, contributor pages, and a clean typographic design.",
	},
];

function NewSiteSidebarTrigger() {
	const { isMobile, openMobile } = useSidebar();
	return (
		<Sidebar.Trigger
			className="shrink-0 border border-border bg-surface-raised md:hidden"
			aria-label={isMobile && openMobile ? "Close projects" : "Open projects"}
			title={isMobile && openMobile ? "Close projects" : "Open projects"}
			aria-expanded={isMobile ? openMobile : false}
		/>
	);
}

function LandingView({
	onSubmitMessage,
	account,
	embedded = false,
	appearance,
	onAppearanceChange,
	onSignIn,
	onSignOut,
	onOpenProjects,
}: {
	onSubmitMessage: (text: string, photos: FileUIPart[]) => void;
	account: AccountStatus;
	embedded?: boolean;
	appearance: Appearance;
	onAppearanceChange: (appearance: Appearance) => void;
	onSignIn: () => void;
	onSignOut: () => void;
	onOpenProjects?: () => void;
}) {
	const [input, setInput] = useState("");
	const [photos, setPhotos] = useState<FileUIPart[]>([]);
	const [photosPending, setPhotosPending] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// Focus on mount (more reliable than autoFocus after Suspense/transition).
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const text = input.trim();
		if (!text || photosPending) return;
		setInput("");
		setPhotos([]);
		onSubmitMessage(text, photos);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit(e);
		}
	};

	return (
		<div className="landing-root h-full min-h-0 w-full overflow-y-auto bg-surface text-text-primary">
			{!embedded ? (
				<header className="landing-nav sticky top-0 z-20 flex h-16 items-center border-b border-border px-5 sm:px-8 lg:px-12">
					<a href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
						<img src="/emdash-mark.svg" alt="" className="h-7 w-7" />
						EmDash Build
					</a>
					<nav className="ml-auto hidden items-center gap-2 sm:flex" aria-label="Explore EmDash">
						<a
							href="https://emdashcms.com"
							target="_blank"
							rel="noopener noreferrer"
							aria-label="EmDash CMS (opens in a new tab)"
							className="landing-nav-link"
						>
							<span className="landing-nav-icon landing-nav-icon--cms" aria-hidden="true">
								<img src="/emdash-mark.svg" alt="" className="size-[14px]" />
							</span>
							<span className="hidden text-[13px] font-medium tracking-tight lg:inline">
								EmDash CMS
							</span>
							<ArrowUpRight
								size={10}
								aria-hidden="true"
								className="hidden text-text-tertiary lg:block"
							/>
						</a>
						<a
							href="https://github.com/emdash-cms"
							target="_blank"
							rel="noopener noreferrer"
							aria-label="EmDash on GitHub (opens in a new tab)"
							className="landing-nav-link"
						>
							<span className="landing-nav-icon landing-nav-icon--github" aria-hidden="true">
								<GithubLogo size={13} weight="fill" />
							</span>
							<span className="hidden text-[13px] font-medium tracking-tight lg:inline">
								GitHub
							</span>
							<ArrowUpRight
								size={10}
								aria-hidden="true"
								className="hidden text-text-tertiary lg:block"
							/>
						</a>
					</nav>
					<div className="ml-auto flex items-center gap-2 sm:ml-3">
						<AccountControl
							authenticated={account.authenticated}
							onSignIn={onSignIn}
							onSignOut={onSignOut}
							onOpenProjects={onOpenProjects}
							inLandingNav
						/>
						<AppearanceControl
							appearance={appearance}
							onChange={onAppearanceChange}
							compact
							floating
						/>
					</div>
				</header>
			) : null}

			<main className={embedded ? "min-h-full" : undefined}>
				<section
					className={`landing-hero relative flex items-center justify-center overflow-hidden px-5 py-20 ${embedded ? "min-h-[100svh]" : "min-h-[calc(100svh-4rem)]"}`}
				>
					<Suspense fallback={null}>
						<LandingAurora />
					</Suspense>
					{embedded ? (
						<div className="absolute inset-x-5 top-4 z-20 flex items-center justify-between">
							<NewSiteSidebarTrigger />
							<div className="ml-auto">
								<AccountControl
									authenticated={account.authenticated}
									onSignIn={onSignIn}
									onSignOut={onSignOut}
								/>
							</div>
						</div>
					) : null}
					<div className="landing-stack relative z-10 w-full max-w-[800px] text-center">
						<h1
							className="landing-title text-balance text-[32px]/[1.1] font-semibold tracking-[-0.04em] sm:text-5xl/[1.1]"
							style={{ viewTransitionName: "app-title" }}
						>
							Build a site that’s yours
						</h1>
						<p className="landing-tagline mx-auto mt-1 max-w-[600px] text-base leading-6 text-text-secondary sm:text-lg">
							Describe your idea. EmDash builds a site and CMS you own.
						</p>

						<form
							onSubmit={handleSubmit}
							className="landing-form mx-auto mt-9 max-w-[700px] text-left"
						>
							<div style={{ viewTransitionName: "chat-shell" }}>
								<Composer
									size="hero"
									inputRef={inputRef}
									value={input}
									onValueChange={setInput}
									onKeyDown={handleKeyDown}
									photos={photos}
									onPhotosChange={setPhotos}
									onPhotosPendingChange={setPhotosPending}
									label="Describe your site"
									placeholder="Describe the site you want to build…"
									actions={
										<button
											type="submit"
											disabled={!input.trim() || photosPending}
											className="flex h-9 items-center gap-1.5 rounded-full bg-text-primary ps-4 pe-3 text-sm font-medium text-surface-raised transition-[background-color,color,scale] duration-150 hover:opacity-90 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-border disabled:text-text-tertiary disabled:active:scale-100"
										>
											Build <ArrowUp size={15} weight="bold" aria-hidden="true" />
										</button>
									}
								/>
							</div>
						</form>
						<div className="landing-form mt-4 flex flex-wrap justify-center gap-2">
							{LANDING_PROMPTS.map((suggestion) => (
								<button
									key={suggestion.label}
									type="button"
									onClick={() => {
										setInput(suggestion.prompt);
										inputRef.current?.focus();
									}}
									className="rounded-full border border-border bg-surface-raised/70 px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-border-strong hover:bg-surface-raised hover:text-text-primary"
								>
									{suggestion.label}
								</button>
							))}
						</div>
					</div>
				</section>
			</main>
		</div>
	);
}
