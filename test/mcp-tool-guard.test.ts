import { type StreamTextOnChunkCallback, type ToolSet, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	McpToolFailureGuard,
	ToolInputWhitespaceGuard,
	adaptMcpToolSchema,
	batchEntryCreateArgs,
	mcpToolDescription,
	normalizeMcpToolArgs,
	reserveBatchSlugs,
} from "../src/worker/mcp-tool-guard.js";

const menuSchema = {
	type: "object",
	properties: {
		name: { type: "string" },
		items: {
			type: "array",
			items: {
				type: "object",
				required: ["label", "type"],
				properties: {
					label: { type: "string" },
					type: { type: "string" },
					parentIndex: {
						type: "integer",
						minimum: 0,
						description: "Array index of the parent item",
					},
				},
			},
		},
	},
};

const cursorSchema = {
	type: "object",
	required: ["query"],
	properties: {
		query: { type: "string" },
		cursor: { type: "string", description: "Pagination cursor" },
	},
};

describe("MCP tool adaptation", () => {
	it("requires an explicit nullable parent for Luna menu items", () => {
		const adapted = adaptMcpToolSchema("menu_set_items", menuSchema) as any;
		const itemSchema = adapted.properties.items.items;

		expect(itemSchema.required).toContain("parentIndex");
		expect(itemSchema.properties.parentIndex).toMatchObject({
			anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
		});
		expect(itemSchema.properties.parentIndex.description).toContain(
			"Use null for a top-level item",
		);
		expect(menuSchema.properties.items.items.required).not.toContain("parentIndex");
	});

	it("turns explicit null into the MCP contract while preserving real nesting", () => {
		const result = normalizeMcpToolArgs("menu_set_items", {
			name: "primary",
			items: [
				{ label: "Home", type: "custom", parentIndex: null },
				{ label: "Guides", type: "custom", parentIndex: null },
				{ label: "Getting started", type: "custom", parentIndex: 1 },
			],
		});

		expect(result.repaired).toBe(true);
		expect(result.args).toEqual({
			name: "primary",
			items: [
				{ label: "Home", type: "custom" },
				{ label: "Guides", type: "custom" },
				{ label: "Getting started", type: "custom", parentIndex: 1 },
			],
		});
	});

	it("repairs Luna's observed all-zero flat-menu arguments", () => {
		const result = normalizeMcpToolArgs("menu_set_items", {
			name: "primary",
			items: [
				{ label: "Home", type: "custom", parentIndex: 0 },
				{ label: "Projects", type: "custom", parentIndex: 0 },
				{ label: "About", type: "page", parentIndex: 0 },
			],
		});

		expect(result.repaired).toBe(true);
		expect(result.args).toEqual({
			name: "primary",
			items: [
				{ label: "Home", type: "custom" },
				{ label: "Projects", type: "custom" },
				{ label: "About", type: "page" },
			],
		});
	});

	it("tells the model to publish entries in the create call", () => {
		const description = mcpToolDescription("content_create", "Create content.");
		expect(description).toContain('status: "published"');
		// Publishing a routable entry needs a slug, which is derived only from a title or name.
		expect(description).toContain("slug");
	});

	it("guides first-page content listing and removes a blank cursor", () => {
		expect(mcpToolDescription("content_list", "List entries.")).toContain(
			"Pass cursor: null on the first page",
		);
		expect(mcpToolDescription("content_list", "List entries.")).toContain(
			"exact cursor returned by the previous response",
		);

		expect(
			normalizeMcpToolArgs("content_list", {
				collection: "products",
				cursor: "   ",
			}),
		).toEqual({
			repaired: true,
			args: { collection: "products" },
		});
	});

	it("makes paginated MCP cursors explicit nullable values", () => {
		for (const toolName of ["content_list", "search", "media_list"]) {
			const adapted = adaptMcpToolSchema(toolName, cursorSchema) as any;
			expect(adapted.required).toContain("cursor");
			expect(adapted.properties.cursor).toMatchObject({
				anyOf: [{ type: "string" }, { type: "null" }],
			});
			expect(adapted.properties.cursor.description).toContain("Use null for the first page");
		}
		expect(cursorSchema.required).not.toContain("cursor");
		expect(normalizeMcpToolArgs("search", { query: "bread", cursor: null })).toEqual({
			repaired: true,
			args: { query: "bread" },
		});
	});

	it("normalizes documented snake_case content ordering aliases", () => {
		expect(
			normalizeMcpToolArgs("content_list", {
				collection: "pages",
				status: "published",
				limit: 100,
				cursor: null,
				orderBy: "created_at",
				order: "desc",
			}),
		).toEqual({
			repaired: true,
			args: {
				collection: "pages",
				status: "published",
				limit: 100,
				orderBy: "createdAt",
				order: "desc",
			},
		});
		expect(normalizeMcpToolArgs("content_list", { orderBy: "updated_at" })).toEqual({
			repaired: true,
			args: { orderBy: "updatedAt" },
		});
	});
});

describe("MCP failure guard", () => {
	it("blocks only an identical rejected call and clears that attempt on success", () => {
		const guard = new McpToolFailureGuard(2);
		const error = "[VALIDATION_ERROR] item[0].parentIndex must reference an earlier item";
		const first = { name: "primary", items: [{ label: "Home" }] };
		const second = { name: "footer", items: [{ label: "Home" }] };

		expect(guard.recordFailure("menu_set_items", first, error)).toBe(false);
		expect(guard.recordFailure("menu_set_items", second, error)).toBe(false);
		expect(guard.isBlocked("menu_set_items", first)).toBe(false);
		expect(guard.isBlocked("menu_set_items", second)).toBe(false);

		expect(guard.recordFailure("menu_set_items", first, error)).toBe(true);
		expect(guard.isBlocked("menu_set_items", first)).toBe(true);
		expect(guard.isBlocked("menu_set_items", second)).toBe(false);

		guard.recordSuccess("menu_set_items");
		expect(guard.isBlocked("menu_set_items", first)).toBe(false);
	});

	it("never blocks state-dependent errors that another mutation can repair", () => {
		const guard = new McpToolFailureGuard(2);
		const input = { collection: "pages", id: "submit" };

		expect(guard.recordFailure("content_get", input, "[NOT_FOUND] submit")).toBe(false);
		expect(guard.recordFailure("content_get", input, "[NOT_FOUND] submit")).toBe(false);
		expect(guard.isBlocked("content_get", input)).toBe(false);
	});
});

/** A chunk exactly as `streamText` passes it to `onChunk`, not a UI message chunk. */
type OnChunkPart = Parameters<StreamTextOnChunkCallback<ToolSet>>[0]["chunk"];

describe("tool input whitespace guard", () => {
	it("aborts a pathological whitespace tail but allows ordinary formatted JSON", () => {
		const guard = new ToolInputWhitespaceGuard(8);
		const observe = (chunk: OnChunkPart) => guard.observe(chunk);

		expect(observe({ type: "tool-input-start", id: "call-1", toolName: "menu_set_items" })).toBe(
			false,
		);
		expect(
			observe({ type: "tool-input-delta", id: "call-1", delta: '{"name": "primary",\n  ' }),
		).toBe(false);
		expect(observe({ type: "tool-input-delta", id: "call-1", delta: "      " })).toBe(true);

		observe({ type: "tool-call", toolCallId: "call-1", toolName: "menu_set_items", input: {} });
		expect(observe({ type: "tool-input-start", id: "call-2", toolName: "menu_set_items" })).toBe(
			false,
		);
		expect(observe({ type: "tool-input-delta", id: "call-2", delta: "    1" })).toBe(false);
	});

	it("aborts a streamText turn from onChunk when a tool argument never finishes", async () => {
		const maxDeltas = 1_000;
		let deltas = 0;
		let aborts = 0;
		const guard = new ToolInputWhitespaceGuard();
		const controller = new AbortController();
		const result = streamText({
			model: new MockLanguageModelV3({
				doStream: async () => ({
					stream: new ReadableStream({
						start(stream) {
							stream.enqueue({ type: "stream-start", warnings: [] });
							stream.enqueue({
								type: "tool-input-start",
								id: "call-1",
								toolName: "menu_set_items",
							});
							stream.enqueue({
								type: "tool-input-delta",
								id: "call-1",
								delta: '{"name": "primary",',
							});
						},
						pull(stream) {
							if (++deltas > maxDeltas) return stream.close();
							stream.enqueue({ type: "tool-input-delta", id: "call-1", delta: " ".repeat(64) });
						},
					}),
				}),
			}),
			prompt: "Build",
			tools: { menu_set_items: tool({ inputSchema: z.object({ name: z.string() }) }) },
			abortSignal: controller.signal,
			// Same wiring as the build turn in agent.ts.
			onChunk: ({ chunk }) => {
				if (guard.observe(chunk)) controller.abort(new Error("runaway tool input"));
			},
			onAbort: () => {
				aborts++;
			},
		});
		const parts: string[] = [];
		for await (const part of result.fullStream) parts.push(part.type);

		expect(aborts).toBe(1);
		expect(parts.at(-1)).toBe("abort");
		// The mock ignores the signal and keeps producing, but the turn stops reading it.
		expect(parts.filter((type) => type === "tool-input-delta").length).toBeLessThan(maxDeltas);
	});
});

describe("create_entries_batch entries", () => {
	const entry = {
		title: "Crème Brûlée & Friends",
		fields: { role: "Pastry lead", category: "invented" },
	};
	const create = (validFields: Set<string> | null, overrides = {}, usedSlugs?: Set<string>) =>
		batchEntryCreateArgs({
			collection: "team",
			bodyField: "bio",
			body: "Bio text",
			entry: { ...entry, ...overrides },
			validFields,
			usedSlugs,
		});

	it("sends title only when the collection has it, and derives the slug otherwise", () => {
		// No title field: EmDash would reject `title`, and derives slugs only from title/name.
		expect(create(new Set(["role", "bio"]))).toEqual({
			args: {
				collection: "team",
				data: { role: "Pastry lead", bio: "Bio text" },
				status: "published",
				slug: "crème-brûlée-friends",
			},
			dropped: ["category"],
		});
		// A title field keeps EmDash's own slug generation; the entry title wins.
		const bylines = [{ bylineId: "by_1" }];
		expect(
			create(new Set(["title", "role", "bio"]), {
				fields: { title: "Stale", role: "Pastry lead" },
				bylines,
			}).args,
		).toEqual({
			collection: "team",
			data: { title: "Crème Brûlée & Friends", role: "Pastry lead", bio: "Bio text" },
			status: "published",
			bylines,
		});
		// Unknown schema: unchanged behaviour.
		expect(create(null).args).toEqual({
			collection: "team",
			data: {
				role: "Pastry lead",
				category: "invented",
				title: "Crème Brûlée & Friends",
				bio: "Bio text",
			},
			status: "published",
		});
	});

	it("derives slugs the way EmDash does, unique within the batch", () => {
		const fields = new Set(["bio"]);
		const slug = (title: string, used?: Set<string>) =>
			create(fields, { title, fields: {} }, used).args.slug;
		expect(slug("Москва")).toBe("москва");
		expect(slug("東京 Guide")).toBe("東京-guide");
		expect(slug("Straße_Guide")).toBe("straße-guide");
		expect(slug("🎉")).toMatch(/^untitled-[0-9a-z]{7}$/);
		expect(slug("a".repeat(90))).toHaveLength(80);
		const used = new Set<string>();
		expect([slug("Jane Doe", used), slug("Jane Doe", used), slug("Jane  Doe", used)]).toEqual([
			"jane-doe",
			"jane-doe-2",
			"jane-doe-3",
		]);
	});

	it("keeps an explicit slug, and leaves a name field to EmDash", () => {
		const fields = new Set(["name", "bio"]);
		expect(create(fields, { slug: "pastry" }).args.slug).toBe("pastry");
		expect(create(new Set(["title", "bio"]), { slug: "pastry" }).args.slug).toBe("pastry");
		expect(create(fields, { fields: { name: "Ana" } }).args).not.toHaveProperty("slug");
		expect(create(new Set(["title", "bio"]), { title: "" }).args).not.toHaveProperty("slug");
	});

	it("reserves explicit slugs before deriving later batch entries", () => {
		const used = new Set<string>();
		const fields = new Set(["bio"]);
		expect(create(fields, { slug: "crème-brûlée-friends" }, used).args.slug).toBe(
			"crème-brûlée-friends",
		);
		expect(create(fields, {}, used).args.slug).toBe("crème-brûlée-friends-2");
		const reserved = reserveBatchSlugs([{}, { slug: "crème-brûlée-friends" }]);
		expect(create(fields, {}, reserved.usedSlugs).args.slug).toBe("crème-brûlée-friends-2");
		expect(reserveBatchSlugs([{ slug: "same" }, { slug: "same" }]).duplicate).toBe("same");
	});
});
