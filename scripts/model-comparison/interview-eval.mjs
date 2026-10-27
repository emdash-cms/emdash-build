// Runs the first-turn interview on a fixed set of briefs and scores the questions
// each model asks: how many, how many can be answered by picking, and how many
// ask the owner to type a fact such as opening hours or an address. The request
// goes through the worker's own prompt, ask_questions tool and model code.
// Run: node --import ./scripts/model-comparison/ts-resolve.mjs scripts/model-comparison/interview-eval.mjs --out <dir> [--models a,b] [--reps 2] [--from <results.json>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hasToolCall, stepCountIs, streamText } from "ai";
import {
	BUILDER_REASONING_EFFORT,
	builderProviderOptions,
	createBuilderModel,
	parseBuilderLineup,
} from "../../src/worker/model.ts";
import { buildInterviewPrompt } from "../../src/worker/prompts.ts";
import {
	createAskQuestionsTool,
	FIRST_INTERVIEW_TOOL_CHOICE,
} from "../../src/worker/questionnaire.ts";
import { parseClarifyingQuestions } from "../../src/shared/questionnaire.ts";
import { devVars } from "./dev-vars.mjs";

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.flatMap((arg, i, all) => (arg.startsWith("--") ? [[arg.slice(2), all[i + 1]]] : [])),
);
const env = { ...devVars(), ...process.env };
const models = (args.models ?? "openai/gpt-6.1-terra:all-low,openai/gpt-6-luna").split(",");
const reps = Number(args.reps ?? 2);
const out = args.out ?? ".model-comparison/interview/latest";

export const BRIEFS = {
	"bakery-editorial":
		"A warm editorial website for an artisanal bakery called Crust and Crumb, with a seasonal menu, opening hours, and the story behind the bakery.",
	"bakery-onepage":
		"Build a one-page site for Crumb and Crust, a small Bristol sourdough bakery, with the daily menu, opening hours and address.",
	photographer:
		"A cinematic photography portfolio for an Iceland landscape photographer, with a dark gallery-led design and projects organised by location.",
	yoga: "a website for my yoga studio",
	grooming: "I run a small dog grooming business, need a site",
	"food-blog": "Personal blog about cooking Vietnamese food at home",
	"budget-app": "Landing page for a budgeting app for students",
	"stargazing-detailed":
		"Build a concise marketing site for Acme Observatory, a community stargazing club in Bristol. Use a dark navy palette, a bright amber accent, an events section, and a friendly call to action to join the next observing night.\n\nUse a welcoming, practical science-club direction with clear event discovery. Include upcoming observing nights grouped by date, a short club introduction, membership information, and a contact page. Keep any unsupplied venue or contact details as clearly editable placeholders rather than facts.",
};

const FACT =
	/\b(hours|opening times?|open(ing)? (days|times)|address|located|location of|where is|phone|e-?mail|prices?|cost|dates?|start times?|when (are|is|do|does)|contact details|fees?)\b/i;

function optionLabel(option) {
	return typeof option === "string" ? option : option?.label;
}

export function scoreQuestion(question) {
	const options = question.options ?? [];
	const pick = options.length > 0;
	return {
		pick,
		freeText: !pick,
		fact: FACT.test(question.question),
		name: !pick && /\b(name|called)\b/i.test(question.question),
		described: pick && options.every((option) => typeof option === "object" && option.description),
		recommended: options.some((option) => typeof option === "object" && option.recommended),
		why: Boolean(question.why),
	};
}

async function interview(modelId, brief) {
	const lineup = parseBuilderLineup(modelId);
	const started = Date.now();
	const result = streamText({
		model: createBuilderModel(env, { modelId: lineup.build }),
		system: buildInterviewPrompt(),
		messages: [{ role: "user", content: brief }],
		tools: { ask_questions: createAskQuestionsTool() },
		toolChoice: FIRST_INTERVIEW_TOOL_CHOICE,
		stopWhen: [hasToolCall("ask_questions"), stepCountIs(2)],
		maxRetries: 3,
		maxOutputTokens: 8192,
		providerOptions: builderProviderOptions(lineup.effort ?? BUILDER_REASONING_EFFORT.interview),
	});
	const steps = await result.steps;
	// A call that failed the schema shows no form in the app, so it asked nothing.
	const call = steps
		.flatMap((step) => step.toolCalls)
		.find((c) => c.toolName === "ask_questions" && !c.invalid);
	const usage = await result.totalUsage;
	return {
		ms: Date.now() - started,
		outputTokens: usage.outputTokens,
		reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
		text: await result.text,
		raw: call?.input,
		questions: call ? parseClarifyingQuestions(call.input) : [],
	};
}

const jobs = models.flatMap((model) =>
	Object.entries(BRIEFS).flatMap(([brief, text]) =>
		Array.from({ length: reps }, (_, rep) => ({ model, brief, text, rep })),
	),
);
const results = args.from
	? JSON.parse(readFileSync(args.from, "utf8")).map((r) => {
			const questions = r.raw ? parseClarifyingQuestions(r.raw) : [];
			return { ...r, questions, scores: questions.map(scoreQuestion) };
		})
	: [];
let next = args.from ? jobs.length : 0;
async function worker() {
	while (next < jobs.length) {
		const job = jobs[next++];
		try {
			const run = await interview(job.model, job.text);
			results.push({ ...job, ...run, scores: run.questions.map(scoreQuestion) });
			console.error(
				`ok ${job.model} ${job.brief} #${job.rep} ${run.questions.length}q ${run.ms}ms`,
			);
		} catch (error) {
			results.push({ ...job, error: String(error?.message ?? error) });
			console.error(`error ${job.model} ${job.brief} #${job.rep} ${error?.message ?? error}`);
		}
	}
}
await Promise.all(Array.from({ length: Number(args.concurrency ?? 4) }, worker));

const rate = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
const lines = [
	"| Model | Interviews | Asked | Questions | Pick an option | Type a fact | Type a name | Type other | Options described | Recommended | Why shown |",
	"|---|---|---|---|---|---|---|---|---|---|---|",
];
for (const model of models) {
	const runs = results.filter((r) => r.model === model && !r.error);
	const scores = runs.flatMap((r) => r.scores);
	const count = (key) => scores.filter((s) => s[key]).length;
	const typedFact = scores.filter((s) => s.freeText && s.fact).length;
	const typedName = count("name");
	const typedOther = scores.filter((s) => s.freeText && !s.fact && !s.name).length;
	lines.push(
		`| ${model} | ${runs.length} | ${runs.filter((r) => r.questions.length).length} | ${scores.length} | ${rate(count("pick"), scores.length)} | ${typedFact} | ${typedName} | ${typedOther} | ${rate(count("described"), count("pick"))} | ${rate(count("recommended"), count("pick"))} | ${rate(count("why"), scores.length)} |`,
	);
}
const detail = results
	.sort((a, b) => a.brief.localeCompare(b.brief) || a.model.localeCompare(b.model) || a.rep - b.rep)
	.map((r) => {
		const head = `### ${r.brief} · ${r.model} · #${r.rep}`;
		if (r.error) return `${head}\n\nError: ${r.error}`;
		const qs = r.questions.map((q, i) => {
			const opts = (q.options ?? []).map((o) => {
				const label = optionLabel(o);
				const desc = typeof o === "object" && o.description ? ` · ${o.description}` : "";
				return `   - ${label}${typeof o === "object" && o.recommended ? " (recommended)" : ""}${desc}`;
			});
			const flags = Object.entries(r.scores[i])
				.filter(([, v]) => v)
				.map(([k]) => k)
				.join(", ");
			return [`${i + 1}. ${q.question} [${flags}]`, q.why ? `   _${q.why}_` : "", ...opts]
				.filter(Boolean)
				.join("\n");
		});
		return [head, "", `> ${r.text.trim().replace(/\n+/g, " ")}`, "", ...qs].join("\n");
	});

mkdirSync(out, { recursive: true });
writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
writeFileSync(`${out}/report.md`, [`# Interview eval`, "", ...lines, "", ...detail].join("\n"));
console.log(lines.join("\n"));
console.log(`\n${out}/report.md`);
