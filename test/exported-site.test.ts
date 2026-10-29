import { readFile } from "node:fs/promises";
import semver from "semver";
import { describe, expect, it } from "vitest";
import { EXPORTED_SITE_NODE_VERSIONS } from "../src/shared/exported-site.js";

function readScaffold(file: string): Promise<string> {
	return readFile(new URL(`../prototype/builder-cloudflare/${file}`, import.meta.url), "utf8");
}

async function scaffoldNodeRange(): Promise<string> {
	const manifest = JSON.parse(await readScaffold("package.json")) as { engines: { node: string } };
	return manifest.engines.node;
}

/** `engines.node` of each locked package, keyed by its lockfile name. */
function lockedNodeRanges(lockfile: string): Map<string, string> {
	const packages = lockfile.slice(
		lockfile.indexOf("\npackages:\n"),
		lockfile.indexOf("\nsnapshots:\n"),
	);
	const ranges = new Map<string, string>();
	for (const entry of packages.split(/\n(?=  \S)/)) {
		const name = entry
			.trim()
			.split("\n")[0]!
			.replace(/^'|'?:$/g, "");
		const node = entry.match(/^ {4}engines: \{[^}]*\bnode: '?([^,}']+)/m)?.[1];
		// sharp's optional 32-bit Windows build supports only Node 20, and pnpm
		// skips an optional build that cannot install.
		if (!node || name.startsWith("@img/sharp-win32-ia32@")) continue;
		ranges.set(name, node.trim());
	}
	return ranges;
}

describe("exported site Node requirement", () => {
	it("accepts no Node version a locked dependency rejects", async () => {
		const range = await scaffoldNodeRange();
		const ranges = lockedNodeRanges(await readScaffold("pnpm-lock.yaml"));
		expect(ranges.size).toBeGreaterThan(0);
		const rejecting = [...ranges].filter(([, dependency]) => !semver.subset(range, dependency));
		expect(rejecting).toEqual([]);
	});

	it("states each Node line the scaffold accepts", async () => {
		const lines = (await scaffoldNodeRange()).split("||").map((range) => {
			const floor = semver.minVersion(range)!;
			const version = floor.version.replace(/(\.0)+$/, "");
			return semver.satisfies(`${floor.major + 1}.0.0`, range)
				? `${version} and up`
				: `${floor.major} (${version} or later)`;
		});
		expect(EXPORTED_SITE_NODE_VERSIONS).toBe(
			new Intl.ListFormat("en", { type: "disjunction" }).format(lines),
		);
	});
});
