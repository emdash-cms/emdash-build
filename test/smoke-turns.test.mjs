import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	askedQuestions,
	auditUrl,
	containsText,
	followUpFailure,
	hasStoryLinkOnSection,
	questionsPending,
	replyPersisted,
	selectBrief,
	storyMovedBetweenSections,
	summarizeTurns,
	visibleText,
} from "../scripts/smoke-turns.mjs";

const briefs = JSON.parse(readFileSync(new URL("../scripts/smoke-briefs.json", import.meta.url)));

function tokens(input, cachedInput, output, reasoning) {
	return { input, cachedInput, output, reasoning };
}

function turn(overrides) {
	return {
		turnId: "t",
		kind: "initial-build",
		outcome: "finished",
		wallMs: 1_000,
		finalSaveMs: 100,
		steps: 3,
		tokens: tokens(1_000, 400, 200, 50),
		subcalls: { calls: 0, tokens: tokens(0, 0, 0, 0) },
		tools: { write_file: { calls: 2, ms: 300, failures: 0 } },
		sync: { previewRefresh: { count: 2, ms: 120 }, backup: { count: 2, ms: 180 } },
		...overrides,
	};
}

describe("smoke briefs", () => {
	it("ships briefs with a prompt, an answer and a follow-up edit", () => {
		expect(Object.keys(briefs).length).toBeGreaterThanOrEqual(3);
		for (const brief of Object.values(briefs)) {
			expect(brief.prompt.length).toBeGreaterThan(40);
			expect(brief.answer.length).toBeGreaterThan(20);
			expect(brief.followUp.length).toBeGreaterThan(10);
			// Text that only appears on the public site once the edit landed.
			expect(brief.followUpExpect.length).toBeGreaterThan(2);
		}
	});

	it("selects a brief by id and applies environment overrides", () => {
		const defaultBrief = Object.keys(briefs)[0];
		expect(selectBrief(briefs, {})).toMatchObject({ id: defaultBrief, ...briefs[defaultBrief] });
		// Overriding the follow-up drops the brief's expectation unless one is given.
		expect(
			selectBrief(briefs, { EMDASH_SMOKE_BRIEF: "editorial", EMDASH_SMOKE_FOLLOW_UP: "" }),
		).toMatchObject({
			id: "editorial",
			followUp: "",
			followUpExpect: "",
			followUpStoryMove: undefined,
		});
		expect(
			selectBrief(briefs, {
				EMDASH_SMOKE_BRIEF: "bakery",
				EMDASH_SMOKE_FOLLOW_UP: "Rename the bakery to Crumb",
				EMDASH_SMOKE_FOLLOW_UP_EXPECT: "Crumb",
			}),
		).toMatchObject({ id: "bakery", followUpExpect: "Crumb" });
		// A custom prompt is its own run: no unrelated brief answer or follow-up.
		const custom = selectBrief(briefs, { EMDASH_SMOKE_PROMPT: "Custom prompt" });
		expect(custom).toMatchObject({
			id: "custom",
			prompt: "Custom prompt",
			followUp: "",
			followUpExpect: "",
			followUpStoryMove: undefined,
		});
		expect(Object.values(briefs).map((brief) => brief.answer)).not.toContain(custom.answer);
		expect(
			selectBrief(briefs, { EMDASH_SMOKE_PROMPT: "Custom", EMDASH_SMOKE_ANSWER: "Mine" }).answer,
		).toBe("Mine");
		expect(() => selectBrief(briefs, { EMDASH_SMOKE_BRIEF: "missing" })).toThrow(
			/Unknown smoke brief "missing".*editorial/,
		);
	});
});

describe("smoke audit", () => {
	it("gives every audit round its own URL so cached preview HTML is not re-checked", () => {
		const preview = "https://preview.example.test";
		expect(auditUrl(preview, "/menu", 2).href).toBe(
			"https://preview.example.test/menu?smoke-audit=2",
		);
		expect(auditUrl(preview, "/stories?page=2", 1).searchParams.get("page")).toBe("2");
		expect(auditUrl(preview, "/", 1).href).not.toBe(auditUrl(preview, "/", 2).href);
	});

	it("finds a follow-up's expected text as whole words, ignoring case", () => {
		expect(containsText("<p>Country sourdough £5.20</p>", "5.20")).toBe(true);
		expect(containsText('<path d="M15.20 3L25.207 9"/>', "5.20")).toBe(false);
		expect(containsText("<a>Join Our Next Night</a>", "Join our next night")).toBe(true);
		expect(containsText("<h2>Rivers</h2>", "Rivers")).toBe(true);
		expect(containsText("<p>Riversides</p>", "Rivers")).toBe(false);
	});

	it("matches only the text a reader sees", () => {
		const found = (html, text) => containsText(visibleText(html), text);
		expect(found("<a>Join our <em>next</em>\n night</a>", "Join our next night")).toBe(true);
		expect(found("<p>Join&nbsp;our next night</p>", "Join our next night")).toBe(true);
		expect(found("<p>Loaf &pound;5.20</p>", "5.20")).toBe(true);
		expect(found("<p>Loaf <span>£</span>5.20</p>", "5.20")).toBe(true);
		expect(found("<p>Loaf £5<span>.20</span></p>", "5.20")).toBe(true);
		expect(found("<a>Home</a><a>Join our next night</a>", "Join our next night")).toBe(true);
		expect(found("<h2>Menu</h2><p>£5.20</p><p>Seeded rye</p>", "5.20")).toBe(true);
		expect(found("<p>Crumb &amp; Crust&#39;s &#x2014; loaf</p>", "Crumb & Crust's — loaf")).toBe(
			true,
		);
		// Markup and code the page carries but never shows.
		expect(found('<img alt="x" data-price="5.20">', "5.20")).toBe(false);
		expect(found('<script type="application/ld+json">{"price":"5.20"}</script>', "5.20")).toBe(
			false,
		);
		expect(found("<style>.x{--p: 5.20}</style><!-- 5.20 -->", "5.20")).toBe(false);
		expect(found('<svg viewBox="0 0 24 24"><path d="M 5.20 3"/></svg>', "5.20")).toBe(false);
		expect(found("<head><title>Loaf 5.20</title></head><header>Crumb</header>", "5.20")).toBe(
			false,
		);
		expect(found("<header>Brookwatch</header>", "Brookwatch")).toBe(true);
		expect(found('<svg class="icon"/><p>Brookwatch</p>', "Brookwatch")).toBe(true);
		expect(found("<p>&#99999999; ok</p>", "ok")).toBe(true);
	});

	it("reads malformed pages in linear time", () => {
		const started = performance.now();
		for (const junk of ["<script", "<!--", "< ", "&amp"]) {
			visibleText(`<p>ok</p>${junk.repeat(200_000)}`);
		}
		expect(visibleText("<p>ok</p><script>x").trim()).toBe("ok");
		expect(performance.now() - started).toBeLessThan(2_000);
	});
});

describe("smoke turn summary", () => {
	it("adds up turns, including entry-text calls, tools and sync time", () => {
		const summary = summarizeTurns([
			turn({ turnId: "interview", kind: "interview", steps: 1, tools: {} }),
			turn({
				turnId: "build",
				subcalls: { calls: 4, tokens: tokens(800, 0, 1_600, 900) },
				tools: {
					write_file: { calls: 5, ms: 2_000, failures: 1 },
					validate_site: { calls: 1, ms: 9_000, failures: 0 },
				},
			}),
		]);

		expect(summary).toEqual({
			turns: 2,
			byOutcome: { finished: 2 },
			wallMs: 2_000,
			finalSaveMs: 200,
			steps: 4,
			tokens: tokens(2_000, 800, 400, 100),
			subcallTokens: tokens(800, 0, 1_600, 900),
			toolCalls: 6,
			toolFailures: 1,
			toolMs: 11_000,
			syncMs: { previewRefresh: 240, backup: 360 },
		});
	});

	it("waits for the build reply to be saved before sending the follow-up", () => {
		const user = { role: "user", parts: [] };
		const reply = { role: "assistant", parts: [] };
		// A build that started on its own: history already ends with the interview reply.
		const atBuildStart = [user, reply];
		expect(replyPersisted(atBuildStart, atBuildStart.length)).toBe(false);
		expect(replyPersisted([...atBuildStart, reply], atBuildStart.length)).toBe(true);
		// A newer user message means something else is in flight.
		expect(replyPersisted([...atBuildStart, reply, user], atBuildStart.length)).toBe(false);
	});

	it("finds interview questions that are still waiting for answers", () => {
		const user = { role: "user", parts: [{ type: "text", text: "Build it" }] };
		const ask = (state, input = { questions: [{ question: "Tone?" }] }) => ({
			role: "assistant",
			parts: [{ type: "tool-ask_questions", toolCallId: "call-1", state, input }],
		});
		expect(questionsPending([user, ask("output-available")])).toBe(true);
		// Still streaming, rejected, empty, or already answered.
		expect(questionsPending([user, ask("input-streaming")])).toBe(false);
		expect(questionsPending([user, ask("output-error")])).toBe(false);
		expect(questionsPending([user, ask("output-available", { questions: [] })])).toBe(false);
		expect(questionsPending([user, ask("output-available"), user])).toBe(false);

		const interview = (calls, failures) => ({
			kind: "interview",
			tools: { ask_questions: { calls, ms: 0, failures } },
		});
		expect(askedQuestions(interview(1, 0))).toBe(true);
		// A rejected call saves no questions; the builder starts on its own.
		expect(askedQuestions(interview(1, 1))).toBe(false);
		expect(askedQuestions({ kind: "interview", tools: {} })).toBe(false);
		expect(askedQuestions({ ...interview(1, 0), kind: "holding" })).toBe(false);
	});

	it("fails the follow-up round only when the edit demonstrably did not land", () => {
		const finished = { outcome: "finished" };
		const audited = { success: true };
		expect(followUpFailure(finished, audited, false, "5.20")).toBe(
			`No public page's visible text contains "5.20" after the follow-up edit.`,
		);
		// Already on the site before the edit, or no expected text: proves nothing.
		expect(followUpFailure(finished, audited, null)).toBeUndefined();
		expect(followUpFailure(finished, audited, undefined)).toBeUndefined();
		expect(followUpFailure(finished, audited, true)).toBeUndefined();
		expect(followUpFailure({ outcome: "error", error: "boom" }, audited, true)).toBe(
			"The follow-up turn ended as error: boom.",
		);
		expect(followUpFailure(finished, { success: false }, true)).toBe(
			"The public site audit failed after the follow-up.",
		);
		expect(followUpFailure(finished, { success: true, storyMoved: false }, true)).toBe(
			"The story must be absent from Waterways and present in Brookwatch after the follow-up edit.",
		);
	});

	it("requires the exact moved story link in the section main content", () => {
		const empty =
			'<main><h1>Brookwatch</h1><a href="/stories/other-story">Other story</a></main><footer><a href="/stories/canal-wildlife">Canal Wildlife</a></footer>';
		expect(hasStoryLinkOnSection(empty, "/stories/canal-wildlife")).toBe(false);
		expect(
			hasStoryLinkOnSection(
				'<main><h1>Brookwatch</h1><a href="/stories/canal-wildlife">Read story</a></main>',
				"/stories/canal-wildlife",
			),
		).toBe(true);
		const move = briefs.editorial.followUpStoryMove;
		expect(storyMovedBetweenSections({ [move.from]: false, [move.to]: true }, move)).toBe(true);
		expect(storyMovedBetweenSections({ [move.from]: true, [move.to]: true }, move)).toBe(false);
		expect(storyMovedBetweenSections({ [move.from]: false }, move)).toBe(false);
	});
});
