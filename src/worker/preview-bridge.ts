import { PREVIEW_EDITOR_RETURN_PARAM, type PreviewSnapshot } from "../shared/preview-navigation.js";

/**
 * The preview is cross-origin to the builder app, so the app cannot read the
 * iframe's location. The Worker injects this small script into proxied HTML
 * so the page reports its path, title and same-origin links to the parent,
 * and accepts a reload command from it. It is added after the Sandbox cache,
 * so it never enters snapshots, the Artifacts repo, or deployed sites.
 */
const BRIDGE_SCRIPT = `(function () {
	var config = __CONFIG__;
	var w = window;
	if (w.parent === w) {
		if (config.editorReturnUrl) location.replace(config.editorReturnUrl);
		return;
	}
	if (w.__emdashPreviewBridge) return;
	w.__emdashPreviewBridge = true;
	var skip = /^\\/(_emdash|_astro|_image|@|node_modules|src)(\\/|$)/;
	function links() {
		var seen = {};
		var out = [];
		var anchors = document.querySelectorAll("a[href]");
		for (var i = 0; i < anchors.length && out.length < 100; i++) {
			var url;
			try { url = new URL(anchors[i].href, location.href); } catch (e) { continue; }
			if (url.origin !== location.origin || skip.test(url.pathname)) continue;
			if (/\\.[a-z0-9]+$/i.test(url.pathname) && !/\\.html?$/i.test(url.pathname)) continue;
			var path = url.pathname + url.search;
			if (seen[path]) continue;
			seen[path] = true;
			out.push({ path: path, label: (anchors[i].textContent || "").trim().slice(0, 80) });
		}
		return out;
	}
	function post(type, withLinks) {
		var message = {
			source: "emdash-preview",
			type: type,
			path: location.pathname + location.search + location.hash,
			title: document.title,
			snapshot: config.snapshot
		};
		if (withLinks) message.links = links();
		try { w.parent.postMessage(message, config.parentOrigin); } catch (e) {}
	}
	function report() { post("state", document.readyState !== "loading"); }
	["pushState", "replaceState"].forEach(function (name) {
		var original = history[name];
		history[name] = function () {
			var result = original.apply(this, arguments);
			report();
			return result;
		};
	});
	w.addEventListener("popstate", report);
	w.addEventListener("hashchange", report);
	w.addEventListener("pageshow", report);
	w.addEventListener("load", report);
	document.addEventListener("DOMContentLoaded", report);
	document.addEventListener("astro:page-load", report);
	w.addEventListener("beforeunload", function () { post("navigating", false); });
	w.addEventListener("message", function (event) {
		if (event.origin !== config.parentOrigin || event.source !== w.parent) return;
		var data = event.data;
		if (!data || data.source !== "emdash-build" || data.type !== "command") return;
		if (data.command === "reload") location.reload();
	});
	if (config.localEditorCookies) {
		document.addEventListener("change", function (event) {
			if (!event.target || event.target.id !== "emdash-edit-toggle") return;
			document.cookie = event.target.checked
				? "emdash-edit-mode=true;path=/;samesite=none;secure"
				: "emdash-edit-mode=;path=/;expires=Thu, 01 Jan 1970 00:00:00 GMT;samesite=none;secure";
		});
	}
	report();
})();`;

/** The configured Builder origin that frames a preview; localhost derives its current dev origin. */
export function previewParentOrigin(url: URL, appHostname?: string): string | null {
	const labels = url.hostname.split(".");
	if (labels.length < 2 || !/^\d{4,5}-/.test(labels[0] ?? "")) return null;
	const host = labels.slice(1).join(".");
	const derived = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
	if (host === "localhost" || host.endsWith(".localhost") || !appHostname) return derived;
	try {
		const configured = new URL(`https://${appHostname.trim().toLowerCase()}`);
		if (configured.pathname !== "/" || configured.search || configured.hash || configured.port) {
			return derived;
		}
		return configured.origin;
	} catch {
		return derived;
	}
}

export function previewSnapshotState(cacheHeader: string | null): PreviewSnapshot {
	if (cacheHeader === "HIT") return "cached";
	if (cacheHeader === "STALE") return "stale";
	return "live";
}

export function previewEditorReturnUrl(url: URL, parentOrigin: string): string | null {
	const returnPath = url.searchParams.get(PREVIEW_EDITOR_RETURN_PARAM);
	if (!returnPath) return null;
	try {
		const target = new URL(returnPath, parentOrigin);
		if (target.origin !== parentOrigin || !/^\/s\/[0-9a-f-]{36}$/i.test(target.pathname))
			return null;
		return target.href;
	} catch {
		return null;
	}
}

function preserveEditorReturnRedirect(
	url: URL,
	response: Response,
	parentOrigin: string,
): Response {
	const editorReturnUrl = previewEditorReturnUrl(url, parentOrigin);
	const location = response.headers.get("Location");
	if (!editorReturnUrl || !location) return response;
	let target: URL;
	try {
		target = new URL(location, url);
	} catch {
		return response;
	}
	if (target.origin !== url.origin) return response;
	const builderReturn = new URL(editorReturnUrl);
	target.searchParams.set(
		PREVIEW_EDITOR_RETURN_PARAM,
		`${builderReturn.pathname}${builderReturn.search}`,
	);
	const headers = new Headers(response.headers);
	headers.set("Location", target.href);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function previewBridgeScript(config: {
	parentOrigin: string;
	snapshot: PreviewSnapshot;
	localEditorCookies?: boolean;
	editorReturnUrl?: string | null;
}): string {
	const json = JSON.stringify(config).replace(/</g, "\\u003c");
	return `<script data-emdash-preview-bridge>${BRIDGE_SCRIPT.replace("__CONFIG__", json)}</script>`;
}

/** Add the navigation bridge to a proxied HTML document response. */
export function injectPreviewBridge(
	request: Request,
	response: Response,
	appHostname?: string,
): Response {
	const url = new URL(request.url);
	const parentOrigin = previewParentOrigin(url, appHostname);
	if (!parentOrigin) return response;
	const editorReturnUrl =
		request.method === "GET" ? previewEditorReturnUrl(url, parentOrigin) : null;
	if (request.headers.get("Sec-Fetch-Dest") === "document" && !editorReturnUrl) {
		return new Response("Not found.", {
			status: 404,
			headers: {
				"Cache-Control": "no-store",
				"Content-Type": "text/plain; charset=utf-8",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}
	if (response.status >= 300 && response.status < 400)
		return preserveEditorReturnRedirect(url, response, parentOrigin);
	if (!response.body) return response;
	if (!response.headers.get("Content-Type")?.toLowerCase().includes("text/html")) return response;
	const headers = new Headers(response.headers);
	headers.set("Content-Security-Policy", "frame-ancestors 'self' " + parentOrigin);
	if (request.method !== "GET") {
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
	const script = previewBridgeScript({
		parentOrigin,
		snapshot: previewSnapshotState(response.headers.get("X-EmDash-Preview-Cache")),
		localEditorCookies: url.protocol === "http:" && url.hostname.endsWith(".localhost"),
		editorReturnUrl,
	});
	headers.delete("Content-Length");
	let injected = false;
	return new HTMLRewriter()
		.on("head", {
			element(element) {
				if (injected) return;
				injected = true;
				element.prepend(script, { html: true });
			},
		})
		.onDocument({
			end(end) {
				if (!injected) end.append(script, { html: true });
			},
		})
		.transform(
			new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			}),
		);
}

export function enableLocalPreviewEditorSessionCookie(request: Request, headers: Headers): void {
	const url = new URL(request.url);
	if (url.protocol !== "http:" || !url.hostname.endsWith(".localhost")) return;
	const cookies = headers.getSetCookie();
	if (!cookies.some((cookie) => cookie.startsWith("astro-session="))) return;
	headers.delete("Set-Cookie");
	for (const cookie of cookies) {
		if (!cookie.startsWith("astro-session=")) {
			headers.append("Set-Cookie", cookie);
			continue;
		}
		const sameSiteNone = /;\s*SameSite=/i.test(cookie)
			? cookie.replace(/;\s*SameSite=[^;]*/i, "; SameSite=None")
			: `${cookie}; SameSite=None`;
		headers.append(
			"Set-Cookie",
			/;\s*Secure(?:;|$)/i.test(sameSiteNone) ? sameSiteNone : `${sameSiteNone}; Secure`,
		);
	}
}
