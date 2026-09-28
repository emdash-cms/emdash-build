import { applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdentityAdapter } from "../src/platform/identity.js";
import {
	AccountAuthStore,
	AuthValidationError,
	accountOwnerKey,
} from "../src/worker/account-auth.js";
import {
	handleCurrentAccount,
	handleLoginCallback,
	handleLoginStart,
	handleLogout,
	type AccountAuthEnv,
} from "../src/worker/account-auth-routes.js";
import { resolveOwner } from "../src/worker/owner-auth.js";
import {
	createGuestToken,
	hashGuestToken,
	serializeGuestCookie,
} from "../src/worker/project-auth.js";
import type { BuilderAgent } from "../src/worker/agent.js";
import type { ProjectCatalog } from "../src/worker/project-catalog.js";

const testEnv = env as typeof env & {
	AUTH_DB: D1Database;
	TEST_MIGRATIONS: D1Migration[];
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
	ProjectCatalog: DurableObjectNamespace<ProjectCatalog>;
};

const testIdentity: IdentityAdapter = {
	async beginLogin({ state, callbackUrl }) {
		const url = new URL(callbackUrl);
		url.searchParams.set("state", state);
		return url;
	},
	async resolveCallback(request) {
		return request.headers.get("X-EmDash-Test-Identity") === "1"
			? { kind: "account", issuer: "https://issuer.test", subject: "test-user" }
			: undefined;
	},
};

describe("account auth storage", () => {
	beforeEach(async () => {
		await reset();
		await applyD1Migrations(testEnv.AUTH_DB, testEnv.TEST_MIGRATIONS);
	});

	it("consumes one browser-bound login attempt into a revocable session", async () => {
		const auth = new AccountAuthStore(testEnv.AUTH_DB);
		const principal = {
			kind: "account",
			issuer: "https://issuer.test",
			subject: "user-1",
		} as const;
		const attempt = await auth.createLoginAttempt({
			guestOwnerKey: "guest-owner",
			returnPath: "/s/11111111-1111-4111-8111-111111111111",
			now: 1_000,
		});

		const completed = await auth.completeLogin({ ...attempt, principal, now: 2_000 });
		expect(completed.session).toMatchObject({
			principal,
			ownerKey: await accountOwnerKey(principal),
			claimGuestOwnerKey: "guest-owner",
			returnPath: "/s/11111111-1111-4111-8111-111111111111",
		});
		expect(await auth.getSession(completed.token, 3_000)).toBeDefined();
		expect(await auth.revokeSession(completed.token, 4_000)).toBe(true);
		expect(await auth.getSession(completed.token, 5_000)).toBeUndefined();
	});

	it("does not consume state on a nonce mismatch and rejects callback replay", async () => {
		const auth = new AccountAuthStore(testEnv.AUTH_DB);
		const attempt = await auth.createLoginAttempt({ returnPath: "/", now: 1_000 });
		const principal = {
			kind: "account",
			issuer: "https://issuer.test",
			subject: "user-1",
		} as const;

		await expect(
			auth.completeLogin({ state: attempt.state, nonce: "wrong", principal, now: 2_000 }),
		).rejects.toBeInstanceOf(AuthValidationError);
		const completed = await auth.completeLogin({ ...attempt, principal, now: 2_100 });
		await expect(auth.completeLogin({ ...attempt, principal, now: 2_200 })).rejects.toBeInstanceOf(
			AuthValidationError,
		);
		expect(await auth.getSession(completed.token, 2_300)).toBeDefined();
	});

	it("rejects expired login attempts without creating a session", async () => {
		const auth = new AccountAuthStore(testEnv.AUTH_DB);
		const attempt = await auth.createLoginAttempt({ returnPath: "/", now: 1_000 });
		const principal = {
			kind: "account",
			issuer: "https://issuer.test",
			subject: "user-1",
		} as const;
		await expect(
			auth.completeLogin({ ...attempt, principal, now: 1_000 + 10 * 60 * 1000 }),
		).rejects.toBeInstanceOf(AuthValidationError);
	});

	it("uses bounded indexes for expired and revoked session cleanup", async () => {
		const expiredPlan = await testEnv.AUTH_DB.prepare(
			"EXPLAIN QUERY PLAN SELECT token_hash FROM auth_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?",
		)
			.bind(Date.now(), 100)
			.all<{ detail: string }>();
		const revokedPlan = await testEnv.AUTH_DB.prepare(
			"EXPLAIN QUERY PLAN SELECT token_hash FROM auth_sessions WHERE revoked_at IS NOT NULL ORDER BY revoked_at LIMIT ?",
		)
			.bind(100)
			.all<{ detail: string }>();
		expect(
			expiredPlan.results.some((row) => row.detail.includes("auth_sessions_expires_at_idx")),
		).toBe(true);
		expect(
			revokedPlan.results.some((row) => row.detail.includes("auth_sessions_revoked_at_idx")),
		).toBe(true);
	});
});

function cookiePair(setCookie: string): string {
	return setCookie.split(";", 1)[0] ?? "";
}

describe("account auth routes", () => {
	beforeEach(async () => {
		await reset();
		await applyD1Migrations(testEnv.AUTH_DB, testEnv.TEST_MIGRATIONS);
	});

	it("starts login, establishes a session, reports it, and revokes it", async () => {
		const routeEnv = testEnv as unknown as AccountAuthEnv;
		const start = await handleLoginStart(
			new Request("http://localhost/api/auth/login", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: "emdash_guest_local=guest-token",
				},
				body: JSON.stringify({ returnTo: "/s/11111111-1111-4111-8111-111111111111" }),
			}),
			routeEnv,
			testIdentity,
		);
		expect(start.status).toBe(200);
		const startData = await start.json<{ url: string }>();
		const loginCookie = cookiePair(start.headers.get("Set-Cookie")!);

		const callback = await handleLoginCallback(
			new Request(startData.url, {
				headers: { Cookie: loginCookie, "X-EmDash-Test-Identity": "1" },
			}),
			routeEnv,
			testIdentity,
		);
		expect(callback.status).toBe(302);
		expect(callback.headers.get("Location")).toBe("http://localhost/auth/complete");
		const accountCookie = callback.headers
			.getSetCookie()
			.map(cookiePair)
			.find((cookie) => cookie.startsWith("emdash_session="));
		expect(accountCookie).toBeDefined();

		const account = await handleCurrentAccount(
			new Request("http://localhost/api/auth/account", { headers: { Cookie: accountCookie! } }),
			routeEnv,
		);
		expect(await account.json()).toMatchObject({
			authenticated: true,
			claimStatus: "available",
			returnPath: "/s/11111111-1111-4111-8111-111111111111",
		});

		const accountToken = accountCookie!.split("=", 2)[1]!;
		const session = await new AccountAuthStore(testEnv.AUTH_DB).getSession(accountToken);
		expect(session).toBeDefined();
		const beginSessionRevocation = vi.fn().mockResolvedValue(true);
		const logoutEnv = {
			AUTH_DB: testEnv.AUTH_DB,
			ProjectCatalog: {
				getByName: () => ({ beginSessionRevocation }),
			},
		} as unknown as AccountAuthEnv;
		const logout = await handleLogout(
			new Request("http://localhost/api/auth/logout", {
				method: "POST",
				headers: { Cookie: accountCookie! },
			}),
			logoutEnv,
		);
		expect(logout.status).toBe(200);
		expect(beginSessionRevocation).toHaveBeenCalledWith(
			session!.ownerKey,
			session!.tokenHash,
			session!.expiresAt,
		);
		const afterLogout = await handleCurrentAccount(
			new Request("http://localhost/api/auth/account", { headers: { Cookie: accountCookie! } }),
			routeEnv,
		);
		expect(await afterLogout.json()).toEqual({ authenticated: false });
	});

	it("rejects callback replay without creating another session", async () => {
		const routeEnv = testEnv as unknown as AccountAuthEnv;
		const start = await handleLoginStart(
			new Request("http://localhost/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ returnTo: "/" }),
			}),
			routeEnv,
			testIdentity,
		);
		const data = await start.json<{ url: string }>();
		const headers = {
			Cookie: cookiePair(start.headers.get("Set-Cookie")!),
			"X-EmDash-Test-Identity": "1",
		};
		expect(
			(await handleLoginCallback(new Request(data.url, { headers }), routeEnv, testIdentity))
				.status,
		).toBe(302);
		expect(
			(
				await handleLoginCallback(new Request(data.url, { headers }), routeEnv, testIdentity)
			).headers.get("Location"),
		).toBe("http://localhost/?auth=failed");
		const count = await testEnv.AUTH_DB.prepare(
			"SELECT COUNT(*) AS count FROM auth_sessions",
		).first<{
			count: number;
		}>();
		expect(count?.count).toBe(1);
	});

	it("returns a failed live callback to its stored project path", async () => {
		const routeEnv = testEnv as unknown as AccountAuthEnv;
		const returnPath = "/s/11111111-1111-4111-8111-111111111111";
		const start = await handleLoginStart(
			new Request("http://localhost/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ returnTo: returnPath }),
			}),
			routeEnv,
			testIdentity,
		);
		const data = await start.json<{ url: string }>();
		const loginCookie = cookiePair(start.headers.get("Set-Cookie")!);

		const failed = await handleLoginCallback(
			new Request(data.url, { headers: { Cookie: loginCookie } }),
			routeEnv,
			testIdentity,
		);
		expect(failed.headers.get("Location")).toBe(`http://localhost${returnPath}?auth=failed`);

		const wrongBrowser = await handleLoginCallback(
			new Request(data.url, { headers: { Cookie: "emdash_login=wrong" } }),
			routeEnv,
			testIdentity,
		);
		expect(wrongBrowser.headers.get("Location")).toBe("http://localhost/?auth=failed");
	});

	it("does not attach a fenced guest to a new login attempt", async () => {
		const guestToken = createGuestToken();
		const guestKey = await hashGuestToken(guestToken);
		const catalog = testEnv.ProjectCatalog.getByName(guestKey);
		await catalog.authorizeActiveGuest(guestKey);
		await catalog.beginClaim(guestKey, "account:reserved", 100);
		await catalog.completeClaim("account:reserved");

		const response = await handleLoginStart(
			new Request("http://localhost/api/auth/login", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: serializeGuestCookie(guestToken, false).split(";", 1)[0]!,
				},
				body: JSON.stringify({ returnTo: "/" }),
			}),
			testEnv as unknown as AccountAuthEnv,
			testIdentity,
		);
		expect(response.status).toBe(200);
		expect(
			response.headers
				.getSetCookie()
				.some((cookie) => /emdash_guest_local=.*Max-Age=0/.test(cookie)),
		).toBe(true);
		const attempt = await testEnv.AUTH_DB.prepare(
			"SELECT guest_owner_key FROM auth_login_attempts ORDER BY created_at DESC LIMIT 1",
		).first<{ guest_owner_key: string | null }>();
		expect(attempt?.guest_owner_key).toBeNull();
	});

	it("preserves a pending first-turn fence while reconciling login candidates", async () => {
		const projectId = "11111111-1111-4111-8111-111111111111";
		const guestToken = createGuestToken();
		const guestKey = await hashGuestToken(guestToken);
		const agent = testEnv.BuilderAgent.getByName(projectId);
		await agent.initializeOwnership(guestKey);
		await runInDurableObject(agent, (instance) => {
			instance.messages = [
				{ id: "user-1", role: "user", parts: [{ type: "text", text: "Build a site" }] },
			];
		});
		const catalog = testEnv.ProjectCatalog.getByName(guestKey);
		expect(await catalog.beginProjectTurn(guestKey, projectId)).toBe(true);

		const response = await handleLoginStart(
			new Request("http://localhost/api/auth/login", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: serializeGuestCookie(guestToken, false).split(";", 1)[0]!,
				},
				body: JSON.stringify({ returnTo: `/s/${projectId}`, projectIds: [projectId] }),
			}),
			testEnv as unknown as AccountAuthEnv,
			testIdentity,
		);

		expect(response.status).toBe(200);
		expect(await catalog.listProjects()).toMatchObject([{ id: projectId }]);
		expect(await catalog.beginClaim(guestKey, "account:owner", 100)).toEqual({ status: "busy" });
	});
});

describe("owner resolution", () => {
	beforeEach(async () => {
		await reset();
		await applyD1Migrations(testEnv.AUTH_DB, testEnv.TEST_MIGRATIONS);
	});

	it("prefers a live account session over a guest and rejects fenced guests", async () => {
		const auth = new AccountAuthStore(testEnv.AUTH_DB);
		const now = Date.now();
		const attempt = await auth.createLoginAttempt({ returnPath: "/", now });
		const principal = {
			kind: "account",
			issuer: "https://issuer.test",
			subject: "user-1",
		} as const;
		const { token } = await auth.completeLogin({ ...attempt, principal, now: now + 1 });
		const guestToken = createGuestToken();
		const guestKey = await hashGuestToken(guestToken);
		const guest = testEnv.ProjectCatalog.getByName(guestKey);
		await guest.authorizeActiveGuest(guestKey);
		const cookie = `${serializeGuestCookie(guestToken, false).split(";", 1)[0]}; emdash_session=${token}`;
		const account = await resolveOwner(
			new Request("http://localhost/api/projects", { headers: { Cookie: cookie } }),
			testEnv,
		);
		expect(account.owner?.kind).toBe("account");

		await guest.beginClaim(guestKey, "account:owner", 100);
		await guest.completeClaim("account:owner");
		const stale = await resolveOwner(
			new Request("http://localhost/api/projects", {
				headers: { Cookie: serializeGuestCookie(guestToken, false).split(";", 1)[0]! },
			}),
			testEnv,
		);
		expect(stale).toEqual({ staleGuest: true });
	});
});
