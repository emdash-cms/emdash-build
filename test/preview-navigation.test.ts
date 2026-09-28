import { describe, expect, it, vi } from "vitest";
import {
	hasNegotiatedVary,
	isPreviewContentMutation,
	isShareablePreviewResponse,
	settleWithin,
	staleRevalidationAction,
} from "../src/worker/preview-cache.js";
import {
	enableLocalPreviewEditorSessionCookie,
	previewBridgeScript,
	previewParentOrigin,
	previewSnapshotState,
} from "../src/worker/preview-bridge.js";
import {
	mergePreviewRoutes,
	normalizePreviewPath,
	parsePreviewBridgeMessage,
	sortPreviewRoutes,
} from "../src/shared/preview-navigation.js";

describe("preview path normalization", () => {
	it("keeps same-origin paths and rejects escapes", () => {
		expect(normalizePreviewPath("about")).toBe("/about");
		expect(normalizePreviewPath(" /blog?page=2#top ")).toBe("/blog?page=2#top");
		expect(normalizePreviewPath("//evil.test/x")).toBeNull();
		expect(normalizePreviewPath("https://evil.test/x")).toBeNull();
		expect(normalizePreviewPath("https://p.test/a", "https://p.test")).toBe("/a");
		expect(normalizePreviewPath("https://evil.test/a", "https://p.test")).toBeNull();
		expect(normalizePreviewPath("/a\\b")).toBeNull();
		expect(normalizePreviewPath(42)).toBeNull();
	});
});

describe("preview bridge messages", () => {
	it("validates bridge state and drops admin links", () => {
		expect(parsePreviewBridgeMessage({ type: "state", path: "/" })).toBeNull();
		expect(
			parsePreviewBridgeMessage({ source: "emdash-preview", type: "navigating", path: "/work" }),
		).toEqual({ type: "navigating", path: "/work" });
		expect(
			parsePreviewBridgeMessage({
				source: "emdash-preview",
				type: "state",
				path: "/about",
				title: "  About\n us ",
				snapshot: "bogus",
				links: [{ path: "/_emdash/admin" }, { path: "/work#x", label: "Work" }, "junk"],
			}),
		).toEqual({
			type: "state",
			path: "/about",
			title: "About us",
			snapshot: "live",
			links: [{ path: "/work", label: "Work" }],
		});
	});

	it("merges routes without replacing a known label", () => {
		const first = mergePreviewRoutes(new Map(), { path: "/about#x", title: "About" }, [
			{ path: "/contact" },
		]);
		const second = mergePreviewRoutes(first, { path: "/contact", title: "Contact us" }, [
			{ path: "/about", label: "Ignored" },
		]);
		expect(sortPreviewRoutes([...second.values(), { path: "/" }])).toEqual([
			{ path: "/" },
			{ path: "/about", label: "About" },
			{ path: "/contact", label: "Contact us" },
		]);
	});
});

describe("preview bridge injection helpers", () => {
	it("makes only localhost editor sessions usable in the embedded preview", () => {
		const headers = new Headers();
		headers.append("Set-Cookie", "astro-session=session; Path=/; HttpOnly; SameSite=Lax");
		headers.append("Set-Cookie", "__em_d1_bookmark=bookmark; Path=/; HttpOnly; SameSite=Lax");
		enableLocalPreviewEditorSessionCookie(
			new Request("http://4321-project-token.localhost:5175/_emdash/api/auth/dev-bypass"),
			headers,
		);
		expect(headers.getSetCookie()).toEqual([
			"astro-session=session; Path=/; HttpOnly; SameSite=None; Secure",
			"__em_d1_bookmark=bookmark; Path=/; HttpOnly; SameSite=Lax",
		]);

		const production = new Headers({ "Set-Cookie": "astro-session=session; SameSite=Lax" });
		enableLocalPreviewEditorSessionCookie(
			new Request("https://4321-project-token.build.emdashcms.com/_emdash/api/auth/dev-bypass"),
			production,
		);
		expect(production.getSetCookie()).toEqual(["astro-session=session; SameSite=Lax"]);
	});

	it("derives the framing app origin from the preview host", () => {
		expect(
			previewParentOrigin(
				new URL("https://4321-abc-tok.preview.build.example.com/x"),
				"build.example.com",
			),
		).toBe("https://build.example.com");
		expect(previewParentOrigin(new URL("https://4321-abc-tok.build.emdashcms.com/x"))).toBe(
			"https://build.emdashcms.com",
		);
		expect(
			previewParentOrigin(new URL("http://4321-abc-tok.localhost:5173/"), "build.example.com"),
		).toBe("http://localhost:5173");
		expect(
			previewParentOrigin(new URL("http://4321-abc-tok.team.localhost:5173/"), "build.example.com"),
		).toBe("http://team.localhost:5173");
		expect(previewParentOrigin(new URL("https://build.emdashcms.com/"))).toBeNull();
	});

	it("reports snapshot state and escapes the inline config", () => {
		expect(previewSnapshotState("HIT")).toBe("cached");
		expect(previewSnapshotState("STALE")).toBe("stale");
		expect(previewSnapshotState(null)).toBe("live");
		const script = previewBridgeScript({
			parentOrigin: "https://a.test</script>",
			snapshot: "live",
		});
		expect(script.match(/<\/script>/g)).toHaveLength(1);
		expect(script).toContain("\\u003c/script>");
	});

	it("returns a top-level authenticated preview to the validated builder project", () => {
		const replace = vi.fn();
		const windowObject: { parent?: unknown; __emdashPreviewBridge?: boolean } = {};
		windowObject.parent = windowObject;
		const script = previewBridgeScript({
			parentOrigin: "https://build.emdashcms.com",
			snapshot: "live",
			editorReturnUrl: "https://build.emdashcms.com/s/11111111-1111-4111-8111-111111111111",
		});
		const body = script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>"));
		new Function("window", "location", body)(windowObject, { replace });
		expect(replace).toHaveBeenCalledWith(
			"https://build.emdashcms.com/s/11111111-1111-4111-8111-111111111111",
		);
	});
});

describe("preview cache freshness", () => {
	it("invalidates snapshots on CMS writes but not MCP or auth traffic", () => {
		const request = (method: string, path: string) =>
			new Request(`https://4321-a-b.example.test${path}`, { method });
		expect(isPreviewContentMutation(request("POST", "/_emdash/api/content/posts"))).toBe(true);
		expect(isPreviewContentMutation(request("DELETE", "/_emdash/api/media/1"))).toBe(true);
		expect(isPreviewContentMutation(request("POST", "/_emdash/api/mcp"))).toBe(false);
		expect(isPreviewContentMutation(request("POST", "/_emdash/api/auth/login"))).toBe(false);
		expect(isPreviewContentMutation(request("GET", "/_emdash/api/content/posts"))).toBe(false);
		expect(isPreviewContentMutation(request("POST", "/contact"))).toBe(false);
	});

	it("only seeds shared snapshots from non-variant, credential-free responses", () => {
		const page = (headers: Record<string, string> = {}) =>
			new Response("ok", { headers: { "Content-Type": "text/html", ...headers } });
		const plain = new Request("https://4321-a-b.example.test/about");
		const withCookie = new Request(plain, { headers: { Cookie: "emdash_session=1" } });
		const withAuth = new Request(plain, { headers: { Authorization: "Bearer x" } });
		expect(isShareablePreviewResponse(plain, page())).toBe(true);
		expect(isShareablePreviewResponse(plain, page({ Vary: "Accept-Encoding" }))).toBe(true);
		expect(isShareablePreviewResponse(plain, page({ Vary: "Accept-Language" }))).toBe(false);
		expect(isShareablePreviewResponse(plain, page({ Vary: "*" }))).toBe(false);
		expect(isShareablePreviewResponse(withCookie, page())).toBe(false);
		expect(isShareablePreviewResponse(withAuth, page())).toBe(false);
	});

	it("treats any negotiated Vary as uncacheable, whoever rendered it", () => {
		const page = (vary?: string) => new Response("ok", { headers: vary ? { Vary: vary } : {} });
		expect(hasNegotiatedVary(page())).toBe(false);
		expect(hasNegotiatedVary(page("Accept-Encoding"))).toBe(false);
		expect(hasNegotiatedVary(page(" accept-encoding , "))).toBe(false);
		expect(hasNegotiatedVary(page("Accept-Encoding, Accept-Language"))).toBe(true);
		expect(hasNegotiatedVary(page("Cookie"))).toBe(true);
		expect(hasNegotiatedVary(page("*"))).toBe(true);
	});

	it("serves fresh renders, live removed routes, and the last good snapshot otherwise", () => {
		const done = (value: { success: boolean; status?: number; invalidHtml?: boolean }) =>
			({ status: "fulfilled", value }) as const;
		expect(staleRevalidationAction(done({ success: true, status: 200 }))).toBe("serve-fresh");
		expect(staleRevalidationAction(done({ success: false, status: 404 }))).toBe("serve-live");
		expect(staleRevalidationAction(done({ success: false, status: 301 }))).toBe("serve-live");
		expect(staleRevalidationAction(done({ success: false, status: 500 }))).toBe("serve-stale");
		expect(staleRevalidationAction(done({ success: false, status: 200, invalidHtml: true }))).toBe(
			"serve-stale",
		);
		expect(staleRevalidationAction(done({ success: false }))).toBe("serve-stale");
		expect(staleRevalidationAction({ status: "timeout" })).toBe("serve-stale");
		expect(staleRevalidationAction({ status: "rejected", reason: new Error("x") })).toBe(
			"serve-stale",
		);
	});

	it("bounds the wait without cancelling the work", async () => {
		const slow = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 30));
		expect(await settleWithin(slow, 5)).toEqual({ status: "timeout" });
		expect(await slow).toBe("done");
		expect(await settleWithin(Promise.resolve(1), 50)).toEqual({ status: "fulfilled", value: 1 });
	});
});
