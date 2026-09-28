import { WFP_RELEASE_LIMITS } from "../platform/wfp-release.js";
import {
	auditPublicSite,
	type PublicSiteAuditCapture,
	type PublicSiteFetch,
} from "./public-site-audit.js";

const SNAPSHOT_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const NETWORK_PRIMITIVES = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/;
const PRIVATE_PATH_PREFIXES = ["/_emdash", "/api", "/@vite", "/node_modules", "/__vite"];
const PUBLIC_MEDIA_PREFIX = "/_emdash/api/media/file/";
const DISPOSE_SYMBOL = (Symbol as typeof Symbol & { readonly dispose?: symbol }).dispose;
const DEFAULT_LIMITS = {
	routes: 50,
	assets: WFP_RELEASE_LIMITS.assets,
	assetBytes: WFP_RELEASE_LIMITS.assetBytes,
	totalAssetBytes: WFP_RELEASE_LIMITS.totalAssetBytes,
};

export interface BuiltSnapshotAsset {
	bytes: Uint8Array;
	contentType: string;
}

export interface BuiltSnapshotAssetMetadata {
	byteLength: number;
	contentType: string;
}

export interface SnapshotAsset extends BuiltSnapshotAsset {
	path: string;
	digest: string;
}

export type SnapshotRoute =
	| { path: string; kind: "page"; assetPath: string }
	| { path: string; kind: "redirect"; status: number; location: string };

export interface SnapshotManifest {
	version: 1;
	routes: Array<
		| { path: string; kind: "page"; assetPath: string }
		| { path: string; kind: "redirect"; status: number; location: string }
	>;
	assets: Array<{ path: string; byteLength: number; contentType: string; digest: string }>;
}

export interface StaticSiteSnapshot {
	siteId: string;
	liveOrigin: string;
	releaseId: string;
	sourceRevision: string;
	routes: SnapshotRoute[];
	assets: SnapshotAsset[];
	manifest: SnapshotManifest;
}

export class StaticSiteSnapshotError extends Error {
	constructor(
		readonly code:
			| "SNAPSHOT_UNSUPPORTED"
			| "SNAPSHOT_TOO_LARGE"
			| "SITE_CHANGED_DURING_PUBLISH"
			| "SITE_NOT_READY",
		message: string,
	) {
		super(message);
		this.name = "StaticSiteSnapshotError";
	}
}

export interface CaptureStaticSiteSnapshotInput {
	siteId: string;
	previewOrigin: string;
	liveOrigin: string;
	fetch: PublicSiteFetch;
	inspectBuiltAsset: (path: string) => Promise<BuiltSnapshotAssetMetadata | undefined>;
	readBuiltAsset: (path: string, maximumBytes: number) => Promise<BuiltSnapshotAsset | undefined>;
	limits?: Partial<typeof DEFAULT_LIMITS>;
}

function unsupported(message: string): never {
	throw new StaticSiteSnapshotError("SNAPSHOT_UNSUPPORTED", message);
}

function tooLarge(message: string): never {
	throw new StaticSiteSnapshotError("SNAPSHOT_TOO_LARGE", message);
}

function canonicalUuid(value: string): string {
	const canonical = value.toLowerCase();
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(canonical)
	) {
		unsupported("The project identity is invalid.");
	}
	return canonical;
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return `sha256:${bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer)))}`;
}

function uuidBytes(value: string): Uint8Array {
	return Uint8Array.from(value.replaceAll("-", "").match(/.{2}/g) ?? [], (pair) =>
		Number.parseInt(pair, 16),
	);
}

async function uuidV5(name: string): Promise<string> {
	const namespace = uuidBytes(SNAPSHOT_NAMESPACE);
	const nameBytes = new TextEncoder().encode(name);
	const input = new Uint8Array(namespace.length + nameBytes.length);
	input.set(namespace);
	input.set(nameBytes, namespace.length);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
	const bytes = digest.slice(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytesToHex(bytes);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedOrigin(value: string, label: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		unsupported(`${label} is not a valid URL.`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") unsupported(`${label} must use HTTP.`);
	return url.origin;
}

function safePublicPath(pathname: string): string {
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		unsupported(`The site references an invalid URL path: ${pathname}`);
	}
	if (
		!decoded.startsWith("/") ||
		decoded.includes("\\") ||
		decoded.split("/").some((part) => part === "..")
	) {
		unsupported(`The site references an unsafe URL path: ${pathname}`);
	}
	return decoded;
}

function isPrivatePath(pathname: string): boolean {
	if (pathname.startsWith(PUBLIC_MEDIA_PREFIX)) return false;
	return PRIVATE_PATH_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

function decodedUrlValue(value: string): string {
	const decoded = value
		.trim()
		.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|quot|apos);/gi, (entity, decimal, hex) => {
			if (decimal) return String.fromCodePoint(Number(decimal));
			if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
			return entity.toLowerCase() === "&amp;" ? "&" : entity.toLowerCase() === "&quot;" ? '"' : "'";
		});
	const quote = decoded[0];
	return quote && (quote === '"' || quote === "'") && decoded.at(-1) === quote
		? decoded.slice(1, -1).trim()
		: decoded;
}

function allowedContentType(value: string): string | undefined {
	const contentType = value.split(";", 1)[0]?.trim().toLowerCase();
	if (!contentType) return;
	if (
		contentType.startsWith("text/") ||
		contentType.startsWith("image/") ||
		contentType.startsWith("font/") ||
		contentType.startsWith("audio/") ||
		contentType.startsWith("video/") ||
		[
			"application/javascript",
			"application/json",
			"application/wasm",
			"application/octet-stream",
			"application/xml",
			"application/pdf",
		].includes(contentType)
	) {
		return contentType;
	}
	return;
}

function extensionFor(contentType: string): string {
	const extensions: Record<string, string> = {
		"text/css": "css",
		"text/javascript": "js",
		"application/javascript": "js",
		"application/json": "json",
		"application/wasm": "wasm",
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
		"image/avif": "avif",
		"image/svg+xml": "svg",
		"font/woff": "woff",
		"font/woff2": "woff2",
		"application/pdf": "pdf",
	};
	return extensions[contentType] ?? "bin";
}

async function responseBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maximumBytes) {
		await response.body?.cancel().catch(() => undefined);
		tooLarge(`A public resource exceeds the ${maximumBytes}-byte file limit.`);
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximumBytes) {
				await reader.cancel();
				tooLarge(`A public resource exceeds the ${maximumBytes}-byte file limit.`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function disposeResponse(response: Response): void {
	if (!DISPOSE_SYMBOL) return;
	const dispose = (response as Response & { [key: symbol]: unknown })[DISPOSE_SYMBOL];
	if (typeof dispose !== "function") return;
	try {
		dispose.call(response);
	} catch {
		// The RPC transport may already have disposed the completed response.
	}
}

async function replaceAsync(
	value: string,
	pattern: RegExp,
	replacer: (...match: string[]) => Promise<string>,
): Promise<string> {
	const matches = [...value.matchAll(pattern)];
	if (matches.length === 0) return value;
	let output = "";
	let offset = 0;
	for (const match of matches) {
		output += value.slice(offset, match.index);
		output += await replacer(...match.map((part) => part ?? ""));
		offset = match.index! + match[0].length;
	}
	return output + value.slice(offset);
}

function attributeValue(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
	return match?.[1] ?? match?.[2];
}

async function rewriteAttribute(
	tag: string,
	name: string,
	rewrite: (value: string) => Promise<string>,
): Promise<string> {
	const pattern = new RegExp(`(\\b${name}\\s*=\\s*)(["'])(.*?)\\2`, "i");
	const match = pattern.exec(tag);
	if (!match) return tag;
	const value = await rewrite(match[3]!);
	return `${tag.slice(0, match.index)}${match[1]}${match[2]}${value}${match[2]}${tag.slice(match.index + match[0].length)}`;
}

export function assertSnapshotGeneration(expected: number, actual: number): void {
	if (expected !== actual) {
		throw new StaticSiteSnapshotError(
			"SITE_CHANGED_DURING_PUBLISH",
			"The draft changed while publishing. Retry Publish site.",
		);
	}
}

export async function captureStaticSiteSnapshot(
	input: CaptureStaticSiteSnapshotInput,
): Promise<StaticSiteSnapshot> {
	const siteId = canonicalUuid(input.siteId);
	const previewOrigin = normalizedOrigin(input.previewOrigin, "Preview origin");
	const liveOrigin = normalizedOrigin(input.liveOrigin, "Live origin");
	const limits = { ...DEFAULT_LIMITS, ...input.limits };
	const captures = new Map<string, PublicSiteAuditCapture>();
	const builtMetadata = new Map<string, BuiltSnapshotAssetMetadata | null>();
	const builtAssets = new Map<string, BuiltSnapshotAsset | null>();
	let inspectedBuiltBytes = 0;
	const inspectBuiltAsset = async (
		path: string,
	): Promise<BuiltSnapshotAssetMetadata | undefined> => {
		if (!builtMetadata.has(path)) {
			const metadata = (await input.inspectBuiltAsset(path)) ?? null;
			if (metadata) {
				if (metadata.byteLength > limits.assetBytes) {
					tooLarge(`The resource ${path} exceeds the ${limits.assetBytes}-byte file limit.`);
				}
				if (inspectedBuiltBytes + metadata.byteLength > limits.totalAssetBytes) {
					tooLarge(`The site exceeds the ${limits.totalAssetBytes}-byte asset limit.`);
				}
				inspectedBuiltBytes += metadata.byteLength;
			}
			builtMetadata.set(path, metadata);
		}
		return builtMetadata.get(path) ?? undefined;
	};
	const readBuiltAsset = async (path: string): Promise<BuiltSnapshotAsset | undefined> => {
		const metadata = await inspectBuiltAsset(path);
		if (!metadata) return;
		if (!builtAssets.has(path)) {
			const asset = (await input.readBuiltAsset(path, limits.assetBytes)) ?? null;
			if (!asset) unsupported(`The built resource ${path} became unavailable while publishing.`);
			if (
				asset.bytes.byteLength !== metadata.byteLength ||
				asset.contentType !== metadata.contentType
			) {
				unsupported(`The built resource ${path} changed while publishing.`);
			}
			builtAssets.set(path, asset);
		}
		return builtAssets.get(path) ?? undefined;
	};
	const audit = await auditPublicSite(input.fetch, {
		maxRoutes: limits.routes,
		maxRequests: limits.routes + limits.assets,
		sameSiteOrigins: [previewOrigin, liveOrigin],
		rejectNonHtmlRoutes: true,
		allowNonHtmlRoute: async (path) => Boolean(await inspectBuiltAsset(path)),
		capture: (capture) => {
			captures.set(capture.path, capture);
		},
	});
	if (!audit.success) {
		const issue = audit.issues[0];
		if (issue?.reason === "route-limit-exceeded" || issue?.reason === "request-limit-exceeded") {
			tooLarge(issue.detail ?? `The site exceeds the ${limits.routes}-route limit.`);
		}
		unsupported(
			issue
				? `The public route ${issue.path} is not publishable (${issue.reason}).${issue.detail ? ` ${issue.detail}` : ""}`
				: "The public site is not publishable.",
		);
	}
	for (const path of captures.keys()) {
		if (new URL(path, liveOrigin).search)
			unsupported(`Query-dependent public route ${path} is not supported.`);
	}

	const stored = new Map<string, SnapshotAsset>();
	const inFlightResources = new Map<string, Promise<string>>();
	const resourceOutputPaths = new Map<string, string>();
	let totalBytes = 0;

	const storeAsset = async (
		pathInput: string,
		bytes: Uint8Array,
		contentTypeInput: string,
	): Promise<SnapshotAsset> => {
		const path = safePublicPath(`/${pathInput.replace(/^\/+/, "")}`).slice(1);
		const contentType = allowedContentType(contentTypeInput);
		if (!contentType) unsupported(`The resource /${path} has an unsupported content type.`);
		if (bytes.byteLength > limits.assetBytes) {
			tooLarge(`The resource /${path} exceeds the ${limits.assetBytes}-byte file limit.`);
		}
		const digest = await sha256(bytes);
		const existing = stored.get(path);
		if (existing) {
			if (existing.digest !== digest || existing.contentType !== contentType) {
				unsupported(`Two different resources resolve to /${path}.`);
			}
			return existing;
		}
		if (stored.size >= limits.assets)
			tooLarge(`The site exceeds the ${limits.assets}-asset limit.`);
		if (totalBytes + bytes.byteLength > limits.totalAssetBytes) {
			tooLarge(`The site exceeds the ${limits.totalAssetBytes}-byte asset limit.`);
		}
		const asset = { path, bytes, contentType, digest };
		stored.set(path, asset);
		totalBytes += bytes.byteLength;
		return asset;
	};

	const resolvePublicUrl = (value: string, basePath: string): URL | undefined => {
		const trimmed = decodedUrlValue(value);
		if (
			!trimmed ||
			/^(?:data|blob|mailto|tel|javascript):/i.test(trimmed) ||
			trimmed.startsWith("#")
		) {
			return;
		}
		let url: URL;
		try {
			url = new URL(trimmed, new URL(basePath, liveOrigin));
		} catch {
			unsupported(`The site references an invalid URL: ${trimmed}`);
		}
		if (url.origin === previewOrigin)
			url = new URL(`${liveOrigin}${url.pathname}${url.search}${url.hash}`);
		return url;
	};

	let captureResource: (value: string, basePath: string) => Promise<string>;

	const rewriteCss = async (css: string, basePath: string): Promise<string> => {
		let rewritten = await replaceAsync(
			css,
			/url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
			async (whole, quote, value) =>
				`url(${quote}${await captureResource(value, basePath)}${quote})`,
		);
		rewritten = await replaceAsync(
			rewritten,
			/@import\s+(["'])([^"']+)\1/gi,
			async (_whole, quote, value) =>
				`@import ${quote}${await captureResource(value, basePath)}${quote}`,
		);
		return rewritten;
	};

	const includeJavascriptDependencies = async (source: string, basePath: string): Promise<void> => {
		if (NETWORK_PRIMITIVES.test(source)) {
			unsupported(`The browser script ${basePath} needs unsupported runtime networking.`);
		}
		const references = [
			...source.matchAll(
				/(?:\bimport\s*(?:[^"'()]*?\sfrom\s*)?|\bexport\s+[^"'()]*?\sfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g,
			),
			...source.matchAll(/\bnew\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g),
		];
		for (const reference of references) await captureResource(reference[1]!, basePath);
	};

	captureResource = async (value: string, basePath: string): Promise<string> => {
		const resolved = resolvePublicUrl(value, basePath);
		if (!resolved || resolved.origin !== liveOrigin)
			return value.replaceAll(previewOrigin, liveOrigin);
		if (resolved.search)
			unsupported(
				`Query-dependent resource ${resolved.pathname}${resolved.search} is not supported.`,
			);
		const pathname = safePublicPath(resolved.pathname);
		if (isPrivatePath(pathname))
			unsupported(`The public site depends on private route ${pathname}.`);
		const knownOutputPath = resourceOutputPaths.get(pathname);
		if (knownOutputPath) return knownOutputPath;
		const prior = inFlightResources.get(pathname);
		if (prior) unsupported(`The public resource ${pathname} has a cyclic dynamic dependency.`);
		const pending = (async () => {
			const built = await readBuiltAsset(pathname);
			let bytes: Uint8Array;
			let contentType: string;
			let outputPath: string | undefined;
			if (built) {
				bytes = built.bytes;
				contentType =
					allowedContentType(built.contentType) ??
					unsupported(`The resource ${pathname} has an unsupported content type.`);
				outputPath = pathname.slice(1);
				resourceOutputPaths.set(pathname, `/${outputPath}`);
			} else {
				const response = await input.fetch(pathname);
				try {
					if (!response.ok) {
						await response.body?.cancel().catch(() => undefined);
						unsupported(`The public resource ${pathname} returned HTTP ${response.status}.`);
					}
					if (response.headers.has("set-cookie")) {
						await response.body?.cancel().catch(() => undefined);
						unsupported(`The public resource ${pathname} depends on a credentialed response.`);
					}
					contentType =
						allowedContentType(response.headers.get("content-type") ?? "") ??
						unsupported(`The public resource ${pathname} has an unsupported content type.`);
					bytes = await responseBytes(response, limits.assetBytes);
				} finally {
					disposeResponse(response);
				}
				if (contentType !== "text/css") {
					const digest = (await sha256(bytes)).slice("sha256:".length);
					outputPath = `__emdash/snapshot/${digest}.${extensionFor(contentType)}`;
					resourceOutputPaths.set(pathname, `/${outputPath}`);
				}
			}

			if (contentType === "text/css") {
				bytes = new TextEncoder().encode(
					await rewriteCss(new TextDecoder().decode(bytes), pathname),
				);
				if (!outputPath) {
					const digest = (await sha256(bytes)).slice("sha256:".length);
					outputPath = `__emdash/snapshot/${digest}.css`;
					resourceOutputPaths.set(pathname, `/${outputPath}`);
				}
			} else if (contentType === "text/javascript" || contentType === "application/javascript") {
				await includeJavascriptDependencies(new TextDecoder().decode(bytes), pathname);
			}
			await storeAsset(outputPath!, bytes, contentType);
			return `/${outputPath}`;
		})();
		inFlightResources.set(pathname, pending);
		try {
			return await pending;
		} catch (error) {
			inFlightResources.delete(pathname);
			throw error;
		}
	};

	const rewriteSrcset = async (value: string, basePath: string): Promise<string> => {
		const candidates: string[] = [];
		let start = 0;
		let dataCandidate = value.trimStart().startsWith("data:");
		let sawWhitespace = false;
		for (let index = 0; index < value.length; index += 1) {
			const character = value[index]!;
			if (/\s/.test(character)) sawWhitespace = true;
			if (character !== "," || (dataCandidate && !sawWhitespace)) continue;
			candidates.push(value.slice(start, index));
			start = index + 1;
			dataCandidate = value.slice(start).trimStart().startsWith("data:");
			sawWhitespace = false;
		}
		candidates.push(value.slice(start));
		const rewritten: string[] = [];
		for (const candidate of candidates) {
			const trimmed = candidate.trim();
			if (!trimmed) continue;
			const split = trimmed.search(/\s/);
			const url = split < 0 ? trimmed : trimmed.slice(0, split);
			const descriptor = split < 0 ? "" : trimmed.slice(split).trim();
			rewritten.push(
				`${await captureResource(url, basePath)}${descriptor ? ` ${descriptor}` : ""}`,
			);
		}
		return rewritten.join(", ");
	};

	const rewriteHtml = async (htmlInput: string, routePath: string): Promise<string> => {
		let html = htmlInput.replaceAll(previewOrigin, liveOrigin);
		for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
			if (attributeValue(script[1]!, "src")) continue;
			const type = attributeValue(script[1]!, "type")?.toLowerCase();
			if (type === "application/ld+json") continue;
			if (NETWORK_PRIMITIVES.test(script[2]!)) {
				unsupported(
					`The public route ${routePath} contains a script that needs runtime networking.`,
				);
			}
		}
		for (const form of html.matchAll(/<form\b([^>]*)>/gi)) {
			const action = attributeValue(form[1]!, "action") ?? routePath;
			const target = resolvePublicUrl(action, routePath);
			if (!target || target.origin === liveOrigin) {
				unsupported(`The public route ${routePath} contains a same-origin form.`);
			}
		}

		html = await replaceAsync(
			html,
			/<(a|link|script|img|source|video|audio|input)\b[^>]*>/gi,
			async (tag, name) => {
				const lower = name.toLowerCase();
				let rewritten = tag;
				if (lower === "a") {
					rewritten = await rewriteAttribute(rewritten, "href", async (value) => {
						const target = resolvePublicUrl(value, routePath);
						if (!target || target.origin !== liveOrigin)
							return value.replaceAll(previewOrigin, liveOrigin);
						if (captures.has(`${target.pathname}${target.search}`))
							return value.replaceAll(previewOrigin, liveOrigin);
						const captured = await captureResource(value, routePath);
						return `${captured}${target.hash}`;
					});
				} else if (lower === "link") {
					const rel = attributeValue(tag, "rel")?.toLowerCase() ?? "";
					if (/\b(?:stylesheet|icon|preload|modulepreload)\b/.test(rel)) {
						rewritten = await rewriteAttribute(rewritten, "href", (value) =>
							captureResource(value, routePath),
						);
					}
				} else if (lower === "video") {
					rewritten = await rewriteAttribute(rewritten, "src", (value) =>
						captureResource(value, routePath),
					);
					rewritten = await rewriteAttribute(rewritten, "poster", (value) =>
						captureResource(value, routePath),
					);
				} else {
					rewritten = await rewriteAttribute(rewritten, "src", (value) =>
						captureResource(value, routePath),
					);
				}
				if (lower === "img" || lower === "source") {
					rewritten = await rewriteAttribute(rewritten, "srcset", (value) =>
						rewriteSrcset(value, routePath),
					);
				}
				return rewritten;
			},
		);
		html = await replaceAsync(html, /<meta\b[^>]*>/gi, async (tag) => {
			const key = (attributeValue(tag, "property") ?? attributeValue(tag, "name"))?.toLowerCase();
			if (
				!key ||
				![
					"og:image",
					"og:image:url",
					"og:image:secure_url",
					"twitter:image",
					"twitter:image:src",
				].includes(key)
			) {
				return tag;
			}
			return rewriteAttribute(tag, "content", async (value) => {
				const captured = await captureResource(value, routePath);
				return new URL(captured, liveOrigin).href;
			});
		});
		html = await replaceAsync(
			html,
			/\bstyle\s*=\s*(["'])(.*?)\1/gi,
			async (_whole, quote, css) => `style=${quote}${await rewriteCss(css, routePath)}${quote}`,
		);
		if (html.includes(previewOrigin))
			unsupported(`The public route ${routePath} still depends on the preview host.`);
		return html;
	};

	const routes: SnapshotRoute[] = [];
	for (const capture of [...captures.values()].sort((left, right) =>
		left.path.localeCompare(right.path),
	)) {
		if (capture.kind === "redirect") {
			const location = capture.location.replaceAll(previewOrigin, liveOrigin);
			if (location.includes(previewOrigin))
				unsupported(`The redirect ${capture.path} depends on the preview host.`);
			routes.push({
				path: capture.path,
				kind: "redirect",
				status: capture.status,
				location,
			});
			continue;
		}
		const html = new TextEncoder().encode(await rewriteHtml(capture.html, capture.path));
		const digest = await sha256(html);
		const page = await storeAsset(
			`__emdash/pages/${digest.slice("sha256:".length)}.html`,
			html,
			"text/html",
		);
		routes.push({ path: capture.path, kind: "page", assetPath: page.path });
	}

	const assets = [...stored.values()].sort((left, right) => left.path.localeCompare(right.path));
	const manifest: SnapshotManifest = {
		version: 1,
		routes: routes.map((route) => ({ ...route })),
		assets: assets.map(({ path, bytes, contentType, digest }) => ({
			path,
			byteLength: bytes.byteLength,
			contentType,
			digest,
		})),
	};
	const sourceRevision = await sha256(new TextEncoder().encode(JSON.stringify(manifest)));
	return {
		siteId,
		liveOrigin,
		releaseId: await uuidV5(`${siteId}\0${sourceRevision}`),
		sourceRevision,
		routes,
		assets,
		manifest,
	};
}
