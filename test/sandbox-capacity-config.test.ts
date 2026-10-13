import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

describe("sandbox capacity configuration", () => {
	it("caps production through the app and Worker Previews through the platform, at the same number", () => {
		const platform = [...wrangler.matchAll(/"max_instances": (\d+)/g)].map((match) => match[1]);
		const app = [...wrangler.matchAll(/"SANDBOX_MAX_CONCURRENT": "(\d+)"/g)].map(
			(match) => match[1],
		);
		// Production first, then Worker Previews, which stay on the default policy.
		expect(app).toEqual(["100", "10"]);
		expect(platform).toEqual(["10"]);
		expect(wrangler).toContain('"scheduling_policy": "durable_object"');
		expect(wrangler).toContain('"SANDBOX_SCHEDULING_POLICY": "default"');
	});
});
