// Collects two-arm comparison runs for an exploration canvas: each site's
// numbers, judge scores and notes, step sequence and resized screenshots, plus
// paired statistics over every block. Writes `data.js` and `img/` into --out.
// Step sequences come from the local BuilderAgent SQLite stores and step
// timings from .model-comparison/dev.log, so run it on the machine that ran
// the trials.
// Run: node scripts/model-comparison/canvas-data.mjs --runs luna-steps,luna-steps-2 --base openai/gpt-6-luna --arm openai/gpt-6-luna:batched --prompt src/worker/prompts/build-batched.md --out .model-comparison/canvas-luna-steps
// More than two arms: --arms <baseline>,<arm>,... instead of --base and --arm,
// plus --factorial <run>/factorial.json to embed factorial.mjs's results.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		runs: { type: "string" },
		base: { type: "string" },
		arm: { type: "string" },
		out: { type: "string" },
		// The prompt text the arm adds, shown on the canvas.
		prompt: { type: "string" },
		arms: { type: "string" },
		factorial: { type: "string" },
	},
});
const armModels = values.arms?.split(",") ?? [values.base, values.arm];
if (!values.runs || armModels.length < 2 || armModels.some((m) => !m) || !values.out) {
	throw new Error(
		"Usage: canvas-data.mjs --runs a,b (--base <model> --arm <model> | --arms <m1>,<m2>,...) --out <dir>",
	);
}
// Two arms keep the original "base" and "arm" labels; more use the model ids.
const armLabel = (model) =>
	armModels.length === 2 ? (model === armModels[0] ? "base" : "arm") : model;
const runs = values.runs.split(",");
const out = values.out;
const readJsonl = (file) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

function stepSequences() {
	const dir = ".wrangler/state/v3/do/emdash-build-BuilderAgent";
	const bySession = new Map();
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".sqlite") || file === "metadata.sqlite") continue;
		let db;
		try {
			db = new DatabaseSync(join(dir, file), { readOnly: true });
			const session = db.prepare("select name from __miniflare_do_name").get()?.name;
			let longest = [];
			for (const row of db.prepare("select message from cf_ai_chat_agent_messages").all()) {
				const message = JSON.parse(row.message);
				if (message.role !== "assistant") continue;
				const steps = [];
				for (const part of message.parts) {
					if (part.type === "step-start") steps.push({ tools: [], failed: 0 });
					else if (steps.length > 0 && part.type?.startsWith("tool-")) {
						const step = steps.at(-1);
						step.tools.push(part.type.slice("tool-".length));
						if (part.state === "output-error" || part.output?.success === false) step.failed += 1;
					}
				}
				if (steps.length > longest.length) longest = steps;
			}
			if (session) bySession.set(session, longest);
		} catch {
			// Not a builder store, or one still being written.
		} finally {
			db?.close();
		}
	}
	return bySession;
}

function stepTimings() {
	const bySession = new Map();
	for (const line of readFileSync(".model-comparison/dev.log", "utf8").split("\n")) {
		if (!line.startsWith('{"event":"builder.turn_metrics"')) continue;
		const record = JSON.parse(line);
		if (record.kind === "initial-build" && Array.isArray(record.stepTimings)) {
			bySession.set(record.sessionId, record);
		}
	}
	return bySession;
}

function notesFor(run) {
	const byTrial = new Map();
	const dir = join(".model-comparison", run, "judging");
	if (!existsSync(dir)) return byTrial;
	for (const judge of readdirSync(dir)) {
		for (const file of readdirSync(join(dir, judge))) {
			const record = JSON.parse(readFileSync(join(dir, judge, file), "utf8"));
			if (record.error || !record.verdict?.sites) continue;
			for (const [label, trialId] of Object.entries(record.labels)) {
				const site = record.verdict.sites[label];
				if (!site) continue;
				const list = byTrial.get(trialId) ?? [];
				list.push({ judge: record.judge.split("/").pop(), order: record.order, ...site });
				byTrial.set(trialId, list);
			}
		}
	}
	return byTrial;
}

function resize(src, dest, width) {
	execFileSync(
		"sips",
		[
			"-s",
			"format",
			"jpeg",
			"-s",
			"formatOptions",
			"72",
			"--resampleWidth",
			String(width),
			src,
			"--out",
			dest,
		],
		{ stdio: "ignore" },
	);
}

// Exact two-sided Wilcoxon signed-rank p over every sign assignment, ties by mid-rank.
function wilcoxon(diffs) {
	const nonzero = diffs.filter((d) => d !== 0);
	const sorted = nonzero.map((d, i) => ({ abs: Math.abs(d), i })).sort((a, b) => a.abs - b.abs);
	const ranks = new Array(nonzero.length);
	for (let start = 0; start < sorted.length; ) {
		let end = start;
		while (end + 1 < sorted.length && sorted[end + 1].abs === sorted[start].abs) end += 1;
		for (let k = start; k <= end; k += 1) ranks[sorted[k].i] = (start + end) / 2 + 1;
		start = end + 1;
	}
	const observed = nonzero.reduce((sum, d, i) => sum + (d > 0 ? ranks[i] : 0), 0);
	const total = ranks.reduce((a, b) => a + b, 0);
	const centre = total / 2;
	let extreme = 0;
	const n = nonzero.length;
	for (let mask = 0; mask < 1 << n; mask += 1) {
		let w = 0;
		for (let i = 0; i < n; i += 1) if (mask & (1 << i)) w += ranks[i];
		if (Math.abs(w - centre) >= Math.abs(observed - centre) - 1e-9) extreme += 1;
	}
	return { n, p: n === 0 ? 1 : extreme / (1 << n) };
}
const median = (list) => {
	const s = [...list].sort((a, b) => a - b);
	return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

const sequences = stepSequences();
const timings = stepTimings();
mkdirSync(join(out, "img"), { recursive: true });

const sites = [];
for (const run of runs) {
	const root = join(".model-comparison", run);
	const summary = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
	const trials = new Map(
		readJsonl(join(root, "trials.jsonl")).map((trial) => [trial.trialId, trial]),
	);
	const notes = notesFor(run);
	for (const row of summary.rows) {
		if (!armModels.includes(row.model)) continue;
		const trial = trials.get(row.trialId);
		const metrics = timings.get(trial.projectId);
		const sequence = sequences.get(trial.projectId) ?? [];
		const dir = join(out, "img", run, row.trialId);
		mkdirSync(dir, { recursive: true });
		const pages = [];
		for (const [index, shot] of (trial.shots ?? []).entries()) {
			if (!shot.full || !existsSync(shot.full)) continue;
			const name = `${String(index).padStart(2, "0")}-${shot.viewport}.jpg`;
			if (!existsSync(join(dir, name))) {
				resize(shot.full, join(dir, name), shot.viewport === "mobile" ? 320 : 760);
			}
			pages.push({
				path: shot.path,
				viewport: shot.viewport,
				title: shot.title,
				img: `img/${run}/${row.trialId}/${name}`,
			});
		}
		const home = trial.shots?.find((shot) => shot.path === "/" && shot.viewport === "desktop");
		if (home?.full && !existsSync(join(dir, "full.jpg")))
			resize(home.full, join(dir, "full.jpg"), 1440);
		sites.push({
			id: `${run}/${row.trialId}`,
			run,
			block: row.block,
			rep: row.rep,
			brief: row.brief,
			arm: armLabel(row.model),
			model: row.model,
			delivered: row.delivered,
			failure: row.delivered
				? null
				: String(
						trial.turns?.find((turn) => turn.kind === "initial-build")?.error ?? trial.reason ?? "",
					),
			buildMin: round(row.buildMs / 60000),
			steps: row.steps,
			validates: metrics?.tools?.validate_site?.calls ?? null,
			promptChars: metrics?.promptChars ?? null,
			efforts: (metrics?.stepTimings ?? []).map((step) => step.effort),
			validateFailures: metrics?.tools?.validate_site?.failures ?? null,
			costUsd: round(row.costLowUsd, 3),
			outputTokens: row.tokens?.output,
			reasoningTokens: row.tokens?.reasoning,
			// A block with one delivered site goes unjudged; its summary row still carries zeros.
			scores: notes.has(row.trialId) ? row.scores : null,
			byJudge: notes.has(row.trialId) ? row.byJudge : null,
			notes: (notes.get(row.trialId) ?? []).sort(
				(a, b) => a.judge.localeCompare(b.judge) || a.order - b.order,
			),
			pages,
			full: home ? `img/${run}/${row.trialId}/full.jpg` : null,
			stepStrip: sequence.map((step, index) => ({
				tools: step.tools,
				failed: step.failed,
				ms: metrics?.stepTimings?.[index]?.ms ?? null,
				firstOutputMs: metrics?.stepTimings?.[index]?.firstOutputMs ?? null,
			})),
		});
	}
}

// One pair per block, in run order.
const pairs = [];
for (const site of sites.filter((s) => s.arm === "base")) {
	const other = sites.find((s) => s.run === site.run && s.block === site.block && s.arm === "arm");
	if (other)
		pairs.push({
			run: site.run,
			block: site.block,
			brief: site.brief,
			rep: site.rep,
			base: site.id,
			arm: other.id,
		});
}
const byId = new Map(sites.map((site) => [site.id, site]));
// Differences are arm minus base. A win is a lower time or step count, or a higher score.
const paired = (pick, lowerWins) => {
	const both = pairs.filter(
		(p) =>
			pick(byId.get(p.base)) != null &&
			pick(byId.get(p.arm)) != null &&
			byId.get(p.base).delivered &&
			byId.get(p.arm).delivered,
	);
	const diffs = both.map((p) => pick(byId.get(p.arm)) - pick(byId.get(p.base)));
	const better = (d) => (lowerWins ? d < 0 : d > 0);
	const worse = (d) => (lowerWins ? d > 0 : d < 0);
	return {
		blocks: both.length,
		armWins: diffs.filter(better).length,
		baseWins: diffs.filter(worse).length,
		medianDiff: round(median(diffs)),
		meanDiff: round(mean(diffs)),
		p: round(wilcoxon(diffs).p, 4),
	};
};
const arms = (arm) => sites.filter((s) => s.arm === arm && s.delivered);
const summaryOf = (arm) => ({
	delivered: `${arms(arm).length}/${sites.filter((s) => s.arm === arm).length}`,
	medianBuildMin: round(median(arms(arm).map((s) => s.buildMin))),
	meanBuildMin: round(mean(arms(arm).map((s) => s.buildMin))),
	medianSteps: median(arms(arm).map((s) => s.steps)),
	medianCostUsd: round(median(arms(arm).map((s) => s.costUsd)), 3),
	scores: Object.fromEntries(
		["overall", "layout", "typography", "colorImagery", "briefFidelity", "polish", "mobile"].map(
			(key) => [
				key,
				round(
					mean(
						arms(arm)
							.filter((s) => s.scores)
							.map((s) => s.scores[key]),
					),
				),
			],
		),
	),
	needsSecondValidation: arms(arm).filter((s) => (s.validates ?? 0) > 1).length,
});

// Every block's sites in arm order, for any number of arms.
const blocks = [];
for (const site of sites) {
	let block = blocks.find((b) => b.run === site.run && b.block === site.block);
	if (!block) {
		block = { run: site.run, block: site.block, brief: site.brief, rep: site.rep, sites: [] };
		blocks.push(block);
	}
	block.sites[armModels.indexOf(site.model)] = site.id;
}
const data = {
	runs,
	prompt: values.prompt ? readFileSync(values.prompt, "utf8") : null,
	arms: armModels,
	sites,
	blocks,
	armSummary: Object.fromEntries(armModels.map((model) => [model, summaryOf(armLabel(model))])),
	factorial: values.factorial ? JSON.parse(readFileSync(values.factorial, "utf8")) : null,
	...(armModels.length === 2
		? {
				base: armModels[0],
				arm: armModels[1],
				pairs,
				summary: { base: summaryOf("base"), arm: summaryOf("arm") },
				paired: {
					buildMin: paired((s) => s.buildMin, true),
					steps: paired((s) => s.steps, true),
					overall: paired((s) => s.scores?.overall, false),
					briefFidelity: paired((s) => s.scores?.briefFidelity, false),
				},
			}
		: {}),
};
writeFileSync(join(out, "data.js"), `window.RUN_DATA = ${JSON.stringify(data, null, "\t")};\n`);
console.log(`wrote ${join(out, "data.js")}: ${sites.length} sites, ${blocks.length} blocks`);
console.log(
	JSON.stringify(
		data.paired ? { summary: data.summary, paired: data.paired } : data.armSummary,
		null,
		2,
	),
);
