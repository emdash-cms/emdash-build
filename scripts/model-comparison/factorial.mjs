// Analyzes a 2×2 factorial run: four arms that cross two factors, every arm
// building each block. Per block it forms the two main-effect contrasts, their
// interaction, and the four simple effects, then gives each an exact Wilcoxon
// signed-rank p and a Hodges–Lehmann estimate with an exact confidence interval.
// Also checks the manipulation: each arm's requested effort per step (from
// .model-comparison/dev.log) and its build prompt size.
// Run after analyze.mjs: node scripts/model-comparison/factorial.mjs --run terra-luna \
//   --cells <A0B0>,<A0B1>,<A1B0>,<A1B1> --factors model,prompt --levels Luna,Terra/standard,batched
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { holm, mean, quantile, wilcoxonSignedRank } from "./stats.mjs";

const { values } = parseArgs({
	options: {
		run: { type: "string" },
		cells: { type: "string" },
		factors: { type: "string", default: "model,prompt" },
		levels: { type: "string", default: "Luna,Terra/standard,batched" },
		// measure:effect pairs, Holm-adjusted together.
		primary: { type: "string", default: "overall:model,buildMin:model" },
	},
});
if (!values.run || !values.cells) {
	throw new Error("Usage: factorial.mjs --run <name> --cells <A0B0>,<A0B1>,<A1B0>,<A1B1>");
}
const root = join(".model-comparison", values.run);
const cells = values.cells.split(",");
if (cells.length !== 4) throw new Error("--cells takes four arms: A0B0, A0B1, A1B0, A1B1.");
const [factorA, factorB] = values.factors.split(",");
const [levelsA, levelsB] = values.levels.split("/").map((pair) => pair.split(","));

const summary = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
const trials = readFileSync(join(root, "trials.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));

// The measures, each read from a summary row. Lower is better for time, steps and cost.
const MEASURES = {
	overall: { label: "Design score, overall (1–10)", read: (row) => row.scores?.overall },
	briefFidelity: { label: "Brief fidelity (1–10)", read: (row) => row.scores?.briefFidelity },
	layout: { label: "Layout (1–10)", read: (row) => row.scores?.layout },
	typography: { label: "Typography (1–10)", read: (row) => row.scores?.typography },
	colorImagery: { label: "Colour and imagery (1–10)", read: (row) => row.scores?.colorImagery },
	polish: { label: "Polish (1–10)", read: (row) => row.scores?.polish },
	mobile: { label: "Mobile (1–10)", read: (row) => row.scores?.mobile },
	buildMin: { label: "First build, minutes", read: (row) => row.buildMs / 60000 },
	modelWaitMin: {
		label: "Waiting for first output, minutes",
		read: (row) => row.modelWaitMs / 60000,
	},
	toolMin: { label: "Tool time, minutes", read: (row) => row.toolMs / 60000 },
	steps: { label: "Model steps", read: (row) => row.steps },
	costUsd: { label: "Cost, USD (list price, low end)", read: (row) => row.costLowUsd },
	outputKTokens: { label: "Output tokens, thousands", read: (row) => row.tokens?.output / 1000 },
	reasoningKTokens: {
		label: "Reasoning tokens, thousands",
		read: (row) => row.tokens?.reasoning / 1000,
	},
};

// A judged site has per-judge scores; a block with one delivered site goes unjudged.
const scored = (row) => row.byJudge && Object.keys(row.byJudge).length > 0;
const value = (row, measure) => {
	if (!row?.delivered) return null;
	if (MEASURES[measure].label.endsWith("(1–10)") && !scored(row)) return null;
	const v = MEASURES[measure].read(row);
	return Number.isFinite(v) ? v : null;
};

const blocks = [...new Set(summary.rows.map((row) => row.block))].sort((a, b) => a - b);
const cellRow = (block, cell) =>
	summary.rows.find((row) => row.block === block && row.model === cells[cell]);

// Contrasts over the four cells [A0B0, A0B1, A1B0, A1B1], each as weights.
const EFFECTS = {
	[factorA]: { label: `${levelsA[1]} − ${levelsA[0]} (main effect)`, w: [-0.5, -0.5, 0.5, 0.5] },
	[factorB]: { label: `${levelsB[1]} − ${levelsB[0]} (main effect)`, w: [-0.5, 0.5, -0.5, 0.5] },
	interaction: {
		label: `(${levelsB[1]} − ${levelsB[0]}) for ${levelsA[1]} minus for ${levelsA[0]}`,
		w: [1, -1, -1, 1],
	},
	[`${factorA}|${levelsB[0]}`]: {
		label: `${levelsA[1]} − ${levelsA[0]}, ${levelsB[0]} prompt`,
		w: [-1, 0, 1, 0],
	},
	[`${factorA}|${levelsB[1]}`]: {
		label: `${levelsA[1]} − ${levelsA[0]}, ${levelsB[1]} prompt`,
		w: [0, -1, 0, 1],
	},
	[`${factorB}|${levelsA[0]}`]: {
		label: `${levelsB[1]} − ${levelsB[0]}, ${levelsA[0]}`,
		w: [-1, 1, 0, 0],
	},
	[`${factorB}|${levelsA[1]}`]: {
		label: `${levelsB[1]} − ${levelsB[0]}, ${levelsA[1]}`,
		w: [0, 0, -1, 1],
	},
};

// Exact null distribution of the signed-rank sum T+ for ranks 1..n.
function signedRankCdf(n) {
	let counts = [1];
	for (let rank = 1; rank <= n; rank += 1) {
		const next = new Array(counts.length + rank).fill(0);
		counts.forEach((count, sum) => {
			next[sum] += count;
			next[sum + rank] += count;
		});
		counts = next;
	}
	const total = 2 ** n;
	let running = 0;
	return counts.map((count) => (running += count) / total);
}

/**
 * Hodges–Lehmann estimate (median of Walsh averages) and the exact confidence
 * interval from the signed-rank distribution, at the closest achievable level at
 * or above 95%.
 */
function hodgesLehmann(differences) {
	const n = differences.length;
	if (n === 0) return { estimate: null, low: null, high: null, level: null };
	const walsh = [];
	for (let i = 0; i < n; i += 1) {
		for (let j = i; j < n; j += 1) walsh.push((differences[i] + differences[j]) / 2);
	}
	walsh.sort((a, b) => a - b);
	const estimate = quantile(walsh, 0.5);
	const cdf = signedRankCdf(n);
	// The largest c with P(T+ <= c) <= 0.025; the interval drops c + 1 Walsh averages per side.
	let c = -1;
	while (c + 1 < cdf.length && cdf[c + 1] <= 0.025) c += 1;
	if (c < 0) return { estimate, low: null, high: null, level: null };
	return {
		estimate,
		low: walsh[c],
		high: walsh[walsh.length - 1 - c],
		level: 1 - 2 * cdf[c],
	};
}

function contrast(measure, effect) {
	const used = [];
	for (const block of blocks) {
		const vals = [0, 1, 2, 3].map((cell) => value(cellRow(block, cell), measure));
		const needed = EFFECTS[effect].w.map((w, i) => (w === 0 ? 0 : vals[i]));
		if (needed.some((v) => v === null)) continue;
		used.push({
			block,
			d: EFFECTS[effect].w.reduce((sum, w, i) => sum + w * (needed[i] ?? 0), 0),
		});
	}
	const diffs = used.map((entry) => entry.d);
	const test = wilcoxonSignedRank(diffs);
	return {
		measure,
		effect,
		blocks: used.length,
		positive: diffs.filter((d) => d > 1e-12).length,
		negative: diffs.filter((d) => d < -1e-12).length,
		mean: diffs.length ? mean(diffs) : null,
		median: diffs.length ? quantile(diffs, 0.5) : null,
		...hodgesLehmann(diffs),
		p: test.p,
		perBlock: used,
	};
}

const results = [];
for (const measure of Object.keys(MEASURES)) {
	for (const effect of Object.keys(EFFECTS)) results.push(contrast(measure, effect));
}
const primaryKeys = values.primary.split(",").map((pair) => pair.split(":"));
const primary = primaryKeys.map(([measure, effect]) =>
	results.find((r) => r.measure === measure && r.effect === effect),
);
holm(primary.map((r) => r.p)).forEach((adjusted, i) => {
	primary[i].holmP = adjusted;
});

// Per-arm descriptives over delivered (and, for scores, judged) sites.
const arms = cells.map((model) => {
	const rows = summary.rows.filter((row) => row.model === model);
	const describe = (measure) => {
		const list = rows.map((row) => value(row, measure)).filter((v) => v !== null);
		return list.length
			? {
					n: list.length,
					mean: mean(list),
					median: quantile(list, 0.5),
					q1: quantile(list, 0.25),
					q3: quantile(list, 0.75),
					min: Math.min(...list),
					max: Math.max(...list),
				}
			: { n: 0 };
	};
	return {
		model,
		trials: rows.length,
		delivered: rows.filter((row) => row.delivered).length,
		measures: Object.fromEntries(Object.keys(MEASURES).map((m) => [m, describe(m)])),
	};
});

// Manipulation checks: requested effort per step and prompt size, from the turn metrics.
const metricsBySession = new Map();
for (const line of readFileSync(".model-comparison/dev.log", "utf8").split("\n")) {
	if (!line.startsWith('{"event":"builder.turn_metrics"')) continue;
	const record = JSON.parse(line);
	if (record.kind === "initial-build") metricsBySession.set(record.sessionId, record);
}
const manipulation = cells.map((model) => {
	const efforts = {};
	const firstStep = {};
	const promptChars = [];
	const served = new Set();
	// Per step: time to first output and reasoning tokens.
	const firstOutput = [];
	const reasoningPerStep = [];
	for (const trial of trials.filter((t) => t.model === model && t.status !== "excluded")) {
		const record = metricsBySession.get(trial.projectId);
		for (const id of trial.servedModels ?? []) served.add(id);
		if (!record) continue;
		promptChars.push(record.promptChars);
		(record.stepTimings ?? []).forEach((step, index) => {
			const target = index === 0 ? firstStep : efforts;
			target[step.effort] = (target[step.effort] ?? 0) + 1;
			if (step.firstOutputMs != null) firstOutput.push(step.firstOutputMs / 1000);
			if (step.tokens) reasoningPerStep.push(step.tokens.reasoning ?? 0);
		});
	}
	return {
		model,
		firstStepEffort: firstStep,
		laterStepEffort: efforts,
		promptChars: promptChars.length ? quantile(promptChars, 0.5) : null,
		served: [...served],
		steps: firstOutput.length,
		firstOutputSec: firstOutput.length ? quantile(firstOutput, 0.5) : null,
		reasoningTokensPerStep: reasoningPerStep.length ? quantile(reasoningPerStep, 0.5) : null,
	};
});

writeFileSync(
	join(root, "factorial.json"),
	JSON.stringify({ cells, factors: [factorA, factorB], arms, results, manipulation }, null, "\t"),
);

const fmt = (v, places = 2) => (v === null || v === undefined ? "–" : v.toFixed(places));
const fmtP = (p) => (p === undefined ? "" : p < 0.001 ? "<0.001" : p.toFixed(3));
const lines = [
	`# Factorial analysis: ${values.run}`,
	"",
	`Cells: ${cells.map((c, i) => `${["A0B0", "A0B1", "A1B0", "A1B1"][i]} \`${c}\``).join(", ")}. A = ${factorA} (${levelsA.join(" → ")}), B = ${factorB} (${levelsB.join(" → ")}).`,
	"",
	"Each contrast is formed per block from the cells it weighs; a block counts only if every cell it needs delivered and, for scores, was judged. Differences are later level minus earlier level. HL is the Hodges–Lehmann estimate with its exact confidence interval (achieved level shown). p is the exact two-sided Wilcoxon signed-rank p over blocks.",
	"",
	"## Primary family (Holm-adjusted)",
	"",
	"| Measure | Effect | Blocks | + / − | HL estimate | CI | p | Holm p |",
	"| --- | --- | --- | --- | --- | --- | --- | --- |",
	...primary.map(
		(r) =>
			`| ${MEASURES[r.measure].label} | ${EFFECTS[r.effect].label} | ${r.blocks} | ${r.positive} / ${r.negative} | ${fmt(r.estimate)} | ${fmt(r.low)} to ${fmt(r.high)} (${fmt((r.level ?? 0) * 100, 1)}%) | ${fmtP(r.p)} | ${fmtP(r.holmP)} |`,
	),
	"",
	"## Arms",
	"",
	`| Arm | Delivered | ${Object.keys(MEASURES)
		.filter((m) => ["overall", "briefFidelity", "buildMin", "steps", "costUsd"].includes(m))
		.map((m) => `${MEASURES[m].label}, median [IQR]`)
		.join(" | ")} |`,
	"| --- | --- | --- | --- | --- | --- | --- |",
	...arms.map(
		(arm) =>
			`| \`${arm.model}\` | ${arm.delivered}/${arm.trials} | ${[
				"overall",
				"briefFidelity",
				"buildMin",
				"steps",
				"costUsd",
			]
				.map((m) => {
					const d = arm.measures[m];
					const places = m === "costUsd" ? 3 : 2;
					return d.n ? `${fmt(d.median, places)} [${fmt(d.q1, places)}–${fmt(d.q3, places)}]` : "–";
				})
				.join(" | ")} |`,
	),
	"",
	"## Every contrast",
	"",
	"| Measure | Effect | Blocks | + / − | Mean | HL estimate | CI | p |",
	"| --- | --- | --- | --- | --- | --- | --- | --- |",
	...results.map(
		(r) =>
			`| ${MEASURES[r.measure].label} | ${EFFECTS[r.effect].label} | ${r.blocks} | ${r.positive} / ${r.negative} | ${fmt(r.mean)} | ${fmt(r.estimate)} | ${fmt(r.low)} to ${fmt(r.high)} | ${fmtP(r.p)} |`,
	),
	"",
	"## Manipulation checks",
	"",
	"| Arm | First step effort | Later steps effort | Build prompt chars, median | Served |",
	"| --- | --- | --- | --- | --- |",
	...manipulation.map(
		(m) =>
			`| \`${m.model}\` | ${JSON.stringify(m.firstStepEffort)} | ${JSON.stringify(m.laterStepEffort)} | ${m.promptChars ?? "–"} | ${m.served.join(", ")} |`,
	),
	"",
	"## Step-level speed",
	"",
	"Medians over every first-build step of non-excluded trials. Writing speed is not given: the AI SDK starts a tool while the model is still writing the step's next call, so tool time overlaps writing and cannot be subtracted.",
	"",
	"| Arm | Steps | Time to first output, s | Reasoning tokens per step |",
	"| --- | --- | --- | --- |",
	...manipulation.map(
		(m) =>
			`| \`${m.model}\` | ${m.steps} | ${fmt(m.firstOutputSec, 1)} | ${fmt(m.reasoningTokensPerStep, 0)} |`,
	),
	"",
];
writeFileSync(join(root, "factorial.md"), lines.join("\n"));
console.log(`wrote ${join(root, "factorial.md")}`);
