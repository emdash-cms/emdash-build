import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEDULED_PUBLISHES_PATH } from "../src/worker/preview-cache.js";
import { CANONICAL_WORKER_TS } from "../src/worker/tools.js";

const scaffoldWorker = readFileSync(
	new URL("../prototype/builder-cloudflare/src/worker.ts", import.meta.url),
	"utf8",
);

describe("the site worker entry", () => {
	it("is the one the builder writes into every site", () => {
		// startDevServer restores CANONICAL_WORKER_TS over any site's copy, new or old.
		expect(scaffoldWorker).toBe(CANONICAL_WORKER_TS);
	});

	it("lists EmDash's development-only routes as local-only", () => {
		const localOnly = /const localOnlyDevRoutes = new Set\(\[([^\]]*)\]\)/.exec(
			CANONICAL_WORKER_TS,
		)?.[1];
		expect(localOnly).toContain('"/_emdash/api/setup/dev-bypass"');
		expect(localOnly).toContain('"/_emdash/api/setup/dev-reset"');
		// EmDash 1.3 added an unauthenticated maintenance route that its dev server calls on localhost.
		expect(localOnly).toContain('"/_emdash/api/dev/scheduled-tasks"');
		// The Sandbox reads what that maintenance published from the container's loopback.
		expect(localOnly).toContain(JSON.stringify(SCHEDULED_PUBLISHES_PATH));
		expect(CANONICAL_WORKER_TS).toContain(
			`routePath === ${JSON.stringify(SCHEDULED_PUBLISHES_PATH)}`,
		);
	});
});
