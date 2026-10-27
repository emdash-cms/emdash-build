// A labeled review page: every block's sites side by side with the model that
// built each one, its timing, cost, judge scores and notes, and its
// screenshots. Not blind; for reading the results, not for judging them.
// Run analyze.mjs first: this reads its summary.json.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { mean, median } from "./stats.mjs";

const { values } = parseArgs({ options: { run: { type: "string" } } });
if (!values.run) throw new Error("Usage: review.mjs --run <name>");
const root = join(".model-comparison", values.run);
const summary = JSON.parse(readFileSync(join(root, "summary.json"), "utf8"));
const briefs = JSON.parse(readFileSync(new URL("../smoke-briefs.json", import.meta.url), "utf8"));
const trials = new Map(
	readFileSync(join(root, "trials.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.map((trial) => [trial.trialId, trial]),
);
const models = summary.design.models;

const LABELS = {
	"openai/gpt-6-luna": { name: "GPT-6 Luna", color: "#0f766e" },
	"anthropic/claude-haiku-5.5": { name: "Claude Haiku 5.5", color: "#b45309" },
	"anthropic/claude-opus-5.5": { name: "Claude Opus 5.5", color: "#6d28d9" },
	"anthropic/claude-opus-5.5>openai/gpt-6-luna": {
		name: "Opus designs, Luna builds",
		color: "#be185d",
	},
	"openai/gpt-6.1-sol": { name: "GPT-6.1 Sol", color: "#0369a1" },
	"anthropic/claude-opus-5.5+anthropic/claude-haiku-5.5": {
		name: "Opus + Haiku helpers",
		color: "#6d28d9",
	},
	"openai/gpt-6.1-sol+openai/gpt-6-luna": { name: "Sol + Luna helpers", color: "#0369a1" },
	"anthropic/claude-opus-5.5:fast": { name: "Opus 5.5, fast mode", color: "#be185d" },
	"anthropic/claude-opus-5.5:low": { name: "Opus 5.5, low effort", color: "#0f766e" },
	"openai/gpt-6-luna:batched": { name: "GPT-6 Luna, fewer steps", color: "#b45309" },
	"openai/gpt-6.1-terra:all-low": { name: "GPT-6.1 Terra, low effort", color: "#7c3aed" },
	"openai/gpt-6.1-terra:all-low:batched": {
		name: "GPT-6.1 Terra, low effort, fewer steps",
		color: "#a21caf",
	},
};
const label = (model) => LABELS[model] ?? { name: model, color: "#334155" };

// Judge notes per trial, one per judge and label order.
const notes = new Map();
const judgingDir = join(root, "judging");
if (existsSync(judgingDir)) {
	for (const judgeDir of readdirSync(judgingDir)) {
		for (const file of readdirSync(join(judgingDir, judgeDir))) {
			const record = JSON.parse(readFileSync(join(judgingDir, judgeDir, file), "utf8"));
			if (record.error || !record.verdict?.sites) continue;
			for (const [siteLabel, trialId] of Object.entries(record.labels)) {
				const site = record.verdict.sites[siteLabel];
				if (!site) continue;
				const list = notes.get(trialId) ?? [];
				list.push({
					judge: record.judge.split("/").pop(),
					overall: site.overall,
					notes: site.notes,
				});
				notes.set(trialId, list);
			}
		}
	}
}

// Why a build failed its checks: the worker logs the rejection codes; the dev
// server's output is saved to .model-comparison/dev.log during a run.
const REJECTIONS = {
	"missing-successful-validation": "it never passed site validation",
	"mutation-after-validation":
		"it changed the site after its last successful validation and stopped without checking again",
	"invalid-quality-sequence": "its validation and preview steps were out of order",
};
const rejections = new Map();
const devLog = join(".model-comparison", "dev.log");
if (existsSync(devLog)) {
	for (const line of readFileSync(devLog, "utf8").split("\n")) {
		if (!line.includes('"builder.initial_build_benchmark"')) continue;
		try {
			const event = JSON.parse(line.slice(line.indexOf("{")));
			if (event.rejectionReasons?.length) rejections.set(event.sessionId, event.rejectionReasons);
		} catch {
			// A line the dev server interleaved with other output.
		}
	}
}

function failureReason(trial) {
	const build = (trial?.turns ?? []).filter((turn) => turn.kind === "initial-build");
	if (build.some((turn) => turn.finishReason === "length")) {
		return "Ran out of output tokens: it spent the build's 32,768-token cap on reasoning before it could validate the site.";
	}
	const codes = rejections.get(trial?.projectId) ?? [];
	if (codes.length) {
		return `Finished its turn but failed the build check: ${codes.map((code) => REJECTIONS[code] ?? code).join("; ")}.`;
	}
	return trial?.reason ?? "Did not deliver.";
}

const escape = (text) =>
	String(text ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
const minutes = (ms) => (ms == null ? "n/a" : `${(ms / 60_000).toFixed(1)} min`);
const money = (low, high) =>
	Number.isFinite(low)
		? Math.abs(high - low) < 0.005
			? `$${low.toFixed(2)}`
			: `$${low.toFixed(2)}–${high.toFixed(2)}`
		: "n/a";
const thousands = (n) => (n == null ? "n/a" : `${Math.round(n / 1000)}k`);
const score = (value) => (value == null ? "n/a" : value.toFixed(1));
const img = (file) => escape(relative(root, file));

function overview() {
	const header = [
		"<th></th>",
		...models.map(
			(model) => `<th style="color:${label(model).color}">${escape(label(model).name)}</th>`,
		),
	];
	const row = (name, cell) =>
		`<tr><td>${name}</td>${models
			.map((model) => {
				const all = summary.rows.filter((r) => r.model === model);
				const delivered = all.filter((r) => r.delivered);
				return `<td>${cell(all, delivered)}</td>`;
			})
			.join("")}</tr>`;
	const scored = (list) =>
		list.filter((r) => r.scores.overall != null).map((r) => r.scores.overall);
	return `<table class="overview"><thead><tr>${header.join("")}</tr></thead><tbody>
${row("Delivered", (all, d) => `${d.length}/${all.length}`)}
${row("Build turn, median", (_, d) => minutes(median(d.map((r) => r.buildMs))))}
${row("Start to finished site, median", (_, d) => minutes(median(d.filter((r) => r.toCompleteMs != null).map((r) => r.toCompleteMs))))}
${row("Cost per build, median", (_, d) => money(median(d.map((r) => r.costLowUsd)), median(d.map((r) => r.costHighUsd))))}
${row("Reasoning tokens, median", (_, d) => thousands(median(d.map((r) => r.tokens.reasoning))))}
${row("Judge score, mean (1–10)", (_, d) => (scored(d).length ? score(mean(scored(d))) : "n/a"))}
</tbody></table>`;
}

/** A multi-model build's time and cost by model, driver or designer first. */
function split(row) {
	const ids = row.model.split(/[>+]/);
	if (ids.length < 2) return "";
	const part = (id) => {
		const ms = row.buildMsByModel?.[id];
		const cost = row.costLowUsdByModel?.[id] ?? 0;
		return `${escape(label(id).name)}: ${ms == null ? "helper calls" : `${minutes(ms)} of steps`}, ${money(cost, cost)}`;
	};
	return `<p class="judges">${ids.map(part).join(" · ")}</p>`;
}

function card(row) {
	const { name, color } = label(row.model);
	const trial = trials.get(row.trialId);
	const pages = (trial?.shots ?? []).filter((page) => page.full);
	const home = pages.find((page) => page.path === "/" && page.viewport === "desktop");
	const phone = pages.find((page) => page.path === "/" && page.viewport === "mobile");
	const inner = pages.filter((page) => page.path !== "/");
	const judged = (notes.get(row.trialId) ?? []).sort((a, b) => a.judge.localeCompare(b.judge));
	const byJudge = Object.entries(row.byJudge ?? {})
		.filter(([, value]) => value != null)
		.map(([judge, value]) => `${escape(judge.split("/").pop())} ${score(value)}`)
		.join(" · ");
	const status = row.delivered
		? `<span class="pill ok">Delivered</span>`
		: `<span class="pill bad">Failed</span>`;
	return `<article class="card" style="--accent:${color}">
<header><h3>${escape(name)}</h3>${status}</header>
${row.delivered ? "" : `<p class="reason">${escape(failureReason(trial))}</p>`}
<dl class="metrics">
<div><dt>Build turn</dt><dd>${minutes(row.buildMs)}</dd></div>
<div><dt>Start to finished</dt><dd>${minutes(row.toCompleteMs)}</dd></div>
<div><dt>Cost</dt><dd>${money(row.costLowUsd, row.costHighUsd)}</dd></div>
<div><dt>Steps</dt><dd>${row.steps}</dd></div>
<div><dt>Reasoning</dt><dd>${thousands(row.tokens.reasoning)} tokens</dd></div>
<div><dt>Judge score</dt><dd class="score">${score(row.scores.overall)}</dd></div>
</dl>
${split(row)}
${byJudge ? `<p class="judges">${byJudge}</p>` : ""}
${
	judged.length
		? `<details><summary>Judge notes (${judged.length})</summary><ul>${judged
				.map((n) => `<li><b>${escape(n.judge)} ${escape(n.overall)}</b>: ${escape(n.notes)}</li>`)
				.join("")}</ul></details>`
		: ""
}
${home ? `<a class="frame" href="${img(home.full)}" target="_blank"><img loading="lazy" src="${img(home.full)}" alt="${escape(name)} home page, desktop"></a>` : `<div class="empty">No site to show</div>`}
${phone ? `<details><summary>Phone (390px)</summary><a class="frame phone" href="${img(phone.full)}" target="_blank"><img loading="lazy" src="${img(phone.full)}" alt="${escape(name)} home page, phone"></a></details>` : ""}
${inner
	.map(
		(page) =>
			`<details><summary>${escape(page.path)}</summary><a class="frame" href="${img(page.full)}" target="_blank"><img loading="lazy" src="${img(page.full)}" alt="${escape(name)} ${escape(page.path)}"></a></details>`,
	)
	.join("")}
</article>`;
}

const blocks = [...Map.groupBy(summary.rows, (row) => row.block).entries()].sort(
	([a], [b]) => a - b,
);
const sections = blocks.map(([block, rows]) => {
	const brief = rows[0].brief;
	const ordered = models.map((model) => rows.find((row) => row.model === model)).filter(Boolean);
	return `<section data-brief="${escape(brief)}">
<h2>Block ${block} · ${escape(brief)} · repetition ${rows[0].rep}</h2>
<details class="brief"><summary>Brief</summary><p>${escape(briefs[brief].prompt)}</p><p>${escape(briefs[brief].answer)}</p></details>
<div class="cards">${ordered.map(card).join("")}</div>
</section>`;
});

writeFileSync(
	join(root, "review.html"),
	`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Builder model comparison: ${escape(values.run)}</title>
<style>
:root{color-scheme:light;font:14px/1.45 system-ui,-apple-system,sans-serif;color:#0f172a;background:#f1f5f9}
body{margin:0;padding:24px 32px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 8px;text-transform:capitalize}
.lead{color:#475569;margin:0 0 16px}
.overview{border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;margin-bottom:20px;box-shadow:0 1px 2px #0001}
.overview th,.overview td{padding:8px 16px;text-align:left;border-bottom:1px solid #e2e8f0}
.overview td:first-child{color:#475569}
.filters{display:flex;gap:8px;margin:0 0 20px;position:sticky;top:0;background:#f1f5f9;padding:8px 0;z-index:1}
.filters button{font:inherit;border:1px solid #cbd5e1;background:#fff;border-radius:999px;padding:4px 14px;cursor:pointer;text-transform:capitalize}
.filters button[aria-pressed=true]{background:#0f172a;color:#fff;border-color:#0f172a}
section{margin:0 0 36px}
.brief{color:#475569;margin:0 0 12px;max-width:900px}
.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}
.card{background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 2px #0001;border-top:4px solid var(--accent)}
.card header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.card h3{margin:0;font-size:15px;color:var(--accent)}
.pill{font-size:12px;padding:2px 10px;border-radius:999px;font-weight:600}
.pill.ok{background:#dcfce7;color:#166534}.pill.bad{background:#fee2e2;color:#991b1b}
.reason{color:#991b1b;margin:6px 0 0;font-size:12px}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}
.metrics div{background:#f8fafc;border-radius:6px;padding:6px 8px}
.metrics dt{font-size:11px;color:#64748b}.metrics dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
.metrics .score{color:var(--accent);font-size:16px}
.judges{margin:0 0 8px;font-size:12px;color:#475569}
details{margin:8px 0}summary{cursor:pointer;color:#334155;font-weight:500}
details ul{margin:6px 0;padding-left:18px;color:#334155}details li{margin:4px 0}
.frame{display:block;max-height:1100px;overflow:auto;border:1px solid #e2e8f0;border-radius:6px;margin-top:8px;cursor:zoom-in}
.frame img{display:block;width:100%}.frame.phone{max-width:280px}
.empty{padding:40px;text-align:center;color:#94a3b8;border:1px dashed #cbd5e1;border-radius:6px;margin-top:8px}
@media (max-width:1100px){.cards{grid-template-columns:1fr}}
</style>
<h1>Builder model comparison</h1>
<p class="lead">Click a screenshot to open it full size. Run <code>${escape(values.run)}</code>: ${summary.rows.length} first builds, every model at the same effort labels. Judge scores are the mean of ${escape(
		Object.keys(summary.judgeTests ?? {})
			.map((j) => j.split("/").pop())
			.join(" and ") || "the model judges",
	)} over every label order.</p>
${overview()}
<nav class="filters">${["all", ...summary.design.briefs]
		.map(
			(brief) =>
				`<button data-filter="${escape(brief)}" aria-pressed="${brief === "all"}">${escape(brief)}</button>`,
		)
		.join("")}</nav>
${sections.join("\n")}
<script>
for (const button of document.querySelectorAll("[data-filter]")) {
	button.addEventListener("click", () => {
		for (const other of document.querySelectorAll("[data-filter]")) other.setAttribute("aria-pressed", String(other === button));
		for (const section of document.querySelectorAll("section[data-brief]")) {
			section.hidden = button.dataset.filter !== "all" && section.dataset.brief !== button.dataset.filter;
		}
	});
}
</script>
</html>`,
);
console.log(`wrote ${join(root, "review.html")}`);
