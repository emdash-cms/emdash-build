import { readFileSync } from "node:fs";

/** The worktree's `.dev.vars`, so the scripts reach the same gateway as `pnpm dev`. */
export function devVars() {
	const vars = {};
	for (const line of readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8").split(
		"\n",
	)) {
		const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
		if (match) vars[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
	}
	return vars;
}
