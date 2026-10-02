// A small, fast model is plenty for a few short prompts and costs a fraction
// of a cent per call, next to a build turn on the frontier model.
export const SUGGESTIONS_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface Suggestion {
	/** Short pill text, e.g. "Add featured projects". */
	label: string;
	/** The request the pill fills into the composer. */
	prompt: string;
}

const MAX_SUGGESTIONS = 3;
const MAX_LABEL = 32;
const MAX_PROMPT = 200;
const RECENT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 600;
const MAX_REPLY_CHARS = 2_000;

interface SuggestionCapability {
	id: string;
	description: string;
}

export interface SuggestionSession {
	toolNames: readonly string[];
	canSearchUnsplash: boolean;
}

const hasAny = (toolNames: ReadonlySet<string>, names: readonly string[]) =>
	names.some((name) => toolNames.has(name));

/** Translate the live tool set into the user-visible work this session can actually complete. */
export function suggestionCapabilities(session: SuggestionSession): SuggestionCapability[] {
	const tools = new Set(session.toolNames);
	return [
		{
			id: "edit_site",
			description: "Edit Astro pages, components, interactions, and Tailwind styles.",
			available: hasAny(tools, ["write_file", "write_files", "edit_file", "edit_files"]),
		},
		{
			id: "cms_schema",
			description: "Create or change EmDash content collections and fields.",
			available: hasAny(tools, [
				"apply_schema_plan",
				"schema_create_collection",
				"schema_create_field",
			]),
		},
		{
			id: "cms_content",
			description: "Create or edit EmDash content entries.",
			available: hasAny(tools, ["create_entries_batch", "content_create", "content_update"]),
		},
		{
			id: "media_upload",
			description: "Add an image URL already present in the conversation to the media library.",
			available: tools.has("upload_media"),
		},
		{
			id: "media_search",
			description: "Find suitable Unsplash photos and add them to the media library.",
			available:
				session.canSearchUnsplash && tools.has("search_unsplash") && tools.has("upload_media"),
		},
		{
			id: "site_menu",
			description: "Create or update the site's navigation menus.",
			available: hasAny(tools, ["menu_create", "menu_update", "menu_set_items"]),
		},
		{
			id: "site_bylines",
			description: "Create or update author bylines.",
			available: hasAny(tools, ["byline_create", "byline_update"]),
		},
		{
			id: "site_taxonomy",
			description: "Create or update taxonomies and terms.",
			available: hasAny(tools, ["taxonomy_create", "taxonomy_create_term", "taxonomy_update_term"]),
		},
		{
			id: "site_settings",
			description: "Update EmDash site settings.",
			available: tools.has("settings_update"),
		},
		{
			id: "publish_site",
			description: "Publish the site to a public URL.",
			available: tools.has("deploy_site"),
		},
	]
		.filter((capability) => capability.available)
		.map(({ id, description }) => ({ id, description }));
}

function buildSystemPrompt(capabilities: readonly SuggestionCapability[]): string {
	const available = capabilities
		.map((capability) => `- ${capability.id}: ${capability.description}`)
		.join("\n");
	const cannotPublish = capabilities.some((capability) => capability.id === "publish_site")
		? ""
		: " Publishing the site is not available in this session.";
	const cannotFindPhotos = capabilities.some((capability) => capability.id === "media_search")
		? ""
		: " Photo search is not available in this session, so never suggest adding or replacing photos.";
	// Asked only for unfinished work, the model found none after a complete build.
	return `Suggest what the site owner is most likely to ask an AI website builder for next. The site uses Astro and EmDash CMS.

Available session capabilities:
${available}

Anything not listed is unavailable.${cannotPublish}${cannotFindPhotos}

Return exactly ${MAX_SUGGESTIONS} suggestions, strongest first. Each must be a specific change to this site that the builder can make now with the listed capabilities, using only information already in the conversation: for example a new section or page the brief implies, more entries for a collection the site already has, or a concrete design or interaction refinement. Never suggest external services, email delivery, payments, bookings, user accounts, comments, invented testimonials, reviews, or ratings, or anything that needs the owner to supply facts, copy, prices, credentials, or images. Never suggest generic audits, vague polishing, or work the builder already did.

Each suggestion has:
- label: an imperative of 2 to 5 words in sentence case, at most 32 characters, with no ending punctuation.
- prompt: the specific request the owner would send, one or two sentences, at most 200 characters.
- capabilities: every capability ID needed to complete it.

Respond with JSON only.`;
}

const ALWAYS_UNSUPPORTED_ACTIONS = [
	/\bcomments?\b/i,
	/\b(?:send|forward|route|deliver)\b.{0,80}\b(?:email|e-mail|inbox)\b/i,
	/\b(?:email|e-mail|newsletter|mailing list)\b.{0,40}\b(?:signup|subscription|delivery|integration)\b/i,
	/\b(?:payments?|checkout|stripe|paypal)\b/i,
	/\b(?:bookings?|reservations?)\b/i,
	/\b(?:user accounts?|authentication|sign[ -]?in|log[ -]?in|registration)\b/i,
	// Invented social proof, which the build prompt forbids; a review site's own reviews are content.
	/\btestimonials?\b|\b(?:customer|client|guest|patient|user)\s+reviews?\b|\bstar\s+ratings?\b|\b\d-star\b/i,
];

const ACTION_CAPABILITY_REQUIREMENTS = [
	{
		capability: "media_search",
		// Getting new photos; without a search, the only images left are ones the user already
		// gave. A preposition before the photo word makes it an edit: "a lightbox to project images".
		pattern:
			/\bunsplash\b|\b(?:find|search|source|add|replace|swap)\s+(?:(?!(?:to|on|for|in|of|with|from|per|across|around|under|over)\b)[\w-]+\s+){0,3}(?:photos?|images?|pictures?|portraits?|headshots?|photography|imagery)\b/i,
	},
];

const PUBLICATION_ACTION = /\b(?:publish|deploy|launch|ship|release)\b|\bgo live\b/i;

function needsUnavailablePublication(
	action: string,
	availableCapabilities: ReadonlySet<string>,
): boolean {
	return PUBLICATION_ACTION.test(action) && !availableCapabilities.has("publish_site");
}

/**
 * Workers AI refuses a schema with keywords its grammar cannot enforce, such
 * as `minItems` or `uniqueItems`, so `parseSuggestions` checks those instead.
 */
function responseFormat(capabilityIds: readonly string[]) {
	return {
		type: "json_schema" as const,
		json_schema: {
			type: "object",
			properties: {
				suggestions: {
					type: "array",
					items: {
						type: "object",
						properties: {
							label: { type: "string" },
							prompt: { type: "string" },
							capabilities: {
								type: "array",
								items: { type: "string", enum: [...capabilityIds] },
							},
						},
						required: ["label", "prompt", "capabilities"],
					},
				},
			},
			required: ["suggestions"],
		},
	};
}

interface SuggestionRunner {
	run(
		model: typeof SUGGESTIONS_MODEL,
		input: {
			messages: { role: "system" | "user"; content: string }[];
			response_format: ReturnType<typeof responseFormat>;
			max_tokens: number;
			temperature: number;
		},
	): Promise<unknown>;
}

interface MessageLike {
	role: string;
	parts?: readonly { type: string; text?: string }[];
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

function messageText(message: MessageLike): string {
	return (message.parts ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

/** A compact, text-only view of the conversation: the brief, recent turns, and the latest reply. */
export function suggestionContext(
	messages: readonly MessageLike[],
	latestReply: string,
	published = false,
): string {
	const brief = messages.find((message) => message.role === "user");
	const recent = messages
		.slice(-RECENT_MESSAGES)
		.filter(
			(message) => message !== brief && (message.role === "user" || message.role === "assistant"),
		)
		.map((message) => ({ role: message.role, text: messageText(message) }))
		.filter((message) => message.text)
		.map(
			(message) =>
				`${message.role === "user" ? "User" : "Builder"}: ${clip(message.text, MAX_MESSAGE_CHARS)}`,
		);
	return [
		`Site brief: ${clip(brief ? messageText(brief) : "", MAX_MESSAGE_CHARS)}`,
		...(recent.length ? ["Recent conversation:", ...recent] : []),
		`What the builder just did: ${clip(latestReply.replace(/\s+/g, " ").trim(), MAX_REPLY_CHARS)}`,
		published ? "The site is already published." : "The site has not been published yet.",
	].join("\n");
}

/** The usable suggestions, and how many the model offered before filtering. */
function parseSuggestions(
	output: unknown,
	availableCapabilities: ReadonlySet<string>,
): { suggestions: Suggestion[]; offered: number } {
	let response = (output as { response?: unknown } | null)?.response ?? output;
	if (typeof response === "string") response = JSON.parse(response);
	const items = (response as { suggestions?: unknown } | null)?.suggestions;
	if (!Array.isArray(items)) return { suggestions: [], offered: 0 };
	const seen = new Set<string>();
	const suggestions: Suggestion[] = [];
	for (const item of items) {
		const label = typeof item?.label === "string" ? item.label.replace(/\s+/g, " ").trim() : "";
		const prompt = typeof item?.prompt === "string" ? item.prompt.replace(/\s+/g, " ").trim() : "";
		const capabilities = Array.isArray(item?.capabilities)
			? [
					...new Set<string>(
						item.capabilities.filter(
							(capability: unknown): capability is string => typeof capability === "string",
						),
					),
				]
			: [];
		const key = label.toLowerCase();
		if (!label || !prompt || label.length > MAX_LABEL || prompt.length > MAX_PROMPT) continue;
		const action = `${label} ${prompt}`;
		if (ALWAYS_UNSUPPORTED_ACTIONS.some((pattern) => pattern.test(action))) continue;
		if (needsUnavailablePublication(action, availableCapabilities)) continue;
		if (
			ACTION_CAPABILITY_REQUIREMENTS.some(
				({ capability, pattern }) => pattern.test(action) && !availableCapabilities.has(capability),
			)
		) {
			continue;
		}
		if (
			capabilities.length === 0 ||
			capabilities.some((capability) => !availableCapabilities.has(capability))
		) {
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		suggestions.push({ label, prompt });
		if (suggestions.length === MAX_SUGGESTIONS) break;
	}
	return { suggestions, offered: items.length };
}

/** Ask the small model for next-step prompts. Never throws; returns [] on any failure. */
export async function suggestNextSteps(
	ai: SuggestionRunner,
	context: string,
	session: SuggestionSession,
): Promise<Suggestion[]> {
	const capabilities = suggestionCapabilities(session);
	if (capabilities.length === 0) return [];
	const capabilityIds = capabilities.map((capability) => capability.id);
	try {
		const output = await ai.run(SUGGESTIONS_MODEL, {
			messages: [
				{ role: "system", content: buildSystemPrompt(capabilities) },
				{ role: "user", content: context },
			],
			response_format: responseFormat(capabilityIds),
			max_tokens: 500,
			temperature: 0.2,
		});
		const { suggestions, offered } = parseSuggestions(output, new Set(capabilityIds));
		if (suggestions.length === 0) {
			console.warn(`[suggestions] no usable suggestion; the model offered ${offered}`);
		}
		return suggestions;
	} catch (error) {
		console.warn("[suggestions] could not suggest next steps:", error);
		return [];
	}
}
