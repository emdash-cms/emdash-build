export type ContentAuthority =
	| { kind: "sandbox" }
	| { kind: "importing"; operationId: string }
	| { kind: "production"; siteId: string; importDigest: string };

export type ContentTransfer =
	| { kind: "unavailable"; reason: "emdash-import-not-supported" }
	| {
			kind: "emdash-logical-snapshot";
			formatVersion: string;
			artifactId: string;
			digest: string;
	  };

export type CompatibilityVerdict =
	| { kind: "compatible" }
	| { kind: "blocked"; reason: string }
	| { kind: "unknown"; reason: string };

export interface CmsTarget {
	authority: "sandbox" | "production";
	mcpUrl: string;
	/** Server-side reference; never a credential value returned to the browser. */
	credentialRef: string;
}

export interface CmsTargetResolver {
	resolve(projectId: string): Promise<CmsTarget>;
}

export interface SchemaCompatibilityGate {
	check(siteId: string, releaseId: string): Promise<CompatibilityVerdict>;
}

export type ContentAuthorityEvent =
	| { type: "import-started"; operationId: string }
	| { type: "import-verified"; siteId: string; importDigest: string }
	| { type: "import-failed" };

const VERIFIED_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Authority changes only after a core-owned import has produced a verifiable
 * digest. Code deployment, candidate health, or MCP connection alone cannot
 * move content authority to production.
 */
export function reduceContentAuthority(
	state: ContentAuthority,
	event: ContentAuthorityEvent,
): ContentAuthority {
	switch (event.type) {
		case "import-started":
			return state.kind === "sandbox" && event.operationId
				? { kind: "importing", operationId: event.operationId }
				: state;
		case "import-verified":
			return state.kind === "importing" && event.siteId && VERIFIED_DIGEST.test(event.importDigest)
				? { kind: "production", siteId: event.siteId, importDigest: event.importDigest }
				: state;
		case "import-failed":
			return state.kind === "importing" ? { kind: "sandbox" } : state;
	}
}
