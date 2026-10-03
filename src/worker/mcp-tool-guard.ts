import type { JSONSchema7 } from "ai";
import { mutationKey } from "./build-convergence.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const PAGINATED_CURSOR_TOOLS = new Set(["content_list", "search", "media_list"]);
const CONTENT_ORDER_ALIASES: Record<string, string> = {
	created_at: "createdAt",
	updated_at: "updatedAt",
	published_at: "publishedAt",
	scheduled_at: "scheduledAt",
	deleted_at: "deletedAt",
};

/**
 * OpenAI-style tool calling is most reliable when nullable values are explicit.
 * EmDash's menu tool models a top-level item by omitting `parentIndex`; expose
 * that one optional value as required-but-nullable to the builder model while
 * leaving the real MCP contract unchanged.
 */
export function adaptMcpToolSchema(toolName: string, inputSchema: unknown): JSONSchema7 {
	if (!isObject(inputSchema)) return inputSchema as JSONSchema7;

	const adapted = structuredClone(inputSchema) as JsonObject;
	const properties = adapted.properties;
	if (!isObject(properties)) return inputSchema as JSONSchema7;
	if (PAGINATED_CURSOR_TOOLS.has(toolName) && isObject(properties.cursor)) {
		const stringCursor: JsonObject = { ...properties.cursor, type: "string" };
		delete stringCursor.anyOf;
		delete stringCursor.description;
		properties.cursor = {
			anyOf: [stringCursor, { type: "null" }],
			description:
				"Use null for the first page. Otherwise use only the exact cursor returned by the previous response.",
		};
		const required = Array.isArray(adapted.required)
			? adapted.required.filter((value): value is string => typeof value === "string")
			: [];
		if (!required.includes("cursor")) required.push("cursor");
		adapted.required = required;
		return adapted as JSONSchema7;
	}
	if (toolName !== "menu_set_items") return inputSchema;
	const itemsProperty = properties.items;
	if (!isObject(itemsProperty) || !isObject(itemsProperty.items)) return inputSchema;
	const itemSchema = itemsProperty.items;
	if (!isObject(itemSchema.properties)) return inputSchema;
	const parentIndex = itemSchema.properties.parentIndex;
	if (!isObject(parentIndex)) return inputSchema;

	const integerParent: JsonObject = { ...parentIndex, type: "integer" };
	delete integerParent.anyOf;
	delete integerParent.description;
	itemSchema.properties.parentIndex = {
		anyOf: [integerParent, { type: "null" }],
		description:
			"Array index of an earlier parent item. Use null for a top-level item; never use its own index.",
	};
	const required = Array.isArray(itemSchema.required)
		? itemSchema.required.filter((value): value is string => typeof value === "string")
		: [];
	if (!required.includes("parentIndex")) required.push("parentIndex");
	itemSchema.required = required;
	return adapted as JSONSchema7;
}

/**
 * Convert the builder-facing nullable menu shape back to EmDash's omission
 * contract. Older calls from Luna used `0` as a filler on every item, including
 * item zero. That first value can never be valid, so prefer a visible flat menu
 * over interpreting the remaining filler values as accidental nesting.
 */
export function normalizeMcpToolArgs(
	toolName: string,
	args: Record<string, unknown>,
): { args: Record<string, unknown>; repaired: boolean } {
	let normalized = args;
	let repaired = false;
	if (
		PAGINATED_CURSOR_TOOLS.has(toolName) &&
		(args.cursor === null || (typeof args.cursor === "string" && !args.cursor.trim()))
	) {
		normalized = { ...normalized };
		delete normalized.cursor;
		repaired = true;
	}
	const normalizedOrderBy =
		toolName === "content_list" && typeof normalized.orderBy === "string"
			? CONTENT_ORDER_ALIASES[normalized.orderBy]
			: undefined;
	if (normalizedOrderBy) {
		if (normalized === args) normalized = { ...normalized };
		normalized.orderBy = normalizedOrderBy;
		repaired = true;
	}
	if (toolName !== "menu_set_items" || !Array.isArray(normalized.items)) {
		return { args: normalized, repaired };
	}
	const items = normalized.items;
	const invalidFirstParent = isObject(items[0]) && items[0].parentIndex === 0;
	const normalizedItems = items.map((value) => {
		if (!isObject(value)) return value;
		if (value.parentIndex !== null && !invalidFirstParent) return value;
		const normalized = { ...value };
		delete normalized.parentIndex;
		repaired = true;
		return normalized;
	});
	return repaired
		? { args: { ...normalized, items: normalizedItems }, repaired: true }
		: { args: normalized, repaired: false };
}

const AUTO_PUBLISH_NOTE =
	"In this builder, when status is omitted and the item is already published, the staged " +
	"change is published automatically if there is no existing draft or schedule. On success, " +
	"the response carries the new _rev; do not call content_publish afterwards.";
const CONTENT_LIST_NOTE =
	"Pass cursor: null on the first page. On later pages, pass only the exact cursor returned by the previous response; never invent a cursor. Omit orderBy unless the collection schema confirms that field is indexed.";

/** Saves the separate content_publish step EmDash's own description points to. */
const CREATE_PUBLISHED_NOTE =
	'In this builder, pass status: "published" to create and publish the entry in one call, unless the user asked for a draft. ' +
	"Publishing needs a slug, which is derived only from a title or name field, so pass an explicit slug for any other entry.";

/** EmDash's description, plus what the builder does differently. */
export function mcpToolDescription(toolName: string, description: string): string {
	if (toolName === "content_create") return `${description} ${CREATE_PUBLISHED_NOTE}`;
	if (toolName === "content_update") return `${description} ${AUTO_PUBLISH_NOTE}`;
	if (toolName === "content_list") return `${description} ${CONTENT_LIST_NOTE}`;
	return description;
}

/**
 * The id and new `_rev` when a `content_update` result is a published item
 * whose change EmDash staged as a draft (collections with revisions), so the
 * live site still shows the old values. A scheduled change must not be
 * published early, but its staged result still needs to be reported as not live.
 */
export function stagedLiveUpdate(
	data: unknown,
): { id: string; rev: string; scheduled: boolean } | undefined {
	if (!isObject(data) || !isObject(data.item) || typeof data._rev !== "string") return undefined;
	const { id, status, draftRevisionId, liveRevisionId, scheduledAt } = data.item;
	if (typeof id !== "string" || status !== "published") return undefined;
	if (typeof draftRevisionId !== "string" || draftRevisionId === liveRevisionId) return undefined;
	return { id, rev: data._rev, scheduled: Boolean(scheduledAt) };
}

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/** EmDash 0.37's `slugify` (`@emdash-cms/admin/slugify`), so derived slugs match its own. */
function slugify(text: string, maxLength = 80): string {
	const normalized = text.normalize("NFKC").toLowerCase();
	let slug = normalized
		.replace(/[\s_]+/gu, "-")
		.replace(/[^\p{Letter}\p{Number}\p{Mark}-]+/gu, "")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!/[\p{Letter}\p{Number}]/u.test(slug)) {
		let hash = 2166136261;
		for (let index = 0; index < normalized.length; index++) {
			hash ^= normalized.charCodeAt(index);
			hash = Math.imul(hash, 16777619);
		}
		slug = `untitled-${(hash >>> 0).toString(36).padStart(7, "0")}`;
	}
	let result = "";
	let length = 0;
	for (const { segment } of GRAPHEMES.segment(slug)) {
		if (length++ >= maxLength) break;
		result += segment;
	}
	return result.replace(/-+$/g, "");
}

export function reserveBatchSlugs(entries: readonly { slug?: string }[]): {
	usedSlugs: Set<string>;
	duplicate?: string;
} {
	const usedSlugs = new Set<string>();
	for (const entry of entries) {
		if (!entry.slug) continue;
		if (usedSlugs.has(entry.slug)) return { usedSlugs, duplicate: entry.slug };
		usedSlugs.add(entry.slug);
	}
	return { usedSlugs };
}

/**
 * `content_create` arguments for one `create_entries_batch` entry. Fields not
 * in the schema are dropped, and `title` is sent only when the collection has
 * it (EmDash rejects unknown fields; `validFields` null means unknown, so it is
 * sent). EmDash derives a missing slug only from `title` or `name`, and can't
 * publish a routable entry without one, so otherwise the slug comes from the
 * entry title. EmDash doesn't de-duplicate explicit slugs, so `usedSlugs`
 * numbers repeats within one batch.
 */
export function batchEntryCreateArgs(input: {
	collection: string;
	bodyField: string;
	body: string;
	entry: {
		title: string;
		slug?: string;
		bylines?: unknown[];
		fields?: Record<string, unknown>;
	};
	validFields: Set<string> | null;
	usedSlugs?: Set<string>;
}): { args: Record<string, unknown>; dropped: string[] } {
	const { collection, bodyField, body, entry, validFields, usedSlugs } = input;
	const data: Record<string, unknown> = {};
	const dropped: string[] = [];
	for (const [key, value] of Object.entries(entry.fields ?? {})) {
		if (!validFields || validFields.has(key)) data[key] = value;
		else dropped.push(key);
	}
	if (!validFields || validFields.has("title")) data.title = entry.title;
	data[bodyField] = body;
	const args: Record<string, unknown> = { collection, data, status: "published" };
	// A sent title (even empty) leaves the slug to EmDash, exactly as before.
	const hasSlugSource = "title" in data || (typeof data.name === "string" && data.name.length > 0);
	if (entry.slug) {
		args.slug = entry.slug;
		usedSlugs?.add(entry.slug);
	} else if (!hasSlugSource) {
		const base = slugify(entry.title);
		let slug = base;
		for (let n = 2; usedSlugs?.has(slug); n++) slug = `${base}-${n}`;
		usedSlugs?.add(slug);
		args.slug = slug;
	}
	if (entry.bylines && entry.bylines.length > 0) args.bylines = entry.bylines;
	return { args, dropped };
}

/** Stable content identity shared by create/update retries with corrected data. */
export function contentMutationFailureKey(
	toolName: string,
	args: Record<string, unknown>,
): string | undefined {
	if (toolName !== "content_create" && toolName !== "content_update") return;
	if (typeof args.collection !== "string") return;
	const data = isObject(args.data) ? args.data : undefined;
	const identity = [args.id, args.slug, data?.slug, data?.title, data?.name].find(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	if (!identity) return;
	const locale = typeof args.locale === "string" ? args.locale : "";
	return `content\0${args.collection}\0${locale}\0${identity}`;
}

/** Turn-local fuse for a model that repeats the exact same rejected MCP call. */
export class McpToolFailureGuard {
	private readonly failures = new Map<string, { error: string; count: number }>();
	private readonly blocked = new Set<string>();

	constructor(private readonly limit = 2) {}

	recordFailure(toolName: string, args: Record<string, unknown>, error: string): boolean {
		if (!error.includes("[VALIDATION_ERROR]")) return false;
		const key = mutationKey(toolName, args);
		const previous = this.failures.get(key);
		const count = previous?.error === error ? previous.count + 1 : 1;
		this.failures.set(key, { error, count });
		if (count >= this.limit) this.blocked.add(key);
		return this.blocked.has(key);
	}

	recordSuccess(toolName: string): void {
		const prefix = `${toolName}\0`;
		for (const key of this.failures.keys()) {
			if (key.startsWith(prefix)) this.failures.delete(key);
		}
		for (const key of this.blocked) {
			if (key.startsWith(prefix)) this.blocked.delete(key);
		}
	}

	isBlocked(toolName: string, args: Record<string, unknown>): boolean {
		return this.blocked.has(mutationKey(toolName, args));
	}
}

/** The fields of an AI SDK `TextStreamPart` (as `streamText` passes to `onChunk`) the guard reads. */
type ToolInputChunk = {
	type: string;
	/** Tool call id on `tool-input-start` / `tool-input-delta`. */
	id?: string;
	delta?: string;
	/** Tool call id on `tool-call`. */
	toolCallId?: string;
};

/** Detect a provider endlessly padding an unfinished tool argument with whitespace. */
export class ToolInputWhitespaceGuard {
	private readonly trailingWhitespace = new Map<string, number>();

	constructor(private readonly limit = 4096) {}

	observe(chunk: ToolInputChunk): boolean {
		if (chunk.type === "tool-input-start" && chunk.id) {
			this.trailingWhitespace.set(chunk.id, 0);
			return false;
		}
		if (chunk.type === "tool-call" && chunk.toolCallId) {
			this.trailingWhitespace.delete(chunk.toolCallId);
			return false;
		}
		if (chunk.type !== "tool-input-delta" || !chunk.id || typeof chunk.delta !== "string") {
			return false;
		}

		let lastNonWhitespace = -1;
		for (let index = chunk.delta.length - 1; index >= 0; index--) {
			if (!/\s/.test(chunk.delta[index] ?? "")) {
				lastNonWhitespace = index;
				break;
			}
		}
		const trailing = chunk.delta.length - lastNonWhitespace - 1;
		const previous = lastNonWhitespace === -1 ? (this.trailingWhitespace.get(chunk.id) ?? 0) : 0;
		const total = previous + trailing;
		this.trailingWhitespace.set(chunk.id, total);
		return total >= this.limit;
	}
}
