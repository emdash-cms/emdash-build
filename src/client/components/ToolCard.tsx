import { Collapsible } from "@cloudflare/kumo";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { useEffect, useRef, useState } from "react";
import { ActivityCollapsiblePanel } from "./ActivityCollapsiblePanel.js";
import { CodePreview } from "./CodePreview.js";
import { ShimmerText } from "./ShimmerText.js";

type ToolDisplayState = "active" | "complete" | "error" | "interrupted";
type ToolLabels = Record<Exclude<ToolDisplayState, "interrupted">, string>;
export type ToolCorrectionState = "recovering" | "recovered" | "retrying" | "retried";

const TOOL_LABELS: Record<string, ToolLabels> = {
	// Sandbox tools
	read_file: { active: "Reading file", complete: "Read file", error: "Failed to read file" },
	read_files: { active: "Reading files", complete: "Read files", error: "Failed to read files" },
	write_file: { active: "Writing file", complete: "Wrote file", error: "Failed to write file" },
	write_files: { active: "Writing files", complete: "Wrote files", error: "Failed to write files" },
	edit_file: { active: "Editing file", complete: "Edited file", error: "Failed to edit file" },
	edit_files: { active: "Editing files", complete: "Edited files", error: "Failed to edit files" },
	exec: { active: "Running command", complete: "Ran command", error: "Command failed" },
	search_unsplash: {
		active: "Searching photos",
		complete: "Searched photos",
		error: "Photo search failed",
	},
	upload_media: {
		active: "Adding images",
		complete: "Added images",
		error: "Failed to add images",
	},
	deploy_site: { active: "Deploying site", complete: "Deployed site", error: "Site deploy failed" },
	restart_dev_server: {
		active: "Restarting dev server",
		complete: "Restarted dev server",
		error: "Dev server restart failed",
	},
	offer_clone: {
		active: "Preparing source download",
		complete: "Prepared source download",
		error: "Source download failed",
	},
	create_entries_batch: {
		active: "Adding entries",
		complete: "Added entries",
		error: "Failed to add entries",
	},
	apply_schema_plan: {
		active: "Creating content model",
		complete: "Created content model",
		error: "Content model failed",
	},
	view_preview: {
		active: "Reviewing the preview",
		complete: "Reviewed the preview",
		error: "Preview review failed",
	},
	refresh_types: {
		active: "Refreshing content types",
		complete: "Refreshed content types",
		error: "Content type refresh failed",
	},
	validate_site: {
		active: "Validating site",
		complete: "Validated site",
		error: "Site validation failed",
	},
	// EmDash MCP tools
	schema_list_collections: {
		active: "Listing collections",
		complete: "Listed collections",
		error: "Failed to list collections",
	},
	schema_get_collection: {
		active: "Getting collection schema",
		complete: "Got collection schema",
		error: "Failed to get collection schema",
	},
	schema_list_block_types: {
		active: "Listing block types",
		complete: "Listed block types",
		error: "Failed to list block types",
	},
	schema_get_block_type: {
		active: "Getting block type",
		complete: "Got block type",
		error: "Failed to get block type",
	},
	schema_update_block_type: {
		active: "Updating block type",
		complete: "Updated block type",
		error: "Failed to update block type",
	},
	schema_activate_block_type_version: {
		active: "Activating block version",
		complete: "Activated block version",
		error: "Failed to activate block version",
	},
	update_blocks_field: {
		active: "Updating page sections",
		complete: "Updated page sections",
		error: "Failed to update page sections",
	},
	schema_create_collection: {
		active: "Creating collection",
		complete: "Created collection",
		error: "Failed to create collection",
	},
	schema_create_field: {
		active: "Adding field",
		complete: "Added field",
		error: "Failed to add field",
	},
	content_list: {
		active: "Listing content",
		complete: "Listed content",
		error: "Failed to list content",
	},
	content_get: {
		active: "Getting content",
		complete: "Got content",
		error: "Failed to get content",
	},
	content_create: {
		active: "Creating content",
		complete: "Created content",
		error: "Failed to create content",
	},
	content_update: {
		active: "Updating content",
		complete: "Updated content",
		error: "Failed to update content",
	},
	content_publish: {
		active: "Publishing content",
		complete: "Published content",
		error: "Failed to publish content",
	},
	content_unpublish: {
		active: "Unpublishing content",
		complete: "Unpublished content",
		error: "Failed to unpublish content",
	},
	content_delete: {
		active: "Deleting content",
		complete: "Deleted content",
		error: "Failed to delete content",
	},
	content_permanent_delete: {
		active: "Permanently deleting content",
		complete: "Permanently deleted content",
		error: "Failed to permanently delete content",
	},
	content_duplicate: {
		active: "Duplicating content",
		complete: "Duplicated content",
		error: "Failed to duplicate content",
	},
	search: {
		active: "Searching content",
		complete: "Searched content",
		error: "Content search failed",
	},
	taxonomy_list: {
		active: "Listing taxonomies",
		complete: "Listed taxonomies",
		error: "Failed to list taxonomies",
	},
	taxonomy_get: {
		active: "Getting taxonomy",
		complete: "Got taxonomy",
		error: "Failed to get taxonomy",
	},
	taxonomy_create: {
		active: "Creating taxonomy",
		complete: "Created taxonomy",
		error: "Failed to create taxonomy",
	},
	taxonomy_list_terms: {
		active: "Listing terms",
		complete: "Listed terms",
		error: "Failed to list terms",
	},
	taxonomy_create_term: {
		active: "Creating term",
		complete: "Created term",
		error: "Failed to create term",
	},
	taxonomy_update_term: {
		active: "Updating term",
		complete: "Updated term",
		error: "Failed to update term",
	},
	taxonomy_delete_term: {
		active: "Deleting term",
		complete: "Deleted term",
		error: "Failed to delete term",
	},
	byline_list: {
		active: "Listing authors",
		complete: "Listed authors",
		error: "Failed to list authors",
	},
	byline_get: { active: "Getting author", complete: "Got author", error: "Failed to get author" },
	byline_create: {
		active: "Creating author",
		complete: "Created author",
		error: "Failed to create author",
	},
	byline_update: {
		active: "Updating author",
		complete: "Updated author",
		error: "Failed to update author",
	},
	settings_get: {
		active: "Reading settings",
		complete: "Read settings",
		error: "Failed to read settings",
	},
	settings_update: {
		active: "Updating settings",
		complete: "Updated settings",
		error: "Failed to update settings",
	},
	media_list: { active: "Listing media", complete: "Listed media", error: "Failed to list media" },
	menu_list: { active: "Listing menus", complete: "Listed menus", error: "Failed to list menus" },
	menu_get: { active: "Getting menu", complete: "Got menu", error: "Failed to get menu" },
	menu_create: {
		active: "Creating menu",
		complete: "Created menu",
		error: "Failed to create menu",
	},
	menu_update: {
		active: "Updating menu",
		complete: "Updated menu",
		error: "Failed to update menu",
	},
	menu_set_items: {
		active: "Setting navigation",
		complete: "Set navigation",
		error: "Failed to set navigation",
	},
};

/**
 * Shrink an image URL to a tiny in-chat thumbnail. Unsplash/imgix URLs accept
 * resize params, so we request a small cropped variant rather than downloading
 * the full-size image.
 */
export function thumbUrl(url: string, size = 96): string {
	try {
		const u = new URL(url);
		if (u.hostname.endsWith("unsplash.com") || u.hostname.includes("imgix")) {
			u.searchParams.set("w", String(size));
			u.searchParams.set("h", String(size));
			u.searchParams.set("fit", "crop");
			u.searchParams.set("auto", "format");
			return u.href;
		}
	} catch {
		// fall through to the original URL
	}
	return url;
}

/** Images passed to upload_media, normalized from the tool input. */
export function getUploadImages(
	input: Record<string, unknown>,
): Array<{ url?: string; alt?: string; filename?: string }> {
	return Array.isArray(input.images)
		? input.images.map((image: unknown) => {
				const value = image && typeof image === "object" ? (image as Record<string, unknown>) : {};
				return {
					url: typeof value.url === "string" ? value.url : undefined,
					alt: typeof value.alt === "string" ? value.alt : undefined,
					filename: typeof value.filename === "string" ? value.filename : undefined,
				};
			})
		: [];
}

function toolDetail(toolName: string, input: Record<string, unknown>): string | null {
	switch (toolName) {
		case "read_file":
		case "write_file":
		case "edit_file":
			return typeof input.path === "string" ? input.path : null;
		case "write_files": {
			const count = Array.isArray(input.files) ? input.files.length : 0;
			return count > 0 ? `${count} ${count === 1 ? "file" : "files"}` : null;
		}
		case "edit_files": {
			const count = Array.isArray(input.edits) ? input.edits.length : 0;
			return count > 0 ? `${count} ${count === 1 ? "edit" : "edits"}` : null;
		}
		case "exec":
			return typeof input.command === "string" ? `“${input.command.slice(0, 80)}”` : null;
		case "search_unsplash":
			return typeof input.query === "string" ? `“${input.query}”` : null;
		case "upload_media": {
			// Thumbnails render in an always-visible strip below the header
			// (see MediaStrip); the header just shows a count/name.
			const images = getUploadImages(input);
			if (images.length === 0) return null;
			const first = images[0];
			const name =
				images.length === 1
					? String(first?.alt || first?.filename || "image")
					: `${images.length} images`;
			return name;
		}
		case "schema_create_collection": {
			const slug = typeof input.slug === "string" ? input.slug : null;
			const label = typeof input.label === "string" ? input.label : null;
			return [slug, label].filter(Boolean).join(": ") || null;
		}
		case "schema_get_block_type":
		case "schema_update_block_type":
			return typeof input.slug === "string" ? input.slug : null;
		case "schema_activate_block_type_version": {
			const slug = typeof input.slug === "string" ? input.slug : null;
			const version = typeof input.version === "number" ? `v${input.version}` : null;
			return [slug, version].filter(Boolean).join(" · ") || null;
		}
		case "update_blocks_field": {
			const collection = typeof input.collection === "string" ? input.collection : null;
			const field = typeof input.fieldSlug === "string" ? input.fieldSlug : null;
			return [collection, field].filter(Boolean).join(".") || null;
		}
		case "schema_create_field": {
			const collection = typeof input.collection === "string" ? input.collection : null;
			const slug = typeof input.slug === "string" ? input.slug : null;
			const type = typeof input.type === "string" ? ` (${input.type})` : "";
			return collection && slug ? `${collection}.${slug}${type}` : (collection ?? slug);
		}
		case "content_create":
			return typeof input.collection === "string" ? input.collection : null;
		case "content_publish": {
			const collection = typeof input.collection === "string" ? input.collection : null;
			const id = typeof input.id === "string" ? input.id : null;
			return [collection, id].filter(Boolean).join("/") || null;
		}
		case "taxonomy_create_term": {
			const taxonomy = typeof input.taxonomy === "string" ? input.taxonomy : null;
			const label = typeof input.label === "string" ? input.label : null;
			return [taxonomy, label].filter(Boolean).join(": ") || null;
		}
		default:
			return null;
	}
}

function collectionRepeaterTarget(input: Record<string, unknown>): string | null {
	if (!Array.isArray(input.collections)) return null;
	for (const candidate of input.collections) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
		const collection = candidate as Record<string, unknown>;
		if (!Array.isArray(collection.fields)) continue;
		for (const candidateField of collection.fields) {
			if (!candidateField || typeof candidateField !== "object" || Array.isArray(candidateField))
				continue;
			const field = candidateField as Record<string, unknown>;
			if (field.type !== "repeater") continue;
			const collectionSlug = typeof collection.slug === "string" ? collection.slug : "collection";
			const fieldSlug = typeof field.slug === "string" ? field.slug : "field";
			return `${collectionSlug}.${fieldSlug}`;
		}
	}
	return null;
}

function toolErrorText(
	toolName: string,
	input: Record<string, unknown>,
	errorText: unknown,
	outputError: unknown,
): string {
	const repeaterTarget = toolName === "apply_schema_plan" ? collectionRepeaterTarget(input) : null;
	if (repeaterTarget) {
		return `The proposed ${repeaterTarget} field used a collection repeater, which the current schema tools cannot create. No schema changes were applied. The agent should retry with a subject-specific block type and a blocks field.`;
	}
	return String(errorText ?? outputError ?? "Unknown error");
}

function toolActionLabel(toolName: string, state: ToolDisplayState): string {
	const fallback = toolName.replaceAll("_", " ");
	const title = fallback.charAt(0).toUpperCase() + fallback.slice(1);
	const labels = TOOL_LABELS[toolName] ?? {
		active: `Running ${fallback}`,
		complete: title,
		error: `${title} failed`,
	};
	return state === "interrupted"
		? `Stopped ${labels.active.charAt(0).toLowerCase()}${labels.active.slice(1)}`
		: labels[state];
}

function toolSummary(toolName: string, state: ToolDisplayState, input: Record<string, unknown>) {
	const label = toolActionLabel(toolName, state);
	const detail = toolDetail(toolName, input);
	return `${label}${detail ? ` ${detail}` : ""}${state === "active" ? "…" : ""}`;
}

function correctionSummary(
	toolName: string,
	state: ToolCorrectionState,
	input: Record<string, unknown>,
) {
	if (state === "retrying" || state === "retried") {
		const subject = toolName === "view_preview" ? "Preview" : "Validation";
		return state === "retried" ? `${subject} retry succeeded` : `${subject} interrupted · retrying`;
	}
	if (toolName === "validate_site") {
		return state === "recovered" ? "Fixed a site issue" : "Found a site issue · fixing";
	}
	const label = state === "recovered" ? "File update corrected" : "Adjusting file update";
	const detail = toolDetail(toolName, input);
	return `${label}${detail ? ` · ${detail}` : ""}`;
}

function contentTarget(input: Record<string, unknown>): string | null {
	const collection = input.collection;
	const id = input.id;
	if (typeof collection !== "string" || !collection.trim() || typeof id !== "string" || !id.trim())
		return null;
	if (collection === "pages" && id === "home") return "Home page";
	return `${collection}/${id}`;
}

function updatedFields(input: Record<string, unknown>): string[] {
	const data = input.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return [];
	return Object.keys(data).filter((key) => key && !key.startsWith("_"));
}

function fieldLabel(key: string): string {
	const name = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
	return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

function contentSummary(
	toolName: string,
	state: ToolDisplayState,
	input: Record<string, unknown>,
): string | null {
	const target = contentTarget(input);
	if (!target || state === "interrupted") return null;
	const verbs: Record<string, [string, string, string]> = {
		content_get: ["Loading", "Loaded", "Failed to load"],
		content_update: ["Updating", "Updated", "Failed to update"],
		content_publish: ["Publishing", "Published", "Failed to publish"],
	};
	const action = verbs[toolName];
	if (!action) return null;
	const verb = action[state === "active" ? 0 : state === "complete" ? 1 : 2];
	const fields = toolName === "content_update" && state === "complete" ? updatedFields(input) : [];
	const detail =
		fields.length === 1 && fields[0]
			? ` · ${fieldLabel(fields[0])}`
			: fields.length > 1
				? ` · ${fields.length} fields`
				: "";
	return `${verb} ${target}${detail}${state === "active" ? "…" : ""}`;
}

/** While input streams, a string value is complete only once a later key has started. */
function settledInput(input: Record<string, unknown>, key: string, streaming: boolean): boolean {
	if (!streaming) return true;
	const keys = Object.keys(input);
	const index = keys.indexOf(key);
	return index >= 0 && index < keys.length - 1;
}

function entriesBatchSummary(
	state: ToolDisplayState,
	input: Record<string, unknown>,
	output: Record<string, unknown>,
	inputStreaming: boolean,
): string {
	const target =
		typeof input.collection === "string" &&
		input.collection.trim() &&
		settledInput(input, "collection", inputStreaming)
			? ` to ${fieldLabel(input.collection)}`
			: "";
	const entries = (count: number) => `${count} ${count === 1 ? "entry" : "entries"}`;
	const requested = Array.isArray(input.entries) ? input.entries.length : 0;
	if (state === "error") return `Failed to add entries${target}`;
	if (state === "interrupted") return `Stopped adding entries${target}`;
	if (state === "active") {
		// The entry list is still arriving while the input streams, so its length would climb.
		return inputStreaming || requested === 0
			? `Adding entries${target}…`
			: `Adding ${entries(requested)}${target}…`;
	}
	const { created, total } = output;
	if (typeof created === "number" && typeof total === "number" && created < total) {
		return `Added ${created} of ${total} entries${target}`;
	}
	return `Added ${entries(typeof created === "number" ? created : requested)}${target}`;
}

function schemaPlanSummary(state: ToolDisplayState, output: Record<string, unknown>): string {
	if (state !== "complete" || output.success !== true) {
		return toolSummary("apply_schema_plan", state, {});
	}
	const counts = [
		[output.createdBlockTypes, "block type", "block types"],
		[output.createdCollections, "collection", "collections"],
	] as const;
	const created = counts.flatMap(([value, one, many]) =>
		typeof value === "number" && value > 0 ? [`${value} ${value === 1 ? one : many}`] : [],
	);
	if (output.changed === false) return "Content model up to date";
	return `Created content model${created.length > 0 ? ` · ${created.join(", ")}` : ""}`;
}

function checkedRoutes(output: Record<string, unknown>): string[] | null {
	if (output.success !== true) return null;
	const audit = output.publicSiteAudit;
	if (!audit || typeof audit !== "object" || Array.isArray(audit)) return null;
	const result = audit as Record<string, unknown>;
	if (result.success !== true || !Array.isArray(result.checkedPaths)) return null;
	const paths = result.checkedPaths;
	return paths.length > 0 && paths.every((path) => typeof path === "string") ? paths : null;
}

function uploadProgress(output: Record<string, unknown>, input: Record<string, unknown>) {
	const images = getUploadImages(input);
	const count = output.count;
	const uploaded = output.uploaded;
	if (
		images.length === 0 ||
		typeof count !== "number" ||
		!Number.isSafeInteger(count) ||
		count !== images.length ||
		typeof uploaded !== "number" ||
		!Number.isSafeInteger(uploaded) ||
		uploaded < 0 ||
		uploaded > count
	) {
		return null;
	}
	return { uploaded, count };
}

function mediaSummary(output: Record<string, unknown>, input: Record<string, unknown>) {
	const progress = uploadProgress(output, input);
	if (!progress || progress.uploaded === 0) return null;
	return progress.uploaded === progress.count
		? `Uploaded ${progress.uploaded} ${progress.uploaded === 1 ? "photo" : "photos"}`
		: `Uploaded ${progress.uploaded} of ${progress.count} photos`;
}

/**
 * Extract tool name from a message part.
 * ai@6 uses either:
 *   - type: "dynamic-tool" with toolName field
 *   - type: "tool-{name}" with name embedded in type string
 */
function getToolName(part: Record<string, unknown>): string {
	if (typeof part.toolName === "string") return part.toolName;
	const type = String(part.type ?? "");
	if (type.startsWith("tool-")) return type.slice(5);
	return "unknown";
}

/** Always-visible thumbnail strip for upload_media, so images are readable
 * without expanding the card. */
function MediaStrip({ input }: { input: Record<string, unknown> }) {
	const images = getUploadImages(input);
	if (images.length === 0) return null;
	return (
		<div className="mt-1.5 ml-0.5 flex flex-wrap gap-2 border-l border-border py-1 pl-3">
			{images.map((im, i) =>
				im?.url ? (
					<img
						key={i}
						src={thumbUrl(String(im.url), 200)}
						alt={String(im.alt ?? "")}
						title={String(im.alt ?? im.filename ?? "")}
						loading="lazy"
						className="h-16 w-16 rounded object-cover"
					/>
				) : null,
			)}
		</div>
	);
}

function MediaOutcome({
	input,
	output,
}: {
	input: Record<string, unknown>;
	output: Record<string, unknown>;
}) {
	const images = getUploadImages(input);
	const results = Array.isArray(output.results) ? output.results : [];
	const progress = uploadProgress(output, input);
	if (images.length === 0) return null;
	return (
		<div className="space-y-2 py-1">
			{progress ? (
				<p className="text-xs text-text-secondary">
					{progress.uploaded} of {progress.count} {progress.count === 1 ? "photo" : "photos"}{" "}
					uploaded
				</p>
			) : null}
			<ul className="space-y-2">
				{images.map((image, index) => {
					const result = results[index];
					const candidate =
						result && typeof result === "object" ? (result as Record<string, unknown>) : {};
					const item =
						typeof candidate.url !== "string" || candidate.url === image.url ? candidate : {};
					const uploaded =
						item.success === true ||
						(results.length === 0 && progress !== null && progress.uploaded === progress.count);
					const failed = item.success === false;
					const name = image.alt || image.filename || `Photo ${index + 1}`;
					return (
						<li
							key={`${image.url ?? "photo"}-${index}`}
							className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-surface-raised p-2"
						>
							{image.url ? (
								<img
									src={thumbUrl(image.url, 240)}
									alt=""
									loading="lazy"
									className="h-20 w-24 shrink-0 rounded-md bg-surface-sunken object-cover"
								/>
							) : null}
							<div className="min-w-0 py-0.5 text-xs">
								<p className="break-words font-medium text-text-primary">{name}</p>
								<p className={`mt-1 ${failed ? "text-danger" : "text-text-secondary"}`}>
									{uploaded
										? "Added to media library"
										: failed
											? `Could not upload${typeof item.error === "string" ? ` · ${item.error.slice(0, 180)}` : ""}`
											: "Upload status unavailable"}
								</p>
								{image.filename && image.filename !== name ? (
									<p
										className="mt-1 truncate font-mono text-[11px] text-text-tertiary"
										title={image.filename}
									>
										{image.filename}
									</p>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

function FileOutcome({
	toolName,
	input,
	output,
	active,
}: {
	toolName: string;
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	active: boolean;
}) {
	const path = typeof input.path === "string" ? input.path : null;
	if (!path || output.success !== true) return null;
	if (output.changed === false)
		return <p className="py-1 text-xs text-text-secondary">Already up to date</p>;
	if (output.changed !== true) return null;
	const oldText = input.oldText;
	const newText = input.newText;
	if (toolName === "edit_file" && typeof oldText === "string" && typeof newText === "string") {
		return (
			<div className="space-y-2 py-1">
				<CodePreview code={oldText} path={path} label="Before" change="removed" active={active} />
				<CodePreview code={newText} path={path} label="After" change="added" active={active} />
			</div>
		);
	}
	if (toolName === "write_file" && typeof input.content === "string") {
		return (
			<div className="py-1">
				<CodePreview code={input.content} path={path} label="File content" active={active} />
			</div>
		);
	}
	return null;
}

function ContentOutcome({ input }: { input: Record<string, unknown> }) {
	const fields = updatedFields(input);
	if (fields.length === 0) return null;
	const visibleFields = fields.slice(0, 3).map(fieldLabel);
	const more = fields.length > 3 ? `, and ${fields.length - 3} more` : "";
	const data = input.data as Record<string, unknown>;
	const heroImage = data.hero_image;
	const image =
		heroImage && typeof heroImage === "object" && !Array.isArray(heroImage)
			? (heroImage as Record<string, unknown>)
			: null;
	const url = typeof image?.url === "string" && /^https?:\/\//.test(image.url) ? image.url : null;
	return (
		<div className="space-y-2 py-1 text-xs text-text-secondary">
			<p className="break-words">
				Updated {fields.length === 1 ? "field" : "fields"}: {visibleFields.join(", ")}
				{more}
			</p>
			{url ? (
				<img
					src={url}
					alt={
						typeof image?.alt === "string" && image.alt.trim() ? image.alt : "Updated hero image"
					}
					loading="lazy"
					referrerPolicy="no-referrer"
					className="max-h-48 w-auto max-w-full rounded-lg border border-border object-contain"
				/>
			) : null}
		</div>
	);
}

function ValidationOutcome({
	output,
	failed,
	correctionState,
}: {
	output: Record<string, unknown>;
	failed: boolean;
	correctionState?: ToolCorrectionState;
}) {
	const audit = output.publicSiteAudit;
	const result = audit && typeof audit === "object" ? (audit as Record<string, unknown>) : null;
	const paths = checkedRoutes(output);
	const issues = result && Array.isArray(result.issues) ? result.issues : [];
	const passed = !failed && output.success === true;
	if (correctionState) {
		const message = {
			recovered: "A later validation passed.",
			recovering: "The builder is correcting this before it finishes.",
			retried: "A later validation completed successfully.",
			retrying: "The builder is retrying validation.",
		}[correctionState];
		return <p className="py-1 text-xs text-text-secondary">{message}</p>;
	}
	return (
		<div className="space-y-1 py-1 text-xs text-text-secondary">
			<p className={failed ? "text-danger" : "text-text-primary"}>
				{failed
					? "Validation failed"
					: passed
						? "Validation passed"
						: "Validation status unavailable"}
			</p>
			{passed && paths ? (
				<>
					<p>
						{paths.length} public {paths.length === 1 ? "route" : "routes"} checked
					</p>
					<ul className="flex flex-wrap gap-1.5 pt-1" aria-label="Validated routes">
						{paths.map((path) => (
							<li key={path} className="rounded border border-border bg-surface-sunken px-2 py-1">
								<code>{path}</code>
							</li>
						))}
					</ul>
				</>
			) : null}
			{issues.slice(0, 3).map((issue, index) => {
				const detail = issue && typeof issue === "object" ? (issue as Record<string, unknown>) : {};
				const path = typeof detail.path === "string" ? detail.path : undefined;
				const subject = path === "/" ? "The homepage" : path ? `Page ${path}` : "A page";
				const reason =
					detail.reason === "http-status"
						? `${subject} could not render${typeof detail.status === "number" ? ` (HTTP ${detail.status})` : ""}.`
						: detail.reason === "request-failed"
							? `${subject} could not be checked.`
							: detail.reason === "missing-block-renderer"
								? `${subject} is missing a section renderer.`
								: `${subject} did not pass this check.`;
				return (
					<p key={index} className="break-words text-danger">
						{reason}
					</p>
				);
			})}
		</div>
	);
}

/** Inline render of the screenshot a `view_preview` call captured. */
function ScreenshotStrip({ output }: { output: Record<string, unknown> }) {
	const base64 = typeof output.base64 === "string" ? output.base64 : undefined;
	if (!base64) return null;
	const mediaType = typeof output.mediaType === "string" ? output.mediaType : "image/png";
	return (
		<div className="mt-1.5 ml-0.5 border-l border-border py-1 pl-3">
			<img
				src={`data:${mediaType};base64,${base64}`}
				alt="Preview screenshot the agent reviewed"
				loading="lazy"
				className="max-h-64 w-full rounded bg-surface-sunken object-contain"
			/>
		</div>
	);
}

/** Compact JSON display for tool input/output */
function JsonDetail({ label, data }: { label: string; data: unknown }) {
	if (data == null || (typeof data === "object" && Object.keys(data as object).length === 0)) {
		return null;
	}
	const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
	// Truncate very long content
	const truncated = text.length > 2000 ? text.slice(0, 2000) + "\n..." : text;
	return (
		<div className="mt-2">
			<div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
				{label}
			</div>
			<pre className="max-h-[200px] overflow-auto rounded bg-surface-sunken p-2 font-mono text-[11px] leading-relaxed text-text-secondary">
				{truncated}
			</pre>
		</div>
	);
}

export function ToolCard({
	part,
	active = false,
	liveLabel,
	correctionState,
	variant = "compact",
	loadPreviewThumbnail,
}: {
	part: Record<string, unknown>;
	active?: boolean;
	/** The agent's current progress for this running step, shown after its label. */
	liveLabel?: string;
	/** Customer-facing state for a completed, correctable failure in this turn. */
	correctionState?: ToolCorrectionState;
	variant?: "compact" | "timeline";
	loadPreviewThumbnail?: (
		shotId: string,
	) => Promise<{ base64: string; mediaType: "image/png" } | null>;
}) {
	const [expanded, setExpanded] = useState(false);
	const [showTechnical, setShowTechnical] = useState(false);
	const [loadedShot, setLoadedShot] = useState<{
		shotId: string;
		thumbnail: { base64: string; mediaType: "image/png" } | null;
	}>();
	const [failedShotId, setFailedShotId] = useState<string>();
	const loaderRef = useRef(loadPreviewThumbnail);
	useEffect(() => {
		loaderRef.current = loadPreviewThumbnail;
	}, [loadPreviewThumbnail]);
	const toolName = getToolName(part);

	const state = String(part.state ?? "");
	const isComplete = state === "output-available" || state === "result";
	const output = (part.output ?? part.result ?? {}) as Record<string, unknown>;
	const input = (part.input ?? part.args ?? {}) as Record<string, unknown>;
	const technicalOutput = part.errorText
		? { ...output, errorText: String(part.errorText) }
		: output;
	const success = output?.success !== false;
	// A passing validation carries its final screenshot under `preview`.
	const previewShot =
		toolName === "validate_site"
			? (output.preview as { shotId?: unknown } | undefined)?.shotId
			: output.shotId;
	const shotId = typeof previewShot === "string" ? previewShot : undefined;
	const thumbnail = loadedShot?.shotId === shotId ? loadedShot?.thumbnail : undefined;
	const hasLoader = typeof loadPreviewThumbnail === "function";
	useEffect(() => {
		if (
			!expanded ||
			!isComplete ||
			!success ||
			!shotId ||
			!hasLoader ||
			!loaderRef.current ||
			loadedShot?.shotId === shotId
		)
			return;
		let cancelled = false;
		setFailedShotId(undefined);
		void loaderRef
			.current(shotId)
			.then((result) => {
				if (!cancelled) setLoadedShot({ shotId, thumbnail: result });
			})
			.catch(() => {
				if (!cancelled) setFailedShotId(shotId);
			});
		return () => {
			cancelled = true;
		};
	}, [expanded, isComplete, success, shotId, hasLoader, loadedShot?.shotId]);
	const rawError = state === "output-error" || (isComplete && !success);
	const isError = rawError && !correctionState;
	const isDone = isComplete || rawError;
	const displayState: ToolDisplayState = rawError
		? correctionState
			? "complete"
			: "error"
		: isDone
			? "complete"
			: active
				? "active"
				: "interrupted";
	const schemaPlanNeedsAdjustment =
		isError && toolName === "apply_schema_plan" && collectionRepeaterTarget(input) !== null;
	const routes =
		variant === "timeline" && toolName === "validate_site" && isComplete && success
			? checkedRoutes(output)
			: null;
	const summary =
		rawError && correctionState
			? correctionSummary(toolName, correctionState, input)
			: schemaPlanNeedsAdjustment
				? "Content model needed adjustment"
				: toolName === "apply_schema_plan"
					? schemaPlanSummary(displayState, output)
					: toolName === "upload_media" && isDone && !isError
						? (mediaSummary(output, input) ?? toolSummary(toolName, displayState, input))
						: toolName === "create_entries_batch"
							? entriesBatchSummary(displayState, input, output, state === "input-streaming")
							: ((variant === "timeline" ? contentSummary(toolName, displayState, input) : null) ??
								(routes
									? `Checked site · ${routes.length} ${routes.length === 1 ? "route" : "routes"} passed`
									: null) ??
								toolSummary(toolName, displayState, input));
	// A path still streaming would flash partial names ("src/pa", then nothing).
	const pathPending =
		["read_file", "write_file", "edit_file"].includes(toolName) &&
		!settledInput(input, "path", state === "input-streaming");
	const fileName =
		variant === "timeline" &&
		!correctionState &&
		["read_file", "write_file", "edit_file"].includes(toolName) &&
		!pathPending
			? toolDetail(toolName, input)?.split("/").pop()
			: undefined;
	const displaySummary = fileName
		? ["edit_file", "write_file"].includes(toolName) &&
			displayState === "complete" &&
			output.changed === false
			? "Up to date"
			: toolName === "edit_file" && displayState === "complete"
				? "Edited"
				: toolName === "write_file" && displayState === "complete"
					? "Wrote"
					: toolActionLabel(toolName, displayState)
		: pathPending
			? toolSummary(toolName, displayState, {})
			: summary;
	const accessibleSummary =
		fileName && displaySummary !== toolActionLabel(toolName, displayState)
			? `${displaySummary} ${toolDetail(toolName, input)}`
			: summary;
	const unellipsised = (text: string) =>
		text
			.replace(/(…|\.\.\.)$/, "")
			.trim()
			.toLowerCase();
	// A restart step's status restates its own label; only add news.
	const liveDetail =
		displayState === "active" &&
		liveLabel &&
		unellipsised(liveLabel) !== unellipsised(displaySummary)
			? liveLabel
			: undefined;
	const hasInput = Object.keys(input).length > 0;
	const hasOutput = Object.keys(output).length > 0 || Boolean(part.errorText);
	const canExpand = isDone && (hasInput || hasOutput);
	const rowContent = (
		<>
			{displayState === "active" ? (
				<ShimmerText className="min-w-0 truncate text-[13px] leading-snug">
					{liveDetail ? displaySummary.replace(/…$/, "") : displaySummary}
				</ShimmerText>
			) : (
				<span
					className={`min-w-0 truncate text-[13px] leading-snug ${isError ? "text-danger" : "text-text-tertiary"}`}
				>
					{displaySummary}
				</span>
			)}
			{fileName ? (
				<span
					className="min-w-0 truncate rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-text-secondary"
					title={toolDetail(toolName, input) ?? undefined}
				>
					{fileName}
				</span>
			) : null}
			{liveDetail ? (
				// Gives way before the label, which says which step this is.
				<span
					className="min-w-0 shrink-[8] truncate text-[13px] leading-snug text-text-tertiary"
					data-live-detail
				>
					<span aria-hidden="true">· </span>
					{liveDetail}
				</span>
			) : null}
			{canExpand ? (
				<CaretRight
					size={12}
					className={`shrink-0 text-text-tertiary opacity-60 transition-[opacity,transform] duration-150 group-hover/tool:opacity-100 motion-reduce:transition-none ${expanded ? "rotate-90 opacity-100" : ""}`}
					aria-hidden="true"
				/>
			) : null}
		</>
	);
	return (
		<Collapsible.Root
			open={expanded}
			onOpenChange={setExpanded}
			disabled={!canExpand}
			className="my-1 min-w-0 text-xs"
			data-tool-state={displayState}
			data-variant={variant}
			data-expanded={expanded}
		>
			<div className="group/tool flex min-h-7 items-center gap-1.5">
				{canExpand ? (
					<Collapsible.Trigger
						aria-label={variant === "timeline" ? accessibleSummary : undefined}
						className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent hover:text-text-primary"
					>
						{rowContent}
					</Collapsible.Trigger>
				) : (
					<div className="flex min-w-0 flex-1 items-center gap-1.5 py-1">{rowContent}</div>
				)}
			</div>

			{variant === "compact" && toolName === "upload_media" ? <MediaStrip input={input} /> : null}
			{variant === "compact" && toolName === "view_preview" && isComplete && success ? (
				<ScreenshotStrip output={output} />
			) : null}

			{canExpand ? (
				<ActivityCollapsiblePanel>
					<div
						className={`mt-1.5 mb-1 overflow-auto text-[11px] text-text-tertiary ${variant === "timeline" ? "max-h-[36rem]" : "ml-0.5 max-h-72 border-l border-border pl-3"}`}
					>
						{variant === "timeline" && toolName === "upload_media" ? (
							<MediaOutcome input={input} output={output} />
						) : null}
						{variant === "timeline" &&
						isDone &&
						!isError &&
						["edit_file", "write_file"].includes(toolName) ? (
							<FileOutcome toolName={toolName} input={input} output={output} active={expanded} />
						) : null}
						{variant === "timeline" && isDone && toolName === "validate_site" ? (
							<ValidationOutcome
								output={output}
								failed={rawError}
								correctionState={correctionState}
							/>
						) : null}
						{variant === "timeline" && isComplete && success && toolName === "content_update" ? (
							<ContentOutcome input={input} />
						) : null}
						{variant === "timeline" &&
						(toolName === "view_preview" || toolName === "validate_site") &&
						isComplete &&
						success &&
						thumbnail ? (
							<img
								src={`data:${thumbnail.mediaType};base64,${thumbnail.base64}`}
								alt="Preview screenshot captured during this step"
								loading="lazy"
								className="max-h-[260px] w-full max-w-[340px] rounded-lg border border-border object-contain"
							/>
						) : variant === "timeline" && toolName === "view_preview" && isComplete && success ? (
							<ScreenshotStrip output={output} />
						) : null}
						{variant === "timeline" &&
						toolName === "view_preview" &&
						isComplete &&
						success &&
						!output.base64 &&
						!thumbnail ? (
							<p className="py-2 text-xs text-text-secondary">
								{failedShotId === shotId
									? "Screenshot could not load. Close and reopen to retry."
									: thumbnail === undefined && loadPreviewThumbnail && shotId
										? "Loading screenshot…"
										: "Screenshot unavailable for this step. Back to site shows the current site."}
							</p>
						) : null}
						{variant === "timeline" ? (
							<Collapsible.Root open={showTechnical} onOpenChange={setShowTechnical}>
								<Collapsible.Trigger className="flex min-h-7 items-center gap-1 rounded text-xs text-text-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
									Technical details
									<CaretRight
										size={12}
										className={`transition-transform duration-150 motion-reduce:transition-none ${showTechnical ? "rotate-90" : ""}`}
										aria-hidden="true"
									/>
								</Collapsible.Trigger>
								<ActivityCollapsiblePanel>
									<JsonDetail label="Input" data={input} />
									<JsonDetail
										label="Output"
										data={
											toolName === "view_preview"
												? {
														...technicalOutput,
														base64: output.base64 ? "<image>" : undefined,
													}
												: technicalOutput
										}
									/>
								</ActivityCollapsiblePanel>
							</Collapsible.Root>
						) : (
							<>
								<JsonDetail label="Input" data={input} />
								{isDone ? (
									<JsonDetail
										label="Output"
										data={
											toolName === "view_preview"
												? {
														...technicalOutput,
														base64: output.base64 ? "<image>" : undefined,
													}
												: technicalOutput
										}
									/>
								) : null}
							</>
						)}
						{isError && (part.errorText || (isComplete && !success && output?.error != null)) ? (
							<div className="mt-2 rounded bg-danger-light px-2 py-1 text-danger">
								{toolErrorText(toolName, input, part.errorText, output?.error).slice(0, 500)}
							</div>
						) : null}
					</div>
				</ActivityCollapsiblePanel>
			) : null}
		</Collapsible.Root>
	);
}
