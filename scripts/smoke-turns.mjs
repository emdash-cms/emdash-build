/** Pure helpers for scripts/smoke-chat.mjs. */

import { findPendingQuestionnaire } from "../src/shared/questionnaire.ts";

const CUSTOM_ANSWER = "Use your best judgement for anything I have not specified, and build it.";

/**
 * Pick a fixed brief by `EMDASH_SMOKE_BRIEF` (default: the first). The older
 * prompt/answer variables still override it. A custom prompt gets a neutral
 * answer and no follow-up unless given; an empty follow-up skips it.
 */
export function selectBrief(briefs, env) {
	const id = env.EMDASH_SMOKE_BRIEF ?? Object.keys(briefs)[0];
	const brief = briefs[id];
	if (!brief) {
		throw new Error(
			`Unknown smoke brief "${id}". Choose one of: ${Object.keys(briefs).join(", ")}.`,
		);
	}
	const custom = env.EMDASH_SMOKE_PROMPT !== undefined;
	const ownFollowUp = env.EMDASH_SMOKE_FOLLOW_UP === undefined && !custom;
	return {
		id: custom ? "custom" : id,
		prompt: env.EMDASH_SMOKE_PROMPT ?? brief.prompt,
		answer: env.EMDASH_SMOKE_ANSWER ?? (custom ? CUSTOM_ANSWER : brief.answer),
		followUp: ownFollowUp ? brief.followUp : (env.EMDASH_SMOKE_FOLLOW_UP ?? ""),
		followUpExpect: ownFollowUp ? brief.followUpExpect : (env.EMDASH_SMOKE_FOLLOW_UP_EXPECT ?? ""),
		followUpStoryMove: ownFollowUp ? brief.followUpStoryMove : undefined,
	};
}

function addTokens(total, tokens) {
	for (const key of Object.keys(total)) total[key] += tokens?.[key] ?? 0;
}

function emptyTokens() {
	return { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
}

/** Totals across `builder.turn_metrics` records. */
export function summarizeTurns(records) {
	const summary = {
		turns: records.length,
		byOutcome: {},
		wallMs: 0,
		finalSaveMs: 0,
		steps: 0,
		tokens: emptyTokens(),
		subcallTokens: emptyTokens(),
		toolCalls: 0,
		toolFailures: 0,
		toolMs: 0,
		syncMs: { previewRefresh: 0, backup: 0 },
	};
	for (const record of records) {
		summary.byOutcome[record.outcome] = (summary.byOutcome[record.outcome] ?? 0) + 1;
		summary.wallMs += record.wallMs;
		summary.finalSaveMs += record.finalSaveMs ?? 0;
		summary.steps += record.steps;
		addTokens(summary.tokens, record.tokens);
		addTokens(summary.subcallTokens, record.subcalls?.tokens);
		for (const tool of Object.values(record.tools ?? {})) {
			summary.toolCalls += tool.calls;
			summary.toolFailures += tool.failures;
			summary.toolMs += tool.ms;
		}
		for (const kind of Object.keys(summary.syncMs)) {
			summary.syncMs[kind] += record.sync?.[kind]?.ms ?? 0;
		}
	}
	return summary;
}

/**
 * The preview serves the last cached HTML for any path it has seen, keyed by
 * path and query. A per-round query makes each audit round render live.
 */
export function auditUrl(previewUrl, path, round) {
	const url = new URL(path, previewUrl);
	url.searchParams.set("smoke-audit", String(round));
	return url;
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `content` contains `text` as whole words or numbers, ignoring case. */
export function containsText(content, text) {
	return new RegExp(`(?<![\\w.])${escapeRegExp(text)}(?![\\w])`, "i").test(content);
}

const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	pound: "£",
	euro: "€",
	rsquo: "’",
	lsquo: "‘",
	ndash: "–",
	mdash: "—",
};

function decodeEntity(match, name) {
	if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
	const code =
		name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
	return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
}

// Inline elements that can split one word or number, as in `£5<span>.20</span>`.
// Astro keeps meaningful whitespace between elements, so joining them is safe.
const PHRASE_TAG =
	/^<\/?(span|em|strong|b|i|u|s|small|mark|sup|sub|abbr|time|code|q|cite|data|var|kbd|bdi|bdo|wbr)\b/i;

/** Drop comments and never-shown elements in one linear pass. */
function stripHidden(html) {
	const lower = html.toLowerCase();
	const opener = /<!--|<(script|style|template|noscript|svg|head)\b/g;
	let text = "";
	let from = 0;
	for (let match = opener.exec(lower); match; match = opener.exec(lower)) {
		text += `${html.slice(from, match.index)} `;
		const tagEnd = match[1] ? lower.indexOf(">", opener.lastIndex) : -1;
		if (tagEnd > 0 && lower[tagEnd - 1] === "/") {
			// Self-closing, like `<svg/>`: nothing inside to hide.
			from = opener.lastIndex = tagEnd + 1;
			continue;
		}
		const close = lower.indexOf(match[1] ? `</${match[1]}` : "-->", opener.lastIndex);
		// Unclosed: the rest of the page is inside it.
		if (close === -1) return text;
		from = match[1] ? lower.indexOf(">", close) + 1 || html.length : close + 3;
		opener.lastIndex = from;
	}
	return text + html.slice(from);
}

/**
 * Roughly the text a reader sees in `html`: no comments, head, scripts,
 * styles, SVG or tags, entities decoded and whitespace collapsed. Good enough
 * to tell whether an edit's wording reached a page; not a full HTML parser.
 */
export function visibleText(html) {
	return stripHidden(html)
		.replace(/<[^<>]*>/g, (tag) => (PHRASE_TAG.test(tag) ? "" : " "))
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
		.replace(/\s+/g, " ");
}

export function hasStoryLinkOnSection(html, storyPath) {
	const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? "";
	const anchors = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
	for (const match of main.matchAll(anchors)) {
		try {
			const url = new URL(match[1] ?? match[2], "http://public-site.local");
			if (url.origin === "http://public-site.local" && url.pathname === storyPath) {
				return true;
			}
		} catch {
			continue;
		}
	}
	return false;
}

export function storyMovedBetweenSections(storyLinksByPath, storyMove) {
	return storyLinksByPath?.[storyMove.from] === false && storyLinksByPath?.[storyMove.to] === true;
}

/**
 * ai-chat saves a turn's reply after its metrics are recorded. A chat request
 * stores its messages before waiting for the turn lock, so a follow-up sent
 * earlier would be stored ahead of the reply and its turn skipped. Send it
 * only once the history has grown past `countBefore` (taken when the build
 * started) and ends with that reply. (A server restart mid-turn closes the
 * socket and fails the run, so a recovered partial reply never gets here.)
 */
export function replyPersisted(messages, countBefore) {
	return messages.length > countBefore && messages.at(-1)?.role === "assistant";
}

/** True when the interview's questions are waiting for answers, as the builder sees it. */
export function questionsPending(messages) {
	return findPendingQuestionnaire(messages) !== undefined;
}

/**
 * True when an interview turn record shows a successful `ask_questions` call.
 * A rejected call saves no questions, and the builder starts on its own.
 */
export function askedQuestions(turn) {
	const ask = turn.kind === "interview" ? turn.tools?.ask_questions : undefined;
	return Boolean(ask && ask.calls > ask.failures);
}

/**
 * Why the follow-up round failed, or `undefined`. `landed === false` means the
 * edit's text never reached a public page; `null` (already there before the
 * edit) and `undefined` (no expected text) prove nothing either way.
 */
export function followUpFailure(turn, publicSiteAudit, landed, expected) {
	if (turn.outcome !== "finished") {
		return `The follow-up turn ended as ${turn.outcome}${turn.error ? `: ${turn.error}` : ""}.`;
	}
	if (!publicSiteAudit.success) return "The public site audit failed after the follow-up.";
	if (publicSiteAudit.storyMoved === false) {
		return "The story must be absent from Waterways and present in Brookwatch after the follow-up edit.";
	}
	if (landed === false) {
		return `No public page's visible text contains "${expected}" after the follow-up edit.`;
	}
	return undefined;
}
