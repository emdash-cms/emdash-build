// Lists a run's trials in which a sandbox command was killed for memory (exit
// code 137), from the local BuilderAgent SQLite stores. Such a kill is an
// environment fault, so its block reruns whole (run.mjs --rerun-block <n>).
// Run: node scripts/model-comparison/oom-check.mjs --run <name>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { run: { type: "string" } } });
if (!values.run) throw new Error("Usage: oom-check.mjs --run <name>");
const trials = readFileSync(join(".model-comparison", values.run, "trials.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const byProject = new Map(trials.map((trial) => [trial.projectId, trial]));

const dir = ".wrangler/state/v3/do/emdash-build-BuilderAgent";
const killed = [];
for (const file of readdirSync(dir)) {
	if (!file.endsWith(".sqlite") || file === "metadata.sqlite") continue;
	let db;
	try {
		db = new DatabaseSync(join(dir, file), { readOnly: true });
		const trial = byProject.get(db.prepare("select name from __miniflare_do_name").get()?.name);
		if (!trial) continue;
		for (const row of db.prepare("select message from cf_ai_chat_agent_messages").all()) {
			const message = JSON.parse(row.message);
			for (const part of message.parts ?? []) {
				if (!part.type?.startsWith("tool-") || part.output?.cached) continue;
				const output = part.output;
				if (output?.exitCode === 137 || /\bKilled\b/.test(String(output?.stderr ?? ""))) {
					killed.push({ block: trial.block, trialId: trial.trialId, tool: part.type.slice(5) });
				}
			}
		}
	} catch {
		// Not a builder store, or one still being written.
	} finally {
		db?.close();
	}
}
for (const kill of killed) console.log(JSON.stringify(kill));
const blocks = [...new Set(killed.map((kill) => kill.block))].sort((a, b) => a - b);
console.log(blocks.length ? `blocks to rerun: ${blocks.join(", ")}` : "no memory kills");
