import { describe, expect, it } from "vitest";
import {
	isSandboxRuntimeReplacement,
	isSandboxWakeReset,
	previewTokenForRoute,
	previewTokenFromUrl,
} from "../src/worker/recovery.js";

describe("preview recovery", () => {
	it("keeps the production token random and supports an isolated preview route suffix", () => {
		const bytes = Uint8Array.from([0x42, 0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x78]);
		expect(previewTokenForRoute(bytes)).toBe("42a1b2c3d4e5f678");
		expect(previewTokenForRoute(bytes, "pr39")).toBe("42a1b2c3d4e5pr39");
		expect(() => previewTokenForRoute(bytes, "bad-long-suffix")).toThrow("PREVIEW_ROUTE_SUFFIX");
		expect(() => previewTokenForRoute(bytes.subarray(0, 7), "pr39")).toThrow("eight random bytes");
	});
	it("retains the token from a legacy stable preview URL", () => {
		expect(
			previewTokenFromUrl(
				"https://4321-a5d77155-5212-4828-8cd5-92fb5de38666-9e379fe9cab803de.build.emdashcms.com/",
				"a5d77155-5212-4828-8cd5-92fb5de38666",
			),
		).toBe("9e379fe9cab803de");
	});

	it("rejects URLs for another sandbox and invalid tokens", () => {
		expect(
			previewTokenFromUrl(
				"https://4321-other-9e379fe9cab803de.build.emdashcms.com/",
				"a5d77155-5212-4828-8cd5-92fb5de38666",
			),
		).toBeUndefined();
		expect(
			previewTokenFromUrl(
				"https://4321-a5d77155-5212-4828-8cd5-92fb5de38666-token-with-dashes.build.emdashcms.com/",
				"a5d77155-5212-4828-8cd5-92fb5de38666",
			),
		).toBeUndefined();
	});

	it("recognizes the Sandbox wake/reset failure", () => {
		expect(
			isSandboxWakeReset(
				new Error(
					"A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.",
				),
			),
		).toBe(true);
		expect(isSandboxWakeReset(new Error("git clone failed"))).toBe(false);
	});

	it("recognizes a Sandbox runtime replacement", () => {
		expect(
			isSandboxRuntimeReplacement({
				code: "OPERATION_INTERRUPTED",
				context: { reason: "runtime_replaced" },
			}),
		).toBe(true);
		expect(isSandboxRuntimeReplacement(new Error("runtime replaced"))).toBe(false);
	});
});
