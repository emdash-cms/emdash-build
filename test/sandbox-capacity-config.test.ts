import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

describe("sandbox capacity configuration", () => {
	it("gives the app-owned cap the same value as the platform cap, per environment", () => {
		const platform = [...wrangler.matchAll(/"max_instances": (\d+)/g)].map((match) => match[1]);
		const app = [...wrangler.matchAll(/"SANDBOX_MAX_CONCURRENT": "(\d+)"/g)].map(
			(match) => match[1],
		);
		// Production first, then Worker Previews.
		expect(platform).toEqual(["100", "10"]);
		expect(app).toEqual(platform);
	});
});
