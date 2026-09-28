/**
 * BuilderAgent Durable Object.
 *
 * Extends AIChatAgent to get automatic message persistence,
 * resumable streaming, and useAgentChat compatibility on the client.
 *
 * Owns a sandbox container where the EmDash site runs.
 */

import { AIChatAgent } from "@cloudflare/ai-chat";
import type {
	ChatRecoveryContext,
	ChatRecoveryOptions,
	ChatResponseResult,
	OnChatMessageOptions,
} from "@cloudflare/ai-chat";
import {
	callable,
	getCurrentAgent,
	type AgentContext,
	type Connection,
	type ConnectionContext,
	type WSMessage,
} from "agents";
import { getSandbox, streamFile } from "@cloudflare/sandbox";
import { artifactsGitEnv, redactArtifactsToken } from "./artifacts-auth.js";
import {
	isAdminPreviewPath,
	normalizePreviewPath,
	previewDocumentPath,
} from "../shared/preview-navigation.js";
import { settleWithin } from "./preview-cache.js";
import {
	streamText,
	generateText,
	convertToModelMessages,
	createUIMessageStream,
	createUIMessageStreamResponse,
	hasToolCall,
	stepCountIs,
	jsonSchema,
	tool,
} from "ai";
import { z } from "zod";
import {
	createTools,
	mapLimit,
	SITE_PATH,
	CANONICAL_WORKER_TS,
	CANONICAL_WRANGLER_JSONC,
	stripSandboxFromAstroConfig,
	scrubAuthFromSnapshot,
	stripStorageFromAstroConfig,
	stripR2FromWrangler,
	ensureSsrOptimizeDep,
	ensurePreviewHmr,
	readFilesFromSandbox,
	type DeployResult,
} from "./tools.js";
import { buildInterviewPrompt, buildHoldingPrompt, buildBuildPrompt } from "./prompts.js";
import {
	recordBuilderMilestone,
	recordPersonalizationMilestone,
	classifyBuildTurn,
	capturedPreviewShotId,
	summarizeInitialBuildBenchmark,
	type BuilderMilestone,
	type BuilderReadinessState,
	type BuilderMilestoneUpdate,
	type BuildStepLike,
	type InitialBuildBenchmark,
} from "./readiness.js";
import { equalTokenDigest } from "./project-auth.js";
import type { ClientRecoveryState } from "../shared/client-recovery.js";
import {
	isSandboxRuntimeReplacement,
	isSandboxWakeReset,
	previewTokenForRoute,
	previewTokenFromUrl,
} from "./recovery.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import {
	createAskQuestionsTool,
	FIRST_INTERVIEW_TOOL_CHOICE,
	shouldRecordBuildEligibility,
} from "./questionnaire.js";
import { findPendingQuestionnaire, readQuestionnaireSubmission } from "../shared/questionnaire.js";
import {
	isInitialGenerationActive,
	type InitialGeneration,
	type InitialGenerationStatus,
} from "../shared/initial-generation.js";
import { withReasoningDurations } from "./reasoning-duration.js";
import {
	closeInterruptedToolCalls,
	markChatTurnFinished,
	markChatTurnStarted,
	planChatRecovery,
	replyStreamOptions,
	shouldAutoStartInitialBuild,
	shouldSkipSiteReadyTurn,
	stashedTurnMetrics,
} from "./turn-gate.js";
import { AccountAuthStore, type IdentityBindings } from "./account-auth.js";
import { readVerifiedAgentAuth, type VerifiedAgentAuth } from "./agent-authorization.js";
import { BUILD_ACTIVITY_TTL_MS, type ProjectCatalogItem } from "./project-catalog-contract.js";
import { suggestNextSteps, suggestionContext, type Suggestion } from "./suggestions.js";
import {
	INITIAL_SCAFFOLD_PATHS,
	InitialScaffoldPrefetch,
	createInitialScaffoldContext,
	emptyInitialScaffoldContext,
	type InitialScaffoldContext,
} from "./initial-scaffold.js";
import { drainProvisionTasks } from "./provisioning.js";
import {
	BuildConvergence,
	canCompleteBuild,
	mutationKey,
	prepareBuildStep,
	releaseStepPreviewImages,
} from "./build-convergence.js";
import { BUILDER_MODEL_ID, BUILDER_PROVIDER_OPTIONS, createBuilderModel } from "./model.js";
import {
	McpToolFailureGuard,
	ToolInputWhitespaceGuard,
	adaptMcpToolSchema,
	batchEntryCreateArgs,
	contentMutationFailureKey,
	mcpToolDescription,
	normalizeMcpToolArgs,
	reserveBatchSlugs,
	stagedLiveUpdate,
} from "./mcp-tool-guard.js";
import {
	canReuseFinalSnapshotForTurn,
	canSkipFinalSnapshot,
	publishStagingCommand,
	snapshotStagingCommand,
} from "./session-snapshot.js";
import { renderErrorSummary } from "./render-diagnostics.js";
import { compactFollowUpContext } from "./follow-up-context.js";
import {
	assertSnapshotGeneration,
	captureStaticSiteSnapshot,
	StaticSiteSnapshotError,
	type BuiltSnapshotAsset,
	type StaticSiteSnapshot,
} from "./static-site-snapshot.js";
import { CloudflareWfpProviderAdapter } from "../platform/cloudflare-wfp-provider.js";
import { deriveWfpProviderIdentity } from "../platform/wfp-release.js";
import {
	PublishedSlugError,
	activatePublishedSlug,
	activePublishedSlugForSite,
	publishedSlugForSite,
	reservePublishedSlug,
	deletePublishedSlug,
	unlockPublishedSlug,
} from "./published-slugs.js";
import {
	buildWfpSnapshotRelease,
	storeWfpSnapshotRelease,
} from "../platform/wfp-snapshot-release.js";
import { ProviderControlPlaneError, type ProviderControlPlane } from "./provider-control-plane.js";
import {
	TurnMetrics,
	timeSync,
	type TurnMetricsInit,
	type TurnMetricsRecord,
} from "./turn-metrics.js";
import {
	validateBlockRendererContract,
	type BlockContractEvidence,
	type BlockRendererValidationResult,
	type ValidatedBlocksField,
} from "./block-renderer-validation.js";

import type { getSandbox as GetSandbox, Process as SandboxProcess } from "@cloudflare/sandbox";

type SandboxInstance = ReturnType<typeof GetSandbox>;

interface PublicationEnv {
	WFP_RELEASES?: R2Bucket;
	ProviderControlPlane?: DurableObjectNamespace<ProviderControlPlane>;
	SITES_HOSTNAME?: string;
	BRANDED_SITES_HOSTNAME?: string;
	SANDBOX_PREVIEW_MODE?: string;
}

export type PublishSiteResult =
	| {
			ok: true;
			status: "live";
			liveUrl: string;
			releaseId: string;
			sourceRevision: string;
			publishedAt: number;
	  }
	| {
			ok: false;
			code:
				| "PROJECT_NOT_FOUND"
				| "SITE_NOT_READY"
				| "SITE_BUSY"
				| "SITE_CHANGED_DURING_PUBLISH"
				| "SNAPSHOT_UNSUPPORTED"
				| "SNAPSHOT_TOO_LARGE"
				| "PUBLISH_NOT_CONFIGURED"
				| "SLUG_INVALID"
				| "SLUG_TAKEN"
				| "SLUG_LOCKED"
				| "SLUG_UNAVAILABLE"
				| "PUBLISH_FAILED";
			message: string;
			reference?: string;
	  };

/** Result of a preview screenshot: the PNG as base64, or why it failed. */
export type PreviewShot =
	| { ok: true; base64: string; mediaType: string }
	| { ok: false; error: string };

/** Result of `getCloneInfo`: a ready-to-run clone command, or why it's unavailable. */
interface CloneInfo {
	ok: boolean;
	/** Why the clone is unavailable (only when `ok` is false). */
	reason?: string;
	/** Git remote with the read token embedded as basic-auth (only when `ok`). */
	cloneUrl?: string;
	/** Tokenless remote, for reference. */
	repoUrl?: string;
	/** Full paste-ready command block (clone + cd + install + dev). */
	command?: string;
	/** ISO timestamp when the embedded read token expires. */
	expiresAt?: string;
}

const PREPARED_TEMPLATES_PATH = "/home/user/.prepared";
const BUILDER_TEMPLATE_DIR = "builder-cloudflare";
const SNAPSHOT_PATH = "/tmp/emdash-build-session-snapshot";
const PUBLISH_PATH = "/tmp/emdash-build-publish";
const SNAPSHOT_PUSH_TIMEOUT_SECONDS = 45;
const PUBLISH_STAGING_TIMEOUT_SECONDS = 110;
const BACKUP_FAILURE_COOLDOWN_MS = 60_000;
const PRODUCTION_SNAPSHOT_PORT = 4322;
const SNAPSHOT_PREPARATION_TIMEOUT_MS = 6 * 60_000;
const QUICK_TUNNEL_SESSION_ID = "builder-tunnel";
const DEV_SERVER_SESSION_ID = "builder-dev";
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
type PublishRunPhase =
	| "checkpoint"
	| "build"
	| "capture"
	| "store"
	| "ensure"
	| "candidate"
	| "promote"
	| "persist";
/** Renew the catalogue's building flag three times per lapse window. */
const BUILD_ACTIVITY_RENEW_MS = BUILD_ACTIVITY_TTL_MS / 3;
/** Work running longer than this is presumed hung and stops counting as building. */
const BUILD_ACTIVITY_MAX_MS = 60 * 60_000;

function isTransientSnapshotPushFailure(result: {
	exitCode?: number;
	stdout?: string;
	stderr?: string;
}): boolean {
	if (result.exitCode === 124) return false;
	return /\bHTTP 5\d\d\b|unexpected disconnect|remote end hung up|network connection lost/i.test(
		`${result.stderr ?? ""}\n${result.stdout ?? ""}`,
	);
}

/**
 * Pre-include EmDash's content validation `zod` entry in the SSR dep optimizer.
 * EmDash imports the bare `zod` entry, which Vite otherwise discovers lazily on
 * the first content_create and re-optimizes mid-request, briefly 404ing a stale
 * deps_ssr chunk (the existing MCP retry covers that transient).
 *
 * Keep this list MINIMAL. Force-including more of EmDash's entrypoints (the
 * middleware chain, media runtime, cloudflare adapters) was tried and reliably
 * CRASHES the dev server on cold start on both Node 22 and 24: the larger SSR
 * pre-bundle produces shared chunks that the cloudflare runner-worker references
 * before they exist, and the process exits 1 before reaching port 4321. The
 * single `zod` entry starts cleanly (verified 4/4); the bigger list does not.
 */
const SSR_OPTIMIZE_DEPS = ["emdash > zod"];

/**
 * `astro/app/manifest` is imported by the Cloudflare runner itself. Letting
 * Vite optimize it after the runner has started regenerates shared deps_ssr
 * chunks underneath workerd and terminates the process before port readiness.
 */
const SSR_OPTIMIZE_EXCLUDES = ["astro/app/manifest"];

/** TTL for the read token handed to the user for a local `git clone` (1 hour). */
const CLONE_TOKEN_TTL_SECONDS = 3600;
/** Step cap for one build turn; see the streamText call in onChatMessage. */
const BUILD_STEP_CAP = 256;

/** Max console lines retained in memory for reload rehydration. */
const CONSOLE_BUFFER_MAX = 500;
const PREVIEW_THUMBNAIL_MAX_BASE64_LENGTH = 1_800_000;
/** Non-root preview routes re-rendered after each mutation, alongside `/`. */
const MAX_VIEWED_PREVIEW_PATHS = 2;
/** Connections whose current route is remembered (covers reconnects and a few tabs). */
const MAX_TRACKED_PREVIEW_CLIENTS = 4;
/**
 * Bound an on-demand route render so a hung dev server cannot pin the caller.
 * Generous on purpose: the toolbar releases its lock after 8s and reloads a
 * second time when this resolves, so a slow render still reaches the user.
 */
const PREVIEW_ROUTE_REFRESH_TIMEOUT_MS = 60_000;
const PREVIEW_THUMBNAIL_LIMIT = 6;

/**
 * Committed into every scaffolded site so a local clone is self-explanatory.
 * Not gitignored (unlike `.dev.vars*`), so it rides along in the snapshot.
 */
const GETTING_STARTED_MD = `# Your EmDash site

This is the full source of the site you built with EmDash Build, a standard
Astro + EmDash project. Your content and uploaded media come along (in
\`.wrangler/\`), so it runs locally with everything already in place.

## Run it locally

You need Node 22+ and pnpm.

\`\`\`sh
pnpm install
pnpm dev
\`\`\`

Then open http://localhost:4321 for the site and
http://localhost:4321/_emdash/admin for the CMS.

If you want to set local secrets (for example an Unsplash key), create a
\`.dev.vars\` file in this folder:

\`\`\`sh
# .dev.vars
EMDASH_SITE_URL=http://localhost:4321
# UNSPLASH_ACCESS_KEY=your-key-here
\`\`\`

## Deploy it

This is a normal Cloudflare project (D1 for content, R2 for media). See the
EmDash docs for deploying to your own account: https://emdashcms.com/docs

## Notes

- \`node_modules\`, \`dist\`, and \`.astro\` are not included; \`pnpm install\` and
  \`pnpm dev\`/\`pnpm build\` recreate them.
- Secrets in \`.dev.vars\` are not included, by design.
`;

/** Artifacts repos hold session state as git; node_modules etc. ride the .gitignore. */
const ARTIFACTS_GIT_USER = "EmDash Build";
const ARTIFACTS_GIT_EMAIL = "agent@emdash.build";

const MUTATING_MCP_TOOLS = new Set([
	"schema_create_collection",
	"schema_create_field",
	"schema_update_block_type",
	"content_create",
	"content_update",
	"content_publish",
	"content_unpublish",
	"content_delete",
	"content_permanent_delete",
	"content_duplicate",
	"taxonomy_create",
	"taxonomy_create_term",
	"taxonomy_update_term",
	"taxonomy_delete_term",
	"byline_create",
	"byline_update",
	"settings_update",
	"menu_create",
	"menu_update",
	"menu_set_items",
]);

async function withBuildMutation<T>(
	convergence: BuildConvergence,
	operation: () => Promise<T>,
	key?: string,
	cacheResult: (result: T) => boolean = () => true,
): Promise<T> {
	return convergence.runMutation(operation, { key, cacheResult });
}

interface SiteRecoveryResult {
	ready: boolean;
	previewUrl?: string;
	error?: string;
}

interface ProvisionResult extends SiteRecoveryResult {
	stopped?: boolean;
}

/** Single-quote a string for safe interpolation into a shell command. */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function decodeBase64(value: string): Uint8Array {
	const decoded = atob(value);
	const bytes = new Uint8Array(decoded.length);
	for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
	return bytes;
}

function builtSnapshotContentType(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase();
	return (
		{
			html: "text/html",
			css: "text/css",
			js: "text/javascript",
			mjs: "text/javascript",
			json: "application/json",
			svg: "image/svg+xml",
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			webp: "image/webp",
			avif: "image/avif",
			ico: "image/x-icon",
			woff: "font/woff",
			woff2: "font/woff2",
			ttf: "font/ttf",
			otf: "font/otf",
			wasm: "application/wasm",
			pdf: "application/pdf",
			txt: "text/plain",
		}[extension ?? ""] ?? "application/octet-stream"
	);
}

/**
 * True if an Artifacts binding error means the repo doesn't exist yet. The
 * structured `.code` ("NOT_FOUND") is stripped when the error crosses the RPC
 * boundary into the Worker, so fall back to matching the message.
 */
function isArtifactsNotFound(err: unknown): boolean {
	const e = err as { code?: string; message?: string } | undefined;
	if (e?.code === "NOT_FOUND") return true;
	return typeof e?.message === "string" && /not found/i.test(e.message);
}

function isChatRequestMessage(message: WSMessage): boolean {
	if (typeof message !== "string") return false;
	try {
		return (JSON.parse(message) as { type?: unknown }).type === "cf_agent_use_chat_request";
	} catch {
		return false;
	}
}

function isChatResumeRequest(message: WSMessage): boolean {
	if (typeof message !== "string") return false;
	try {
		return (JSON.parse(message) as { type?: unknown }).type === "cf_agent_stream_resume_request";
	} catch {
		return false;
	}
}

function cancelledChatRequestId(message: WSMessage): string | undefined {
	if (typeof message !== "string") return;
	try {
		const parsed = JSON.parse(message) as { type?: unknown; id?: unknown };
		return parsed.type === "cf_agent_chat_request_cancel" && typeof parsed.id === "string"
			? parsed.id
			: undefined;
	} catch {
		return;
	}
}

/** Persisted, client-broadcast session state. Must not hold secrets. */
export interface BuilderState extends BuilderReadinessState {
	siteReady: boolean;
	initialGeneration?: InitialGeneration;
	/** Whether the first full build turn has begun (persists across DO eviction). */
	buildStarted?: boolean;
	/** The first build turn began and has not finished, so recovery resumes it as such. */
	initialBuildInFlight?: boolean;
	/** Quality-filtered metrics for the completed first build. */
	initialBuildBenchmark?: InitialBuildBenchmark;
	/** Cost and timing of the most recent model turn, for smoke runs. */
	lastTurnMetrics?: TurnMetricsRecord;
	previewUrl?: string;
	provisionError?: string;
	/** A visible warning when the latest site checkpoint could not be persisted. */
	persistenceError?: string;
	/**
	 * Current progress line ("Installing dependencies..."). Kept in state
	 * rather than a fire-and-forget broadcast so clients that connect
	 * mid-provision (or refresh) still see it.
	 */
	status?: string;
	/**
	 * A chat turn is running. The status line is session-wide (opening a site
	 * restores its preview too), so clients use this to attribute progress to
	 * a turn, including after a reload before the turn's first chunk.
	 */
	turnActive?: boolean;
	/**
	 * Last temporary-account deploy. The claim URL is the user's own (it grants
	 * ownership of their throwaway preview account), so it is safe to broadcast
	 * to this session's client. Expires 60 minutes after `at`.
	 */
	deploy?: { liveUrl?: string; claimUrl?: string; at: number };
	/** Last successfully promoted read-only Workers for Platforms snapshot. */
	publication?: {
		liveUrl: string;
		releaseId: string;
		sourceRevision: string;
		at: number;
	};
	/**
	 * Host the app was loaded from (client's `window.location.host`), sent with
	 * each chat request. Used to build a preview URL that routes back to the
	 * serving worker -- in dev this is `localhost:<port>` so the preview proxy
	 * reaches the LOCAL worker/Sandbox DO instead of production. Persisted so
	 * recovery turns (which may carry no request body) still have it.
	 */
	appHost?: string;
	/** Next-step prompts for the composer, from a small model after the latest successful build. */
	suggestions?: Suggestion[];
}

/** True for hosts that resolve to the local machine (dev servers). */
function isLocalHostname(host: string): boolean {
	const h = host.split(":")[0] ?? "";
	return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h.endsWith(".localhost");
}

/**
 * Extract human-readable text from an MCP tool result. MCP results carry a
 * `content` array of typed parts; text parts hold the message (including error
 * details when `isError` is set).
 */
/**
 * Repair tool arguments where the model serialized a structured value to a
 * JSON string. Smaller models frequently send `data: "{...}"` for an object
 * (or `"[...]"` for an array) parameter, which MCP rejects with a type error.
 * Schema-driven: for each top-level property typed `object`/`array`, if the
 * received value is a string that parses to the expected shape, replace it with
 * the parsed value. Nested object properties are coerced one level deep too
 * (e.g. a stringified field inside `data`).
 */
function coerceJsonArgs(
	args: Record<string, unknown>,
	inputSchema: unknown,
): { args: Record<string, unknown>; repaired: string[] } {
	const props = (
		inputSchema as {
			properties?: Record<
				string,
				{ type?: string; additionalProperties?: unknown; properties?: unknown; items?: unknown }
			>;
		}
	)?.properties;
	if (!props || typeof args !== "object" || args === null) return { args, repaired: [] };
	const out: Record<string, unknown> = { ...args };
	const repaired: string[] = [];
	for (const [key, schema] of Object.entries(props)) {
		if (typeof out[key] !== "string") continue;
		const type = schema?.type;
		const isArray = type === "array" || schema?.items != null;
		const isObject =
			type === "object" ||
			(type == null && (schema?.additionalProperties != null || schema?.properties != null));
		if (isArray || isObject) {
			const parsed = tryParseShaped(out[key] as string, isArray ? "array" : "object");
			if (parsed !== undefined) {
				out[key] = parsed;
				repaired.push(key);
			}
		}
	}
	// One level deeper into a top-level object (e.g. content_create `data`),
	// where individual field values may also arrive as stringified JSON.
	for (const key of Object.keys(out)) {
		const val = out[key];
		if (val && typeof val === "object" && !Array.isArray(val)) {
			const inner = val as Record<string, unknown>;
			const copy: Record<string, unknown> = { ...inner };
			for (const [k, v] of Object.entries(inner)) {
				if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) {
					const parsed = tryParseShaped(v, v.startsWith("[") ? "array" : "object");
					if (parsed !== undefined) {
						copy[k] = parsed;
						repaired.push(`${key}.${k}`);
					}
				}
			}
			if (repaired.some((r) => r.startsWith(`${key}.`))) out[key] = copy;
		}
	}
	return { args: out, repaired };
}

/** Parse `text` as JSON and return it only if it matches the expected shape. */
function tryParseShaped(text: string, type: "object" | "array"): unknown {
	try {
		const parsed = JSON.parse(text);
		const ok =
			type === "array"
				? Array.isArray(parsed)
				: parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
		return ok ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Heuristic: does an MCP error message look like a transient dev-server hiccup
 * (the Vite SSR optimizer re-bundling a newly-discovered dep, a mid-reload
 * 500, or a dropped connection) rather than a real tool-level error? Those
 * self-heal, so we retry through them instead of surfacing them to the model.
 */
function isTransientDevServerError(text: string): boolean {
	return /optimize deps|deps_ssr|does not exist|program reload|internal server error|server error|econnrefused|connection refused|fetch failed|socket hang up|502|503|504/i.test(
		text,
	);
}

/**
 * Turn a thrown turn error into a short, user-facing message. Container drains
 * on a new-version rollout (and cold-start races) are transient -- the fix is
 * to wait a moment and resend -- so we say so rather than showing a raw stack
 * (or, worse, nothing at all).
 */
function friendlyTurnError(error: unknown): string {
	const m = error instanceof Error ? error.message : String(error);
	if (
		/rollout|signalled the container to exit|container .*(exit|not ready|unavailable|starting)|no container instance|failed to start|container is not running|network connection lost|blockConcurrencyWhile|durable object.*reset|internal error/i.test(
			m,
		)
	) {
		return "The build environment was just updated or is still starting up. Give it a few seconds and send your message again.";
	}
	return "Something went wrong on that turn. Please try again in a moment.";
}

/** True for retryable Workers AI errors (capacity/rate limits, transient unavailability). */
function isTransientAiError(message: string): boolean {
	return /capacity temporarily exceeded|\b3040\b|rate.?limit|too many requests|\b429\b|overloaded|temporarily unavailable|no healthy|please try again/i.test(
		message,
	);
}

function mcpResultText(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join(" ")
		.trim();
}

/** Parse the JSON text block of an MCP success envelope; `undefined` if it isn't JSON. */
function mcpResultJson(result: unknown): unknown {
	const text = mcpResultText(result);
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * Best-effort extraction of the created item's id from a content_create MCP
 * result (the payload is JSON text, and the envelope shape varies:
 * `{ item }`, `{ data: { item } }`, or a bare id). Only used for the batch
 * result summary, so a miss is non-fatal.
 */
function extractContentId(result: unknown): string | undefined {
	const text = mcpResultText(result);
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as {
			id?: string;
			item?: { id?: string };
			data?: { id?: string; item?: { id?: string } };
		};
		return parsed.item?.id ?? parsed.data?.item?.id ?? parsed.id ?? parsed.data?.id;
	} catch {
		return undefined;
	}
}

/**
 * Collect the field slugs from a `schema_get_collection` MCP result. The
 * envelope shape varies (`{ fields }`, `{ item: { fields } }`,
 * `{ data: { fields } }`, ...), so probe the likely roots. Used to filter a
 * batch entry's data down to real schema fields.
 */
function collectFieldSlugs(parsed: unknown): Set<string> {
	const slugs = new Set<string>();
	const p = parsed as Record<string, any>;
	const roots = [p, p?.item, p?.data, p?.data?.item, p?.collection, p?.data?.collection];
	for (const root of roots) {
		const fields = (root as { fields?: unknown } | undefined)?.fields;
		if (!Array.isArray(fields)) continue;
		for (const f of fields) {
			const slug = (f as { slug?: unknown; name?: unknown })?.slug ?? (f as any)?.name;
			if (typeof slug === "string") slugs.add(slug);
		}
	}
	return slugs;
}

const schemaSlug = z
	.string()
	.min(1)
	.max(63)
	.regex(/^[a-z][a-z0-9_]*$/);
// Mirrors EmDash 0.40's RESERVED_FIELD_SLUGS for collection-plan preflight.
// Core remains authoritative; this prevents an otherwise-valid batch from
// partially mutating before schema_create_field reports the reserved name.
const RESERVED_COLLECTION_FIELD_SLUGS = new Set([
	"id",
	"slug",
	"status",
	"author_id",
	"primary_byline_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
	"terms",
	"bylines",
	"byline",
]);
const collectionFieldSlug = schemaSlug
	.refine(
		(slug) => !RESERVED_COLLECTION_FIELD_SLUGS.has(slug),
		"Do not declare built-in entry fields such as id, slug, status, timestamps, terms, or bylines",
	)
	.describe(
		"Field slug. Do not declare built-in entry fields: id, slug, status, timestamps, terms, or bylines.",
	);
const stringOptions = z.array(z.string().min(1)).min(1);
const mimeTypes = z.array(z.string().min(1)).min(1).max(64);
const blockFieldBase = z.object({
	slug: schemaSlug,
	label: z.string().min(1).max(200),
	required: z.boolean().optional(),
	defaultValue: z.unknown().optional(),
});
const blockTextValidation = z
	.object({
		minLength: z.number().int().min(0).optional(),
		maxLength: z.number().int().min(0).optional(),
		pattern: z.string().optional(),
	})
	.strict()
	.optional();
const blockNumberValidation = z
	.object({ min: z.number().optional(), max: z.number().optional() })
	.strict()
	.optional();
const blockMimeValidation = z
	.object({ allowedMimeTypes: mimeTypes.optional() })
	.strict()
	.optional();
const repeaterSubFieldSchema = z.discriminatedUnion("type", [
	z
		.object({
			slug: schemaSlug,
			label: z.string().min(1).max(200),
			type: z.literal("select"),
			required: z.boolean().optional(),
			options: stringOptions,
		})
		.strict(),
	z
		.object({
			slug: schemaSlug,
			label: z.string().min(1).max(200),
			type: z.enum(["string", "text", "url", "number", "integer", "boolean", "datetime", "image"]),
			required: z.boolean().optional(),
		})
		.strict(),
]);
const blockFieldSchema = z.discriminatedUnion("type", [
	blockFieldBase
		.extend({ type: z.enum(["string", "text", "url"]), validation: blockTextValidation })
		.strict(),
	blockFieldBase
		.extend({ type: z.enum(["number", "integer"]), validation: blockNumberValidation })
		.strict(),
	blockFieldBase.extend({ type: z.enum(["boolean", "datetime", "portableText"]) }).strict(),
	blockFieldBase
		.extend({
			type: z.enum(["select", "multiSelect"]),
			validation: z.object({ options: stringOptions }).strict(),
		})
		.strict(),
	blockFieldBase
		.extend({
			type: z.literal("image"),
			validation: blockMimeValidation,
			options: z.object({ darkVariant: z.boolean().optional() }).strict().optional(),
		})
		.strict(),
	blockFieldBase.extend({ type: z.literal("file"), validation: blockMimeValidation }).strict(),
	blockFieldBase
		.extend({
			type: z.literal("repeater"),
			validation: z
				.object({
					subFields: z.array(repeaterSubFieldSchema).min(1),
					minItems: z.number().int().min(0).optional(),
					maxItems: z.number().int().min(1).optional(),
				})
				.strict(),
		})
		.strict(),
]);

const ordinaryFieldSchema = z.object({
	slug: collectionFieldSlug,
	label: z.string().min(1),
	type: z.enum([
		"string",
		"text",
		"number",
		"integer",
		"boolean",
		"datetime",
		"select",
		"multiSelect",
		"portableText",
		"image",
		"file",
		"reference",
		"json",
		"slug",
	]),
	required: z.boolean().optional(),
	unique: z.boolean().optional(),
	defaultValue: z.unknown().optional(),
	validation: z
		.object({
			min: z.number().optional(),
			max: z.number().optional(),
			minLength: z.number().optional(),
			maxLength: z.number().optional(),
			pattern: z.string().optional(),
			options: z.array(z.string()).optional(),
		})
		.optional(),
	options: z.record(z.string(), z.unknown()).optional(),
	searchable: z.boolean().optional(),
	indexed: z.boolean().optional(),
	translatable: z.boolean().optional(),
});

const blocksFieldSchema = z
	.object({
		slug: collectionFieldSlug,
		label: z.string().min(1),
		type: z.literal("blocks"),
		translatable: z.boolean().optional(),
		validation: z
			.object({
				allowedTypes: z.array(schemaSlug),
				minItems: z.number().int().min(0).optional(),
				maxItems: z.number().int().min(1).optional(),
			})
			.strict(),
	})
	.strict();

const collectionPlanSchema = z.object({
	slug: schemaSlug,
	label: z.string().min(1),
	labelSingular: z.string().optional(),
	description: z.string().optional(),
	icon: z.string().optional(),
	supports: z
		.array(z.enum(["drafts", "revisions", "preview", "scheduling", "search", "seo"]))
		.optional(),
	routable: z.boolean().optional(),
	editLocking: z.boolean().optional(),
	urlPattern: z
		.string()
		.regex(/^\/(?!\/)[^{}]*(?:\{(?:slug|id)\}[^{}]*)+$/)
		.optional()
		.describe(
			'Public URL of one entry, matching its Astro detail route, e.g. "/{slug}" for ' +
				'pages or "/journal/{slug}". Menus and the sitemap link entries here; without ' +
				"it they use /{collection}/{slug}. Placeholders: {slug}, {id}.",
		),
	fields: z
		.array(z.union([ordinaryFieldSchema, blocksFieldSchema]))
		.min(1)
		.describe(
			"Collection fields. Do not use repeater here: the current schema MCP cannot create collection repeaters. For ordered structured values such as a gallery, declare a subject-specific block type and use a blocks field. Repeater is valid only inside blockTypes[].fields.",
		),
});

const schemaPlanInput = z
	.object({
		blockTypes: z
			.array(
				z
					.object({
						slug: schemaSlug,
						label: z.string().min(1).max(200),
						description: z.string().optional(),
						icon: z.string().optional(),
						category: z.string().optional(),
						fields: z.array(blockFieldSchema),
					})
					.strict(),
			)
			.default([]),
		collections: z.array(collectionPlanSchema).default([]),
	})
	.refine(
		({ blockTypes, collections }) => blockTypes.length > 0 || collections.length > 0,
		"The schema plan must contain at least one block type or collection",
	);

const blocksFieldUpdateInput = z
	.object({
		collection: schemaSlug,
		fieldSlug: schemaSlug,
		label: z.string().min(1).optional(),
		sortOrder: z.number().int().min(0).optional(),
		translatable: z.boolean().optional(),
		validation: z
			.object({
				allowedTypes: z
					.array(schemaSlug)
					.refine(
						(values) => new Set(values).size === values.length,
						"allowedTypes must be unique",
					),
				minItems: z.number().int().min(0).max(100),
				maxItems: z.number().int().min(1).max(100),
			})
			.strict()
			.refine(
				(validation) => validation.minItems <= validation.maxItems,
				"maxItems must be greater than or equal to minItems",
			)
			.optional(),
	})
	.strict()
	.refine(
		(input) =>
			input.label !== undefined ||
			input.sortOrder !== undefined ||
			input.translatable !== undefined ||
			input.validation !== undefined,
		"Provide at least one blocks-field change",
	);

type SchemaPlan = z.infer<typeof schemaPlanInput>;
type BlockTypePlan = SchemaPlan["blockTypes"][number];
type BlocksFieldPlan = Extract<
	SchemaPlan["collections"][number]["fields"][number],
	{ type: "blocks" }
>;

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function extractedBlockType(parsed: unknown): Record<string, unknown> | undefined {
	const item = recordValue(recordValue(parsed)?.item);
	return typeof item?.slug === "string" && Array.isArray(item.versions) ? item : undefined;
}

function extractedCollection(parsed: unknown): Record<string, unknown> | undefined {
	const collection = recordValue(parsed);
	return typeof collection?.slug === "string" && Array.isArray(collection.fields)
		? collection
		: undefined;
}

function canonicalContract(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalContract);
	const record = recordValue(value);
	if (!record) return value;
	return Object.fromEntries(
		Object.entries(record)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, canonicalContract(child)]),
	);
}

function comparableBlockField(field: unknown): unknown {
	const record = recordValue(canonicalContract(field));
	if (!record) return field;
	record.required = record.required === true;
	return canonicalContract(record);
}

function inspectBlockType(
	parsed: unknown,
	plan?: BlockTypePlan,
): { ok: true } | { ok: false; reason: string } {
	const item = extractedBlockType(parsed);
	if (!item) return { ok: false, reason: "the block type response was incomplete" };
	const versions = item.versions as unknown[];
	const active = versions
		.map(recordValue)
		.find((version) => version?.version === item.currentVersion);
	if (!active)
		return { ok: false, reason: `active version ${String(item.currentVersion)} is missing` };
	if (Array.isArray(active.unsupportedTypes) && active.unsupportedTypes.length > 0) {
		return { ok: false, reason: "its active version contains unsupported field types" };
	}
	if (!Array.isArray(active.fields)) {
		return { ok: false, reason: "its active fields are missing" };
	}
	if (!plan) return { ok: true };
	if (item.slug !== plan.slug || item.label !== plan.label) {
		return { ok: false, reason: "its slug or label differs from the plan" };
	}
	for (const key of ["description", "icon", "category"] as const) {
		if (plan[key] !== undefined && item[key] !== plan[key]) {
			return { ok: false, reason: `its ${key} differs from the plan` };
		}
	}
	if (
		JSON.stringify((active.fields as unknown[]).map(comparableBlockField)) !==
		JSON.stringify(plan.fields.map(comparableBlockField))
	) {
		return { ok: false, reason: "its active fields differ from the plan" };
	}
	return { ok: true };
}

function collectionFieldMap(
	collection: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
	const fields = new Map<string, Record<string, unknown>>();
	for (const value of collection.fields as unknown[]) {
		const field = recordValue(value);
		if (typeof field?.slug === "string") fields.set(field.slug, field);
	}
	return fields;
}

function blocksFieldMatches(actual: Record<string, unknown>, plan: BlocksFieldPlan): boolean {
	const validation = recordValue(actual.validation);
	return (
		actual.type === "blocks" &&
		actual.label === plan.label &&
		(actual.translatable ?? true) === (plan.translatable ?? true) &&
		JSON.stringify(validation?.allowedTypes ?? []) ===
			JSON.stringify(plan.validation.allowedTypes) &&
		(validation?.minItems ?? 0) === (plan.validation.minItems ?? 0) &&
		(validation?.maxItems ?? 100) === (plan.validation.maxItems ?? 100)
	);
}

function blockUpdateMatches(parsed: unknown, args: Record<string, unknown>): boolean {
	const item = extractedBlockType(parsed);
	if (!item || typeof args.slug !== "string" || item.slug !== args.slug) return false;
	for (const key of ["label", "description", "icon", "category"] as const) {
		if (!(key in args)) continue;
		const expected = args[key] === null ? undefined : args[key];
		if (item[key] !== expected) return false;
	}
	const versions = Array.isArray(item.versions) ? item.versions.map(recordValue) : [];
	const active = versions.find((version) => version?.version === item.currentVersion);
	if (!active || (Array.isArray(active.unsupportedTypes) && active.unsupportedTypes.length > 0)) {
		return false;
	}
	if (!Array.isArray(args.fields)) return active.fingerprint === args.expectedFingerprint;
	const desired = JSON.stringify(args.fields.map(comparableBlockField));
	if (
		Array.isArray(active.fields) &&
		JSON.stringify(active.fields.map(comparableBlockField)) === desired
	) {
		return true;
	}
	if (args.breaking !== true || active.fingerprint !== args.expectedFingerprint) return false;
	return (
		versions.filter(
			(version) =>
				version?.active !== true &&
				Array.isArray(version?.fields) &&
				JSON.stringify(version.fields.map(comparableBlockField)) === desired &&
				(!Array.isArray(version.unsupportedTypes) || version.unsupportedTypes.length === 0),
		).length === 1
	);
}

function blocksFieldUpdateMatches(
	actual: Record<string, unknown>,
	args: Record<string, unknown>,
): boolean {
	if (actual.type !== "blocks") return false;
	for (const key of ["label", "sortOrder", "translatable"] as const) {
		if (args[key] !== undefined && actual[key] !== args[key]) return false;
	}
	const desired = recordValue(args.validation);
	if (!desired) return true;
	const validation = recordValue(actual.validation);
	return (
		JSON.stringify(validation?.allowedTypes ?? []) === JSON.stringify(desired.allowedTypes) &&
		(validation?.minItems ?? 0) === desired.minItems &&
		(validation?.maxItems ?? 100) === desired.maxItems
	);
}

function mcpItems(parsed: unknown): Record<string, unknown>[] {
	const items = recordValue(parsed)?.items;
	return Array.isArray(items) ? items.map(recordValue).filter((item) => item !== undefined) : [];
}

export class BuilderAgent extends AIChatAgent<Env, BuilderState> {
	// Block the turn on MCP (re)connection so CMS tools are available on the
	// first turn and after hibernation, instead of racing tool enumeration.
	override waitForMcpConnections = { timeout: 20_000 };
	// Wrap chat turns in a fiber so a turn interrupted by DO eviction resumes.
	override chatRecovery = true;
	override initialState: BuilderState = { siteReady: false };

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.releaseInterruptedActivity();
		const frameworkOnConnect = this.onConnect.bind(this);
		this.onConnect = async (connection: Connection, context: ConnectionContext) => {
			const auth = readVerifiedAgentAuth(context.request);
			if (!auth || !(await this.isAgentAuthLive(auth))) {
				connection.close(4404, "Project not found");
				return;
			}
			const previous =
				connection.state && typeof connection.state === "object" ? connection.state : {};
			connection.setState({ ...previous, emdashAuth: auth });
			return frameworkOnConnect(connection, context);
		};

		const frameworkOnRequest = this.onRequest.bind(this);
		this.onRequest = async (request: Request) => {
			const auth = readVerifiedAgentAuth(request);
			if (!auth || !(await this.isAgentAuthLive(auth))) {
				return Response.json({ error: "Project not found." }, { status: 404 });
			}
			return frameworkOnRequest(request);
		};

		const frameworkOnMessage = this.onMessage.bind(this);
		this.onMessage = async (connection: Connection, message: WSMessage) => {
			const auth = (connection.state as { emdashAuth?: VerifiedAgentAuth } | null)?.emdashAuth;
			if (!auth || !(await this.isAgentAuthLive(auth))) {
				connection.close(4404, "Project not found");
				return;
			}
			if (
				isChatRequestMessage(message) &&
				!(await this.env.ProjectCatalog.getByName(auth.ownerKey).beginProjectTurn(
					auth.ownerKey,
					this.name,
					auth.sessionHash,
				))
			) {
				connection.close(4404, "Project not found");
				return;
			}
			const currentOwner = this.getOwnerRecord();
			if (!currentOwner || !equalTokenDigest(currentOwner.ownerKey, auth.ownerKey)) {
				connection.close(4404, "Project not found");
				return;
			}
			if (isChatResumeRequest(message)) {
				connection.send(
					JSON.stringify({ type: "cf_agent_chat_messages", messages: this.messages }),
				);
			}
			const cancelledId = cancelledChatRequestId(message);
			if (
				cancelledId &&
				cancelledId === this.activeInitialRequestId &&
				this.state.initialGeneration?.status !== "ready"
			) {
				void this.requestStop(this.state.initialGeneration?.id);
			}
			return frameworkOnMessage(connection, message);
		};
	}

	private ensureRevokedSessionsTable() {
		this.sql`CREATE TABLE IF NOT EXISTS revoked_account_sessions (
			session_hash TEXT PRIMARY KEY,
			expires_at INTEGER NOT NULL
		)`;
	}

	private isAccountSessionRevoked(sessionHash: string): boolean {
		this.ensureRevokedSessionsTable();
		return (
			this.sql<{
				session_hash: string;
			}>`SELECT session_hash FROM revoked_account_sessions WHERE session_hash = ${sessionHash} LIMIT 1`
				.length > 0
		);
	}

	private closeInvalidAccountConnections(now = Date.now()): string[] {
		const closed: string[] = [];
		for (const connection of this.getConnections()) {
			const auth = (connection.state as { emdashAuth?: VerifiedAgentAuth } | null)?.emdashAuth;
			if (
				auth?.kind === "account" &&
				(!auth.expiresAt ||
					auth.expiresAt <= now ||
					!auth.sessionHash ||
					this.isAccountSessionRevoked(auth.sessionHash))
			) {
				closed.push(connection.id);
				connection.close(4404, "Session ended");
			}
		}
		return closed;
	}

	override setState(state: BuilderState): void {
		this.closeInvalidAccountConnections();
		this.stateWrittenHere = true;
		super.setState(state);
	}

	/**
	 * Builder state is written only by the server. The SDK otherwise applies a
	 * connected client's `cf_agent_state` message verbatim, which would let a
	 * client repoint `previewUrl` (where upload_media sends the site's API
	 * token) or fake readiness flags. The client only reads state.
	 */
	override validateStateChange(_nextState: BuilderState, source: Connection | "server"): void {
		if (source !== "server") throw new Error("Builder state is read-only for clients.");
	}

	/**
	 * Set once this instance writes state. Until then, progress in state (the
	 * status line, a preview restore) was left by an evicted instance and
	 * describes work that no longer runs.
	 */
	private stateWrittenHere = false;

	/**
	 * Chat turns and setup this instance is running now. Activity rows outlive
	 * the instance (chat rows wait for recovery), so they cannot say whether
	 * work is live; only work begun here can.
	 */
	private liveBuildWork = new Map<string, { kind: string; startedAt: number }>();
	/** What this instance last told the owner's catalogue about building. */
	private reportedBuilding = false;
	private lastBuildReportAt = 0;
	private buildActivityChain: Promise<void> = Promise.resolve();

	private hasProgressInState(): boolean {
		return Boolean(this.state.status || this.state.previewRestarting || this.state.turnActive);
	}

	override broadcast(message: string | ArrayBuffer | ArrayBufferView, without?: string[]): void {
		const invalid = this.closeInvalidAccountConnections();
		super.broadcast(message, [...new Set([...(without ?? []), ...invalid])]);
	}

	private sandbox: SandboxInstance | null = null;

	/** Bounded in-memory console history, for reload/late-connect rehydration. */
	private consoleBuffer: string[] = [];
	private devServerErrors: Array<{ at: number; text: string }> = [];

	/** Process id of the running `pnpm dev` server, for a clean restart. */
	private devServerProcessId?: string;
	private devServerProcess?: SandboxProcess;
	private quickTunnelProcess?: SandboxProcess;

	/**
	 * Set when a build turn actually runs. Guards the auto-started build turn
	 * that fires when background provisioning finishes (turns are otherwise
	 * user-initiated, so a finished provision would just sit idle): if a queued
	 * user message reached the build phase first, the auto-started turn must
	 * no-op rather than re-run a full build against its own output. Checked at
	 * turn *run* time, not enqueue time -- the queued user turn may only start
	 * after the auto-turn is already enqueued.
	 */
	private buildStarted = false;
	private activeInitialRequestId?: string;
	private activeInitialUserMessageId?: string;
	private activeBuildConvergences = new Map<string, BuildConvergence>();
	private stopPromise: Promise<void> | null = null;
	/** Set by restartInterruptedTurn for the one turn it enqueues. */
	private restartingInterruptedTurn = false;

	private latestUserMessageId(): string | undefined {
		return [...this.messages].reverse().find((message) => message.role === "user")?.id;
	}

	private ensureInitialGeneration(): InitialGeneration | undefined {
		if (this.state.initialGeneration) return this.state.initialGeneration;
		if (this.state.complete) return;
		const id = this.messages.find((message) => message.role === "user")?.id;
		if (!id) return;
		const generation: InitialGeneration = { id, status: "preparing" };
		this.setState({ ...this.state, initialGeneration: generation });
		return generation;
	}

	private setInitialGenerationStatus(
		status: InitialGenerationStatus,
		terminalMessageId?: string,
		previewShotId?: string,
	): void {
		const current = this.state.initialGeneration;
		if (
			!current ||
			current.status === "ready" ||
			(current.status === "stopping" && status !== "stopping" && status !== "stopped") ||
			(current.status === "stopped" && status !== "stopped") ||
			(current.status === "failed" && status !== "failed" && status !== "stopped")
		)
			return;
		if (
			(status === "stopping" || status === "stopped" || status === "failed") &&
			!terminalMessageId
		) {
			terminalMessageId = this.activeInitialUserMessageId ?? this.latestUserMessageId();
		}
		if (
			current.status === status &&
			current.terminalMessageId === terminalMessageId &&
			current.previewShotId === previewShotId
		)
			return;
		this.setState({
			...this.state,
			initialGeneration: {
				id: current.id,
				status,
				...(previewShotId ? { previewShotId } : {}),
				...(terminalMessageId ? { terminalMessageId } : {}),
			},
		});
		// Setup only counts as building while the first build is underway.
		this.syncBuildActivity();
	}

	private requestStop(generationId?: string): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		const generation = this.state.initialGeneration;
		const stopsInitialGeneration =
			generationId !== undefined &&
			generation?.id === generationId &&
			generation.status !== "ready";
		const terminalMessageId = this.activeInitialUserMessageId ?? this.latestUserMessageId();
		if (stopsInitialGeneration) this.setInitialGenerationStatus("stopping", terminalMessageId);

		const pending = Promise.resolve().then(async () => {
			if (this.activeInitialRequestId) this.abortRequest(this.activeInitialRequestId);
			const provisionController = this.provisionController;
			const provisionPromise = this.provisionPromise;
			const activeProvisionPromise = this.activeProvisionPromise;
			provisionController?.abort(new DOMException("Build stopped by the user.", "AbortError"));
			this.initialScaffoldPrefetch.cancel();
			const provisions = new Set(
				[provisionPromise, activeProvisionPromise].filter(
					(promise): promise is Promise<ProvisionResult> => promise !== null,
				),
			);
			await Promise.allSettled([
				...[...new Set(this.activeBuildConvergences.values())].map((convergence) =>
					convergence.waitForIdle(),
				),
				...provisions,
			]);
			if (this.provisionController === provisionController) this.provisionController = null;
			if (this.provisionPromise === provisionPromise) this.provisionPromise = null;
			if (this.activeProvisionPromise === activeProvisionPromise) {
				this.activeProvisionPromise = null;
			}
			if (stopsInitialGeneration && this.state.initialGeneration?.id === generationId) {
				this.setInitialGenerationStatus("stopped", terminalMessageId);
			}
			this.sendStatus("");
		});
		let tracked!: Promise<void>;
		tracked = pending.finally(() => {
			if (this.stopPromise === tracked) this.stopPromise = null;
		});
		this.stopPromise = tracked;

		return tracked;
	}

	async stopGeneration(generationId?: string): Promise<boolean> {
		await this.requestStop(generationId);
		return true;
	}

	async stopInitialGeneration(generationId: string): Promise<boolean> {
		const generation = this.state.initialGeneration;
		if (!generation || generation.id !== generationId || generation.status === "ready")
			return false;
		await this.requestStop(generationId);
		return true;
	}

	/** Retry the existing serialized session checkpoint without exposing its details. */
	async retrySessionSave(): Promise<boolean> {
		if (!this.state.persistenceError) return true;
		await this.backupSite();
		return !this.state.persistenceError;
	}

	/**
	 * In-flight provision promise. Set on the first message of a session
	 * (when the interview turn streams) and awaited on the next turn before
	 * tools/MCP are used. Re-set on cold start if a build turn arrives
	 * before provision is durable in this.state.
	 */
	private provisionPromise: Promise<ProvisionResult> | null = null;
	private activeProvisionPromise: Promise<ProvisionResult> | null = null;
	private provisionController: AbortController | null = null;

	/** Serialize checkpoints so every caller waits for a snapshot containing its mutation. */
	private backupChain: Promise<void> = Promise.resolve();
	private deletionPromise?: Promise<"deleted" | "retry">;
	private backupRetryAfter = 0;
	private lastSavedPreviewGeneration?: number;

	/** Coalesce sidebar, chat-recovery and restart requests for the same sleeping site. */
	private recoveryPromise: Promise<SiteRecoveryResult> | null = null;
	private recoveryReconnectMcp = false;

	/** Astro's Cloudflare dev runner becomes unresponsive under parallel MCP requests. */
	private mcpCallQueue = new SerialTaskQueue();

	/**
	 * Cached template AGENTS.md (per-template body included). Populated
	 * lazily after provision. Lost on eviction; re-read on demand.
	 */
	private templateGuidance: string | undefined;

	/** Attempt-owned, in-memory source snapshot for the unstarted first build. */
	private initialScaffoldPrefetch = new InitialScaffoldPrefetch();

	/** Durable, server-only store for the site's API token (never broadcast). */
	private ensureSecretsTable() {
		this.sql`CREATE TABLE IF NOT EXISTS builder_secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
	}

	private ensurePreviewThumbnailsTable() {
		this.sql`CREATE TABLE IF NOT EXISTS builder_preview_thumbnails (
			shot_id TEXT PRIMARY KEY,
			base64 TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`;
	}

	private savePreviewThumbnail(shotId: string, shot: { base64: string; mediaType: string }) {
		if (shot.mediaType !== "image/png" || shot.base64.length > PREVIEW_THUMBNAIL_MAX_BASE64_LENGTH)
			return;
		try {
			this.ensurePreviewThumbnailsTable();
			const pinnedShotId = this.state.initialGeneration?.previewShotId ?? "";
			this.sql`INSERT OR REPLACE INTO builder_preview_thumbnails (shot_id, base64, created_at)
				VALUES (${shotId}, ${shot.base64}, ${Date.now()})`;
			this
				.sql`DELETE FROM builder_preview_thumbnails WHERE shot_id != ${pinnedShotId} AND shot_id NOT IN (
				SELECT shot_id FROM builder_preview_thumbnails WHERE shot_id != ${pinnedShotId} ORDER BY created_at DESC, rowid DESC LIMIT ${PREVIEW_THUMBNAIL_LIMIT}
			)`;
		} catch {
			console.warn("[BuilderAgent] Could not retain preview thumbnail");
		}
	}

	async getPreviewThumbnail(
		shotId: string,
	): Promise<{ base64: string; mediaType: "image/png" } | null> {
		if (!/^[0-9a-f-]{36}$/i.test(shotId)) return null;
		this.ensurePreviewThumbnailsTable();
		const row = this.sql<{
			base64: string;
		}>`SELECT base64 FROM builder_preview_thumbnails WHERE shot_id = ${shotId}`[0];
		return row ? { base64: row.base64, mediaType: "image/png" } : null;
	}

	private persistApiToken(token: string) {
		this.ensureSecretsTable();
		this.sql`INSERT OR REPLACE INTO builder_secrets (k, v) VALUES ('apiToken', ${token})`;
	}

	private getApiToken(): string | undefined {
		this.ensureSecretsTable();
		const rows = this.sql<{ v: string }>`SELECT v FROM builder_secrets WHERE k = 'apiToken'`;
		return rows[0]?.v;
	}

	private markWfpCleanupRequired(): void {
		this.ensureSecretsTable();
		this.sql`INSERT OR REPLACE INTO builder_secrets (k, v) VALUES ('wfpCleanupRequired', '1')`;
	}

	private isWfpCleanupRequired(): boolean {
		this.ensureSecretsTable();
		return (
			this.sql`SELECT 1 FROM builder_secrets WHERE k = 'wfpCleanupRequired' LIMIT 1`.length > 0
		);
	}

	private getOwnerRecord(): { ownerKey: string } | undefined {
		this.ensureSecretsTable();
		if (this.isDeletionPending()) return undefined;
		const row = this.sql<{ v: string }>`SELECT v FROM builder_secrets WHERE k = 'ownerDigest'`[0];
		return row ? { ownerKey: row.v } : undefined;
	}

	private isDeletionPending(): boolean {
		this.ensureSecretsTable();
		return this.sql`SELECT v FROM builder_secrets WHERE k = 'deleting'`.length > 0;
	}

	private ensureOwnerActivityTable() {
		this.sql`CREATE TABLE IF NOT EXISTS owner_activity (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			started_at INTEGER NOT NULL
		)`;
	}

	private ensurePublishAttemptsTable() {
		this.sql`CREATE TABLE IF NOT EXISTS builder_publish_attempts (
			release_id TEXT NOT NULL,
			publication_epoch INTEGER NOT NULL,
			attempt INTEGER NOT NULL,
			pending INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (release_id, publication_epoch)
		)`;
	}

	private getPublishAttempt(releaseId: string, publicationEpoch: number): number {
		this.ensurePublishAttemptsTable();
		const now = Date.now();
		this.sql`INSERT OR IGNORE INTO builder_publish_attempts
			(release_id, publication_epoch, attempt, pending, updated_at)
			VALUES (${releaseId}, ${publicationEpoch}, 0, 0, ${now})`;
		this.sql`UPDATE builder_publish_attempts SET updated_at = ${now}
			WHERE release_id = ${releaseId} AND publication_epoch = ${publicationEpoch}`;
		this.sql`DELETE FROM builder_publish_attempts WHERE pending = 0 AND rowid NOT IN (
			SELECT rowid FROM builder_publish_attempts WHERE pending = 0
			ORDER BY updated_at DESC, rowid DESC LIMIT 20
		)`;
		return this.sql<{ attempt: number }>`SELECT attempt FROM builder_publish_attempts
			WHERE release_id = ${releaseId} AND publication_epoch = ${publicationEpoch}`[0]!.attempt;
	}

	private markPublishAttemptPending(releaseId: string, publicationEpoch: number): void {
		this.ensurePublishAttemptsTable();
		this.sql`UPDATE builder_publish_attempts SET pending = 1, updated_at = ${Date.now()}
			WHERE release_id = ${releaseId} AND publication_epoch = ${publicationEpoch}`;
	}

	private advancePublishAttempt(releaseId: string, publicationEpoch: number): void {
		this.ensurePublishAttemptsTable();
		this.sql`UPDATE builder_publish_attempts
			SET attempt = attempt + 1, pending = 0,
				updated_at = ${Date.now()}
			WHERE release_id = ${releaseId} AND publication_epoch = ${publicationEpoch}`;
	}

	private clearPublishAttempt(releaseId: string, publicationEpoch: number): void {
		this.ensurePublishAttemptsTable();
		this.sql`DELETE FROM builder_publish_attempts
			WHERE release_id = ${releaseId} AND publication_epoch = ${publicationEpoch}`;
	}

	private hasPendingPublishAttempt(): boolean {
		this.ensurePublishAttemptsTable();
		return this.sql`SELECT 1 FROM builder_publish_attempts WHERE pending = 1 LIMIT 1`.length > 0;
	}

	private beginOwnerActivity(id: string, kind: string) {
		this.ensureOwnerActivityTable();
		this.sql`INSERT OR IGNORE INTO owner_activity (id, kind, started_at)
			VALUES (${id}, ${kind}, ${Date.now()})`;
		if (kind === "chat") this.syncTurnActive();
		if (kind === "chat" || kind === "provision") {
			// Chat turns run one at a time; an earlier one here was interrupted.
			if (kind === "chat") {
				for (const [workId, work] of this.liveBuildWork) {
					if (work.kind === "chat" && workId !== id) this.liveBuildWork.delete(workId);
				}
			}
			this.liveBuildWork.set(id, { kind, startedAt: Date.now() });
			this.syncBuildActivity();
		}
	}

	private finishOwnerActivity(id: string) {
		this.ensureOwnerActivityTable();
		this.sql`DELETE FROM owner_activity WHERE id = ${id}`;
		if (id.startsWith("chat:")) this.syncTurnActive();
		if (this.liveBuildWork.delete(id)) this.syncBuildActivity();
	}

	/**
	 * Building, for other tabs' sidebars: a chat turn is running, or the first
	 * build's setup is (not while it waits for the user's answers).
	 */
	private isBuildingNow(): boolean {
		const now = Date.now();
		const kinds = new Set(
			[...this.liveBuildWork.values()]
				.filter((work) => now - work.startedAt < BUILD_ACTIVITY_MAX_MS)
				.map((work) => work.kind),
		);
		if (kinds.has("chat")) return true;
		const status = this.state.initialGeneration?.status;
		return kinds.has("provision") && status !== undefined && isInitialGenerationActive(status);
	}

	/**
	 * Tell the owner's catalogue when building starts or stops. The catalogue
	 * lets the flag lapse on its own, so a scheduled renewal keeps it up while
	 * work continues and an evicted or crashed instance never leaves a site
	 * shimmering. The renewal uses the alarm, never an in-memory timer, so it
	 * does not keep the object awake.
	 */
	private syncBuildActivity() {
		const building = this.isBuildingNow();
		if (building === this.reportedBuilding) return;
		this.reportedBuilding = building;
		this.reportBuildActivity(building);
		this.queueBuildRenewal(building);
	}

	/**
	 * Scheduled while building: renew the flag, or clear it and stop once this
	 * instance has no live work (a renewal an evicted instance left lands here).
	 */
	async renewBuildActivity(): Promise<void> {
		const building = this.isBuildingNow();
		this.reportedBuilding = building;
		this.reportBuildActivity(building);
		if (!building) this.queueBuildRenewal(false);
		await this.buildActivityChain;
	}

	private queueBuildRenewal(on: boolean) {
		this.buildActivityChain = this.buildActivityChain
			.then(async () => {
				if (on) {
					await this.scheduleEvery(BUILD_ACTIVITY_RENEW_MS / 1000, "renewBuildActivity");
					return;
				}
				for (const schedule of await this.listSchedules()) {
					if (schedule.callback === "renewBuildActivity") await this.cancelSchedule(schedule.id);
				}
			})
			.catch((error: unknown) =>
				console.warn("[BuilderAgent] building flag renewal not updated:", error),
			);
	}

	/**
	 * Renew from the work itself. A turn resumed after eviction runs inside the
	 * alarm, where the scheduled renewal cannot fire until it ends.
	 */
	private touchBuildActivity() {
		if (!this.reportedBuilding || Date.now() - this.lastBuildReportAt < BUILD_ACTIVITY_RENEW_MS) {
			return;
		}
		if (this.isBuildingNow()) this.reportBuildActivity(true);
	}

	/** Reports stay in order and never hold up the work they describe. */
	private reportBuildActivity(active: boolean) {
		const owner = this.getOwnerRecord();
		if (!owner) return;
		if (active) this.lastBuildReportAt = Date.now();
		const projectId = this.name;
		this.buildActivityChain = this.buildActivityChain
			.then(() =>
				this.env.ProjectCatalog.getByName(owner.ownerKey).setProjectActivity(
					owner.ownerKey,
					projectId,
					active,
				),
			)
			.then(
				() => {},
				(error: unknown) => console.warn("[BuilderAgent] building flag not updated:", error),
			);
	}

	/** Mirror the durable chat-turn rows into broadcast state for every connected tab. */
	private syncTurnActive() {
		const active =
			this.sql<{ id: string }>`SELECT id FROM owner_activity WHERE kind = 'chat' LIMIT 1`.length >
			0;
		// Chat recovery can settle a turn before onStart runs. Writing state first
		// would make onStart keep an evicted instance's progress, so reset it here.
		const stale = !this.stateWrittenHere && this.hasProgressInState();
		if (!stale && Boolean(this.state.turnActive) === active) return;
		this.setState({
			...this.state,
			...(stale && { status: "", previewRestarting: false }),
			turnActive: active,
		});
	}

	/**
	 * Activity rows outlive the instance that ran the work. A new instance
	 * runs none of it, so rows it inherits are left over from eviction. Chat
	 * turns are the exception: chat recovery resumes them, so their rows stay
	 * until recovery settles the turn (see onChatRecovery and onChatMessage).
	 */
	private releaseInterruptedActivity() {
		this.ensureOwnerActivityTable();
		this.sql`DELETE FROM owner_activity WHERE kind != 'chat'`;
	}

	private hasOwnerActivity(): boolean {
		this.ensureOwnerActivityTable();
		return this.sql<{ id: string }>`SELECT id FROM owner_activity LIMIT 1`.length > 0;
	}

	private hasOwnerActivityKind(kind: string): boolean {
		this.ensureOwnerActivityTable();
		return (
			this.sql<{ id: string }>`SELECT id FROM owner_activity WHERE kind = ${kind} LIMIT 1`.length >
			0
		);
	}

	private async withOwnerActivity<T>(kind: string, operation: () => Promise<T>) {
		const id = `${kind}:${crypto.randomUUID()}`;
		this.beginOwnerActivity(id, kind);
		try {
			return await operation();
		} finally {
			this.finishOwnerActivity(id);
		}
	}

	private closeAgentConnections(reason: string) {
		for (const connection of this.getConnections()) connection.close(4403, reason);
	}

	private closeStaleAgentConnections(ownerKey: string, reason: string) {
		for (const connection of this.getConnections()) {
			const auth = (connection.state as { emdashAuth?: VerifiedAgentAuth } | null)?.emdashAuth;
			if (!auth || !equalTokenDigest(auth.ownerKey, ownerKey)) {
				connection.close(4403, reason);
			}
		}
	}

	async revokeSessionConnections(sessionHash: string, expiresAt: number): Promise<void> {
		if (!sessionHash || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) return;
		this.ensureRevokedSessionsTable();
		this.sql`DELETE FROM revoked_account_sessions WHERE session_hash IN (
			SELECT session_hash FROM revoked_account_sessions WHERE expires_at <= ${Date.now()} LIMIT 100
		)`;
		this.sql`INSERT OR REPLACE INTO revoked_account_sessions (session_hash, expires_at)
			VALUES (${sessionHash}, ${expiresAt})`;
		for (const connection of this.getConnections()) {
			const auth = (connection.state as { emdashAuth?: VerifiedAgentAuth } | null)?.emdashAuth;
			if (
				auth?.kind === "account" &&
				auth.sessionHash &&
				equalTokenDigest(auth.sessionHash, sessionHash)
			) {
				connection.close(4404, "Session ended");
			}
		}
	}

	private async isAgentAuthLive(auth: VerifiedAgentAuth): Promise<boolean> {
		const owner = this.getOwnerRecord();
		if (!owner || !equalTokenDigest(owner.ownerKey, auth.ownerKey)) {
			return false;
		}
		let credentialLive: boolean;
		if (auth.kind === "guest") {
			credentialLive = await this.env.ProjectCatalog.getByName(auth.ownerKey).authorizeActiveGuest(
				auth.ownerKey,
			);
		} else {
			if (!auth.sessionHash || !auth.expiresAt || auth.expiresAt <= Date.now()) return false;
			if (this.isAccountSessionRevoked(auth.sessionHash)) return false;
			try {
				credentialLive = await AccountAuthStore.fromEnv(
					this.env as Env & IdentityBindings,
				).isSessionHashLive(auth.sessionHash);
			} catch {
				return false;
			}
		}
		const currentOwner = this.getOwnerRecord();
		return Boolean(
			credentialLive && currentOwner && equalTokenDigest(currentOwner.ownerKey, auth.ownerKey),
		);
	}

	/** Bind a newly-created project to its server-issued owner key. */
	async initializeOwnership(ownerKey: string): Promise<boolean> {
		this.ensureSecretsTable();
		this.sql`INSERT OR IGNORE INTO builder_secrets (k, v) VALUES ('ownerDigest', ${ownerKey})`;
		return this.authorizeProject(ownerKey);
	}

	/**
	 * Bind an unanchored project to a retry-stable creation capability. The
	 * capability may repair a lost guest cookie or an auth change only before
	 * the first brief starts any work; afterward ordinary ownership rules win.
	 */
	async initializeCreationOwnership(ownerKey: string, creationDigest: string): Promise<boolean> {
		this.ensureSecretsTable();
		const recordedCreation = this.sql<{
			v: string;
		}>`SELECT v FROM builder_secrets WHERE k = 'creationDigest'`[0]?.v;
		if (!recordedCreation) {
			this.sql`INSERT OR IGNORE INTO builder_secrets (k, v) VALUES ('ownerDigest', ${ownerKey})`;
			this
				.sql`INSERT OR IGNORE INTO builder_secrets (k, v) VALUES ('creationDigest', ${creationDigest})`;
			return this.authorizeProject(ownerKey);
		}
		if (!equalTokenDigest(recordedCreation, creationDigest)) return false;
		if (await this.authorizeProject(ownerKey)) return true;
		const previousOwner = this.getOwnerRecord()?.ownerKey;
		if (!previousOwner) return false;
		const anchored = Boolean(
			this.messages.length > 0 ||
			this.state.siteReady ||
			this.state.buildStarted ||
			this.state.initialGeneration ||
			this.hasOwnerActivity(),
		);
		if (anchored) return false;
		const changed = this.sql<{
			v: string;
		}>`UPDATE builder_secrets SET v = ${ownerKey}
			WHERE k = 'ownerDigest' AND v = ${previousOwner} RETURNING v`;
		if (changed.length !== 1) return false;
		this.closeStaleAgentConnections(ownerKey, "Ownership changed");
		return true;
	}

	/** Called by the Worker before it forwards an Agent HTTP/WebSocket request. */
	async authorizeOwner(ownerKey: string): Promise<{ authorized: boolean }> {
		const owner = this.getOwnerRecord();
		return { authorized: Boolean(owner) && equalTokenDigest(owner!.ownerKey, ownerKey) };
	}

	async authorizeProject(ownerKey: string): Promise<boolean> {
		return (await this.authorizeOwner(ownerKey)).authorized;
	}

	async confirmedPublicationUrlForOwner(ownerKey: string): Promise<string | undefined> {
		return (await this.authorizeProject(ownerKey)) ? this.state.publication?.liveUrl : undefined;
	}

	async openProjectSession(ownerKey: string) {
		const authorized = await this.authorizeProject(ownerKey);
		return authorized
			? { authorized, previewUrl: this.state.previewUrl, initialMessages: this.messages }
			: { authorized };
	}

	/** The Worker has fenced this project in the owner's catalogue before calling. */
	async deleteProjectForOwner(
		ownerKey: string,
	): Promise<"deleted" | "busy" | "forbidden" | "retry"> {
		this.ensureSecretsTable();
		const recorded = this.sql<{
			v: string;
		}>`SELECT v FROM builder_secrets WHERE k = 'ownerDigest'`[0];
		if (!recorded) return "deleted"; // A previous attempt cleared storage; finish catalogue removal.
		if (!equalTokenDigest(recorded.v, ownerKey)) return "forbidden";
		if (!this.isDeletionPending()) {
			const generationStatus = this.state.initialGeneration?.status;
			const hasBuildWork = Boolean(
				this.state.turnActive ||
				(generationStatus && isInitialGenerationActive(generationStatus)) ||
				this.hasOwnerActivityKind("chat") ||
				this.hasOwnerActivityKind("provision") ||
				this.provisionPromise ||
				this.activeProvisionPromise ||
				this.activeBuildConvergences.size,
			);
			if (hasBuildWork) {
				this.abortAllRequests();
				await this.requestStop(this.state.initialGeneration?.id);
			}
			const stable = await this.waitUntilStable({ timeout: 10_000 });
			if (stable) {
				for (const row of this.sql<{
					id: string;
				}>`SELECT id FROM owner_activity WHERE kind = 'chat'`) {
					this.finishOwnerActivity(row.id);
				}
				if (
					this.state.previewRestarting &&
					!this.recoveryPromise &&
					!this.hasOwnerActivityKind("resume-preview")
				) {
					this.setState({ ...this.state, previewRestarting: false });
				}
			}
			if (
				this.hasOwnerActivity() ||
				(this.stateWrittenHere && this.hasProgressInState()) ||
				this.provisionPromise ||
				this.activeProvisionPromise ||
				this.recoveryPromise ||
				!stable
			)
				return "busy";
			this.sql`INSERT OR REPLACE INTO builder_secrets (k, v) VALUES ('deleting', '1')`;
			this.closeAgentConnections("Project deleted");
		}
		this.deletionPromise ??= (async () => {
			await this.backupChain;
			try {
				await this.eraseProjectData();
				return "deleted" as const;
			} catch (error) {
				console.error(
					"[BuilderAgent] project deletion failed",
					redactArtifactsToken(String(error)),
				);
				return "retry" as const;
			}
		})();
		const deletion = this.deletionPromise;
		try {
			return await deletion;
		} finally {
			if (this.deletionPromise === deletion) this.deletionPromise = undefined;
		}
	}

	private async eraseProjectData(): Promise<void> {
		const publicationEnv = this.env as Env & PublicationEnv;
		if (publicationEnv.ProviderControlPlane && publicationEnv.WFP_RELEASES) {
			const cleanup = await publicationEnv.ProviderControlPlane.getByName(this.name).cleanupSite(
				this.name,
			);
			if (!cleanup.ok) throw new Error(`Published Site cleanup failed: ${cleanup.code}`);
		} else if (
			this.state.publication ||
			this.hasPendingPublishAttempt() ||
			this.isWfpCleanupRequired()
		) {
			throw new Error("Published Site cleanup is not configured.");
		}
		await deletePublishedSlug(this.env.AUTH_DB, this.name);
		await this.env.ARTIFACTS.delete(this.name);
		await this.env.Sandbox.getByName(this.name).deleteProjectData();
		await this.ctx.storage.deleteAll();
	}

	async claimOwnership(
		expectedGuestKey: string,
		accountOwnerKey: string,
	): Promise<"claimed" | "already-claimed" | "busy" | "conflict"> {
		let owner = this.getOwnerRecord();
		if (!owner) return "conflict";
		if (equalTokenDigest(owner.ownerKey, accountOwnerKey)) {
			this.closeStaleAgentConnections(accountOwnerKey, "Ownership changed");
			return "already-claimed";
		}
		if (!equalTokenDigest(owner.ownerKey, expectedGuestKey)) return "conflict";
		// Claims arrive by plain DO RPC, which skips onStart, so progress left
		// by an evicted instance may still be in state; only this instance's counts.
		if (
			this.hasOwnerActivity() ||
			(this.stateWrittenHere && this.hasProgressInState()) ||
			this.provisionPromise ||
			this.recoveryPromise ||
			!(await this.waitUntilStable({ timeout: 1 }))
		) {
			return "busy";
		}

		owner = this.getOwnerRecord();
		if (!owner) return "conflict";
		if (equalTokenDigest(owner.ownerKey, accountOwnerKey)) return "already-claimed";
		if (!equalTokenDigest(owner.ownerKey, expectedGuestKey)) return "conflict";
		const changed = this.sql<{
			v: string;
		}>`UPDATE builder_secrets SET v = ${accountOwnerKey} WHERE k = 'ownerDigest' AND v = ${expectedGuestKey} RETURNING v`;
		if (changed.length !== 1) return "conflict";
		this.closeAgentConnections("Ownership changed");
		return "claimed";
	}

	async getClaimableProjectSummary(
		expectedOwnerKey: string,
	): Promise<ProjectCatalogItem | undefined> {
		if (!(await this.authorizeProject(expectedOwnerKey))) return undefined;
		const firstUser = this.messages.find((message) => message.role === "user");
		if (!firstUser) return undefined;
		const text = firstUser.parts
			?.filter((part) => part.type === "text")
			.map((part) => (part as { text?: string }).text ?? "")
			.join(" ")
			.trim();
		const titleText = text || "Untitled site";
		const words = titleText.replace(/\s+/g, " ").split(" ").slice(0, 7).join(" ");
		const title = words.length < titleText.length ? `${words}…` : words;
		const status: ProjectCatalogItem["status"] = this.state.provisionError
			? "failed"
			: this.state.publication?.liveUrl || this.state.deploy?.liveUrl
				? "live"
				: this.state.complete
					? "draft"
					: "building";
		// When the brief was first saved, so a catalogue that learns of the site
		// late (sign-in reconciliation) lists it in place, not as brand new.
		const savedAt = this.sql<{ ms: number | null }>`
			SELECT CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS ms
			FROM cf_ai_chat_agent_messages WHERE id = ${firstUser.id}
		`[0]?.ms;
		const createdAt =
			typeof savedAt === "number" && Number.isSafeInteger(savedAt) && savedAt >= 0
				? savedAt
				: undefined;
		return {
			id: this.name,
			title,
			status,
			...(createdAt !== undefined && { createdAt }),
			updatedAt: Date.now(),
		};
	}

	async registerProjectForCurrentOwner(): Promise<void> {
		const owner = this.getOwnerRecord();
		if (!owner) throw new Error("Project owner is missing.");
		const summary = await this.getClaimableProjectSummary(owner.ownerKey);
		if (!summary) return;
		const result = await this.env.ProjectCatalog.getByName(owner.ownerKey).registerProject(
			owner.ownerKey,
			summary,
			owner.ownerKey.startsWith("account:") ? undefined : 10,
		);
		if (result !== "registered") {
			throw new Error(
				result === "limit-reached"
					? "Guest project limit reached. Sign in to keep building."
					: "Project ownership is changing. Sign in again to continue.",
			);
		}
		// A new site's first report reached the catalogue before its row did.
		if (this.reportedBuilding) this.reportBuildActivity(true);
	}

	/** Local validation hook. It is not registered as a client-callable method. */
	async provisionPreviewForValidation(hostname: string) {
		this.setState({
			...this.state,
			appHost: hostname,
			provisionError: undefined,
		});
		return this.withOwnerActivity("validation-provision", () => this.provisionSite(hostname));
	}

	/** Local validation hook. It is not registered as a client-callable method. */
	async restartPreviewForValidation() {
		return this.withOwnerActivity("validation-restart", () => this.restartDevServer());
	}

	/** Local validation hook. It is not registered as a client-callable method. */
	async capturePreviewForValidation() {
		return this.withOwnerActivity("validation-capture", async () => {
			const shot = await this.capturePreview();
			return shot.ok
				? { success: true, bytes: Math.floor((shot.base64.length * 3) / 4) }
				: { success: false, error: shot.error };
		});
	}

	/** Local validation hook: revoke forwarding without touching the site disk. */
	async deactivatePreviewForValidation() {
		return this.withOwnerActivity("validation-deactivate", async () => {
			const sandbox = this.getOrCreateSandbox();
			if (this.usesQuickTunnelPreview()) await this.stopQuickTunnel(sandbox);
			else await sandbox.unexposePort(4321);
			return { success: true, previewUrl: this.state.previewUrl };
		});
	}

	private usesQuickTunnelPreview(): boolean {
		const mode = (this.env as Env & { SANDBOX_PREVIEW_MODE?: string }).SANDBOX_PREVIEW_MODE;
		if (!mode || mode === "expose-port") return false;
		if (mode === "quick-tunnel") return true;
		throw new Error("SANDBOX_PREVIEW_MODE must be expose-port or quick-tunnel.");
	}

	private async quickTunnelUrl(process: SandboxProcess): Promise<string | undefined> {
		const status = await process.getStatus().catch(() => process.status);
		if (status !== "starting" && status !== "running") return;
		const logs = await process.getLogs().catch(() => undefined);
		const match = `${logs?.stdout ?? ""}\n${logs?.stderr ?? ""}`.match(QUICK_TUNNEL_URL);
		return match ? `${match[0].replace(/\/$/, "")}/` : undefined;
	}

	private async getOrCreateProcessSession(sandbox: SandboxInstance, id: string) {
		try {
			return await sandbox.createSession({ id });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof Error && error.name === "SessionAlreadyExistsError") {
				return sandbox.getSession(id);
			}
			if (!/already exists/i.test(message)) throw error;
			return sandbox.getSession(id);
		}
	}

	private async stopQuickTunnel(sandbox = this.getOrCreateSandbox()): Promise<void> {
		this.quickTunnelProcess = undefined;
		const session = await this.getOrCreateProcessSession(sandbox, QUICK_TUNNEL_SESSION_ID);
		const processes = await session.listProcesses().catch(() => []);
		await Promise.all(
			processes
				.filter((process) => process.command.includes("cloudflared tunnel"))
				.map((process) => process.kill("SIGTERM").catch(() => undefined)),
		);
	}

	private async exposeQuickTunnel(sandbox: SandboxInstance): Promise<{ url: string }> {
		if (this.quickTunnelProcess) {
			const url = await this.quickTunnelUrl(this.quickTunnelProcess);
			if (url) return { url };
			this.quickTunnelProcess = undefined;
		}
		const session = await this.getOrCreateProcessSession(sandbox, QUICK_TUNNEL_SESSION_ID);
		const processes = await session.listProcesses().catch(() => []);
		for (const process of processes) {
			if (!process.command.includes("cloudflared tunnel")) continue;
			const url = await this.quickTunnelUrl(process);
			if (url) {
				this.quickTunnelProcess = process;
				return { url };
			}
			await process.kill("SIGTERM").catch(() => undefined);
		}

		this.sendConsole("$ cloudflared tunnel (Worker Preview)");
		const process = await session.startProcess(
			"cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:4321",
			{ cwd: SITE_PATH },
		);
		this.quickTunnelProcess = process;
		try {
			const ready = await process.waitForLog(QUICK_TUNNEL_URL, 30_000);
			const url = ready.match?.[0] ?? ready.line.match(QUICK_TUNNEL_URL)?.[0];
			if (!url) throw new Error("cloudflared did not report a public URL.");
			return { url: `${url.replace(/\/$/, "")}/` };
		} catch (error) {
			await process.kill("SIGTERM").catch(() => undefined);
			if (this.quickTunnelProcess === process) this.quickTunnelProcess = undefined;
			throw error;
		}
	}

	/**
	 * Stable, per-session preview-URL token. `exposePort` mints a fresh random
	 * token when none is passed, so re-exposing on recovery (sandbox sleep, DO
	 * eviction, the interview -> build hand-off) would silently change the
	 * preview URL and 404 any client still holding the old one
	 * (`INVALID_TOKEN`). We generate one 16-char token once, persist it, and
	 * pass it to every `exposePort` call so the URL is stable for the session's
	 * life. The default stays 16 random hex characters. An isolated review
	 * deployment can reserve a short suffix for a narrowly routed hostname;
	 * the result still matches the SDK's 1-16 character token format.
	 */
	private ensurePreviewToken(): string {
		this.ensureSecretsTable();
		const suffix = (this.env as Env & { PREVIEW_ROUTE_SUFFIX?: string }).PREVIEW_ROUTE_SUFFIX;
		const rows = this.sql<{ v: string }>`SELECT v FROM builder_secrets WHERE k = 'previewToken'`;
		const existing = rows[0]?.v;
		if (existing) {
			if (suffix && !existing.endsWith(suffix)) {
				throw new Error("The existing preview token does not match PREVIEW_ROUTE_SUFFIX.");
			}
			return existing;
		}
		const legacy = previewTokenFromUrl(this.state.previewUrl, this.name);
		if (legacy) {
			if (suffix && !legacy.endsWith(suffix)) {
				throw new Error("The existing preview URL does not match PREVIEW_ROUTE_SUFFIX.");
			}
			this.sql`INSERT OR REPLACE INTO builder_secrets (k, v) VALUES ('previewToken', ${legacy})`;
			return legacy;
		}
		const bytes = new Uint8Array(8);
		crypto.getRandomValues(bytes);
		const token = previewTokenForRoute(bytes, suffix);
		this.sql`INSERT OR REPLACE INTO builder_secrets (k, v) VALUES ('previewToken', ${token})`;
		return token;
	}

	/** Reactivate the stable preview URL for the Sandbox's current runtime. */
	private async exposePreview(hostname: string): Promise<{ url: string }> {
		// Authorization survives a container restart, but current Sandbox SDKs
		// require exposePort() again to activate forwarding for the new runtime.
		// getExposedPorts() returns only currently-active ports.
		const sandbox = this.getOrCreateSandbox();
		if (this.usesQuickTunnelPreview()) return this.exposeQuickTunnel(sandbox);
		const existing = await sandbox
			.getExposedPorts(hostname)
			.then((ports) => ports.find((entry) => entry.port === 4321))
			.catch(() => undefined);
		if (existing) return { url: existing.url };

		try {
			return await sandbox.exposePort(4321, {
				hostname,
				name: "preview",
				token: this.ensurePreviewToken(),
			});
		} catch (error) {
			// Container startup restores persisted ports asynchronously. Close the
			// race where it becomes exposed between the list and expose calls.
			if (!/already exposed/i.test(error instanceof Error ? error.message : String(error))) {
				throw error;
			}
			const restored = (await sandbox.getExposedPorts(hostname)).find(
				(entry) => entry.port === 4321,
			);
			if (restored) return { url: restored.url };

			// A stale container-side exposure can outlive the SDK token record.
			// Clear that orphan and recreate it with our persisted preview token.
			await sandbox.unexposePort(4321);
			return await sandbox.exposePort(4321, {
				hostname,
				name: "preview",
				token: this.ensurePreviewToken(),
			});
		}
	}

	private persistArtifactsRemote(remote: string) {
		this.ensureSecretsTable();
		this.sql`INSERT OR REPLACE INTO builder_secrets (k, v) VALUES ('artifactsRemote', ${remote})`;
	}

	private getStoredArtifactsRemote(): string | undefined {
		this.ensureSecretsTable();
		const rows = this.sql<{ v: string }>`SELECT v FROM builder_secrets WHERE k = 'artifactsRemote'`;
		return rows[0]?.v;
	}

	/**
	 * The Artifacts repo handle from `get()` is an RPC stub, so `repo.remote` is
	 * a promise, not the URL string -- it must be awaited. We also persist it so
	 * later backups don't depend on the stub at all.
	 */
	private async resolveArtifactsRemote(repo: { remote: string }): Promise<string> {
		const stored = this.getStoredArtifactsRemote();
		if (stored) return stored;
		const remote = await repo.remote;
		this.persistArtifactsRemote(remote);
		return remote;
	}

	/**
	 * Get this session's Artifacts repo for writing, creating it on first save.
	 * The repo name is the DO id; the namespace is the binding's. Returns the
	 * git remote and a fresh write token.
	 */
	private async ensureArtifactsRepo(): Promise<{ remote: string; token: string }> {
		try {
			const repo = await this.env.ARTIFACTS.get(this.name);
			const tok = await repo.createToken("write", 900);
			return { remote: await this.resolveArtifactsRemote(repo), token: tok.plaintext };
		} catch (err) {
			if (!isArtifactsNotFound(err)) throw err;
			// First save for this session: create the repo. `create` returns a
			// plain result (remote is a real string) plus an initial write token.
			const created = await this.env.ARTIFACTS.create(this.name, {
				description: "EmDash Build session snapshot",
				setDefaultBranch: "main",
			});
			this.persistArtifactsRemote(created.remote);
			return { remote: created.remote, token: created.token };
		}
	}

	/**
	 * Get this session's Artifacts repo for reading (restore). Returns null when
	 * the repo doesn't exist yet (no snapshot), so the caller re-provisions.
	 */
	private async getArtifactsRepoForRead(): Promise<{ remote: string; token: string } | null> {
		try {
			const repo = await this.env.ARTIFACTS.get(this.name);
			const tok = await repo.createToken("read", 900);
			return { remote: await this.resolveArtifactsRemote(repo), token: tok.plaintext };
		} catch (err) {
			if (isArtifactsNotFound(err)) return null;
			throw err;
		}
	}

	/**
	 * Mint a short-lived read token and return a ready-to-run `git clone`
	 * command for this session's source (the Artifacts repo). Called by the
	 * client on demand -- the token is returned only to the caller, never
	 * broadcast or persisted, and the embedded read token expires within the
	 * hour. The clone contains the full site plus its local D1/R2 state, so
	 * `pnpm install && pnpm dev` boots it with content in place.
	 *
	 * Registered as a client-callable via `callable()` at the bottom of this
	 * file rather than the `@callable` decorator: the build does not transpile
	 * decorator syntax and workerd rejects it at parse time.
	 */
	async getCloneInfo(): Promise<CloneInfo> {
		if (!this.state.siteReady) {
			return { ok: false, reason: "Your site is still being set up. Try again once it's ready." };
		}
		let repo: Awaited<ReturnType<(typeof this.env.ARTIFACTS)["get"]>>;
		try {
			repo = await this.env.ARTIFACTS.get(this.name);
		} catch (err) {
			if (isArtifactsNotFound(err)) {
				return { ok: false, reason: "No snapshot saved yet. Make a change first, then clone." };
			}
			throw err;
		}
		const tok = await repo.createToken("read", CLONE_TOKEN_TTL_SECONDS);
		const remote = await this.resolveArtifactsRemote(repo);
		// Artifacts accepts the token as the basic-auth password (the username
		// is ignored), per the docs: https://x:<token>@.../repo.git. This keeps
		// the user's clone to a single paste with no header gymnastics.
		const cloneUrl = remote.replace(/^https:\/\//, `https://x:${tok.plaintext}@`);
		const command = `git clone ${cloneUrl} my-site\ncd my-site\npnpm install\npnpm dev`;
		return { ok: true, cloneUrl, repoUrl: remote, command, expiresAt: tok.expiresAt };
	}

	/**
	 * Reveal the "Clone locally" panel in the UI. Triggered by the `offer_clone`
	 * tool when the user signals developer intent. Carries no secret -- the
	 * client mints the token itself via `getCloneInfo` when the panel opens.
	 */
	private offerClone(): { success: boolean } {
		this.broadcast(JSON.stringify({ type: "offer-clone" }));
		return { success: true };
	}

	private getOrCreateSandbox() {
		if (!this.sandbox) {
			this.sandbox = getSandbox(this.env.Sandbox, this.name, {
				sleepAfter: this.usesQuickTunnelPreview() ? "30m" : "5m",
			});
		}
		return this.sandbox;
	}

	private async runSandboxRead<T>(
		operation: (sandbox: SandboxInstance) => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		try {
			return await operation(this.getOrCreateSandbox());
		} catch (error) {
			if (!isSandboxRuntimeReplacement(error)) throw error;
			this.sendConsole("Sandbox runtime changed; retrying the read...");
			this.sandbox = null;
			await new Promise((resolve) => setTimeout(resolve, 750));
			signal?.throwIfAborted();
			return operation(this.getOrCreateSandbox());
		}
	}

	/** Retry the first harmless command when the Sandbox DO is reset while waking. */
	private async execRecoveryCommand(command: string, timeout: number) {
		let lastError: unknown;
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				return await this.getOrCreateSandbox().exec(command, { timeout });
			} catch (error) {
				lastError = error;
				if (!isSandboxWakeReset(error) || attempt === 3) throw error;
				this.sendConsole(`Sandbox wake was reset; retrying (${attempt}/3)...`);
				this.sandbox = null;
				this.devServerProcess = undefined;
				this.devServerProcessId = undefined;
				await new Promise((resolve) => setTimeout(resolve, attempt * 750));
			}
		}
		throw lastError;
	}

	/**
	 * Set the status label shown under the chat. Lives in synced state so it
	 * survives client refresh/reconnect, not just a live broadcast.
	 */
	private sendStatus(status: string) {
		this.touchBuildActivity();
		if (this.state.status === status) return;
		this.setState({ ...this.state, status });
	}

	/**
	 * A step's own progress on the status line. Clearing removes only this
	 * step's latest line, so a parallel step's progress is not blanked, and
	 * ends the line: a straggler (a worker still settling after Stop) cannot
	 * bring it back.
	 */
	private statusLine() {
		let shown: string | undefined;
		let ended = false;
		return {
			set: (status: string) => {
				if (ended) return;
				shown = status;
				this.sendStatus(status);
			},
			clear: () => {
				ended = true;
				if (shown !== undefined && this.state.status === shown) this.sendStatus("");
				shown = undefined;
			},
		};
	}

	/** Refresh the last-known-good public HTML without routing through the slow preview path. */
	private async refreshPreviewCache(path = "/", ensureOnly = false): Promise<boolean> {
		try {
			const sandbox = this.env.Sandbox.getByName(this.name);
			if (ensureOnly && (await sandbox.hasCachedPreview(path))) return true;
			const result = await sandbox.refreshPreview(path);
			// A route that renders but is uncacheable (negotiated Vary) is served live.
			if (result.success || result.rendered) return true;
			this.sendConsole(`Warning: preview snapshot returned HTTP ${result.status ?? "unknown"}.`);
		} catch (error) {
			this.sendConsole(
				`Warning: preview snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return false;
	}

	private refreshAndReloadPreview(initialBuild = false): Promise<void> {
		return this.refreshAndReloadPreviewInternal(initialBuild);
	}

	/**
	 * After a content or source change: mark every snapshot stale, then
	 * re-render `/` and the routes open in the builder so the reload that
	 * follows shows current HTML on whatever page the user is viewing.
	 */
	private async refreshPreviewSnapshots(): Promise<boolean> {
		try {
			const sandbox = this.env.Sandbox.getByName(this.name);
			const [home] = await sandbox.refreshPreviews(["/", ...this.viewedPreviewPaths()], {
				invalidate: true,
			});
			if (home?.success || home?.rendered) return true;
			this.sendConsole(
				home?.error
					? `Warning: preview snapshot failed: ${home.error}`
					: `Warning: preview snapshot returned HTTP ${home?.status ?? "unknown"}.`,
			);
		} catch (error) {
			this.sendConsole(
				`Warning: preview snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return false;
	}

	/** Record the route a builder client is viewing so mutations refresh it too. */
	async setPreviewPath(path: unknown): Promise<void> {
		const normalized = normalizePreviewPath(path);
		if (!normalized) return;
		const documentPath = previewDocumentPath(normalized);
		if (isAdminPreviewPath(documentPath)) return;
		// One row per builder connection: each tab's latest route replaces its
		// previous one, and `/` (always refreshed) just retires it.
		const client = getCurrentAgent().connection?.id ?? "server";
		this.ensurePreviewRoutesTable();
		if (documentPath === "/") {
			this.sql`DELETE FROM builder_preview_routes WHERE client = ${client}`;
			return;
		}
		this.sql`INSERT OR REPLACE INTO builder_preview_routes (client, path, viewed_at)
			VALUES (${client}, ${documentPath}, ${Date.now()})`;
		this.sql`DELETE FROM builder_preview_routes WHERE client NOT IN (
			SELECT client FROM builder_preview_routes ORDER BY viewed_at DESC, rowid DESC
			LIMIT ${MAX_TRACKED_PREVIEW_CLIENTS}
		)`;
	}

	/** Durable so hibernation does not silently drop the routes to keep fresh. */
	private ensurePreviewRoutesTable() {
		this.sql`CREATE TABLE IF NOT EXISTS builder_preview_routes (
			client TEXT PRIMARY KEY,
			path TEXT NOT NULL,
			viewed_at INTEGER NOT NULL
		)`;
	}

	private viewedPreviewPaths(): string[] {
		this.ensurePreviewRoutesTable();
		const rows = this.sql<{ path: string }>`SELECT path FROM builder_preview_routes
			ORDER BY viewed_at DESC, rowid DESC`;
		return [...new Set(rows.map((row) => row.path))].slice(0, MAX_VIEWED_PREVIEW_PATHS);
	}

	/** Re-render one route on demand, for the preview toolbar's Reload button. */
	async refreshPreviewRoute(path: unknown): Promise<{ refreshed: boolean }> {
		const normalized = normalizePreviewPath(path);
		if (!normalized || !this.state.previewUrl || this.state.previewRestarting) {
			return { refreshed: false };
		}
		const documentPath = previewDocumentPath(normalized);
		if (isAdminPreviewPath(documentPath)) return { refreshed: false };
		await this.setPreviewPath(documentPath);
		const settled = await settleWithin(
			this.env.Sandbox.getByName(this.name).refreshPreview(documentPath),
			PREVIEW_ROUTE_REFRESH_TIMEOUT_MS,
		);
		return {
			refreshed:
				settled.status === "fulfilled" &&
				(settled.value.success || settled.value.rendered === true),
		};
	}

	/**
	 * Whether a route's snapshot is current, for a preview still showing a
	 * STALE copy: a cheap read the toolbar polls before reloading, so a render
	 * that lands late still reaches the open page without blind reloads.
	 */
	async getPreviewRouteSnapshot(path: unknown): Promise<"current" | "stale" | "missing"> {
		const normalized = normalizePreviewPath(path);
		if (!normalized) return "missing";
		const documentPath = previewDocumentPath(normalized);
		if (isAdminPreviewPath(documentPath)) return "missing";
		try {
			return await this.env.Sandbox.getByName(this.name).previewSnapshotState(documentPath);
		} catch {
			return "stale";
		}
	}

	private async refreshAndReloadPreviewInternal(initialBuild = false): Promise<void> {
		const refreshed = await this.refreshPreviewSnapshots();
		const update = recordPersonalizationMilestone(this.state, initialBuild, refreshed);
		if (update) this.publishMilestone("personalized", update);
		this.broadcast(JSON.stringify({ type: "reload" }));
	}

	private publishMilestone(
		milestone: BuilderMilestone,
		update: BuilderMilestoneUpdate<BuilderState>,
	): BuilderState {
		this.setState(update.state);
		console.log(
			JSON.stringify({
				event: "builder.milestone",
				sessionId: this.name,
				milestone,
				elapsedMs: update.elapsedMs,
			}),
		);
		return update.state;
	}

	/** Record a readiness boundary once and expose both the flag and elapsed timing. */
	private markMilestone(milestone: BuilderMilestone): BuilderState {
		const at = Date.now();
		const update = recordBuilderMilestone(this.state, milestone, at);
		return update ? this.publishMilestone(milestone, update) : this.state;
	}

	/**
	 * The scaffold's AGENTS.md, passed verbatim into the build system prompt.
	 * The first successful read is pinned in SQLite: the site copy lives in
	 * the model-writable sandbox, so re-reading it would let the agent rewrite
	 * its own instructions. Projects created before pinning fall back to one
	 * sandbox read. Returns undefined if the guidance can't be read.
	 */
	private async loadTemplateGuidance(): Promise<string | undefined> {
		if (this.templateGuidance) return this.templateGuidance;
		this.ensureSecretsTable();
		const pinned = this.sql<{ v: string }>`
			SELECT v FROM builder_secrets WHERE k = 'templateGuidance'
		`[0]?.v;
		if (pinned) return (this.templateGuidance = pinned);
		const sandbox = this.getOrCreateSandbox();
		try {
			const result = await sandbox.exec(`cat ${SITE_PATH}/AGENTS.md`, { timeout: 5000 });
			if (result.success && result.stdout.trim()) return this.pinTemplateGuidance(result.stdout);
		} catch {
			// fall through
		}
		return undefined;
	}

	private pinTemplateGuidance(guidance: string): string {
		this.ensureSecretsTable();
		this.sql`INSERT OR IGNORE INTO builder_secrets (k, v) VALUES ('templateGuidance', ${guidance})`;
		this.templateGuidance =
			this.sql<{ v: string }>`SELECT v FROM builder_secrets WHERE k = 'templateGuidance'`[0]?.v ??
			guidance;
		return this.templateGuidance;
	}

	private startInitialScaffoldPrefetch(
		sandbox = this.getOrCreateSandbox(),
	): Promise<InitialScaffoldContext> {
		return this.initialScaffoldPrefetch.start(
			async (signal) => {
				try {
					const result = await readFilesFromSandbox(sandbox, INITIAL_SCAFFOLD_PATHS, {
						streamFile,
						signal,
					});
					return createInitialScaffoldContext(result);
				} catch {
					return emptyInitialScaffoldContext();
				}
			},
			(context) => {
				if (context.templateGuidance) this.pinTemplateGuidance(context.templateGuidance);
			},
		);
	}

	/** Rebuild the bounded blank snapshot after eviction if the first build has not started. */
	private async loadInitialScaffoldContext(): Promise<InitialScaffoldContext> {
		const context = await (this.initialScaffoldPrefetch.current() ??
			this.startInitialScaffoldPrefetch());
		return context.templateGuidance
			? { ...context, templateGuidance: this.pinTemplateGuidance(context.templateGuidance) }
			: context;
	}

	/** Wait for the dev listener after HMR/restart without forcing a slow SSR render. */
	private async waitForDevServer(signal?: AbortSignal): Promise<void> {
		const sandbox = this.getOrCreateSandbox();
		for (let i = 0; i < 20; i++) {
			signal?.throwIfAborted();
			try {
				const check = await sandbox.exec("timeout 1 bash -c 'echo > /dev/tcp/127.0.0.1/4321'", {
					timeout: 3000,
					signal,
				});
				if (check.success) return;
			} catch {
				// Server is mid-restart; keep polling.
			}
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	/**
	 * Run the setup dev-bypass: migrations, seed, dev admin, and a full-scope
	 * API token in one call. Returns the token, or undefined if it could not
	 * be obtained.
	 *
	 * The first hit to each EmDash route makes Vite lazily optimize its deps
	 * (the `emdash/middleware/*` chain, then the `@emdash-cms/cloudflare`
	 * sandbox + R2 storage adapters that the seed touches) and trigger a
	 * "program reload" that tears down the in-flight request. A single call
	 * stalls forever here. We warm the common routes to force most of those
	 * optimizations up front, then retry the bypass past any remaining reloads.
	 * Each curl is short so reload-killed requests fail fast and we churn
	 * through the optimization rounds quickly, logging every attempt so the
	 * progress is visible in the console.
	 */
	private async runDevBypass(signal?: AbortSignal): Promise<string | undefined> {
		signal?.throwIfAborted();
		const sandbox = this.getOrCreateSandbox();
		const base = "http://localhost:4321";
		const bypassUrl = `${base}/_emdash/api/setup/dev-bypass?token=1&content=0`;

		// Warm the base route so Vite runs its initial dep-optimize pass. The
		// first hit to the dev-bypass route then triggers a final round of
		// optimization (runtime, zod, seed/storage adapters), which on a cold
		// cache makes Vite re-bundle and briefly 500 with "chunk does not
		// exist" before it settles. That self-heals, so we health-gate each
		// attempt and keep retrying past the churn until the endpoint returns
		// its JSON token. The response shape is { data: { token } }.
		await sandbox
			.exec(`curl -s -o /dev/null --max-time 30 ${base}/`, { timeout: 35000, signal })
			.catch(() => {});
		signal?.throwIfAborted();

		for (let attempt = 1; attempt <= 24; attempt++) {
			signal?.throwIfAborted();
			// The explicit warm-up above already proved the first request can run.
			// Re-probing before attempt 1 used to queue twenty short-lived root
			// renders behind Vite's optimizer, adding roughly 50 seconds locally.
			// Health-gate only retries after an actual failed bypass request.
			if (attempt > 1) await this.waitForDevServer(signal);
			// curl -sS returns exit 0 even for HTTP 500, so capture the status
			// code on its own trailing line to tell "still settling" (5xx) from
			// a real success.
			const res = await sandbox
				.exec(`curl -sS -w '\\n%{http_code}' --max-time 60 '${bypassUrl}'`, {
					timeout: 65000,
					signal,
				})
				.catch(() => null);
			signal?.throwIfAborted();
			if (res?.success) {
				const out = res.stdout;
				const nl = out.lastIndexOf("\n");
				const status = (nl >= 0 ? out.slice(nl + 1) : "").trim();
				const body = nl >= 0 ? out.slice(0, nl) : out;
				if (status === "200") {
					try {
						const parsed = JSON.parse(body) as { data?: { token?: string } };
						if (parsed.data?.token) {
							this.sendConsole(`Setup complete (attempt ${attempt}).`);
							return parsed.data.token;
						}
						this.sendConsole(`Setup attempt ${attempt}: 200 but no token in response.`);
					} catch {
						this.sendConsole(`Setup attempt ${attempt}: 200 but body was not JSON.`);
					}
				} else {
					this.sendConsole(`Setup attempt ${attempt}: HTTP ${status || "?"}, retrying...`);
				}
			} else {
				this.sendConsole(`Setup attempt ${attempt}: request failed, retrying...`);
			}
			await new Promise((r) => setTimeout(r, 3000));
			signal?.throwIfAborted();
		}
		return undefined;
	}

	/**
	 * Send a console log line to all connected clients, and keep it in a bounded
	 * in-memory buffer so a client that reloads (or connects late) can rehydrate
	 * the recent output via `getRecentConsole` instead of showing an empty panel.
	 */
	private sendConsole(text: string) {
		// Long commands and deploys print as they run, even between steps.
		this.touchBuildActivity();
		this.consoleBuffer.push(text);
		if (this.consoleBuffer.length > CONSOLE_BUFFER_MAX) {
			this.consoleBuffer.splice(0, this.consoleBuffer.length - CONSOLE_BUFFER_MAX);
		}
		this.broadcast(JSON.stringify({ type: "console", text }));
	}

	/** Recent console output, so a reloaded client can catch up. Client-callable. */
	async getRecentConsole(): Promise<string[]> {
		return this.consoleBuffer;
	}

	/** Durable transcript and activity needed to classify a dropped client action. */
	async getClientRecoveryState(): Promise<ClientRecoveryState> {
		this.ensureOwnerActivityTable();
		return {
			messages: this.messages,
			turnActive:
				this.sql<{ id: string }>`SELECT id FROM owner_activity WHERE kind = 'chat' LIMIT 1`.length >
				0,
			initialGeneration: this.state.initialGeneration,
		};
	}

	/**
	 * Drain a ReadableStream<Uint8Array> of SSE events, broadcasting
	 * stdout/stderr data lines to the console panel.
	 */
	private async pumpLogs(
		stream: ReadableStream<Uint8Array>,
		recordRenderErrors = false,
	): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith("data: ")) continue;
					try {
						const event = JSON.parse(trimmed.slice(6)) as {
							type?: string;
							data?: string;
							exitCode?: number;
							error?: string;
						};
						if (
							(event.type === "stdout" || event.type === "stderr") &&
							typeof event.data === "string"
						) {
							const text = event.data.replace(/\n$/, "");
							if (text) {
								if (recordRenderErrors) {
									const summary = renderErrorSummary(text);
									if (summary) {
										this.devServerErrors.push({ at: Date.now(), text: summary });
										this.devServerErrors = this.devServerErrors.slice(-8);
									}
								}
								this.sendConsole(text);
							}
						} else if (event.type === "complete") {
							this.sendConsole(`Process exited with code ${event.exitCode ?? "unknown"}`);
						} else if (event.type === "error") {
							this.sendConsole(`ERROR: ${event.error ?? event.data ?? "unknown"}`);
						}
					} catch {
						if (trimmed) this.sendConsole(trimmed);
					}
				}
			}
			if (buffer.trim()) this.sendConsole(buffer.trim());
		} catch (err) {
			this.sendConsole(`[stream ended: ${err instanceof Error ? err.message : String(err)}]`);
		} finally {
			reader.releaseLock();
		}
	}

	/** Run `pnpm install` in the site dir, streaming logs. Returns the exit code. */
	private async installDeps(signal?: AbortSignal): Promise<number> {
		signal?.throwIfAborted();
		const sandbox = this.getOrCreateSandbox();
		this.sendStatus("Installing dependencies...");
		this.sendConsole("$ pnpm install");
		const install = await sandbox.startProcess(
			"pnpm install --prefer-offline --reporter=append-only",
			{
				cwd: SITE_PATH,
			},
		);
		const installLogs = await sandbox.streamProcessLogs(install.id);
		const installLogsDone = this.pumpLogs(installLogs);
		const stopInstall = () => void install.kill("SIGTERM").catch(() => {});
		signal?.addEventListener("abort", stopInstall, { once: true });
		if (signal?.aborted) stopInstall();
		try {
			const installResult = await install.waitForExit(300000);
			signal?.throwIfAborted();
			return installResult.exitCode;
		} finally {
			signal?.removeEventListener("abort", stopInstall);
			await installLogsDone.catch(() => {});
		}
	}

	/** Reapply runtime-critical config that model-authored edits must preserve. */
	private async protectAstroConfig(stripSandboxPlugin = false): Promise<void> {
		const sandbox = this.getOrCreateSandbox();
		const astroPath = `${SITE_PATH}/astro.config.mjs`;
		const cfg = await sandbox.readFile(astroPath, { encoding: "utf-8" });
		if (!cfg.success) return;
		const base = stripSandboxPlugin ? stripSandboxFromAstroConfig(cfg.content) : cfg.content;
		const optimized = ensureSsrOptimizeDep(base, SSR_OPTIMIZE_DEPS, SSR_OPTIMIZE_EXCLUDES);
		const patched = ensurePreviewHmr(optimized);
		if (patched !== cfg.content) await sandbox.writeFile(astroPath, patched);
	}

	/** Start `pnpm dev`, stream its logs, and block until port 4321 is up. */
	private async startDevServer(
		previewUrl = this.state.previewUrl,
		configurationReady = false,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const sandbox = this.getOrCreateSandbox();
		const quickTunnel = this.usesQuickTunnelPreview();
		if (!configurationReady) await this.protectAstroConfig();
		await sandbox.writeFile(`${SITE_PATH}/src/worker.ts`, CANONICAL_WORKER_TS);
		// Pin the public origin to the internal HTTP dev server. The preview is
		// served through a TLS-terminating proxy, so the request arrives with
		// `X-Forwarded-Proto: https` while the dev server only speaks HTTP on
		// localhost:4321. Without this, getPublicOrigin() resolves to
		// `https://localhost:4321`, so the responsive-image pipeline builds
		// `/_image?href=https://localhost:4321/...` and the SSR fetch does TLS
		// against the plain-HTTP server (workerd: WRONG_VERSION_NUMBER), 404ing
		// every image. EMDASH_SITE_URL is read at runtime via process.env
		// (exposed from .dev.vars under nodejs_compat) and takes priority over
		// the request origin. The browser still loads `/_image` from the public
		// preview origin; only the internal href scheme is corrected.
		await sandbox.writeFile(
			`${SITE_PATH}/.dev.vars`,
			[
				"EMDASH_SITE_URL=http://localhost:4321",
				...(previewUrl ? [`EMDASH_PREVIEW_URL=${previewUrl}`] : []),
				"",
			].join("\n"),
		);
		signal?.throwIfAborted();
		this.sendStatus("Starting dev server...");
		const archivedModules = await sandbox.exec(
			`grep -q '/tmp/pnpm-store' ${SITE_PATH}/node_modules/.modules.yaml`,
			{ signal },
		);
		const previewVariables = [
			...(previewUrl ? [`EMDASH_PREVIEW_URL=${shellQuote(previewUrl)}`] : []),
			...(quickTunnel ? ["__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.trycloudflare.com"] : []),
		];
		const previewEnv = previewVariables.length > 0 ? `${previewVariables.join(" ")} ` : "";
		const devCommand = archivedModules.success
			? `mkdir -p /tmp/pnpm-store && ${previewEnv}PNPM_CONFIG_STORE_DIR=/tmp/pnpm-store pnpm dev --host 0.0.0.0`
			: `${previewEnv}pnpm dev --host 0.0.0.0`;
		this.sendConsole(archivedModules.success ? "$ pnpm dev (prepared archive)" : "$ pnpm dev");
		const processHost = quickTunnel
			? await this.getOrCreateProcessSession(sandbox, DEV_SERVER_SESSION_ID)
			: sandbox;
		const devServer = await processHost.startProcess(devCommand, { cwd: SITE_PATH });
		this.devServerProcess = devServer;
		this.devServerProcessId = devServer.id;
		const stopOnAbort = () => void devServer.kill("SIGTERM").catch(() => {});
		signal?.addEventListener("abort", stopOnAbort, { once: true });
		if (signal?.aborted) stopOnAbort();
		this.devServerErrors = [];
		const logStream = await sandbox.streamProcessLogs(devServer.id);
		const logsDone = this.pumpLogs(logStream, true);
		try {
			await this.waitForDevServerPort(45_000, signal);
			signal?.throwIfAborted();
		} catch (error) {
			await this.stopDevServer();
			throw error;
		} finally {
			signal?.removeEventListener("abort", stopOnAbort);
		}
		void logsDone;
		this.sendConsole("Dev server ready on port 4321.");
	}

	/**
	 * Sandbox Process.waitForPort occasionally misses a restarted listener until
	 * its full timeout. Probe the container TCP socket directly and keep the
	 * product's restart boundary below a minute.
	 */
	private async waitForDevServerPort(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		return this.waitForSandboxPort(4321, timeoutMs, "Dev server", signal);
	}

	private async waitForSandboxPort(
		port: number,
		timeoutMs: number,
		label: string,
		signal?: AbortSignal,
	): Promise<void> {
		const sandbox = this.getOrCreateSandbox();
		const deadline = Date.now() + timeoutMs;
		do {
			signal?.throwIfAborted();
			const probe = await sandbox
				.exec(`timeout 1 bash -c 'echo > /dev/tcp/127.0.0.1/${port}'`, {
					timeout: 3000,
					signal,
				})
				.catch(() => null);
			signal?.throwIfAborted();
			if (probe?.success) return;
			await new Promise((resolve) => setTimeout(resolve, 250));
		} while (Date.now() < deadline);
		throw new Error(`${label} did not listen on port ${port} within ${timeoutMs / 1000}s.`);
	}

	/**
	 * Screenshot the current preview by driving a headless Chrome INSIDE the
	 * sandbox (agent-browser, baked into the image) against localhost:4321.
	 * Returns a PNG as base64 for the multimodal model. A bounded copy may be stored
	 * separately for the client; image bytes never enter the chat transcript.
	 *
	 * This runs entirely on the container's loopback -- no Cloudflare Browser
	 * Run, no proxy chain -- so it works in local dev. Each shot uses a unique,
	 * self-closing browser session: a stale daemon/session from one long model
	 * turn must not block the next visual check. Restrict navigation to container
	 * loopback so external fonts or services cannot stall `Page.navigate`; set
	 * the viewport after launch so that network containment remains available.
	 */
	private async capturePreview(signal?: AbortSignal): Promise<PreviewShot> {
		if (!this.state.siteReady) return { ok: false, error: "The preview isn't ready yet." };
		const outPath = "/tmp/emdash-preview.png";
		try {
			const shot = await this.runSandboxRead((sandbox) => {
				const browserSession = `preview-${crypto.randomUUID().slice(0, 8)}`;
				return sandbox.exec(
					`AGENT_BROWSER_DEFAULT_TIMEOUT=45000 AGENT_BROWSER_ARGS=--disable-dev-shm-usage agent-browser --session ${browserSession} ` +
						`--allowed-domains localhost,127.0.0.1 ` +
						`batch 'open http://127.0.0.1:4321/' 'set viewport 1024 640' ` +
						`'screenshot ${outPath}' 'close'`,
					{ timeout: 90000, signal },
				);
			}, signal);
			if (!shot.success) {
				return {
					ok: false,
					error: `Screenshot failed: ${(shot.stderr || shot.stdout || "agent-browser failed").slice(0, 300)}`,
				};
			}
			const file = await this.runSandboxRead(
				(sandbox) => sandbox.readFile(outPath, { encoding: "base64" }),
				signal,
			);
			if (!file.success) return { ok: false, error: "Screenshot captured but could not be read." };
			return { ok: true, base64: file.content, mediaType: "image/png" };
		} catch (err) {
			return {
				ok: false,
				error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	/** Kill the tracked `pnpm dev` process if running. Safe to call when stopped. */
	private async stopDevServer(): Promise<void> {
		const sandbox = this.getOrCreateSandbox();
		if (this.devServerProcess) {
			await this.devServerProcess.kill("SIGTERM").catch(() => {});
		} else if (this.devServerProcessId) {
			await sandbox.killProcess(this.devServerProcessId).catch(() => {});
		}
		this.devServerProcess = undefined;
		this.devServerProcessId = undefined;
		const stopped = await sandbox.exec(
			"pkill -f '[a]stro dev' || true; " +
				"for attempt in $(seq 1 20); do " +
				"if ! timeout 1 bash -c 'echo > /dev/tcp/127.0.0.1/4321' 2>/dev/null; then exit 0; fi; " +
				"sleep 0.1; done; exit 1",
			{ cwd: SITE_PATH, timeout: 5000 },
		);
		if (!stopped.success) throw new Error("The previous dev server did not stop cleanly.");
	}

	/**
	 * Cleanly restart the dev server: kill the tracked `pnpm dev` process and
	 * start a fresh one. The agent owns the dev-server lifecycle, so this is the
	 * sanctioned way to pick up a newly-installed dependency or recover a stuck
	 * server -- the model must never start/kill it via `exec` (port conflicts).
	 */
	private async restartDevServer(
		metrics?: TurnMetrics,
	): Promise<{ success: boolean; error?: string }> {
		this.sendStatus("Restarting dev server...");
		this.sendConsole("$ restart dev server");
		this.setState({ ...this.state, previewRestarting: true });
		try {
			await this.stopDevServer();
			await this.startDevServer();
			await timeSync(metrics, "previewRefresh", () => this.refreshPreviewSnapshots());
			this.setState({ ...this.state, previewRestarting: false, provisionError: undefined });
			this.broadcast(JSON.stringify({ type: "reload" }));
			return { success: true };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.sendConsole(`Warning: dev server restart lost its transport: ${message}`);
			this.sandbox = null;
			this.devServerProcess = undefined;
			this.devServerProcessId = undefined;
			const appHost = this.state.appHost;
			const hostname = appHost && isLocalHostname(appHost) ? appHost : this.env.PREVIEW_HOSTNAME;
			try {
				const recovered = await this.recoverSite(hostname, true);
				if (recovered.ready) {
					this.setState({
						...this.state,
						previewRestarting: false,
						provisionError: undefined,
					});
					this.broadcast(JSON.stringify({ type: "reload" }));
					this.sendConsole("Preview reconnected after container restart.");
					return { success: true };
				}
			} catch (recoveryError) {
				const recoveryMessage =
					recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
				this.sendConsole(`Warning: preview recovery failed: ${recoveryMessage}`);
				this.setState({ ...this.state, previewRestarting: false });
				return { success: false, error: `${message}; recovery: ${recoveryMessage}` };
			}
			this.setState({ ...this.state, previewRestarting: false });
			return { success: false, error: message };
		} finally {
			this.sendStatus("");
		}
	}

	/** Point the agent's MCP client at the EmDash server behind the preview URL. */
	private async connectMcp(
		exposedUrl: string,
		apiToken: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		signal?.throwIfAborted();
		this.sendStatus("Connecting to CMS...");
		const mcpUrl = `${exposedUrl}_emdash/api/mcp`;

		const existingServers = this.getMcpServers();
		for (const [id] of Object.entries(existingServers.servers)) {
			signal?.throwIfAborted();
			try {
				await this.removeMcpServer(id);
			} catch {
				// ignore
			}
		}
		try {
			await this.retry(
				() => {
					signal?.throwIfAborted();
					return this.addMcpServer("emdash", mcpUrl, {
						transport: {
							headers: { Authorization: `Bearer ${apiToken}` },
							type: "streamable-http",
						},
					});
				},
				{ maxAttempts: 10, baseDelayMs: 3000, maxDelayMs: 3000 },
			);
			signal?.throwIfAborted();
			this.sendConsole("Connected to EmDash MCP server.");
			return true;
		} catch (err) {
			if (signal?.aborted) throw err;
			const msg = err instanceof Error ? err.message : String(err);
			this.sendConsole(`Warning: MCP connection failed: ${msg}`);
			return false;
		}
	}

	/**
	 * Bring an already-provisioned session back up after the sandbox slept
	 * (ephemeral disk is wiped on sleep) or the DO was evicted.
	 *
	 * - dev server still answering → container is warm, nothing to rebuild.
	 * - site dir present but server down → restart the dev server.
	 * - site dir gone → `git clone` the session's Artifacts repo, reinstall,
	 *   restart.
	 *
	 * Returns `ready: false` when restoration is unavailable. Established sites
	 * must surface that failure; they are never replaced with a clean template.
	 */
	private recoverSite(hostname: string, reconnectMcp = false): Promise<SiteRecoveryResult> {
		if (reconnectMcp) this.recoveryReconnectMcp = true;
		if (this.recoveryPromise) return this.recoveryPromise;
		const pending = this.doRecoverSite(hostname).finally(() => {
			if (this.recoveryPromise === pending) {
				this.recoveryPromise = null;
				this.recoveryReconnectMcp = false;
			}
		});
		this.recoveryPromise = pending;
		return pending;
	}

	private async doRecoverSite(hostname: string): Promise<SiteRecoveryResult> {
		let sandbox = this.getOrCreateSandbox();

		// Probe the listening socket, not `/`. A warm Astro process can spend
		// several seconds bundling a newly reached route; treating that HTTP
		// timeout as a dead server starts a second `pnpm dev` on the same port.
		// The sandbox command may itself throw during container churn, so a failed
		// probe simply falls through to the normal restore/restart path.
		const probe = await this.execRecoveryCommand(
			"timeout 2 bash -c 'echo > /dev/tcp/127.0.0.1/4321'",
			5000,
		).catch(() => null);
		if (probe?.success) {
			const workerEntry = await sandbox.readFile(`${SITE_PATH}/src/worker.ts`, {
				encoding: "utf-8",
			});
			const workerEntryChanged =
				!workerEntry.success || workerEntry.content !== CANONICAL_WORKER_TS;
			const previousUrl = this.state.previewUrl;
			const exposed = await this.exposePreview(hostname);
			const tunnelChanged =
				this.usesQuickTunnelPreview() && previousUrl !== undefined && previousUrl !== exposed.url;
			if (workerEntryChanged || tunnelChanged) {
				this.sendConsole(
					workerEntryChanged
						? "Applying the current protected preview runtime..."
						: "Quick tunnel changed; restarting preview on the new URL...",
				);
				await this.stopDevServer();
				await this.startDevServer(exposed.url);
			}
			await this.refreshPreviewCache("/", true);
			if (this.recoveryReconnectMcp) {
				const token = this.getApiToken();
				if (token && !(await this.connectMcp(exposed.url, token))) {
					return { ready: false, error: "The CMS connection did not recover." };
				}
			}
			this.setState({
				...this.state,
				previewUrl: exposed.url,
				previewReady: true,
				previewRestarting: false,
				provisionError: undefined,
			});
			this.markMilestone("previewReady");
			this.broadcast(JSON.stringify({ type: "reload" }));
			return { ready: true, previewUrl: exposed.url };
		}

		const hasSite = await this.execRecoveryCommand(`test -f ${SITE_PATH}/package.json`, 5000);
		sandbox = this.getOrCreateSandbox();
		const apiToken = this.getApiToken();

		if (!hasSite.success) {
			// Site dir is gone (sandbox slept). Restore from the Artifacts repo.
			const repo = await this.getArtifactsRepoForRead();
			if (!repo) {
				return {
					ready: false,
					error: "No saved snapshot is available for this established site.",
				};
			}
			this.sendStatus("Restoring session...");
			this.sendConsole("$ git clone session snapshot");
			const clone = await sandbox.exec(
				`rm -rf ${SITE_PATH} && git clone -q ${shellQuote(repo.remote)} ${SITE_PATH}`,
				{ timeout: 120000, env: artifactsGitEnv(repo.token) },
			);
			if (!clone.success) {
				this.sendConsole(
					`Warning: restore failed: ${redactArtifactsToken(clone.stderr || clone.stdout || "git clone failed")}`,
				);
				return { ready: false, error: "The saved site snapshot could not be restored." };
			}
			const installCode = await this.installDeps();
			if (installCode !== 0) {
				this.sendConsole(`pnpm install failed during restore (exit ${installCode})`);
				return { ready: false, error: "Dependencies could not be restored for the saved site." };
			}
		}

		const exposed = await this.exposePreview(hostname);
		await this.startDevServer(exposed.url);
		await this.refreshPreviewSnapshots();
		this.sendConsole(`Preview URL: ${exposed.url}`);
		this.setState({
			...this.state,
			previewUrl: exposed.url,
			previewReady: true,
			previewRestarting: false,
			provisionError: undefined,
		});
		this.markMilestone("previewReady");
		this.broadcast(JSON.stringify({ type: "reload" }));
		if (apiToken) {
			this.markMilestone("cmsReady");
			if (await this.connectMcp(exposed.url, apiToken)) this.markMilestone("agentToolsReady");
		}
		return { ready: true, previewUrl: exposed.url };
	}

	/** Wake and restore an established site as soon as its sidebar route opens. */
	async resumePreview(appHost?: string): Promise<SiteRecoveryResult> {
		if (this.isDeletionPending()) return { ready: false, error: "This site was deleted." };
		if (!this.state.siteReady) return { ready: false, error: "The site is not ready yet." };
		const hostname = appHost && isLocalHostname(appHost) ? appHost : this.env.PREVIEW_HOSTNAME;
		this.setState({
			...this.state,
			appHost: appHost ?? this.state.appHost,
			previewRestarting: true,
			provisionError: undefined,
		});
		this.sendStatus("Restoring preview...");
		try {
			const recovered = await this.withOwnerActivity("resume-preview", () =>
				this.recoverSite(hostname),
			);
			if (!recovered.ready) {
				const error = recovered.error ?? "The saved site could not be restored.";
				this.sendConsole(`Recovery stopped without replacing the site: ${error}`);
				this.setState({
					...this.state,
					previewRestarting: false,
					provisionError: error,
				});
				return { ready: false, error };
			}
			return recovered;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sendConsole(`Preview recovery failed without replacing the site: ${message}`);
			this.setState({
				...this.state,
				previewRestarting: false,
				provisionError: message,
			});
			return { ready: false, error: message };
		} finally {
			this.sendStatus("");
		}
	}

	/**
	 * Snapshot the site dir to the session's Artifacts repo (git) so it survives
	 * sandbox sleep. `node_modules`, `dist`, and `.astro` are excluded by the
	 * template's `.gitignore` and reinstalled/rebuilt on restore; `.wrangler`
	 * (the EmDash D1 + R2 local state) is committed, so content and media ride
	 * along. Commit + push run inside the sandbox; the Worker only mints the
	 * short-lived, repo-scoped write token. Resolves to the redacted failure
	 * message when the backup failed (it is also kept as `persistenceError`).
	 */
	private backupSite(
		options: { quiet?: boolean; skipIfUnchanged?: boolean } = {},
	): Promise<string | undefined> {
		return this.enqueueBackupSite(options);
	}

	private enqueueBackupSite(
		options: { quiet?: boolean; skipIfUnchanged?: boolean } = {},
	): Promise<string | undefined> {
		const queued = this.backupChain.then(() => this.performBackupSite(options));
		this.backupChain = queued.then(
			() => {},
			() => {},
		);
		return queued;
	}

	private async performBackupSite({
		quiet = false,
		skipIfUnchanged = false,
	}: {
		quiet?: boolean;
		skipIfUnchanged?: boolean;
	}): Promise<string | undefined> {
		if (this.isDeletionPending()) return;
		if (!this.state.siteReady || (quiet && Date.now() < this.backupRetryAfter)) return;
		const sandbox = this.getOrCreateSandbox();
		const previewGeneration = await this.env.Sandbox.getByName(this.name)
			.getPreviewGeneration()
			.catch(() => undefined);
		if (
			skipIfUnchanged &&
			canSkipFinalSnapshot(
				this.lastSavedPreviewGeneration,
				previewGeneration,
				Boolean(this.state.persistenceError),
			)
		) {
			return;
		}
		if (!quiet) this.sendStatus("Saving session...");
		try {
			const { remote, token } = await this.ensureArtifactsRepo();
			// Git must never scan the live Vite/SQLite tree: files can change beneath
			// its object reader and produce an unusable snapshot. Copy at a completed
			// tool/turn boundary, then commit only the stable staging tree.
			let staged = await sandbox.exec(snapshotStagingCommand(SITE_PATH, SNAPSHOT_PATH), {
				timeout: 120000,
			});
			if (!staged.success) {
				this.sendConsole("Session snapshot staging was interrupted; retrying once...");
				await new Promise((resolve) => setTimeout(resolve, 250));
				staged = await sandbox.exec(snapshotStagingCommand(SITE_PATH, SNAPSHOT_PATH), {
					timeout: 120000,
				});
			}
			if (!staged.success) {
				throw new Error(staged.stderr || staged.stdout || "session staging copy failed");
			}
			const script = [
				`cd ${SNAPSHOT_PATH}`,
				"git init -q",
				`git config user.email ${shellQuote(ARTIFACTS_GIT_EMAIL)}`,
				`git config user.name ${shellQuote(ARTIFACTS_GIT_USER)}`,
				"git add -A",
				`git commit -q --allow-empty -m ${shellQuote(`session snapshot ${new Date().toISOString()}`)}`,
				// The Sandbox RPC timeout does not kill a stalled git child. Bound it inside the container.
				`timeout --signal=TERM --kill-after=2s ${SNAPSHOT_PUSH_TIMEOUT_SECONDS}s git push -q ${shellQuote(remote)} HEAD:main --force`,
			].join(" && ");
			let result = await sandbox.exec(script, {
				cwd: SNAPSHOT_PATH,
				timeout: 65_000,
				env: artifactsGitEnv(token),
			});
			if (!result.success && isTransientSnapshotPushFailure(result)) {
				this.sendConsole("Session snapshot upload was interrupted; retrying once...");
				await new Promise((resolve) => setTimeout(resolve, 1000));
				result = await sandbox.exec(script, {
					cwd: SNAPSHOT_PATH,
					timeout: 65_000,
					env: artifactsGitEnv(token),
				});
			}
			if (!result.success) {
				throw new Error(
					result.exitCode === 124
						? "Session snapshot upload timed out."
						: redactArtifactsToken(result.stderr || result.stdout || "git push failed"),
				);
			}
			this.backupRetryAfter = 0;
			this.lastSavedPreviewGeneration = previewGeneration;
			if (!quiet) this.sendConsole("Session saved.");
			if (this.state.persistenceError) {
				this.setState({ ...this.state, persistenceError: undefined });
			}
		} catch (err) {
			this.backupRetryAfter = Date.now() + BACKUP_FAILURE_COOLDOWN_MS;
			const detail = redactArtifactsToken(err instanceof Error ? err.message : String(err));
			const message = "The latest session checkpoint could not be saved.";
			this.sendConsole(`Warning: session backup failed: ${detail}`);
			this.setState({ ...this.state, persistenceError: message });
			return message;
		} finally {
			if (!quiet) this.sendStatus("");
		}
	}

	private async prepareStaticSiteSnapshot(
		liveOrigin: string,
		onPhase: (phase: PublishRunPhase) => void = () => {},
	): Promise<StaticSiteSnapshot> {
		if (
			!this.state.siteReady ||
			(this.state.initialGeneration && this.state.initialGeneration.status !== "ready")
		) {
			throw new Error("The site is not ready to publish yet.");
		}
		if (!this.state.previewUrl) throw new Error("The site preview is not ready.");
		const liveUrl = new URL(liveOrigin);
		if (liveUrl.protocol !== "https:" && liveUrl.protocol !== "http:") {
			throw new Error("The live site origin is invalid.");
		}
		const publishSiteProbe = `test -f ${SITE_PATH}/package.json && test -d ${SITE_PATH}/node_modules`;
		const siteAvailable = await this.execRecoveryCommand(publishSiteProbe, 5000).catch(() => null);
		if (!siteAvailable?.success) {
			this.sendStatus("Restoring the site before publishing...");
			const hostname =
				this.state.appHost && isLocalHostname(this.state.appHost)
					? this.state.appHost
					: this.env.PREVIEW_HOSTNAME;
			const recovered = await this.recoverSite(hostname).catch(() => ({
				ready: false as const,
				error: undefined,
			}));
			const restoredSite = recovered.ready
				? await this.execRecoveryCommand(publishSiteProbe, 5000).catch(() => null)
				: null;
			if (!recovered.ready || !restoredSite?.success) {
				throw new StaticSiteSnapshotError(
					"SITE_NOT_READY",
					recovered.error ?? "The saved site could not be restored before publishing.",
				);
			}
		}
		const previewGeneration = await this.env.Sandbox.getByName(this.name).getPreviewGeneration();
		onPhase("checkpoint");
		const backupError = await this.backupSite();
		if (backupError) throw new Error("The latest draft could not be saved before publishing.");
		const checkpointGeneration = await this.env.Sandbox.getByName(this.name).getPreviewGeneration();
		assertSnapshotGeneration(previewGeneration, checkpointGeneration);

		const sandbox = this.getOrCreateSandbox();
		let buildProcessId: string | undefined;
		let buildLogs: Promise<void> | undefined;
		let productionProcessId: string | undefined;
		let productionLogs: Promise<void> | undefined;

		try {
			onPhase("build");
			this.sendStatus("Preparing the production site...");
			const stagingCommand = publishStagingCommand(SNAPSHOT_PATH, SITE_PATH, PUBLISH_PATH);
			const staged = await sandbox.exec(
				`timeout --signal=TERM --kill-after=2s ${PUBLISH_STAGING_TIMEOUT_SECONDS}s ` +
					`sh -c ${shellQuote(stagingCommand)}`,
				{ timeout: 120_000 },
			);
			if (!staged.success) {
				throw new Error(
					staged.exitCode === 124
						? "Publish staging timed out."
						: staged.stderr || staged.stdout || "publish staging copy failed",
				);
			}
			await sandbox.writeFile(
				`${PUBLISH_PATH}/.dev.vars`,
				`EMDASH_SITE_URL=${liveUrl.origin}\nEMDASH_PREVIEW_URL=${this.state.previewUrl}\n`,
			);

			this.sendStatus("Building the production site...");
			this.sendConsole("$ pnpm build (publish snapshot)");
			const build = await sandbox.startProcess(
				`EMDASH_SITE_URL=${shellQuote(liveUrl.origin)} pnpm build`,
				{ cwd: PUBLISH_PATH },
			);
			buildProcessId = build.id;
			buildLogs = this.pumpLogs(await sandbox.streamProcessLogs(build.id));
			const buildResult = await build.waitForExit(300_000);
			buildProcessId = undefined;
			await buildLogs.catch(() => undefined);
			buildLogs = undefined;
			if (buildResult.exitCode !== 0) {
				throw new Error(`Production build failed with exit code ${buildResult.exitCode}.`);
			}

			await sandbox.exec("pkill -f '[w]rangler dev.*--port 4322' || true", {
				cwd: PUBLISH_PATH,
				timeout: 5000,
			});
			this.sendConsole("$ wrangler dev (publish snapshot)");
			const production = await sandbox.startProcess(
				`CLOUDFLARE_API_TOKEN= CLOUDFLARE_API_KEY= CLOUDFLARE_EMAIL= ` +
					`EMDASH_SITE_URL=${shellQuote(liveUrl.origin)} pnpm exec wrangler dev --local ` +
					`--ip 0.0.0.0 --port ${PRODUCTION_SNAPSHOT_PORT} --persist-to .wrangler/state ` +
					`-c dist/server/wrangler.json`,
				{ cwd: PUBLISH_PATH },
			);
			productionProcessId = production.id;
			productionLogs = this.pumpLogs(await sandbox.streamProcessLogs(production.id));
			this.sendStatus("Starting production checks...");
			await this.waitForSandboxPort(PRODUCTION_SNAPSHOT_PORT, 45_000, "Production runner");

			const builtAssetTarget = (path: string) => {
				const target = new URL(path, liveUrl.origin);
				if (target.origin !== liveUrl.origin || target.search || target.hash) return;
				let pathname: string;
				try {
					pathname = decodeURIComponent(target.pathname);
				} catch {
					return;
				}
				if (
					!pathname.startsWith("/") ||
					pathname.includes("\\") ||
					pathname.split("/").some((segment) => segment === "..")
				) {
					return;
				}
				return {
					pathname,
					filePath: `${PUBLISH_PATH}/dist/client${pathname}`,
				};
			};
			const inspectBuiltAsset = async (path: string) => {
				const target = builtAssetTarget(path);
				if (!target) return;
				const measured = await sandbox.exec(`wc -c < ${shellQuote(target.filePath)}`, {
					cwd: PUBLISH_PATH,
					timeout: 5000,
				});
				if (!measured.success) return;
				const byteLength = Number(measured.stdout?.trim());
				if (!Number.isSafeInteger(byteLength) || byteLength < 0) return;
				return {
					byteLength,
					contentType: builtSnapshotContentType(target.pathname),
				};
			};
			const readBuiltAsset = async (
				path: string,
				maximumBytes: number,
			): Promise<BuiltSnapshotAsset | undefined> => {
				const target = builtAssetTarget(path);
				if (!target) return;
				const command = `test -f ${shellQuote(target.filePath)} && head -c ${maximumBytes + 1} -- ${shellQuote(target.filePath)} | base64`;
				const file = await sandbox.exec(`bash -o pipefail -c ${shellQuote(command)}`, {
					cwd: PUBLISH_PATH,
					timeout: 15_000,
				});
				if (!file.success) return;
				const bytes = decodeBase64((file.stdout ?? "").replace(/\s+/g, ""));
				if (bytes.byteLength > maximumBytes) {
					throw new StaticSiteSnapshotError(
						"SNAPSHOT_TOO_LARGE",
						`The resource ${target.pathname} exceeds the ${maximumBytes}-byte file limit.`,
					);
				}
				return {
					bytes,
					contentType: builtSnapshotContentType(target.pathname),
				};
			};
			onPhase("capture");
			this.sendStatus("Checking pages and assets...");
			let snapshotTimeout: ReturnType<typeof setTimeout> | undefined;
			const capture = captureStaticSiteSnapshot({
				siteId: this.name,
				previewOrigin: this.state.previewUrl,
				liveOrigin: liveUrl.origin,
				fetch: (path) =>
					sandbox.containerFetch(
						new URL(path, liveUrl.origin).toString(),
						{
							headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
							redirect: "manual",
						},
						PRODUCTION_SNAPSHOT_PORT,
					),
				inspectBuiltAsset,
				readBuiltAsset,
			});
			let snapshot: StaticSiteSnapshot;
			try {
				snapshot = await Promise.race([
					capture,
					new Promise<never>((_, reject) => {
						snapshotTimeout = setTimeout(() => {
							reject(new Error("Snapshot preparation timed out after six minutes."));
						}, SNAPSHOT_PREPARATION_TIMEOUT_MS);
					}),
				]);
			} finally {
				if (snapshotTimeout) clearTimeout(snapshotTimeout);
			}
			const currentGeneration = await this.env.Sandbox.getByName(this.name).getPreviewGeneration();
			assertSnapshotGeneration(previewGeneration, currentGeneration);
			return snapshot;
		} finally {
			if (buildProcessId) {
				await sandbox.killProcess(buildProcessId).catch(() => undefined);
				await buildLogs?.catch(() => undefined);
			}
			if (productionProcessId) {
				await sandbox.killProcess(productionProcessId).catch(() => undefined);
				await productionLogs?.catch(() => undefined);
			}
			try {
				const cleanup = await sandbox.exec(`rm -rf ${shellQuote(PUBLISH_PATH)}`, {
					timeout: 15_000,
				});
				if (!cleanup.success) {
					this.sendConsole("Warning: the temporary publish workspace could not be removed.");
				}
			} catch {
				this.sendConsole("Warning: the temporary publish workspace could not be removed.");
			} finally {
				this.sendStatus("");
			}
		}
	}

	async publishSiteForOwner(
		ownerKey: string,
		sitesHostname: string,
		requestedSlug?: string,
	): Promise<PublishSiteResult> {
		const runId = crypto.randomUUID();
		const reference = runId.slice(0, 8);
		const startedAt = Date.now();
		let phase: PublishRunPhase = "checkpoint";
		let result: PublishSiteResult | undefined;
		try {
			result = await this.runPublishSiteForOwner(
				ownerKey,
				sitesHostname,
				requestedSlug,
				runId,
				(nextPhase) => {
					phase = nextPhase;
				},
			);
			return result.ok ? result : { ...result, reference };
		} finally {
			console.info(
				JSON.stringify({
					event: "builder.publish_run",
					runId,
					reference,
					siteId: this.name,
					phase,
					outcome: result?.ok ? "succeeded" : "failed",
					code: result ? (result.ok ? "LIVE" : result.code) : "UNEXPECTED",
					elapsedMs: Date.now() - startedAt,
				}),
			);
		}
	}

	private async runPublishSiteForOwner(
		ownerKey: string,
		sitesHostname: string,
		requestedSlug: string | undefined,
		runId: string,
		onPhase: (phase: PublishRunPhase) => void,
	): Promise<PublishSiteResult> {
		let liveMutationStarted = false;
		const owner = this.getOwnerRecord();
		if (!owner || !equalTokenDigest(owner.ownerKey, ownerKey)) {
			return { ok: false, code: "PROJECT_NOT_FOUND", message: "Project not found." };
		}
		const publicationEnv = this.env as Env & PublicationEnv;
		if (publicationEnv.SANDBOX_PREVIEW_MODE === "quick-tunnel") {
			return {
				ok: false,
				code: "PUBLISH_NOT_CONFIGURED",
				message: "Publishing is available on the production Builder only.",
			};
		}
		if (!publicationEnv.WFP_RELEASES || !publicationEnv.ProviderControlPlane || !sitesHostname) {
			return {
				ok: false,
				code: "PUBLISH_NOT_CONFIGURED",
				message: "Publishing is not configured for this EmDash Build deployment.",
			};
		}
		if (
			this.isDeletionPending() ||
			!this.state.siteReady ||
			Boolean(this.state.initialGeneration && this.state.initialGeneration.status !== "ready")
		) {
			return { ok: false, code: "SITE_NOT_READY", message: "The site is not ready to publish." };
		}
		if (this.hasOwnerActivity()) {
			return {
				ok: false,
				code: "SITE_BUSY",
				message: "Wait for the current site activity to finish, then publish again.",
			};
		}

		const activityId = `publish:${runId}`;
		this.beginOwnerActivity(activityId, "publish");
		try {
			if (
				(this.stateWrittenHere && this.hasProgressInState()) ||
				this.provisionPromise ||
				this.recoveryPromise ||
				!(await this.waitUntilStable({ timeout: 1 }))
			) {
				return {
					ok: false,
					code: "SITE_BUSY",
					message: "Wait for the current site activity to finish, then publish again.",
				};
			}
			const brandedHostname = publicationEnv.BRANDED_SITES_HOSTNAME;
			if (requestedSlug !== undefined && !brandedHostname) {
				return {
					ok: false,
					code: "PUBLISH_NOT_CONFIGURED",
					message: "Named publishing is not configured here.",
				};
			}
			const reservedSlug = brandedHostname
				? await publishedSlugForSite(this.env.AUTH_DB, this.name)
				: undefined;
			const previousActiveSlug = brandedHostname
				? await activePublishedSlugForSite(this.env.AUTH_DB, this.name)
				: undefined;
			const slug = requestedSlug ?? reservedSlug;
			if (slug && brandedHostname) {
				await reservePublishedSlug(this.env.AUTH_DB, this.name, slug);
			}
			const identity = await deriveWfpProviderIdentity(this.name, this.name, sitesHostname);
			const publicHostname =
				slug && brandedHostname ? `${slug}.${brandedHostname}` : identity.hostname;
			const snapshot = await this.prepareStaticSiteSnapshot(`https://${publicHostname}`, onPhase);
			const release = await buildWfpSnapshotRelease(snapshot);
			this.markWfpCleanupRequired();
			onPhase("store");
			this.sendStatus("Uploading the publish bundle...");
			await storeWfpSnapshotRelease(publicationEnv.WFP_RELEASES, release);
			const currentPublication = this.state.publication;
			const operationEpoch = currentPublication?.at ?? 0;
			const publishAttempt = this.getPublishAttempt(snapshot.releaseId, operationEpoch);
			const advancePublishAttempt = () =>
				this.advancePublishAttempt(snapshot.releaseId, operationEpoch);
			const undoUnpublishedActivation = async () => {
				if (slug && !previousActiveSlug) {
					await unlockPublishedSlug(this.env.AUTH_DB, this.name, slug);
				}
			};

			const provider = new CloudflareWfpProviderAdapter(publicationEnv.ProviderControlPlane);
			onPhase("ensure");
			this.sendStatus("Preparing the public site...");
			const ensureReference = await provider.ensureSite({
				siteId: this.name,
				idempotencyKey: "snapshot-publish:ensure:v1",
			});
			const ensured = await provider.getOperation(ensureReference.operationId);
			if (ensured.status !== "succeeded") {
				return {
					ok: false,
					code: "PUBLISH_FAILED",
					message: "The public Site could not be prepared. Live was not changed.",
				};
			}

			const runBoundedMutation = async (
				kind: "deploy" | "promote" | "rollback",
				action: (idempotencyKey: string) => Promise<{ operationId: string }>,
			) => {
				onPhase(kind === "deploy" ? "candidate" : "promote");
				this.sendStatus(
					kind === "deploy" ? "Uploading the release..." : "Confirming the live release...",
				);
				this.markPublishAttemptPending(snapshot.releaseId, operationEpoch);
				if (kind !== "deploy" && slug) {
					await activatePublishedSlug(this.env.AUTH_DB, this.name, slug);
				}
				let operation = await provider.getOperation(
					(
						await action(
							`snapshot-publish:${snapshot.releaseId}:${operationEpoch}:${publishAttempt}:${kind}:0`,
						)
					).operationId,
				);
				if (operation.status === "failed" && operation.error?.retryable) {
					operation = await provider.getOperation(
						(
							await action(
								`snapshot-publish:${snapshot.releaseId}:${operationEpoch}:${publishAttempt}:${kind}:1`,
							)
						).operationId,
					);
				}
				return operation;
			};
			let restoredRelease = false;
			try {
				liveMutationStarted = true;
				const promoted = await runBoundedMutation("promote", (idempotencyKey) =>
					provider.promoteRelease({
						siteId: this.name,
						releaseId: snapshot.releaseId,
						idempotencyKey,
					}),
				);
				if (promoted.status !== "succeeded") {
					if (promoted.status === "failed") {
						advancePublishAttempt();
						await undoUnpublishedActivation();
					}
					return {
						ok: false,
						code: "PUBLISH_FAILED",
						message:
							promoted.status === "running"
								? "Publishing may have completed, but Live could not be confirmed. Retry Publish site to reconcile."
								: "The release could not become Live. The current Live site was not changed.",
					};
				}
				restoredRelease = true;
			} catch (error) {
				if (error instanceof ProviderControlPlaneError && error.code === "LIVE_BUSY") {
					this.clearPublishAttempt(snapshot.releaseId, operationEpoch);
					throw error;
				}
				if (
					!(error instanceof ProviderControlPlaneError) ||
					error.code !== "INVALID_RELEASE_STATE"
				) {
					throw error;
				}
				await undoUnpublishedActivation();
				liveMutationStarted = false;
			}
			if (!restoredRelease) {
				try {
					liveMutationStarted = true;
					const rolledBack = await runBoundedMutation("rollback", (idempotencyKey) =>
						provider.rollbackRelease({
							siteId: this.name,
							releaseId: snapshot.releaseId,
							idempotencyKey,
						}),
					);
					if (rolledBack.status !== "succeeded") {
						if (rolledBack.status === "failed") {
							advancePublishAttempt();
							await undoUnpublishedActivation();
						}
						return {
							ok: false,
							code: "PUBLISH_FAILED",
							message:
								rolledBack.status === "running"
									? "Publishing may have completed, but Live could not be confirmed. Retry Publish site to reconcile."
									: "The previous release could not become Live. The current Live site was not changed.",
						};
					}
					restoredRelease = true;
				} catch (error) {
					if (error instanceof ProviderControlPlaneError && error.code === "LIVE_BUSY") {
						this.clearPublishAttempt(snapshot.releaseId, operationEpoch);
						throw error;
					}
					if (
						!(error instanceof ProviderControlPlaneError) ||
						error.code !== "INVALID_RELEASE_STATE"
					) {
						throw error;
					}
					await undoUnpublishedActivation();
					liveMutationStarted = false;
				}
			}
			try {
				const deployed = restoredRelease
					? undefined
					: await runBoundedMutation("deploy", (idempotencyKey) =>
							provider.deployRelease({
								siteId: this.name,
								releaseId: snapshot.releaseId,
								bundle: release.bundle,
								idempotencyKey,
							}),
						);
				if (deployed && deployed.status !== "succeeded") {
					if (deployed.status === "failed") advancePublishAttempt();
					const failureCode = deployed.error?.code;
					if (failureCode) this.sendConsole(`Publish candidate failed: ${failureCode}.`);
					return {
						ok: false,
						code: "PUBLISH_FAILED",
						message:
							failureCode === "CANDIDATE_HEALTH_FAILED"
								? "The uploaded release did not pass its health check. The current Live site was not changed."
								: failureCode === "CANDIDATE_UPLOAD_FAILED"
									? "The release could not be uploaded. The current Live site was not changed."
									: "The release candidate failed. The current Live site was not changed.",
					};
				}
			} catch (error) {
				if (error instanceof ProviderControlPlaneError && error.code === "CANDIDATE_BUSY") {
					this.clearPublishAttempt(snapshot.releaseId, operationEpoch);
					liveMutationStarted = true;
					throw error;
				}
				if (
					!(error instanceof ProviderControlPlaneError) ||
					error.code !== "RELEASE_ALREADY_LIVE"
				) {
					throw error;
				}
				liveMutationStarted = true;
				const rolledBack = await runBoundedMutation("rollback", (idempotencyKey) =>
					provider.rollbackRelease({
						siteId: this.name,
						releaseId: snapshot.releaseId,
						idempotencyKey,
					}),
				);
				if (rolledBack.status !== "succeeded") {
					if (rolledBack.status === "failed") {
						advancePublishAttempt();
						await undoUnpublishedActivation();
					}
					return {
						ok: false,
						code: "PUBLISH_FAILED",
						message:
							rolledBack.status === "running"
								? "Publishing may have completed, but Live could not be confirmed. Retry Publish site to reconcile."
								: "The previous release could not become Live. The current Live site was not changed.",
					};
				}
				restoredRelease = true;
			}
			if (!restoredRelease) {
				liveMutationStarted = true;
				const promoted = await runBoundedMutation("promote", (idempotencyKey) =>
					provider.promoteRelease({
						siteId: this.name,
						releaseId: snapshot.releaseId,
						idempotencyKey,
					}),
				);
				if (promoted.status !== "succeeded") {
					if (promoted.status === "failed") {
						advancePublishAttempt();
						await undoUnpublishedActivation();
					}
					return {
						ok: false,
						code: "PUBLISH_FAILED",
						message:
							promoted.status === "running"
								? "Publishing may have completed, but Live could not be confirmed. Retry Publish site to reconcile."
								: "The release could not become Live. The current Live site was not changed.",
					};
				}
			}

			const publication = {
				liveUrl: `https://${publicHostname}`,
				releaseId: snapshot.releaseId,
				sourceRevision: snapshot.sourceRevision,
				at: Math.max(Date.now(), (currentPublication?.at ?? 0) + 1),
			};
			onPhase("persist");
			this.sendStatus("Saving the live site details...");
			try {
				this.setState({ ...this.state, publication });
				this.clearPublishAttempt(snapshot.releaseId, operationEpoch);
			} catch (error) {
				console.error("[BuilderAgent] could not persist promoted publication metadata", error);
			}
			try {
				const catalog = this.env.ProjectCatalog.getByName(ownerKey);
				const project = (await catalog.listProjects()).find(({ id }) => id === this.name);
				if (project) {
					await catalog.updateProject(ownerKey, {
						...project,
						status: "live",
						updatedAt: publication.at,
					});
				}
			} catch (error) {
				console.error("[BuilderAgent] could not update promoted project metadata", error);
			}
			return {
				ok: true,
				status: "live",
				liveUrl: publication.liveUrl,
				releaseId: publication.releaseId,
				sourceRevision: publication.sourceRevision,
				publishedAt: publication.at,
			};
		} catch (error) {
			if (error instanceof PublishedSlugError) {
				if (liveMutationStarted) {
					return {
						ok: false,
						code: "PUBLISH_FAILED",
						message:
							"Publishing may have completed, but Live could not be confirmed. Retry Publish site to reconcile.",
					};
				}
				return { ok: false, code: error.code, message: error.message };
			}
			if (error instanceof StaticSiteSnapshotError) {
				return { ok: false, code: error.code, message: error.message };
			}
			if (error instanceof ProviderControlPlaneError && error.code === "WFP_NOT_CONFIGURED") {
				return {
					ok: false,
					code: "PUBLISH_NOT_CONFIGURED",
					message: "Publishing is not configured for this EmDash Build deployment.",
				};
			}
			console.error("[BuilderAgent] snapshot publish failed", error);
			return {
				ok: false,
				code: "PUBLISH_FAILED",
				message: liveMutationStarted
					? "Publishing may have completed, but Live could not be confirmed. Retry Publish site to reconcile."
					: "Publishing failed. The current Live site was not changed.",
			};
		} finally {
			this.finishOwnerActivity(activityId);
			this.sendStatus("");
		}
	}

	/**
	 * Build the site and deploy it to a Cloudflare temporary preview account
	 * (`wrangler deploy --temporary`), returning a live URL and a claim URL the
	 * user can open within 60 minutes to take ownership.
	 *
	 * The session was already created without the sandbox runner / Worker
	 * Loader / crons. Temp accounts also can't provision R2, so we strip
	 * `storage` from astro.config and `r2_buckets` from wrangler.jsonc *before*
	 * the build (so the built worker doesn't reference the absent MEDIA binding),
	 * then restore them in a `finally`. The session's D1 (schema + content) is
	 * exported locally, scrubbed of users/tokens/secrets (`scrubAuthFromSnapshot`),
	 * and loaded into the temp account's D1 after deploy via
	 * `d1 execute --remote --temporary` (D1 is covered by the temp preview-account
	 * token). The deployed copy therefore has the content but no media (R2), and
	 * the claimant creates their own admin through the setup wizard.
	 *
	 * Deploy uses the adapter-generated `dist/server/wrangler.json` (correct
	 * built `main` + `no_bundle: true`) rather than a hand-built config -- the
	 * latter pointed at the source worker entry and made wrangler re-bundle it,
	 * failing on Astro/EmDash virtual modules. A current Wrangler is pulled via
	 * `npx wrangler@latest` (the template pins an older one without `--temporary`),
	 * and the sandbox is unauthenticated, which `--temporary` requires.
	 */
	private async deploySite(): Promise<DeployResult> {
		if (!this.state.siteReady) {
			return { success: false, error: "The site is not ready to deploy yet." };
		}
		const sandbox = this.getOrCreateSandbox();
		const astroPath = `${SITE_PATH}/astro.config.mjs`;
		const wranglerPath = `${SITE_PATH}/wrangler.jsonc`;

		this.sendStatus("Preparing deploy...");
		const origAstro = await sandbox.readFile(astroPath, { encoding: "utf-8" });
		const origWrangler = await sandbox.readFile(wranglerPath, { encoding: "utf-8" });
		if (!origAstro.success || !origWrangler.success) {
			this.sendStatus("");
			return { success: false, error: "Could not read the project config for deploy." };
		}

		try {
			// Stop the dev server first: it shares .vite/.astro/dist with the
			// build and watches astro.config, so leaving it running while we
			// swap configs and run `astro build` corrupts the optimizer cache
			// and crashes the preview. It's restarted in the finally.
			this.sendStatus("Stopping preview for deploy...");
			await this.stopDevServer();

			// Snapshot the session's D1 (schema + content) from the local state
			// while it's at rest. `--local` needs no credentials; the canonical
			// wrangler.jsonc (still in place here) has the DB binding. We load
			// this into the freshly-provisioned temp D1 after deploy.
			const snapshotPath = "/tmp/d1-snapshot.sql";
			this.sendStatus("Exporting content...");
			this.sendConsole("$ wrangler d1 export DB --local");
			const dump = await sandbox.exec(
				`npx -y wrangler@latest d1 export DB --local --output ${snapshotPath} -c wrangler.jsonc`,
				{ cwd: SITE_PATH, timeout: 120000 },
			);
			let haveSnapshot = dump.success;
			if (!haveSnapshot) {
				this.sendConsole(
					`Warning: content export failed; deployed site will be empty: ${(dump.stderr || dump.stdout).slice(0, 300)}`,
				);
			} else {
				// The export carries the dev-bypass admin and the hash of this
				// session's full-scope PAT; neither may reach a public site. Skip
				// the content load entirely if the scrub can't be applied.
				const snapshot = await sandbox.readFile(snapshotPath, { encoding: "utf-8" });
				if (snapshot.success) {
					await sandbox.writeFile(snapshotPath, scrubAuthFromSnapshot(snapshot.content));
				} else {
					haveSnapshot = false;
					this.sendConsole(
						"Warning: could not scrub credentials from the content export; deployed site will be empty.",
					);
				}
			}

			// Drop R2 for the build: from astro.config (so the built code doesn't
			// wire the MEDIA binding) and from wrangler.jsonc (so the generated
			// deploy config has no MEDIA binding the temp account can't create).
			await sandbox.writeFile(astroPath, stripStorageFromAstroConfig(origAstro.content));
			await sandbox.writeFile(wranglerPath, stripR2FromWrangler(origWrangler.content));

			this.sendStatus("Building site for deploy...");
			this.sendConsole("$ EMDASH_DEPLOY_MODE=temporary pnpm build");
			const build = await sandbox.startProcess("EMDASH_DEPLOY_MODE=temporary pnpm build", {
				cwd: SITE_PATH,
			});
			const buildLogs = await sandbox.streamProcessLogs(build.id);
			const buildLogsDone = this.pumpLogs(buildLogs);
			const buildResult = await build.waitForExit(300000);
			await buildLogsDone.catch(() => {});
			if (buildResult.exitCode !== 0) {
				throw new Error(`Build failed with exit code ${buildResult.exitCode}`);
			}

			this.sendStatus("Deploying to Cloudflare...");
			this.sendConsole("$ wrangler deploy --temporary");
			// Deploy the adapter-generated config (built entry + `no_bundle`).
			// Scrub any Cloudflare credentials from the env: `--temporary` only
			// works when Wrangler is unauthenticated.
			const deploy = await sandbox.exec(
				"CLOUDFLARE_API_TOKEN= CLOUDFLARE_API_KEY= CLOUDFLARE_EMAIL= CI=1 " +
					"npx -y wrangler@latest deploy --temporary -c dist/server/wrangler.json",
				{ cwd: SITE_PATH, timeout: 180000 },
			);
			const output = `${deploy.stdout}\n${deploy.stderr}`;
			for (const line of output.split("\n")) {
				if (line.trim()) this.sendConsole(line);
			}
			if (!deploy.success) {
				throw new Error(`Deploy failed: ${(deploy.stderr || deploy.stdout).slice(0, 300)}`);
			}

			// Load the snapshot into the temp account's freshly-provisioned D1.
			// D1 commands accept `--temporary` (the temp preview-account token
			// covers D1), so this reuses the cached temp account from the deploy
			// -- still unauthenticated. Non-fatal: a failure leaves the deployed
			// site up but empty rather than aborting the deploy.
			if (haveSnapshot) {
				this.sendStatus("Loading content into the deployed site...");
				this.sendConsole("$ wrangler d1 execute DB --remote --temporary --file <snapshot>");
				const load = await sandbox.exec(
					"CLOUDFLARE_API_TOKEN= CLOUDFLARE_API_KEY= CLOUDFLARE_EMAIL= CI=1 " +
						`npx -y wrangler@latest d1 execute DB --remote --temporary -y --file ${snapshotPath} -c dist/server/wrangler.json`,
					{ cwd: SITE_PATH, timeout: 180000 },
				);
				if (load.success) {
					this.sendConsole("Content loaded into the deployed site.");
				} else {
					this.sendConsole(
						`Warning: content load failed; deployed site may be empty: ${(load.stderr || load.stdout).slice(0, 300)}`,
					);
				}
			}

			const liveUrl = output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev[^\s]*/i)?.[0];
			const claimUrl = output.match(/https:\/\/dash\.cloudflare\.com\/claim[^\s'"]*/i)?.[0];
			if (!claimUrl) {
				this.sendConsole("Warning: no claim URL found in the deploy output.");
			}

			this.setState({ ...this.state, deploy: { liveUrl, claimUrl, at: Date.now() } });
			this.sendConsole(liveUrl ? `Deployed: ${liveUrl}` : "Deploy completed.");
			return { success: true, liveUrl, claimUrl };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.sendConsole(`ERROR: ${message}`);
			return { success: false, error: message };
		} finally {
			// Restore the originals so the live preview (with media) keeps working.
			try {
				await sandbox.writeFile(astroPath, origAstro.content);
				await sandbox.writeFile(wranglerPath, origWrangler.content);
			} catch {
				// best-effort cleanup
			}
			// Bring the preview back up with the restored config.
			try {
				this.sendStatus("Restarting preview...");
				await this.startDevServer();
				await this.refreshPreviewSnapshots();
				this.broadcast(JSON.stringify({ type: "reload" }));
			} catch (err) {
				this.sendConsole(
					`Warning: could not restart preview after deploy: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			this.sendStatus("");
		}
	}

	/**
	 * Scaffold the chosen template, install deps, start the dev server,
	 * run dev-bypass, expose the port, and connect to the MCP server.
	 * Idempotent — recovers an established session or provisions a new one.
	 */
	private async provisionSite(hostname: string, signal?: AbortSignal): Promise<ProvisionResult> {
		if (signal?.aborted) return { ready: false, stopped: true };
		if (this.state.siteReady) {
			const recovered = await this.recoverSite(hostname);
			if (signal?.aborted) return { ready: false, stopped: true };
			if (recovered.ready) return recovered;
			const error = recovered.error ?? "The saved site could not be restored.";
			this.sendConsole(`Recovery stopped without replacing the site: ${error}`);
			this.setState({ ...this.state, provisionError: error, previewRestarting: false });
			return { ready: false, error };
		}

		const sandbox = this.getOrCreateSandbox();
		const templateDir = BUILDER_TEMPLATE_DIR;

		try {
			this.markMilestone("containerStarting");
			// Prepared templates include their dependency trees in the image. Retain a
			// network fallback so older images and local development remain recoverable.
			this.sendStatus("Opening a blank site canvas...");
			const preparedArchive = `${PREPARED_TEMPLATES_PATH}/${templateDir}.tgz`;
			const prepared = await sandbox.exec(`test -f ${preparedArchive}`, { signal });
			if (prepared.success) {
				this.sendConsole(`$ extract prepared ${templateDir}`);
				const copied = await sandbox.exec(
					`rm -rf ${SITE_PATH} && mkdir -p ${SITE_PATH} && tar -xzf ${preparedArchive} -C ${SITE_PATH}`,
					{ timeout: this.usesQuickTunnelPreview() ? 180_000 : 30_000, signal },
				);
				if (!copied.success) {
					throw new Error(`Prepared template copy failed: ${copied.stderr || copied.stdout}`);
				}
			} else {
				throw new Error(
					"The local builder template is missing from the Sandbox image. Rebuild the container image.",
				);
			}

			this.startInitialScaffoldPrefetch(sandbox);

			// These creation-only operations touch disjoint resources. Start them
			// together, then drain every required branch before starting Astro or
			// reporting a failure so a retry cannot race unfinished setup work.
			// Quick tunnels start a cloudflared child inside the container, so wait
			// until extraction has settled instead of racing it with filesystem churn.
			const exposure = this.usesQuickTunnelPreview() ? undefined : this.exposePreview(hostname);
			await drainProvisionTasks([
				sandbox.writeFile(`${SITE_PATH}/GETTING-STARTED.md`, GETTING_STARTED_MD),
				sandbox.writeFile(`${SITE_PATH}/wrangler.jsonc`, CANONICAL_WRANGLER_JSONC),
				this.protectAstroConfig(true),
				...(exposure ? [exposure] : []),
			]);
			signal?.throwIfAborted();

			if (!prepared.success) {
				const installCode = await this.installDeps(signal);
				if (installCode !== 0) {
					throw new Error(`pnpm install failed with exit code ${installCode}`);
				}
			}

			this.sendStatus("Opening preview...");
			let exposed: { url: string };
			let devServerStarted = false;
			if (exposure) {
				exposed = await exposure;
			} else {
				await this.startDevServer(undefined, true, signal);
				devServerStarted = true;
				try {
					exposed = await this.exposePreview(hostname);
				} catch (error) {
					await this.stopDevServer();
					throw error;
				}
			}
			signal?.throwIfAborted();
			if (!devServerStarted) await this.startDevServer(exposed.url, true, signal);
			// The browser can use the real template while CMS setup and MCP continue.
			this.sendConsole(`Preview URL: ${exposed.url}`);
			this.setState({
				...this.state,
				previewUrl: exposed.url,
				previewReady: true,
				provisionError: undefined,
			});
			this.markMilestone("previewReady");

			// Run setup dev-bypass with ?token=1&content=0: runs migrations,
			// applies the template seed schema-only (no sample content, bylines,
			// or taxonomy terms), creates the dev admin, and returns a
			// full-scope PAT in one call.
			this.sendStatus("Running initial setup...");
			this.sendConsole("$ curl setup/dev-bypass?token=1&content=0");
			const apiToken = await this.runDevBypass(signal);
			if (apiToken) {
				this.persistApiToken(apiToken);
				this.sendConsole("Setup complete, API token created.");
				this.markMilestone("cmsReady");
			} else {
				throw new Error("CMS setup did not return an API token.");
			}
			await this.refreshPreviewCache();
			signal?.throwIfAborted();

			if (!(await this.connectMcp(exposed.url, apiToken, signal))) {
				throw new Error("CMS tools could not connect. Send another message to retry.");
			}
			this.markMilestone("agentToolsReady");

			this.setState({
				...this.state,
				siteReady: true,
				previewUrl: exposed.url,
				previewReady: true,
				cmsReady: true,
				agentToolsReady: true,
				provisionError: undefined,
			});
			await this.backupSite({ quiet: true });
			signal?.throwIfAborted();

			return { ready: true, previewUrl: exposed.url };
		} catch (err) {
			if (signal?.aborted) {
				if (!this.state.siteReady) await this.stopDevServer();
				this.sendStatus("");
				return { ready: false, stopped: true };
			}
			const message = err instanceof Error ? err.message : String(err);
			this.sendConsole(`ERROR: ${message}`);
			this.setState({ ...this.state, provisionError: message });
			return { ready: false, error: message };
		}
	}

	/** Extract the plain text from the latest user message */
	private getLatestUserText(): string {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const msg = this.messages[i];
			if (msg?.role !== "user") continue;
			const parts = (msg as { parts?: Array<{ type?: string; text?: string }> }).parts;
			if (Array.isArray(parts)) {
				return parts
					.filter((p) => p?.type === "text" && typeof p.text === "string")
					.map((p) => p.text)
					.join(" ");
			}
			const content = (msg as { content?: unknown }).content;
			if (typeof content === "string") return content;
		}
		return "";
	}

	/** Look up a connected MCP tool's server id + input schema by name. */
	private mcpToolMeta(name: string): { serverId: string; inputSchema: unknown } | undefined {
		const t = this.getMcpServers().tools.find((x) => x.name === name);
		if (!t) return undefined;
		return { serverId: t.serverId, inputSchema: (t as any).inputSchema ?? { type: "object" } };
	}

	/**
	 * Call an MCP tool with the shared arg-repair and transient-retry behaviour.
	 * Smaller models often serialize object/array params to JSON strings (which
	 * MCP rejects), so we repair them first. We then retry through transient
	 * dev-server hiccups (a thrown transport error, or an `isError` result whose
	 * message looks like the Vite SSR optimizer mid-reload) so they never reach
	 * the model, which would misread them as a broken environment. A genuine
	 * tool error (bad args, validation) is returned as `toolError` so the caller
	 * can react. Throws only when the transport itself keeps failing.
	 */
	private callMcpTool(
		name: string,
		serverId: string,
		inputSchema: unknown,
		args: Record<string, unknown>,
		abortSignal?: AbortSignal,
	): Promise<
		| { status: "ok"; result: unknown }
		| { status: "toolError"; text: string; result: unknown }
		| { status: "unstable" }
	> {
		return this.callMcpToolUnchecked(name, serverId, inputSchema, args, abortSignal);
	}

	private async callMcpToolUnchecked(
		name: string,
		serverId: string,
		inputSchema: unknown,
		args: Record<string, unknown>,
		abortSignal?: AbortSignal,
	): Promise<
		| { status: "ok"; result: unknown }
		| { status: "toolError"; text: string; result: unknown }
		| { status: "unstable" }
	> {
		const { args: repairedArgs, repaired } = coerceJsonArgs(args, inputSchema);
		if (repaired.length > 0) {
			this.sendConsole(`Repaired stringified ${name} args: ${repaired.join(", ")}`);
		}
		const MAX_ATTEMPTS = 6;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			abortSignal?.throwIfAborted();
			let result: unknown;
			try {
				result = await this.mcpCallQueue.run(() => {
					abortSignal?.throwIfAborted();
					return this.mcp.callTool({ name, arguments: repairedArgs, serverId });
				});
			} catch (err) {
				abortSignal?.throwIfAborted();
				if (attempt < MAX_ATTEMPTS - 1) {
					await this.waitForDevServer(abortSignal);
					await new Promise((r) => setTimeout(r, 1000));
					continue;
				}
				throw err;
			}
			const mcpResult = result as { isError?: boolean } | null;
			if (mcpResult?.isError) {
				const text = mcpResultText(result) || `${name} failed`;
				if (attempt < MAX_ATTEMPTS - 1 && isTransientDevServerError(text)) {
					await this.waitForDevServer(abortSignal);
					await new Promise((r) => setTimeout(r, 1000));
					continue;
				}
				return { status: "toolError", text, result };
			}
			return { status: "ok", result };
		}
		return { status: "unstable" };
	}

	private async checkUpdateDraft(
		args: Record<string, unknown>,
		abortSignal?: AbortSignal,
	): Promise<
		| {
				result: { success: false; error: string };
				recoveryTool?: "content_create" | "content_update";
		  }
		| undefined
	> {
		if (args.status !== undefined || !args.data) return;
		const get = this.mcpToolMeta("content_get");
		if (!get || typeof args.collection !== "string" || typeof args.id !== "string") {
			return {
				result: { success: false, error: "Cannot inspect the entry before updating it." },
			};
		}
		const current = await this.callMcpTool(
			"content_get",
			get.serverId,
			get.inputSchema,
			{ collection: args.collection, id: args.id, ...(args.locale ? { locale: args.locale } : {}) },
			abortSignal,
		);
		if (current.status === "toolError" && current.text.includes("[NOT_FOUND]")) {
			return {
				result: {
					success: false,
					error: `${args.collection}/${args.id} does not exist. content_update cannot create it; correct and retry content_create instead. No update was made.`,
				},
				recoveryTool: "content_create",
			};
		}
		if (current.status !== "ok") {
			const reason =
				current.status === "toolError"
					? current.text
					: "the CMS connection did not stabilize in time";
			return {
				result: {
					success: false,
					error: `Could not inspect ${args.collection}/${args.id} before updating: ${reason}. No update was made.`,
				},
			};
		}
		const data = mcpResultJson(current.result) as
			| {
					_rev?: string;
					item?: {
						status?: string;
						draftRevisionId?: string | null;
						liveRevisionId?: string | null;
						scheduledAt?: string | null;
					};
			  }
			| undefined;
		if (!data?.item || typeof data._rev !== "string") {
			return {
				result: {
					success: false,
					error: "Cannot verify the entry's draft state. Read it and retry. No update was made.",
				},
			};
		}
		if (data._rev !== args._rev) {
			return {
				result: {
					success: false,
					error: "The entry changed since it was read. Read it and retry. No update was made.",
				},
			};
		}
		if (data.item.status !== "published") return;
		if (data.item.scheduledAt) {
			return {
				result: {
					success: false,
					error:
						"This entry has a scheduled change. Resolve its schedule before changing the live site.",
				},
			};
		}
		if (
			typeof data.item.draftRevisionId === "string" &&
			data.item.draftRevisionId !== data.item.liveRevisionId
		) {
			return {
				result: {
					success: false,
					error:
						"This entry already has an unpublished draft. Resolve it before changing the live site; no update was made.",
				},
			};
		}
	}

	private async publishStagedUpdate(
		args: Record<string, unknown>,
		result: unknown,
		abortSignal?: AbortSignal,
	): Promise<unknown> {
		if (args.status !== undefined || typeof args.collection !== "string" || !args.data) {
			return result;
		}
		const staged = stagedLiveUpdate(mcpResultJson(result));
		if (!staged) return result;
		const failed = (reason: string) => {
			this.sendConsole(
				`Publishing ${args.collection}/${staged.id} after content_update failed: ${reason}`,
			);
			return {
				...(result as Record<string, unknown>),
				success: false,
				error: `The change was saved, but is not confirmed live: ${reason}. Read the entry before retrying content_publish; it may already be live.`,
			};
		};
		if (staged.scheduled) return failed("the entry has a scheduled change");
		if (abortSignal?.aborted) return failed("the turn was stopped before publishing");
		const publish = this.mcpToolMeta("content_publish");
		if (!publish) return failed("content_publish is not connected");
		let reason: string;
		try {
			const outcome = await this.callMcpTool(
				"content_publish",
				publish.serverId,
				publish.inputSchema,
				{ collection: args.collection, id: staged.id, _rev: staged.rev },
				abortSignal,
			);
			if (outcome.status === "ok") {
				return {
					...(outcome.result as Record<string, unknown>),
					note: "The change was published automatically and is live.",
				};
			}
			reason =
				outcome.status === "toolError" ? outcome.text : "the dev server did not stabilize in time";
		} catch (error) {
			reason = error instanceof Error ? error.message : String(error);
		}
		return failed(reason);
	}

	/**
	 * Build the MCP-derived tool map for the current turn. MCP supplies the
	 * tool descriptions and JSON schemas; we wrap each execute() with a small
	 * retry that pings the dev server if it momentarily stopped responding.
	 */
	private buildMcpTools(
		failureGuard: McpToolFailureGuard,
		convergence: BuildConvergence,
		metrics?: TurnMetrics,
	) {
		const ALLOWED_MCP_TOOLS = new Set([
			"schema_list_collections",
			"schema_get_collection",
			"schema_list_block_types",
			"schema_get_block_type",
			"schema_update_block_type",
			"content_create",
			"content_get",
			"content_update",
			"content_publish",
			"content_unpublish",
			"content_list",
			"content_delete",
			"content_permanent_delete",
			"content_duplicate",
			"search",
			"taxonomy_create",
			"taxonomy_get",
			"taxonomy_create_term",
			"taxonomy_list",
			"taxonomy_list_terms",
			"taxonomy_update_term",
			"taxonomy_delete_term",
			"byline_list",
			"byline_get",
			"byline_create",
			"byline_update",
			"settings_get",
			"settings_update",
			"media_list",
			"menu_list",
			"menu_get",
			"menu_create",
			"menu_update",
			"menu_set_items",
		]);
		const mcpState = this.getMcpServers();
		const mcpToolEntries: Record<string, unknown> = {};
		for (const t of mcpState.tools) {
			if (!ALLOWED_MCP_TOOLS.has(t.name)) continue;
			const inputSchema = (t as any).inputSchema ?? { type: "object" };
			const modelInputSchema = adaptMcpToolSchema(t.name, inputSchema);
			mcpToolEntries[t.name] = {
				description: mcpToolDescription(t.name, t.description ?? t.name),
				// AI SDK v6 tools key the schema as `inputSchema`, not `parameters`.
				inputSchema: jsonSchema(modelInputSchema),
				execute: async (
					args: Record<string, unknown>,
					{ abortSignal }: { abortSignal?: AbortSignal },
				) => {
					abortSignal?.throwIfAborted();
					const normalized = normalizeMcpToolArgs(t.name, args);
					if (normalized.repaired) {
						this.sendConsole(`Normalized ${t.name} arguments.`);
					}
					if (failureGuard.isBlocked(t.name, normalized.args)) {
						return {
							success: false,
							error: `${t.name} rejected this exact input twice. Change the input before retrying; the tool remains available for a corrected call.`,
						};
					}
					const key = MUTATING_MCP_TOOLS.has(t.name)
						? mutationKey(t.name, normalized.args)
						: undefined;
					const entityFailureKey = contentMutationFailureKey(t.name, normalized.args);
					const executeCall = async () => {
						if (t.name === "content_update") {
							const unsafe = await this.checkUpdateDraft(normalized.args, abortSignal);
							if (unsafe) {
								if (entityFailureKey && unsafe.recoveryTool) {
									convergence.recordUnresolvedFailure({
										key: entityFailureKey,
										toolName: unsafe.recoveryTool,
										error: unsafe.result.error,
									});
								}
								return unsafe.result;
							}
						}
						const currentMeta = this.mcpToolMeta(t.name);
						if (!currentMeta) {
							return { success: false, error: `${t.name} is reconnecting. Try again shortly.` };
						}
						if (t.name === "schema_update_block_type") {
							const update = await this.runReconciledSchemaWrite({
								call: () =>
									this.callMcpTool(
										t.name,
										currentMeta.serverId,
										currentMeta.inputSchema,
										normalized.args,
										abortSignal,
									),
								reconcile: async () => {
									const get = this.mcpToolMeta("schema_get_block_type");
									if (!get) return;
									const reread = await this.callMcpTool(
										"schema_get_block_type",
										get.serverId,
										get.inputSchema,
										{ slug: normalized.args.slug },
										abortSignal,
									);
									return reread.status === "ok" &&
										blockUpdateMatches(mcpResultJson(reread.result), normalized.args)
										? reread.result
										: undefined;
								},
								finish: async () => {
									await timeSync(metrics, "previewRefresh", () => this.refreshAndReloadPreview());
									await timeSync(metrics, "backup", () => this.backupSite({ quiet: true }));
								},
								abortSignal,
								ambiguousCode: /CONFLICT/,
							});
							if (update.success === true) failureGuard.recordSuccess(t.name);
							else
								failureGuard.recordFailure(
									t.name,
									normalized.args,
									String(update.error ?? "Block update failed"),
								);
							return update;
						}
						const outcome = await this.callMcpTool(
							t.name,
							currentMeta.serverId,
							currentMeta.inputSchema,
							normalized.args,
							abortSignal,
						);
						if (outcome.status === "ok") {
							failureGuard.recordSuccess(t.name);
							const result =
								t.name === "content_update"
									? await this.publishStagedUpdate(normalized.args, outcome.result, abortSignal)
									: outcome.result;
							if (entityFailureKey) convergence.resolveUnresolvedFailure(entityFailureKey);
							if (MUTATING_MCP_TOOLS.has(t.name)) {
								await timeSync(metrics, "previewRefresh", () => this.refreshAndReloadPreview());
								await timeSync(metrics, "backup", () => this.backupSite({ quiet: true }));
							}
							return result;
						}
						if (outcome.status === "toolError") {
							// Genuine tool error: return it (tagged) so the model can
							// react; the UI marks the tool failed.
							this.sendConsole(`MCP ${t.name} error: ${outcome.text}`);
							const blocked = failureGuard.recordFailure(t.name, normalized.args, outcome.text);
							const error =
								t.name === "content_create" && outcome.text.includes("[VALIDATION_ERROR]")
									? `${outcome.text} No content was created. Correct the content_create data and retry content_create; do not use content_update for this missing entry.`
									: outcome.text;
							if (
								entityFailureKey &&
								t.name === "content_create" &&
								outcome.text.includes("[VALIDATION_ERROR]")
							) {
								convergence.recordUnresolvedFailure({
									key: entityFailureKey,
									toolName: t.name,
									error,
								});
							}
							return {
								...(outcome.result as Record<string, unknown>),
								success: false,
								error: blocked
									? `${error} This exact input is now blocked; change it before retrying.`
									: error,
							};
						}
						// Exhausted retries on a still-reloading dev server.
						return {
							success: false,
							error: `${t.name} failed: the dev server did not stabilize in time. It should recover shortly -- try again.`,
						};
					};
					return key ? convergence.runMutation(executeCall, { key }) : executeCall();
				},
			};
		}
		this.sendConsole(
			`MCP tools: ${Object.keys(mcpToolEntries).length} of ${mcpState.tools.length}`,
		);
		return mcpToolEntries;
	}

	/**
	 * Apply an idempotent collection/field plan through the live MCP contract.
	 * Blank sites otherwise need one model step and one Artifacts checkpoint for
	 * every field; this keeps the same schema authority while checkpointing once.
	 */
	private buildSchemaPlanTool(convergence: BuildConvergence, metrics?: TurnMetrics) {
		const getCollection = this.mcpToolMeta("schema_get_collection");
		const createCollection = this.mcpToolMeta("schema_create_collection");
		const createField = this.mcpToolMeta("schema_create_field");
		const updateCollection = this.mcpToolMeta("schema_update_collection");
		const getBlockType = this.mcpToolMeta("schema_get_block_type");
		const createBlockType = this.mcpToolMeta("schema_create_block_type");

		return {
			apply_schema_plan: tool({
				description:
					"Create the site's EmDash block types, collections, and fields in one idempotent pass. " +
					"Block types are resolved before any blocks field references them. Existing ordinary " +
					"fields are left intact; existing block types and blocks fields must exactly match. Give each " +
					"collection with detail pages a urlPattern matching its route. Collection fields cannot use " +
					"repeater because the current schema MCP does not expose it; model ordered structured values " +
					"such as a project gallery as a subject-specific block type plus a blocks field. Repeater is " +
					"valid only inside blockTypes[].fields. The plan is " +
					"checkpointed once at the end. Call refresh_types after it succeeds.",
				inputSchema: schemaPlanInput,
				execute: async ({ blockTypes = [], collections = [] }, { abortSignal }) => {
					const hasBlocksFields = collections.some((collection) =>
						collection.fields.some((field) => field.type === "blocks"),
					);
					const missing = [
						...(blockTypes.length > 0 || hasBlocksFields
							? [
									!getBlockType && "schema_get_block_type",
									blockTypes.length > 0 && !createBlockType && "schema_create_block_type",
								]
							: []),
						...(collections.length > 0
							? [
									!getCollection && "schema_get_collection",
									!createCollection && "schema_create_collection",
									!createField && "schema_create_field",
								]
							: []),
						...(collections.some((collection) => collection.urlPattern !== undefined)
							? [!updateCollection && "schema_update_collection"]
							: []),
					].filter((name): name is string => typeof name === "string");
					if (missing.length > 0) {
						return {
							success: false as const,
							changed: false as const,
							error: `This project cannot apply the requested schema plan because ${missing.join(
								", ",
							)} ${missing.length === 1 ? "is" : "are"} unavailable. No schema changes were made.`,
						};
					}
					const progress = this.statusLine();
					return withBuildMutation(
						convergence,
						async () => {
							let createdBlockTypes = 0;
							let skippedBlockTypes = 0;
							let createdCollections = 0;
							let createdFields = 0;
							let skippedFields = 0;
							let createdBlockFields = 0;
							let skippedBlockFields = 0;
							let updatedUrlPatterns = 0;
							let mutationDispatched = false;
							let ambiguousCommit = false;
							let checkpointed = false;
							const failureText = (outcome: { status: string; text?: string }) =>
								outcome.text ?? "the EmDash MCP connection did not stabilize";
							const counters = () => ({
								createdBlockTypes,
								skippedBlockTypes,
								createdCollections,
								createdFields,
								skippedFields,
								createdBlockFields,
								skippedBlockFields,
								updatedUrlPatterns,
							});
							const confirmedChanged = () =>
								createdBlockTypes > 0 ||
								createdCollections > 0 ||
								createdFields > 0 ||
								updatedUrlPatterns > 0;
							const checkpointChanges = async () => {
								if (checkpointed) return;
								if (updatedUrlPatterns > 0) {
									// Menus render entry links from the pattern.
									await timeSync(metrics, "previewRefresh", () => this.refreshAndReloadPreview());
								}
								if (confirmedChanged() || mutationDispatched || ambiguousCommit) {
									await timeSync(metrics, "backup", () => this.backupSite({ quiet: true }));
								}
								checkpointed = true;
							};
							const fail = async (error: string) => {
								await checkpointChanges();
								return {
									success: false as const,
									changed: confirmedChanged() || ambiguousCommit,
									error,
									...counters(),
								};
							};
							const stopIfAborted = async () => {
								if (!abortSignal?.aborted) return;
								await checkpointChanges();
								abortSignal.throwIfAborted();
							};
							const callSchema = async (
								name: string,
								serverId: string,
								inputSchema: unknown,
								args: Record<string, unknown>,
								reconcileWrite = false,
							) => {
								try {
									return await this.callMcpTool(name, serverId, inputSchema, args, abortSignal);
								} catch (error) {
									if (abortSignal?.aborted) {
										await checkpointChanges();
										abortSignal.throwIfAborted();
									}
									if (reconcileWrite) {
										return {
											status: "thrown" as const,
											text: error instanceof Error ? error.message : String(error),
										};
									}
									await checkpointChanges();
									throw error;
								}
							};

							const resolvedBlockTypes = new Set<string>();
							for (const [index, blockType] of blockTypes.entries()) {
								await stopIfAborted();
								progress.set(
									`Block type ${blockType.label}${blockTypes.length > 1 ? ` (${index + 1}/${blockTypes.length})` : ""}...`,
								);
								const existing = await callSchema(
									"schema_get_block_type",
									getBlockType!.serverId,
									getBlockType!.inputSchema,
									{ slug: blockType.slug },
								);
								if (existing.status === "ok") {
									const inspected = inspectBlockType(mcpResultJson(existing.result), blockType);
									if (!inspected.ok) {
										return fail(
											`Block type ${blockType.slug} already exists but ${inspected.reason}. Use the renderer-aware block update workflow instead.`,
										);
									}
									skippedBlockTypes += 1;
									resolvedBlockTypes.add(blockType.slug);
									continue;
								}
								if (
									existing.status !== "toolError" ||
									!/BLOCK_TYPE_NOT_FOUND|not found/i.test(existing.text)
								) {
									return fail(
										`Could not inspect block type ${blockType.slug}: ${failureText(existing)}`,
									);
								}

								mutationDispatched = true;
								const created = await callSchema(
									"schema_create_block_type",
									createBlockType!.serverId,
									createBlockType!.inputSchema,
									blockType,
									true,
								);
								mutationDispatched = false;
								if (created.status === "ok") {
									createdBlockTypes += 1;
									resolvedBlockTypes.add(blockType.slug);
									continue;
								}
								ambiguousCommit =
									created.status === "thrown" ||
									created.status === "unstable" ||
									(created.status === "toolError" && /BLOCK_TYPE_EXISTS/i.test(created.text));
								await stopIfAborted();
								const reread = await callSchema(
									"schema_get_block_type",
									getBlockType!.serverId,
									getBlockType!.inputSchema,
									{ slug: blockType.slug },
								);
								if (
									reread.status === "ok" &&
									inspectBlockType(mcpResultJson(reread.result), blockType).ok
								) {
									ambiguousCommit = false;
									createdBlockTypes += 1;
									resolvedBlockTypes.add(blockType.slug);
									continue;
								}
								return fail(
									`Could not create block type ${blockType.slug}: ${failureText(created)}. A reread did not confirm the requested definition.`,
								);
							}

							for (const collection of collections) {
								for (const field of collection.fields) {
									if (field.type !== "blocks") continue;
									for (const slug of field.validation.allowedTypes) {
										if (resolvedBlockTypes.has(slug)) continue;
										await stopIfAborted();
										const referenced = await callSchema(
											"schema_get_block_type",
											getBlockType!.serverId,
											getBlockType!.inputSchema,
											{ slug },
										);
										if (referenced.status !== "ok") {
											return fail(
												`Blocks field ${collection.slug}.${field.slug} references unavailable block type ${slug}: ${failureText(referenced)}`,
											);
										}
										const inspected = inspectBlockType(mcpResultJson(referenced.result));
										if (!inspected.ok) {
											return fail(
												`Blocks field ${collection.slug}.${field.slug} cannot use ${slug}: ${inspected.reason}.`,
											);
										}
										resolvedBlockTypes.add(slug);
									}
								}
							}

							for (const [index, collection] of collections.entries()) {
								await stopIfAborted();
								const place = collections.length > 1 ? ` (${index + 1}/${collections.length})` : "";
								progress.set(`${collection.label}${place}...`);
								const existing = await callSchema(
									"schema_get_collection",
									getCollection!.serverId,
									getCollection!.inputSchema,
									{ slug: collection.slug },
								);
								let existingFields = new Map<string, Record<string, unknown>>();
								let currentPattern: unknown;
								if (existing.status === "ok") {
									const current = extractedCollection(mcpResultJson(existing.result));
									if (!current) {
										return fail(
											`Could not inspect collection ${collection.slug}: response was incomplete`,
										);
									}
									existingFields = collectionFieldMap(current);
									currentPattern = current.urlPattern;
								} else if (
									existing.status === "toolError" &&
									/NOT_FOUND|not found/i.test(existing.text)
								) {
									// schema_create_collection has no urlPattern; it is set below.
									const { fields, urlPattern, ...collectionInput } = collection;
									mutationDispatched = true;
									const created = await callSchema(
										"schema_create_collection",
										createCollection!.serverId,
										createCollection!.inputSchema,
										collectionInput,
									);
									if (created.status !== "ok") {
										mutationDispatched = false;
										return fail(
											`Could not create collection ${collection.slug}: ${failureText(created)}`,
										);
									}
									mutationDispatched = false;
									createdCollections += 1;
								} else {
									return fail(
										`Could not inspect collection ${collection.slug}: ${failureText(existing)}`,
									);
								}

								if (
									collection.urlPattern !== undefined &&
									collection.urlPattern !== currentPattern
								) {
									await stopIfAborted();
									mutationDispatched = true;
									const updated = await callSchema(
										"schema_update_collection",
										updateCollection!.serverId,
										updateCollection!.inputSchema,
										{ slug: collection.slug, urlPattern: collection.urlPattern },
									);
									if (updated.status !== "ok") {
										mutationDispatched = false;
										return fail(
											`Could not set the URL pattern for ${collection.slug}: ${failureText(updated)}`,
										);
									}
									mutationDispatched = false;
									updatedUrlPatterns += 1;
								}

								for (const [fieldIndex, field] of collection.fields.entries()) {
									await stopIfAborted();
									const existingField = existingFields.get(field.slug);
									if (existingField) {
										if (field.type === "blocks" && !blocksFieldMatches(existingField, field)) {
											return fail(
												`Blocks field ${collection.slug}.${field.slug} already exists with a different contract. Inspect it and use update_blocks_field instead.`,
											);
										}
										skippedFields += 1;
										if (field.type === "blocks") skippedBlockFields += 1;
										continue;
									}
									progress.set(
										`${collection.label}${place}: field ${fieldIndex + 1} of ${collection.fields.length}...`,
									);
									mutationDispatched = true;
									const created = await callSchema(
										"schema_create_field",
										createField!.serverId,
										createField!.inputSchema,
										{ collection: collection.slug, ...field },
										field.type === "blocks",
									);
									mutationDispatched = false;
									if (created.status === "ok") {
										createdFields += 1;
										if (field.type === "blocks") createdBlockFields += 1;
										existingFields.set(field.slug, field);
										continue;
									}
									if (field.type === "blocks") {
										ambiguousCommit =
											created.status === "thrown" ||
											created.status === "unstable" ||
											(created.status === "toolError" && /FIELD_EXISTS/i.test(created.text));
										await stopIfAborted();
										const reread = await callSchema(
											"schema_get_collection",
											getCollection!.serverId,
											getCollection!.inputSchema,
											{ slug: collection.slug },
										);
										const rereadCollection =
											reread.status === "ok"
												? extractedCollection(mcpResultJson(reread.result))
												: undefined;
										const rereadField = rereadCollection
											? collectionFieldMap(rereadCollection).get(field.slug)
											: undefined;
										if (rereadField && blocksFieldMatches(rereadField, field)) {
											ambiguousCommit = false;
											createdFields += 1;
											createdBlockFields += 1;
											existingFields.set(field.slug, rereadField);
											continue;
										}
									}
									return fail(
										`Could not create ${collection.slug}.${field.slug}: ${failureText(created)}${
											field.type === "blocks"
												? ". A reread did not confirm the requested blocks field."
												: ""
										}`,
									);
								}
							}
							await checkpointChanges();
							return {
								success: true as const,
								changed: confirmedChanged(),
								...counters(),
							};
						},
						mutationKey("apply_schema_plan", { blockTypes, collections }),
					).finally(() => progress.clear());
				},
			}),
		};
	}

	private async runReconciledSchemaWrite(options: {
		call: () => ReturnType<BuilderAgent["callMcpTool"]>;
		reconcile: () => Promise<unknown | undefined>;
		finish: () => Promise<void>;
		abortSignal?: AbortSignal;
		ambiguousCode: RegExp;
		reconcileOnSuccess?: boolean;
	}): Promise<Record<string, unknown>> {
		let outcome:
			| Awaited<ReturnType<BuilderAgent["callMcpTool"]>>
			| { status: "thrown"; text: string };
		try {
			outcome = await options.call();
		} catch (error) {
			outcome = {
				status: "thrown",
				text: error instanceof Error ? error.message : String(error),
			};
		}
		const ambiguous =
			outcome.status === "thrown" ||
			outcome.status === "unstable" ||
			(outcome.status === "toolError" && options.ambiguousCode.test(outcome.text));
		const committed = outcome.status === "ok";
		if (options.abortSignal?.aborted) {
			if (committed || ambiguous) await this.backupSite({ quiet: true });
			options.abortSignal.throwIfAborted();
		}

		let response =
			outcome.status === "ok" && !options.reconcileOnSuccess ? outcome.result : undefined;
		let reconciled = false;
		if (ambiguous || (committed && options.reconcileOnSuccess)) {
			try {
				response = await options.reconcile();
				reconciled = response !== undefined;
			} catch (error) {
				if (committed || ambiguous) await this.backupSite({ quiet: true });
				throw error;
			}
		}
		if (!response) {
			if (committed || ambiguous) await this.backupSite({ quiet: true });
			const detail =
				outcome.status === "toolError" || outcome.status === "thrown"
					? outcome.text
					: "The MCP connection did not stabilize";
			return {
				success: false,
				changed: committed || ambiguous,
				error: `${detail}. A live reread did not confirm the requested schema state.`,
			};
		}
		await options.finish();
		return { success: true, changed: true, reconciled, result: response };
	}

	private buildBlockEvolutionTools(convergence: BuildConvergence, metrics?: TurnMetrics) {
		const getBlockType = this.mcpToolMeta("schema_get_block_type");
		const activateBlockType = this.mcpToolMeta("schema_activate_block_type_version");
		const getCollection = this.mcpToolMeta("schema_get_collection");
		const updateField = this.mcpToolMeta("schema_update_field");
		const result: Record<string, unknown> = {};
		const finishMutation = async () => {
			await timeSync(metrics, "previewRefresh", () => this.refreshAndReloadPreview());
			await timeSync(metrics, "backup", () => this.backupSite({ quiet: true }));
		};
		const reject = (error: string) => ({
			changed: false as const,
			result: { success: false as const, changed: false as const, error },
		});

		if (getCollection && updateField) {
			result.update_blocks_field = tool({
				description:
					"Safely update an existing blocks field. Validation changes must include the complete " +
					"allowedTypes/minItems/maxItems contract. This tool preserves core-owned retired types and refuses tighter limits.",
				inputSchema: blocksFieldUpdateInput,
				execute: async (args, { abortSignal }) =>
					convergence.runConditionalMutation<Record<string, unknown>>(
						async () => {
							const current = await this.callMcpTool(
								"schema_get_collection",
								getCollection.serverId,
								getCollection.inputSchema,
								{ slug: args.collection },
								abortSignal,
							);
							const collection =
								current.status === "ok"
									? extractedCollection(mcpResultJson(current.result))
									: undefined;
							const field = collection
								? collectionFieldMap(collection).get(args.fieldSlug)
								: undefined;
							if (!field || field.type !== "blocks") {
								return reject(
									`${args.collection}.${args.fieldSlug} is not an existing blocks field.`,
								);
							}
							const liveValidation = recordValue(field.validation);
							const currentMin =
								typeof liveValidation?.minItems === "number" ? liveValidation.minItems : 0;
							const currentMax =
								typeof liveValidation?.maxItems === "number" ? liveValidation.maxItems : 100;
							if (
								args.validation &&
								(args.validation.minItems > currentMin || args.validation.maxItems < currentMax)
							) {
								return reject(
									"Tightening blocks-field limits requires a separately scoped content migration.",
								);
							}
							if (blocksFieldUpdateMatches(field, args)) {
								return {
									changed: false as const,
									result: { success: true as const, changed: false as const },
								};
							}
							return {
								changed: true as const,
								operation: async () => {
									const { collection: collectionSlug, ...input } = args;
									return this.runReconciledSchemaWrite({
										call: () =>
											this.callMcpTool(
												"schema_update_field",
												updateField.serverId,
												updateField.inputSchema,
												{ collection: collectionSlug, ...input },
												abortSignal,
											),
										reconcile: async () => {
											const reread = await this.callMcpTool(
												"schema_get_collection",
												getCollection.serverId,
												getCollection.inputSchema,
												{ slug: collectionSlug },
												abortSignal,
											);
											const after =
												reread.status === "ok"
													? extractedCollection(mcpResultJson(reread.result))
													: undefined;
											const updated = after
												? collectionFieldMap(after).get(args.fieldSlug)
												: undefined;
											return updated && blocksFieldUpdateMatches(updated, args)
												? updated
												: undefined;
										},
										finish: finishMutation,
										abortSignal,
										ambiguousCode: /CONFLICT|FIELD_EXISTS/,
										reconcileOnSuccess: true,
									});
								},
							};
						},
						{ key: mutationKey("update_blocks_field", args) },
					),
			});
		}

		if (getBlockType && activateBlockType) {
			result.schema_activate_block_type_version = {
				description:
					"Activate a retained block version only after validate_site proves exhaustive renderers for " +
					"the current schema. The result reports the bounded entries that still require explicit migration.",
				inputSchema: jsonSchema(
					adaptMcpToolSchema("schema_activate_block_type_version", activateBlockType.inputSchema),
				),
				execute: async (
					args: Record<string, unknown>,
					{ abortSignal }: { abortSignal?: AbortSignal },
				) =>
					convergence.runConditionalMutation<Record<string, unknown>>(
						async () => {
							const validation = convergence.currentValidation<{
								blockRendererValidation?: BlockRendererValidationResult;
							}>();
							const evidence = validation?.blockRendererValidation?.success
								? validation.blockRendererValidation.evidence
								: undefined;
							const slug = typeof args.slug === "string" ? args.slug : "";
							const targetVersion = typeof args.version === "number" ? args.version : 0;
							const validatedFields = evidence?.fields.filter((field) =>
								field.types.some(
									(type) => type.slug === slug && type.versions.includes(targetVersion),
								),
							);
							if (!evidence || !validatedFields?.length) {
								return reject(
									"Run validate_site with exhaustive current block renderers before activation.",
								);
							}
							const current = await this.callMcpTool(
								"schema_get_block_type",
								getBlockType.serverId,
								getBlockType.inputSchema,
								{ slug },
								abortSignal,
							);
							const item =
								current.status === "ok"
									? extractedBlockType(mcpResultJson(current.result))
									: undefined;
							const versions = Array.isArray(item?.versions) ? item.versions.map(recordValue) : [];
							const active = versions.find((version) => version?.version === item?.currentVersion);
							const target = versions.find((version) => version?.version === targetVersion);
							if (
								!item ||
								!active ||
								!target ||
								(Array.isArray(target.unsupportedTypes) && target.unsupportedTypes.length > 0) ||
								active.fingerprint !== args.expectedFingerprint
							) {
								return reject(
									"The target version or active fingerprint no longer matches the activation request.",
								);
							}
							const live = await this.loadLiveBlockEvidence(abortSignal);
							if (live.issues.length > 0) return reject(live.issues.join(" "));
							const liveFields = live.evidence.fields.filter((field) =>
								field.types.some((type) => type.slug === slug),
							);
							const validatedFingerprints = new Map(
								validatedFields.map((field) => [
									`${field.collection}.${field.field}`,
									field.fingerprint,
								]),
							);
							if (
								liveFields.length !== validatedFingerprints.size ||
								liveFields.some(
									(field) =>
										validatedFingerprints.get(`${field.collection}.${field.field}`) !==
										field.fingerprint,
								)
							) {
								return reject("The live blocks fields changed after validation.");
							}
							const discovery = await this.discoverAffectedBlockEntries(
								slug,
								targetVersion,
								liveFields,
								abortSignal,
							);
							if (!discovery.success || discovery.incomplete || discovery.entries.length > 20) {
								return {
									changed: false as const,
									result: {
										success: false as const,
										changed: false as const,
										error:
											discovery.error ??
											"Activation needs a separately scoped migration because discovery exceeded 200 scanned or 20 affected entries.",
									},
								};
							}
							if (item.currentVersion === targetVersion) {
								return {
									changed: false as const,
									result: {
										success: true as const,
										changed: false as const,
										alreadyActive: true,
										affectedEntries: discovery.entries,
									},
								};
							}
							return {
								changed: true as const,
								operation: async () => {
									const activation = await this.runReconciledSchemaWrite({
										call: () =>
											this.callMcpTool(
												"schema_activate_block_type_version",
												activateBlockType.serverId,
												activateBlockType.inputSchema,
												args,
												abortSignal,
											),
										reconcile: async () => {
											const reread = await this.callMcpTool(
												"schema_get_block_type",
												getBlockType.serverId,
												getBlockType.inputSchema,
												{ slug },
												abortSignal,
											);
											return reread.status === "ok" &&
												extractedBlockType(mcpResultJson(reread.result))?.currentVersion ===
													targetVersion
												? reread.result
												: undefined;
										},
										finish: finishMutation,
										abortSignal,
										ambiguousCode: /CONFLICT/,
									});
									if (activation.success !== true) return activation;
									const remaining = await this.discoverAffectedBlockEntries(
										slug,
										targetVersion,
										liveFields,
										abortSignal,
									);
									return {
										...activation,
										affectedEntries: discovery.entries,
										remainingEntries: remaining.success ? remaining.entries : discovery.entries,
										remainingIncomplete: !remaining.success || remaining.incomplete,
										migrationComplete:
											remaining.success && !remaining.incomplete && remaining.entries.length === 0,
									};
								},
							};
						},
						{ key: mutationKey("schema_activate_block_type_version", args) },
					),
			};
		}
		return result;
	}

	private async discoverAffectedBlockEntries(
		slug: string,
		targetVersion: number,
		fields: ValidatedBlocksField[],
		abortSignal?: AbortSignal,
	): Promise<{
		success: boolean;
		incomplete: boolean;
		entries: Array<{ collection: string; id: string; fields: string[] }>;
		error?: string;
	}> {
		const list = this.mcpToolMeta("content_list");
		const get = this.mcpToolMeta("content_get");
		if (!list || !get)
			return {
				success: false,
				incomplete: true,
				entries: [],
				error: "Content inspection tools are unavailable.",
			};
		const byCollection = new Map<string, string[]>();
		for (const field of fields) {
			const names = byCollection.get(field.collection) ?? [];
			if (!names.includes(field.field)) names.push(field.field);
			byCollection.set(field.collection, names);
		}
		let scanned = 0;
		const entries: Array<{ collection: string; id: string; fields: string[] }> = [];
		for (const [collection, fieldNames] of byCollection) {
			let cursor: string | undefined;
			do {
				if (scanned >= 200) return { success: true, incomplete: true, entries };
				const listed = await this.callMcpTool(
					"content_list",
					list.serverId,
					list.inputSchema,
					{
						collection,
						limit: Math.min(100, 200 - scanned),
						orderBy: "createdAt",
						order: "asc",
						...(cursor ? { cursor } : {}),
					},
					abortSignal,
				);
				if (listed.status !== "ok")
					return {
						success: false,
						incomplete: true,
						entries,
						error: `Could not scan ${collection}.`,
					};
				const page = recordValue(mcpResultJson(listed.result));
				for (const item of mcpItems(page)) {
					const id = typeof item.id === "string" ? item.id : undefined;
					if (!id)
						return {
							success: false,
							incomplete: true,
							entries,
							error: `${collection} returned an entry without an id.`,
						};
					scanned += 1;
					const read = await this.callMcpTool(
						"content_get",
						get.serverId,
						get.inputSchema,
						{ collection, id },
						abortSignal,
					);
					const payload =
						read.status === "ok" ? recordValue(mcpResultJson(read.result)) : undefined;
					const data = recordValue(recordValue(payload?.item)?.data);
					if (!data)
						return {
							success: false,
							incomplete: true,
							entries,
							error: `Could not inspect ${collection}/${id}.`,
						};
					const affectedFields = fieldNames.filter(
						(field) =>
							Array.isArray(data[field]) &&
							(data[field] as unknown[]).some((value) => {
								const block = recordValue(value);
								return block?._type === slug && block._version !== targetVersion;
							}),
					);
					if (affectedFields.length > 0) entries.push({ collection, id, fields: affectedFields });
					if (entries.length > 20) return { success: true, incomplete: false, entries };
				}
				cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
			} while (cursor);
		}
		return { success: true, incomplete: false, entries };
	}

	private async loadLiveBlockEvidence(
		abortSignal?: AbortSignal,
	): Promise<{ evidence: BlockContractEvidence; issues: string[] }> {
		const listCollections = this.mcpToolMeta("schema_list_collections");
		const getCollection = this.mcpToolMeta("schema_get_collection");
		const evidence: BlockContractEvidence = { fields: [] };
		const issues: string[] = [];
		if (!listCollections || !getCollection) {
			return { evidence, issues: ["Collection schema tools are unavailable."] };
		}
		const listed = await this.callMcpTool(
			"schema_list_collections",
			listCollections.serverId,
			listCollections.inputSchema,
			{},
			abortSignal,
		);
		if (listed.status !== "ok")
			return {
				evidence,
				issues: ["Could not list collections for block validation."],
			};
		for (const summary of mcpItems(mcpResultJson(listed.result))) {
			if (typeof summary.slug !== "string") continue;
			const read = await this.callMcpTool(
				"schema_get_collection",
				getCollection.serverId,
				getCollection.inputSchema,
				{ slug: summary.slug },
				abortSignal,
			);
			const collection =
				read.status === "ok" ? extractedCollection(mcpResultJson(read.result)) : undefined;
			if (!collection) {
				issues.push(`Could not inspect collection ${summary.slug}.`);
				continue;
			}
			for (const field of collectionFieldMap(collection).values()) {
				if (field.type !== "blocks") continue;
				const validation = recordValue(field.validation);
				const allowedTypes = Array.isArray(validation?.allowedTypes)
					? validation.allowedTypes.filter((value): value is string => typeof value === "string")
					: [];
				const retiredTypes = Array.isArray(validation?.retiredTypes)
					? validation.retiredTypes.filter((value): value is string => typeof value === "string")
					: [];
				const referenced = [...new Set([...allowedTypes, ...retiredTypes])];
				const returnedTypes = Array.isArray(field.blockTypes)
					? field.blockTypes.map(recordValue)
					: [];
				const types = referenced.flatMap((slug) => {
					const item = returnedTypes.find((type) => type?.slug === slug);
					const versions = Array.isArray(item?.versions) ? item.versions.map(recordValue) : [];
					const active = versions.find((version) => version?.version === item?.currentVersion);
					if (
						!item ||
						!active ||
						versions.some(
							(version) =>
								Array.isArray(version?.unsupportedTypes) && version.unsupportedTypes.length > 0,
						)
					) {
						issues.push(
							`${summary.slug}.${String(field.slug)} references unavailable or unsupported block type ${slug}.`,
						);
						return [];
					}
					return [
						{
							slug,
							currentVersion: item.currentVersion as number,
							versions: versions
								.map((version) => version!.version)
								.filter((version): version is number => typeof version === "number"),
						},
					];
				});
				if (typeof field.slug !== "string" || typeof field.blockTypeFingerprint !== "string") {
					issues.push(
						`${summary.slug}.${String(field.slug)} has incomplete block schema evidence.`,
					);
					continue;
				}
				evidence.fields.push({
					collection: summary.slug,
					field: field.slug,
					fingerprint: field.blockTypeFingerprint,
					allowedTypes,
					retiredTypes,
					types,
				});
			}
		}
		return { evidence, issues };
	}

	private async validateLiveBlockContracts(
		sandbox: SandboxInstance,
		abortSignal?: AbortSignal,
	): Promise<BlockRendererValidationResult> {
		const { evidence, issues } = await this.loadLiveBlockEvidence(abortSignal);
		if (issues.length > 0) return { success: false, evidence, issues };
		return validateBlockRendererContract(evidence, {
			listAstroFiles: async () => {
				const listedFiles = await sandbox.listFiles(`${SITE_PATH}/src`, { recursive: true });
				if (!listedFiles.success) return [];
				return listedFiles.files
					.filter((file) => file.type === "file" && file.absolutePath.endsWith(".astro"))
					.map((file) => ({
						path: file.absolutePath.slice(`${SITE_PATH}/`.length),
						size: file.size,
					}));
			},
			read: async (path) => {
				const file = await sandbox.readFile(`${SITE_PATH}/${path}`, { encoding: "utf-8" });
				return file.success ? file.content : undefined;
			},
		});
	}

	/**
	 * Fetch the set of valid field slugs for a collection via
	 * `schema_get_collection`. Returns null when the schema can't be read, so
	 * callers fall back to not filtering. Used by the batch tool to drop keys
	 * the model invented (e.g. `category`, `tag`) or misplaced (`bylines` is a
	 * top-level param, not a data field) before they fail content_create.
	 */
	private async fetchCollectionFieldSlugs(
		collection: string,
		abortSignal?: AbortSignal,
	): Promise<Set<string> | null> {
		const meta = this.mcpToolMeta("schema_get_collection");
		if (!meta) return null;
		try {
			const outcome = await this.callMcpTool(
				"schema_get_collection",
				meta.serverId,
				meta.inputSchema,
				{ slug: collection },
				abortSignal,
			);
			if (outcome.status !== "ok") return null;
			const slugs = collectFieldSlugs(mcpResultJson(outcome.result));
			return slugs.size > 0 ? slugs : null;
		} catch {
			return null;
		}
	}

	/**
	 * Fan-out content creation tool (prototype).
	 *
	 * The wall-clock cost of seeding a set of entries is dominated by the model
	 * writing each body serially, not by the D1 writes. This tool splits those:
	 * the coordinator supplies a short brief per entry, and we generate every
	 * body CONCURRENTLY with tool-less `generateText` calls (no shared state, no
	 * dev-server contact -- so they parallelize safely), then create + publish
	 * the entries SERIALLY (writes go through the single fragile dev server,
	 * where the win is already banked). Bodies are sent as markdown: the EmDash
	 * MCP write path converts markdown strings to Portable Text for
	 * `portableText` fields, so we don't structure them ourselves.
	 *
	 * The generated body text never passes back through the coordinator's
	 * context: the coordinator only sends short titles/briefs/metadata in and
	 * gets a short result summary out.
	 */
	private buildContentBatchTool(convergence: BuildConvergence, metrics?: TurnMetrics) {
		const genModel = createBuilderModel(this.env);
		return {
			create_entries_batch: tool({
				description: [
					"Create MANY content entries of one collection at once, generating each entry's long",
					"body text in PARALLEL. Prefer this over many separate content_create calls whenever you",
					"are seeding multiple entries of the same collection (several blog posts, portfolio",
					"projects, etc.). You give a short brief per entry and the body prose is written for you;",
					"entries are created AND published. Inspect the collection with schema_get_collection first.",
					"Put ONLY real schema fields (excerpt, image fieldValue from upload_media, date, etc.) in",
					"each entry's `fields` -- unknown fields are dropped. Credit authors via the per-entry",
					"`bylines` (byline ids from byline_create), NOT in `fields`. Upload images first.",
				].join(" "),
				inputSchema: z.object({
					collection: z.string().describe("Collection slug, e.g. 'posts' or 'projects'"),
					bodyField: z
						.string()
						.describe(
							"The collection's Portable Text body field name (from schema_get_collection), e.g. 'body' or 'content'",
						),
					voice: z
						.string()
						.describe(
							"Shared tone/voice/context applied to EVERY entry: who the site is for, the brand personality, any constraints.",
						),
					entries: z
						.array(
							z.object({
								title: z
									.string()
									.describe(
										"The entry title. Saved to the `title` field when the collection has one; the slug is derived from it when omitted.",
									),
								brief: z
									.string()
									.describe(
										"1-3 sentences on what THIS entry should cover. The body is written from this.",
									),
								slug: z
									.string()
									.optional()
									.describe("URL slug (auto-generated from the title if omitted)"),
								bylines: z
									.array(
										z.object({
											bylineId: z.string().describe("Byline id from byline_create / byline_list"),
											roleLabel: z.string().optional().describe("Optional role, e.g. 'Author'"),
										}),
									)
									.optional()
									.describe(
										"Authors to credit (the first is primary). Passed to content_create's top-level bylines param -- do NOT put bylines in `fields`.",
									),
								fields: z
									.record(z.string(), z.unknown())
									.optional()
									.describe(
										"Only REAL schema fields for this collection (from schema_get_collection): excerpt, image fieldValue (from upload_media), date, etc. Do NOT put the body, bylines, or taxonomy terms here. Keys that aren't in the schema are dropped.",
									),
							}),
						)
						.min(1)
						.describe("All entries to create"),
				}),
				execute: async (
					{
						collection,
						bodyField,
						voice,
						entries,
					}: {
						collection: string;
						bodyField: string;
						voice: string;
						entries: Array<{
							title: string;
							brief: string;
							slug?: string;
							bylines?: Array<{ bylineId: string; roleLabel?: string }>;
							fields?: Record<string, unknown>;
						}>;
					},
					{ abortSignal }: { abortSignal?: AbortSignal },
				) => {
					abortSignal?.throwIfAborted();
					const meta = this.mcpToolMeta("content_create");
					if (!meta) {
						return {
							success: false as const,
							changed: false as const,
							error: "content_create is not available (CMS not connected).",
						};
					}
					const batchKey = mutationKey("create_entries_batch", {
						collection,
						bodyField,
						voice,
						entries,
					});
					const cachedBatch = await convergence.reusedMutationResultQueued<unknown>(batchKey);
					if (cachedBatch.hit) return cachedBatch.value;
					abortSignal?.throwIfAborted();
					// Learn the collection's real fields so we can drop keys the
					// model invented/misplaced (bylines, category, tag) before they
					// fail content_create. Null = couldn't read schema; don't filter.
					const validFields = await this.fetchCollectionFieldSlugs(collection, abortSignal);
					abortSignal?.throwIfAborted();
					const { usedSlugs, duplicate } = reserveBatchSlugs(entries);
					if (duplicate) {
						return {
							success: false as const,
							changed: false as const,
							error: `Duplicate explicit slug "${duplicate}" in the batch. Choose unique slugs.`,
						};
					}

					// 1. Generate every body concurrently -- the slow part, and it
					//    parallelizes cleanly (no tools, no shared state). Bounded
					//    so we don't open an unbounded number of model calls. Retry
					//    once on an empty result (the model occasionally returns
					//    nothing) before giving up on that entry.
					const drafting = this.statusLine();
					const publishing = this.statusLine();
					let draftedCount = 0;
					drafting.set(`Drafting (0/${entries.length})...`);
					this.sendConsole(`Generating ${entries.length} entry bodies in parallel...`);
					const generateBody = async (entry: { title: string; brief: string }) => {
						const MAX = 4;
						for (let attempt = 0; attempt < MAX; attempt++) {
							abortSignal?.throwIfAborted();
							try {
								const { text, usage } = await generateText({
									model: genModel,
									abortSignal,
									system: [
										"You write the BODY of a single web content entry, in markdown.",
										voice,
										"Rules: 3-6 substantive paragraphs of real, specific writing. Use ## and ### for",
										"section headings where they help. Do NOT repeat the title as a heading. No",
										"frontmatter, no title line, no preamble such as 'Here is'. Output only the body markdown.",
									].join("\n"),
									prompt: `Title: ${entry.title}\n\nWrite about: ${entry.brief}`,
									maxOutputTokens: 2048,
									providerOptions: BUILDER_PROVIDER_OPTIONS,
								});
								metrics?.addSubcall(usage);
								const body = text.trim();
								if (body.length > 0) return body;
							} catch (err) {
								abortSignal?.throwIfAborted();
								// Retry capacity/rate errors with backoff; rethrow the rest.
								const msg = err instanceof Error ? err.message : String(err);
								if (attempt < MAX - 1 && isTransientAiError(msg)) {
									await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
									continue;
								}
								throw err;
							}
						}
						return null;
					};
					const drafted = await mapLimit(entries, 3, async (entry) => {
						abortSignal?.throwIfAborted();
						try {
							const body = await generateBody(entry);
							return { entry, body, error: body ? undefined : "empty body generated" };
						} catch (err) {
							return {
								entry,
								body: null as string | null,
								error: err instanceof Error ? err.message : String(err),
							};
						} finally {
							drafting.set(`Drafting (${++draftedCount}/${entries.length})...`);
						}
					}).catch((error: unknown) => {
						drafting.clear();
						throw error;
					});
					if (abortSignal?.aborted) {
						drafting.clear();
						abortSignal.throwIfAborted();
					}

					// 2. Create + publish serially. Writes go through the single
					//    dev server + D1, which the codebase repeatedly shows is
					//    fragile under concurrency; the parallel win is in step 1.
					//    `status: "published"` creates and publishes in one call.
					return withBuildMutation(
						convergence,
						async () => {
							const results: Array<{ title: string; id?: string; ok: boolean; error?: string }> =
								[];
							const droppedFields: Array<{ title: string; fields: string[] }> = [];
							const saveProgress = async () => {
								publishing.set("Saving...");
								await timeSync(metrics, "previewRefresh", () => this.refreshAndReloadPreview());
								if (results.some((result) => result.ok)) {
									await timeSync(metrics, "backup", () => this.backupSite({ quiet: true }));
								}
							};
							for (const [index, d] of drafted.entries()) {
								if (abortSignal?.aborted) {
									await saveProgress();
									abortSignal.throwIfAborted();
								}
								publishing.set(`Publishing (${index + 1}/${drafted.length})...`);
								if (!d.body) {
									results.push({
										title: d.entry.title,
										ok: false,
										error: d.error ?? "body generation failed",
									});
									continue;
								}
								const { args, dropped } = batchEntryCreateArgs({
									collection,
									bodyField,
									body: d.body,
									entry: d.entry,
									validFields,
									usedSlugs,
								});
								if (dropped.length > 0) {
									droppedFields.push({ title: d.entry.title, fields: dropped });
									this.sendConsole(
										`create_entries_batch: dropped non-schema field(s) on ${collection}: ${dropped.join(", ")}`,
									);
								}
								try {
									let outcome = await this.callMcpTool(
										"content_create",
										meta.serverId,
										meta.inputSchema,
										args,
										abortSignal,
									);
									for (
										let retry = 0;
										retry < 4 &&
										outcome.status === "toolError" &&
										outcome.text.includes("[SLUG_CONFLICT]") &&
										!d.entry.slug &&
										typeof args.slug === "string";
										retry++
									) {
										const next = batchEntryCreateArgs({
											collection,
											bodyField,
											body: d.body,
											entry: d.entry,
											validFields,
											usedSlugs,
										});
										outcome = await this.callMcpTool(
											"content_create",
											meta.serverId,
											meta.inputSchema,
											next.args,
											abortSignal,
										);
									}
									if (outcome.status === "ok") {
										results.push({
											title: d.entry.title,
											id: extractContentId(outcome.result),
											ok: true,
										});
									} else if (outcome.status === "toolError") {
										results.push({ title: d.entry.title, ok: false, error: outcome.text });
									} else {
										results.push({
											title: d.entry.title,
											ok: false,
											error: "the dev server did not stabilize in time",
										});
									}
								} catch (err) {
									results.push({
										title: d.entry.title,
										ok: false,
										error: err instanceof Error ? err.message : String(err),
									});
								}
							}

							await saveProgress();
							const created = results.filter((r) => r.ok).length;
							this.sendConsole(`create_entries_batch: ${created}/${entries.length} created.`);
							return {
								success: created > 0,
								created,
								total: entries.length,
								results,
								...(droppedFields.length > 0 && {
									droppedFields,
									note: `Dropped fields are not in the ${collection} schema and were not saved. Use the collection's real field slugs to update those entries.`,
								}),
							};
						},
						batchKey,
						(result) => result.success && result.created === result.total,
					).finally(() => {
						// Drafting's last line stays up while publishing waits in the mutation queue.
						drafting.clear();
						publishing.clear();
					});
				},
			}),
		};
	}

	/** Model turns awaiting a record, keyed by request id, for the onChatResponse fallback. */
	private readonly openTurnMetrics = new Map<string, TurnMetrics>();

	private startTurnMetrics(
		requestId: string | undefined,
		init: Omit<TurnMetricsInit, "turnId" | "model">,
	): TurnMetrics {
		const turnId = requestId ?? crypto.randomUUID();
		const metrics = new TurnMetrics({ ...init, turnId, model: BUILDER_MODEL_ID });
		if (requestId) this.openTurnMetrics.set(requestId, metrics);
		return metrics;
	}

	/**
	 * Suggest next steps for the composer with a small model. Never throws. The
	 * builder's reply is passed in because it is not in `this.messages` until
	 * the SDK finishes reading the stream.
	 */
	private async refreshSuggestions(
		latestReply: string,
		toolNames: readonly string[],
	): Promise<void> {
		const turn = this.latestUserMessageId();
		const suggestions = await suggestNextSteps(
			this.env.AI,
			suggestionContext(this.messages, latestReply, Boolean(this.state.deploy?.liveUrl)),
			{
				toolNames,
				canSearchUnsplash: Boolean(this.env.UNSPLASH_ACCESS_KEY),
			},
		);
		// A newer message arrived meanwhile; its own build will suggest again.
		if (!suggestions.length || this.latestUserMessageId() !== turn) return;
		try {
			this.setState({ ...this.state, suggestions });
		} catch (error) {
			console.warn("[BuilderAgent] could not store suggestions:", error);
		}
	}

	/**
	 * Called when a turn changed the site: the pills may describe work that is now
	 * done or half done. Turns that only answer a question keep them.
	 */
	private dropSuggestions(): void {
		if (this.state.suggestions) this.setState({ ...this.state, suggestions: undefined });
	}

	/**
	 * End-of-turn backup, then the turn's record, also when the backup throws.
	 * Call after `markChatTurnFinished(this, metrics.pendingRecord())`: recovery
	 * skips a turn evicted during the backup and records that copy instead.
	 */
	private async saveAndRecordTurn(metrics: TurnMetrics): Promise<void> {
		try {
			const skipIfUnchanged = canReuseFinalSnapshotForTurn(metrics.pendingRecord());
			const saveError = await metrics.timeFinalSave(() => this.backupSite({ skipIfUnchanged }));
			if (saveError) metrics.noteError(`Session backup failed: ${saveError}`);
		} catch (error) {
			metrics.noteError(error);
			throw error;
		} finally {
			this.recordTurnMetrics(metrics.finish("finished"));
			// Recorded: drop the stashed copy so recovery cannot record it again.
			markChatTurnFinished(this);
		}
	}

	/**
	 * Log one line per model turn and keep the latest in state for smoke runs.
	 * Never throws. State is written first: if storage is gone (the instance is
	 * shutting down) the line is skipped, and recovery records the stashed copy.
	 * Recovery itself only logs, so it cannot disturb `onStart`'s progress reset.
	 */
	private recordTurnMetrics(
		record: TurnMetricsRecord | null | undefined,
		{ keepInState = true }: { keepInState?: boolean } = {},
	): void {
		if (!record) return;
		try {
			if (record.error) record.error = redactArtifactsToken(record.error);
			if (keepInState) this.setState({ ...this.state, lastTurnMetrics: record });
			console.log(
				JSON.stringify({ event: "builder.turn_metrics", sessionId: this.name, ...record }),
			);
		} catch (error) {
			console.warn("[BuilderAgent] could not record turn metrics:", error);
		}
	}

	/**
	 * Surface a turn error to the client (the chat panel renders it) as a
	 * failed stream -- no model call, so we never inject a synthetic user
	 * message that the model then reasons about as if the user sent it.
	 */
	private errorTurn(message: string): Response {
		const stream = createUIMessageStream({
			execute: () => {
				throw new Error(message);
			},
			onError: () => message,
		});
		return createUIMessageStreamResponse({ stream });
	}

	private finishNoopChat(requestId?: string): Response {
		if (requestId) this.finishOwnerActivity(`chat:${requestId}`);
		if (this.state.siteReady) this.provisionPromise = null;
		return new Response(null);
	}

	override async onChatMessage(
		onFinish: Parameters<typeof AIChatAgent.prototype.onChatMessage>[0],
		options?: OnChatMessageOptions,
	) {
		try {
			return await this.runChatTurn(onFinish, options);
		} catch (error) {
			// A thrown turn never reaches onChatResponse, which normally releases its row.
			if (options?.requestId) {
				const convergence = this.activeBuildConvergences.get(options.requestId);
				await convergence?.waitForIdle();
				if (this.activeBuildConvergences.get(options.requestId) === convergence) {
					this.activeBuildConvergences.delete(options.requestId);
				}
				this.finishOwnerActivity(`chat:${options.requestId}`);
			}
			throw error;
		}
	}

	private async runChatTurn(
		onFinish: Parameters<typeof AIChatAgent.prototype.onChatMessage>[0],
		options?: OnChatMessageOptions,
	) {
		if (this.stopPromise) await this.stopPromise;
		const turnStartedAt = Date.now();
		const resuming = options?.continuation === true || this.restartingInterruptedTurn;
		const turnUserMessageId = this.latestUserMessageId();
		this.restartingInterruptedTurn = false;
		if (this.hasOwnerActivityKind("publish")) {
			try {
				await this.registerProjectForCurrentOwner();
			} catch {}
			return this.errorTurn("Publishing is in progress. Wait for it to finish, then try again.");
		}
		// A resumed turn already passed the gate; keep that if it is evicted again.
		if (resuming) markChatTurnStarted(this);
		if (options?.requestId) {
			// Chat turns run one at a time: any other chat row belongs to an interrupted turn.
			this
				.sql`DELETE FROM owner_activity WHERE kind = 'chat' AND id != ${`chat:${options.requestId}`}`;
			this.beginOwnerActivity(`chat:${options.requestId}`, "chat");
		}
		try {
			await this.registerProjectForCurrentOwner();
		} catch (error) {
			if (options?.requestId) this.finishOwnerActivity(`chat:${options.requestId}`);
			const message = error instanceof Error ? error.message : "";
			return this.errorTurn(
				message === "Guest project limit reached. Sign in to keep building." ||
					message === "Project ownership is changing. Sign in again to continue."
					? message
					: friendlyTurnError(error),
			);
		}
		if (!this.getOwnerRecord()) return this.errorTurn("Project owner is missing.");
		const generation = this.ensureInitialGeneration();
		if (options?.abortSignal?.aborted) {
			if (generation?.status !== "ready") {
				this.setInitialGenerationStatus("stopped", turnUserMessageId);
			}
			markChatTurnFinished(this);
			return this.finishNoopChat(options?.requestId);
		}
		const latestUserId = this.latestUserMessageId();
		const stoppedAtMessageId =
			generation?.status === "stopped" ? generation.terminalMessageId : undefined;
		if (
			(generation?.status === "stopped" || generation?.status === "failed") &&
			this.messages.at(-1)?.role === "user" &&
			latestUserId !== generation.terminalMessageId
		) {
			this.setState({
				...this.state,
				initialGeneration: {
					id: generation.id,
					status: this.state.siteReady ? "building" : "preparing",
				},
			});
		}
		const initialGenerationId =
			this.state.initialGeneration?.status === "ready"
				? undefined
				: this.state.initialGeneration?.id;
		if (initialGenerationId && options?.requestId) {
			this.activeInitialRequestId = options.requestId;
			this.activeInitialUserMessageId = turnUserMessageId;
		}
		// Preview host: prefer the client's own host when it's a local dev
		// origin, so the preview URL routes back to THIS (local) worker and its
		// Sandbox DO. In production the client host isn't localhost, so we use
		// the configured PREVIEW_HOSTNAME (the wildcard-routed zone). Capture
		// the client host into state so recovery turns (no request body) keep it.
		const clientHost =
			typeof options?.body?.appHost === "string" ? options.body.appHost : undefined;
		if (clientHost && this.state.appHost !== clientHost) {
			this.setState({ ...this.state, appHost: clientHost });
		}
		const candidateHost = clientHost ?? this.state.appHost;
		const hostname =
			candidateHost && isLocalHostname(candidateHost) ? candidateHost : this.env.PREVIEW_HOSTNAME;
		// The client's Stop button fires this signal. Thread it into every
		// streamText call so a stop actually halts the server turn -- otherwise
		// the turn runs on as a zombie and blocks the queue, so the next message
		// never starts.
		const abortSignal = options?.abortSignal;

		// Site-ready turns can be intentionally empty (see shouldSkipSiteReadyTurn).
		// Gate them before constructing the model because they do not call it.
		if (
			(this.state.siteReady || stoppedAtMessageId) &&
			shouldSkipSiteReadyTurn({
				messages: this.messages,
				buildStarted: this.buildStarted || this.state.buildStarted === true,
				resuming,
				stoppedAtMessageId,
			})
		) {
			return this.finishNoopChat(options?.requestId);
		}
		markChatTurnStarted(this);
		const closedHistory = closeInterruptedToolCalls(this.messages);
		if (closedHistory) await this.persistMessages(closedHistory);

		const model = createBuilderModel(this.env);

		const finish = onFinish as (...args: unknown[]) => unknown;

		// Provisioning runs in the background. While the site isn't ready we run
		// tool-less interview turns so the user has something to do; when
		// provisioning finishes we auto-start the build (turns are otherwise
		// user-initiated, so a finished provision would just sit idle). A slow
		// provision means a longer interview rather than a stall.
		if (!this.state.siteReady) {
			// Kick off provisioning if it isn't running, or retry after a failure.
			if (!this.provisionPromise || this.state.provisionError) {
				this.setState({ ...this.state, provisionError: undefined });
				this.sendStatus("Setting up your site...");
				const controller = new AbortController();
				this.provisionController = controller;
				const pending = this.withOwnerActivity("provision", () =>
					this.provisionSite(hostname, controller.signal),
				);
				this.provisionPromise = pending;
				// When provisioning succeeds, trigger a fresh turn so the build
				// starts on its own. saveMessages waits for any active interview
				// turn (and any queued user turns) to finish first; the build
				// path below no-ops this turn if a queued user message already
				// ran the build by then.
				pending
					.then((result) => {
						if (!result.ready && this.provisionPromise === pending) this.provisionPromise = null;
						if (
							shouldAutoStartInitialBuild(
								result.ready,
								this.buildStarted,
								this.state.initialGeneration?.status,
							)
						) {
							this.sendStatus("");
							return this.saveMessages((messages) => [...messages]);
						}
						if (!result.ready && !result.stopped) this.setInitialGenerationStatus("failed");
						if (
							["stopping", "stopped", "failed"].includes(this.state.initialGeneration?.status ?? "")
						) {
							this.sendStatus("");
						}
					})
					.catch((err) => {
						if (this.provisionPromise === pending) this.provisionPromise = null;
						const message = err instanceof Error ? err.message : String(err);
						this.sendConsole(`ERROR: auto-start build failed: ${message}`);
						console.error("[BuilderAgent] auto-start build failed:", err);
					})
					.finally(() => {
						if (this.provisionController === controller) this.provisionController = null;
					});
			}
			const isUserTurn = this.messages[this.messages.length - 1]?.role === "user";
			const submission = isUserTurn
				? readQuestionnaireSubmission(this.messages, this.messages.length - 1)
				: undefined;
			if (shouldRecordBuildEligibility(this.messages, isUserTurn)) {
				this.markMilestone("buildEligible");
			}
			if (submission) {
				this.setInitialGenerationStatus("preparing");
				markChatTurnFinished(this);
				return this.finishNoopChat(options?.requestId);
			}

			// The first pre-ready turn runs the full interview. If the user
			// replies again while provisioning is still in flight, a second
			// interview turn would re-ask the same questions (visible loop), so
			// switch to a short holding turn once we've already interviewed --
			// detected by an existing assistant message in the history.
			const alreadyInterviewed = this.messages.some((m) => m.role === "assistant");
			const interviewSystem = alreadyInterviewed ? buildHoldingPrompt() : buildInterviewPrompt();
			const interviewTools = alreadyInterviewed
				? undefined
				: { ask_questions: createAskQuestionsTool() };
			const interviewMessages = await convertToModelMessages(this.messages);
			const metrics = this.startTurnMetrics(options?.requestId, {
				kind: alreadyInterviewed ? "holding" : "interview",
				resumed: resuming,
				stepCap: 2,
				startedAt: turnStartedAt,
			});
			metrics.streamStarted({
				promptChars: interviewSystem.length,
				toolCount: interviewTools ? Object.keys(interviewTools).length : 0,
			});
			const result = streamText({
				model,
				system: interviewSystem,
				messages: interviewMessages,
				tools: interviewTools,
				toolChoice: alreadyInterviewed ? undefined : FIRST_INTERVIEW_TOOL_CHOICE,
				stopWhen: alreadyInterviewed
					? stepCountIs(2)
					: [hasToolCall("ask_questions"), stepCountIs(2)],
				maxRetries: 5,
				maxOutputTokens: 8192,
				providerOptions: BUILDER_PROVIDER_OPTIONS,
				abortSignal,
				onStepFinish: (step) => {
					this.touchBuildActivity();
					metrics.onStep(step);
				},
				experimental_onToolCallFinish: (event) => {
					this.touchBuildActivity();
					metrics.onToolCallFinish(event);
				},
				onAbort: () => this.recordTurnMetrics(metrics.finish("stopped")),
				onError: ({ error }) => {
					console.error("[BuilderAgent] interview stream error:", error);
					metrics.noteError(error);
				},
				onFinish: (async (...args: unknown[]) => {
					await finish(...args);
					metrics.modelFinished((args[0] as { finishReason?: string } | undefined)?.finishReason);
					// The reply is complete; eviction during the backup must not replay the turn.
					markChatTurnFinished(this, metrics.pendingRecord());
					await this.saveAndRecordTurn(metrics);
				}) as any,
			});
			return createUIMessageStreamResponse({
				stream: withReasoningDurations(
					result.toUIMessageStream(
						replyStreamOptions(
							(error) => friendlyTurnError(error),
							initialGenerationId,
							alreadyInterviewed ? "holding" : undefined,
						),
					),
				),
			});
		}

		const { startsInitialBuild: isInitialBuild, initialBuild: tracksInitialBuild } =
			classifyBuildTurn(this.state, resuming);
		const metrics = this.startTurnMetrics(options?.requestId, {
			kind: tracksInitialBuild ? "initial-build" : "follow-up",
			resumed: resuming,
			stepCap: BUILD_STEP_CAP,
			startedAt: turnStartedAt,
		});
		if (isInitialBuild) this.markMilestone("buildEligible");
		if (!tracksInitialBuild && this.state.initialBuildInFlight) {
			this.setState({ ...this.state, initialBuildInFlight: false });
		}
		this.buildStarted = true;
		if (tracksInitialBuild) this.setInitialGenerationStatus("building");
		try {
			if (this.provisionPromise) {
				// The interview-phase provision just finished; the sandbox is warm.
				this.provisionPromise = null;
			} else {
				// A later turn (or after DO eviction / sandbox sleep): provisionSite
				// recovers from the Artifacts snapshot if the sandbox slept, and
				// fast-probes when already warm.
				const pendingProvision = this.provisionSite(hostname, abortSignal);
				this.activeProvisionPromise = pendingProvision;
				const recovered = await pendingProvision.finally(() => {
					if (this.activeProvisionPromise === pendingProvision) this.activeProvisionPromise = null;
				});
				if (!recovered.ready) {
					if (recovered.stopped) {
						markChatTurnFinished(this);
						return this.finishNoopChat(options?.requestId);
					}
					if (isInitialBuild) this.buildStarted = false;
					if (tracksInitialBuild) this.setInitialGenerationStatus("failed");
					this.recordTurnMetrics(metrics.finish("error", { error: recovered.error }));
					return this.errorTurn(friendlyTurnError(recovered.error));
				}
			}
			this.sendStatus("");

			const runawayToolInput = new ToolInputWhitespaceGuard();
			const runawayController = new AbortController();
			const buildAbortSignal = abortSignal
				? AbortSignal.any([abortSignal, runawayController.signal])
				: runawayController.signal;
			const convergence = new BuildConvergence(buildAbortSignal);
			if (options?.requestId) this.activeBuildConvergences.set(options.requestId, convergence);
			const sandboxTools = createTools(
				() => this.getOrCreateSandbox(),
				{
					reloadPreview: () =>
						timeSync(metrics, "previewRefresh", () =>
							this.refreshAndReloadPreview(tracksInitialBuild),
						),
					checkpointSite: async () => {
						await timeSync(metrics, "backup", () => this.backupSite({ quiet: true }));
					},
					restartDevServer: () => this.restartDevServer(metrics),
					getRecentRenderErrors: () =>
						[
							...new Set(
								this.devServerErrors
									.filter(({ at }) => at >= Date.now() - 5 * 60_000)
									.map(({ text }) => text),
							),
						].slice(-3),
					offerClone: () => this.offerClone(),
					capturePreview: () => this.capturePreview(buildAbortSignal),
					savePreviewThumbnail: (shotId, shot) => this.savePreviewThumbnail(shotId, shot),
					runSandboxRead: (operation) => this.runSandboxRead(operation, buildAbortSignal),
					validateBlockContracts: (sandbox) =>
						this.validateLiveBlockContracts(sandbox, buildAbortSignal),
				},
				{
					convergence,
					abortSignal: buildAbortSignal,
					streamFile,
					unsplashAccessKey: this.env.UNSPLASH_ACCESS_KEY,
					apiToken: this.getApiToken(),
					cmsBaseUrl: this.state.previewUrl,
					previewImagesEnabled: true,
					maxPreviewImages: 3,
				},
			);

			const mcpFailureGuard = new McpToolFailureGuard();
			const tools = {
				...sandboxTools,
				...this.buildMcpTools(mcpFailureGuard, convergence, metrics),
				...this.buildSchemaPlanTool(convergence, metrics),
				...this.buildBlockEvolutionTools(convergence, metrics),
				...this.buildContentBatchTool(convergence, metrics),
			};
			const buildToolNames = Object.keys(tools) as Array<keyof typeof tools>;
			const initialScaffoldContext = isInitialBuild
				? await this.loadInitialScaffoldContext()
				: undefined;
			const templateGuidance =
				initialScaffoldContext?.templateGuidance ?? (await this.loadTemplateGuidance());
			const system = buildBuildPrompt({
				templateGuidance,
				initialScaffoldContext,
				editMode: !tracksInitialBuild,
			});

			const onBuildFinish = async (...args: unknown[]) => {
				await finish(...args);
				// Record completion before the backup: eviction during the backup
				// does not replay a finished turn, so it would never be recorded.
				const outcome = args[0] as
					| { finishReason?: string; steps?: readonly BuildStepLike[]; text?: string }
					| undefined;
				metrics.modelFinished(outcome?.finishReason);
				// Pills described the site before this turn's changes.
				if (convergence.currentRevision() > 0) this.dropSuggestions();
				if (
					!buildAbortSignal.aborted &&
					this.state.initialGeneration?.status !== "stopping" &&
					this.state.initialGeneration?.status !== "stopped" &&
					canCompleteBuild(convergence, outcome?.finishReason)
				) {
					this.markMilestone("complete");
					// Not awaited: runs beside the backup and never holds up the turn.
					void this.refreshSuggestions(outcome?.text ?? "", buildToolNames);
					if (tracksInitialBuild) {
						this.setInitialGenerationStatus(
							"ready",
							undefined,
							capturedPreviewShotId(outcome?.steps ?? [], convergence.currentRevision()),
						);
					}
					if (tracksInitialBuild && outcome?.steps) {
						const benchmark: InitialBuildBenchmark = {
							...summarizeInitialBuildBenchmark(this.state.milestones ?? {}, outcome.steps),
							...(isInitialBuild ? {} : { resumed: true }),
						};
						this.setState({ ...this.state, initialBuildBenchmark: benchmark });
						console.log(
							JSON.stringify({
								event: "builder.initial_build_benchmark",
								sessionId: this.name,
								...benchmark,
							}),
						);
					}
				} else if (tracksInitialBuild) {
					this.setInitialGenerationStatus("failed");
				}
				if (tracksInitialBuild) this.setState({ ...this.state, initialBuildInFlight: false });
				markChatTurnFinished(this, metrics.pendingRecord());
				await this.saveAndRecordTurn(metrics);
			};
			const history = await convertToModelMessages(this.messages);
			const modelMessages = tracksInitialBuild ? history : compactFollowUpContext(history);
			if (tracksInitialBuild) {
				this.setState({ ...this.state, buildStarted: true, initialBuildInFlight: true });
				if (isInitialBuild) this.markMilestone("buildStarting");
			}
			metrics.streamStarted({ promptChars: system.length, toolCount: buildToolNames.length });
			const result = streamText({
				model,
				system,
				messages: modelMessages,
				tools,
				// A full build is many tool calls; cap high so it finishes in one
				// turn. Keep text and tool history intact; prepareStep only drops
				// superseded screenshot bytes. Interview turns are capped at 2.
				stopWhen: stepCountIs(BUILD_STEP_CAP),
				prepareStep: ({ messages }) => {
					return prepareBuildStep(convergence, messages, buildToolNames);
				},
				onStepFinish: (step) => {
					convergence.finishStep(step);
					if (tracksInitialBuild) {
						this.setInitialGenerationStatus(
							convergence.hasCurrentValidation() ? "checking" : "building",
						);
					}
					releaseStepPreviewImages(step);
					this.touchBuildActivity();
					metrics.onStep(step);
				},
				experimental_onToolCallFinish: (event) => {
					this.touchBuildActivity();
					metrics.onToolCallFinish(event);
				},
				onAbort: () => {
					if (convergence.currentRevision() > 0) this.dropSuggestions();
					this.recordTurnMetrics(
						metrics.finish("stopped", {
							error: runawayController.signal.aborted ? runawayController.signal.reason : undefined,
						}),
					);
				},
				maxRetries: 5,
				maxOutputTokens: 32768,
				providerOptions: BUILDER_PROVIDER_OPTIONS,
				abortSignal: buildAbortSignal,
				onChunk: ({ chunk }) => {
					this.touchBuildActivity();
					if (!runawayToolInput.observe(chunk)) return;
					const error = new Error(
						"Stopped a malformed tool call after excessive whitespace in its unfinished input.",
					);
					this.sendConsole(`ERROR: ${error.message}`);
					runawayController.abort(error);
				},
				onFinish: onBuildFinish as any,
				onError: ({ error }) => {
					console.error("[BuilderAgent] build stream error:", error);
					this.sendConsole(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
					metrics.noteError(error);
				},
			});

			return createUIMessageStreamResponse({
				stream: withReasoningDurations(
					result.toUIMessageStream(
						replyStreamOptions((error) => friendlyTurnError(error), initialGenerationId),
					),
				),
			});
		} catch (err) {
			if (isInitialBuild && !this.state.buildStarted) this.buildStarted = false;
			// A thrown turn error (e.g. the container was drained by a new-version
			// rollout, so sandbox exec throws) must NOT bubble out silently -- that
			// leaves the client with a turn that just stops. Surface it as a short,
			// retry-oriented assistant message instead.
			console.error("[BuilderAgent] turn failed before streaming:", err);
			this.recordTurnMetrics(metrics.finish("error", { error: err }));
			this.sendConsole(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
			this.sendStatus("");
			if (tracksInitialBuild) this.setInitialGenerationStatus("failed");
			return this.errorTurn(friendlyTurnError(err));
		}
	}

	override async onStart(): Promise<void> {
		if (!this.stateWrittenHere && this.hasProgressInState()) {
			// A recovered turn marks itself active again when it resumes.
			this.setState({ ...this.state, status: "", previewRestarting: false, turnActive: false });
		}
		if (this.state.initialGeneration?.status === "stopping") {
			this.setInitialGenerationStatus("stopped", this.state.initialGeneration.terminalMessageId);
		}
	}

	/**
	 * This agent has no client tools or approvals, so an `input-available` part
	 * can only be a server tool orphaned by eviction. Waiting on it never
	 * resolves and would block recovery's continuation; onChatMessage repairs it.
	 */
	override hasPendingInteraction(): boolean {
		return false;
	}

	protected override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
		const plan = planChatRecovery(ctx);
		if (plan === "skip") {
			this.finishOwnerActivity(`chat:${ctx.requestId}`);
			// Evicted during the end-of-turn backup: record the turn as it stood before it.
			this.recordTurnMetrics(stashedTurnMetrics(ctx.recoveryData), { keepInState: false });
		}
		if (plan === "restart" || plan === "retry") {
			await this.schedule(
				0,
				"restartInterruptedTurn",
				{ afterMessageId: ctx.messages.at(-1)?.id ?? null, pastGate: plan === "restart" },
				{ idempotent: true },
			);
		}
		return plan === "continue" ? {} : { continue: false };
	}

	/**
	 * Re-run a turn that was evicted before it streamed anything, as a fresh
	 * reply. It skips the site-ready gate only if the interrupted turn had
	 * passed it, and only while the conversation still ends where that turn
	 * left it; a turn that ran in the meantime (or a restarted turn that was
	 * itself evicted) supersedes it, and the enqueued turn is gated normally.
	 */
	async restartInterruptedTurn(payload?: {
		afterMessageId?: string | null;
		pastGate?: boolean;
	}): Promise<void> {
		const target = payload?.afterMessageId ?? null;
		// Already superseded: the newer turn answers the conversation as it is now.
		if ((this.messages.at(-1)?.id ?? null) !== target) return;
		try {
			await this.saveMessages((messages) => {
				// Runs inside the turn lock, immediately before this turn's onChatMessage.
				this.restartingInterruptedTurn =
					payload?.pastGate === true && (messages.at(-1)?.id ?? null) === target;
				return [...messages];
			});
		} finally {
			this.restartingInterruptedTurn = false;
		}
	}

	protected override async onChatResponse(result: ChatResponseResult) {
		if (result.requestId === this.activeInitialRequestId) {
			if (result.status === "aborted") {
				await this.requestStop(this.state.initialGeneration?.id);
			} else if (result.status === "error") {
				this.setInitialGenerationStatus("failed");
			} else if (!this.state.buildStarted) {
				this.setInitialGenerationStatus(
					findPendingQuestionnaire(this.messages) ? "awaiting_answers" : "preparing",
				);
			}
			this.activeInitialRequestId = undefined;
			this.activeInitialUserMessageId = undefined;
		}
		const convergence = this.activeBuildConvergences.get(result.requestId);
		if (convergence) {
			await convergence.waitForIdle();
			if (this.activeBuildConvergences.get(result.requestId) === convergence) {
				this.activeBuildConvergences.delete(result.requestId);
			}
		}
		this.finishOwnerActivity(`chat:${result.requestId}`);
		const metrics = this.openTurnMetrics.get(result.requestId);
		if (metrics) {
			this.openTurnMetrics.delete(result.requestId);
			// Records user Stops (ai-chat settles before onAbort fires) and stream
			// failures that reach no streamText callback; onFinish/onAbort record
			// the rest first, and a second finish is a no-op.
			this.recordTurnMetrics(metrics.finishFromResponse(result));
		}
	}
}

// Mark `getCloneInfo` client-callable. The `@callable` decorator is the
// idiomatic way, but this build leaves decorator syntax untranspiled and
// workerd rejects it, so apply the decorator function manually -- it just
// records the method in the SDK's callable-metadata WeakMap, keyed on the
// prototype function, which is exactly what `agent.call()` dispatch checks.
callable({
	description: "Mint a read token and return a git clone command for this session's source.",
})(BuilderAgent.prototype.getCloneInfo, {
	kind: "method",
	name: "getCloneInfo",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Return recent console output so a reloaded client can catch up.",
})(BuilderAgent.prototype.getRecentConsole, {
	kind: "method",
	name: "getRecentConsole",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Return durable chat state after a client action loses its response.",
})(BuilderAgent.prototype.getClientRecoveryState, {
	kind: "method",
	name: "getClientRecoveryState",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Return a bounded screenshot thumbnail captured during this project's build.",
})(BuilderAgent.prototype.getPreviewThumbnail, {
	kind: "method",
	name: "getPreviewThumbnail",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Wake and restore the saved preview when an existing project is opened.",
})(BuilderAgent.prototype.resumePreview, {
	kind: "method",
	name: "resumePreview",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Record the preview route the builder is showing so edits refresh it.",
})(BuilderAgent.prototype.setPreviewPath, {
	kind: "method",
	name: "setPreviewPath",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Re-render one preview route before the builder reloads it.",
})(BuilderAgent.prototype.refreshPreviewRoute, {
	kind: "method",
	name: "refreshPreviewRoute",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Report whether a preview route's snapshot reflects the latest change.",
})(BuilderAgent.prototype.getPreviewRouteSnapshot, {
	kind: "method",
	name: "getPreviewRouteSnapshot",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Stop the active generation and wait for accepted mutations to settle.",
})(BuilderAgent.prototype.stopGeneration, {
	kind: "method",
	name: "stopGeneration",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Stop the unfinished first site generation until the user sends another message.",
})(BuilderAgent.prototype.stopInitialGeneration, {
	kind: "method",
	name: "stopInitialGeneration",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);

callable({
	description: "Retry the latest session checkpoint after a terminal save failure.",
})(BuilderAgent.prototype.retrySessionSave, {
	kind: "method",
	name: "retrySessionSave",
	static: false,
	private: false,
} as ClassMethodDecoratorContext);
