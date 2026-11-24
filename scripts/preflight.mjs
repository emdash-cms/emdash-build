import { spawnSync } from "node:child_process";
import { loadProviderConfig } from "./provider-config.mjs";

const path = process.env.EMDASH_PROVIDER_CONFIG ?? "provider.config.json";

function fail(message) {
	console.error(`preflight: ${message}`);
	process.exitCode = 1;
}

function commandAvailable(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return result.status === 0;
}

let config;
try {
	config = await loadProviderConfig(path);
} catch (error) {
	fail(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
// jsdom, which the unit tests run on, needs 24.15.
if (nodeMajor < 24 || (nodeMajor === 24 && nodeMinor < 15)) {
	fail(`Node 24.15+ is required; found ${process.versions.node}`);
}
if (!commandAvailable("docker", ["info"])) fail("a Docker-compatible daemon is required");
if (!commandAvailable("pnpm", ["exec", "wrangler", "whoami"])) {
	fail("Wrangler must be installed and authenticated");
}

if (!process.exitCode) console.log(`preflight: ${path} and local tooling are ready`);
