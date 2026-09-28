import { describe, expect, it } from "vitest";
import { publicPublishingEnabled } from "../src/worker/publication-config.js";

describe("public publication configuration", () => {
	it("fails closed unless explicitly enabled", () => {
		for (const value of [undefined, null, "", "false", "TRUE", true, 1]) {
			expect(publicPublishingEnabled(value)).toBe(false);
		}
		expect(publicPublishingEnabled("true")).toBe(true);
	});
});
