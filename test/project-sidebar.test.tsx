// @vitest-environment jsdom

import { Sidebar } from "@cloudflare/kumo";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	ProjectSidebar,
	SidebarAccessibility,
	SidebarKeyboardShortcut,
	type ProjectSummary,
} from "../src/client/components/ProjectSidebar.js";
import { ProjectHeader } from "../src/client/components/ProjectHeader.js";

const projects: ProjectSummary[] = [
	{
		id: "active-project",
		title: "Iceland portfolio",
		updatedAt: 1,
		status: "building",
	},
	{
		id: "other-project",
		title: "Neighbourhood bakery",
		updatedAt: 2,
		status: "draft",
	},
];

afterEach(cleanup);

let mobile = false;
const mediaListeners = new Set<() => void>();

function setMobile(value: boolean) {
	mobile = value;
	for (const listener of mediaListeners) listener();
}

beforeAll(() => {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches: mobile && query === "(max-width: 767px)",
			media: query,
			onchange: null,
			addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
			removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
			dispatchEvent: vi.fn(),
		})),
	});
});

afterEach(() => {
	setMobile(false);
	mediaListeners.clear();
});

function renderSidebar(defaultOpen = true) {
	const onNewProject = vi.fn();
	const onOpenProject = vi.fn();
	const onPreloadProject = vi.fn();
	const onRenameProject = vi.fn().mockResolvedValue(undefined);
	const onDeleteProject = vi.fn().mockResolvedValue(undefined);
	const onAppearanceChange = vi.fn();
	render(
		<Sidebar.Provider defaultOpen={defaultOpen} className="h-full min-h-0!">
			<SidebarKeyboardShortcut />
			<ProjectSidebar
				projects={projects}
				activeProjectId="active-project"
				appearance="system"
				onAppearanceChange={onAppearanceChange}
				onNewProject={onNewProject}
				onOpenProject={onOpenProject}
				onPreloadProject={onPreloadProject}
				onRenameProject={onRenameProject}
				onDeleteProject={onDeleteProject}
			/>
			<main>Workspace</main>
		</Sidebar.Provider>,
	);
	return {
		onNewProject,
		onOpenProject,
		onPreloadProject,
		onRenameProject,
		onDeleteProject,
		onAppearanceChange,
	};
}

describe("ProjectSidebar", () => {
	it("does not invent a Publish action when no publication control is supplied", () => {
		render(
			<Sidebar.Provider>
				<ProjectHeader
					title="Iceland portfolio"
					previewCollapsed={false}
					onRename={vi.fn()}
					onTogglePreview={vi.fn()}
				/>
			</Sidebar.Provider>,
		);
		expect(document.querySelector("[data-publish-button]")).toBeNull();
	});

	it("labels header actions that become icon-only on narrow screens", () => {
		render(
			<Sidebar.Provider>
				<ProjectHeader
					title="Iceland portfolio"
					previewCollapsed
					onRename={vi.fn()}
					onTogglePreview={vi.fn()}
					exportControl={
						<button type="button" aria-label="Export">
							Export
						</button>
					}
				/>
			</Sidebar.Provider>,
		);
		expect(screen.getByRole("button", { name: "Show preview" }).getAttribute("aria-label")).toBe(
			"Show preview",
		);
		expect(screen.getByRole("button", { name: "Export" }).getAttribute("aria-label")).toBe(
			"Export",
		);
		expect(screen.queryByText("Saved")).toBeNull();
	});

	it("renames a site from the header using the keyboard", async () => {
		const user = userEvent.setup();
		function NamedHeader() {
			const [title, setTitle] = useState("Iceland portfolio");
			return (
				<Sidebar.Provider>
					<ProjectHeader
						title={title}
						previewCollapsed={false}
						onRename={async (nextTitle) => setTitle(nextTitle)}
						onTogglePreview={vi.fn()}
					/>
				</Sidebar.Provider>
			);
		}
		render(<NamedHeader />);
		await user.click(screen.getByRole("button", { name: "Rename site" }));
		const input = screen.getByRole("textbox", { name: "Site name" });
		await user.clear(input);
		await user.type(input, "Noah's Iceland{enter}");
		expect(await screen.findByRole("heading", { name: "Noah's Iceland" })).toBeTruthy();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Rename site" }));
	});

	it("renames and deletes a recent site from its keyboard-accessible options", async () => {
		const user = userEvent.setup();
		const { onOpenProject, onRenameProject, onDeleteProject } = renderSidebar();
		const options = screen.getByRole("button", { name: "Options for Neighbourhood bakery" });
		options.focus();
		await user.keyboard("{enter}");
		const menu = await screen.findByRole("menu", { name: "Options for Neighbourhood bakery" });
		expect(menu.classList.contains("recent-site-popover")).toBe(true);
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		expect(document.activeElement).toBe(options);
		await user.keyboard("{enter}");
		await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
		const input = await screen.findByRole("textbox", { name: "Site name" });
		await user.clear(input);
		await user.type(input, "Baker's corner");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(onRenameProject).toHaveBeenCalledWith("other-project", "Baker's corner"),
		);
		await user.click(options);
		await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
		expect(
			await screen.findByText(
				"Delete “Neighbourhood bakery”? Any build in progress will stop. This can't be undone. Its published site will also go offline.",
			),
		).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Delete site" }));
		await waitFor(() => expect(onDeleteProject).toHaveBeenCalledWith("other-project"));
		expect(onOpenProject).not.toHaveBeenCalled();
	});

	it("keeps the delete confirmation open when cleanup fails", async () => {
		const user = userEvent.setup();
		const { onDeleteProject } = renderSidebar();
		onDeleteProject.mockRejectedValueOnce(new Error("Wait for the current build to finish."));
		await user.click(screen.getByRole("button", { name: "Options for Neighbourhood bakery" }));
		await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
		await user.click(screen.getByRole("button", { name: "Delete site" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Wait for the current build to finish.",
		);
		expect(screen.getByRole("button", { name: "Delete site" })).toBeTruthy();
	});

	it("uses Kumo sidebar landmarks and exposes the active project", () => {
		renderSidebar();

		const sidebar = screen.getByRole("complementary");
		expect(sidebar.getAttribute("data-sidebar")).toBe("sidebar");
		expect(sidebar.classList).toContain("[--sidebar-bg:var(--color-sidebar)]");
		expect(sidebar.classList).toContain("[--sidebar-active-bg:var(--color-sidebar-active)]");
		expect(sidebar.querySelector('[data-sidebar="header"]')?.classList.contains("border-b")).toBe(
			true,
		);
		const home = screen.getByRole("link", { name: "EmDash Build home" });
		expect(home.parentElement?.classList.contains("ps-4")).toBe(true);
		expect(home.parentElement?.classList.contains("transition-[padding]")).toBe(true);
		expect(home.classList.contains("w-full")).toBe(true);
		expect(home.querySelector("img")?.classList.contains("size-6")).toBe(true);
		expect(within(home).getByText("Build").classList.contains("text-base")).toBe(true);
		const footer = sidebar.querySelector('[data-sidebar="footer"]');
		expect(footer?.classList.contains("border-t")).toBe(true);
		expect(footer?.classList.contains("transition-[width,padding]")).toBe(true);
		expect(screen.getByRole("navigation", { name: "Recent sites" })).toBeTruthy();
		expect(screen.getByRole("navigation", { name: "Recent sites" }).classList).toContain("w-full");
		expect(
			screen.getByRole("button", { name: "Iceland portfolio" }).getAttribute("aria-current"),
		).toBe("page");
		expect(screen.queryByText("Building")).toBeNull();
		// A lifecycle status alone is not live work, so nothing shimmers.
		expect(sidebar.querySelector(".shimmer-text")).toBeNull();
		expect(screen.queryByText("Draft")).toBeNull();
		expect(screen.queryByText("Saved")).toBeNull();
	});

	it("shimmers the title of a site that is building right now", () => {
		render(
			<Sidebar.Provider defaultOpen className="h-full min-h-0!">
				<ProjectSidebar
					projects={[
						{ ...projects[0]!, building: true },
						{ ...projects[1]!, status: "failed", building: true },
						{ id: "idle", title: "Idle site", updatedAt: 3, status: "failed" },
					]}
					activeProjectId="active-project"
					appearance="system"
					onAppearanceChange={vi.fn()}
					onNewProject={vi.fn()}
					onOpenProject={vi.fn()}
					onRenameProject={vi.fn()}
					onDeleteProject={vi.fn()}
				/>
			</Sidebar.Provider>,
		);
		const building = screen.getByRole("button", { name: "Iceland portfolio, Building" });
		expect(within(building).getByText("Iceland portfolio").classList).toContain("shimmer-text");
		// Without motion the shimmer is still, so a quiet word says it instead.
		const label = within(building).getByText("Building");
		expect(label.getAttribute("aria-hidden")).toBe("true");
		expect(label.classList).toContain("motion-reduce:inline");
		// A retry that is running outranks the earlier failure.
		const retrying = screen.getByRole("button", { name: "Neighbourhood bakery, Building" });
		expect(within(retrying).queryByText("Needs attention")).toBeNull();
		const idle = screen.getByRole("button", { name: "Idle site, Needs attention" });
		expect(idle.querySelector(".shimmer-text")).toBeNull();
	});

	it("keeps project and new-site navigation wired to the existing callbacks", async () => {
		const user = userEvent.setup();
		const { onNewProject, onOpenProject, onPreloadProject } = renderSidebar();
		const newSite = screen.getByRole("button", { name: "New site" });
		expect(newSite.parentElement?.classList.contains("px-3.5")).toBe(true);
		expect(newSite.classList.contains("ps-1.5!")).toBe(true);
		expect(newSite.classList.contains("bg-(--kumo-button-emphasis-bg)")).toBe(true);
		expect(newSite.classList.contains("bg-inherit")).toBe(false);
		expect(newSite.style.getPropertyValue("--kumo-button-emphasis-bg")).toBe("var(--color-accent)");
		expect(newSite.style.getPropertyValue("--kumo-button-emphasis-gradient-start")).toBe(
			"var(--color-accent)",
		);
		expect(newSite.style.getPropertyValue("--kumo-button-emphasis-gradient-end")).toBe(
			"var(--color-accent-hover)",
		);

		const otherProject = screen.getByRole("button", { name: "Neighbourhood bakery" });
		fireEvent.pointerEnter(otherProject);
		otherProject.focus();
		await user.click(newSite);
		await user.click(otherProject);

		expect(onNewProject).toHaveBeenCalledTimes(1);
		expect(onOpenProject).toHaveBeenCalledWith("other-project");
		expect(onPreloadProject).toHaveBeenCalledWith("other-project");
	});

	it("offers system, light, and dark appearances from the sidebar", async () => {
		const user = userEvent.setup();
		const { onAppearanceChange } = renderSidebar();

		const trigger = screen.getByRole("button", { name: "Appearance" });
		expect(screen.queryByRole("combobox")).toBeNull();
		await user.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(
			screen
				.getByRole("group", { name: "Theme" })
				.parentElement?.classList.contains("transition-[height,opacity]"),
		).toBe(true);
		await user.click(screen.getByRole("button", { name: "Dark" }));
		expect(onAppearanceChange).toHaveBeenCalledWith("dark");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(trigger);
	});

	it("collapses to the compact VibeSDK-style actions and toggles with Command+B", async () => {
		const user = userEvent.setup();
		renderSidebar();
		const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
		const help = screen.getByRole("link", { name: "Help and docs" });
		const newSite = screen.getByRole("button", { name: "New site" });
		const recent = screen.getByRole("navigation", { name: "Recent sites" });
		const activeProject = screen.getByRole("button", { name: "Iceland portfolio" });
		const appearanceText = within(screen.getByRole("button", { name: "Appearance" })).getByText(
			"Appearance",
		);
		const appearanceLabels = appearanceText.parentElement;

		expect(collapse.parentElement).toBe(help.parentElement);
		expect(collapse.parentElement?.classList.contains("transition-[gap]")).toBe(true);
		expect(collapse.nextElementSibling).toBe(help);
		expect(activeProject.getAttribute("data-active")).toBe("true");
		await user.click(collapse);
		expect(screen.getByRole("complementary").getAttribute("data-state")).toBe("collapsed");
		expect(
			screen
				.getByRole("link", { name: "EmDash Build home" })
				.parentElement?.classList.contains("px-4"),
		).toBe(true);
		const appearance = screen.getByRole("button", { name: "Appearance" });
		expect(appearance.classList.contains("justify-center")).toBe(true);
		expect(appearance.parentElement?.classList.contains("w-full")).toBe(true);
		expect(appearanceText.isConnected).toBe(true);
		expect(appearanceLabels?.classList.contains("max-w-0")).toBe(true);
		expect(appearanceLabels?.classList.contains("opacity-0")).toBe(true);
		expect(appearanceLabels?.getAttribute("aria-hidden")).toBe("true");
		await user.click(appearance);
		expect(screen.getByRole("button", { name: "Dark" })).toBeTruthy();
		await user.click(appearance);
		expect(screen.queryByRole("navigation", { name: "Recent sites" })).toBeNull();
		expect(recent.isConnected).toBe(true);
		expect(recent.classList.contains("opacity-0")).toBe(true);
		expect(activeProject.isConnected).toBe(true);
		expect(activeProject.hasAttribute("data-active")).toBe(false);
		expect(activeProject.querySelector("svg")).toBeNull();
		expect(screen.getByRole("button", { name: "New site" })).toBe(newSite);
		expect(newSite.parentElement?.classList.contains("px-3")).toBe(true);
		expect(screen.getByRole("button", { name: "Expand sidebar" })).toBe(collapse);
		expect(collapse.classList.contains("mx-auto")).toBe(false);
		expect(screen.queryByRole("link", { name: "Help and docs" })).toBeNull();

		await user.keyboard("{Meta>}b{/Meta}");
		expect(screen.getByRole("complementary").getAttribute("data-state")).toBe("expanded");
		expect(appearanceText.isConnected).toBe(true);
		expect(appearanceLabels?.classList.contains("max-w-52")).toBe(true);
		expect(appearanceLabels?.classList.contains("opacity-100")).toBe(true);
		expect(screen.getByRole("navigation", { name: "Recent sites" })).toBe(recent);
		expect(screen.getByRole("button", { name: "Iceland portfolio" })).toBe(activeProject);
		expect(activeProject.getAttribute("data-active")).toBe("true");
		expect(screen.getByRole("link", { name: "Help and docs" })).toBe(help);
	});

	it("closes the mobile drawer before opening a recent-site action dialog", async () => {
		const user = userEvent.setup();
		setMobile(true);
		render(
			<Sidebar.Provider defaultOpen>
				<SidebarAccessibility />
				<ProjectSidebar
					projects={projects}
					activeProjectId="active-project"
					appearance="system"
					onAppearanceChange={vi.fn()}
					onNewProject={vi.fn()}
					onOpenProject={vi.fn()}
					onRenameProject={vi.fn()}
					onDeleteProject={vi.fn()}
				/>
				<main data-sidebar-workspace>
					<ProjectHeader
						title="Iceland portfolio"
						previewCollapsed={false}
						onRename={vi.fn()}
						onTogglePreview={vi.fn()}
					/>
					<button type="button">Workspace action</button>
				</main>
			</Sidebar.Provider>,
		);
		const opener = screen.getByRole("button", { name: "Open projects" });
		await user.click(opener);
		await user.click(screen.getByRole("button", { name: "Options for Neighbourhood bakery" }));
		await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
		const dialog = await screen.findByRole("dialog", { name: "Rename site" });
		await waitFor(() =>
			expect(screen.queryByRole("navigation", { name: "Navigation" })).toBeNull(),
		);
		expect(document.querySelector("[data-sidebar-workspace]")?.hasAttribute("inert")).toBe(false);
		await user.tab();
		expect(dialog.contains(document.activeElement)).toBe(true);
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await user.click(opener);
		await user.click(screen.getByRole("button", { name: "Options for Neighbourhood bakery" }));
		await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
		const confirmation = await screen.findByRole("dialog", { name: "Delete site?" });
		await waitFor(() =>
			expect(screen.queryByRole("navigation", { name: "Navigation" })).toBeNull(),
		);
		await user.tab();
		expect(confirmation.contains(document.activeElement)).toBe(true);
	});

	it("closes the mobile drawer before opening a recent site", async () => {
		const user = userEvent.setup();
		const onOpenProject = vi.fn();
		setMobile(true);
		render(
			<Sidebar.Provider defaultOpen>
				<SidebarAccessibility />
				<ProjectSidebar
					projects={projects}
					activeProjectId="active-project"
					appearance="system"
					onAppearanceChange={vi.fn()}
					onNewProject={vi.fn()}
					onOpenProject={onOpenProject}
					onRenameProject={vi.fn()}
					onDeleteProject={vi.fn()}
				/>
				<main data-sidebar-workspace>
					<ProjectHeader
						title="Iceland portfolio"
						previewCollapsed={false}
						onRename={vi.fn()}
						onTogglePreview={vi.fn()}
					/>
				</main>
			</Sidebar.Provider>,
		);

		await user.click(screen.getByRole("button", { name: "Open projects" }));
		await user.click(screen.getByRole("button", { name: "Neighbourhood bakery" }));
		expect(onOpenProject).toHaveBeenCalledWith("other-project");
		await waitFor(() =>
			expect(screen.queryByRole("navigation", { name: "Navigation" })).toBeNull(),
		);
		expect(document.querySelector("[data-sidebar-workspace]")?.hasAttribute("inert")).toBe(false);
	});

	it("opens the native Kumo drawer on mobile and exposes an explicit close action", async () => {
		const user = userEvent.setup();
		const onNewProject = vi.fn();
		setMobile(true);
		render(
			<Sidebar.Provider defaultOpen>
				<SidebarAccessibility />
				<ProjectSidebar
					projects={projects}
					activeProjectId="active-project"
					appearance="system"
					onAppearanceChange={vi.fn()}
					onNewProject={onNewProject}
					onOpenProject={vi.fn()}
					onRenameProject={vi.fn()}
					onDeleteProject={vi.fn()}
				/>
				<main data-sidebar-workspace>
					<ProjectHeader
						title="Iceland portfolio"
						previewCollapsed={false}
						onRename={vi.fn()}
						onTogglePreview={vi.fn()}
					/>
					<button type="button">Workspace action</button>
				</main>
			</Sidebar.Provider>,
		);

		await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
		const opener = screen.getByRole("button", { name: "Open projects" });
		const workspace = screen.getByRole("main");
		expect(workspace.querySelector("header")?.classList.contains("border-b")).toBe(true);
		await user.click(opener);
		const drawer = await screen.findByRole("navigation", { name: "Navigation" });
		const close = within(drawer).getByRole("button", { name: "Close projects" });
		const home = within(drawer).getByRole("link", { name: "EmDash Build home" });
		const help = within(drawer).getByRole("link", { name: "Help and docs" });
		expect(opener.getAttribute("aria-expanded")).toBe("true");
		expect(close.getAttribute("aria-expanded")).toBe("true");
		expect(workspace.hasAttribute("inert")).toBe(true);
		await waitFor(() => expect(document.activeElement).toBe(home));
		expect(screen.getByRole("navigation", { name: "Recent sites" })).toBeTruthy();

		help.focus();
		await user.tab();
		expect(drawer.contains(document.activeElement)).toBe(true);
		home.focus();
		await user.tab({ shift: true });
		expect(drawer.contains(document.activeElement)).toBe(true);

		await user.click(close);
		await waitFor(() =>
			expect(screen.queryByRole("navigation", { name: "Navigation" })).toBeNull(),
		);
		expect(workspace.hasAttribute("inert")).toBe(false);
		expect(opener.getAttribute("aria-expanded")).toBe("false");
		await waitFor(() => expect(document.activeElement).toBe(opener));

		await user.click(opener);
		await waitFor(() => expect(document.activeElement).toBe(home));
		await user.click(within(drawer).getByRole("button", { name: "New site" }));
		await waitFor(() =>
			expect(screen.queryByRole("navigation", { name: "Navigation" })).toBeNull(),
		);
		expect(workspace.hasAttribute("inert")).toBe(false);
		expect(onNewProject).toHaveBeenCalledOnce();
		await user.click(opener);
		setMobile(false);
		const desktopTrigger = await screen.findByRole("button", { name: "Collapse sidebar" });
		expect(workspace.hasAttribute("inert")).toBe(false);
		await waitFor(() => expect(document.activeElement).toBe(desktopTrigger));
	});
});
