import {
	isPageNavigation,
	hasNegotiatedVary,
	isCredentialedPreviewRequest,
	isPreviewContentMutation,
	isShareablePreviewResponse,
	preventPreviewErrorCaching,
	previewDocumentKey,
	settleWithin,
	staleRevalidationAction,
} from "./preview-cache.js";
import {
	PREVIEW_PORT_HEADER,
	PREVIEW_PROXY_HEADER,
	PREVIEW_TOKEN_HEADER,
} from "./preview-router.js";
import { isCompletePublicHtml } from "./public-site-audit.js";

const MAX_CACHED_HTML_BYTES = 1024 * 1024;
const MAX_CACHED_ROUTES = 50;
const MAX_REFRESH_PATHS = 4;
/** How long a stale route waits for a live render before showing its last good snapshot. */
const STALE_REVALIDATE_WAIT_MS = 5000;
/** Secondary routes refreshed at a mutation boundary must not stall the agent's tool call. */
const SECONDARY_REFRESH_WAIT_MS = 8000;
const UNSAFE_CACHED_HEADERS = new Set([
	"content-encoding",
	"content-length",
	"server-timing",
	"transfer-encoding",
]);

interface CachedPreviewRow extends Record<string, SqlStorageValue> {
	status: number;
	status_text: string;
	headers_json: string;
	body: ArrayBuffer;
	generation: number;
	updated_at: number;
}

export interface PreviewRefreshResult {
	path: string;
	/** A snapshot was stored. */
	success: boolean;
	/** The route rendered as HTML, even if it could not be cached (e.g. negotiated Vary). */
	rendered?: boolean;
	status?: number;
	error?: string;
	invalidHtml?: boolean;
}

type RenderResult = Omit<PreviewRefreshResult, "path">;

export type PreviewSnapshotState = "current" | "stale" | "missing";

/** Whether HTML is (the start of) a whole page rather than a fragment. */
function isPageMarkup(html: string): boolean {
	return /<html[\s>]/i.test(html);
}

async function readBodyUpTo(
	response: Response,
	maximumBytes: number,
): Promise<ArrayBuffer | "too-large" | null> {
	// Not awaited: this is often one branch of a clone, whose cancel waits for the other.
	const drop = (cancel: () => Promise<void>) => void cancel().catch(() => undefined);
	const declaredLength = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
		if (response.body) drop(() => response.body!.cancel());
		return "too-large";
	}
	if (!response.body) return null;
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximumBytes) {
				drop(() => reader.cancel());
				return "too-large";
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (total === 0) return null;
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body.buffer;
}

function localPreviewPath(path: string): string | undefined {
	const target = new URL(path, "http://localhost:4321");
	if (target.origin !== "http://localhost:4321") return undefined;
	return `${target.pathname}${target.search}`;
}

/** What the snapshots need from the Sandbox Durable Object that holds them. */
export interface PreviewSnapshotHost {
	readonly sql: SqlStorage;
	waitUntil(promise: Promise<unknown>): void;
	/** The live dev server's response to a proxied preview request. */
	forwardLive(request: Request): Promise<Response>;
	/**
	 * A route rendered the way an anonymous visitor sees it, straight from the
	 * dev server. Snapshots are shared by every viewer of the preview URL, so
	 * they must never be built from a browser request carrying the editor's
	 * cookies or credentials.
	 */
	renderCanonical(cachePath: string): Promise<Response>;
	validatePortToken(port: number, token: string): Promise<boolean>;
}

/**
 * A durable last-known-good HTML view for public preview routes, kept in the
 * Sandbox Durable Object's SQLite. The live Astro runner remains authoritative
 * for CMS/API traffic. Each snapshot records the content generation it was
 * rendered at; mutations bump the generation so every other route revalidates
 * on its next visit instead of serving stale HTML indefinitely.
 */
export class PreviewSnapshots {
	private verifiedPreviewRows = new Map<string, number>();

	constructor(private readonly host: PreviewSnapshotHost) {
		const sql = host.sql;
		sql.exec(`
			CREATE TABLE IF NOT EXISTS builder_preview_cache (
				path TEXT PRIMARY KEY,
				status INTEGER NOT NULL,
				status_text TEXT NOT NULL,
				headers_json TEXT NOT NULL,
				body BLOB NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		const columns = sql
			.exec<{ name: string }>("PRAGMA table_info(builder_preview_cache)")
			.toArray();
		if (!columns.some((column) => column.name === "generation")) {
			// Rows written before generations existed may have been seeded from
			// credentialed browser requests, so none may survive even as a stale
			// fallback. Recovery and the next visit re-render them canonically.
			sql.exec("DELETE FROM builder_preview_cache");
			sql.exec(
				"ALTER TABLE builder_preview_cache ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
			);
		}
		sql.exec(
			"CREATE TABLE IF NOT EXISTS builder_preview_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
		);
	}

	private currentGeneration(): number {
		const row = this.host.sql
			.exec<{ value: number }>("SELECT value FROM builder_preview_meta WHERE key = 'generation'")
			.toArray()[0];
		return row?.value ?? 0;
	}

	getPreviewGeneration(): number {
		return this.currentGeneration();
	}

	/** Mark every snapshot stale at a builder mutation; renders follow separately. */
	invalidatePreviewSnapshots(): number {
		this.invalidatePreviews();
		return this.currentGeneration();
	}

	/** Mark every stored snapshot as older than the latest content change. */
	private invalidatePreviews(): void {
		this.host.sql.exec(
			`INSERT INTO builder_preview_meta (key, value) VALUES ('generation', 1)
			 ON CONFLICT(key) DO UPDATE SET value = value + 1`,
		);
	}

	private readCachedPreview(path: string): CachedPreviewRow | undefined {
		const row = this.host.sql
			.exec<CachedPreviewRow>(
				"SELECT status, status_text, headers_json, body, generation, updated_at FROM builder_preview_cache WHERE path = ?",
				path,
			)
			.toArray()[0];
		if (row && this.verifiedPreviewRows.get(path) !== row.updated_at) {
			if (!isCompletePublicHtml(new TextDecoder().decode(row.body))) {
				this.deleteCachedPreview(path, row.generation);
				return;
			}
			this.verifiedPreviewRows.set(path, row.updated_at);
		}
		return row;
	}

	private deleteCachedPreview(path: string, generation: number): void {
		this.verifiedPreviewRows.delete(path);
		this.host.sql.exec(
			"DELETE FROM builder_preview_cache WHERE path = ? AND generation <= ?",
			path,
			generation,
		);
	}

	/**
	 * Persist a render made at `generation`. A slower render from an older
	 * generation never replaces a snapshot from a newer one.
	 */
	private async storePreview(
		path: string,
		response: Response,
		generation: number,
	): Promise<"stored" | "invalid" | "fragment" | "uncacheable"> {
		if (!response.ok || !response.headers.get("Content-Type")?.includes("text/html")) {
			await response.body?.cancel().catch(() => undefined);
			return "uncacheable";
		}
		const body = await readBodyUpTo(response, MAX_CACHED_HTML_BYTES);
		if (body === "too-large") return "uncacheable";
		if (!body) return "invalid";
		const text = new TextDecoder().decode(body);
		if (!isCompletePublicHtml(text)) return isPageMarkup(text) ? "invalid" : "fragment";
		if (response.headers.has("Set-Cookie") || hasNegotiatedVary(response)) return "uncacheable";
		const headers = [...response.headers.entries()].filter(
			([name]) => !UNSAFE_CACHED_HEADERS.has(name.toLowerCase()),
		);
		const updatedAt = Date.now();
		this.host.sql.exec(
			`INSERT INTO builder_preview_cache
				(path, status, status_text, headers_json, body, updated_at, generation)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(path) DO UPDATE SET
				status = excluded.status,
				status_text = excluded.status_text,
				headers_json = excluded.headers_json,
				body = excluded.body,
				updated_at = excluded.updated_at,
				generation = excluded.generation
			 WHERE excluded.generation >= builder_preview_cache.generation`,
			path,
			response.status,
			response.statusText,
			JSON.stringify(headers),
			body,
			updatedAt,
			generation,
		);
		this.verifiedPreviewRows.set(path, updatedAt);
		this.host.sql.exec(
			`DELETE FROM builder_preview_cache
			 WHERE path NOT IN (
			SELECT path FROM builder_preview_cache ORDER BY updated_at DESC LIMIT ?
			 )`,
			MAX_CACHED_ROUTES,
		);
		if (this.verifiedPreviewRows.size > MAX_CACHED_ROUTES) this.verifiedPreviewRows.clear();
		return "stored";
	}

	private cachedResponse(row: CachedPreviewRow, head: boolean, state: "HIT" | "STALE"): Response {
		const headers = new Headers(JSON.parse(row.headers_json) as [string, string][]);
		headers.set("Cache-Control", "no-store");
		headers.set("Server-Timing", 'preview-cache;dur=0;desc="Last successful preview"');
		headers.set("X-EmDash-Preview-Cache", state);
		return new Response(head ? null : row.body, {
			status: row.status,
			statusText: row.status_text,
			headers,
		});
	}

	/** Whether a last-known-good response already exists for this route. */
	hasCachedPreview(path = "/"): boolean {
		const cachePath = localPreviewPath(path);
		return cachePath ? Boolean(this.readCachedPreview(cachePath)) : false;
	}

	/** Whether this route's snapshot reflects the latest content change (a cheap DO read). */
	previewSnapshotState(path = "/"): PreviewSnapshotState {
		const cachePath = localPreviewPath(path);
		const row = cachePath ? this.readCachedPreview(cachePath) : undefined;
		if (!row) return "missing";
		return row.generation >= this.currentGeneration() ? "current" : "stale";
	}

	/** In-flight canonical renders by path, with the generation each started at. */
	private refreshing = new Map<string, { generation: number; render: Promise<RenderResult> }>();

	/**
	 * Render and persist one public route directly from the dev server. One
	 * render per route at a time: the agent's mutation refresh, the toolbar's
	 * Reload and a stale page visit join a render that already reflects their
	 * generation. A caller needing a newer generation waits for the older
	 * render to finish instead of stacking a second render beside it.
	 */
	async refreshPreview(path = "/"): Promise<RenderResult> {
		const cachePath = localPreviewPath(path);
		if (!cachePath) return { success: false };
		const needed = this.currentGeneration();
		for (;;) {
			const pending = this.refreshing.get(cachePath);
			if (!pending) break;
			if (pending.generation >= needed) return pending.render;
			await pending.render.catch(() => undefined);
		}
		const generation = this.currentGeneration();
		const render = this.renderAndStore(cachePath, generation).finally(() => {
			if (this.refreshing.get(cachePath)?.render === render) this.refreshing.delete(cachePath);
		});
		this.refreshing.set(cachePath, { generation, render });
		// Callers bound their wait; the render must still finish and store.
		this.host.waitUntil(render.catch(() => undefined));
		return render;
	}

	private async renderAndStore(cachePath: string, generation: number): Promise<RenderResult> {
		const response = await this.host.renderCanonical(cachePath);
		const outcome = await this.storePreview(cachePath, response, generation);
		const rendered =
			outcome === "stored" ||
			(outcome === "uncacheable" &&
				response.ok &&
				Boolean(response.headers.get("Content-Type")?.includes("text/html")));
		const success = outcome === "stored";
		if (outcome === "uncacheable" && response.status < 500) {
			this.deleteCachedPreview(cachePath, generation);
		}
		return {
			success,
			rendered,
			status: response.status,
			...(outcome === "invalid" || outcome === "fragment"
				? { invalidHtml: true, error: "The public page returned empty or incomplete HTML." }
				: {}),
		};
	}

	/**
	 * Refresh the routes a user is looking at after a content or source change.
	 * With `invalidate`, every other snapshot is marked stale first. The first
	 * path is awaited fully; the rest render together within one bounded window
	 * so a slow route finishes in the background instead of stalling the caller.
	 */
	async refreshPreviews(
		paths: string[],
		options: { invalidate?: boolean } = {},
	): Promise<PreviewRefreshResult[]> {
		if (options.invalidate) this.invalidatePreviews();
		const targets = [
			...new Set(paths.map(localPreviewPath).filter((path): path is string => Boolean(path))),
		].slice(0, MAX_REFRESH_PATHS);
		const attempt = (path: string): Promise<PreviewRefreshResult> =>
			this.refreshPreview(path).then(
				(result) => ({ path, ...result }),
				(error: unknown) => ({
					path,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		const [first, ...rest] = targets;
		if (!first) return [];
		const results: PreviewRefreshResult[] = [await attempt(first)];
		if (rest.length === 0) return results;
		const slots: (PreviewRefreshResult | undefined)[] = rest.map(() => undefined);
		const secondary = Promise.all(
			rest.map((path, index) =>
				attempt(path).then((result) => {
					slots[index] = result;
				}),
			),
		);
		if ((await settleWithin(secondary, SECONDARY_REFRESH_WAIT_MS)).status === "timeout") {
			this.host.waitUntil(secondary);
		}
		rest.forEach((path, index) => {
			results.push(slots[index] ?? { path, success: false, error: "timed out" });
		});
		return results;
	}

	/**
	 * A snapshot older than the latest content change: re-render it (joining
	 * any in-flight render) for a bounded time. The render keeps running in
	 * the background on timeout and stores or drops the row when it lands.
	 */
	private async revalidate(
		request: Request,
		path: string,
		cached: CachedPreviewRow,
	): Promise<Response> {
		const refresh = this.refreshPreview(path);
		const settled = await settleWithin(refresh, STALE_REVALIDATE_WAIT_MS);
		if (settled.status === "timeout") this.host.waitUntil(refresh.catch(() => undefined));
		const action = staleRevalidationAction(settled);
		if (action === "serve-fresh") {
			// A write during the render leaves the new row already behind: label
			// it STALE so the preview keeps retrying instead of settling.
			const fresh = this.readCachedPreview(path);
			if (fresh) {
				const current = fresh.generation >= this.currentGeneration();
				return this.cachedResponse(fresh, false, current ? "HIT" : "STALE");
			}
		}
		if (action === "serve-stale") return this.cachedResponse(cached, false, "STALE");
		// The route moved, disappeared or stopped being HTML. Serve the real
		// proxied response so redirects and error pages keep public-host semantics.
		return preventPreviewErrorCaching(request, await this.host.forwardLive(request));
	}

	/** Serve a proxied preview request: snapshots for public HTML, the live dev server otherwise. */
	async fetch(request: Request): Promise<Response> {
		const proxied = request.headers.get(PREVIEW_PROXY_HEADER) === "1";
		if (proxied && isPreviewContentMutation(request)) {
			const response = await this.host.forwardLive(request);
			if (response.ok) this.invalidatePreviews();
			return preventPreviewErrorCaching(request, response);
		}

		const cachePath = proxied ? previewDocumentKey(request) : undefined;
		if (cachePath && !isCredentialedPreviewRequest(request)) {
			const port = Number(request.headers.get(PREVIEW_PORT_HEADER));
			const token = request.headers.get(PREVIEW_TOKEN_HEADER);
			if (Number.isInteger(port) && token && (await this.host.validatePortToken(port, token))) {
				const cached = this.readCachedPreview(cachePath);
				if (cached) {
					const head = request.method === "HEAD";
					if (cached.generation >= this.currentGeneration()) {
						return this.cachedResponse(cached, head, "HIT");
					}
					// A stale HEAD goes live below; only GET renders a replacement.
					if (!head) return this.revalidate(request, cachePath, cached);
				}
			}
		}

		const generation = this.currentGeneration();
		const response = await this.host.forwardLive(request);
		if (
			cachePath &&
			request.method === "GET" &&
			response.ok &&
			response.headers.get("Content-Type")?.includes("text/html")
		) {
			if (isShareablePreviewResponse(request, response)) {
				try {
					const stored = await this.storePreview(cachePath, response.clone(), generation);
					// A fragment a page fetches is fine; a cut-off page is not, however it is loaded.
					if (stored === "invalid" || (stored === "fragment" && isPageNavigation(request))) {
						await response.body?.cancel().catch(() => undefined);
						return new Response("Preview page is incomplete. Try again after the site is fixed.", {
							status: 503,
							headers: { "Cache-Control": "no-store" },
						});
					}
				} catch (error) {
					console.error("Could not inspect the public preview response:", error);
				}
			} else if (!isCredentialedPreviewRequest(request)) {
				const body = await readBodyUpTo(response.clone(), MAX_CACHED_HTML_BYTES);
				const text = body && body !== "too-large" ? new TextDecoder().decode(body) : "";
				if (
					body !== "too-large" &&
					!isCompletePublicHtml(text) &&
					(isPageMarkup(text) || isPageNavigation(request))
				) {
					await response.body?.cancel().catch(() => undefined);
					return new Response("Preview page is incomplete. Try again after the site is fixed.", {
						status: 503,
						headers: { "Cache-Control": "no-store" },
					});
				}
			} else if (
				isCredentialedPreviewRequest(request) &&
				!hasNegotiatedVary(response) &&
				!this.readCachedPreview(cachePath)
			) {
				// This response is per-viewer (e.g. the Admin tab's session cookie),
				// so seed the route from an anonymous render instead; otherwise it
				// would hit the slow dev server on every visit.
				this.host.waitUntil(this.refreshPreview(cachePath).catch(() => undefined));
			}
		}
		return preventPreviewErrorCaching(request, response);
	}
}
