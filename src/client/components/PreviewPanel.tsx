import { ArrowsIn } from "@phosphor-icons/react/ArrowsIn";
import { ArrowsOut } from "@phosphor-icons/react/ArrowsOut";
import { Browser } from "@phosphor-icons/react/Browser";
import { Desktop } from "@phosphor-icons/react/Desktop";
import { DeviceMobile } from "@phosphor-icons/react/DeviceMobile";
import { DeviceTablet } from "@phosphor-icons/react/DeviceTablet";
import { Check } from "@phosphor-icons/react/Check";
import { X } from "@phosphor-icons/react/X";
import { Menu } from "@base-ui/react/menu";
import { Tabs } from "@cloudflare/kumo";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
	isAdminPreviewPath,
	mergePreviewRoutes,
	normalizePreviewPath,
	parsePreviewBridgeMessage,
	PREVIEW_EDITOR_RETURN_PARAM,
	previewCommand,
	previewDocumentPath,
	sortPreviewRoutes,
	type PreviewLink,
	type PreviewSnapshot,
} from "../../shared/preview-navigation.js";
import { PreviewAddressBar } from "./PreviewAddressBar.js";

type Tab = "preview" | "admin";
type Viewport = "desktop" | "tablet" | "mobile";

const VIEWPORTS = [
	{ id: "desktop", label: "Desktop", Icon: Desktop, frame: "w-full rounded-xl" },
	{ id: "tablet", label: "Tablet", Icon: DeviceTablet, frame: "w-[768px] max-w-full rounded-2xl" },
	{ id: "mobile", label: "Mobile", Icon: DeviceMobile, frame: "w-[390px] max-w-full rounded-2xl" },
] as const;

/** Wait this long for a manual Reload's server-side re-render before reloading anyway. */
const MANUAL_REFRESH_WAIT_MS = 8000;
const LOADING_TIMEOUT_MS = 20000;
const BRIDGE_GRACE_MS = 600;
/**
 * A STALE snapshot means a fresh render was still running when the page was
 * served. Each retry reload joins that render server-side for up to 5s, so a
 * few spaced retries pick up the edit without a manual reload.
 */
const STALE_RETRY_DELAY_MS = 2500;
const STALE_RETRY_LIMIT = 6;
/** After the retries, poll snapshot freshness (no render, no reload) with backoff. */
const STALE_POLL_MIN_MS = 3000;
const STALE_POLL_MAX_MS = 15000;

function originOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

function pathStorageKey(url: string): string {
	return `emdash-build:preview-path:${originOf(url) ?? url}`;
}

function readStoredPath(url: string): string {
	try {
		const stored = normalizePreviewPath(sessionStorage.getItem(pathStorageKey(url)));
		return stored && !isAdminPreviewPath(stored) ? stored : "/";
	} catch {
		return "/";
	}
}

export function PreviewPanel({
	url,
	liveUrl,
	reloadKey,
	cmsReady = false,
	buildComplete = false,
	previewRestarting = false,
	reopenState,
	onRetryRecovery,
	expanded = false,
	compact = false,
	onToggleExpanded,
	onCollapse,
	onPreviewPathChange,
	onRefreshRoute,
	onCheckRouteSnapshot,
}: {
	url?: string;
	liveUrl?: string;
	reloadKey?: number;
	cmsReady?: boolean;
	buildComplete?: boolean;
	previewRestarting?: boolean;
	reopenState?: "waking" | "ready" | "failed" | "unknown" | "needsChat";
	onRetryRecovery?: () => void;
	expanded?: boolean;
	compact?: boolean;
	onToggleExpanded?: () => void;
	onCollapse?: () => void;
	/** The draft route shown in the frame changed (path + query, no fragment). */
	onPreviewPathChange?: (path: string) => void;
	/** Re-render a draft route on the server before a manual reload. */
	onRefreshRoute?: (path: string) => Promise<{ refreshed: boolean }>;
	/** Whether a draft route's server snapshot is current, stale, or absent. */
	onCheckRouteSnapshot?: (path: string) => Promise<"current" | "stale" | "missing">;
}) {
	const [tab, setTab] = useState<Tab>("preview");
	const [target, setTarget] = useState<"draft" | "live">("draft");
	const [viewport, setViewport] = useState<Viewport>("desktop");
	const [sitePath, setSitePath] = useState(() => (url ? readStoredPath(url) : "/"));
	const [pageTitle, setPageTitle] = useState("");
	const [snapshot, setSnapshot] = useState<PreviewSnapshot>("live");
	/** Bumped on every bridge report so a repeated STALE schedules another retry. */
	const [reportCount, setReportCount] = useState(0);
	const staleRetries = useRef({ path: "", count: 0 });
	const [routes, setRoutes] = useState<Map<string, PreviewLink>>(() => new Map());
	const [loading, setLoading] = useState(false);
	const [frameStatus, setFrameStatus] = useState<"loading" | "ready" | "error">("loading");
	const bridgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [refreshing, setRefreshing] = useState(false);
	/** The deployed site has no bridge, so its in-page navigation cannot be followed. */
	const [livePathUnknown, setLivePathUnknown] = useState(false);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	/** True once the current document's injected bridge has reported in. */
	const bridgeReady = useRef(false);
	const sitePathRef = useRef(sitePath);
	const adminPathRef = useRef("/_emdash/admin");
	const tabRef = useRef(tab);
	tabRef.current = tab;
	const targetRef = useRef(target);
	targetRef.current = target;
	const urlRef = useRef(url);
	urlRef.current = url;
	/** Set when the app itself navigates the frame, so other loads are in-page navigation. */
	const expectingLoad = useRef(false);
	const refreshInFlight = useRef(false);
	const refreshGeneration = useRef(0);

	const siteBase = target === "live" && liveUrl ? liveUrl : url;
	const frameBase = tab === "preview" ? siteBase : url;
	const frameOrigin = originOf(frameBase);
	const frameOriginRef = useRef(frameOrigin);
	frameOriginRef.current = frameOrigin;
	const currentHref = frameBase
		? tab === "preview"
			? new URL(sitePath, frameBase).href
			: new URL(adminPathRef.current, frameBase).href
		: undefined;
	const livePathHidden = tab === "preview" && target === "live" && livePathUnknown;
	const currentHrefRef = useRef(currentHref);
	currentHrefRef.current = currentHref;
	const externalAdminHref = useMemo(() => {
		if (!url) return undefined;
		try {
			if (!new URL(url).hostname.endsWith(".trycloudflare.com")) return undefined;
			return `${url}_emdash/api/auth/dev-bypass?redirect=/_emdash/admin`;
		} catch {
			return undefined;
		}
	}, [url]);
	const editorLogin = useMemo(() => {
		if (!url || !/^\/s\/[0-9a-f-]{36}$/i.test(window.location.pathname)) return undefined;
		const builderReturn = `${window.location.pathname}${window.location.search}`;
		const redirect = new URL(sitePath, url);
		redirect.searchParams.set(PREVIEW_EDITOR_RETURN_PARAM, builderReturn);
		return {
			action: new URL("/_emdash/api/auth/dev-bypass", url).href,
			builderReturn,
			redirect: `${redirect.pathname}${redirect.search}${redirect.hash}`,
		};
	}, [sitePath, url]);

	const updateSitePath = useCallback((path: string) => {
		sitePathRef.current = path;
		setSitePath(path);
	}, []);

	const loadFrame = useCallback((href: string) => {
		const iframe = iframeRef.current;
		if (!iframe) return;
		bridgeReady.current = false;
		clearTimeout(bridgeTimer.current);
		setFrameStatus("loading");
		expectingLoad.current = true;
		setLivePathUnknown(false);
		setLoading(true);
		iframe.src = href;
	}, []);

	const reloadFrame = useCallback(() => {
		const iframe = iframeRef.current;
		const origin = frameOriginRef.current;
		if (!iframe || !origin) return;
		if (bridgeReady.current && iframe.contentWindow) {
			bridgeReady.current = false;
			clearTimeout(bridgeTimer.current);
			setFrameStatus("loading");
			setLoading(true);
			iframe.contentWindow.postMessage(previewCommand("reload"), origin);
		} else if (currentHrefRef.current) {
			loadFrame(currentHrefRef.current);
		}
	}, [loadFrame]);
	const reloadFrameRef = useRef(reloadFrame);
	reloadFrameRef.current = reloadFrame;

	// A new project preview starts from its last viewed route in this tab.
	useEffect(() => {
		if (!url) return;
		updateSitePath(readStoredPath(url));
		setRoutes(new Map());
		setSnapshot("live");
	}, [url, updateSitePath]);

	// The iframe's src is owned imperatively: in-page navigation must never
	// be overwritten by a React re-render, and reload must keep the route.
	const frameKey = frameBase ? `${tab}:${frameBase}` : "";
	useEffect(() => {
		if (!frameKey || !frameBase) return;
		loadFrame(
			tab === "preview"
				? new URL(sitePathRef.current, frameBase).href
				: `${url}_emdash/api/auth/dev-bypass?redirect=/_emdash/admin`,
		);
		// Only a frame target change (tab, draft/live, project) reloads here.
	}, [frameKey]);

	// Agent mutations broadcast a reload; coalesce bursts from consecutive
	// tools. They change the draft only, so Admin and live-site views are left alone.
	useEffect(() => {
		if (!reloadKey) return;
		const timer = setTimeout(() => {
			if (tabRef.current !== "preview" || targetRef.current !== "draft") return;
			reloadFrameRef.current();
		}, 250);
		return () => clearTimeout(timer);
	}, [reloadKey]);

	useEffect(() => {
		if (!loading) return;
		const timer = setTimeout(() => {
			setLoading(false);
			if (
				!bridgeReady.current &&
				tabRef.current === "preview" &&
				targetRef.current === "draft" &&
				(buildComplete || reopenState)
			) {
				setFrameStatus("error");
			}
		}, LOADING_TIMEOUT_MS);
		return () => clearTimeout(timer);
	}, [loading, buildComplete, reopenState]);
	useEffect(() => () => clearTimeout(bridgeTimer.current), []);

	useEffect(() => {
		const retries = staleRetries.current;
		if (snapshot !== "stale") {
			retries.count = 0;
			return;
		}
		if (tab !== "preview" || target !== "draft") return;
		const path = previewDocumentPath(sitePath);
		if (retries.path !== path) {
			retries.path = path;
			retries.count = 0;
		}
		if (retries.count < STALE_RETRY_LIMIT) {
			const timer = setTimeout(() => {
				retries.count += 1;
				reloadFrameRef.current();
			}, STALE_RETRY_DELAY_MS);
			return () => clearTimeout(timer);
		}
		if (!onCheckRouteSnapshot) return;
		// The render outlasted the retries. Ask cheaply whether it has landed
		// (or the route stopped being cacheable) and reload exactly once then.
		let cancelled = false;
		let delay = STALE_POLL_MIN_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			if (document.visibilityState !== "hidden") {
				const state = await onCheckRouteSnapshot(path).catch(() => "stale" as const);
				if (cancelled) return;
				if (state !== "stale") {
					retries.count = 0;
					reloadFrameRef.current();
					return;
				}
			}
			delay = Math.min(delay * 2, STALE_POLL_MAX_MS);
			timer = setTimeout(poll, delay);
		};
		timer = setTimeout(poll, delay);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [snapshot, sitePath, tab, target, reportCount, onCheckRouteSnapshot]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const iframe = iframeRef.current;
			if (!iframe || event.source !== iframe.contentWindow) return;
			if (event.origin !== frameOriginRef.current) return;
			const message = parsePreviewBridgeMessage(event.data);
			if (!message) return;
			if (message.type === "navigating") {
				bridgeReady.current = false;
				clearTimeout(bridgeTimer.current);
				setFrameStatus("loading");
				setLoading(true);
				return;
			}
			if (tabRef.current === "preview" && message.path.startsWith("/_emdash/api/auth/dev-bypass"))
				return;
			bridgeReady.current = true;
			clearTimeout(bridgeTimer.current);
			setFrameStatus("ready");
			setLoading(false);
			if (tabRef.current === "admin") {
				if (isAdminPreviewPath(message.path)) adminPathRef.current = message.path;
				return;
			}
			updateSitePath(message.path);
			setPageTitle(message.title);
			setSnapshot(message.snapshot);
			setReportCount((count) => count + 1);
			setRoutes((known) => mergePreviewRoutes(known, message, message.links));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [updateSitePath]);

	// Remember the draft route across app reloads and tell the agent which
	// page to keep fresh when it edits the site.
	const lastReportedPath = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (!url || target !== "draft") return;
		try {
			if (!isAdminPreviewPath(sitePath)) sessionStorage.setItem(pathStorageKey(url), sitePath);
		} catch {
			// Storage can be unavailable in private modes; navigation still works.
		}
		const documentPath = previewDocumentPath(sitePath);
		if (lastReportedPath.current === documentPath) return;
		lastReportedPath.current = documentPath;
		onPreviewPathChange?.(documentPath);
	}, [sitePath, url, target, onPreviewPathChange]);

	useEffect(() => {
		if (!cmsReady && tab === "admin") setTab("preview");
	}, [cmsReady, tab]);

	useEffect(() => {
		if (!liveUrl && target === "live") setTarget("draft");
	}, [liveUrl, target]);

	const navigate = useCallback(
		(input: string) => {
			const path = normalizePreviewPath(input, originOf(siteBase));
			if (!path || !siteBase) return;
			updateSitePath(path);
			loadFrame(new URL(path, siteBase).href);
		},
		[siteBase, updateSitePath, loadFrame],
	);

	// One server re-render at a time, released at a fixed deadline. If the
	// render outlasts it, reload with the current cache and reload again when
	// the fresh render lands, but only if the user is still on that route.
	const manualReload = useCallback(async () => {
		if (refreshInFlight.current) return;
		if (tab !== "preview" || target !== "draft" || !onRefreshRoute) {
			reloadFrame();
			return;
		}
		const path = previewDocumentPath(sitePathRef.current);
		const attempt = ++refreshGeneration.current;
		const project = url;
		const stillHere = () =>
			refreshGeneration.current === attempt &&
			urlRef.current === project &&
			tabRef.current === "preview" &&
			targetRef.current === "draft" &&
			previewDocumentPath(sitePathRef.current) === path;
		refreshInFlight.current = true;
		setRefreshing(true);
		const refresh = onRefreshRoute(path)
			.then((result) => result?.refreshed === true)
			.catch(() => false);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const inTime = await Promise.race([
			refresh.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), MANUAL_REFRESH_WAIT_MS);
			}),
		]);
		clearTimeout(timer);
		refreshInFlight.current = false;
		setRefreshing(false);
		if (stillHere()) reloadFrameRef.current();
		if (!inTime && (await refresh) && stillHere()) reloadFrameRef.current();
	}, [tab, target, url, onRefreshRoute, reloadFrame]);

	const onFrameLoad = useCallback(() => {
		setLoading(false);
		if (tabRef.current === "preview" && targetRef.current === "draft" && !bridgeReady.current) {
			clearTimeout(bridgeTimer.current);
			bridgeTimer.current = setTimeout(() => {
				if (!bridgeReady.current && tabRef.current === "preview" && targetRef.current === "draft") {
					setFrameStatus("error");
				}
			}, BRIDGE_GRACE_MS);
		}
		if (!expectingLoad.current && tabRef.current === "preview" && targetRef.current === "live") {
			setLivePathUnknown(true);
		}
		expectingLoad.current = false;
	}, []);

	const routeList = useMemo(() => {
		const all = new Map(routes);
		if (!all.has("/")) all.set("/", { path: "/" });
		const current = previewDocumentPath(sitePath);
		if (!isAdminPreviewPath(current) && !all.has(current)) {
			all.set(current, { path: current, label: pageTitle || undefined });
		}
		return sortPreviewRoutes(all.values());
	}, [routes, sitePath, pageTitle]);

	const activeViewport = VIEWPORTS.find((option) => option.id === viewport) ?? VIEWPORTS[0];
	const ViewportIcon = activeViewport.Icon;
	const draftFallback =
		tab === "preview" &&
		target === "draft" &&
		Boolean(frameBase) &&
		(buildComplete || reopenState !== undefined);
	const fallback = !draftFallback
		? undefined
		: reopenState === "failed" || reopenState === "unknown" || reopenState === "needsChat"
			? reopenState
			: frameStatus === "ready"
				? undefined
				: reopenState === "waking"
					? "waking"
					: frameStatus === "error"
						? "error"
						: "loading";
	const savedPreview = draftFallback && reopenState === "waking" && frameStatus === "ready";
	const editorWaking =
		(previewRestarting || reopenState === "waking" || reopenState === "unknown") &&
		target === "draft" &&
		Boolean(url);
	const previewBlocked =
		editorWaking || fallback === "failed" || fallback === "error" || fallback === "needsChat";
	const adminAvailable =
		cmsReady &&
		!previewRestarting &&
		reopenState !== "waking" &&
		reopenState !== "unknown" &&
		reopenState !== "failed" &&
		reopenState !== "needsChat" &&
		fallback !== "error";
	const addressLabel =
		reopenState === "unknown" && target === "draft"
			? "Reconnecting…"
			: editorWaking
				? "Waking editor…"
				: fallback === "needsChat"
					? "Site not ready"
					: fallback === "failed" || fallback === "error"
						? "Preview unavailable"
						: !frameBase
							? "Preparing preview…"
							: tab === "admin"
								? "Admin"
								: livePathHidden
									? "Live site"
									: sitePath;
	const toggleView = compact ? onCollapse : onToggleExpanded;
	const toggleViewLabel = compact ? "Close preview" : expanded ? "Restore chat" : "Expand preview";

	return (
		<div className="preview-reveal flex min-h-0 flex-1 flex-col">
			{editorWaking && !fallback ? (
				<span role="status" className="sr-only">
					Waking editor
				</span>
			) : null}
			<div className="preview-toolbar min-h-12 shrink-0 border-b border-border px-2.5 py-2">
				<div className="flex min-w-0 items-center gap-1.5 justify-self-start">
					<Tabs
						variant="segmented"
						size="sm"
						value={tab}
						onValueChange={(value) => {
							if (value === "admin" && adminAvailable && externalAdminHref) {
								window.open(externalAdminHref, "_blank", "noopener,noreferrer");
								return;
							}
							if (value === "preview" || (value === "admin" && adminAvailable)) setTab(value);
						}}
						indicatorClassName="motion-reduce:transition-none"
						tabs={[
							{ value: "preview", label: "Site" },
							{
								value: "admin",
								label: "Admin",
								className: "aria-disabled:cursor-not-allowed aria-disabled:opacity-40",
								render: (props) => (
									<button
										{...props}
										aria-disabled={!adminAvailable || undefined}
										onClick={(event) => {
											if (!adminAvailable) {
												event.preventDefault();
												return;
											}
											props.onClick?.(event);
										}}
										title={
											adminAvailable
												? externalAdminHref
													? "Open the EmDash admin in a new tab"
													: "Open the EmDash admin"
												: previewRestarting
													? "Admin is available when the editor is ready"
													: "Admin is available when CMS setup finishes"
										}
									/>
								),
							},
						]}
					/>

					{liveUrl && tab === "preview" ? (
						<div className="preview-target-toggle gap-0.5 rounded-lg bg-surface-sunken p-0.5">
							{(["draft", "live"] as const).map((value) => (
								<button
									key={value}
									type="button"
									onClick={() => setTarget(value)}
									aria-pressed={target === value}
									className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${target === value ? "bg-surface-raised text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-secondary"}`}
								>
									{value}
								</button>
							))}
						</div>
					) : null}
				</div>

				<div className="preview-toolbar-center flex min-w-0 items-center justify-center gap-1">
					<Menu.Root>
						<Menu.Trigger
							className="preview-device-menu icon-button data-popup-open:bg-surface-sunken data-popup-open:text-text-primary"
							title={`${activeViewport.label} preview`}
							aria-label={`Preview size: ${activeViewport.label}`}
						>
							<ViewportIcon size={17} />
						</Menu.Trigger>
						<Menu.Portal>
							<Menu.Positioner align="center" sideOffset={6} className="z-50">
								<Menu.Popup className="preview-popover min-w-40 rounded-2xl border border-border bg-surface-raised p-1 text-text-primary shadow-lg outline-none">
									<Menu.RadioGroup
										value={viewport}
										onValueChange={(value) => setViewport(value as Viewport)}
									>
										{VIEWPORTS.map((option) => (
											<Menu.RadioItem
												key={option.id}
												value={option.id}
												className="flex h-9 cursor-default items-center gap-2 rounded-xl pr-3 pl-2 text-sm outline-none select-none data-highlighted:bg-surface-sunken"
											>
												<option.Icon size={16} className="shrink-0 text-text-secondary" />
												<span className="flex-1">{option.label}</span>
												<Menu.RadioItemIndicator className="flex">
													<Check size={14} weight="bold" />
												</Menu.RadioItemIndicator>
											</Menu.RadioItem>
										))}
									</Menu.RadioGroup>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>

					<PreviewAddressBar
						label={addressLabel}
						path={tab === "preview" ? sitePath : undefined}
						routes={routeList}
						loading={loading || refreshing || editorWaking}
						stale={tab === "preview" && snapshot === "stale"}
						disabled={!frameBase || tab === "admin" || previewBlocked}
						onReload={
							frameBase && !livePathHidden && !previewBlocked
								? () => void manualReload()
								: undefined
						}
						onNavigate={navigate}
					/>
				</div>

				<div className="flex items-center justify-self-end gap-1">
					{tab === "preview" && target === "draft" && cmsReady && buildComplete && editorLogin ? (
						<form method="get" action={editorLogin.action}>
							<input
								type="hidden"
								name={PREVIEW_EDITOR_RETURN_PARAM}
								value={editorLogin.builderReturn}
							/>
							<input type="hidden" name="redirect" value={editorLogin.redirect} />
							<button
								type="submit"
								disabled={loading || previewBlocked || Boolean(fallback) || !bridgeReady.current}
								className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-sunken hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
							>
								Edit site
							</button>
						</form>
					) : null}
					{toggleView ? (
						<button
							type="button"
							onClick={toggleView}
							className="icon-button"
							title={toggleViewLabel}
							aria-label={toggleViewLabel}
							aria-pressed={compact ? undefined : expanded}
						>
							{compact ? (
								<X size={17} />
							) : expanded ? (
								<ArrowsIn size={16} />
							) : (
								<ArrowsOut size={16} />
							)}
						</button>
					) : null}
				</div>
			</div>

			<div className="relative flex min-h-0 flex-1 justify-center p-3">
				{frameBase ? (
					<div
						className={`relative h-full overflow-hidden border border-border bg-surface-raised transition-[width,border-radius] duration-200 ${tab === "admin" ? VIEWPORTS[0].frame : activeViewport.frame}`}
					>
						<div className="h-full bg-surface-raised" inert={Boolean(fallback || savedPreview)}>
							<iframe
								ref={iframeRef}
								title={tab === "preview" ? "Site preview" : "Admin"}
								onLoad={onFrameLoad}
								className="h-full w-full border-0 bg-surface-raised"
							/>
						</div>
						{savedPreview ? (
							<span className="pointer-events-none absolute top-5 left-5 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-text-secondary shadow-sm">
								Saved preview
							</span>
						) : null}
						{fallback ? (
							<div
								role={fallback === "failed" || fallback === "error" ? "alert" : "status"}
								className="absolute inset-0 overflow-y-auto bg-surface-raised"
							>
								<div className="flex min-h-full flex-col items-center justify-center px-5 py-5 text-center">
									<div
										className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border bg-surface-sunken text-text-secondary shadow-sm"
										aria-hidden="true"
									>
										<Browser size={24} />
									</div>
									<h2 className="mt-4 text-base font-semibold text-text-primary">
										{fallback === "needsChat"
											? "Continue in chat"
											: fallback === "failed"
												? "Couldn't restore this saved site"
												: fallback === "error"
													? "Preview couldn't load"
													: fallback === "unknown"
														? "Still reconnecting"
														: "Opening your site"}
									</h2>
									<p className="mt-1 max-w-xs text-sm text-text-secondary">
										{fallback === "needsChat"
											? "The site build isn't finished. Answer any questions or resume the build in chat."
											: fallback === "failed"
												? "The editor couldn't be restored. Try again or check Logs for details."
												: fallback === "error"
													? "The site isn't responding yet. Try reloading this page."
													: fallback === "unknown"
														? "The connection dropped while your site was waking. It may still be restoring."
														: "Waking the editor and restoring your saved site. This can take a moment."}
									</p>
									{fallback === "needsChat" ? null : fallback === "failed" ||
									  fallback === "unknown" ||
									  fallback === "error" ? (
										<button
											type="button"
											onClick={fallback === "error" ? reloadFrame : onRetryRecovery}
											className="mt-5 min-h-9 rounded-lg bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
										>
											{fallback === "error" ? "Reload preview" : "Retry"}
										</button>
									) : (
										<div className="mt-5 flex gap-1.5" aria-hidden="true">
											{[0, 1, 2].map((index) => (
												<span
													key={index}
													className="size-1.5 animate-[status-pulse_1.4s_ease-in-out_infinite] rounded-full bg-accent motion-reduce:animate-none"
													style={{ animationDelay: `${index * 0.2}s` }}
												/>
											))}
										</div>
									)}
								</div>
							</div>
						) : null}
					</div>
				) : (
					<div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-border bg-surface-raised">
						<div className="flex gap-1.5" aria-hidden="true">
							<span className="h-1.5 w-1.5 animate-[status-pulse_1.4s_ease-in-out_infinite] rounded-full bg-text-tertiary" />
							<span className="h-1.5 w-1.5 animate-[status-pulse_1.4s_ease-in-out_infinite] rounded-full bg-text-tertiary [animation-delay:0.2s]" />
							<span className="h-1.5 w-1.5 animate-[status-pulse_1.4s_ease-in-out_infinite] rounded-full bg-text-tertiary [animation-delay:0.4s]" />
						</div>
						<div className="text-center">
							<p className="text-sm font-medium text-text-secondary">Preparing your site</p>
							<p className="mt-1 text-xs text-text-tertiary">
								The preview will appear here automatically.
							</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
