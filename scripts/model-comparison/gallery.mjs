// A blind gallery for a human judge. Images are copied under opaque names and
// sites get letters drawn independently of the model judges' labels; the key
// that maps them back stays in gallery-key.json, outside the page. Scores are
// kept in the page and downloaded as JSON; `--import <file>` turns that file
// into verdicts for analyze.mjs.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		run: { type: "string" },
		import: { type: "string" },
		seed: { type: "string", default: "99" },
	},
});
if (!values.run) throw new Error("Usage: gallery.mjs --run <name> [--import verdicts.json]");
const root = join(".model-comparison", values.run);
const keyFile = join(root, "gallery-key.json");

if (values.import) {
	const key = JSON.parse(readFileSync(keyFile, "utf8"));
	const dir = join(root, "judging", "human");
	mkdirSync(dir, { recursive: true });
	for (const record of JSON.parse(readFileSync(values.import, "utf8"))) {
		const labels = Object.fromEntries(
			Object.entries(record.labels).map(([label, siteId]) => [label, key.sites[siteId]]),
		);
		writeFileSync(
			join(dir, `block-${String(record.block).padStart(2, "0")}-order-0.json`),
			JSON.stringify({ ...record, labels }, null, 2),
		);
	}
	console.log(`imported human verdicts into ${dir}`);
	process.exit(0);
}

const briefs = JSON.parse(readFileSync(new URL("../smoke-briefs.json", import.meta.url), "utf8"));
const trials = readFileSync(join(root, "trials.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((trial) => trial.status === "delivered");

const opaque = (text) =>
	createHash("sha256").update(`${values.seed}:${text}`).digest("hex").slice(0, 16);
let state = Number(values.seed) >>> 0;
const random = () => {
	state = (state + 0x6d2b79f5) >>> 0;
	let t = Math.imul(state ^ (state >>> 15), state | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const escape = (text) =>
	String(text).replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

const imageDir = join(root, "gallery");
rmSync(imageDir, { recursive: true, force: true });
mkdirSync(imageDir, { recursive: true });
const key = { sites: {} };

const blocks = [...Map.groupBy(trials, (trial) => trial.block).entries()].sort(([a], [b]) => a - b);
const sections = blocks.map(([block, members]) => {
	const sites = members
		.filter((trial) => (trial.shots ?? []).some((page) => page.full))
		.sort((a, b) => a.trialId.localeCompare(b.trialId));
	for (let i = sites.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		[sites[i], sites[j]] = [sites[j], sites[i]];
	}
	const labels = {};
	const columns = sites
		.map((trial, i) => {
			const label = `Site ${String.fromCharCode(65 + i)}`;
			const siteId = opaque(trial.trialId);
			key.sites[siteId] = trial.trialId;
			labels[label] = siteId;
			const pages = trial.shots
				.filter((page) => page.full)
				.map((page) => {
					const name = `${opaque(page.full)}.jpg`;
					copyFileSync(page.full, join(imageDir, name));
					return `<figure><figcaption>${escape(page.path)} · ${page.viewport}</figcaption><div class="frame ${page.viewport}"><img loading="lazy" src="gallery/${name}"></div></figure>`;
				});
			return `<div class="site"><h3>${label}</h3>
<label>Overall 1–10 <input type="number" min="1" max="10" data-block="${block}" data-label="${label}"></label>
${pages.join("\n")}
</div>`;
		})
		.join("\n");
	const brief = briefs[members[0].brief];
	return `<section data-block="${block}" data-labels='${escape(JSON.stringify(labels))}'>
<h2>Block ${block}</h2>
<details><summary>Brief</summary><p>${escape(brief.prompt)}</p><p>${escape(brief.answer)}</p></details>
<div class="sites">${columns}</div>
</section>`;
});
writeFileSync(keyFile, JSON.stringify(key, null, 2));

writeFileSync(
	join(root, "gallery.html"),
	`<!doctype html><meta charset="utf-8"><title>Blind gallery</title>
<style>
body{font:14px system-ui;margin:24px;background:#f4f4f5;color:#18181b}
.sites{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:16px}
.site{background:#fff;padding:12px;border-radius:8px}
.frame{max-height:900px;overflow:auto;border:1px solid #e4e4e7}
.frame img{display:block;width:100%}.frame.mobile{max-width:390px}
section{margin-bottom:48px}input{width:4em}button{font:inherit;padding:8px 16px}
</style>
<h1>Blind gallery</h1>
<p>Score each site from 1 to 10 for how happy the client would be to launch it. Scores stay in this browser until you download them.</p>
<button id="save">Download verdicts</button>
${sections.join("\n")}
<script>
const storageKey = "gallery:" + ${JSON.stringify(opaque(values.run))};
const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
for (const input of document.querySelectorAll("input[data-block]")) {
	const id = input.dataset.block + "/" + input.dataset.label;
	if (saved[id]) input.value = saved[id];
	input.addEventListener("input", () => { saved[id] = input.value; localStorage.setItem(storageKey, JSON.stringify(saved)); });
}
document.getElementById("save").addEventListener("click", () => {
	const records = [...document.querySelectorAll("section[data-block]")].map((section) => {
		const labels = JSON.parse(section.dataset.labels);
		const sites = {};
		for (const label of Object.keys(labels)) {
			const value = Number(saved[section.dataset.block + "/" + label]);
			if (value) sites[label] = { overall: value };
		}
		return { judge: "human", block: Number(section.dataset.block), order: 0, labels, verdict: { sites } };
	}).filter((record) => Object.keys(record.verdict.sites).length > 0);
	const link = document.createElement("a");
	link.href = URL.createObjectURL(new Blob([JSON.stringify(records, null, 2)], { type: "application/json" }));
	link.download = "human-verdicts.json";
	link.click();
});
</script>`,
);
console.log(`wrote ${join(root, "gallery.html")} (key: ${keyFile})`);
