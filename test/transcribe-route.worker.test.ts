import { applyD1Migrations, env, reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	createGuestToken,
	hashGuestToken,
	serializeGuestCookie,
} from "../src/worker/project-auth.js";
import type { ProjectCatalog } from "../src/worker/project-catalog.js";

const testEnv = env as typeof env & {
	AUTH_DB: D1Database;
	TEST_MIGRATIONS: D1Migration[];
	ProjectCatalog: DurableObjectNamespace<ProjectCatalog>;
};

describe("guest dictation route", () => {
	beforeEach(async () => {
		await reset();
		await applyD1Migrations(testEnv.AUTH_DB, testEnv.TEST_MIGRATIONS);
	});

	it("accepts active guest sessions without requiring an account", async () => {
		const unauthenticated = await exports.default.fetch(
			new Request("http://localhost/api/transcribe", {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "not audio",
			}),
		);
		expect(unauthenticated.status).toBe(401);

		const token = createGuestToken();
		const key = await hashGuestToken(token);
		await testEnv.ProjectCatalog.getByName(key).authorizeActiveGuest(key);
		const cookie = serializeGuestCookie(token, false).split(";", 1)[0];
		const guest = await exports.default.fetch(
			new Request("http://localhost/api/transcribe", {
				method: "POST",
				headers: { Cookie: cookie!, "Content-Type": "text/plain" },
				body: "not audio",
			}),
		);
		expect(guest.status).toBe(415);

		const crossOrigin = await exports.default.fetch(
			new Request("http://localhost/api/transcribe", {
				method: "POST",
				headers: { Cookie: cookie!, Origin: "https://other.example", "Content-Type": "text/plain" },
				body: "not audio",
			}),
		);
		expect(crossOrigin.status).toBe(403);
	});
});
