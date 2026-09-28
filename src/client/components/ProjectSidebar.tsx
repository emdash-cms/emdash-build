import { Button, Dialog, DropdownMenu, LinkButton, Sidebar, useSidebar } from "@cloudflare/kumo";
import { DotsThree } from "@phosphor-icons/react/DotsThree";
import { PencilSimple } from "@phosphor-icons/react/PencilSimple";
import { Plus } from "@phosphor-icons/react/Plus";
import { Question } from "@phosphor-icons/react/Question";
import { Trash } from "@phosphor-icons/react/Trash";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Appearance } from "../appearance.js";
import { AppearanceControl } from "./AppearanceControl.js";
import { ShimmerText } from "./ShimmerText.js";

export interface ProjectSummary {
	id: string;
	title: string;
	/** When the site was created; the list is ordered by it. */
	createdAt?: number;
	updatedAt: number;
	status: "building" | "draft" | "live" | "failed";
	/** Work is running right now (a turn or first-build setup), not just unfinished. */
	building?: boolean;
}

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SidebarKeyboardShortcut() {
	const { toggleSidebar } = useSidebar();

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "b" || (!event.metaKey && !event.ctrlKey)) return;
			event.preventDefault();
			toggleSidebar();
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [toggleSidebar]);

	return null;
}

export function SidebarAccessibility() {
	const { isMobile, openMobile } = useSidebar();
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const wasOpenRef = useRef(false);

	useEffect(() => {
		const workspace = document.querySelector<HTMLElement>("[data-sidebar-workspace]");
		if (!isMobile || !openMobile) {
			workspace?.removeAttribute("inert");
			if (wasOpenRef.current) {
				wasOpenRef.current = false;
				const returnFocus = returnFocusRef.current;
				returnFocusRef.current = null;
				const desktopTrigger = document.querySelector<HTMLElement>(
					'[data-sidebar="sidebar"]:not([data-mobile="true"]) [data-sidebar="trigger"]',
				);
				const focusTarget =
					isMobile || (returnFocus?.getClientRects().length ?? 0) > 0
						? returnFocus
						: desktopTrigger;
				focusTarget?.focus();
			}
			return;
		}

		const sidebar = document.querySelector<HTMLElement>(
			'[data-sidebar="sidebar"][data-mobile="true"]',
		);
		if (!sidebar) return;

		if (!wasOpenRef.current) {
			const activeElement = document.activeElement;
			if (activeElement instanceof HTMLElement && !sidebar.contains(activeElement)) {
				returnFocusRef.current = activeElement;
			}
		}
		wasOpenRef.current = true;
		workspace?.setAttribute("inert", "");

		const focusableElements = () =>
			Array.from(sidebar.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
				(element) => !element.hasAttribute("disabled") && !element.closest("[inert]"),
			);
		focusableElements()[0]?.focus();
		const trapFocus = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const focusable = focusableElements();
			const first = focusable[0];
			const last = focusable.at(-1);
			if (!first || !last) return;
			const activeElement = document.activeElement;
			if (!sidebar.contains(activeElement)) {
				event.preventDefault();
				(event.shiftKey ? last : first).focus();
			} else if (!event.shiftKey && activeElement === last) {
				event.preventDefault();
				first.focus();
			} else if (event.shiftKey && activeElement === first) {
				event.preventDefault();
				last.focus();
			}
		};
		document.addEventListener("keydown", trapFocus);

		return () => {
			document.removeEventListener("keydown", trapFocus);
			workspace?.removeAttribute("inert");
		};
	}, [isMobile, openMobile]);

	return null;
}

export function ProjectSidebar({
	projects,
	activeProjectId,
	newProjectActive = false,
	appearance,
	onAppearanceChange,
	onNewProject,
	onOpenProject,
	onPreloadProject,
	onRenameProject,
	onDeleteProject,
}: {
	projects: ProjectSummary[];
	activeProjectId: string;
	newProjectActive?: boolean;
	appearance: Appearance;
	onAppearanceChange: (appearance: Appearance) => void;
	onNewProject: () => void;
	onOpenProject: (projectId: string) => void;
	onPreloadProject?: (projectId: string) => void;
	onRenameProject: (projectId: string, title: string) => Promise<void>;
	onDeleteProject: (projectId: string) => Promise<void>;
}) {
	const { state, isMobile, openMobile, setOpenMobile } = useSidebar();
	const [action, setAction] = useState<{ type: "rename" | "delete"; project: ProjectSummary }>();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const openAction = (type: "rename" | "delete", project: ProjectSummary) => {
		if (isMobile && openMobile) setOpenMobile(false);
		setAction({ type, project });
		setName(project.title);
		setError(undefined);
	};
	const submitAction = async () => {
		if (!action) return;
		setBusy(true);
		setError(undefined);
		try {
			if (action.type === "rename") await onRenameProject(action.project.id, name.trim());
			else await onDeleteProject(action.project.id);
			setAction(undefined);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not update this site.");
		} finally {
			setBusy(false);
		}
	};
	const compact = state === "collapsed" && !isMobile;
	const footerPadding = isMobile
		? ""
		: compact
			? "px-3"
			: "group-not-data-[state=collapsed]/sidebar:px-3";

	return (
		<Sidebar className="[--sidebar-bg:var(--color-sidebar)] [--sidebar-active-bg:var(--color-sidebar-active)]">
			<Sidebar.Header
				className={`h-13 py-0 transition-[padding] duration-(--sidebar-animation-duration) ease-(--sidebar-easing) motion-reduce:transition-none ${compact ? "px-4" : "ps-4 pe-2.5"}`}
			>
				<a
					href="/"
					className="flex w-full shrink-0 items-center gap-2.5 overflow-hidden text-kumo-default"
					aria-label="EmDash Build home"
				>
					<img src="/emdash-mark.svg" alt="" className="size-6 shrink-0" />
					<span
						className={`truncate text-base font-semibold transition-opacity duration-250 ease-[cubic-bezier(0.77,0,0.175,1)] motion-reduce:transition-none ${compact ? "opacity-0" : "opacity-100"}`}
					>
						Build
					</span>
				</a>
			</Sidebar.Header>

			<div
				className={`shrink-0 py-3 transition-[padding] duration-250 ease-[cubic-bezier(0.77,0,0.175,1)] motion-reduce:transition-none ${compact ? "px-3" : "px-3.5"}`}
			>
				<Button
					size="base"
					variant="primary"
					aria-current={newProjectActive ? "page" : undefined}
					style={
						{
							"--kumo-button-emphasis-bg": "var(--color-accent)",
							"--kumo-button-emphasis-gradient-start": "var(--color-accent)",
							"--kumo-button-emphasis-gradient-end": "var(--color-accent-hover)",
						} as CSSProperties
					}
					icon={<Plus className="size-4 shrink-0" weight="bold" />}
					onClick={() => {
						if (isMobile && openMobile) setOpenMobile(false);
						onNewProject();
					}}
					title="New site"
					className={`h-8! justify-start overflow-hidden text-sm transition-[width,padding,gap] duration-250 ease-[cubic-bezier(0.77,0,0.175,1)] motion-reduce:transition-none ${compact ? "w-8! gap-0! px-2!" : "w-full! gap-1.5! ps-1.5! pe-3!"}`}
				>
					<span
						className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-250 ease-[cubic-bezier(0.77,0,0.175,1)] motion-reduce:transition-none ${compact ? "max-w-0 opacity-0" : "max-w-40 opacity-100"}`}
					>
						New site
					</span>
				</Button>
			</div>

			<Sidebar.Content>
				<nav
					aria-label="Recent sites"
					aria-hidden={compact || undefined}
					inert={compact || undefined}
					className={`w-full shrink-0 transition-opacity duration-250 ease-[cubic-bezier(0.77,0,0.175,1)] motion-reduce:transition-none ${compact ? "pointer-events-none opacity-0" : "opacity-100"}`}
				>
					<Sidebar.Group>
						<Sidebar.GroupLabel className="group-data-[state=collapsed]/sidebar:my-0! group-data-[state=collapsed]/sidebar:grid-rows-[1fr]! group-data-[state=collapsed]/sidebar:border-transparent!">
							Recent
						</Sidebar.GroupLabel>
						{projects.length === 0 ? (
							<p className="px-3 py-2 text-sm text-kumo-subtle">No recent sites yet</p>
						) : (
							<Sidebar.Menu>
								{projects.map((project) => {
									const active = project.id === activeProjectId;
									// Work running now outranks an earlier failure it may be retrying.
									const attention = project.status === "failed" && !project.building;
									return (
										<Sidebar.MenuItem key={project.id} className="relative">
											<Sidebar.MenuButton
												active={active && !compact}
												onClick={() => {
													if (isMobile && openMobile) setOpenMobile(false);
													onOpenProject(project.id);
												}}
												onFocus={() => onPreloadProject?.(project.id)}
												onPointerEnter={() => onPreloadProject?.(project.id)}
												aria-label={`${project.title}${project.building ? ", Building" : attention ? ", Needs attention" : ""}`}
												aria-current={active ? "page" : undefined}
												className="min-h-10 py-2 pr-11 pl-3 text-sm"
											>
												<span className="flex min-w-0 flex-1 items-center gap-2">
													{project.building ? (
														<>
															<ShimmerText className="min-w-0 truncate">
																{project.title}
															</ShimmerText>
															{/* The shimmer stands still without motion; a quiet word says it instead. */}
															<span
																aria-hidden="true"
																className="hidden shrink-0 text-xs text-kumo-subtle motion-reduce:inline"
															>
																Building
															</span>
														</>
													) : (
														<span className="truncate text-kumo-default">{project.title}</span>
													)}
													{attention ? (
														<span className="shrink-0 text-xs text-danger">Needs attention</span>
													) : null}
												</span>
											</Sidebar.MenuButton>
											<DropdownMenu>
												<DropdownMenu.Trigger
													render={
														<button
															type="button"
															aria-label={`Options for ${project.title}`}
															className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-kumo-subtle hover:bg-surface-sunken hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
														>
															<DotsThree size={19} weight="bold" aria-hidden="true" />
														</button>
													}
												/>
												<DropdownMenu.Content
													align="end"
													sideOffset={4}
													className="recent-site-popover z-50"
												>
													<DropdownMenu.Item
														icon={PencilSimple}
														onClick={() => openAction("rename", project)}
													>
														Rename
													</DropdownMenu.Item>
													<DropdownMenu.Item
														icon={Trash}
														variant="danger"
														onClick={() => openAction("delete", project)}
													>
														Delete
													</DropdownMenu.Item>
												</DropdownMenu.Content>
											</DropdownMenu>
										</Sidebar.MenuItem>
									);
								})}
							</Sidebar.Menu>
						)}
					</Sidebar.Group>
				</nav>
			</Sidebar.Content>

			<Sidebar.Footer className={`h-auto! flex-col items-stretch gap-1 py-2 ${footerPadding}`}>
				<AppearanceControl
					appearance={appearance}
					onChange={onAppearanceChange}
					compact={compact}
				/>
				<div
					className={`flex items-center transition-[gap] duration-(--sidebar-animation-duration) ease-(--sidebar-easing) motion-reduce:transition-none ${compact ? "gap-0" : "gap-2"}`}
				>
					<Sidebar.Trigger
						aria-label={
							isMobile ? "Close projects" : compact ? "Expand sidebar" : "Collapse sidebar"
						}
						title={isMobile ? "Close projects" : compact ? "Expand sidebar" : "Collapse sidebar"}
						aria-expanded={isMobile ? openMobile : !compact}
						className="size-8 shrink-0 justify-center rounded-lg p-0"
					/>
					<LinkButton
						href="https://emdashcms.com"
						external
						variant="ghost"
						shape="base"
						size="base"
						icon={Question}
						aria-label="Help and docs"
						title="Help and docs"
						aria-hidden={compact || undefined}
						tabIndex={compact ? -1 : undefined}
						className={`h-8! justify-start overflow-hidden text-sm transition-[width,padding,opacity] duration-250 ease-[cubic-bezier(0.77,0,0.175,1)] motion-reduce:transition-none ${compact ? "w-0! p-0! opacity-0" : "min-w-0 flex-1 px-2! opacity-100"}`}
					>
						Help and docs
					</LinkButton>
				</div>
			</Sidebar.Footer>
			<Dialog.Root
				open={Boolean(action)}
				onOpenChange={(open) => {
					if (!open && !busy) setAction(undefined);
				}}
			>
				<Dialog size="sm" className="bg-surface-raised p-5">
					<Dialog.Title className="text-base font-semibold">
						{action?.type === "delete" ? "Delete site?" : "Rename site"}
					</Dialog.Title>
					<Dialog.Description className="mt-2 text-sm text-text-secondary">
						{action?.type === "delete"
							? `Delete “${action.project.title}”? Any build in progress will stop. This can't be undone. Its published site will also go offline.`
							: "Give this site a name you can recognize in Recents."}
					</Dialog.Description>
					{action?.type === "rename" ? (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void submitAction();
							}}
						>
							<label htmlFor="recent-site-name" className="mt-4 block text-sm">
								Site name
							</label>
							<input
								id="recent-site-name"
								autoFocus
								maxLength={200}
								required
								value={name}
								onChange={(event) => setName(event.target.value)}
								className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-accent"
							/>
							{error ? (
								<p role="alert" className="mt-2 text-sm text-danger">
									{error}
								</p>
							) : null}
							<div className="mt-5 flex justify-end gap-2">
								<Dialog.Close className="secondary-button" disabled={busy}>
									Cancel
								</Dialog.Close>
								<button type="submit" className="primary-button" disabled={busy || !name.trim()}>
									{busy ? "Saving…" : "Save"}
								</button>
							</div>
						</form>
					) : (
						<>
							{error ? (
								<p role="alert" className="mt-3 text-sm text-danger">
									{error}
								</p>
							) : null}
							<div className="mt-5 flex justify-end gap-2">
								<Dialog.Close className="secondary-button" disabled={busy}>
									Cancel
								</Dialog.Close>
								<button
									type="button"
									className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
									disabled={busy}
									onClick={() => void submitAction()}
								>
									{busy ? "Deleting…" : "Delete site"}
								</button>
							</div>
						</>
					)}
				</Dialog>
			</Dialog.Root>
		</Sidebar>
	);
}
