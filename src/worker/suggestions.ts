// A small, fast model is plenty for a few short prompts and costs a fraction
// of a cent per call, next to a build turn on the frontier model.
export const SUGGESTIONS_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface Suggestion {
	/** Short pill text, e.g. "Add featured projects". */
	label: string;
	/** The request the pill fills into the composer. */
	prompt: string;
}

const MAX_SUGGESTIONS = 4;
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
	return `Rank the best next actions after an AI website builder finishes a change. The site uses Astro and EmDash CMS.

Available session capabilities:
${available}

Anything not listed is unavailable.${cannotPublish} Only suggest an action when the conversation gives concrete evidence that it is both relevant and unfinished. It must be possible to complete now using only the listed capabilities and information already in the session. Do not suggest external services, email delivery, payments, bookings, user accounts, or comments. Do not ask the user to supply facts, copy, prices, credentials, or images. Do not suggest generic audits or vague polishing.

Return one to ${MAX_SUGGESTIONS} suggestions, strongest first. Prefer fewer high-confidence actions over filling the list. Each suggestion has:
- label: an imperative of 2 to 5 words in sentence case, at most 32 characters, with no ending punctuation.
- prompt: the specific request the user would send, one or two sentences, at most 200 characters.
- capabilities: every capability ID needed to complete it.

Do not suggest work that is already done. Respond with JSON only.`;
}

const ALWAYS_UNSUPPORTED_ACTIONS = [
	/\bcomments?\b/i,
	/\b(?:send|forward|route|deliver)\b.{0,80}\b(?:email|e-mail|inbox)\b/i,
	/\b(?:email|e-mail|newsletter|mailing list)\b.{0,40}\b(?:signup|subscription|delivery|integration)\b/i,
	/\b(?:payments?|checkout|stripe|paypal)\b/i,
	/\b(?:bookings?|reservations?)\b/i,
	/\b(?:user accounts?|authentication|sign[ -]?in|log[ -]?in|registration)\b/i,
];

const ACTION_CAPABILITY_REQUIREMENTS = [
	{
		capability: "media_search",
		pattern: /\bunsplash\b|\b(?:find|search|source)\b.{0,40}\b(?:photos?|images?|photography)\b/i,
	},
];

const PUBLICATION_ACTION = /\b(?:publish|deploy|launch|ship|release)\b|\bgo live\b/i;

function needsUnavailablePublication(
	action: string,
	availableCapabilities: ReadonlySet<string>,
): boolean {
	return PUBLICATION_ACTION.test(action) && !availableCapabilities.has("publish_site");
}

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
								minItems: 1,
								uniqueItems: true,
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

function parseSuggestions(
	output: unknown,
	availableCapabilities: ReadonlySet<string>,
): Suggestion[] {
	let response = (output as { response?: unknown } | null)?.response ?? output;
	if (typeof response === "string") response = JSON.parse(response);
	const items = (response as { suggestions?: unknown } | null)?.suggestions;
	if (!Array.isArray(items)) return [];
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
	return suggestions;
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
		return parseSuggestions(output, new Set(capabilityIds));
	} catch (error) {
		console.warn("[suggestions] could not suggest next steps:", error);
		return [];
	}
}
