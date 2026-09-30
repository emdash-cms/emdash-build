/**
 * Sandbox tools for the builder agent.
 *
 * These are the low-level file/shell tools the LLM uses to inspect
 * and customize the scaffolded template. The CMS tools (schema,
 * content, taxonomy) come from the EmDash MCP server and are wired
 * up in agent.ts.
 */

import { tool } from "ai";
import { z } from "zod";
import { BuildConvergence, mutationKey } from "./build-convergence.js";
import { auditPublicSite } from "./public-site-audit.js";
import { isSandboxRuntimeReplacement } from "./recovery.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

import type { getSandbox } from "@cloudflare/sandbox";
import type { BlockRendererValidationResult } from "./block-renderer-validation.js";
import type { PublicSiteAuditResult } from "./public-site-audit.js";

type SandboxInstance = ReturnType<typeof getSandbox>;

/** Base path for the scaffolded site inside the sandbox */
export const SITE_PATH = "/home/user/site";

const READ_FILES_MAX_PATHS = 12;
const READ_FILE_MAX_BYTES = 48 * 1024;
const READ_FILES_MAX_BYTES = 128 * 1024;
const READ_FILE_TIMEOUT_MS = 5_000;
const READ_FILES_TIMEOUT_MS = 10_000;
const WRITE_FILES_MAX_PATHS = 12;
const WRITE_FILES_MAX_BYTES = 192 * 1024;
const EDIT_FILES_MAX_EDITS = 12;
const EDIT_FILES_MAX_BYTES = 192 * 1024;
const BATCH_READ_EXCLUDED_ROOTS = new Set([".git", ".wrangler", ".astro", "node_modules", "dist"]);
const TYPEGEN_MAX_BYTES = 2 * 1024 * 1024;
/** Generated declarations returned to the model; larger files point at the file itself. */
const TYPE_DECLARATIONS_MAX_CHARS = 60_000;

export interface CanonicalSiteReadPath {
	path: string;
	fullPath: string;
}

export type BatchReadFileResult =
	| { path: string; success: true; content: string }
	| { path: string; success: false; error: string };

export interface BatchReadResult {
	success: boolean;
	files: BatchReadFileResult[];
}

interface StreamingReadSandbox {
	readFileStream(path: string): Promise<ReadableStream<Uint8Array>>;
}

interface BatchReadOptions {
	streamFile: typeof import("@cloudflare/sandbox").streamFile;
	signal?: AbortSignal;
	timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

interface InternalReadSuccess {
	path: string;
	success: true;
	content: string;
	bytes: number;
}

type InternalReadResult = InternalReadSuccess | Extract<BatchReadFileResult, { success: false }>;

/** Canonicalize one site-relative source path without treating `\\` as `/`. */
export function canonicalizeSiteReadPath(input: string): CanonicalSiteReadPath {
	if (!input || input.includes("\0")) throw new Error("Path must be a non-empty relative path.");
	if (input.startsWith("/")) throw new Error("Absolute paths are not allowed.");

	const segments: string[] = [];
	for (const segment of input.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) throw new Error("Path must stay inside the site root.");
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	if (segments.length === 0) throw new Error("Path must name a file inside the site root.");

	const path = segments.join("/");
	const fullPath = `${SITE_PATH}/${path}`;
	if (!fullPath.startsWith(`${SITE_PATH}/`)) {
		throw new Error("Path must stay inside the site root.");
	}
	return { path, fullPath };
}

/** True when `search` occurs more than once, counting overlaps, so ambiguous targets are rejected. */
function hasSecondMatch(content: string, first: number, search: string): boolean {
	return content.indexOf(search, first + 1) !== -1;
}

/** `readFile` throws this SDK error when a write destination is new. */
function isSandboxFileNotFound(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
	return (
		candidate.name === "FileNotFoundError" ||
		candidate.code === "FILE_NOT_FOUND" ||
		(typeof candidate.message === "string" &&
			candidate.message.startsWith("FileNotFoundError: File not found: "))
	);
}

/** Runtime env files (`.dev.vars`, `.dev.vars.<env>`); builder-managed and possibly secret. */
function isDevVarsPath(path: string): boolean {
	const root = path.split("/", 1)[0] ?? "";
	return root === ".dev.vars" || root.startsWith(".dev.vars.");
}

function isBatchReadExcluded(path: string): boolean {
	return BATCH_READ_EXCLUDED_ROOTS.has(path.split("/", 1)[0] ?? "") || isDevVarsPath(path);
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
	return AbortSignal.any(active);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error("Read was stopped or timed out."));
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(new Error("Read was stopped or timed out."));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function cancelStream(stream: ReadableStream<Uint8Array> | undefined): void {
	if (!stream) return;
	try {
		void stream.cancel().catch(() => {});
	} catch {
		// Best-effort cleanup for a transport-owned stream that closed concurrently.
	}
}

async function openReadStream(
	sandbox: StreamingReadSandbox,
	fullPath: string,
	signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
	if (signal?.aborted) throw new Error("Read was stopped or timed out.");
	let requestFinished = false;
	const open = Promise.resolve().then(() => sandbox.readFileStream(fullPath));
	const observed = open.then((stream) => {
		if (requestFinished) cancelStream(stream);
		return stream;
	});

	try {
		return await abortable(observed, signal);
	} finally {
		requestFinished = true;
	}
}

async function readOneTextFile(
	sandbox: StreamingReadSandbox,
	path: CanonicalSiteReadPath,
	streamFile: typeof import("@cloudflare/sandbox").streamFile,
	signal?: AbortSignal,
): Promise<InternalReadResult> {
	let chunks: ReturnType<typeof streamFile> | undefined;
	try {
		const source = await openReadStream(sandbox, path.fullPath, signal);
		const stream = signal
			? source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal })
			: source;
		chunks = streamFile(stream);
		const encoder = new TextEncoder();
		let bytes = 0;
		const parts: Uint8Array[] = [];

		while (true) {
			const chunk = await chunks.next();
			if (chunk.done) {
				if (chunk.value.size > READ_FILE_MAX_BYTES) {
					throw new Error("File exceeds the 48 KiB limit.");
				}
				break;
			}
			const part = chunk.value instanceof Uint8Array ? chunk.value : encoder.encode(chunk.value);
			bytes += part.byteLength;
			if (bytes > READ_FILE_MAX_BYTES) throw new Error("File exceeds the 48 KiB limit.");
			if (part.includes(0)) throw new Error("File contains NUL bytes.");
			parts.push(part);
		}
		const sourceBytes = new Uint8Array(bytes);
		let offset = 0;
		for (const part of parts) {
			sourceBytes.set(part, offset);
			offset += part.byteLength;
		}
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
		} catch {
			throw new Error("File is binary or is not valid UTF-8 text.");
		}
		return { path: path.path, success: true, content, bytes };
	} catch (error) {
		await chunks?.return(undefined as never).catch(() => {});
		if (isSandboxRuntimeReplacement(error)) throw error;
		return {
			path: path.path,
			success: false,
			error: error instanceof Error ? error.message : "Could not read file.",
		};
	}
}

function invalidBatch(paths: readonly string[], error: unknown): BatchReadResult {
	const message = error instanceof Error ? error.message : "Invalid file batch.";
	return {
		success: false,
		files: paths.map((path) => ({ path, success: false as const, error: message })),
	};
}

/** Read one validated source batch concurrently, then apply the aggregate bound in input order. */
export async function readFilesFromSandbox(
	sandbox: StreamingReadSandbox,
	paths: readonly string[],
	options: BatchReadOptions,
): Promise<BatchReadResult> {
	if (paths.length < 1 || paths.length > READ_FILES_MAX_PATHS) {
		return invalidBatch(paths, new Error("Provide between 1 and 12 file paths."));
	}

	let canonical: CanonicalSiteReadPath[];
	try {
		canonical = paths.map(canonicalizeSiteReadPath);
		const seen = new Set<string>();
		for (const file of canonical) {
			if (isBatchReadExcluded(file.path)) {
				throw new Error(`Batch reads exclude runtime path: ${file.path}`);
			}
			if (seen.has(file.path)) throw new Error(`Duplicate file path: ${file.path}`);
			seen.add(file.path);
		}
	} catch (error) {
		return invalidBatch(paths, error);
	}

	if (options.signal?.aborted) {
		return invalidBatch(paths, new Error("Read was stopped before it started."));
	}
	const timeoutSignal = options.timeoutSignal ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
	const batchSignal = combineSignals([options.signal, timeoutSignal(READ_FILES_TIMEOUT_MS)]);
	const results = await Promise.all(
		canonical.map((path) =>
			readOneTextFile(
				sandbox,
				path,
				options.streamFile,
				combineSignals([batchSignal, timeoutSignal(READ_FILE_TIMEOUT_MS)]),
			),
		),
	);

	let totalBytes = 0;
	const files = results.map((result): BatchReadFileResult => {
		if (!result.success) return result;
		if (totalBytes + result.bytes > READ_FILES_MAX_BYTES) {
			return {
				path: result.path,
				success: false,
				error: "File would exceed the 128 KiB batch content limit.",
			};
		}
		totalBytes += result.bytes;
		return { path: result.path, success: true, content: result.content };
	});
	return { success: files.some((file) => file.success), files };
}

/**
 * Builder-managed files the model must not change: runtime wiring, bindings,
 * secrets, and the scaffold guidance that is loaded into the system prompt.
 */
const PROTECTED_SITE_FILES = [
	"src/worker.ts",
	"src/live.config.ts",
	"wrangler.jsonc",
	".dev.vars",
	"AGENTS.md",
] as const;

/** `path` must already be canonical (see canonicalizeSiteReadPath). */
function isProtectedSitePath(path: string): boolean {
	return (
		(PROTECTED_SITE_FILES as readonly string[]).includes(path) || path.startsWith(".dev.vars.")
	);
}

function protectedFileError(path: string): string {
	return `${path} is protected because EmDash Build manages it. Change public site code in src/pages, src/layouts, src/components, or src/styles instead.`;
}

const PROTECTED_FILE_NOTICE = "emdash-build-guard: ";

/**
 * Wrap a shell command (run from the site root) so protected site files
 * survive it: copy them aside first, then restore any the command changed
 * or deleted and report each on stderr. The command's exit status is kept.
 * Runs in a subshell so `exit` never ends the sandbox's shared session.
 *
 * This catches accidental edits, not a determined model: it shares the
 * command's permissions, and background processes can outlive it. The
 * prompt-bearing AGENTS.md is therefore pinned by the agent, not re-read.
 * `.dev.vars.*` variants are refused by the file tools only.
 */
export function guardProtectedFiles(command: string): string {
	const files = PROTECTED_SITE_FILES.map(shellQuote).join(" ");
	const notice = (message: string) => `echo "${PROTECTED_FILE_NOTICE}${message}" >&2`;
	const restore =
		`rm -rf "$f.emdash-restore" && cp "$guard/$f" "$f.emdash-restore" && mv -f "$f.emdash-restore" "$f" && ` +
		notice("restored protected file $f");
	const steps = [
		'guard=$(mktemp -d "${TMPDIR:-/tmp}/emdash-guard.XXXXXX") || exit 1',
		"backed=",
		`for f in ${files}; do if [ -f "$f" ]; then { mkdir -p "$guard/$(dirname "$f")" && cp "$f" "$guard/$f" && backed="$backed $f"; } || ${notice("could not back up protected file $f")}; fi; done`,
		command,
		"rc=$?",
		// Word splitting over $backed is safe: protected paths contain no spaces.
		`for f in $backed; do if [ ! -f "$guard/$f" ]; then ${notice("could not check protected file $f: its backup was removed")}; elif ! cmp -s "$guard/$f" "$f"; then { if [ -L "$f" ]; then rm -f "$f"; elif [ -d "$f" ]; then rm -rf "$f"; fi; mkdir -p "$(dirname "$f")" && ${restore}; } || ${notice("could not restore protected file $f")}; fi; done`,
		'rm -rf "$guard"',
		"exit $rc",
	];
	return `( ${steps.join("; ")} )`;
}

/**
 * Guard notices from a guarded command's stderr, e.g. "restored protected file
 * AGENTS.md". A notice may follow command output that lacked a final newline.
 */
function protectedFileNotices(stderr: string): string[] {
	return stderr.split("\n").flatMap((line) => {
		const start = line.indexOf(PROTECTED_FILE_NOTICE);
		return start === -1 ? [] : [line.slice(start + PROTECTED_FILE_NOTICE.length)];
	});
}

/** Quote one argument for a POSIX shell command. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Map over `items` running at most `limit` calls of `fn` concurrently,
 * preserving input order in the returned array. Used to bound the load we put
 * on the single shared dev server (media uploads, etc.) -- unbounded
 * `Promise.all` hammers the media/D1 endpoint and trips the Vite SSR reload.
 */
export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: width }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) break;
			results[i] = await fn(items[i]!, i);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Result of a temporary-account deploy. */
export interface DeployResult {
	success: boolean;
	liveUrl?: string;
	claimUrl?: string;
	error?: string;
}

/**
 * Cloudflare temporary preview accounts (`wrangler deploy --temporary`)
 * support only a limited set of products. EmDash's Cloudflare template binds
 * R2 (`MEDIA`) and a Worker Loader (`LOADER`) and registers a cron trigger,
 * none of which a temporary account can provision. These helpers produce a
 * stripped, temp-account-safe build so the agent can deploy a working live
 * preview (pages + D1 content) without media uploads, sandboxed plugins, or
 * scheduled publishing. They are pure so they can be unit-tested.
 */

/**
 * Builder-owned Worker entry for every managed site. Development setup/reset
 * stays reachable from the container loopback for provisioning, but the public
 * preview origin cannot mint the Builder's full-scope PAT or reset the CMS.
 */
export const CANONICAL_WORKER_TS = `import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

const localOnlyDevRoutes = new Set([
	"/_emdash/api/setup/dev-bypass",
	"/_emdash/api/setup/dev-reset",
]);
const fetchHandler = handler.fetch;
if (!fetchHandler) throw new Error("The EmDash Worker handler is missing fetch().");

export default {
	...handler,
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		let routePath = url.pathname;
		for (let pass = 0; pass < 8; pass++) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(routePath);
			} catch {
				return new Response("Bad request", { status: 400 });
			}
			if (decoded === routePath) break;
			if (pass === 7) return new Response("Bad request", { status: 400 });
			routePath = decoded;
		}
		if (routePath.length > 1) routePath = routePath.replace(/\\/+$/, "");
		if (
			localOnlyDevRoutes.has(routePath) &&
			url.hostname !== "localhost" &&
			url.hostname !== "127.0.0.1"
		) {
			return new Response("Not found", { status: 404 });
		}
		const response = await fetchHandler(request, env, ctx);
		if (!response.headers.get("Content-Type")?.includes("text/html")) return response;
		const headers = new Headers(response.headers);
		headers.delete("X-Frame-Options");
		headers.delete("Content-Security-Policy");
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	},
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler<Env>;
`;

/**
 * Canonical wrangler config written over the template's at site creation. All
 * four templates' wrangler.jsonc are identical bar the name, so we replace it
 * with one known-good config instead of parsing/stripping the template's. It
 * keeps D1 + R2 (so media works in the preview) and drops `worker_loaders` and
 * the cron `triggers`: the sandbox plugin runner is removed at creation, and
 * crons are inert under `astro dev`. `compatibility_date` tracks the templates;
 * bump it if they do.
 */
export const CANONICAL_WRANGLER_JSONC = JSON.stringify(
	{
		$schema: "node_modules/wrangler/config-schema.json",
		name: "emdash-site",
		main: "./src/worker.ts",
		compatibility_date: "2026-02-24",
		compatibility_flags: ["nodejs_compat"],
		d1_databases: [{ binding: "DB", database_name: "emdash-site" }],
		r2_buckets: [{ binding: "MEDIA", bucket_name: "emdash-media" }],
	},
	null,
	2,
);

/**
 * Remove the sandbox plugin runner from an astro.config -- `sandboxRunner`,
 * `sandboxed`, and `marketplace` (only the blog template ships these). The
 * Worker Loader they need isn't provisioned on temp accounts, and a
 * `marketplace` without a `sandboxRunner` fails config load. Regular `plugins`
 * (forms, marketing-blocks) and `storage` are kept. Applied once at creation.
 */
export function stripSandboxFromAstroConfig(src: string): string {
	return src
		.replace(/^[ \t]*sandboxRunner:\s*sandbox\(\),?\s*$\n?/m, "")
		.replace(/^[ \t]*sandboxed:\s*\[[^\]]*\],?\s*$\n?/m, "")
		.replace(/^[ \t]*marketplace:\s*["'][^"']*["'],?\s*$\n?/m, "");
}

/**
 * Remove `storage: r2(...)` from an astro.config. Applied to the deploy build
 * only (R2 isn't on temporary accounts) so the built worker doesn't reference
 * the absent MEDIA binding. The in-builder preview keeps storage.
 */
export function stripStorageFromAstroConfig(src: string): string {
	return src.replace(/^[ \t]*storage:\s*r2\([^)]*\),?\s*$\n?/m, "");
}

/**
 * Drop `r2_buckets` from the (canonical, JSON) wrangler config for the deploy
 * build, so the adapter-generated deploy config has no MEDIA binding the temp
 * account can't provision. Restored after deploy.
 */
export function stripR2FromWrangler(jsonText: string): string {
	const cfg = JSON.parse(jsonText) as Record<string, unknown>;
	delete cfg.r2_buckets;
	return JSON.stringify(cfg, null, 2);
}

/**
 * Append statements to a `wrangler d1 export` snapshot that remove everything
 * auth-related before it is loaded into a deployed site: the dev-bypass admin
 * user, its full-scope PAT (the same raw token the Worker holds for the
 * session), OAuth/device/passkey state, and the secret-bearing options.
 * Mirrors the exclusions EmDash's own backup export makes. Clearing
 * `emdash:setup_complete` along with the users sends whoever claims the deploy
 * through the setup wizard to create their own admin; public pages are not
 * gated on setup, so the site still serves. Child tables go before `users`.
 */
export function scrubAuthFromSnapshot(sql: string): string {
	const tables = [
		"_emdash_api_tokens",
		"_emdash_oauth_tokens",
		"_emdash_authorization_codes",
		"_emdash_device_codes",
		"_emdash_oauth_clients",
		"_emdash_rate_limits",
		"auth_challenges",
		"auth_tokens",
		"credentials",
		"oauth_accounts",
		"audit_logs",
		"users",
	];
	const statements = [
		...tables.map((t) => `DELETE FROM ${t};`),
		"DELETE FROM options WHERE name IN ('emdash:setup_complete', 'emdash:site_url', 'emdash:preview_secret');",
		"DELETE FROM options WHERE name LIKE 'plugin:%' OR name LIKE 'emdash:passkey_pending:%';",
	];
	return `${sql.trimEnd()}\n${statements.join("\n")}\n`;
}

/**
 * Configure the astro.config SSR dependency optimizer for stable Worker dev.
 *
 * Cloudflare's runner can still be serving an older deps_ssr graph when Vite
 * discovers another dependency and regenerates shared chunks. The resulting
 * "file does not exist" request terminates Astro before port 4321 is ready.
 * Pre-bundle the one CJS dependency EmDash needs, disable further discovery,
 * and tolerate an already-issued request for an older graph while the explicit
 * bundle settles.
 *
 * Merges into an existing include array when present (the marketing template
 * already has one for astro-iconset) and inserts a fresh `vite` block
 * otherwise. Idempotent: deps and options already present are left alone.
 */
export function ensureSsrOptimizeDep(
	src: string,
	deps: string[],
	excludedDeps: string[] = [],
): string {
	let output = src;
	const missing = deps.filter((d) => !output.includes(`"${d}"`));
	const list = missing.map((d) => `"${d}"`).join(", ");
	const missingExcludes = excludedDeps.filter((d) => !output.includes(`"${d}"`));
	// Splice into an existing `optimizeDeps` include array if there is one. Use
	// index walking, not one regex: the marketing template has a comment between
	// `optimizeDeps: {` and `include: [`, which a `\s*`-based pattern misses --
	// the old version then inserted a second `vite` key that silently shadowed
	// the real one. `optimizeDeps` precedes its own `include: [` and the
	// astro-iconset `include: {` (object, not array) comes later.
	let odIdx = output.indexOf("optimizeDeps");
	if (odIdx !== -1) {
		const incIdx = output.indexOf("include:", odIdx);
		const openIdx = incIdx === -1 ? -1 : output.indexOf("[", incIdx);
		if (openIdx !== -1 && missing.length > 0) {
			// Insert before any existing entries (comma-separate if there are any).
			const rest = output.slice(openIdx + 1);
			const sep = /^\s*\]/.test(rest) ? "" : ", ";
			output = `${output.slice(0, openIdx + 1)}${list}${sep}${rest}`;
		}

		odIdx = output.indexOf("optimizeDeps");
		const objectStart = output.indexOf("{", odIdx);
		if (objectStart !== -1) {
			const options = [
				!output.includes("noDiscovery:") ? "noDiscovery: true" : undefined,
				!output.includes("ignoreOutdatedRequests:") ? "ignoreOutdatedRequests: true" : undefined,
				missingExcludes.length > 0
					? `exclude: [${missingExcludes.map((d) => `"${d}"`).join(", ")}]`
					: undefined,
			].filter((option): option is string => option !== undefined);
			if (options.length > 0) {
				output = `${output.slice(0, objectStart + 1)} ${options.join(", ")},${output.slice(objectStart + 1)}`;
			}
		}
		return output;
	}
	return output.replace(
		/defineConfig\(\s*\{/,
		`defineConfig({\n\tvite: { ssr: { optimizeDeps: { noDiscovery: true, ignoreOutdatedRequests: true, exclude: [${missingExcludes.map((d) => `"${d}"`).join(", ")}], include: [${list}] } } },`,
	);
}

/**
 * Make Vite's HMR client connect back through the public Sandbox preview URL
 * instead of trying the container-local `localhost:4321`. The preview URL is
 * supplied in `.dev.vars` before Astro starts and differs per session.
 */
export function ensurePreviewHmr(src: string): string {
	if (src.includes("EMDASH_PREVIEW_URL")) return src;
	const declaration = [
		"const emdashPreviewUrl = process.env.EMDASH_PREVIEW_URL",
		"\t? new URL(process.env.EMDASH_PREVIEW_URL)",
		"\t: undefined;",
		"",
	].join("\n");
	let output = src.replace(
		"export default defineConfig(",
		`${declaration}export default defineConfig(`,
	);
	const viteStart = output.indexOf("vite:");
	const objectStart = viteStart === -1 ? -1 : output.indexOf("{", viteStart);
	if (objectStart === -1) return output;
	const hmr = [
		"",
		"\t\tserver: emdashPreviewUrl",
		"\t\t\t? {",
		"\t\t\t\thmr: {",
		'\t\t\t\t\tprotocol: emdashPreviewUrl.protocol === "https:" ? "wss" : "ws",',
		"\t\t\t\t\thost: emdashPreviewUrl.hostname,",
		"\t\t\t\t\tclientPort: Number(",
		'\t\t\t\t\t\temdashPreviewUrl.port || (emdashPreviewUrl.protocol === "https:" ? 443 : 80),',
		"\t\t\t\t\t),",
		"\t\t\t\t},",
		"\t\t\t}",
		"\t\t\t: undefined,",
	].join("\n");
	return `${output.slice(0, objectStart + 1)}${hmr}${output.slice(objectStart + 1)}`;
}

/**
 * Drop the `PluginBridge` Durable Object re-export from the worker entry.
 * With the sandbox runner stripped the built worker never references it, and
 * exporting a DO class without a matching migration would fail `wrangler
 * deploy`.
 */
export function stripWorkerEntry(src: string): string {
	return src.replace(/export\s*{\s*default\s*,\s*PluginBridge\s*}/, "export { default }");
}

interface ToolCallbacks {
	/** Refresh the durable HTML snapshot, then reload the preview iframe. */
	reloadPreview: () => Promise<void>;
	/** Persist the site after a successful mutation, before another tool runs. */
	checkpointSite: () => Promise<void>;
	getRecentRenderErrors?: () => string[];
	/** Cleanly restart the dev server (e.g. after installing a dependency). */
	restartDevServer: () => Promise<{ success: boolean; error?: string }>;
	/** Reveal the "Clone locally" panel to the user (mints no secret). */
	offerClone: () => { success: boolean };
	/** Screenshot the live preview inside the Sandbox for visual QA. */
	capturePreview: () => Promise<
		{ ok: true; base64: string; mediaType: string } | { ok: false; error: string }
	>;
	savePreviewThumbnail?: (shotId: string, shot: { base64: string; mediaType: string }) => void;
	runSandboxRead?: <T>(operation: (sandbox: SandboxInstance) => Promise<T>) => Promise<T>;
	validateBlockContracts?: (sandbox: SandboxInstance) => Promise<BlockRendererValidationResult>;
}

interface ToolOptions {
	/** Shared turn-local revision/evidence tracker. */
	convergence?: BuildConvergence;
	/** Cancellation for the build turn, including queued sandbox operations. */
	abortSignal?: AbortSignal;
	/** SDK decoder for transport-neutral file streams. */
	streamFile?: typeof import("@cloudflare/sandbox").streamFile;
	unsplashAccessKey?: string;
	/** Full-scope API token for the site's EmDash instance (Worker-side only) */
	apiToken?: string;
	/** Public preview URL of the site (ends with `/`), used to reach the CMS API */
	cmsBaseUrl?: string;
	/** Deliver screenshot image bytes to the model for visual QA. */
	previewImagesEnabled?: boolean;
	/** Maximum exploratory screenshot images delivered before final validation. */
	maxPreviewImages?: number;
}

interface UnsplashPhoto {
	id: string;
	description: string | null;
	alt_description: string | null;
	urls: { raw: string; regular: string; small: string };
	user: { name: string; username: string };
	links: { html: string };
}

interface UnsplashSearchResponse {
	results: UnsplashPhoto[];
}

type PreviewModelOutput =
	| { type: "text"; value: string }
	| { type: "error-text"; value: string }
	| {
			type: "content";
			value: Array<
				{ type: "text"; text: string } | { type: "file-data"; data: string; mediaType: string }
			>;
	  };

type FileMutationResult =
	| { success: true; changed: boolean; path: string; message: string }
	| { success: false; changed: boolean; error: string };

type BatchFileMutationResult =
	| {
			success: true;
			changed: boolean;
			files: Array<{ path: string; changed: boolean }>;
			message: string;
	  }
	| { success: false; changed: boolean; error: string };

/**
 * Wait for the dev server to be responsive after a file change. Best-effort:
 * never throws, so it only gates the preview reload and never fails the edit
 * that triggered it. HMR is a brief blip, but an astro.config change triggers a
 * full server restart, so the poll budget is generous and each probe fails fast
 * and a probe that throws while the server is down is treated as "not ready
 * yet" rather than aborting. Probe TCP instead of `/`: local Astro SSR can take
 * several seconds per render even when the listener is healthy.
 */
async function waitForDevServer(sandbox: SandboxInstance, retries = 20): Promise<boolean> {
	for (let i = 0; i < retries; i++) {
		try {
			const check = await sandbox.exec("timeout 1 bash -c 'echo > /dev/tcp/127.0.0.1/4321'", {
				timeout: 3000,
			});
			if (check.success) return true;
		} catch {
			// Server is mid-restart (exec/curl timed out); keep polling.
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

/** Files Vite picks up without restarting the managed Astro process. */
function isHotReloadFile(path: string): boolean {
	return /\.(?:astro|css|[cm]?[jt]sx?)$/i.test(path);
}

async function settleHotReload(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 250));
}

async function readResponseTextBounded(response: Response, maximumBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get("Content-Length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
		await response.body?.cancel();
		throw new Error(`Response exceeds ${maximumBytes} bytes.`);
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maximumBytes) {
				await reader.cancel();
				throw new Error(`Response exceeds ${maximumBytes} bytes.`);
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		reader.releaseLock();
	}
}

/** Generated type declarations as returned to the model, bounded for its context. */
export function typeDeclarationsForModel(declarations: string): {
	declarations: string;
	declarationsTruncated?: true;
	note?: string;
} {
	if (declarations.length <= TYPE_DECLARATIONS_MAX_CHARS) return { declarations };
	return {
		declarations: declarations.slice(0, TYPE_DECLARATIONS_MAX_CHARS),
		declarationsTruncated: true,
		note: "The declarations were shortened. Read emdash-env.d.ts for the rest before using names beyond this excerpt.",
	};
}

export async function refreshLiveTypes(
	sandbox: SandboxInstance,
	abortSignal?: AbortSignal,
): Promise<{
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	generatedFile?: string;
	/** The generated declarations, when they came from the live expanded schema. */
	declarations?: string;
}> {
	let response: Response;
	try {
		response = await sandbox.containerFetch(
			"http://localhost:4321/_emdash/api/typegen",
			{ redirect: "manual" },
			4321,
		);
	} catch (error) {
		if (isSandboxRuntimeReplacement(error)) throw error;
		return {
			success: false,
			exitCode: 1,
			stdout: "",
			stderr: `Live expanded type generation could not reach the dev server: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (response.status === 404) {
		await response.body?.cancel();
		const fallback = await sandbox.exec("pnpm exec emdash types", {
			cwd: SITE_PATH,
			timeout: 60_000,
			signal: abortSignal,
		});
		return {
			success: fallback.success,
			exitCode: fallback.exitCode,
			stdout: fallback.stdout,
			stderr: fallback.stderr,
			...(fallback.success ? { generatedFile: ".emdash/types.ts" } : {}),
		};
	}
	if (!response.ok) {
		let detail = "";
		try {
			detail = await readResponseTextBounded(response, 1000);
		} catch (error) {
			if (isSandboxRuntimeReplacement(error)) throw error;
			detail = error instanceof Error ? error.message : String(error);
		}
		return {
			success: false,
			exitCode: 1,
			stdout: "",
			stderr: `Live expanded type generation failed with HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
		};
	}
	let types: string;
	try {
		types = await readResponseTextBounded(response, TYPEGEN_MAX_BYTES);
	} catch (error) {
		if (isSandboxRuntimeReplacement(error)) throw error;
		return {
			success: false,
			exitCode: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
	if (!types || !types.includes('declare module "emdash"')) {
		return {
			success: false,
			exitCode: 1,
			stdout: "",
			stderr: "Live expanded type generation returned malformed TypeScript.",
		};
	}
	const written = await sandbox.writeFile(`${SITE_PATH}/emdash-env.d.ts`, types);
	if (!written.success) {
		return {
			success: false,
			exitCode: 1,
			stdout: "",
			stderr: "Could not write emdash-env.d.ts.",
		};
	}
	return {
		success: true,
		exitCode: 0,
		stdout: "Generated emdash-env.d.ts from the live expanded schema.",
		stderr: "",
		generatedFile: "emdash-env.d.ts",
		declarations: types,
	};
}

async function auditSandboxPublicSite(sandbox: SandboxInstance): Promise<PublicSiteAuditResult> {
	const fetchPage = (path: string) => {
		const url = new URL(path, "http://localhost:4321");
		// AbortSignal cannot cross the Sandbox RPC boundary. containerFetch owns
		// its container-start and request timeouts, so pass only serializable init.
		return sandbox.containerFetch(
			url.toString(),
			{ headers: { Accept: "text/html" }, redirect: "manual" },
			4321,
		);
	};
	const first = await auditPublicSite(fetchPage);
	if (
		!first.success &&
		first.issues.length > 0 &&
		first.issues.every((issue) => issue.reason === "truncated-html")
	) {
		return auditPublicSite(fetchPage);
	}
	return first;
}

function formatPublicSiteIssues(audit: PublicSiteAuditResult): string {
	return audit.issues
		.map((issue) => {
			const description =
				issue.reason === "scaffold-placeholder"
					? "still renders the blank-builder placeholder"
					: issue.reason === "missing-block-renderer"
						? `has no renderer for ${issue.detail ?? "a stored block"}`
						: issue.reason === "http-status"
							? `returned HTTP ${issue.status ?? "error"}${issue.detail ? `: ${issue.detail}` : ""}`
							: issue.reason === "request-failed"
								? `could not be loaded${issue.detail ? `: ${issue.detail}` : ""}`
								: issue.reason === "empty-html"
									? "returned an empty HTML document"
									: issue.reason === "truncated-html"
										? "returned a truncated HTML document"
										: issue.reason.replaceAll("-", " ");
			return `- ${issue.path}: ${description}`;
		})
		.join("\n");
}

/** Result of uploading a single image to the CMS. */
type UploadResult =
	| {
			url: string;
			success: true;
			mediaId: string;
			width?: number;
			height?: number;
			fieldValue: { id: string; provider: "local"; alt?: string };
	  }
	| { url: string; success: false; error: string };

/**
 * Download one image and register it as a CMS media item. Runs entirely in the
 * Worker so the API token never enters the sandbox. Always resolves (errors are
 * returned, not thrown) so a batch can report per-image outcomes.
 */
async function uploadOneMedia(
	url: string,
	filename: string | undefined,
	alt: string | undefined,
	token: string,
	base: string,
	abortSignal?: AbortSignal,
): Promise<UploadResult> {
	let bytes: ArrayBuffer;
	let contentType: string;
	try {
		const imgRes = await fetch(url, {
			signal: abortSignal
				? AbortSignal.any([abortSignal, AbortSignal.timeout(15_000)])
				: AbortSignal.timeout(15_000),
		});
		if (!imgRes.ok) {
			return { url, success: false, error: `Could not fetch image: HTTP ${imgRes.status}` };
		}
		contentType = imgRes.headers.get("content-type") ?? "application/octet-stream";
		bytes = await imgRes.arrayBuffer();
	} catch (err) {
		return {
			url,
			success: false,
			error: `Could not fetch image: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (abortSignal?.aborted) return { url, success: false, error: "Upload stopped." };
	const safeName = (filename ?? "image").replace(/[^A-Za-z0-9._-]/g, "_");
	const form = new FormData();
	form.append("file", new File([bytes], safeName, { type: contentType }));
	let upRes: Response;
	let text: string;
	try {
		upRes = await fetch(`${base}_emdash/api/media`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: form,
			signal: abortSignal
				? AbortSignal.any([abortSignal, AbortSignal.timeout(20_000)])
				: AbortSignal.timeout(20_000),
		});
		text = await upRes.text();
	} catch (err) {
		return {
			url,
			success: false,
			error: `Upload request failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (!upRes.ok) {
		return {
			url,
			success: false,
			error: `Upload failed: HTTP ${upRes.status} ${text.slice(0, 300)}`,
		};
	}
	try {
		const parsed = JSON.parse(text) as {
			item?: { id?: string; width?: number; height?: number };
			data?: { item?: { id?: string; width?: number; height?: number } };
		};
		const item = parsed.item ?? parsed.data?.item;
		const id = item?.id;
		if (!id) {
			return { url, success: false, error: `Unexpected upload response: ${text.slice(0, 300)}` };
		}
		return {
			url,
			success: true,
			mediaId: id,
			width: item?.width,
			height: item?.height,
			fieldValue: { id, provider: "local", ...(alt ? { alt } : {}) },
		};
	} catch {
		return { url, success: false, error: `Could not parse upload response: ${text.slice(0, 300)}` };
	}
}

/**
 * Creates the tool set, closing over the sandbox instance.
 * Called once per onChatMessage invocation.
 */
export function createTools(
	sandboxSource: SandboxInstance | (() => SandboxInstance),
	callbacks: ToolCallbacks,
	options: ToolOptions = {},
) {
	const currentSandbox = () =>
		typeof sandboxSource === "function" ? sandboxSource() : sandboxSource;
	const runSandboxRead =
		callbacks.runSandboxRead ??
		(<T>(operation: (sandbox: SandboxInstance) => Promise<T>) => operation(currentSandbox()));
	const convergence = options.convergence ?? new BuildConvergence(options.abortSignal);
	// AI SDK 6 converts an intermediate tool result twice: once for the
	// completed step and once for the next model request. Retain each image for
	// both conversions, then release it. The result itself only contains a UUID,
	// so screenshot bytes are never persisted in chat history. The optional
	// callback keeps a bounded copy separately for the details UI.
	const previewShots = new Map<
		string,
		{
			base64: string;
			mediaType: string;
			revision: number;
			conversions: number;
			modelOutput?: PreviewModelOutput;
		}
	>();
	const previewAcknowledgements = new Set<string>();
	let exploratoryPreviewImagesDelivered = 0;
	const readFilesQueue = new SerialTaskQueue();
	const validationQueue = new SerialTaskQueue();
	const previewQueue = new SerialTaskQueue();
	const trackedMutation = async <T>(
		operation: () => Promise<T>,
		key?: string,
		cacheResult: (result: T) => boolean = () => true,
	): Promise<T> => convergence.runMutation(operation, { key, cacheResult });
	return {
		read_file: tool({
			description:
				"Read a file from the site. Path is relative to the site root " +
				"(e.g. 'src/styles/global.css', 'astro.config.mjs'). " +
				"Use this before edit_file, or read_files before edit_files, to see the current contents.",
			inputSchema: z.object({
				path: z.string().describe("File path relative to the site root"),
			}),
			execute: async ({ path }) => {
				options.abortSignal?.throwIfAborted();
				try {
					const canonical = canonicalizeSiteReadPath(path);
					if (isDevVarsPath(canonical.path)) {
						return {
							success: false as const,
							error: `${canonical.path} holds builder-managed runtime settings and is not readable.`,
						};
					}
					const file = await runSandboxRead((sandbox) =>
						sandbox.readFile(canonical.fullPath, { encoding: "utf-8" }),
					);
					if (!file.success) {
						return {
							success: false as const,
							error: `Could not read ${canonical.path}`,
						};
					}
					return {
						success: true as const,
						path: canonical.path,
						content: file.content,
					};
				} catch (err) {
					return {
						success: false as const,
						error: `Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			},
		}),

		read_files: tool({
			description:
				"Read several independent text source files concurrently. Paths are relative to the site " +
				"root. Use one call for source inspection that does not depend on earlier reads. Returns " +
				"per-file results in input order; runtime, generated, dependency, and secret paths are excluded.",
			inputSchema: z.object({
				paths: z
					.array(z.string())
					.min(1)
					.max(READ_FILES_MAX_PATHS)
					.describe("Unique site-relative source file paths"),
			}),
			execute: async ({ paths }, { abortSignal }) =>
				readFilesQueue.run(() => {
					if (!options.streamFile) {
						return Promise.resolve(
							invalidBatch(paths, new Error("Sandbox file streaming is unavailable.")),
						);
					}
					if (abortSignal?.aborted) {
						return Promise.resolve(
							invalidBatch(paths, new Error("Read was stopped before it started.")),
						);
					}
					return runSandboxRead((sandbox) =>
						readFilesFromSandbox(sandbox, paths, {
							streamFile: options.streamFile!,
							signal: abortSignal,
						}),
					);
				}),
		}),

		write_file: tool({
			description:
				"Write or overwrite a file in the site. Path is relative to the site root. " +
				"The dev server picks up changes to .astro and .css files and the preview reloads. " +
				"Builder-managed files (src/worker.ts, src/live.config.ts, wrangler.jsonc, .dev.vars, AGENTS.md) are protected.",
			inputSchema: z.object({
				path: z.string().describe("File path relative to the site root"),
				content: z.string().describe("The full file content to write"),
			}),
			execute: async ({ path: requestedPath, content }) => {
				let path: string;
				let fullPath: string;
				try {
					({ path, fullPath } = canonicalizeSiteReadPath(requestedPath));
				} catch (err) {
					return {
						success: false as const,
						changed: false as const,
						error: `Could not write ${requestedPath}: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
				if (isProtectedSitePath(path)) {
					return {
						success: false as const,
						changed: false as const,
						error: protectedFileError(path),
					};
				}
				if (path === "astro.config.mjs") {
					return {
						success: false as const,
						changed: false as const,
						error:
							"Whole-file writes to astro.config.mjs are blocked because they can remove builder runtime settings. Read it, then use edit_file for targeted font/config changes; config edits restart and validate automatically.",
					};
				}
				return convergence.runConditionalMutation<FileMutationResult>(
					async () => {
						try {
							const existing = await currentSandbox().readFile(fullPath, { encoding: "utf-8" });
							if (existing.success && existing.content === content) {
								return {
									changed: false as const,
									result: {
										success: true as const,
										changed: false as const,
										path,
										message: `${path} already has the requested content`,
									},
								};
							}
						} catch {
							// A missing/unreadable destination is handled by the write below.
						}
						return {
							changed: true as const,
							operation: async () => {
								try {
									await currentSandbox().writeFile(fullPath, content);
									if (isHotReloadFile(path)) await settleHotReload();
									else await waitForDevServer(currentSandbox());
									await callbacks.reloadPreview();
									await callbacks.checkpointSite();
									return {
										success: true as const,
										changed: true as const,
										path,
										message: `Wrote ${path}`,
									};
								} catch (err) {
									return {
										success: false as const,
										changed: true as const,
										error: `Could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
									};
								}
							},
						};
					},
					{ key: mutationKey("write_file", { path, content }) },
				);
			},
		}),

		write_files: tool({
			description:
				"Write or overwrite 2-12 independent source files as one coherent batch. Use this when several planned components, pages, layouts, or styles are ready together. All paths are validated before writing, then the preview reloads and Artifacts checkpoints once for the whole batch. Use write_file for one file and edit_file for targeted follow-up changes. Builder-managed files and astro.config.mjs are protected.",
			inputSchema: z.object({
				files: z
					.array(
						z.object({
							path: z.string().describe("File path relative to the site root"),
							content: z.string().describe("The full file content to write"),
						}),
					)
					.min(2)
					.max(WRITE_FILES_MAX_PATHS),
			}),
			execute: async ({ files: requestedFiles }) => {
				let files: Array<{ path: string; fullPath: string; content: string }>;
				try {
					const seen = new Set<string>();
					let bytes = 0;
					files = requestedFiles.map(({ path: requestedPath, content }) => {
						const { path, fullPath } = canonicalizeSiteReadPath(requestedPath);
						if (seen.has(path)) throw new Error(`Duplicate file path: ${path}`);
						seen.add(path);
						if (isProtectedSitePath(path)) throw new Error(protectedFileError(path));
						if (path === "astro.config.mjs") {
							throw new Error(
								"astro.config.mjs cannot be batch-written. Read it, then use edit_file for a targeted change.",
							);
						}
						bytes += new TextEncoder().encode(content).byteLength;
						if (bytes > WRITE_FILES_MAX_BYTES) {
							throw new Error("Batch content exceeds the 192 KiB limit.");
						}
						return { path, fullPath, content };
					});
				} catch (err) {
					return {
						success: false as const,
						changed: false as const,
						error: `Could not write file batch: ${err instanceof Error ? err.message : String(err)}`,
					};
				}

				return convergence.runConditionalMutation<BatchFileMutationResult>(
					async () => {
						const originals: Array<{
							path: string;
							fullPath: string;
							content: string;
							existed: boolean;
							original?: string;
						}> = [];
						for (const file of files) {
							options.abortSignal?.throwIfAborted();
							let current: Awaited<ReturnType<SandboxInstance["readFile"]>>;
							try {
								current = await currentSandbox().readFile(file.fullPath, {
									encoding: "utf-8",
								});
							} catch (err) {
								if (isSandboxFileNotFound(err)) {
									originals.push({ ...file, existed: false });
									continue;
								}
								return {
									changed: false as const,
									result: {
										success: false as const,
										changed: false as const,
										error: `Could not read ${file.path}: ${err instanceof Error ? err.message : String(err)}`,
									},
								};
							}
							originals.push({
								...file,
								existed: current.success,
								...(current.success ? { original: current.content } : {}),
							});
						}
						const changed = originals.filter(
							(file) => !file.existed || file.original !== file.content,
						);
						if (changed.length === 0) {
							return {
								changed: false as const,
								result: {
									success: true as const,
									changed: false as const,
									files: originals.map(({ path }) => ({ path, changed: false })),
									message: "All files already have the requested content",
								},
							};
						}

						return {
							changed: true as const,
							operation: async () => {
								const attempted: typeof changed = [];
								try {
									for (const file of changed) {
										options.abortSignal?.throwIfAborted();
										attempted.push(file);
										const result = await currentSandbox().writeFile(file.fullPath, file.content);
										if (!result.success) throw new Error(`Could not write ${file.path}`);
									}
								} catch (err) {
									const rollbackErrors: string[] = [];
									for (const file of attempted.reverse()) {
										try {
											if (file.existed) {
												const result = await currentSandbox().writeFile(
													file.fullPath,
													file.original ?? "",
												);
												if (!result.success) throw new Error("restore failed");
											} else {
												const result = await currentSandbox().deleteFile(file.fullPath);
												if (!result.success) throw new Error("delete failed");
											}
										} catch {
											rollbackErrors.push(file.path);
										}
									}
									return {
										success: false as const,
										changed: true as const,
										error: `Could not write file batch: ${err instanceof Error ? err.message : String(err)}${rollbackErrors.length > 0 ? `. Rollback failed for: ${rollbackErrors.join(", ")}` : ". Earlier writes were rolled back."}`,
									};
								}

								try {
									if (changed.every((file) => isHotReloadFile(file.path))) await settleHotReload();
									else await waitForDevServer(currentSandbox());
									await callbacks.reloadPreview();
									await callbacks.checkpointSite();
									return {
										success: true as const,
										changed: true as const,
										files: originals.map(({ path, content, original, existed }) => ({
											path,
											changed: !existed || original !== content,
										})),
										message: `Wrote ${changed.length} files`,
									};
								} catch (err) {
									return {
										success: false as const,
										changed: true as const,
										error: `Files were written, but preview refresh or checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
									};
								}
							},
						};
					},
					{ key: mutationKey("write_files", { files }) },
				);
			},
		}),

		edit_file: tool({
			description:
				"Apply a search-and-replace edit to a file. You MUST read_file first to see the current " +
				"contents. Provide the exact text to find (oldText) and the replacement (newText); " +
				"oldText must match exactly one place, so include enough surrounding text. " +
				"This is much faster than rewriting entire files -- use it for CSS variable changes, " +
				"config tweaks, or any targeted edit. The oldText must match exactly (including whitespace). " +
				"Editing astro.config.mjs restarts and validates the dev server automatically; do not call restart_dev_server too.",
			inputSchema: z.object({
				path: z.string().describe("File path relative to the site root"),
				oldText: z.string().describe("Exact text to find in the file"),
				newText: z.string().describe("Text to replace it with"),
			}),
			execute: async ({ path: requestedPath, oldText, newText }) => {
				let path: string;
				let fullPath: string;
				try {
					({ path, fullPath } = canonicalizeSiteReadPath(requestedPath));
				} catch (err) {
					return {
						success: false as const,
						changed: false as const,
						error: `Could not edit ${requestedPath}: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
				if (isProtectedSitePath(path)) {
					return {
						success: false as const,
						changed: false as const,
						error: protectedFileError(path),
					};
				}
				if (oldText.length === 0) {
					return {
						success: false as const,
						changed: false as const,
						error:
							"oldText must not be empty. Include the exact text to replace, or use write_file for a whole file.",
					};
				}
				return convergence.runConditionalMutation<FileMutationResult>(
					async () => {
						let file: Awaited<ReturnType<SandboxInstance["readFile"]>>;
						try {
							file = await currentSandbox().readFile(fullPath, { encoding: "utf-8" });
						} catch (err) {
							return {
								changed: false as const,
								result: {
									success: false as const,
									changed: false as const,
									error: `Could not edit ${path}: ${err instanceof Error ? err.message : String(err)}`,
								},
							};
						}
						const start = file.success ? file.content.indexOf(oldText) : -1;
						if (!file.success || start === -1 || hasSecondMatch(file.content, start, oldText)) {
							return {
								changed: false as const,
								result: {
									success: false as const,
									changed: false as const,
									error: !file.success
										? `Could not read ${path}. Use read_file first to verify it exists.`
										: start === -1
											? `Could not find the specified text in ${path}. Use read_file to check the current contents.`
											: `The specified text matches more than one place in ${path}. Include more surrounding text so it matches exactly one.`,
								},
							};
						}
						// Splice rather than String#replace, which expands `$&`, `$$`, etc.
						const updated =
							file.content.slice(0, start) + newText + file.content.slice(start + oldText.length);
						if (updated === file.content) {
							return {
								changed: false as const,
								result: {
									success: true as const,
									changed: false as const,
									path,
									message: `${path} already has the requested edit`,
								},
							};
						}
						return {
							changed: true as const,
							operation: async () => {
								try {
									await currentSandbox().writeFile(fullPath, updated);
									if (path === "astro.config.mjs") {
										const restarted = await callbacks.restartDevServer();
										if (!restarted.success) {
											await currentSandbox().writeFile(fullPath, file.content);
											const restored = await callbacks.restartDevServer();
											return {
												success: false as const,
												changed: true as const,
												error: restored.success
													? `The config edit failed to start the preview and was rolled back: ${restarted.error ?? "unknown error"}`
													: `The config edit failed and rollback could not restart the preview: ${restarted.error ?? "unknown error"}; rollback: ${restored.error ?? "unknown error"}`,
											};
										}
									} else {
										if (isHotReloadFile(path)) await settleHotReload();
										else await waitForDevServer(currentSandbox());
									}
									if (path !== "astro.config.mjs") await callbacks.reloadPreview();
									await callbacks.checkpointSite();
									return {
										success: true as const,
										changed: true as const,
										path,
										message: `Edited ${path}`,
									};
								} catch (err) {
									return {
										success: false as const,
										changed: true as const,
										error: `Could not edit ${path}: ${err instanceof Error ? err.message : String(err)}`,
									};
								}
							},
						};
					},
					{ key: mutationKey("edit_file", { path, oldText, newText }) },
				);
			},
		}),

		edit_files: tool({
			description:
				"Apply 2-12 independent exact replacements across one or more current source files as one atomic batch. " +
				"Read every affected file first. Multiple replacements may target the same path and are preflighted in order. Every oldText is validated before any file is written; a write failure rolls the batch back. " +
				"The preview reloads and Artifacts checkpoints once for the whole batch. Use edit_file for one file or astro.config.mjs, and do not batch edits whose contents depend on an earlier mutation.",
			inputSchema: z.object({
				edits: z
					.array(
						z.object({
							path: z.string().describe("File path relative to the site root"),
							oldText: z.string().describe("Exact text to find once in the current file"),
							newText: z.string().describe("Text to replace it with"),
						}),
					)
					.min(2)
					.max(EDIT_FILES_MAX_EDITS),
			}),
			execute: async ({ edits: requestedEdits }) => {
				let edits: Array<{
					path: string;
					fullPath: string;
					oldText: string;
					newText: string;
				}>;
				try {
					let bytes = 0;
					edits = requestedEdits.map(({ path: requestedPath, oldText, newText }) => {
						const { path, fullPath } = canonicalizeSiteReadPath(requestedPath);
						if (isProtectedSitePath(path)) throw new Error(protectedFileError(path));
						if (path === "astro.config.mjs") {
							throw new Error(
								"astro.config.mjs cannot be batch-edited. Use edit_file so the preview restart is validated.",
							);
						}
						if (oldText.length === 0) {
							throw new Error(`oldText must not be empty for ${path}.`);
						}
						bytes += new TextEncoder().encode(oldText).byteLength;
						bytes += new TextEncoder().encode(newText).byteLength;
						if (bytes > EDIT_FILES_MAX_BYTES) {
							throw new Error("Batch replacements exceed the 192 KiB limit.");
						}
						return { path, fullPath, oldText, newText };
					});
				} catch (err) {
					return {
						success: false as const,
						changed: false as const,
						error: `Could not edit file batch: ${err instanceof Error ? err.message : String(err)}`,
					};
				}

				return convergence.runConditionalMutation<BatchFileMutationResult>(
					async () => {
						const prepared = new Map<
							string,
							{
								path: string;
								fullPath: string;
								original: string;
								updated: string;
							}
						>();
						for (const edit of edits) {
							options.abortSignal?.throwIfAborted();
							let file = prepared.get(edit.path);
							if (!file) {
								let current: Awaited<ReturnType<SandboxInstance["readFile"]>>;
								try {
									current = await currentSandbox().readFile(edit.fullPath, { encoding: "utf-8" });
								} catch (err) {
									return {
										changed: false as const,
										result: {
											success: false as const,
											changed: false as const,
											error: `Could not edit ${edit.path}: ${err instanceof Error ? err.message : String(err)}`,
										},
									};
								}
								if (!current.success) {
									return {
										changed: false as const,
										result: {
											success: false as const,
											changed: false as const,
											error: `Could not read ${edit.path}. Use read_files first to verify it exists.`,
										},
									};
								}
								file = {
									path: edit.path,
									fullPath: edit.fullPath,
									original: current.content,
									updated: current.content,
								};
								prepared.set(edit.path, file);
							}
							const start = file.updated.indexOf(edit.oldText);
							if (start === -1 || hasSecondMatch(file.updated, start, edit.oldText)) {
								return {
									changed: false as const,
									result: {
										success: false as const,
										changed: false as const,
										error:
											start === -1
												? `Could not find the specified text in ${edit.path}. Use read_files to check the current contents.`
												: `The specified text matches more than one place in ${edit.path}. Include more surrounding text so it matches exactly one.`,
									},
								};
							}
							file.updated =
								file.updated.slice(0, start) +
								edit.newText +
								file.updated.slice(start + edit.oldText.length);
						}

						const preparedFiles = [...prepared.values()];
						const changed = preparedFiles.filter((file) => file.updated !== file.original);
						if (changed.length === 0) {
							return {
								changed: false as const,
								result: {
									success: true as const,
									changed: false as const,
									files: preparedFiles.map(({ path }) => ({ path, changed: false })),
									message: "All files already have the requested edits",
								},
							};
						}

						return {
							changed: true as const,
							operation: async () => {
								const attempted: typeof changed = [];
								try {
									for (const file of changed) {
										options.abortSignal?.throwIfAborted();
										attempted.push(file);
										const result = await currentSandbox().writeFile(file.fullPath, file.updated);
										if (!result.success) throw new Error(`Could not write ${file.path}`);
									}
								} catch (err) {
									const rollbackErrors: string[] = [];
									for (const file of attempted.reverse()) {
										try {
											const result = await currentSandbox().writeFile(file.fullPath, file.original);
											if (!result.success) throw new Error("restore failed");
										} catch {
											rollbackErrors.push(file.path);
										}
									}
									return {
										success: false as const,
										changed: true as const,
										error: `Could not edit file batch: ${err instanceof Error ? err.message : String(err)}${rollbackErrors.length > 0 ? `. Rollback failed for: ${rollbackErrors.join(", ")}` : ". Earlier edits were rolled back."}`,
									};
								}

								try {
									if (changed.every((file) => isHotReloadFile(file.path))) await settleHotReload();
									else await waitForDevServer(currentSandbox());
									await callbacks.reloadPreview();
									await callbacks.checkpointSite();
									return {
										success: true as const,
										changed: true as const,
										files: preparedFiles.map(({ path, original, updated }) => ({
											path,
											changed: original !== updated,
										})),
										message: `Edited ${changed.length} files`,
									};
								} catch (err) {
									return {
										success: false as const,
										changed: true as const,
										error: `Files were edited, but preview refresh or checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
									};
								}
							},
						};
					},
					{ key: mutationKey("edit_files", { edits }) },
				);
			},
		}),

		exec: tool({
			description:
				"Run a shell command in the sandbox. Working directory is the site root. " +
				"Use for: checking the site (curl localhost:4321), debugging, inspecting files, etc. " +
				"Commands are terminated after 12 seconds so a hung process cannot block later tools. " +
				"Builder-managed files are restored if a command changes them.",
			inputSchema: z.object({
				command: z.string().describe("The shell command to execute"),
			}),
			execute: async ({ command }) => {
				// The step's allowed tools already exclude exec here; refuse too in case
				// the provider ignored them, since the command would void validation.
				if (convergence.hasCurrentValidation()) {
					return {
						success: false as const,
						error:
							"The current revision already passed validation, and a shell command would void it. Make a real source or CMS change, or finish.",
					};
				}
				return trackedMutation(async () => {
					// The SDK request timeout does not reliably kill a child process. A
					// hung curl then owns the default command session and every later exec
					// queues behind it. Enforce the deadline inside the container and leave
					// a small outer margin for the termination result to cross RPC.
					const boundedCommand =
						`timeout --signal=TERM --kill-after=2s 12s ` + `bash -lc ${shellQuote(command)}`;
					const result = await currentSandbox().exec(guardProtectedFiles(boundedCommand), {
						cwd: SITE_PATH,
						timeout: 17000,
						signal: options.abortSignal,
					});
					const notices = protectedFileNotices(result.stderr);
					return {
						success: result.success,
						exitCode: result.exitCode,
						stdout: result.stdout.slice(0, 3000),
						stderr: result.stderr.slice(0, 1000),
						...(notices.length > 0 && {
							protectedFiles: notices,
							note: "Builder-managed files must not be modified; see protectedFiles.",
						}),
					};
				});
			},
		}),

		refresh_types: tool({
			description:
				"Regenerate emdash-env.d.ts from the live expanded schema after creating or changing collections, fields, or block types, " +
				"and return its declarations. Call this once after a coherent schema pass; apply_schema_plan already does it. " +
				"Use the returned names exactly and never hand-author replacement block unions.",
			inputSchema: z.object({}),
			execute: async () =>
				trackedMutation(async () => {
					const result = await runSandboxRead((sandbox) =>
						refreshLiveTypes(sandbox, options.abortSignal),
					);
					if (result.success) await callbacks.checkpointSite();
					return {
						success: result.success,
						exitCode: result.exitCode,
						stdout: result.stdout.slice(0, 4000),
						stderr: result.stderr.slice(0, 2000),
						...(result.generatedFile ? { generatedFile: result.generatedFile } : {}),
						...(result.success && result.declarations
							? typeDeclarationsForModel(result.declarations)
							: {}),
					};
				}),
		}),

		validate_site: tool({
			description:
				"Validate the generated public site before completion. Runs the template's frontend boundary " +
				"check (no React/JSX/client hydration on public routes), Astro typecheck, and a rendered crawl " +
				"that rejects the blank scaffold and broken internal links. Fix every reported source or route " +
				"error, then call this again until it succeeds.",
			inputSchema: z.object({}),
			execute: async () =>
				validationQueue.run(async () => {
					options.abortSignal?.throwIfAborted();
					const cached = convergence.currentValidationResult<{
						success: boolean;
						exitCode: number;
						stdout: string;
						stderr: string;
						publicSiteAudit?: PublicSiteAuditResult;
						blockRendererValidation?: BlockRendererValidationResult;
					}>();
					if (cached) {
						return {
							...cached,
							cached: true as const,
							message: cached.success
								? "The current site revision already passed validation."
								: "The current site revision has the same validation errors. Change the site before validating again.",
						};
					}

					const observation = convergence.beginObservation();
					if (!observation) {
						return {
							success: false as const,
							retryable: true as const,
							error: "The site is still changing. Retry validation after the mutation finishes.",
						};
					}

					const result = await runSandboxRead((sandbox) =>
						sandbox.exec("pnpm validate", {
							cwd: SITE_PATH,
							timeout: 120_000,
							signal: options.abortSignal,
						}),
					);
					const blockRendererValidation =
						result.success && callbacks.validateBlockContracts
							? await runSandboxRead((sandbox) => callbacks.validateBlockContracts!(sandbox))
							: undefined;
					const publicSiteAudit =
						result.success && blockRendererValidation?.success !== false
							? await runSandboxRead((sandbox) => auditSandboxPublicSite(sandbox))
							: undefined;
					const success =
						result.success &&
						blockRendererValidation?.success !== false &&
						publicSiteAudit?.success === true;
					const renderErrors =
						publicSiteAudit && !publicSiteAudit.success
							? (callbacks.getRecentRenderErrors?.() ?? [])
							: [];
					const output = {
						success,
						exitCode: success ? 0 : result.exitCode || 1,
						stdout: [
							result.stdout.slice(0, 6000),
							publicSiteAudit?.success
								? `Rendered public-site audit passed for ${publicSiteAudit.checkedPaths.length} route(s).`
								: "",
						]
							.filter(Boolean)
							.join("\n"),
						stderr: [
							result.stderr.slice(0, 4000),
							blockRendererValidation && !blockRendererValidation.success
								? `Block renderer validation failed:\n${blockRendererValidation.issues.map((issue) => `- ${issue}`).join("\n")}`
								: "",
							publicSiteAudit && !publicSiteAudit.success
								? `Rendered public-site audit failed:\n${formatPublicSiteIssues(publicSiteAudit)}`
								: "",
							renderErrors.length > 0
								? `Recent dev-server render error (confirm it still applies):\n${renderErrors.join("\n")}`
								: "",
						]
							.filter(Boolean)
							.join("\n"),
						...(publicSiteAudit ? { publicSiteAudit } : {}),
						...(blockRendererValidation ? { blockRendererValidation } : {}),
					};
					if (!convergence.recordValidationResult(observation, output, success)) {
						return {
							success: false as const,
							retryable: true as const,
							error: "The site changed during validation. Retry against the current revision.",
						};
					}
					return output;
				}),
		}),

		search_unsplash: tool({
			description:
				"Search Unsplash for photos by keyword. Returns real photo URLs, descriptions, " +
				"and photographer credits. Use these URLs in content for image references. " +
				"Always search rather than guessing photo IDs.",
			inputSchema: z.object({
				query: z.string().describe("Search query (e.g. 'iceland landscape')"),
				count: z.number().optional().default(5).describe("Number of results (1-10, default 5)"),
			}),
			execute: async ({ query, count }) => {
				options.abortSignal?.throwIfAborted();
				const n = Math.min(Math.max(count, 1), 10);
				const key = options.unsplashAccessKey;
				if (!key) {
					return {
						success: false as const,
						error: "UNSPLASH_ACCESS_KEY is not configured on the worker.",
					};
				}
				const url = new URL("https://api.unsplash.com/search/photos");
				url.searchParams.set("query", query);
				url.searchParams.set("per_page", String(n));
				const res = await fetch(url, {
					headers: { Authorization: `Client-ID ${key}` },
					signal: options.abortSignal,
				});
				if (!res.ok) {
					return {
						success: false as const,
						error: `Unsplash API error ${res.status}: ${await res.text()}`,
					};
				}
				const data = (await res.json()) as UnsplashSearchResponse;
				const photos = data.results.map((p) => ({
					id: p.id,
					description: p.description ?? p.alt_description ?? "",
					url: `${p.urls.raw}&w=1200&h=800&fit=crop&auto=format`,
					thumb: `${p.urls.raw}&w=400&h=300&fit=crop&auto=format`,
					photographer: p.user.name,
					photographerUrl: `https://unsplash.com/@${p.user.username}`,
				}));
				return { success: true as const, query, count: photos.length, photos };
			},
		}),

		upload_media: tool({
			description:
				"Download one or more images from URLs (e.g. those returned by search_unsplash) and " +
				"register them as CMS media items. Pass ALL the images you need in a single call via the " +
				"`images` array -- do NOT call this once per image. Image/file fields do NOT accept raw " +
				"URLs: each result includes a `fieldValue` " +
				'({ "id": "<mediaId>", "provider": "local", "alt": "..." }) to put in the entry\'s image ' +
				"field when calling content_create/content_update. Results come back in input order and " +
				"echo each `url` so you can match them to the right entry.",
			inputSchema: z.object({
				images: z
					.array(
						z.object({
							url: z.string().describe("Direct image URL to download"),
							filename: z
								.string()
								.optional()
								.describe("Filename to store it as, e.g. 'hero.jpg' (default 'image')"),
							alt: z.string().optional().describe("Alt text describing the image"),
						}),
					)
					.min(1)
					.describe("All images to upload in this call"),
			}),
			execute: async ({ images }) => {
				const token = options.apiToken;
				const base = options.cmsBaseUrl;
				if (!token || !base) {
					return {
						success: false as const,
						changed: false as const,
						error: "Media upload is unavailable (no CMS token/URL).",
					};
				}
				return trackedMutation(
					async () => {
						// Bounded concurrency (not unbounded Promise.all): each upload
						// writes to D1 + R2 through the single dev server, and hammering
						// the media endpoint trips the Vite SSR reload. A small width
						// overlaps the fetch+upload latency without swamping it. Errors
						// are per-image, not fatal; `mapLimit` preserves input order.
						let uploaded = 0;
						try {
							const results = await mapLimit(images, 2, async (img) => {
								if (options.abortSignal?.aborted) {
									return { url: img.url, success: false as const, error: "Upload stopped." };
								}
								const result = await uploadOneMedia(
									img.url,
									img.filename,
									img.alt,
									token,
									base,
									options.abortSignal,
								);
								if (result.success) uploaded++;
								return result;
							});
							options.abortSignal?.throwIfAborted();
							for (const [index, result] of results.entries()) {
								const image = images[index]!;
								const identity = image.filename?.trim() || image.alt?.trim() || image.url;
								const failureKey = `media\0${identity}`;
								if (result.success) {
									convergence.resolveUnresolvedFailure(failureKey);
								} else {
									convergence.recordUnresolvedFailure({
										key: failureKey,
										toolName: "upload_media",
										error: `${identity}: ${result.error}`,
									});
								}
							}
							return { success: uploaded > 0, count: results.length, uploaded, results };
						} finally {
							if (uploaded > 0) await callbacks.checkpointSite();
						}
					},
					mutationKey("upload_media", { images }),
					(result) => result.success && result.uploaded === result.count,
				);
			},
		}),

		restart_dev_server: tool({
			description:
				"Cleanly restart the site's dev server. Use this ONLY after installing a new dependency " +
				"with `pnpm add` that the running server needs to pick up, or if the preview is genuinely " +
				"stuck. Config edits restart automatically, so do not call this after editing astro.config.mjs. " +
				"It takes a few seconds. Do NOT use it for transient tool errors (those self-heal) " +
				"and never start or kill the dev server yourself with `exec`.",
			inputSchema: z.object({}),
			execute: async () =>
				trackedMutation(async () => {
					options.abortSignal?.throwIfAborted();
					const restarted = await callbacks.restartDevServer();
					options.abortSignal?.throwIfAborted();
					if (restarted.success) await callbacks.checkpointSite();
					return restarted;
				}),
		}),

		view_preview: tool({
			description:
				"Look at the live preview: capture a screenshot of the site as it renders right now and " +
				"see it yourself. Use this after making design or content changes to check your work -- " +
				"verify layout, spacing and alignment, colour and contrast, that images actually loaded, " +
				"that no section is empty or broken, and that the result matches the brief. Call it before " +
				"telling the user the site is ready. Fix anything that looks off, then look again.",
			inputSchema: z.object({}),
			execute: async () =>
				previewQueue.run(async () => {
					options.abortSignal?.throwIfAborted();
					const observation = convergence.beginObservation();
					if (!observation) {
						return {
							success: false as const,
							retryable: true as const,
							error: "The site is still changing. Retry the preview after the mutation finishes.",
						};
					}
					if (convergence.hasCurrentPreviewCapture()) {
						return {
							success: true as const,
							cached: true as const,
							revision: observation.revision,
							acknowledgementId: crypto.randomUUID(),
							message: "The current site revision already has a preview capture.",
						};
					}
					const maxPreviewImages = options.maxPreviewImages ?? 1;
					if (
						!convergence.hasCurrentValidation() &&
						exploratoryPreviewImagesDelivered >= maxPreviewImages
					) {
						return {
							success: true as const,
							skipped: true as const,
							message:
								"The exploratory screenshot budget is full. Validate first, then request the final preview.",
						};
					}
					const shot = await callbacks.capturePreview();
					if (!shot.ok) return { success: false as const, error: shot.error };
					if (!convergence.recordPreviewCapture(observation)) {
						return {
							success: false as const,
							retryable: true as const,
							error: "The site changed during preview capture. Retry the current revision.",
						};
					}
					const shotId = crypto.randomUUID();
					try {
						callbacks.savePreviewThumbnail?.(shotId, {
							base64: shot.base64,
							mediaType: shot.mediaType,
						});
					} catch {
						console.warn("Could not retain preview thumbnail");
					}
					previewShots.set(shotId, {
						base64: shot.base64,
						mediaType: shot.mediaType,
						revision: observation.revision,
						conversions: 0,
					});
					return { success: true as const, shotId, revision: observation.revision };
				}),
			// Hand the first-build screenshot to the multimodal coordinator,
			// not as JSON. `file-data` carries base64 image bytes inline.
			toModelOutput: ({ output }) => {
				const o = output as
					| { success: true; shotId: string; revision: number }
					| { success: true; skipped: true; message: string }
					| {
							success: true;
							cached: true;
							revision: number;
							acknowledgementId: string;
							message: string;
					  }
					| { success: false; error: string };
				if (!o.success) {
					return { type: "error-text" as const, value: o.error };
				}
				if ("skipped" in o) {
					return { type: "text" as const, value: o.message };
				}
				if ("cached" in o) {
					if (!convergence.isObservationCurrent({ revision: o.revision })) {
						return {
							type: "error-text" as const,
							value: "The site changed before the cached preview could be used. Capture it again.",
						};
					}
					if (!previewAcknowledgements.has(o.acknowledgementId)) {
						previewAcknowledgements.add(o.acknowledgementId);
						if (convergence.hasCurrentPreviewDelivery()) {
							convergence.recordPreviewDelivery(o.revision);
						}
					}
					return {
						type: "text" as const,
						value:
							"No new screenshot was captured because the site has not changed. Use the current preview; do not call view_preview again unless you make a real change.",
					};
				}
				const shot = previewShots.get(o.shotId);
				if (!shot) {
					return {
						type: "error-text" as const,
						value:
							"The preview screenshot could not be attached. Capture the current revision again.",
					};
				}
				if (!convergence.isObservationCurrent({ revision: shot.revision })) {
					previewShots.delete(o.shotId);
					return {
						type: "error-text" as const,
						value: "The site changed before the screenshot could be attached. Capture it again.",
					};
				}
				if (shot.modelOutput) {
					shot.conversions += 1;
					const converted = shot.modelOutput;
					if (shot.conversions >= 2) previewShots.delete(o.shotId);
					return converted;
				}
				shot.conversions += 1;
				const maxPreviewImages = options.maxPreviewImages ?? 1;
				const isFinalPreview = convergence.hasCurrentValidation();
				const canDeliverExploratory = exploratoryPreviewImagesDelivered < maxPreviewImages;
				if (!options.previewImagesEnabled || (!isFinalPreview && !canDeliverExploratory)) {
					shot.modelOutput = {
						type: "text" as const,
						value:
							"The exploratory screenshot budget is full. Validate the current revision, then call view_preview once for the final image.",
					};
					if (shot.conversions >= 2) previewShots.delete(o.shotId);
					return shot.modelOutput;
				}
				if (!isFinalPreview && shot.conversions === 1) exploratoryPreviewImagesDelivered += 1;
				const converted: PreviewModelOutput = {
					type: "content" as const,
					value: [
						{
							type: "text" as const,
							text: "Current preview screenshot. Review layout, spacing, alignment, colour/contrast, whether images loaded, any empty or broken sections, and how well it matches the brief. If anything looks off, fix it and look again.",
						},
						{ type: "file-data" as const, data: shot.base64, mediaType: shot.mediaType },
					],
				};
				shot.modelOutput = converted;
				if (shot.conversions >= 2) previewShots.delete(o.shotId);
				return converted;
			},
		}),

		offer_clone: tool({
			description:
				"Reveal the 'Clone locally' panel in the UI, which shows the user a git command to " +
				"download the site's source and run it on their own machine. Call this when the user " +
				"wants to get the code, edit the site themselves, run or host it elsewhere, add custom " +
				"code the builder cannot do, or otherwise take the project with them. It exposes no " +
				"secret to you and persists nothing. After calling it, briefly tell the user the panel " +
				"is now available, that the local copy includes their content and media, and that they " +
				"need Node and pnpm installed to run it.",
			inputSchema: z.object({}),
			execute: async () => {
				options.abortSignal?.throwIfAborted();
				return callbacks.offerClone();
			},
		}),
	};
}
