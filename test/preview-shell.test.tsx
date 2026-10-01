// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "../src/client/components/PreviewPanel.js";

const PROJECT_PATH = "/s/11111111-1111-4111-8111-111111111111";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	sessionStorage.clear();
	window.history.replaceState(null, "", "/");
});

beforeAll(() => {
	HTMLElement.prototype.getAnimations = () => [];
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterAll(() => {
	vi.unstubAllGlobals();
	delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

describe("preview shell", () => {
	it("keeps localhost editing inside the current draft preview", async () => {
		window.history.replaceState(null, "", PROJECT_PATH);
		const url = "http://4321-project-token.localhost:5175/";
		render(<PreviewPanel url={url} cmsReady buildComplete />);
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: new URL(url).origin,
					source: frame.contentWindow,
					data: { source: "emdash-preview", type: "state", path: "/work", title: "Work" },
				}),
			);
		});
		const edit = screen.getByRole("button", { name: "Edit site" });
		const form = edit.closest("form");
		expect(form?.method).toBe("get");
		expect(form?.action).toBe(`${url}_emdash/api/auth/dev-bypass`);
		expect(form?.querySelector<HTMLInputElement>('input[name="redirect"]')?.value).toBe(
			`/work?__emdash_build_return=${encodeURIComponent(PROJECT_PATH)}`,
		);
		expect(frame.src).toBe(url);
	});

	it("enters EmDash editing on the current draft route only after setup", async () => {
		window.history.replaceState(null, "", PROJECT_PATH);
		const user = userEvent.setup();
		const url = "https://4321-project-token.example.test/";
		const onPreviewPathChange = vi.fn();
		const { rerender } = render(
			<PreviewPanel url={url} onPreviewPathChange={onPreviewPathChange} />,
		);
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		expect(screen.queryByRole("button", { name: "Edit site" })).toBeNull();

		rerender(<PreviewPanel url={url} cmsReady onPreviewPathChange={onPreviewPathChange} />);
		expect(screen.queryByRole("button", { name: "Edit site" })).toBeNull();
		rerender(
			<PreviewPanel url={url} cmsReady buildComplete onPreviewPathChange={onPreviewPathChange} />,
		);
		expect(screen.getByRole("button", { name: "Edit site" }).hasAttribute("disabled")).toBe(true);
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: new URL(url).origin,
					source: frame.contentWindow,
					data: {
						source: "emdash-preview",
						type: "state",
						path: "/previous",
						title: "Previous",
					},
				}),
			);
		});
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: new URL(url).origin,
					source: frame.contentWindow,
					data: { source: "emdash-preview", type: "navigating" },
				}),
			);
		});
		expect(screen.getByRole("button", { name: "Edit site" }).hasAttribute("disabled")).toBe(true);
		act(() => frame.dispatchEvent(new Event("load")));
		expect(screen.getByRole("button", { name: "Edit site" }).hasAttribute("disabled")).toBe(true);
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: new URL(url).origin,
					source: frame.contentWindow,
					data: {
						source: "emdash-preview",
						type: "state",
						path: "/work?sort=new#featured",
						title: "Work",
					},
				}),
			);
		});
		const edit = screen.getByRole("button", { name: "Edit site" });
		const form = edit.closest("form");
		expect(form?.action).toBe(`${url}_emdash/api/auth/dev-bypass`);
		expect(form?.querySelector<HTMLInputElement>('input[name="redirect"]')?.value).toBe(
			`/work?sort=new&__emdash_build_return=${encodeURIComponent(PROJECT_PATH)}#featured`,
		);
		expect(frame.src).toBe(url);

		await user.click(screen.getByRole("tab", { name: "Admin" }));
		expect(screen.queryByRole("button", { name: "Edit site" })).toBeNull();
		await user.click(screen.getByRole("tab", { name: "Site" }));
		rerender(
			<PreviewPanel url={url} cmsReady buildComplete liveUrl="https://live.example.test/" />,
		);
		await user.click(screen.getByRole("button", { name: "live" }));
		expect(screen.queryByRole("button", { name: "Edit site" })).toBeNull();
	});

	it("keeps the horizontal toolbar separator and an inset empty-state frame", () => {
		render(<PreviewPanel />);
		const toolbar = screen.getByRole("tablist").closest(".preview-toolbar");
		expect(toolbar?.classList.contains("border-b")).toBe(true);
		expect(screen.getByRole("tab", { name: "Site" }).getAttribute("data-kumo-component")).toBe(
			"Tabs",
		);
		expect(toolbar?.querySelector(".motion-reduce\\:transition-none")).not.toBeNull();
		expect(
			screen.getByText("Preparing your site").parentElement?.parentElement?.classList,
		).toContain("bg-surface-raised");
		expect(toolbar?.nextElementSibling?.classList.contains("p-3")).toBe(true);
	});

	it("says when a new or saved site waits for a free build slot", () => {
		const { rerender } = render(<PreviewPanel slotWait={{ ahead: 2 }} />);
		expect(screen.getByText("Waiting for a free build slot")).toBeTruthy();
		expect(screen.getByText(/2 sites ahead of yours/)).toBeTruthy();
		rerender(<PreviewPanel slotWait={{ ahead: 0 }} />);
		expect(screen.getByText(/Yours is next/)).toBeTruthy();
		rerender(<PreviewPanel slotWait={{}} />);
		expect(screen.getByText(/Every build slot is in use/)).toBeTruthy();
		rerender(<PreviewPanel slotWait={{ gaveUp: true }} />);
		expect(screen.getByText("Every build slot is busy")).toBeTruthy();

		const url = "https://4321-project-token.example.test/";
		rerender(
			<PreviewPanel
				url={url}
				cmsReady
				buildComplete
				reopenState="waking"
				slotWait={{ ahead: 1 }}
			/>,
		);
		expect(screen.getByRole("status").textContent).toContain("Waiting for a free build slot");
		expect(screen.getByRole("status").textContent).toContain("1 site ahead of yours");
		rerender(<PreviewPanel url={url} cmsReady buildComplete reopenState="waking" />);
		expect(screen.getByRole("status").textContent).toContain("Opening your site");
		rerender(
			<PreviewPanel
				url={url}
				cmsReady
				buildComplete
				reopenState="failed"
				slotWait={{ gaveUp: true }}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("Every build slot is busy");
		expect(screen.getByRole("alert").textContent).not.toContain("Couldn't restore");
	});

	it("keeps the saved preview visible while its editor wakes", async () => {
		const user = userEvent.setup();
		const url = "https://4321-project-token.example.test/";
		const { rerender } = render(
			<PreviewPanel url={url} cmsReady buildComplete previewRestarting reopenState="waking" />,
		);

		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		expect(frame.src).toBe(url);
		expect(screen.getByText("Waking editor…")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain("Opening your site");
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: new URL(url).origin,
					source: frame.contentWindow,
					data: { source: "emdash-preview", type: "state", path: "/", title: "Site" },
				}),
			);
		});
		expect(screen.getByText("Saved preview")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toBe("Waking editor");
		const admin = screen.getByRole("tab", { name: "Admin" });
		expect(admin.getAttribute("aria-disabled")).toBe("true");
		await user.click(admin);
		expect(screen.getByRole("tab", { name: "Site" }).getAttribute("aria-selected")).toBe("true");

		rerender(<PreviewPanel url={url} cmsReady buildComplete reopenState="ready" />);
		expect(screen.getByTitle("Site preview")).toBe(frame);
		expect(screen.getByText("/")).toBeTruthy();
		expect(admin.getAttribute("aria-disabled")).toBeNull();
	});

	it("fills the saved site's frame while it wakes, then reveals a validated cached page", () => {
		const url = "https://4321-project-token.example.test/";
		render(<PreviewPanel url={url} cmsReady buildComplete reopenState="waking" />);
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		expect(screen.getByRole("status").textContent).toContain("Opening your site");
		act(() => frame.dispatchEvent(new Event("load")));
		expect(screen.getByText("Opening your site")).toBeTruthy();

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: new URL(url).origin,
					source: frame.contentWindow,
					data: { source: "emdash-preview", type: "state", path: "/work", title: "Work" },
				}),
			);
		});
		expect(screen.queryByText("Opening your site")).toBeNull();
		expect(screen.getByText("Saved preview")).toBeTruthy();
		expect(frame.closest("[inert]")).toBeTruthy();
	});

	it("shows an in-frame recovery failure with a working retry", async () => {
		const user = userEvent.setup();
		const retry = vi.fn();
		const { rerender } = render(
			<PreviewPanel
				url="https://4321-project-token.example.test/"
				cmsReady
				buildComplete
				reopenState="failed"
				onRetryRecovery={retry}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("Couldn't restore this saved site");
		expect(screen.queryByRole("link", { name: "Open in a new tab" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(retry).toHaveBeenCalledOnce();
		rerender(
			<PreviewPanel
				url="https://4321-project-token.example.test/"
				liveUrl="https://live.example.test/"
				cmsReady
				buildComplete
				reopenState="failed"
				onRetryRecovery={retry}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "live" }));
		expect(screen.getByRole("tab", { name: "Admin" }).getAttribute("aria-disabled")).toBe("true");
		expect(screen.getByTitle("Site preview")).toBeTruthy();
	});

	it("replaces an unbridged draft load with an error screen and reload action", async () => {
		vi.useFakeTimers();
		const url = "https://4321-project-token.example.test/";
		render(<PreviewPanel url={url} cmsReady buildComplete />);
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		act(() => frame.dispatchEvent(new Event("load")));
		await act(async () => vi.advanceTimersByTimeAsync(1000));
		expect(screen.getByRole("alert").textContent).toContain("Preview couldn't load");
		act(() =>
			within(screen.getByRole("alert")).getByRole("button", { name: "Reload preview" }).click(),
		);
		expect(screen.getByText("Opening your site")).toBeTruthy();
		vi.useRealTimers();
	});

	it("keeps Admin disabled until CMS setup, then switches the iframe via Kumo tabs", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<PreviewPanel url="https://example.test/" />);
		const admin = screen.getByRole("tab", { name: "Admin" });
		expect(admin.hasAttribute("disabled")).toBe(false);
		expect(admin.getAttribute("aria-disabled")).toBe("true");
		expect(admin.getAttribute("aria-selected")).toBe("false");
		await user.click(admin);
		expect(screen.getByRole("tab", { name: "Site" }).getAttribute("aria-selected")).toBe("true");

		rerender(<PreviewPanel url="https://example.test/" cmsReady />);
		expect(admin.getAttribute("aria-disabled")).toBeNull();
		await user.click(admin);
		expect(admin.getAttribute("aria-selected")).toBe("true");
		expect(screen.getByTitle("Admin")).toBeTruthy();

		await user.click(screen.getByRole("tab", { name: "Site" }));
		expect(screen.getByTitle("Site preview")).toBeTruthy();
	});

	it("carries the validated Builder return marker on the editor login request", () => {
		window.history.replaceState(null, "", "/s/11111111-1111-4111-8111-111111111111");
		render(
			<PreviewPanel url="https://4321-project-token.build.emdashcms.com/" cmsReady buildComplete />,
		);
		const form = screen.getByRole("button", { name: "Edit site" }).closest("form")!;
		expect(form.getAttribute("action")).toBe(
			"https://4321-project-token.build.emdashcms.com/_emdash/api/auth/dev-bypass",
		);
		expect(form.querySelector<HTMLInputElement>('input[name="__emdash_build_return"]')?.value).toBe(
			"/s/11111111-1111-4111-8111-111111111111",
		);
	});

	it("opens quick-tunnel Admin in a top-level tab", async () => {
		const user = userEvent.setup();
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const url = "https://branch-preview.trycloudflare.com/";
		render(<PreviewPanel url={url} cmsReady />);

		await user.click(screen.getByRole("tab", { name: "Admin" }));

		expect(open).toHaveBeenCalledWith(
			`${url}_emdash/api/auth/dev-bypass?redirect=/_emdash/admin`,
			"_blank",
			"noopener,noreferrer",
		);
		expect(screen.getByRole("tab", { name: "Site" }).getAttribute("aria-selected")).toBe("true");
		open.mockRestore();
	});

	it("keeps unavailable Admin reachable by arrow keys without selecting it", async () => {
		const user = userEvent.setup();
		render(<PreviewPanel url="https://example.test/" />);
		const site = screen.getByRole("tab", { name: "Site" });
		const admin = screen.getByRole("tab", { name: "Admin" });

		site.focus();
		await user.keyboard("{ArrowRight}");
		expect(document.activeElement).toBe(admin);
		expect(admin.getAttribute("aria-disabled")).toBe("true");
		await user.keyboard("{Enter}");
		expect(site.getAttribute("aria-selected")).toBe("true");
	});

	it("keeps one focused view action while its compact meaning changes", async () => {
		const user = userEvent.setup();
		const onToggleExpanded = vi.fn();
		const onCollapse = vi.fn();
		const { rerender } = render(
			<PreviewPanel onToggleExpanded={onToggleExpanded} onCollapse={onCollapse} />,
		);
		const action = screen.getByRole("button", { name: "Expand preview" });

		rerender(<PreviewPanel compact onToggleExpanded={onToggleExpanded} onCollapse={onCollapse} />);
		expect(screen.getByRole("button", { name: "Close preview" })).toBe(action);
		await user.click(action);
		expect(onCollapse).toHaveBeenCalledTimes(1);

		rerender(<PreviewPanel onToggleExpanded={onToggleExpanded} onCollapse={onCollapse} />);
		expect(screen.getByRole("button", { name: "Expand preview" })).toBe(action);
		await user.click(action);
		expect(onToggleExpanded).toHaveBeenCalledTimes(1);
	});

	it("follows in-page navigation, keeps the route on reload, and lists page links", async () => {
		const user = userEvent.setup();
		const onPreviewPathChange = vi.fn();
		const { rerender } = render(
			<PreviewPanel
				url="https://4321-p-t.example.test/"
				onPreviewPathChange={onPreviewPathChange}
			/>,
		);
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		expect(frame.src).toBe("https://4321-p-t.example.test/");

		// Messages from other windows or origins are ignored.
		window.dispatchEvent(
			new MessageEvent("message", {
				origin: "https://evil.test",
				source: frame.contentWindow,
				data: { source: "emdash-preview", type: "state", path: "/evil", title: "" },
			}),
		);
		expect(screen.queryByText("/evil")).toBeNull();

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: "https://4321-p-t.example.test",
					source: frame.contentWindow,
					data: {
						source: "emdash-preview",
						type: "state",
						path: "/about#team",
						title: "About",
						snapshot: "cached",
						links: [
							{ path: "/", label: "Home" },
							{ path: "/contact", label: "Contact" },
						],
					},
				}),
			);
		});
		expect(screen.getByText("/about#team")).toBeTruthy();
		expect(onPreviewPathChange).toHaveBeenLastCalledWith("/about");
		expect(screen.queryByRole("link", { name: "Open in a new tab" })).toBeNull();

		// An agent reload goes through the bridge and keeps the current route.
		const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
		rerender(
			<PreviewPanel
				url="https://4321-p-t.example.test/"
				reloadKey={1}
				onPreviewPathChange={onPreviewPathChange}
			/>,
		);
		await waitFor(() =>
			expect(postMessage).toHaveBeenCalledWith(
				{ source: "emdash-build", type: "command", command: "reload" },
				"https://4321-p-t.example.test",
			),
		);
		expect(frame.src).toBe("https://4321-p-t.example.test/");

		await user.click(screen.getByRole("combobox", { name: /Choose page/ }));
		const options = await screen.findAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual([
			"/Home",
			"/aboutAbout",
			"/contactContact",
		]);
		await user.click(screen.getByRole("option", { name: /contact/ }));
		expect(frame.src).toBe("https://4321-p-t.example.test/contact");
		expect(
			screen.getByRole("combobox", { name: "Choose page, current page /contact" }),
		).toBeTruthy();
	});

	it("single-flights manual refresh and stops spinning on a bridge report", async () => {
		const user = userEvent.setup();
		let finish: (value: { refreshed: boolean }) => void = () => {};
		const onRefreshRoute = vi.fn(
			() => new Promise<{ refreshed: boolean }>((resolve) => (finish = resolve)),
		);
		render(<PreviewPanel url="https://4321-p-t.example.test/" onRefreshRoute={onRefreshRoute} />);
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		const report = (path: string) =>
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						origin: "https://4321-p-t.example.test",
						source: frame.contentWindow,
						data: { source: "emdash-preview", type: "state", path, title: "", snapshot: "live" },
					}),
				);
			});
		report("/work");
		const reload = screen.getByRole("button", { name: "Reload preview" });
		expect(reload.querySelector(".animate-spin")).toBeNull();

		const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
		await user.click(reload);
		await user.click(reload);
		expect(onRefreshRoute).toHaveBeenCalledTimes(1);
		expect(onRefreshRoute).toHaveBeenCalledWith("/work");
		expect(reload.querySelector(".animate-spin")).not.toBeNull();

		await act(async () => finish({ refreshed: true }));
		await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
		report("/work");
		expect(reload.querySelector(".animate-spin")).toBeNull();
	});

	it("retries a stale snapshot, then polls freshness and reloads once it lands", async () => {
		vi.useFakeTimers();
		try {
			const states: ("current" | "stale" | "missing")[] = ["stale", "current"];
			const onCheckRouteSnapshot = vi.fn(async () => states.shift() ?? "current");
			render(
				<PreviewPanel
					url="https://4321-p-t.example.test/"
					onCheckRouteSnapshot={onCheckRouteSnapshot}
				/>,
			);
			const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
			const report = (snapshot: string) =>
				act(() => {
					window.dispatchEvent(
						new MessageEvent("message", {
							origin: "https://4321-p-t.example.test",
							source: frame.contentWindow,
							data: { source: "emdash-preview", type: "state", path: "/work", title: "", snapshot },
						}),
					);
				});
			const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");
			for (let attempt = 1; attempt <= 6; attempt++) {
				report("stale");
				act(() => vi.advanceTimersByTime(2500));
			}
			expect(postMessage).toHaveBeenCalledTimes(6);
			expect(onCheckRouteSnapshot).not.toHaveBeenCalled();

			// Retries exhausted: no more blind reloads, only cheap freshness polls.
			report("stale");
			await act(() => vi.advanceTimersByTimeAsync(3000));
			expect(onCheckRouteSnapshot).toHaveBeenCalledWith("/work");
			expect(postMessage).toHaveBeenCalledTimes(6);
			await act(() => vi.advanceTimersByTimeAsync(6000));
			expect(onCheckRouteSnapshot).toHaveBeenCalledTimes(2);
			expect(postMessage).toHaveBeenCalledTimes(7);

			// A fresh report stops everything.
			report("cached");
			await act(() => vi.advanceTimersByTimeAsync(30000));
			expect(postMessage).toHaveBeenCalledTimes(7);
			expect(onCheckRouteSnapshot).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not claim a route after unfollowable navigation on the live site", () => {
		render(
			<PreviewPanel url="https://4321-p-t.example.test/" liveUrl="https://site.workers.dev/" />,
		);
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		act(() => screen.getByRole("button", { name: "live" }).click());
		expect(frame.src).toBe("https://site.workers.dev/");
		act(() => frame.dispatchEvent(new Event("load")));
		expect(screen.getByRole("combobox", { name: "Choose page, current page /" })).toBeTruthy();

		// A second load the app did not start is in-page navigation it cannot see.
		act(() => frame.dispatchEvent(new Event("load")));
		expect(
			screen.getByRole("combobox", { name: "Choose page, current page Live site" }),
		).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Open in a new tab" })).toBeNull();
		expect(screen.getByRole("button", { name: "Reload preview" }).hasAttribute("disabled")).toBe(
			true,
		);
	});

	it("leaves a live-site view alone when the agent reloads the draft", async () => {
		const { rerender } = render(
			<PreviewPanel url="https://4321-p-t.example.test/" liveUrl="https://site.workers.dev/" />,
		);
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		act(() => screen.getByRole("button", { name: "live" }).click());
		const setSrc = vi.spyOn(frame, "src", "set");
		rerender(
			<PreviewPanel
				url="https://4321-p-t.example.test/"
				liveUrl="https://site.workers.dev/"
				reloadKey={1}
			/>,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(setSrc).not.toHaveBeenCalled();
	});

	it("leaves Admin alone when the agent reloads the draft", async () => {
		const user = userEvent.setup();
		const url = "https://4321-p-t.example.test/";
		const { rerender } = render(<PreviewPanel url={url} cmsReady />);

		await user.click(screen.getByRole("tab", { name: "Admin" }));
		const frame = screen.getByTitle("Admin") as HTMLIFrameElement;
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: new URL(url).origin,
					source: frame.contentWindow,
					data: {
						source: "emdash-preview",
						type: "state",
						path: "/_emdash/admin",
						title: "Admin",
					},
				}),
			);
		});
		const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

		rerender(<PreviewPanel url={url} cmsReady reloadKey={1} />);
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(postMessage).not.toHaveBeenCalled();
	});

	it("does not impose a white background on the embedded site frame", () => {
		render(<PreviewPanel url="https://example.test/" />);
		const frame = screen.getByTitle("Site preview").parentElement;
		expect(frame?.classList.contains("bg-surface-raised")).toBe(true);
		expect(frame?.classList.contains("bg-white")).toBe(false);
	});
});
