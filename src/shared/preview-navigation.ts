/** Messages exchanged between the builder app and the script injected into preview pages. */

export const PREVIEW_BRIDGE_SOURCE = "emdash-preview";
export const PREVIEW_COMMAND_SOURCE = "emdash-build";
export const PREVIEW_EDITOR_RETURN_PARAM = "__emdash_build_return";
const MAX_PATH_LENGTH = 2048;
const MAX_LINKS = 100;

export type PreviewSnapshot = "cached" | "stale" | "live";

export interface PreviewLink {
	path: string;
	label?: string;
}

export type PreviewBridgeMessage =
	| {
			type: "state";
			path: string;
			title: string;
			snapshot: PreviewSnapshot;
			links?: PreviewLink[];
	  }
	| { type: "navigating"; path?: string };

export type PreviewCommand = "reload";

export function previewCommand(command: PreviewCommand) {
	return { source: PREVIEW_COMMAND_SOURCE, type: "command", command } as const;
}

/**
 * Normalize user or page input into a same-origin preview path. Returns
 * `null` for anything that would leave the preview origin.
 */
export function normalizePreviewPath(input: unknown, previewOrigin?: string): string | null {
	if (typeof input !== "string") return null;
	let value = input.trim();
	if (!value || value.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f\\]/.test(value))
		return null;
	const base = previewOrigin ?? "http://preview.invalid";
	if (/^https?:\/\//i.test(value)) {
		if (!previewOrigin) return null;
	} else if (!value.startsWith("/")) {
		value = `/${value}`;
	}
	let url: URL;
	try {
		url = new URL(value, base);
	} catch {
		return null;
	}
	if (url.origin !== new URL(base).origin) return null;
	return `${url.pathname}${url.search}${url.hash}`;
}

/** Path + query, without the fragment: the unit the server renders and caches. */
export function previewDocumentPath(path: string): string {
	const hash = path.indexOf("#");
	return hash === -1 ? path : path.slice(0, hash) || "/";
}

export function isAdminPreviewPath(path: string): boolean {
	return path === "/_emdash" || path.startsWith("/_emdash/");
}

function cleanText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim().slice(0, max);
	return text || undefined;
}

const MAX_KNOWN_ROUTES = 100;

/** Accumulate routes seen in page links and visits, keeping the first label found. */
export function mergePreviewRoutes(
	known: ReadonlyMap<string, PreviewLink>,
	visited: { path: string; title?: string },
	links: PreviewLink[] = [],
): Map<string, PreviewLink> {
	const next = new Map(known);
	const add = (path: string, label?: string) => {
		if (isAdminPreviewPath(path)) return;
		const existing = next.get(path);
		if (existing?.label || (existing && !label)) return;
		if (!existing && next.size >= MAX_KNOWN_ROUTES) return;
		next.set(path, { path, label });
	};
	add(previewDocumentPath(visited.path), visited.title);
	for (const link of links) add(link.path, link.label);
	return next;
}

/** "/" first, then alphabetical. */
export function sortPreviewRoutes(routes: Iterable<PreviewLink>): PreviewLink[] {
	return [...routes].sort((a, b) =>
		a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path),
	);
}

export function parsePreviewBridgeMessage(data: unknown): PreviewBridgeMessage | null {
	if (!data || typeof data !== "object") return null;
	const record = data as Record<string, unknown>;
	if (record.source !== PREVIEW_BRIDGE_SOURCE) return null;
	if (record.type === "navigating") {
		const path = normalizePreviewPath(record.path);
		return path ? { type: "navigating", path } : { type: "navigating" };
	}
	if (record.type !== "state") return null;
	const path = normalizePreviewPath(record.path);
	if (!path) return null;
	const snapshot =
		record.snapshot === "cached" || record.snapshot === "stale" ? record.snapshot : "live";
	const message: PreviewBridgeMessage = {
		type: "state",
		path,
		title: cleanText(record.title, 200) ?? "",
		snapshot,
	};
	if (Array.isArray(record.links)) {
		const links: PreviewLink[] = [];
		for (const link of record.links.slice(0, MAX_LINKS)) {
			if (!link || typeof link !== "object") continue;
			const linkPath = normalizePreviewPath((link as Record<string, unknown>).path);
			if (!linkPath || isAdminPreviewPath(linkPath)) continue;
			links.push({
				path: previewDocumentPath(linkPath),
				label: cleanText((link as Record<string, unknown>).label, 80),
			});
		}
		message.links = links;
	}
	return message;
}
