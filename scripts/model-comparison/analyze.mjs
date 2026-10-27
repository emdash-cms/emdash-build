// Turns a run's trials and blind verdicts into report.md, summary.json and trials.csv.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	friedman,
	friedmanExactP,
	holm,
	mean,
	median,
	quantile,
	spearman,
	wilcoxonSignedRank,
} from "./stats.mjs";

const { values } = parseArgs({ options: { run: { type: "string" } } });
if (!values.run) throw new Error("Usage: analyze.mjs --run <name>");
const root = join(".model-comparison", values.run);

// USD per million tokens at standard list prices. Luna's come from third-party
// price trackers (no official page was found); gateway billing may differ.
// A request whose prompt passes `longContext.over` tokens pays its rates.
const PRICES = {
	"openai/gpt-6-luna": {
		input: 0.1,
		cachedInput: 0.01,
		cacheWrite: 0.125,
		output: 0.5,
		longContext: { over: 272_000, input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 },
	},
	"anthropic/claude-haiku-5.5": {
		input: 0.1,
		cachedInput: 0.01,
		cacheWrite: 0.125,
		output: 0.5,
		longContext: { over: 100_000, input: 0.5, cachedInput: 0.05, cacheWrite: 0.625, output: 2.5 },
	},
	"anthropic/claude-opus-5.5": { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
	// developers.openai.com/api/docs/models/gpt-6.1-terra, Oct 26, 2026.
	"openai/gpt-6.1-terra": {
		input: 1,
		cachedInput: 0.05,
		cacheWrite: 1.25,
		output: 5,
		longContext: { over: 272_000, input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 7.5 },
	},
	"openai/gpt-6.1-sol": {
		input: 2,
		cachedInput: 0.1,
		cacheWrite: 2.5,
		output: 10,
		longContext: { over: 272_000, input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 },
	},
};

const design = JSON.parse(readFileSync(join(root, "design.json"), "utf8"));
const models = design.models;
const allTrials = readFileSync(join(root, "trials.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const excludedTrials = allTrials.filter((trial) => trial.status === "excluded");

// A block reran when amd64 emulation broke under it. A rerun is justified only
// if a build in the superseded attempt crashed (its turn ended in an error) or
// a trial was excluded (excluded trials always rerun); otherwise the first
// attempt stands and the rerun must be undone.
const supersededFile = join(root, "superseded.jsonl");
const reruns = [
	...Map.groupBy(
		existsSync(supersededFile)
			? readFileSync(supersededFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [],
		(trial) => `${trial.block}@${trial.supersededAt}`,
	).values(),
].map((attempt) => ({
	block: attempt[0].block,
	because: attempt[0].supersededBecause,
	excluded: attempt.filter((trial) => trial.status === "excluded").map((trial) => trial.model),
	crashed: attempt
		.filter((trial) =>
			(trial.turns ?? []).some((turn) => turn.kind === "initial-build" && turn.outcome === "error"),
		)
		.map((trial) => trial.model),
}));
const unjustifiedReruns = reruns.filter(
	(rerun) =>
		rerun.because !== "requested" && rerun.crashed.length === 0 && rerun.excluded.length === 0,
);
const trials = allTrials.filter((trial) => trial.status !== "excluded");

const sumTokens = (a = {}, b = {}) =>
	Object.fromEntries(
		["input", "cachedInput", "output", "reasoning"].map((key) => [
			key,
			(a[key] ?? 0) + (b[key] ?? 0),
		]),
	);

/**
 * Per-step prompt sizes are not in the trial record, so cost is a range. Low:
 * standard rates, uncached input at the plain input price. High: uncached input
 * at the cache-write price, and long-context rates for every request if any
 * prompt passed the threshold.
 */
function costRange(model, tokens, peakInputTokens) {
	const price = PRICES[model];
	if (!price) return { low: NaN, high: NaN };
	const uncached = tokens.input - tokens.cachedInput;
	const at = (rates, uncachedRate) =>
		(uncached * uncachedRate +
			tokens.cachedInput * rates.cachedInput +
			tokens.output * rates.output) /
		1e6;
	const long =
		price.longContext && peakInputTokens > price.longContext.over ? price.longContext : price;
	return { low: at(price, price.input), high: at(long, long.cacheWrite) };
}

/**
 * Tokens by the model that spent them. Turns record their steps by model, and
 * sub-calls (entry bodies, helpers) by model when they name one; otherwise a
 * sub-call ran on the build model. Older records have one model per trial.
 */
const buildModelOf = (choice) => choice.split(":")[0].split("+")[0].split(">").pop();

function tokensByModel(trial) {
	const build = buildModelOf(trial.model);
	const byModel = {};
	const add = (model, tokens) => (byModel[model] = sumTokens(byModel[model], tokens));
	for (const turn of trial.turns ?? []) {
		if (!turn.byModel) continue;
		for (const [model, entry] of Object.entries(turn.byModel)) add(model, entry.tokens);
		const named = turn.subcalls?.byModel ?? {};
		for (const [model, tokens] of Object.entries(named)) add(model, tokens);
		const unnamed = Object.values(named).reduce(
			(rest, tokens) =>
				Object.fromEntries(
					Object.entries(rest).map(([key, value]) => [key, value - (tokens[key] ?? 0)]),
				),
			sumTokens(turn.subcalls?.tokens),
		);
		if (Object.values(unnamed).some((value) => value > 0)) add(build, unnamed);
	}
	if (Object.keys(byModel).length === 0) {
		add(trial.model, sumTokens(trial.totals?.tokens, trial.totals?.subcallTokens));
	}
	return byModel;
}

function trialCost(trial, peakInputTokens) {
	// Fast mode bills the build model's requests at twice its standard rates.
	const fast = trial.model.split(":").slice(1).includes("fast") ? buildModelOf(trial.model) : null;
	const parts = Object.entries(tokensByModel(trial)).map(([model, tokens]) => {
		const { low, high } = costRange(model, tokens, peakInputTokens);
		const rate = model === fast ? 2 : 1;
		return { model, low: low * rate, high: high * rate };
	});
	return {
		low: parts.reduce((sum, part) => sum + part.low, 0),
		high: parts.reduce((sum, part) => sum + part.high, 0),
		byModel: Object.fromEntries(parts.map((part) => [part.model, part.low])),
	};
}

/** Minutes each model ran steps for, over the trial's first-build turns. */
function buildMsByModel(trial) {
	const byModel = {};
	for (const turn of trial.turns ?? []) {
		if (turn.kind !== "initial-build" || !turn.byModel) continue;
		for (const [model, entry] of Object.entries(turn.byModel)) {
			byModel[model] = (byModel[model] ?? 0) + entry.ms;
		}
	}
	return byModel;
}

const rows = trials.map((trial) => {
	const turns = trial.turns ?? [];
	const ofKind = (kind) => turns.filter((turn) => turn.kind === kind);
	const tokens = sumTokens(trial.totals?.tokens, trial.totals?.subcallTokens);
	const shots = (trial.shots ?? []).filter((page) => !page.error);
	const phone = shots.find((page) => page.path === "/" && page.viewport === "mobile");
	const peakInputTokens = Math.max(0, ...turns.map((turn) => turn.peakInputTokens ?? 0));
	const cost = trialCost(trial, peakInputTokens);
	return {
		trialId: trial.trialId,
		block: trial.block,
		rep: trial.rep,
		brief: trial.brief,
		model: trial.model,
		delivered: trial.status === "delivered",
		reason: trial.reason,
		servedModels: trial.servedModels ?? [],
		qualityValid: trial.initialBuildBenchmark?.qualityValid === true,
		publicAuditOk: trial.publicSiteAudit?.success === true,
		askedQuestions: trial.questionnaireObserved === true,
		interviewMs: ofKind("interview").reduce((sum, turn) => sum + turn.wallMs, 0),
		buildMs: ofKind("initial-build").reduce((sum, turn) => sum + turn.wallMs, 0),
		buildTurns: ofKind("initial-build").length,
		toCompleteMs: trial.elapsedMs?.complete ?? null,
		modelWaitMs: turns.reduce((sum, turn) => sum + (turn.modelWaitMs ?? 0), 0),
		toolMs: trial.totals?.toolMs ?? 0,
		steps: trial.totals?.steps ?? 0,
		stepCapReached: turns.some((turn) => turn.stepCapReached),
		tokens,
		peakInputTokens,
		costLowUsd: cost.low,
		costHighUsd: cost.high,
		costLowUsdByModel: cost.byModel,
		delegateCalls: turns.reduce((sum, turn) => sum + (turn.tools?.delegate?.calls ?? 0), 0),
		buildMsByModel: buildMsByModel(trial),
		pages: shots.filter((page) => page.viewport === "desktop").length,
		brokenImages: shots.reduce((sum, page) => sum + (page.brokenImages ?? 0), 0),
		mobileOverflowPx: phone?.horizontalOverflowPx ?? null,
	};
});
const rowById = new Map(rows.map((row) => [row.trialId, row]));

// Verdicts: per trial, the mean of every model judge and order; per judge, the mean of its orders.
const verdicts = [];
const judgingDir = join(root, "judging");
if (existsSync(judgingDir)) {
	for (const judgeDir of readdirSync(judgingDir)) {
		for (const file of readdirSync(join(judgingDir, judgeDir))) {
			const record = JSON.parse(readFileSync(join(judgingDir, judgeDir, file), "utf8"));
			if (record.error || !record.verdict?.sites) continue;
			for (const [label, trialId] of Object.entries(record.labels)) {
				const scores = record.verdict.sites[label];
				if (!scores || !rowById.has(trialId)) continue;
				verdicts.push({
					judge: record.judge,
					human: record.judge === "human",
					block: record.block,
					order: record.order,
					position: Number(label.replace(/\D/g, "")),
					trialId,
					model: rowById.get(trialId).model,
					scores,
				});
			}
		}
	}
}
const criteria = [
	"overall",
	"layout",
	"typography",
	"colorImagery",
	"briefFidelity",
	"polish",
	"mobile",
];
const judges = [...new Set(verdicts.map((v) => v.judge))].sort();
const modelJudges = judges.filter((judge) => judge !== "human");
for (const row of rows) {
	const mine = verdicts.filter((v) => v.trialId === row.trialId);
	// The primary score is the model judges', and only when every model judge
	// scored the site, so no site's mean rests on a different set of judges.
	// A human's overall-only verdict is reported beside it.
	const judged = mine.filter((v) => !v.human);
	const complete = modelJudges.every((judge) => judged.some((v) => v.judge === judge));
	row.scores = Object.fromEntries(
		criteria.map((key) => {
			const list = judged.map((v) => Number(v.scores[key])).filter(Number.isFinite);
			return [key, complete && list.length ? mean(list) : null];
		}),
	);
	row.byJudge = Object.fromEntries(
		judges.map((judge) => {
			const list = mine.filter((v) => v.judge === judge).map((v) => Number(v.scores.overall));
			return [judge, list.length ? mean(list) : null];
		}),
	);
}

// ---- block tests ----
const byModel = Map.groupBy(rows, (row) => row.model);
const delivered = (model) => (byModel.get(model) ?? []).filter((row) => row.delivered);
const blocks = [...Map.groupBy(rows, (row) => row.block).entries()]
	.map(([block, members]) => ({ block, members: new Map(members.map((row) => [row.model, row])) }))
	.sort((a, b) => a.block - b.block);

/**
 * A failed build ranks worst in its block. A block is left out when a model
 * has no trial in it (excluded and not yet rerun) or a delivered site has no
 * value for the measure (a capture or judge gap), so harness gaps never count
 * against a model.
 */
function blockTest(measure, { higherIsBetter }) {
	const worst = higherIsBetter ? -Infinity : Infinity;
	const matrix = [];
	let skipped = 0;
	for (const { members } of blocks) {
		const row = models.map((model) => {
			const trial = members.get(model);
			if (!trial) return null;
			if (!trial.delivered) return worst;
			const value = measure(trial);
			return value === null || value === undefined || Number.isNaN(value) ? null : value;
		});
		if (row.some((value) => value === null) || !row.some(Number.isFinite)) skipped += 1;
		else matrix.push(row);
	}
	const oriented = matrix.map((row) => row.map((v) => (higherIsBetter ? v : -v)));
	const test =
		matrix.length > 1 ? { ...friedman(oriented), exactP: friedmanExactP(oriented) } : null;
	const pairs = [];
	for (let i = 0; i < models.length; i += 1) {
		for (let j = i + 1; j < models.length; j += 1) {
			const raw = matrix.map((row) => row[i] - row[j]).filter((d) => !Number.isNaN(d));
			const observed = raw.filter(Number.isFinite);
			// A block one side failed counts as the largest difference, in the other side's favour.
			const largest = Math.max(0, ...observed.map(Math.abs)) + 1;
			const differences = raw.map((d) => (Number.isFinite(d) ? d : Math.sign(d) * largest));
			pairs.push({ a: models[i], b: models[j], observed, ...wilcoxonSignedRank(differences) });
		}
	}
	holm(pairs.map((pair) => pair.p)).forEach((p, index) => (pairs[index].pHolm = p));
	const wins = Object.fromEntries(models.map((model) => [model, 0]));
	for (const row of matrix) {
		const best = higherIsBetter ? Math.max(...row) : Math.min(...row);
		const winners = models.filter((_, j) => row[j] === best);
		for (const model of winners) wins[model] += 1 / winners.length;
	}
	return { blocks: matrix.length, skipped, test, pairs, wins };
}

const timeTest = blockTest((row) => row.buildMs, { higherIsBetter: false });
const completeTest = blockTest((row) => row.toCompleteMs, { higherIsBetter: false });
const costTest = blockTest((row) => (row.costLowUsd + row.costHighUsd) / 2, {
	higherIsBetter: false,
});
const qualityTest = modelJudges.length
	? blockTest((row) => row.scores.overall, { higherIsBetter: true })
	: null;
const judgeTests = Object.fromEntries(
	judges.map((judge) => [judge, blockTest((row) => row.byJudge[judge], { higherIsBetter: true })]),
);

// ---- judge reliability ----
const judgeAgreement = [];
for (let i = 0; i < judges.length; i += 1) {
	for (let j = i + 1; j < judges.length; j += 1) {
		const both = rows.filter(
			(row) => row.byJudge[judges[i]] !== null && row.byJudge[judges[j]] !== null,
		);
		if (both.length > 2) {
			judgeAgreement.push({
				a: judges[i],
				b: judges[j],
				n: both.length,
				rho: spearman(
					both.map((row) => row.byJudge[judges[i]]),
					both.map((row) => row.byJudge[judges[j]]),
				),
			});
		}
	}
}
const orderConsistency = modelJudges.map((judge) => {
	const own = verdicts.filter((v) => v.judge === judge);
	const first = new Map(
		own.filter((v) => v.order === 0).map((v) => [v.trialId, Number(v.scores.overall)]),
	);
	const second = new Map(
		own.filter((v) => v.order === 1).map((v) => [v.trialId, Number(v.scores.overall)]),
	);
	const both = [...first.keys()].filter((trialId) => second.has(trialId));
	return {
		judge,
		n: both.length,
		rho:
			both.length > 2
				? spearman(
						both.map((trialId) => first.get(trialId)),
						both.map((trialId) => second.get(trialId)),
					)
				: NaN,
	};
});
const modelVerdicts = verdicts.filter((v) => !v.human);
const positions = [...new Set(modelVerdicts.map((v) => v.position))].sort();

// ---- report helpers ----
const fmt = (value, digits = 1) =>
	value === null || value === undefined || Number.isNaN(value) ? "n/a" : value.toFixed(digits);
const fmtP = (p) =>
	p === undefined || Number.isNaN(p) ? "n/a" : p < 0.0001 ? "< 0.0001" : p.toFixed(4);
const minutes = (ms) => ms / 60_000;
const spread = (list, scale = (x) => x, digits = 1) => {
	if (list.length === 0) return "n/a";
	const scaled = list.map(scale);
	return `${fmt(median(scaled), digits)} [${fmt(quantile(scaled, 0.25), digits)}–${fmt(quantile(scaled, 0.75), digits)}] (${fmt(Math.min(...scaled), digits)}–${fmt(Math.max(...scaled), digits)})`;
};
const table = (header, body) =>
	[
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...body.map((r) => `| ${r.join(" | ")} |`),
	].join("\n");
const short = (model) =>
	model
		.split("+")
		.map((driver) =>
			driver
				.split(">")
				.map((id) => id.split("/").pop())
				.join(" → "),
		)
		.join(" + ");

function pairTable(result, unit, scale) {
	return table(
		[
			"Pair",
			"Blocks",
			"Median difference where both delivered (A − B)",
			"Exact Wilcoxon p",
			"Holm p",
		],
		result.pairs.map((pair) => [
			`${short(pair.a)} − ${short(pair.b)}`,
			String(pair.n),
			pair.observed.length
				? `${fmt(median(pair.observed.map(scale)), 2)} ${unit} (n = ${pair.observed.length})`
				: "n/a",
			fmtP(pair.p),
			fmtP(pair.pHolm),
		]),
	);
}
const friedmanLine = (result) =>
	result.test
		? `Friedman χ²(${result.test.k - 1}) = ${fmt(result.test.statistic, 2)}, exact p ${result.test.exactP < 0.0001 ? "" : "= "}${fmtP(result.test.exactP)}, Kendall's W = ${fmt(result.test.kendallW, 2)}, over ${result.blocks} blocks${result.skipped ? ` (${result.skipped} left out for missing data)` : ""}. Block wins: ${models.map((m) => `${short(m)} ${fmt(result.wins[m], 1)}`).join(", ")}.`
		: "Not enough complete blocks for a test.";

// ---- report ----
const lines = [];
lines.push(`# Builder model comparison: ${values.run}`, "");
lines.push(
	`${rows.length} scored trials over ${design.briefs.length} briefs × ${design.reps} repetitions × ${models.length} models, run as a randomized complete block design (every model builds the same brief at the same time). Commit \`${design.commit.slice(0, 10)}\`${design.dirty ? " plus the changes in `design.diff`" : ""}, seed ${design.seed}.`,
	"",
	"Time and design quality are co-primary measures, each tested at α = 0.025 (Bonferroni over the two). Pairwise p-values are Holm-adjusted within each measure.",
	"",
);
lines.push("## Reliability", "");
lines.push(
	table(
		[
			"Model",
			"Scored trials",
			"Delivered",
			"Quality check passed",
			"Public audit passed",
			"Hit the step cap",
			"Asked questions",
		],
		models.map((model) => {
			const list = byModel.get(model) ?? [];
			const count = (predicate) => `${list.filter(predicate).length}/${list.length}`;
			return [
				short(model),
				String(list.length),
				count((r) => r.delivered),
				count((r) => r.qualityValid),
				count((r) => r.publicAuditOk),
				count((r) => r.stepCapReached),
				count((r) => r.askedQuestions),
			];
		}),
	),
	"",
);
const failures = rows.filter((row) => !row.delivered);
if (failures.length) {
	lines.push(
		"Failed builds:",
		"",
		...failures.map((row) => `- \`${row.trialId}\`: ${row.reason}`),
		"",
	);
}
if (excludedTrials.length) {
	lines.push(
		"Excluded and not yet rerun (not scored):",
		"",
		...excludedTrials.map((trial) => `- \`${trial.trialId}\`: ${trial.excludedBecause}`),
		"",
	);
}
if (reruns.length) {
	lines.push(
		"Block reruns:",
		"",
		...reruns.map(
			(rerun) =>
				`- block ${rerun.block}: ${rerun.because}; crashed builds: ${rerun.crashed.map(short).join(", ") || "none"}; excluded trials: ${rerun.excluded.map(short).join(", ") || "none"}${unjustifiedReruns.includes(rerun) ? " (UNJUSTIFIED: the first attempt should stand)" : ""}`,
		),
		"",
	);
}
lines.push(
	`Models the gateway reported serving: ${models.map((m) => `${short(m)} → ${[...new Set(delivered(m).flatMap((r) => r.servedModels))].join(", ") || "n/a"}`).join("; ")}.`,
	"",
);
lines.push("## Time", "", "Median [IQR] (min–max), minutes, delivered trials only.", "");
lines.push(
	table(
		[
			"Model",
			"Build turn",
			"Container start to finished site",
			"Interview turn",
			"Model wait (to first output)",
			"Tool time",
			"Steps",
		],
		models.map((model) => {
			const list = delivered(model);
			return [
				short(model),
				spread(
					list.map((r) => r.buildMs),
					minutes,
				),
				spread(
					list.filter((r) => r.toCompleteMs !== null).map((r) => r.toCompleteMs),
					minutes,
				),
				spread(
					list.map((r) => r.interviewMs),
					minutes,
					2,
				),
				spread(
					list.map((r) => r.modelWaitMs),
					minutes,
				),
				spread(
					list.map((r) => r.toolMs),
					minutes,
				),
				spread(
					list.map((r) => r.steps),
					(x) => x,
					0,
				),
			];
		}),
	),
	"",
);
lines.push(`Build turn: ${friedmanLine(timeTest)}`, "", pairTable(timeTest, "min", minutes), "");
lines.push(`Container start to finished site: ${friedmanLine(completeTest)}`, "");
lines.push(
	"## Tokens and cost",
	"",
	"Median per delivered trial, builder turns plus entry-body sub-calls. Cost is a low–high range at list prices (see `analyze.mjs`).",
	"",
);
lines.push(
	table(
		[
			"Model",
			"Input tokens",
			"Cached share",
			"Output tokens",
			"Reasoning tokens",
			"Peak prompt",
			"Cost low (USD)",
			"Cost high (USD)",
		],
		models.map((model) => {
			const list = delivered(model);
			return [
				short(model),
				fmt(median(list.map((r) => r.tokens.input)), 0),
				`${fmt(100 * median(list.map((r) => r.tokens.cachedInput / Math.max(1, r.tokens.input))), 0)}%`,
				fmt(median(list.map((r) => r.tokens.output)), 0),
				fmt(median(list.map((r) => r.tokens.reasoning)), 0),
				fmt(median(list.map((r) => r.peakInputTokens)), 0),
				spread(
					list.map((r) => r.costLowUsd),
					(x) => x,
					3,
				),
				spread(
					list.map((r) => r.costHighUsd),
					(x) => x,
					3,
				),
			];
		}),
	),
	"",
);
lines.push(`Cost (midpoint of the range): ${friedmanLine(costTest)}`, "");
if (qualityTest) {
	lines.push("## Design quality (blind judges)", "");
	lines.push(
		`Model judges: ${modelJudges.map((j) => `\`${j}\``).join(", ")}. Every block was judged once per site position. Scores are 1–10, the mean over model judges and orders. A failed build counts as the worst site in its block.`,
		"",
	);
	lines.push(
		table(
			["Model", ...criteria],
			models.map((model) => {
				const list = delivered(model).filter((r) => r.scores.overall !== null);
				return [
					short(model),
					...criteria.map((key) => fmt(mean(list.map((r) => r.scores[key])), 2)),
				];
			}),
		),
		"",
	);
	lines.push(
		`Overall: ${friedmanLine(qualityTest)}`,
		"",
		pairTable(qualityTest, "points", (x) => x),
		"",
	);
	lines.push(
		"### Per judge",
		"",
		"Mean overall by candidate model, and each judge's own block test. A judge that favours its own model family shows here. The Google judge shares a family with no candidate.",
		"",
	);
	lines.push(
		table(
			["Judge", ...models.map(short), "Exact Friedman p", "Block wins"],
			judges.map((judge) => [
				judge,
				...models.map((model) => {
					const list = delivered(model)
						.map((r) => r.byJudge[judge])
						.filter((v) => v !== null);
					return fmt(list.length ? mean(list) : NaN, 2);
				}),
				fmtP(judgeTests[judge].test?.exactP),
				models.map((m) => `${short(m)} ${fmt(judgeTests[judge].wins[m], 1)}`).join(", "),
			]),
		),
		"",
	);
	lines.push(
		`Agreement between judges (Spearman ρ on per-site overall): ${judgeAgreement.map((a) => `${short(a.a)}~${short(a.b)} ρ = ${fmt(a.rho, 2)} (n = ${a.n})`).join("; ") || "n/a"}.`,
		"",
		`Same judge, first two label orders (Spearman ρ): ${orderConsistency.map((o) => `${short(o.judge)} ρ = ${fmt(o.rho, 2)} (n = ${o.n})`).join("; ")}.`,
		"",
		`Mean overall by label position, model judges: ${positions.map((p) => `Site ${p} ${fmt(mean(modelVerdicts.filter((v) => v.position === p).map((v) => Number(v.scores.overall))), 2)}`).join(", ")}.`,
		"",
	);
}
lines.push("## Objective page checks", "");
lines.push(
	table(
		[
			"Model",
			"Desktop pages captured (median)",
			"Broken images (total)",
			"Trials with mobile horizontal overflow",
		],
		models.map((model) => {
			const list = delivered(model);
			return [
				short(model),
				fmt(median(list.map((r) => r.pages)), 0),
				String(list.reduce((s, r) => s + r.brokenImages, 0)),
				`${list.filter((r) => (r.mobileOverflowPx ?? 0) > 1).length}/${list.length}`,
			];
		}),
	),
	"",
);
lines.push("## Trials", "");
lines.push(
	table(
		["Trial", "Delivered", "Build (min)", "To finished (min)", "Steps", "Cost (USD)", "Overall"],
		[...rows]
			.sort((a, b) => a.block - b.block || a.model.localeCompare(b.model))
			.map((r) => [
				`\`${r.trialId}\``,
				r.delivered ? "yes" : "no",
				fmt(minutes(r.buildMs)),
				r.toCompleteMs === null ? "n/a" : fmt(minutes(r.toCompleteMs)),
				String(r.steps),
				`${fmt(r.costLowUsd, 3)}–${fmt(r.costHighUsd, 3)}`,
				fmt(r.scores.overall, 2),
			]),
	),
	"",
);

writeFileSync(join(root, "report.md"), lines.join("\n"));
writeFileSync(
	join(root, "summary.json"),
	JSON.stringify(
		{
			design,
			rows,
			excludedTrials: excludedTrials.map((trial) => trial.trialId),
			reruns,
			unjustifiedReruns,
			timeTest,
			completeTest,
			costTest,
			qualityTest,
			judgeTests,
			judgeAgreement,
			orderConsistency,
		},
		null,
		2,
	),
);
const csvColumns = [
	"trialId",
	"block",
	"rep",
	"brief",
	"model",
	"delivered",
	"qualityValid",
	"askedQuestions",
	"buildMs",
	"toCompleteMs",
	"interviewMs",
	"modelWaitMs",
	"toolMs",
	"steps",
	"costLowUsd",
	"costHighUsd",
];
writeFileSync(
	join(root, "trials.csv"),
	[
		[
			...csvColumns,
			"inputTokens",
			"cachedInputTokens",
			"outputTokens",
			"reasoningTokens",
			...criteria,
		].join(","),
		...rows.map((r) =>
			[
				...csvColumns.map((c) => r[c]),
				r.tokens.input,
				r.tokens.cachedInput,
				r.tokens.output,
				r.tokens.reasoning,
				...criteria.map((k) => r.scores[k] ?? ""),
			].join(","),
		),
	].join("\n"),
);
console.log(`wrote ${join(root, "report.md")}`);
