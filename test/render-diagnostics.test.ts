import { describe, expect, it } from "vitest";
import { renderErrorSummary } from "../src/worker/render-diagnostics.js";

describe("dev-server render diagnostics", () => {
	it("keeps the actionable component error without its large stack", () => {
		expect(
			renderErrorSummary(
				"[ERROR] [vite] Uncaught exception: workerd: Unable to render RichText because it is undefined!\nstack: /home/user/site/node_modules/...",
			),
		).toBe("Unable to render RichText because it is undefined!");
	});

	it("keeps type errors and excludes ordinary server output", () => {
		expect(renderErrorSummary("ReferenceError: gallery is not defined\n  at render")).toBe(
			"ReferenceError: gallery is not defined",
		);
		expect(renderErrorSummary("[vite] connected and ready on port 4321")).toBeUndefined();
	});
});
