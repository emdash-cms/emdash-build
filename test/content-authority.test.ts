import { describe, expect, it } from "vitest";
import { reduceContentAuthority } from "../src/platform/content-authority.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("content authority", () => {
	it("cannot become production without an in-flight verified import", () => {
		expect(
			reduceContentAuthority(
				{ kind: "sandbox" },
				{ type: "import-verified", siteId: "site-1", importDigest: DIGEST },
			),
		).toEqual({ kind: "sandbox" });
	});

	it("moves to production only after a digest-verifiable import", () => {
		const importing = reduceContentAuthority(
			{ kind: "sandbox" },
			{ type: "import-started", operationId: "operation-1" },
		);
		expect(
			reduceContentAuthority(importing, {
				type: "import-verified",
				siteId: "site-1",
				importDigest: DIGEST,
			}),
		).toEqual({ kind: "production", siteId: "site-1", importDigest: DIGEST });
	});

	it("keeps the sandbox authoritative after failed or unverifiable import", () => {
		const importing = { kind: "importing", operationId: "operation-1" } as const;
		expect(
			reduceContentAuthority(importing, {
				type: "import-verified",
				siteId: "site-1",
				importDigest: "not-verifiable",
			}),
		).toEqual(importing);
		expect(reduceContentAuthority(importing, { type: "import-failed" })).toEqual({
			kind: "sandbox",
		});
	});
});
