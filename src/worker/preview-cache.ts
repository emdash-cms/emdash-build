import { PREVIEW_PROXY_HEADER } from "./preview-router.js";

/** Select only public HTML document routes for last-known-good preview caching. */
export function previewDocumentKey(request: Request): string | undefined {
	if (request.method !== "GET" && request.method !== "HEAD") return undefined;
	if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return undefined;
	const url = new URL(request.url);
	if (
		url.pathname.startsWith("/_emdash/") ||
		// Astro's per-request endpoints answer with fragments or data, never a page.
		url.pathname.startsWith("/_server-islands/") ||
		url.pathname.startsWith("/_actions/") ||
		url.pathname.startsWith("/@") ||
		url.pathname.startsWith("/src/") ||
		url.pathname.startsWith("/node_modules/") ||
		url.pathname.startsWith("/_image")
	) {
		return undefined;
	}
	const destination = request.headers.get("Sec-Fetch-Dest");
	const accept = request.headers.get("Accept") ?? "";
	const lastSegment = url.pathname.split("/").at(-1) ?? "";
	const looksLikeRoute = !lastSegment.includes(".");
	if (destination !== "document" && !accept.includes("text/html") && !looksLikeRoute) {
		return undefined;
	}
	return `${url.pathname}${url.search}`;
}

export function preventPreviewErrorCaching(request: Request, response: Response): Response {
	if (
		request.headers.get(PREVIEW_PROXY_HEADER) !== "1" ||
		request.headers.get("Upgrade")?.toLowerCase() === "websocket" ||
		response.status < 400
	) {
		return response;
	}
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * CMS writes made through the preview origin (the Admin tab, media uploads)
 * can change any rendered page. Agent MCP mutations are refreshed explicitly
 * by the agent, and MCP reads are also POSTs, so MCP is excluded.
 */
export function isPreviewContentMutation(request: Request): boolean {
	if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
	const { pathname } = new URL(request.url);
	return (
		pathname.startsWith("/_emdash/api/") &&
		!pathname.startsWith("/_emdash/api/mcp") &&
		!pathname.startsWith("/_emdash/api/auth/")
	);
}

/**
 * A response negotiated on request headers (anything beyond Accept-Encoding)
 * has no single correct body per path, so it must never become a snapshot,
 * however it was rendered. Such routes are always served live.
 */
export function hasNegotiatedVary(response: Response): boolean {
	const vary = response.headers.get("Vary");
	if (!vary) return false;
	return vary
		.split(",")
		.map((header) => header.trim().toLowerCase())
		.some((header) => header !== "" && header !== "accept-encoding");
}

/**
 * Whether someone is loading the response as a page: a navigation, or a
 * client without fetch metadata asking for HTML. A page's script fetching a
 * fragment is not, so a fragment is not refused as an incomplete page.
 */
export function isPageNavigation(request: Request): boolean {
	const destination = request.headers.get("Sec-Fetch-Dest");
	if (destination) return ["document", "iframe", "frame"].includes(destination);
	return (request.headers.get("Accept") ?? "").includes("text/html");
}

export function isCredentialedPreviewRequest(request: Request): boolean {
	return request.headers.has("Cookie") || request.headers.has("Authorization");
}

/**
 * Snapshots are keyed by path alone and shared by every viewer, so a browser
 * response may only seed one when it cannot be a per-viewer variant.
 */
export function isShareablePreviewResponse(request: Request, response: Response): boolean {
	return !isCredentialedPreviewRequest(request) && !hasNegotiatedVary(response);
}

export type Settled<T> =
	| { status: "fulfilled"; value: T }
	| { status: "rejected"; reason: unknown }
	| { status: "timeout" };

/** Wait at most `ms` for a promise without cancelling it. */
export function settleWithin<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise.then(
			(value) => ({ status: "fulfilled", value }) as const,
			(reason: unknown) => ({ status: "rejected", reason }) as const,
		),
		new Promise<Settled<T>>((resolve) => {
			timer = setTimeout(() => resolve({ status: "timeout" }), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * Decide what to serve after re-rendering a snapshot older than the latest
 * mutation. A stored render is served from the cache; a route that now
 * redirects, 404s or is not HTML is served live (its row was dropped); a
 * slow, failed or erroring render falls back to the last good snapshot.
 */
export function staleRevalidationAction(
	result: Settled<{ success: boolean; status?: number; invalidHtml?: boolean }>,
): "serve-fresh" | "serve-live" | "serve-stale" {
	if (result.status !== "fulfilled") return "serve-stale";
	if (result.value.success) return "serve-fresh";
	if (result.value.invalidHtml) return "serve-stale";
	const status = result.value.status;
	if (status === undefined || status >= 500) return "serve-stale";
	return "serve-live";
}
