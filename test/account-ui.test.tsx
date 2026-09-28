// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toasty } from "@cloudflare/kumo";
import { useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/client/App.js";
import {
	needsAuthCompletion,
	postAuthDestination,
	revokeAccountSession,
} from "../src/client/account-state.js";
import { AccountControl } from "../src/client/components/AccountControl.js";
import { AuthComplete } from "../src/client/components/AuthComplete.js";
import { PublishPanel } from "../src/client/components/PublishPanel.js";
import { toasts } from "../src/client/toasts.js";
import type { BuilderState } from "../src/worker/agent.js";

vi.mock("agents/react", () => ({ useAgent: vi.fn() }));
vi.mock("@cloudflare/ai-chat/react", () => ({ useAgentChat: vi.fn() }));

beforeAll(() => {
	HTMLElement.prototype.getAnimations = () => [];
});

beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		clear: () => values.clear(),
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
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
	sessionStorage.clear();
	vi.useRealTimers();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	window.history.replaceState(null, "", "/");
});

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mockLandingAgent() {
	vi.mocked(useAgent).mockReturnValue({ call: vi.fn().mockResolvedValue([]) } as never);
	vi.mocked(useAgentChat).mockReturnValue({
		messages: [],
		isStreaming: false,
		sendMessage: vi.fn(),
	} as never);
	vi.stubGlobal(
		"matchMedia",
		vi
			.fn()
			.mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
	);
}

describe("account state", () => {
	it("gates every authenticated non-complete claim and the callback route", () => {
		expect(needsAuthCompletion({ authenticated: false }, "/auth/complete")).toBe(false);
		expect(needsAuthCompletion({ authenticated: true, claimStatus: "complete" }, "/s/id")).toBe(
			false,
		);
		expect(needsAuthCompletion({ authenticated: true, claimStatus: "available" }, "/s/id")).toBe(
			true,
		);
		expect(needsAuthCompletion({ authenticated: true }, "/auth/complete")).toBe(true);
	});

	it("opens the newest account project only when returning to the landing page", () => {
		expect(postAuthDestination("/", "11111111-1111-4111-8111-111111111111")).toBe(
			"/s/11111111-1111-4111-8111-111111111111",
		);
		expect(postAuthDestination("/s/22222222-2222-4222-8222-222222222222", "newest")).toBe(
			"/s/22222222-2222-4222-8222-222222222222",
		);
	});

	it("rejects logout failures before the caller clears local account state", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unavailable" }, 503)));
		await expect(revokeAccountSession()).rejects.toThrow("Sign out is temporarily unavailable.");
	});
});

describe("AccountControl", () => {
	it("exposes sign in while signed out", async () => {
		const user = userEvent.setup();
		const onSignIn = vi.fn();
		render(<AccountControl authenticated={false} onSignIn={onSignIn} onSignOut={vi.fn()} />);

		await user.click(screen.getByRole("button", { name: "Sign in" }));

		expect(onSignIn).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
	});

	it("exposes account projects and sign out while signed in", async () => {
		const user = userEvent.setup();
		const onOpenProjects = vi.fn();
		const onSignOut = vi.fn();
		render(
			<AccountControl
				authenticated
				onSignIn={vi.fn()}
				onSignOut={onSignOut}
				onOpenProjects={onOpenProjects}
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Open projects" }));
		await user.click(screen.getByRole("button", { name: "Sign out" }));

		expect(onOpenProjects).toHaveBeenCalledTimes(1);
		expect(onSignOut).toHaveBeenCalledTimes(1);
	});
});

describe("AuthComplete", () => {
	it("runs one claim pass automatically and completes to the stored return path", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				status: "complete",
				returnPath: "/s/11111111-1111-4111-8111-111111111111",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onComplete = vi.fn();
		render(
			<AuthComplete
				initial={{ authenticated: true, claimStatus: "available", returnPath: "/" }}
				onComplete={onComplete}
				onSignOut={vi.fn()}
			/>,
		);

		await waitFor(() =>
			expect(onComplete).toHaveBeenCalledWith("/s/11111111-1111-4111-8111-111111111111"),
		);
		expect(fetchMock).toHaveBeenCalledWith("/api/auth/claim", { method: "POST" });
	});

	it("waits for an active build and connects automatically when it finishes", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					status: "waiting",
					message: "Waiting for your site to finish building. It will connect automatically.",
					returnPath: "/s/11111111-1111-4111-8111-111111111111",
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					status: "complete",
					returnPath: "/s/11111111-1111-4111-8111-111111111111",
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const onComplete = vi.fn();
		render(
			<AuthComplete
				initial={{ authenticated: true, claimStatus: "available", returnPath: "/" }}
				onComplete={onComplete}
				onSignOut={vi.fn()}
			/>,
		);

		await act(async () => {});
		expect(
			screen.getByText("Waiting for your site to finish building. It will connect automatically."),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
		await act(async () => vi.advanceTimersByTimeAsync(3_000));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(onComplete).toHaveBeenCalledWith("/s/11111111-1111-4111-8111-111111111111");
		vi.useRealTimers();
	});

	it("offers sign out when the account session has expired", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "expired" }, 401)));
		render(
			<AuthComplete
				initial={{ authenticated: true, claimStatus: "available", returnPath: "/" }}
				onComplete={vi.fn()}
				onSignOut={vi.fn()}
			/>,
		);

		expect(
			await screen.findByText("Your sign in has expired. Sign out and try again."),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
	});
});

describe("application boot", () => {
	function mountReopeningSite(resumePreview: () => Promise<{ ready: boolean; error?: string }>) {
		mockLandingAgent();
		const projectId = "11111111-1111-4111-8111-111111111111";
		const previewUrl = "https://4321-saved-preview.example.test/";
		window.history.replaceState(null, "", `/s/${projectId}`);
		let onStateUpdate: ((state: BuilderState) => void) | undefined;
		let onMessage: ((event: MessageEvent) => void) | undefined;
		const agentCall = vi.fn((method: string) =>
			method === "resumePreview" ? resumePreview() : Promise.resolve([]),
		);
		vi.mocked(useAgent).mockImplementation((options) => {
			onStateUpdate = options.onStateUpdate as (state: BuilderState) => void;
			onMessage = options.onMessage as (event: MessageEvent) => void;
			return { call: agentCall } as never;
		});
		vi.mocked(useAgentChat).mockReturnValue({
			messages: [{ id: "brief", role: "user", parts: [{ type: "text", text: "My site" }] }],
			isStreaming: false,
			status: "ready",
			sendMessage: vi.fn(),
		} as never);
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request) => {
				const url = input.toString();
				if (url === "/api/auth/account")
					return Promise.resolve(jsonResponse({ authenticated: false }));
				if (url === "/api/project-session")
					return Promise.resolve(
						jsonResponse({
							projectId,
							resuming: true,
							publishingEnabled: true,
							previewUrl,
							projects: [{ id: projectId, title: "My site", status: "draft" }],
						}),
					);
				if (url.startsWith("/api/projects")) return Promise.resolve(jsonResponse({ projects: [] }));
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		render(<App />);
		return {
			agentCall,
			previewUrl,
			reload: () =>
				act(() => onMessage?.(new MessageEvent("message", { data: '{"type":"reload"}' }))),
			offerClone: () =>
				act(() => onMessage?.(new MessageEvent("message", { data: '{"type":"offer-clone"}' }))),
			sync: (state: Partial<BuilderState>) =>
				act(() =>
					onStateUpdate?.({
						siteReady: true,
						previewReady: true,
						previewUrl,
						...state,
					} as BuilderState),
				),
		};
	}

	it("retries transient account and project startup without losing the requested site", async () => {
		mockLandingAgent();
		const projectId = "11111111-1111-4111-8111-111111111111";
		window.history.replaceState(null, "", `/s/${projectId}`);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
			.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
			.mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
			.mockResolvedValueOnce(
				jsonResponse({
					projectId,
					resuming: true,
					publishingEnabled: true,
					projects: [{ id: projectId, title: "Site" }],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);

		expect(await screen.findByRole("button", { name: "Publish" })).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ body: JSON.stringify({ projectId }) });
		expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ body: JSON.stringify({ projectId }) });
	});

	it("offers a contextual startup retry after bounded recovery is exhausted", async () => {
		mockLandingAgent();
		const projectId = "11111111-1111-4111-8111-111111111111";
		window.history.replaceState(null, "", `/s/${projectId}`);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
			.mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
			.mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
			.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
			.mockResolvedValueOnce(
				jsonResponse({ projectId, resuming: true, publishingEnabled: true, projects: [] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const user = userEvent.setup();
		render(<App />);

		expect(await screen.findByText("We couldn't open this site.")).toBeTruthy();
		expect(screen.queryByText(/temporary/i)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("button", { name: "Publish" })).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("does not duplicate a new guest project when its creation response is ambiguous", async () => {
		mockLandingAgent();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
			.mockRejectedValueOnce(new TypeError("response lost"));
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);

		expect(await screen.findByText("We couldn't start a site.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
		const attempts = fetchMock.mock.calls.filter(
			([input]) => input.toString() === "/api/project-session",
		);
		expect(attempts).toHaveLength(3);
		const firstAttempt = JSON.parse(String(attempts[0]?.[1]?.body));
		const createProjectId = firstAttempt.createProjectId;
		const creationToken = firstAttempt.creationToken;
		expect(
			new Set(attempts.map(([, init]) => JSON.parse(String(init?.body)).createProjectId)),
		).toEqual(new Set([createProjectId]));
		expect(
			new Set(attempts.map(([, init]) => JSON.parse(String(init?.body)).creationToken)),
		).toEqual(new Set([creationToken]));
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
			.mockResolvedValueOnce(
				jsonResponse({ projectId: createProjectId, resuming: false, projects: [] }),
			);
		await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByPlaceholderText("Describe the site you want to build…")).toBeTruthy();
		const retriedBody = JSON.parse(
			String(
				fetchMock.mock.calls
					.filter(([input]) => input.toString() === "/api/project-session")
					.at(-1)?.[1]?.body,
			),
		);
		expect(retriedBody.createProjectId).toBe(createProjectId);
		expect(retriedBody.creationToken).toBe(creationToken);
	});

	it("does not duplicate an authenticated new project without a stable id", async () => {
		mockLandingAgent();
		window.history.replaceState(null, "", "/?new=1");
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ authenticated: true, claimStatus: "complete" }))
			.mockRejectedValueOnce(new TypeError("response lost"));
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);

		expect(await screen.findByText("We couldn't start a site.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
		const attempts = fetchMock.mock.calls.filter(
			([input]) => input.toString() === "/api/project-session",
		);
		expect(attempts).toHaveLength(3);
		expect(
			new Set(attempts.map(([, init]) => JSON.parse(String(init?.body)).createProjectId)).size,
		).toBe(1);
		expect(
			new Set(attempts.map(([, init]) => JSON.parse(String(init?.body)).creationToken)).size,
		).toBe(1);
	});

	it("reconciles a dropped first brief without sending it twice", async () => {
		const projectId = "11111111-1111-4111-8111-111111111111";
		let messageId = "";
		const sendMessage = vi.fn(async (message: { id?: string }) => {
			messageId = message.id ?? "";
			throw new Error("response dropped");
		});
		const setMessages = vi.fn();
		const clearError = vi.fn();
		vi.mocked(useAgentChat).mockReturnValue({
			messages: [],
			isStreaming: false,
			status: "ready",
			sendMessage,
			setMessages,
			clearError,
			stop: vi.fn(),
		} as never);
		const agentCall = vi.fn(async (method: string) =>
			method === "getClientRecoveryState"
				? {
						messages: [
							{
								id: messageId,
								role: "user",
								parts: [{ type: "text", text: "A quiet journal" }],
							},
						],
						turnActive: true,
					}
				: [],
		);
		vi.mocked(useAgent).mockReturnValue({ call: agentCall } as never);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
				.mockResolvedValueOnce(jsonResponse({ projectId, resuming: false, projects: [] })),
		);
		const user = userEvent.setup();
		render(<App />);
		await user.type(
			await screen.findByPlaceholderText("Describe the site you want to build…"),
			"A quiet journal",
		);
		await user.click(screen.getByRole("button", { name: /Build/ }));

		await waitFor(() => expect(agentCall).toHaveBeenCalledWith("getClientRecoveryState"));
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(setMessages).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: messageId })]),
		);
		expect(clearError).toHaveBeenCalledTimes(1);
	});

	it("keeps checkpoint details in Logs and offers one sticky save retry", async () => {
		const add = vi.spyOn(toasts, "add");
		const close = vi.spyOn(toasts, "close");
		const site = mountReopeningSite(async () => ({ ready: true }));
		await screen.findByRole("button", { name: "Publish" });

		site.sync({ persistenceError: "cp: cannot stat content.sqlite-wal" });
		expect(screen.queryByText(/changes are not safely saved/i)).toBeNull();
		expect(screen.queryByText(/sqlite-wal/i)).toBeNull();

		await waitFor(() =>
			expect(add).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "session-save-error:11111111-1111-4111-8111-111111111111",
					title: "Session changes could not be saved",
					timeout: 0,
				}),
			),
		);
		const toast = add.mock.calls.at(-1)?.[0] as { actions?: Array<{ onClick?: () => void }> };
		expect(JSON.stringify(toast)).not.toContain("sqlite-wal");
		toast.actions?.[0]?.onClick?.();
		toast.actions?.[0]?.onClick?.();
		expect(site.agentCall).toHaveBeenCalledWith("retrySessionSave");
		expect(
			site.agentCall.mock.calls.filter(([method]) => method === "retrySessionSave"),
		).toHaveLength(1);

		site.sync({ persistenceError: undefined });
		await waitFor(() =>
			expect(close).toHaveBeenCalledWith("session-save-error:11111111-1111-4111-8111-111111111111"),
		);
	});

	it("opens an agent-offered export instead of overlapping the publish panel", async () => {
		const site = mountReopeningSite(async () => ({ ready: true }));
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "Publish" }));
		expect(await screen.findByText("Sign in to publish")).toBeTruthy();
		site.offerClone();
		expect(await screen.findByRole("dialog", { name: "Export site" })).toBeTruthy();
		await waitFor(() => expect(screen.queryByText("Sign in to publish")).toBeNull());
	});

	it("keeps a published preview pending until its first provisioning finishes", async () => {
		let finish!: (result: { ready: boolean; error?: string }) => void;
		const response = new Promise<{ ready: boolean; error?: string }>(
			(resolve) => (finish = resolve),
		);
		const { previewUrl, sync } = mountReopeningSite(() => response);
		expect(await screen.findByText("Opening your site")).toBeTruthy();
		await act(async () => finish({ ready: false, error: "The site is not ready yet." }));
		expect(screen.queryByText("Couldn't restore this saved site")).toBeNull();
		expect(screen.getByText("Opening your site")).toBeTruthy();

		sync({ siteReady: true, cmsReady: true, complete: true, status: "" });
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: new URL(previewUrl).origin,
					source: frame.contentWindow,
					data: { source: "emdash-preview", type: "state", path: "/", title: "Site" },
				}),
			);
		});
		expect(screen.queryByText("Opening your site")).toBeNull();
		expect(screen.queryByText("Saved preview")).toBeNull();
		expect(screen.getByRole("tab", { name: "Admin" }).getAttribute("aria-disabled")).toBeNull();
	});

	it.each(["stopped", "failed", "awaiting_answers"] as const)(
		"points a %s first build back to chat instead of waiting forever",
		async (status) => {
			const { sync } = mountReopeningSite(async () => ({
				ready: false,
				error: "The site is not ready yet.",
			}));
			expect(await screen.findByText("Opening your site")).toBeTruthy();
			sync({
				siteReady: false,
				initialGeneration: { id: "brief", status },
				provisionError: status === "failed" ? "Setup failed" : undefined,
				status: "",
			});
			expect(screen.getByText("Continue in chat")).toBeTruthy();
			expect(screen.queryByText("Opening your site")).toBeNull();
			expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
			sync({
				siteReady: true,
				initialGeneration: { id: "brief", status: "ready" },
				cmsReady: true,
				status: "",
			});
			expect(screen.queryByText("Continue in chat")).toBeNull();
		},
	);

	it("clears a failed overlay after another tab restores the editor", async () => {
		const { sync } = mountReopeningSite(async () => ({
			ready: false,
			error: "The saved site snapshot could not be restored.",
		}));
		expect(await screen.findByText("Couldn't restore this saved site")).toBeTruthy();
		sync({ provisionError: "The saved site snapshot could not be restored." });
		sync({ previewRestarting: true, provisionError: undefined, status: "Restoring preview..." });
		sync({ previewRestarting: false, provisionError: undefined, status: "", cmsReady: true });
		expect(screen.queryByText("Couldn't restore this saved site")).toBeNull();
		expect(screen.getByRole("tab", { name: "Admin" }).getAttribute("aria-disabled")).toBeNull();
	});

	it("clears a failed overlay when a later chat turn reloads the recovered site", async () => {
		const { reload, sync } = mountReopeningSite(async () => ({
			ready: false,
			error: "The saved site snapshot could not be restored.",
		}));
		expect(await screen.findByText("Couldn't restore this saved site")).toBeTruthy();
		sync({ provisionError: undefined, status: "", cmsReady: true });
		reload();
		expect(screen.queryByText("Couldn't restore this saved site")).toBeNull();
	});

	it("retains a completed server recovery when its RPC response is lost afterward", async () => {
		let reject!: (error: Error) => void;
		const response = new Promise<{ ready: boolean }>((_resolve, fail) => (reject = fail));
		const { previewUrl, sync } = mountReopeningSite(() => response);
		expect(await screen.findByText("Opening your site")).toBeTruthy();
		sync({ previewRestarting: true, status: "Restoring preview..." });
		sync({ previewRestarting: false, status: "", cmsReady: true, complete: true });
		const frame = screen.getByTitle("Site preview") as HTMLIFrameElement;
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					origin: new URL(previewUrl).origin,
					source: frame.contentWindow,
					data: { source: "emdash-preview", type: "state", path: "/", title: "Site" },
				}),
			);
		});
		await act(async () => reject(new Error("Socket closed after recovery")));
		expect(screen.queryByText("Saved preview")).toBeNull();
		expect(screen.getByRole("tab", { name: "Admin" }).getAttribute("aria-disabled")).toBeNull();
	});

	it("verifies a ready reconnect when the wake notification was missed", async () => {
		const resumeCall = vi
			.fn()
			.mockRejectedValueOnce(new Error("socket dropped"))
			.mockResolvedValueOnce({ ready: true });
		const { sync } = mountReopeningSite(() => resumeCall());
		expect(await screen.findByText("Still reconnecting")).toBeTruthy();
		sync({ previewRestarting: false, status: "", cmsReady: true });
		await waitFor(() => expect(resumeCall).toHaveBeenCalledTimes(2));
		expect(screen.queryByText("Still reconnecting")).toBeNull();
		expect(screen.getByRole("tab", { name: "Admin" }).getAttribute("aria-disabled")).toBeNull();
	});

	it("bounds reconnect verification to one automatic attempt", async () => {
		const resumeCall = vi.fn().mockRejectedValue(new Error("socket dropped"));
		const { sync } = mountReopeningSite(() => resumeCall());
		expect(await screen.findByText("Still reconnecting")).toBeTruthy();
		sync({ previewRestarting: false, status: "" });
		await waitFor(() => expect(resumeCall).toHaveBeenCalledTimes(2));
		expect(await screen.findByText("Still reconnecting")).toBeTruthy();
		sync({ previewRestarting: false, status: "" });
		expect(resumeCall).toHaveBeenCalledTimes(2);
	});

	it("shows a saved site waking and reconciles a dropped retry from server state", async () => {
		mockLandingAgent();
		const projectId = "11111111-1111-4111-8111-111111111111";
		const previewUrl = "https://4321-saved-preview.example.test/";
		window.history.replaceState(null, "", `/s/${projectId}`);
		let finishRecovery!: (result: { ready: boolean; error?: string }) => void;
		const recovery = new Promise<{ ready: boolean; error?: string }>((resolve) => {
			finishRecovery = resolve;
		});
		const resumeCall = vi
			.fn()
			.mockReturnValueOnce(recovery)
			.mockRejectedValueOnce(new Error("socket closed"));
		const call = vi.fn((method: string) =>
			method === "resumePreview" ? resumeCall() : Promise.resolve([]),
		);
		let syncState: ((state: BuilderState) => void) | undefined;
		vi.mocked(useAgent).mockImplementation((options) => {
			syncState = options.onStateUpdate as (state: BuilderState) => void;
			return { call } as never;
		});
		vi.mocked(useAgentChat).mockReturnValue({
			messages: [{ id: "brief", role: "user", parts: [{ type: "text", text: "My site" }] }],
			isStreaming: false,
			status: "ready",
			sendMessage: vi.fn(),
		} as never);
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request) => {
				const url = input.toString();
				if (url === "/api/auth/account")
					return Promise.resolve(jsonResponse({ authenticated: false }));
				if (url === "/api/project-session")
					return Promise.resolve(
						jsonResponse({
							projectId,
							resuming: true,
							previewUrl,
							projects: [{ id: projectId, title: "My site", status: "draft" }],
						}),
					);
				if (url.startsWith("/api/projects")) return Promise.resolve(jsonResponse({ projects: [] }));
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		render(<App />);
		expect(await screen.findByText("Opening your site")).toBeTruthy();
		expect(call).toHaveBeenCalledWith("resumePreview", [window.location.host]);
		await act(async () => finishRecovery({ ready: false, error: "Snapshot unavailable" }));
		const failure = await screen.findByText("Couldn't restore this saved site");
		const user = userEvent.setup();
		await user.click(
			within(failure.closest('[role="alert"]') as HTMLElement).getByRole("button", {
				name: "Retry",
			}),
		);
		expect(resumeCall).toHaveBeenCalledTimes(2);
		expect(await screen.findByText("Still reconnecting")).toBeTruthy();
		act(() =>
			syncState?.({
				siteReady: true,
				previewUrl,
				previewRestarting: false,
				status: "",
			} as BuilderState),
		);
		expect(screen.getByText("Still reconnecting")).toBeTruthy();
		act(() =>
			syncState?.({ siteReady: true, previewUrl, previewRestarting: true } as BuilderState),
		);
		expect(screen.getByText("Opening your site")).toBeTruthy();
		act(() =>
			syncState?.({
				siteReady: true,
				previewUrl,
				previewRestarting: false,
				status: "",
			} as BuilderState),
		);
		expect(screen.queryByText("Still reconnecting")).toBeNull();
		expect(screen.getByText("Opening your site")).toBeTruthy();
	});
	it("offers a retry when a previously deleted site still needs cleanup", async () => {
		const projectId = "11111111-1111-4111-8111-111111111111";
		window.history.replaceState(null, "", `/s/${projectId}`);
		const fetchMock = vi.fn((input: string | URL | Request) => {
			const url = input.toString();
			if (url === "/api/auth/account")
				return Promise.resolve(jsonResponse({ authenticated: false }));
			if (url === "/api/project-session")
				return Promise.resolve(jsonResponse({ code: "PROJECT_DELETION_PENDING" }, 409));
			if (url === `/api/projects/${projectId}`)
				return Promise.resolve(jsonResponse({ error: "Still unavailable" }, 503));
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<App />);
		const retry = await screen.findByRole("button", { name: "Retry deletion" });
		expect(
			fetchMock.mock.calls.filter(([input]) => input.toString() === `/api/projects/${projectId}`),
		).toHaveLength(3);
		await userEvent.setup().click(retry);
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"Deletion is still unavailable. Please try again.",
		);
		expect(
			fetchMock.mock.calls.filter(([input]) => input.toString() === `/api/projects/${projectId}`),
		).toHaveLength(6);
		expect(fetchMock).toHaveBeenCalledWith(`/api/projects/${projectId}`, { method: "DELETE" });
	});

	it("finishes a popup sign-in by returning control to the existing workspace", async () => {
		window.history.replaceState(null, "", "/auth/complete");
		const opener = { closed: false, postMessage: vi.fn() };
		vi.stubGlobal("opener", opener);
		const close = vi.spyOn(window, "close").mockImplementation(() => {});
		const fetchMock = vi.fn((input: string | URL | Request) => {
			if (input.toString() === "/api/auth/account")
				return Promise.resolve(
					jsonResponse({
						authenticated: true,
						claimStatus: "complete",
						returnPath: "/s/11111111-1111-4111-8111-111111111111",
					}),
				);
			throw new Error(`Unexpected request: ${input}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);
		await waitFor(() =>
			expect(opener.postMessage).toHaveBeenCalledWith(
				{ type: "emdash-auth-complete" },
				window.location.origin,
			),
		);
		expect(close).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("opens sign-in in a popup while the current site remains visible", async () => {
		mockLandingAgent();
		const popup = { closed: false, location: { assign: vi.fn() }, close: vi.fn() };
		vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
		const fetchMock = vi.fn((input: string | URL | Request) => {
			const url = input.toString();
			if (url === "/api/auth/account")
				return Promise.resolve(jsonResponse({ authenticated: false }));
			if (url === "/api/project-session")
				return Promise.resolve(
					jsonResponse({
						projectId: "11111111-1111-4111-8111-111111111111",
						resuming: false,
						projects: [],
					}),
				);
			if (url === "/api/auth/login")
				return Promise.resolve(
					jsonResponse({ authenticated: false, url: "https://identity.test/login" }),
				);
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);
		await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in" }));
		await waitFor(() =>
			expect(popup.location.assign).toHaveBeenCalledWith("https://identity.test/login"),
		);
		expect(window.open).toHaveBeenCalledWith(
			"",
			"emdash-sign-in",
			expect.stringContaining("popup"),
		);
		expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
	});

	it("keeps details visible through compact layout changes and restores the mounted preview", async () => {
		const layoutListeners = new Set<() => void>();
		let compact = false;
		vi.stubGlobal(
			"matchMedia",
			vi.fn((query: string) => ({
				get matches() {
					return query === "(max-width: 1120px)" && compact;
				},
				addEventListener: (_type: string, listener: () => void) => layoutListeners.add(listener),
				removeEventListener: (_type: string, listener: () => void) =>
					layoutListeners.delete(listener),
			})),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request) => {
				const url = input.toString();
				if (url === "/api/auth/account")
					return Promise.resolve(jsonResponse({ authenticated: false }));
				if (url === "/api/project-session")
					return Promise.resolve(
						jsonResponse({
							projectId: "11111111-1111-4111-8111-111111111111",
							resuming: true,
							projects: [],
						}),
					);
				if (url.startsWith("/api/projects/")) return Promise.resolve(jsonResponse({}));
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		const agentCall = vi.fn(async (method: string) =>
			method === "getPreviewThumbnail" ? { base64: "cGljdHVyZQ==", mediaType: "image/png" } : [],
		);
		vi.mocked(useAgent).mockReturnValue({ call: agentCall } as never);
		vi.mocked(useAgentChat).mockReturnValue({
			messages: [
				{ id: "user-1", role: "user", parts: [{ type: "text", text: "Build a site" }] },
				{
					id: "assistant-1",
					role: "assistant",
					parts: [
						{
							type: "tool-write_file",
							state: "output-available",
							input: { path: "src/pages/index.astro" },
							output: { success: true },
						},
						{
							type: "tool-view_preview",
							state: "output-available",
							output: { success: true, shotId: "00000000-0000-4000-8000-000000000001" },
						},
						{ type: "text", text: "Your site is ready." },
					],
				},
			],
			isStreaming: false,
			status: "ready",
			sendMessage: vi.fn(),
			stop: vi.fn(),
		} as never);
		const user = userEvent.setup();
		render(<App />);
		expect(
			screen.queryByRole("img", { name: "Site screenshot captured during this response" }),
		).toBeNull();
		await user.click(await screen.findByRole("button", { name: "View activity" }));
		const preview = document.querySelector(".project-preview .preview-reveal");
		expect(preview).toBeTruthy();
		expect(document.querySelector(".project-preview [inert]")).toContain(preview);
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to site" }));
		await user.click(screen.getByRole("button", { name: "Reviewed the preview" }));
		await screen.findByRole("img", { name: "Preview screenshot captured during this step" });
		expect(agentCall).toHaveBeenCalledWith("getPreviewThumbnail", [
			"00000000-0000-4000-8000-000000000001",
		]);
		expect(
			agentCall.mock.calls.filter(([method]) => method === "getPreviewThumbnail"),
		).toHaveLength(1);
		const activity = screen.getByRole("button", { name: "View activity" });
		expect(activity.getAttribute("aria-current")).toBe("true");
		await user.click(activity);
		expect(screen.getByRole("region", { name: "Build activity" })).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Back to site" }));
		expect(screen.queryByRole("region", { name: "Build activity" })).toBeNull();
		expect(document.querySelector(".project-preview .preview-reveal")).toBe(preview);
		await user.click(activity);

		act(() => {
			compact = true;
			for (const listener of layoutListeners) listener();
		});
		expect(screen.getByRole("region", { name: "Build activity" })).toBeTruthy();
		expect(document.getElementById("project-chat")?.hasAttribute("inert")).toBe(true);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(screen.queryByRole("region", { name: "Build activity" })).toBeNull();
		expect(document.querySelector(".project-preview .preview-reveal")).toBe(preview);
		expect(document.querySelector(".project-preview [inert]")).toBeNull();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Site" })),
		);
	});

	it("does not request a direct project session until its pending account claim completes", async () => {
		window.history.replaceState(null, "", "/s/11111111-1111-4111-8111-111111111111");
		const fetchMock = vi.fn((input: string | URL | Request) => {
			const url = input.toString();
			if (url === "/api/auth/account") {
				return Promise.resolve(
					jsonResponse({
						authenticated: true,
						claimStatus: "available",
						returnPath: "/s/11111111-1111-4111-8111-111111111111",
					}),
				);
			}
			if (url === "/api/auth/claim") return new Promise<Response>(() => {});
			throw new Error(`Unexpected boot request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);

		expect(await screen.findByRole("heading", { name: "Connecting your projects" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
		expect(fetchMock.mock.calls.map(([input]) => input.toString())).toEqual([
			"/api/auth/account",
			"/api/auth/claim",
		]);
	});

	it("keeps callback completion visible when the account catalogue cannot load", async () => {
		window.history.replaceState(null, "", "/auth/complete");
		const fetchMock = vi.fn((input: string | URL | Request) => {
			const url = input.toString();
			if (url === "/api/auth/account") {
				return Promise.resolve(
					jsonResponse({ authenticated: true, claimStatus: "complete", returnPath: "/" }),
				);
			}
			if (url === "/api/projects") {
				return Promise.resolve(jsonResponse({ error: "unavailable" }, 503));
			}
			throw new Error(`Unexpected completion request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);

		expect(await screen.findByText("Your projects could not be loaded right now.")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
		expect(fetchMock.mock.calls.map(([input]) => input.toString())).toEqual([
			"/api/auth/account",
			"/api/projects",
		]);
	});

	it("shows the signed-in New site prompt beside the server-backed recents", async () => {
		mockLandingAgent();
		window.history.replaceState(null, "", "/?new=1");
		localStorage.setItem(
			"emdash-build:recent-projects",
			JSON.stringify([{ id: "stale", title: "Stale project" }]),
		);
		const projects = [
			{
				id: "11111111-1111-4111-8111-111111111111",
				title: "Account project",
				status: "draft",
				updatedAt: 5,
			},
		];
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ authenticated: true, claimStatus: "complete" }))
				.mockResolvedValueOnce(
					jsonResponse({
						projectId: "22222222-2222-4222-8222-222222222222",
						resuming: false,
						projects,
					}),
				),
		);

		render(<App />);

		const prompt = await screen.findByPlaceholderText("Describe the site you want to build…");
		expect(screen.getByRole("complementary")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Account project" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "New site" }).getAttribute("aria-current")).toBe(
			"page",
		);
		expect(document.querySelector(".landing-nav")).toBeNull();
		await userEvent.setup().click(screen.getByRole("button", { name: "New site" }));
		expect(document.activeElement).toBe(prompt);
		await waitFor(() =>
			expect(JSON.parse(localStorage.getItem("emdash-build:recent-projects") ?? "null")).toEqual(
				projects,
			),
		);
	});

	it("keeps anonymous first-run on the full-width landing", async () => {
		mockLandingAgent();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
				.mockResolvedValueOnce(
					jsonResponse({
						projectId: "22222222-2222-4222-8222-222222222222",
						resuming: false,
						projects: [],
					}),
				),
		);
		render(<App />);
		expect(await screen.findByPlaceholderText("Describe the site you want to build…")).toBeTruthy();
		expect(screen.queryByRole("complementary")).toBeNull();
		expect(document.querySelector(".landing-nav")).toBeTruthy();
	});

	it("keeps a guest's recents beside New site after leaving an existing workspace", async () => {
		mockLandingAgent();
		window.history.replaceState(null, "", "/?new=1");
		const recent = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Iceland portfolio",
			status: "draft",
			updatedAt: 5,
		};
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
			.mockResolvedValueOnce(
				jsonResponse({
					projectId: "22222222-2222-4222-8222-222222222222",
					resuming: false,
					projects: [recent],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);
		const prompt = await screen.findByPlaceholderText("Describe the site you want to build…");
		expect(screen.getByRole("complementary")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Iceland portfolio" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "New site" }).getAttribute("aria-current")).toBe(
			"page",
		);
		expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
		expect(document.querySelector(".landing-nav")).toBeNull();
		await userEvent.setup().click(screen.getByRole("button", { name: "New site" }));
		expect(document.activeElement).toBe(prompt);
		expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/project-session", expect.any(Object));
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
			createNew: true,
			createProjectId: expect.any(String),
			creationToken: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
	});

	it("keeps the signed-in sidebar mounted when the first prompt starts building", async () => {
		mockLandingAgent();
		window.history.replaceState(null, "", "/?new=1");
		vi.mocked(useAgentChat).mockImplementation(() => {
			const [messages, setMessages] = useState<
				{ id: string; role: "user"; parts: { type: "text"; text: string }[] }[]
			>([]);
			return {
				messages,
				isStreaming: false,
				sendMessage: (message: {
					id: string;
					role: "user";
					parts: { type: "text"; text: string }[];
				}) => setMessages([message]),
			} as never;
		});
		const projectId = "22222222-2222-4222-8222-222222222222";
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request) => {
				const url = input.toString();
				if (url === "/api/auth/account")
					return Promise.resolve(jsonResponse({ authenticated: true, claimStatus: "complete" }));
				if (url === "/api/project-session")
					return Promise.resolve(jsonResponse({ projectId, resuming: false, projects: [] }));
				if (url === `/api/projects/${projectId}`)
					return Promise.resolve(jsonResponse({ ok: true }));
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		render(<App />);
		const sidebar = await screen.findByRole("complementary");
		const user = userEvent.setup();
		await user.type(
			screen.getByPlaceholderText("Describe the site you want to build…"),
			"A small blog",
		);
		await user.click(screen.getByRole("button", { name: /Build/ }));
		await waitFor(() => expect(document.querySelector(".project-chat")).toBeTruthy());
		expect(screen.getByRole("complementary")).toBe(sidebar);
		expect(window.location.pathname).toBe(`/s/${projectId}`);
	});

	it("retries automatic project metadata writes without visible noise", async () => {
		mockLandingAgent();
		const projectId = "22222222-2222-4222-8222-222222222222";
		vi.mocked(useAgentChat).mockReturnValue({
			messages: [
				{ id: "brief", role: "user", parts: [{ type: "text", text: "An Iceland journal" }] },
			],
			isStreaming: false,
			status: "ready",
			sendMessage: vi.fn(),
			stop: vi.fn(),
		} as never);
		let writes = 0;
		const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url === "/api/auth/account")
				return Promise.resolve(jsonResponse({ authenticated: false }));
			if (url === "/api/project-session")
				return Promise.resolve(jsonResponse({ projectId, resuming: false, projects: [] }));
			if (url === `/api/projects/${projectId}` && init?.method === "PUT") {
				writes += 1;
				return Promise.resolve(
					writes === 1
						? jsonResponse({ error: "temporary infrastructure detail" }, 503)
						: jsonResponse({ ok: true }),
				);
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(<App />);

		await waitFor(() => expect(writes).toBe(2), { timeout: 2_000 });
		expect(screen.queryByText(/temporary infrastructure detail/i)).toBeNull();
		expect(document.querySelector("[data-toast-title]")).toBeNull();
	});

	it("keeps the sidebar in creation order when an older site is opened", async () => {
		mockLandingAgent();
		const newer = {
			id: "22222222-2222-4222-8222-222222222222",
			title: "Newer site",
			status: "draft",
			createdAt: 20,
			updatedAt: 20,
		};
		const opened = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Opened site",
			status: "draft",
			createdAt: 10,
			updatedAt: 10,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request) => {
				const url = input.toString();
				if (url === "/api/auth/account")
					return Promise.resolve(jsonResponse({ authenticated: true, claimStatus: "complete" }));
				if (url === "/api/project-session")
					return Promise.resolve(
						jsonResponse({ projectId: opened.id, resuming: true, projects: [newer, opened] }),
					);
				if (url.startsWith("/api/projects/")) return Promise.resolve(jsonResponse({}));
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		vi.mocked(useAgentChat).mockReturnValue({
			messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Opened site" }] }],
			isStreaming: false,
			status: "ready",
			sendMessage: vi.fn(),
		} as never);

		render(<App />);

		const sites = async () =>
			within(await screen.findByRole("complementary"))
				.getAllByRole("button", { name: /^(Newer site|Opened site)$/ })
				.map((button) => button.textContent);
		await waitFor(async () => expect(await sites()).toEqual(["Newer site", "Opened site"]));
		// Let the open site's own updates land; it must not jump to the top.
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(await sites()).toEqual(["Newer site", "Opened site"]);
	});

	it("preloads and opens a recent site without replacing the app with Connecting", async () => {
		mockLandingAgent();
		const currentId = "11111111-1111-4111-8111-111111111111";
		const targetId = "22222222-2222-4222-8222-222222222222";
		window.history.replaceState(null, "", `/s/${currentId}`);
		const projects = [
			{ id: currentId, title: "Current site", status: "draft", createdAt: 20, updatedAt: 20 },
			{ id: targetId, title: "Target site", status: "draft", createdAt: 10, updatedAt: 10 },
		];
		const currentMessages = [
			{ id: "current-user", role: "user", parts: [{ type: "text", text: "Current site" }] },
		];
		const targetMessages = [
			{ id: "target-user", role: "user", parts: [{ type: "text", text: "Target site" }] },
		];
		const currentPreviewUrl = "https://4321-current-preview.example.test/";
		const previewUrl = "https://4321-target-preview.example.test/";
		let targetRequests = 0;
		let holdTargetRequests = false;
		const pendingTargetRequests: ((response: Response) => void)[] = [];
		vi.mocked(useAgent).mockImplementation(
			() =>
				({
					call: vi.fn(async (method: string) =>
						method === "resumePreview" ? { ready: true } : [],
					),
				}) as never,
		);
		vi.mocked(useAgentChat).mockImplementation(
			(options) =>
				({
					messages: options.messages ?? currentMessages,
					isStreaming: false,
					status: "ready",
					sendMessage: vi.fn(),
					stop: vi.fn(),
				}) as never,
		);
		const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url === "/api/auth/account")
				return Promise.resolve(jsonResponse({ authenticated: true, claimStatus: "complete" }));
			if (url === "/api/project-session") {
				const body = JSON.parse(String(init?.body ?? "{}")) as { projectId?: string };
				const projectId = body.projectId ?? currentId;
				const response = () =>
					jsonResponse({
						projectId,
						resuming: true,
						projects,
						previewUrl: projectId === targetId ? previewUrl : currentPreviewUrl,
						initialMessages: projectId === targetId ? targetMessages : currentMessages,
					});
				if (projectId === targetId) targetRequests += 1;
				if (projectId === targetId && holdTargetRequests) {
					return new Promise<Response>((resolve) => {
						pendingTargetRequests.push(resolve);
					});
				}
				return Promise.resolve(response());
			}
			if (url.startsWith("/api/projects/")) return Promise.resolve(jsonResponse({ ok: true }));
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const user = userEvent.setup();
		render(<App />);

		const target = await screen.findByRole("button", { name: "Target site" });
		fireEvent.pointerEnter(target);
		await waitFor(() => expect(targetRequests).toBe(1));
		expect(window.location.pathname).toBe(`/s/${currentId}`);

		holdTargetRequests = true;
		await user.click(target);
		await waitFor(() => expect(pendingTargetRequests.length).toBeGreaterThan(0));
		await user.click(screen.getByRole("button", { name: "Current site" }));
		holdTargetRequests = false;
		await act(async () => {
			for (const resolve of pendingTargetRequests.splice(0)) {
				resolve(
					jsonResponse({
						projectId: targetId,
						resuming: true,
						projects,
						previewUrl,
						initialMessages: targetMessages,
					}),
				);
			}
		});
		expect(window.location.pathname).toBe(`/s/${currentId}`);
		expect(screen.queryByText("Connecting...")).toBeNull();

		await user.click(target);
		await waitFor(() => expect(window.location.pathname).toBe(`/s/${targetId}`));
		expect(screen.queryByText("Connecting...")).toBeNull();
		expect((screen.getByTitle("Site preview") as HTMLIFrameElement).src).toBe(previewUrl);
		const targetChat = [...vi.mocked(useAgentChat).mock.calls]
			.reverse()
			.find(([options]) => options.messages?.[0]?.id === "target-user")?.[0];
		expect(targetChat).toMatchObject({
			messages: [{ id: "target-user" }],
			getInitialMessages: null,
			cancelOnClientAbort: false,
		});

		window.history.replaceState(null, "", `/s/${currentId}`);
		window.dispatchEvent(new PopStateEvent("popstate"));
		await waitFor(() =>
			expect((screen.getByTitle("Site preview") as HTMLIFrameElement).src).toBe(currentPreviewUrl),
		);
		expect(window.location.pathname).toBe(`/s/${currentId}`);
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Current site" })),
		);
	});

	it("shimmers the open site from its live turn, not from a saved flag", async () => {
		mockLandingAgent();
		const opened = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Opened site",
			status: "draft",
			createdAt: 10,
			updatedAt: 10,
			// A flag saved by an earlier page must not survive into this one.
			building: true,
		};
		const other = {
			...opened,
			id: "22222222-2222-4222-8222-222222222222",
			title: "Other site",
			building: false,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request) => {
				const url = input.toString();
				if (url === "/api/auth/account")
					return Promise.resolve(jsonResponse({ authenticated: true, claimStatus: "complete" }));
				if (url === "/api/project-session")
					return Promise.resolve(
						jsonResponse({ projectId: opened.id, resuming: true, projects: [opened, other] }),
					);
				if (url.startsWith("/api/projects")) return Promise.resolve(jsonResponse({}));
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		const idle = {
			messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Opened site" }] }],
			isStreaming: false,
			status: "ready",
			sendMessage: vi.fn(),
		};
		vi.mocked(useAgentChat).mockReturnValue(idle as never);

		const view = render(<App />);
		const sidebar = await screen.findByRole("complementary");
		await waitFor(() =>
			expect(within(sidebar).getByRole("button", { name: "Opened site" })).toBeTruthy(),
		);
		expect(sidebar.querySelector(".shimmer-text")).toBeNull();

		vi.mocked(useAgentChat).mockReturnValue({
			...idle,
			isStreaming: true,
			status: "streaming",
		} as never);
		view.rerender(<App />);
		await waitFor(() =>
			expect(within(sidebar).getByRole("button", { name: "Opened site, Building" })).toBeTruthy(),
		);
		const saved = JSON.parse(
			localStorage.getItem("emdash-build:recent-projects") ?? "[]",
		) as object[];
		expect(saved.length).toBeGreaterThan(0);
		expect(saved.every((project) => !("building" in project))).toBe(true);
	});

	it("does not let a refresh that started before a rename undo it", async () => {
		mockLandingAgent();
		const opened = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Opened site",
			status: "draft",
			createdAt: 10,
			updatedAt: 10,
		};
		const other = { ...opened, id: "22222222-2222-4222-8222-222222222222", title: "Other site" };
		let answerList: (value: Response) => void = () => {};
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				if (url === "/api/auth/account")
					return Promise.resolve(jsonResponse({ authenticated: true, claimStatus: "complete" }));
				if (url === "/api/project-session")
					return Promise.resolve(
						jsonResponse({ projectId: opened.id, resuming: true, projects: [opened, other] }),
					);
				if (url === "/api/projects" && !init?.method)
					return new Promise<Response>((resolve) => {
						answerList = resolve;
					});
				if (url.startsWith("/api/projects/")) return Promise.resolve(jsonResponse({}));
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		vi.mocked(useAgentChat).mockReturnValue({
			messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Opened site" }] }],
			isStreaming: false,
			status: "ready",
			sendMessage: vi.fn(),
		} as never);
		const user = userEvent.setup();
		render(<App />);
		const sidebar = await screen.findByRole("complementary");
		await within(sidebar).findByRole("button", { name: "Other site" });

		// Coming back to the tab starts a refresh; the rename lands before it returns.
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
		await user.click(within(sidebar).getByRole("button", { name: "Options for Other site" }));
		await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
		const input = await screen.findByRole("textbox", { name: "Site name" });
		await user.clear(input);
		await user.type(input, "Renamed site");
		await user.click(screen.getByRole("button", { name: "Save" }));
		await within(sidebar).findByRole("button", { name: "Renamed site" });

		await act(async () => answerList(jsonResponse({ projects: [opened, other] })));
		expect(within(sidebar).getByRole("button", { name: "Renamed site" })).toBeTruthy();
		expect(within(sidebar).queryByRole("button", { name: "Other site" })).toBeNull();
		Reflect.deleteProperty(document, "visibilityState");
	});

	it("opens a resumed account project without exposing the new-site prompt", async () => {
		mockLandingAgent();
		const project = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Account project",
			status: "draft",
			updatedAt: 5,
		};
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ authenticated: true, claimStatus: "complete" }))
				.mockResolvedValueOnce(
					jsonResponse({ projectId: project.id, resuming: true, projects: [project] }),
				),
		);

		render(<App />);

		expect(await screen.findByRole("button", { name: "New site" })).toBeTruthy();
		expect(screen.queryByPlaceholderText("Describe the site you want to build…")).toBeNull();
	});

	it("publishes once from the popover and shows the stable live URL", async () => {
		mockLandingAgent();
		let syncState: ((state: BuilderState) => void) | undefined;
		vi.mocked(useAgent).mockImplementation((options) => {
			syncState = options.onStateUpdate as typeof syncState;
			return { call: vi.fn().mockResolvedValue([]) } as never;
		});
		const project = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Publish project",
			status: "draft" as const,
			updatedAt: 5,
		};
		let finishPublish!: (response: Response) => void;
		const publishResponse = new Promise<Response>((resolve) => (finishPublish = resolve));
		const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			if (url === "/api/auth/account") {
				return Promise.resolve(jsonResponse({ authenticated: true, claimStatus: "complete" }));
			}
			if (url === "/api/project-session") {
				return Promise.resolve(
					jsonResponse({
						projectId: project.id,
						resuming: true,
						projects: [project],
						publishingEnabled: true,
					}),
				);
			}
			if (url === `/api/projects/${project.id}/publish`)
				return init?.method === "POST"
					? publishResponse
					: Promise.resolve(jsonResponse({ namedPublishing: false }));
			if (url === `/api/projects/${project.id}`) return Promise.resolve(jsonResponse({ ok: true }));
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		const user = userEvent.setup();
		render(<App />);

		await user.click(await screen.findByRole("button", { name: "Publish" }));
		const publish = await screen.findByRole("button", { name: "Publish site" });
		await user.click(publish);
		expect(screen.getByRole("button", { name: "Publishing…" })).toBeTruthy();
		act(() =>
			syncState?.({
				siteReady: true,
				status: "Checking pages and assets...",
			} as BuilderState),
		);
		expect(screen.getAllByText("Checking pages and assets…")).toHaveLength(2);
		expect(
			fetchMock.mock.calls.filter(
				([input, init]) => input.toString().endsWith("/publish") && init?.method === "POST",
			),
		).toHaveLength(1);

		finishPublish(
			jsonResponse({
				status: "live",
				liveUrl: "https://stable.sites.test",
				releaseId: "release-1",
				sourceRevision: `sha256:${"a".repeat(64)}`,
				publishedAt: 10,
			}),
		);
		const live = await screen.findByRole("link", { name: /Visit site/ });
		expect(live.getAttribute("href")).toBe("https://stable.sites.test");
	});

	it("moves focus into a compact preview and back when it closes", async () => {
		mockLandingAgent();
		let compact = true;
		const layoutListeners = new Set<() => void>();
		vi.stubGlobal(
			"matchMedia",
			vi.fn((query: string) => ({
				get matches() {
					return query === "(max-width: 1120px)" && compact;
				},
				addEventListener: (_type: string, listener: () => void) => {
					if (query === "(max-width: 1120px)") layoutListeners.add(listener);
				},
				removeEventListener: (_type: string, listener: () => void) =>
					layoutListeners.delete(listener),
			})),
		);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
				.mockResolvedValueOnce(
					jsonResponse({
						projectId: "11111111-1111-4111-8111-111111111111",
						resuming: true,
						projects: [],
					}),
				)
				.mockResolvedValue(jsonResponse({ namedPublishing: false })),
		);
		const user = userEvent.setup();
		render(<App />);

		const showPreview = await screen.findByRole("button", { name: "Show preview" });
		await user.click(showPreview);
		const chatPanel = document.getElementById("project-chat");
		expect(chatPanel?.hasAttribute("inert")).toBe(true);
		expect(chatPanel?.getAttribute("aria-hidden")).toBe("true");
		expect(screen.queryByRole("textbox", { name: "Message EmDash" })).toBeNull();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Site" })),
		);
		await user.click(screen.getByRole("button", { name: "Close preview" }));
		expect(chatPanel?.hasAttribute("inert")).toBe(false);
		expect(screen.getByRole("textbox", { name: "Message EmDash" })).toBeTruthy();
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show preview" })),
		);
		await user.click(screen.getByRole("button", { name: "Show preview" }));
		fireEvent.keyDown(window, { key: "Escape" });
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show preview" })),
		);

		act(() => {
			compact = false;
			for (const listener of layoutListeners) listener();
		});
		screen.getByRole("tab", { name: "Site" }).focus();
		act(() => {
			compact = true;
			for (const listener of layoutListeners) listener();
		});
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show preview" })),
		);
		act(() => {
			compact = false;
			for (const listener of layoutListeners) listener();
		});
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Site" })),
		);
		screen.getByRole("separator", { name: "Chat width" }).focus();
		act(() => {
			compact = true;
			for (const listener of layoutListeners) listener();
		});
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show preview" })),
		);
		await user.click(screen.getByRole("button", { name: "Show preview" }));
		const viewAction = screen.getByRole("button", { name: "Close preview" });
		viewAction.focus();
		act(() => {
			compact = false;
			for (const listener of layoutListeners) listener();
		});
		expect(screen.getByRole("button", { name: "Expand preview" })).toBe(viewAction);
		expect(document.activeElement).toBe(viewAction);
		act(() => {
			compact = true;
			for (const listener of layoutListeners) listener();
		});
		expect(screen.getByRole("button", { name: "Close preview" })).toBe(viewAction);
		expect(document.activeElement).toBe(viewAction);
		act(() => {
			compact = false;
			for (const listener of layoutListeners) listener();
		});
		screen.getByRole("textbox", { name: "Message EmDash" }).focus();
		act(() => {
			compact = true;
			for (const listener of layoutListeners) listener();
		});
		expect(chatPanel?.hasAttribute("inert")).toBe(true);
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Site" })),
		);
	});

	it("keeps export and deploy feedback visible when the compact preview is closed", async () => {
		mockLandingAgent();
		vi.stubGlobal(
			"matchMedia",
			vi.fn((query: string) => ({
				matches: query === "(max-width: 1120px)",
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			})),
		);
		let syncState: ((state: BuilderState) => void) | undefined;
		vi.mocked(useAgent).mockImplementation((options) => {
			syncState = options.onStateUpdate as typeof syncState;
			return { call: vi.fn().mockResolvedValue([]) } as never;
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
				.mockResolvedValueOnce(
					jsonResponse({
						projectId: "11111111-1111-4111-8111-111111111111",
						resuming: true,
						projects: [],
						publishingEnabled: true,
					}),
				),
		);
		const user = userEvent.setup();
		render(<App />);
		await screen.findByRole("button", { name: "Show preview" });
		act(() =>
			syncState?.({
				previewUrl: "https://example.test/",
				siteReady: true,
				deploy: {
					at: Date.now(),
					claimUrl: "https://example.test/claim",
					liveUrl: "https://example.test/live",
				},
			} as BuilderState),
		);
		const claim = screen.getByRole("link", { name: "Claim on Cloudflare" });
		expect(claim.closest(".project-preview")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Export" }));
		expect(screen.getByText("Clone this site locally").closest(".project-preview")).toBeNull();
		expect(document.querySelector(".project-preview")?.classList.contains("hidden")).toBe(true);
		await user.click(screen.getByRole("button", { name: "Show preview" }));
		await user.click(screen.getByRole("button", { name: "Publish" }));
		expect(screen.getByRole("dialog", { name: "Publish site" })).toBeTruthy();
		expect(screen.getByRole("tab", { name: "Site" })).toBeTruthy();
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Close publish panel" }),
			),
		);
	});

	it("hides publication and legacy deployment UI when the release lock is active", async () => {
		mockLandingAgent();
		let syncState: ((state: BuilderState) => void) | undefined;
		vi.mocked(useAgent).mockImplementation((options) => {
			syncState = options.onStateUpdate as typeof syncState;
			return { call: vi.fn().mockResolvedValue([]) } as never;
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(jsonResponse({ authenticated: false }))
				.mockResolvedValueOnce(
					jsonResponse({
						projectId: "11111111-1111-4111-8111-111111111111",
						resuming: true,
						projects: [],
						publishingEnabled: false,
					}),
				),
		);

		render(<App />);
		await screen.findByRole("heading", { name: "Untitled site" });
		expect(document.querySelector("[data-publish-button]")).toBeNull();

		act(() =>
			syncState?.({
				previewUrl: "https://example.test/",
				siteReady: true,
				publication: {
					at: Date.now(),
					liveUrl: "https://published.example.test/",
					releaseId: "11111111-1111-4111-8111-111111111111",
					sourceRevision: `sha256:${"a".repeat(64)}`,
				},
				deploy: {
					at: Date.now(),
					claimUrl: "https://example.test/claim",
					liveUrl: "https://example.test/live",
				},
			} as BuilderState),
		);

		expect(screen.queryByRole("link", { name: "Claim on Cloudflare" })).toBeNull();
		expect(screen.queryByRole("button", { name: "live" })).toBeNull();
	});

	it("reports a callback error as a toast without stealing focus from the landing", async () => {
		mockLandingAgent();
		window.history.replaceState(null, "", "/?auth=failed");
		let resolveSession!: (response: Response) => void;
		const sessionResponse = new Promise<Response>((resolve) => (resolveSession = resolve));
		const fetchMock = vi.fn((input: string | URL | Request) => {
			const url = input.toString();
			if (url === "/api/auth/account")
				return Promise.resolve(jsonResponse({ authenticated: false }));
			if (url === "/api/project-session") return sessionResponse;
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<Toasty toastManager={toasts}>
				<App />
			</Toasty>,
		);

		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some(([input]) => input.toString() === "/api/project-session"),
			).toBe(true),
		);
		expect(window.location.search).toBe("");
		expect(document.querySelector("[data-toast-title]")).toBeNull();
		await act(async () =>
			resolveSession(
				jsonResponse({
					projectId: "11111111-1111-4111-8111-111111111111",
					resuming: false,
					projects: [],
				}),
			),
		);
		await waitFor(() =>
			expect(document.querySelector("[data-toast-title]")).toHaveProperty(
				"textContent",
				"Sign in failed. Please try again.",
			),
		);
		const error = document.querySelector<HTMLElement>("[data-toast-title]")!;
		expect(error.closest("main")).toBeNull();
		const composer = screen.getByPlaceholderText("Describe the site you want to build…");
		await waitFor(() => expect(document.activeElement).toBe(composer));
	});

	it("reports a callback error after the account completion view is ready", async () => {
		window.history.replaceState(null, "", "/?auth=failed");
		vi.stubGlobal(
			"fetch",
			vi.fn((input: string | URL | Request) => {
				const url = input.toString();
				if (url === "/api/auth/account")
					return Promise.resolve(
						jsonResponse({ authenticated: true, claimStatus: "available", returnPath: "/" }),
					);
				if (url === "/api/auth/claim") return new Promise<Response>(() => {});
				throw new Error(`Unexpected request: ${url}`);
			}),
		);

		render(
			<Toasty toastManager={toasts}>
				<App />
			</Toasty>,
		);

		expect(await screen.findByRole("heading", { name: "Connecting your projects" })).toBeTruthy();
		await waitFor(() =>
			expect(document.querySelector("[data-toast-title]")).toHaveProperty(
				"textContent",
				"Sign in failed. Please try again.",
			),
		);
		expect(window.location.search).toBe("");
	});

	it("keeps account state and the landing visible when logout fails", async () => {
		mockLandingAgent();
		const projects = [
			{
				id: "11111111-1111-4111-8111-111111111111",
				title: "Account project",
				status: "draft",
				updatedAt: 5,
			},
		];
		const fetchMock = vi.fn((input: string | URL | Request) => {
			const url = input.toString();
			if (url === "/api/auth/account") {
				return Promise.resolve(jsonResponse({ authenticated: true, claimStatus: "complete" }));
			}
			if (url === "/api/project-session") {
				return Promise.resolve(
					jsonResponse({ projectId: projects[0]!.id, resuming: false, projects }),
				);
			}
			return Promise.resolve(jsonResponse({ error: "unavailable" }, 503));
		});
		vi.stubGlobal("fetch", fetchMock);
		render(
			<Toasty toastManager={toasts}>
				<App />
			</Toasty>,
		);
		const user = userEvent.setup();

		await user.click(await screen.findByRole("button", { name: "Sign out" }));

		await waitFor(() =>
			expect(document.querySelector("[data-toast-title]")).toHaveProperty(
				"textContent",
				"Sign out is temporarily unavailable.",
			),
		);
		expect(screen.getByPlaceholderText("Describe the site you want to build…")).toBeTruthy();
		expect(JSON.parse(localStorage.getItem("emdash-build:recent-projects") ?? "null")).toEqual(
			projects,
		);
	});
});

function PublishHarness() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<aside data-sidebar="sidebar">
				<button type="button">Sidebar action</button>
			</aside>
			<main data-sidebar-workspace>
				<PublishPanel
					projectId="99999999-9999-4999-8999-999999999999"
					open={open}
					onOpenChange={setOpen}
					state={{ stage: "authentication-required" }}
					onPublish={vi.fn()}
					onSignIn={vi.fn()}
				/>
			</main>
		</>
	);
}

describe("PublishPanel", () => {
	it("presents authentication-required publishing in the popover", async () => {
		const onSignIn = vi.fn();
		const user = userEvent.setup();
		render(
			<PublishPanel
				projectId="99999999-9999-4999-8999-999999999999"
				open
				state={{ stage: "authentication-required" }}
				onOpenChange={vi.fn()}
				onPublish={vi.fn()}
				onSignIn={onSignIn}
			/>,
		);

		expect(screen.getByRole("dialog", { name: "Publish site" })).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Sign in" }));
		expect(onSignIn).toHaveBeenCalledTimes(1);
	});

	it("announces publishing, preserves Live on failure, and exposes retry", async () => {
		const onRetry = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => jsonResponse({ namedPublishing: false })),
		);
		const view = render(
			<PublishPanel
				projectId="99999999-9999-4999-8999-999999999999"
				open
				state={{ stage: "publishing" }}
				onOpenChange={vi.fn()}
				onPublish={onRetry}
				onSignIn={vi.fn()}
			/>,
		);
		expect(screen.getByRole("status").textContent).toContain("Publishing");
		view.rerender(
			<PublishPanel
				projectId="99999999-9999-4999-8999-999999999999"
				open
				state={{
					stage: "failed",
					error: "Validation failed",
					reference: "12ab34cd",
					liveUrl: "https://site.test",
				}}
				onOpenChange={vi.fn()}
				onPublish={onRetry}
				onSignIn={vi.fn()}
			/>,
		);
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "Try again" }));
		expect(onRetry).toHaveBeenCalledOnce();
		expect(screen.getByRole("alert").textContent).toContain("Validation failed");
		expect(screen.getByRole("alert").textContent).toContain("Live is unchanged");
		expect(screen.getByRole("alert").textContent).toContain("Reference: 12ab34cd");
		expect(screen.getByRole("link", { name: /Visit site/ }).getAttribute("href")).toBe(
			"https://site.test",
		);
	});

	it("allows background interaction and returns focus to Publish on Escape", async () => {
		const user = userEvent.setup();
		render(<PublishHarness />);
		const publish = screen.getByRole("button", { name: "Publish" });

		await user.click(publish);
		const close = screen.getByRole("button", { name: "Close publish panel" });
		const signIn = screen.getByRole("button", { name: "Sign in" });
		await waitFor(() => expect(document.activeElement).toBe(close));
		expect(screen.getByRole("main")).toBeTruthy();
		expect(screen.getByRole("complementary")).toBeTruthy();

		await user.click(signIn);
		expect(screen.getByRole("main")).toBeTruthy();
		await user.keyboard("{Escape}");

		await waitFor(() => expect(screen.queryByRole("dialog", { name: "Publish site" })).toBeNull());
		await waitFor(() => expect(document.activeElement).toBe(publish));
		expect(screen.getByRole("main")).toBeTruthy();
		expect(screen.getByRole("complementary")).toBeTruthy();
	});
});
