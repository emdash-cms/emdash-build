import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { EXPORTED_SITE_NODE_VERSIONS } from "../src/shared/exported-site.js";

describe("exported site Node requirement", () => {
	it("names the minimum of each range the scaffold's engines field accepts", async () => {
		const manifest = JSON.parse(
			await readFile(
				new URL("../prototype/builder-cloudflare/package.json", import.meta.url),
				"utf8",
			),
		) as { engines: { node: string } };
		const minimums = manifest.engines.node.split("||").map((range) =>
			range
				.trim()
				.replace(/^(\^|>=)/, "")
				.replace(/(\.0)+$/, ""),
		);
		expect(EXPORTED_SITE_NODE_VERSIONS.match(/\d+(\.\d+)*/g)).toEqual(minimums);
	});
});
