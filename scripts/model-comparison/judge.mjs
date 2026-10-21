// Blind design judging, on the builder's own model path (run with
// --import ./scripts/model-comparison/ts-resolve.mjs). Each block's sites go to
// every judge as "Site 1..n", once with each site in each position, so
// position bias cancels. Judges never see a model name, trial id or project
// id; the label mapping is written next to each verdict for analysis only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { generateText } from "ai";
import { builderProviderOptions, createBuilderModel } from "../../src/worker/model.ts";
import { devVars } from "./dev-vars.mjs";

const { values } = parseArgs({
	options: {
		run: { type: "string" },
		judges: { type: "string" },
		// Default: one rotation per site, so every site takes every position once.
		orders: { type: "string" },
		seed: { type: "string", default: "7" },
	},
});
if (!values.run || !values.judges) {
	throw new Error("Usage: judge.mjs --run <name> --judges <gateway-model,...> [--orders n]");
}

const root = join(".model-comparison", values.run);
const briefs = JSON.parse(readFileSync(new URL("../smoke-briefs.json", import.meta.url), "utf8"));
const trials = readFileSync(join(root, "trials.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((trial) => trial.status === "delivered");
const env = { ...devVars(), ...process.env };

const CRITERIA = {
	layout:
		"Layout and visual hierarchy: composition, spacing, alignment, clear focal points; looks designed rather than templated.",
	typography: "Typography: font choice and pairing, type scale, line length, readability.",
	colorImagery:
		"Colour and imagery: palette fits the brief, images are relevant and well used, contrast is sufficient.",
	briefFidelity:
		"Brief fidelity: the requested sections, content, features and tone are present and correct.",
	polish:
		"Polish: free of defects such as broken images, overflow, misalignment, empty sections, placeholder junk or lorem ipsum. Higher means fewer defects.",
	mobile: "Mobile: the phone layout is usable and well composed, not just a squeezed desktop.",
};

const RUBRIC = `Score every site on each criterion from 1 to 10:
${Object.entries(CRITERIA)
	.map(([key, text]) => `- ${key}: ${text}`)
	.join("\n")}
- overall: how happy the client would be to launch this site as it stands.

Anchors: 1-2 broken or unusable; 3-4 poor; 5-6 acceptable but generic; 7-8 good, professional; 9-10 exceptional.
Judge only what the screenshots show. Compare the sites against each other so the scores separate them, and give different overall scores unless two sites are truly equal.

Reply with JSON only, no prose around it:
{"sites": {"Site 1": {"layout": n, "typography": n, "colorImagery": n, "briefFidelity": n, "polish": n, "mobile": n, "overall": n, "notes": "one sentence"}, ...}, "ranking": ["Site k", ...]}`;

// Vision models downscale past ~1568px on the long edge; resize first so detail survives and requests stay small.
function resized(file) {
	const hash = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 32);
	const out = join(tmpdir(), `judge-${hash}.jpg`);
	if (!existsSync(out)) {
		execFileSync("sips", ["-Z", "1568", "-s", "format", "jpeg", file, "--out", out], {
			stdio: "ignore",
		});
	}
	return readFileSync(out).toString("base64");
}

function siteImages(trial) {
	const pages = (trial.shots ?? []).filter((page) => !page.error);
	const pick = (page, count) => page.tiles.slice(0, count).map((file) => ({ page, file }));
	const home = pages.find((page) => page.path === "/" && page.viewport === "desktop");
	const phone = pages.find((page) => page.path === "/" && page.viewport === "mobile");
	const inner = pages.filter((page) => page.path !== "/");
	return [
		...(home ? pick(home, 4) : []),
		...(phone ? pick(phone, 2) : []),
		...inner.flatMap((page) => pick(page, 1)),
	];
}

function caption({ page }, index, count) {
	const where = page.path === "/" ? "home page" : `page ${page.path}`;
	return `${where}, ${page.viewport} (${page.viewport === "desktop" ? "1440" : "390"}px wide), part ${index + 1} of ${count}`;
}

/** The verdict, or an error naming what is missing, so a bad reply is retried rather than scored. */
function parseVerdict(text, labels) {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("The judge returned no JSON.");
	const verdict = JSON.parse(text.slice(start, end + 1));
	for (const label of labels) {
		const scores = verdict.sites?.[label];
		if (!scores) throw new Error(`The verdict leaves out ${label}.`);
		for (const key of [...Object.keys(CRITERIA), "overall"]) {
			const value = Number(scores[key]);
			if (!(value >= 1 && value <= 10)) throw new Error(`${label} has no 1-10 ${key} score.`);
			scores[key] = value;
		}
	}
	return verdict;
}

function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), a | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const blocks = Map.groupBy(trials, (trial) => trial.block);
// Each judge and block gets its own seeded order, so resuming or adding a judge changes no other order.
const seedFor = (judge, block) =>
	createHash("sha256").update(`${values.seed}:${judge}:${block}`).digest().readUInt32LE(0);

for (const judge of values.judges.split(",")) {
	const dir = join(root, "judging", judge.replace(/[^a-z0-9.]+/gi, "-"));
	mkdirSync(dir, { recursive: true });
	for (const [block, members] of blocks) {
		const sites = members.filter((trial) => siteImages(trial).length > 0);
		if (sites.length < 2) continue;
		const random = rng(seedFor(judge, block));
		const base = [...sites].sort((a, b) => a.trialId.localeCompare(b.trialId));
		for (let i = base.length - 1; i > 0; i -= 1) {
			const j = Math.floor(random() * (i + 1));
			[base[i], base[j]] = [base[j], base[i]];
		}
		const orders = Number(values.orders ?? base.length);
		for (let order = 0; order < orders; order += 1) {
			const file = join(dir, `block-${String(block).padStart(2, "0")}-order-${order}.json`);
			if (existsSync(file) && !JSON.parse(readFileSync(file, "utf8")).error) continue;
			const rotated = base.map((_, i) => base[(i + order) % base.length]);
			const labels = Object.fromEntries(
				rotated.map((trial, i) => [`Site ${i + 1}`, trial.trialId]),
			);
			const brief = briefs[members[0].brief];
			const content = [
				{
					type: "text",
					text:
						`You are reviewing ${rotated.length} candidate websites built for the same client brief.\n\n` +
						`Client brief:\n${brief.prompt}\n\n${brief.answer}\n\n${RUBRIC}`,
				},
			];
			rotated.forEach((trial, i) => {
				const images = siteImages(trial);
				content.push({ type: "text", text: `\n=== Site ${i + 1} ===` });
				images.forEach((image, index) => {
					content.push({
						type: "text",
						text: `Site ${i + 1}: ${caption(image, index, images.length)}`,
					});
					content.push({ type: "file", data: resized(image.file), mediaType: "image/jpeg" });
				});
			});
			const started = Date.now();
			let record;
			try {
				const result = await generateText({
					model: createBuilderModel(env, { modelId: judge }),
					messages: [{ role: "user", content }],
					providerOptions: builderProviderOptions("medium", { reasoningSummary: false }),
					maxRetries: 3,
				});
				record = {
					judge,
					block,
					order,
					labels,
					verdict: parseVerdict(result.text, Object.keys(labels)),
					ms: Date.now() - started,
					usage: result.totalUsage,
				};
			} catch (error) {
				record = {
					judge,
					block,
					order,
					labels,
					error: String(error?.responseBody ?? error?.message ?? error).slice(0, 500),
				};
			}
			writeFileSync(file, JSON.stringify(record, null, 2));
			console.error(
				`${judge} block ${block} order ${order}: ${record.error ? `FAILED ${record.error}` : "ok"}`,
			);
		}
	}
}
