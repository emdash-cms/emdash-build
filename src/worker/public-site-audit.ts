const AUDIT_ORIGIN = "http://public-site.local";
const DEFAULT_MAX_ROUTES = 50;
const DEFAULT_MAX_HTML_BYTES = 512 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;
const IGNORED_PATH_PREFIXES = ["/_emdash", "/_astro/", "/@vite/", "/node_modules/"];
const DISPOSE_SYMBOL = (Symbol as typeof Symbol & { readonly dispose?: symbol }).dispose;

/**
 * A request that found the site's container stopped ran nothing, and is no
 * site defect. (The smoke runner loads this module alone, so the check from
 * sandbox-ops is repeated here.)
 */
function isSandboxNotRunning(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error)).startsWith("SANDBOX_NOT_RUNNING");
}

export function isCompletePublicHtml(html: string): boolean {
	const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
	const visibleText = body?.[1]
		?.replace(/<!--[^]*?-->/g, "")
		.replace(/<(script|style|template|noscript)\b[^>]*>[^]*?<\/\1>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&(?:nbsp|#160|#x[aA]0);/gi, "")
		.trim();
	return Boolean(/<html\b/i.test(html) && /<\/html>\s*$/i.test(html) && visibleText);
}

export type PublicSiteAuditIssueReason =
	| "request-failed"
	| "http-status"
	| "redirect-missing-location"
	| "redirect-loop"
	| "too-many-redirects"
	| "html-too-large"
	| "non-html-root"
	| "non-html-route"
	| "empty-html"
	| "truncated-html"
	| "missing-block-renderer"
	| "scaffold-placeholder"
	| "route-limit-exceeded"
	| "request-limit-exceeded";

export interface PublicSiteAuditIssue {
	path: string;
	reason: PublicSiteAuditIssueReason;
	status?: number;
	detail?: string;
}

export interface PublicSiteAuditResult {
	success: boolean;
	checkedPaths: string[];
	issues: PublicSiteAuditIssue[];
}

export interface PublicSiteAuditOptions {
	maxRoutes?: number;
	maxRequests?: number;
	maxHtmlBytes?: number;
	maxRedirects?: number;
	sameSiteOrigins?: string[];
	rejectNonHtmlRoutes?: boolean;
	allowNonHtmlRoute?: (path: string, contentType: string) => boolean | Promise<boolean>;
	capture?: (capture: PublicSiteAuditCapture) => void | Promise<void>;
}

export type PublicSiteAuditCapture =
	| { kind: "redirect"; path: string; status: number; location: string }
	| { kind: "html"; path: string; status: number; html: string };

export type PublicSiteFetch = (path: string) => Promise<Response>;

function decodeHtmlAttribute(value: string): string {
	return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|quot|apos);/gi, (entity, decimal, hex) => {
		if (decimal) return String.fromCodePoint(Number(decimal));
		if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
		return entity.toLowerCase() === "&amp;" ? "&" : entity.toLowerCase() === "&quot;" ? '"' : "'";
	});
}

function sitePath(
	href: string,
	fromPath: string,
	sameSiteOrigins: ReadonlySet<string>,
): string | undefined {
	let target: URL;
	try {
		target = new URL(decodeHtmlAttribute(href), new URL(fromPath, AUDIT_ORIGIN));
	} catch {
		return undefined;
	}
	if (target.origin !== AUDIT_ORIGIN && !sameSiteOrigins.has(target.origin)) return undefined;
	if (IGNORED_PATH_PREFIXES.some((prefix) => target.pathname.startsWith(prefix))) {
		return undefined;
	}
	target.hash = "";
	return `${target.pathname}${target.search}`;
}

function extractSiteLinks(
	html: string,
	fromPath: string,
	sameSiteOrigins: ReadonlySet<string>,
): string[] {
	const links: string[] = [];
	const seen = new Set<string>();
	const anchor = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
	for (const match of html.matchAll(anchor)) {
		const path = sitePath(match[1] ?? match[2] ?? "", fromPath, sameSiteOrigins);
		if (!path || seen.has(path)) continue;
		seen.add(path);
		links.push(path);
	}
	return links;
}

function containsScaffoldPlaceholder(html: string): boolean {
	const normalized = html.toLowerCase().replace(/\s+/g, " ");
	const unchangedBody = [
		"your site is taking shape.",
		"the builder is designing the content model, pages, and visual system from your brief.",
	].every((marker) => normalized.includes(marker));
	return unchangedBody || /<title[^>]*>\s*new emdash site\b/i.test(html);
}

function missingBlockRenderer(html: string): string | undefined {
	const match = /\bdata-emdash-missing-block\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(html);
	return match ? decodeHtmlAttribute(match[1] ?? match[2] ?? match[3] ?? "unknown") : undefined;
}

function errorDetail(body: string): string | undefined {
	const marker = "const error = ";
	const start = body.indexOf(marker);
	if (start >= 0) {
		const end = body.indexOf("\n", start);
		try {
			const error = JSON.parse(
				body
					.slice(start + marker.length, end >= 0 ? end : undefined)
					.trim()
					.replace(/;$/, ""),
			) as { message?: unknown; stack?: unknown };
			const detail = [error.message, error.stack]
				.filter((value): value is string => typeof value === "string" && Boolean(value))
				.join("\n");
			if (detail) return detail.slice(0, 4000);
		} catch {
			// Fall through to visible text for other error-page formats.
		}
	}
	const detail = body
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return detail ? detail.slice(0, 4000) : undefined;
}

async function readHtml(response: Response, maximumBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
		throw new Error(`HTML exceeds ${maximumBytes} bytes.`);
	}
	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let html = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maximumBytes) {
				await reader.cancel();
				throw new Error(`HTML exceeds ${maximumBytes} bytes.`);
			}
			html += decoder.decode(value, { stream: true });
		}
		html += decoder.decode();
		return html;
	} finally {
		reader.releaseLock();
	}
}

function disposeResponse(response: Response): void {
	if (!DISPOSE_SYMBOL) return;
	const dispose = (response as Response & { [key: symbol]: unknown })[DISPOSE_SYMBOL];
	if (typeof dispose !== "function") return;
	try {
		dispose.call(response);
	} catch {
		// Best-effort cleanup for an RPC response already disposed by its transport.
	}
}

async function discardResponse(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The transport may already have closed an empty/error response body.
	} finally {
		disposeResponse(response);
	}
}

/**
 * Check the rendered public site instead of trusting source/type validation
 * alone. The crawl is discovered from same-origin anchors and bounded only to
 * protect the Worker from an accidentally infinite site graph.
 */
export async function auditPublicSite(
	fetchPage: PublicSiteFetch,
	options: PublicSiteAuditOptions = {},
): Promise<PublicSiteAuditResult> {
	const maxRoutes = options.maxRoutes ?? DEFAULT_MAX_ROUTES;
	const maxRequests = options.maxRequests ?? maxRoutes;
	const maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
	const sameSiteOrigins = new Set(options.sameSiteOrigins ?? []);
	const rejectNonHtmlRoutes = options.rejectNonHtmlRoutes ?? false;
	const capture = options.capture;
	const queue = ["/"];
	const queued = new Set(queue);
	const checked = new Set<string>();
	const routes = new Set<string>();
	const checkedPaths: string[] = [];
	const issues: PublicSiteAuditIssue[] = [];

	while (queue.length > 0) {
		if (checkedPaths.length >= maxRequests) {
			issues.push({
				path: queue[0]!,
				reason: "request-limit-exceeded",
				detail: `More than ${maxRequests} public links were reachable.`,
			});
			break;
		}

		const requestedPath = queue.shift()!;
		if (checked.has(requestedPath)) continue;
		let currentPath = requestedPath;
		const redirects = new Set([currentPath]);
		let response: Response | undefined;
		let externalRedirect = false;

		for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
			if (!checked.has(currentPath)) {
				checked.add(currentPath);
				checkedPaths.push(currentPath);
			}
			try {
				response = await fetchPage(currentPath);
			} catch (error) {
				if (isSandboxNotRunning(error)) throw error;
				issues.push({
					path: currentPath,
					reason: "request-failed",
					detail: error instanceof Error ? error.message : String(error),
				});
				response = undefined;
				break;
			}

			if (response.status < 300 || response.status >= 400) break;
			const location = response.headers.get("Location");
			if (!location) {
				issues.push({
					path: currentPath,
					reason: "redirect-missing-location",
					status: response.status,
				});
				await discardResponse(response);
				response = undefined;
				break;
			}
			if (!routes.has(currentPath)) {
				if (routes.size >= maxRoutes) {
					issues.push({
						path: currentPath,
						reason: "route-limit-exceeded",
						detail: `More than ${maxRoutes} rendered routes were reachable.`,
					});
					await discardResponse(response);
					response = undefined;
					break;
				}
				routes.add(currentPath);
			}
			await capture?.({ kind: "redirect", path: currentPath, status: response.status, location });
			const redirectedPath = sitePath(location, currentPath, sameSiteOrigins);
			if (!redirectedPath) {
				await discardResponse(response);
				externalRedirect = true;
				break;
			}
			if (redirects.has(redirectedPath)) {
				issues.push({ path: currentPath, reason: "redirect-loop" });
				await discardResponse(response);
				response = undefined;
				break;
			}
			await discardResponse(response);
			redirects.add(redirectedPath);
			currentPath = redirectedPath;
			if (redirectCount === maxRedirects) {
				issues.push({ path: requestedPath, reason: "too-many-redirects" });
				response = undefined;
			}
		}

		if (!response || externalRedirect) continue;
		if (!response.ok) {
			let detail = currentPath !== requestedPath ? `Redirected to ${currentPath}.` : undefined;
			if (response.status >= 500) {
				try {
					detail = errorDetail(await readHtml(response, maxHtmlBytes));
				} catch (error) {
					if (isSandboxNotRunning(error)) throw error;
					detail = error instanceof Error ? error.message : String(error);
				} finally {
					disposeResponse(response);
				}
			} else {
				await discardResponse(response);
			}
			issues.push({
				path: requestedPath,
				reason: "http-status",
				status: response.status,
				...(detail ? { detail } : {}),
			});
			continue;
		}

		const contentType = response.headers.get("Content-Type") ?? "";
		if (!contentType.toLowerCase().includes("text/html")) {
			const allowed = Boolean(
				requestedPath !== "/" && (await options.allowNonHtmlRoute?.(requestedPath, contentType)),
			);
			if (requestedPath === "/" || (rejectNonHtmlRoutes && !allowed)) {
				issues.push({
					path: requestedPath,
					reason: requestedPath === "/" ? "non-html-root" : "non-html-route",
					detail:
						requestedPath === "/" ? undefined : `Returned ${contentType || "an unknown type"}.`,
				});
			}
			await discardResponse(response);
			continue;
		}
		if (!routes.has(currentPath)) {
			if (routes.size >= maxRoutes) {
				issues.push({
					path: currentPath,
					reason: "route-limit-exceeded",
					detail: `More than ${maxRoutes} rendered routes were reachable.`,
				});
				await discardResponse(response);
				continue;
			}
			routes.add(currentPath);
		}

		let html: string;
		try {
			html = await readHtml(response, maxHtmlBytes);
		} catch (error) {
			issues.push({
				path: currentPath,
				reason: "html-too-large",
				detail: error instanceof Error ? error.message : String(error),
			});
			continue;
		} finally {
			disposeResponse(response);
		}
		if (!html.trim()) {
			issues.push({ path: currentPath, reason: "empty-html" });
			continue;
		}
		if (!isCompletePublicHtml(html)) {
			issues.push({ path: currentPath, reason: "truncated-html" });
			continue;
		}
		const missingBlock = missingBlockRenderer(html);
		if (missingBlock) {
			issues.push({ path: currentPath, reason: "missing-block-renderer", detail: missingBlock });
		}
		if (requestedPath === "/" && containsScaffoldPlaceholder(html)) {
			issues.push({ path: "/", reason: "scaffold-placeholder" });
		}
		await capture?.({ kind: "html", path: currentPath, status: response.status, html });
		for (const path of extractSiteLinks(html, currentPath, sameSiteOrigins)) {
			if (checked.has(path) || queued.has(path)) continue;
			queued.add(path);
			queue.push(path);
		}
	}

	return { success: issues.length === 0, checkedPaths, issues };
}
