import { spawnSync } from "node:child_process";
import { loadProviderConfig } from "./provider-config.mjs";

const input = process.env.EMDASH_PROVIDER_CONFIG ?? "provider.config.json";
const config = await loadProviderConfig(input);
const environmentName = `${config.providerId}_emdash_build`.replace(/-/g, "_");
const wranglerConfig = `dist/${environmentName}/wrangler.json`;
const args = ["exec", "wrangler", "deploy", "-c", wranglerConfig];
if (process.env.EMDASH_PROVIDER_DRY_RUN === "1") args.push("--dry-run");
const result = spawnSync("pnpm", args, {
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
