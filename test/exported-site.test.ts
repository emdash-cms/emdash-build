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

describe("exported site Node requirement", () => {
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
