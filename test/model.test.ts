import { describe, expect, it } from "vitest";
import { BUILDER_MODEL_ID, BUILDER_PROVIDER_OPTIONS } from "../src/worker/model.js";

describe("builder model configuration", () => {
	it("uses Luna high without stored response references", () => {
		expect(BUILDER_MODEL_ID).toBe("openai/gpt-5.6-luna");
		expect(BUILDER_PROVIDER_OPTIONS).toEqual({
			openai: {
				forceReasoning: true,
				reasoningEffort: "high",
				reasoningSummary: "auto",
				store: false,
			},
		});
	});
});
