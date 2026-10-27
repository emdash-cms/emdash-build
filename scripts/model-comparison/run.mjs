// Runs the comparison as a randomized complete block design: each block is
// one brief and one repetition, and every model builds it at the same time
// against the same dev server, so load and time of day hit all models alike.
// Rerunning with the same --run resumes from design.json and skips recorded
// trials. --rerun-excluded reruns every block that holds an excluded trial.
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { captureSite } from "./capture.mjs";

const { values } = parseArgs({
	options: {
		run: { type: "string" },
		models: {
			type: "string",
			default: "openai/gpt-6-luna,anthropic/claude-haiku-5.5,anthropic/claude-opus-5.5",
		},
		briefs: { type: "string", default: "stargazing,bakery,editorial" },
		reps: { type: "string", default: "3" },
		// Run only the first n blocks of the schedule.
		"max-blocks": { type: "string" },
		seed: { type: "string", default: "20261021" },
		url: { type: "string", default: "http://localhost:5173" },
		"timeout-min": { type: "string", default: "60" },
		"rerun-excluded": { type: "boolean", default: false },
		"rerun-block": { type: "string", multiple: true, default: [] },
		// Restart Colima when amd64 emulation has broken (Rosetta's binfmt handler can go stale).
		"heal-emulation": { type: "boolean", default: false },
		// Start each block only once the app has idle-stopped the earlier blocks' sandboxes.
		"wait-idle": { type: "boolean", default: false },
	},
});
if (!values.run) throw new Error("Pass --run <name>; results go to .model-comparison/<name>/.");

const root = join(".model-comparison", values.run);
mkdirSync(root, { recursive: true });
const briefs = JSON.parse(readFileSync("scripts/smoke-briefs.json", "utf8"));

// The same words reach every model: the brief and its follow-up direction in
// the first message, and one fixed reply if the interview asks anything.
const firstMessage = (brief) => `${briefs[brief].prompt}\n\n${briefs[brief].answer}`;
const INTERVIEW_REPLY =
	"Everything I know is in my first message. Use your judgment for anything else.";

// mulberry32: a seeded shuffle, so the schedule is reproducible.
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function shuffle(items, random) {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

const designFile = join(root, "design.json");
if (!existsSync(designFile)) {
	const models = values.models.split(",");
	const random = rng(Number(values.seed));
	const blocks = [];
	for (let rep = 1; rep <= Number(values.reps); rep += 1) {
		for (const brief of shuffle(values.briefs.split(","), random)) {
			blocks.push({ block: blocks.length + 1, rep, brief, launchOrder: shuffle(models, random) });
		}
	}
	if (values["max-blocks"]) blocks.splice(Number(values["max-blocks"]));
	writeFileSync(
		designFile,
		JSON.stringify(
			{
				models,
				briefs: values.briefs.split(","),
				reps: Number(values.reps),
				seed: Number(values.seed),
				url: values.url,
				commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
				dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
				createdAt: new Date().toISOString(),
				interviewReply: INTERVIEW_REPLY,
				blocks,
			},
			null,
			2,
		),
	);
}
const design = JSON.parse(readFileSync(designFile, "utf8"));
// The uncommitted changes the run used, so it can be reproduced.
const diffFile = join(root, "design.diff");
if (!existsSync(diffFile)) {
	const git = (args) => {
		try {
			return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		} catch (error) {
			// `git diff --no-index` exits 1 when the files differ.
			return error.stdout ?? "";
		}
	};
	const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
	writeFileSync(
		diffFile,
		[
			git(["diff", design.commit]),
			...untracked.map((file) => git(["diff", "--no-index", "/dev/null", file])),
		].join(""),
	);
}

const trialsFile = join(root, "trials.jsonl");
const readTrials = () =>
	existsSync(trialsFile)
		? readFileSync(trialsFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];

// Superseded trials leave trials.jsonl for superseded.jsonl and their
// directories move aside, so the block reruns whole under the same ids.
function supersedeBlocks(blocks, because) {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const kept = [];
	for (const trial of readTrials()) {
		if (!blocks.has(trial.block)) {
			kept.push(trial);
			continue;
		}
		appendFileSync(
			join(root, "superseded.jsonl"),
			`${JSON.stringify({ ...trial, supersededAt: stamp, supersededBecause: because })}\n`,
		);
		mkdirSync(join(root, "superseded"), { recursive: true });
		const dir = join(root, trial.trialId);
		if (existsSync(dir)) renameSync(dir, join(root, "superseded", `${trial.trialId}-${stamp}`));
		done.delete(trial.trialId);
	}
	writeFileSync(trialsFile, kept.map((trial) => `${JSON.stringify(trial)}\n`).join(""));
	console.error(`rerunning blocks ${[...blocks].sort((a, b) => a - b).join(", ")}: ${because}`);
}

const done = new Set(readTrials().map((trial) => trial.trialId));
const rerunBlocks = new Set(values["rerun-block"].map(Number));
if (values["rerun-excluded"]) {
	for (const trial of readTrials()) if (trial.status === "excluded") rerunBlocks.add(trial.block);
}
if (rerunBlocks.size > 0) supersedeBlocks(rerunBlocks, "requested");

// `a>b` and `a+b` are different arms, so they need different trial ids.
const slug = (model) =>
	model
		.replaceAll(">", "-to-")
		.replaceAll("+", "-with-")
		.replace(/[^a-z0-9.]+/gi, "-");
// The gateway lists "claude-opus-5.5" and may report Anthropic's own "claude-opus-5-5".
const bareModel = (id) => String(id).split("/").pop().toLowerCase().replaceAll(".", "-");

function runSmoke(block, model, dir) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["scripts/smoke-chat.mjs"], {
			env: {
				...process.env,
				EMDASH_SMOKE_URL: design.url,
				EMDASH_SMOKE_PROMPT: firstMessage(block.brief),
				EMDASH_SMOKE_ANSWER: INTERVIEW_REPLY,
				// First build only: an empty follow-up ends the run after the build is audited.
				EMDASH_SMOKE_FOLLOW_UP: "",
				EMDASH_SMOKE_MODEL: model,
				EMDASH_SMOKE_TIMEOUT_MS: String(Number(values["timeout-min"]) * 60_000),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let log = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => {
			log += chunk;
			for (const line of String(chunk).split("\n").filter(Boolean)) {
				console.error(`[b${block.block} ${block.brief} ${slug(model)}] ${line}`);
			}
		});
		child.on("close", (code) => {
			writeFileSync(join(dir, "smoke.log"), log);
			writeFileSync(join(dir, "smoke.json"), stdout);
			try {
				resolve(JSON.parse(stdout));
			} catch {
				resolve({ ok: false, reason: `smoke-chat exited ${code} without a JSON result.` });
			}
		});
	});
}

/**
 * excluded: the model never got a fair run (provisioning, auth, a socket the
 * harness lost before any turn, or the gateway served another model). These
 * are rerun, never scored. failed: the model ran and did not deliver.
 */
function classify(result, modelCheck) {
	const turns = result.turns ?? [];
	const authFailures = turns.some((turn) =>
		Object.keys(turn.modelHttp?.failures ?? {}).some(
			(status) => status === "401" || status === "403",
		),
	);
	// A turn that ended on a lost connection (status 0) failed on the network, not the model.
	const networkFailure = turns.some(
		(turn) => turn.outcome === "error" && (turn.modelHttp?.failures?.["0"] ?? 0) > 0,
	);
	// The provider can end a stream with its own capacity error.
	const providerOverloaded = turns.some(
		(turn) => turn.outcome === "error" && /overloaded/i.test(turn.error ?? ""),
	);
	if (!modelCheck.verified) return { status: "excluded", why: modelCheck.why };
	if (result.ok === true) return { status: "delivered" };
	if (turns.length === 0) return { status: "excluded", why: "no turn ran" };
	if (/^Provisioning failed/.test(result.reason ?? ""))
		return { status: "excluded", why: "provisioning" };
	if (authFailures) return { status: "excluded", why: "gateway auth" };
	if (networkFailure) return { status: "excluded", why: "network" };
	if (providerOverloaded) return { status: "excluded", why: "provider overloaded" };
	return { status: "failed" };
}

function checkModel(result, model) {
	const turns = result.turns ?? [];
	if (turns.length === 0) return { verified: true, labels: [], served: [] };
	const labels = [...new Set(turns.map((turn) => turn.model))];
	const served = [...new Set(turns.flatMap((turn) => turn.servedModels ?? []))];
	if (!labels.every((id) => id === model)) {
		return { verified: false, labels, served, why: `worker built with ${labels.join(", ")}` };
	}
	// The gateway may add a date suffix to the id it reports. A split choice
	// (`<design>><build>`) is served by either of its models; a helper
	// (`<build>+<helper>`) runs inside tools, so its steps are not reported here.
	// Speed tags (`:fast`, `:low`) change requests, not models.
	const allowed = model.split(":")[0].split(/[>+]/).map(bareModel);
	if (
		served.length === 0 ||
		!served.every((id) => allowed.some((bare) => bareModel(id).startsWith(bare)))
	) {
		return {
			verified: false,
			labels,
			served,
			why: `gateway served ${served.join(", ") || "nothing"}`,
		};
	}
	return { verified: true, labels, served };
}

const trialIdFor = (block, model) =>
	`b${String(block.block).padStart(2, "0")}-${block.brief}-r${block.rep}-${slug(model)}`;

async function runTrial(block, model) {
	const trialId = trialIdFor(block, model);
	if (done.has(trialId)) return;
	const dir = join(root, trialId);
	mkdirSync(dir, { recursive: true });
	const startedAt = Date.now();
	const result = await runSmoke(block, model, dir);
	const finishedAt = Date.now();
	let shots = [];
	if (result.previewUrl) {
		shots = await captureSite(
			result.previewUrl,
			result.publicSiteAudit?.checkedPaths ?? ["/"],
			join(dir, "shots"),
		).catch((error) => [{ error: error instanceof Error ? error.message : String(error) }]);
	}
	const modelCheck = checkModel(result, model);
	const { status, why } = classify(result, modelCheck);
	const record = {
		trialId,
		block: block.block,
		rep: block.rep,
		brief: block.brief,
		model,
		status,
		...(why ? { excludedBecause: why } : {}),
		startedAt,
		runnerWallMs: finishedAt - startedAt,
		ok: result.ok === true,
		reason: result.reason,
		projectId: result.projectId,
		previewUrl: result.previewUrl,
		modelVerified: modelCheck.verified,
		turnModels: modelCheck.labels,
		servedModels: modelCheck.served,
		questionnaireObserved: result.questionnaireObserved,
		elapsedMs: result.elapsedMs,
		initialBuildBenchmark: result.initialBuildBenchmark,
		publicSiteAudit: result.publicSiteAudit && {
			success: result.publicSiteAudit.success,
			checkedPaths: result.publicSiteAudit.checkedPaths,
			issues: result.publicSiteAudit.issues,
		},
		turns: result.turns,
		totals: result.totals,
		shots,
	};
	appendFileSync(trialsFile, `${JSON.stringify(record)}\n`);
	console.error(
		`[b${block.block} ${block.brief} ${slug(model)}] ${status}${why ? ` (${why})` : ""}` +
			`${record.ok ? "" : `: ${record.reason}`} in ${Math.round(record.runnerWallMs / 1000)}s`,
	);
}

// The sandbox image is amd64. If emulation is broken, every trial in a block
// fails to provision, so check before launching one.
function emulationWorks() {
	try {
		return (
			execFileSync(
				"docker",
				["run", "--rm", "--platform", "linux/amd64", "alpine", "uname", "-m"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 120_000,
				},
			).trim() === "x86_64"
		);
	} catch {
		return false;
	}
}

function ensureEmulation() {
	if (emulationWorks()) return;
	if (!values["heal-emulation"]) {
		throw new Error("amd64 emulation is broken; restart Colima or rerun with --heal-emulation.");
	}
	console.error("amd64 emulation is broken; restarting Colima");
	execFileSync("colima", ["restart"], { stdio: "ignore", timeout: 300_000 });
	if (!emulationWorks()) throw new Error("amd64 emulation is still broken after a Colima restart.");
}

// A block's sandboxes keep running for the app's 10-minute idle stop after their
// last capture. With --wait-idle the next block waits for that stop (up to 20
// minutes), so it starts on an idle machine and no block inherits another's load.
function runningSandboxes() {
	try {
		return execFileSync(
			"docker",
			["ps", "--filter", "name=workerd-emdash-build-Sandbox-", "--format", "{{.Names}}"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
		)
			.split("\n")
			.filter((name) => name && !name.endsWith("-proxy")).length;
	} catch (error) {
		console.error(`could not list sandboxes, so not waiting: ${error.message}`);
		return 0;
	}
}

async function waitForIdleMachine(block, attempt) {
	const started = Date.now();
	let running = runningSandboxes();
	if (running > 0) console.error(`waiting for ${running} sandbox(es) from earlier blocks to stop`);
	while (running > 0 && Date.now() - started < 20 * 60_000) {
		await new Promise((resolve) => setTimeout(resolve, 15_000));
		running = runningSandboxes();
	}
	appendFileSync(
		join(root, "block-starts.jsonl"),
		`${JSON.stringify({ block: block.block, attempt, startedAt: new Date().toISOString(), waitedMs: Date.now() - started, stillRunning: running })}\n`,
	);
}

// Emulation can break mid-block: running processes go on, but every new one in
// the sandbox fails, and a build still running then crashes (its turn ends in
// an error such as a failed checkpoint). A block with such a crash reruns
// whole. A model that finished its turn and failed the checks keeps that
// failure, so a coincident breakage never gives it a second chance.
for (const block of design.blocks) {
	for (let attempt = 1; ; attempt += 1) {
		if (block.launchOrder.every((model) => done.has(trialIdFor(block, model)))) break;
		if (values["wait-idle"]) await waitForIdleMachine(block, attempt);
		ensureEmulation();
		console.error(`block ${block.block}/${design.blocks.length}: ${block.brief} rep ${block.rep}`);
		await Promise.all(block.launchOrder.map((model) => runTrial(block, model)));
		if (emulationWorks()) break;
		const crashed = readTrials().filter(
			(trial) =>
				trial.block === block.block &&
				trial.status === "failed" &&
				(trial.turns ?? []).some(
					(turn) => turn.kind === "initial-build" && turn.outcome === "error",
				),
		);
		if (crashed.length === 0) break;
		if (attempt >= 3)
			throw new Error(`amd64 emulation broke during block ${block.block} three times.`);
		supersedeBlocks(new Set([block.block]), "amd64 emulation broke during the block");
	}
}
const excluded = readTrials().filter((trial) => trial.status === "excluded");
console.error(
	excluded.length
		? `done with ${excluded.length} excluded trials; rerun their blocks with --rerun-excluded`
		: `done: ${trialsFile}`,
);
