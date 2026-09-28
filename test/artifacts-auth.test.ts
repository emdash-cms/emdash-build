import { describe, expect, it } from "vitest";
import { artifactsGitEnv, redactArtifactsToken } from "../src/worker/artifacts-auth.js";

describe("Artifacts Git authentication", () => {
	it("configures Git HTTP auth through the command environment", () => {
		const token = "art_v2_x_example?expires=1234567890";
		expect(artifactsGitEnv(token)).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.extraHeader",
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
			GIT_TERMINAL_PROMPT: "0",
		});
	});

	it("redacts both token versions in SDK timeout and Git errors", () => {
		const message =
			"Command timed out: Authorization: Bearer art_v2_x_example?expires=1234567890; " +
			"previous art_v1_abc123?expires=1234567890";
		expect(redactArtifactsToken(message)).toBe(
			"Command timed out: Authorization: Bearer art_***; previous art_***",
		);
	});
});
