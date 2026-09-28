import { describe, expect, it } from "vitest";
import { isCompletePublicHtml } from "../src/worker/public-site-audit.js";

describe("complete public HTML", () => {
	it("accepts a finished page", () => {
		expect(isCompletePublicHtml("<!doctype html><html><body><main>Site</main></body></html>")).toBe(
			true,
		);
	});

	it.each([
		"",
		" ",
		"<head><title>Site</title>",
		"<html><body>Half",
		"<html><body></body></html>",
		"<html><body><script>Site</script></body></html>",
		"<html><body><main></main></body></html>",
	])("rejects empty or incomplete output: %s", (html) =>
		expect(isCompletePublicHtml(html)).toBe(false),
	);
});
