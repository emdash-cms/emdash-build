import {
	AccountAuthStore,
	AuthUnavailableError,
	AuthValidationError,
	clearAuthCookie,
	createIdentityAdapter,
	isSecureRequest,
	readAccountToken,
	readLoginNonce,
	requireSameOrigin,
	serializeAccountCookie,
	serializeLoginCookie,
	validateReturnPath,
	type IdentityBindings,
} from "./account-auth.js";
import type { IdentityAdapter } from "../platform/identity.js";
import { clearGuestCookie, hashGuestToken, readGuestToken } from "./project-auth.js";
import { runClaimPass } from "./project-claim.js";

export type AccountAuthEnv = Env & IdentityBindings;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
	return Response.json(data, { status, headers });
}

async function authFailure(
	request: Request,
	env: AccountAuthEnv,
	state?: string | null,
	nonce?: string,
): Promise<Response> {
	let returnPath = "/";
	if (state && nonce) {
		try {
			returnPath =
				(await AccountAuthStore.fromEnv(env).getLoginReturnPath(state, nonce)) ?? returnPath;
		} catch {
			// Authentication failures stay generic even when auth storage is unavailable.
		}
	}
	const location = new URL(returnPath, request.url);
	location.searchParams.set("auth", "failed");
	return Response.redirect(location, 302);
}

export async function handleLoginStart(
	request: Request,
	env: AccountAuthEnv,
	identity?: IdentityAdapter,
): Promise<Response> {
	try {
		requireSameOrigin(request);
		const store = AccountAuthStore.fromEnv(env);
		const accountToken = readAccountToken(request);
		if (accountToken && (await store.getSession(accountToken))) {
			return json({ authenticated: true });
		}
		const body: { returnTo?: unknown; projectIds?: unknown } = await request
			.json<{ returnTo?: unknown; projectIds?: unknown }>()
			.catch(() => ({}));
		const returnPath = validateReturnPath(body.returnTo);
		const guestToken = readGuestToken(request);
		let guestOwnerKey = guestToken ? await hashGuestToken(guestToken) : undefined;
		let staleGuest = false;
		if (
			guestOwnerKey &&
			!(await env.ProjectCatalog.getByName(guestOwnerKey).authorizeActiveGuest(guestOwnerKey))
		) {
			guestOwnerKey = undefined;
			staleGuest = true;
		}
		if (body.projectIds !== undefined) {
			if (!Array.isArray(body.projectIds) || body.projectIds.length > 20) {
				throw new AuthValidationError("Invalid project candidates.");
			}
			const projectIds = [
				...new Set(
					body.projectIds.filter(
						(projectId): projectId is string =>
							typeof projectId === "string" && PROJECT_ID.test(projectId),
					),
				),
			];
			if (guestOwnerKey) {
				const catalog = env.ProjectCatalog.getByName(guestOwnerKey);
				await Promise.all(
					projectIds.map(async (projectId) => {
						const summary =
							await env.BuilderAgent.getByName(projectId).getClaimableProjectSummary(guestOwnerKey);
						if (summary) await catalog.reconcileProject(guestOwnerKey, summary);
					}),
				);
			}
		}
		const attempt = await store.createLoginAttempt({
			guestOwnerKey,
			returnPath,
		});
		const callbackUrl = new URL("/api/auth/callback", request.url);
		const adapter = identity ?? createIdentityAdapter(request, env);
		const url = await adapter.beginLogin({ state: attempt.state, callbackUrl });
		const response = json({ authenticated: false, url: url.href }, 200, {
			"Set-Cookie": serializeLoginCookie(attempt.nonce, isSecureRequest(request)),
		});
		if (staleGuest) {
			response.headers.append("Set-Cookie", clearGuestCookie(isSecureRequest(request)));
		}
		return response;
	} catch (error) {
		if (error instanceof AuthUnavailableError) return json({ error: error.message }, 503);
		if (error instanceof AuthValidationError) return json({ error: error.message }, 400);
		return json({ error: "Authentication could not be started." }, 503);
	}
}

export async function handleLoginCallback(
	request: Request,
	env: AccountAuthEnv,
	identity?: IdentityAdapter,
): Promise<Response> {
	const secure = isSecureRequest(request);
	const state = new URL(request.url).searchParams.get("state");
	const nonce = readLoginNonce(request);
	try {
		if (!state || !nonce) return authFailure(request, env);
		const principal = await (identity ?? createIdentityAdapter(request, env)).resolveCallback(
			request,
		);
		if (!principal) return authFailure(request, env, state, nonce);
		const { token } = await AccountAuthStore.fromEnv(env).completeLogin({
			state,
			nonce,
			principal,
		});
		const response = new Response(null, {
			status: 302,
			headers: { Location: new URL("/auth/complete", request.url).href },
		});
		response.headers.append("Set-Cookie", serializeAccountCookie(token, secure));
		response.headers.append("Set-Cookie", clearAuthCookie("login", secure));
		response.headers.set("Cache-Control", "no-store");
		return response;
	} catch (error) {
		console.error(
			"[account-auth] callback failed",
			error instanceof Error ? error.message : "unknown error",
		);
		return authFailure(request, env, state, nonce);
	}
}

export async function handleCurrentAccount(
	request: Request,
	env: AccountAuthEnv,
): Promise<Response> {
	const token = readAccountToken(request);
	if (!token) return json({ authenticated: false }, 200, { "Cache-Control": "no-store" });
	try {
		const session = await AccountAuthStore.fromEnv(env).getSession(token);
		if (!session) {
			return json({ authenticated: false }, 200, {
				"Cache-Control": "no-store",
				"Set-Cookie": clearAuthCookie("account", isSecureRequest(request)),
			});
		}
		return json(
			{
				authenticated: true,
				claimStatus: session.claimGuestOwnerKey ? "available" : "complete",
				returnPath: session.returnPath,
			},
			200,
			{ "Cache-Control": "no-store" },
		);
	} catch (error) {
		return json(
			{
				error: error instanceof AuthUnavailableError ? error.message : "Account state unavailable.",
			},
			503,
		);
	}
}

export async function handleClaim(request: Request, env: AccountAuthEnv): Promise<Response> {
	try {
		requireSameOrigin(request);
		const token = readAccountToken(request);
		if (!token) return json({ error: "Account session required." }, 401);
		const store = AccountAuthStore.fromEnv(env);
		const session = await store.getSession(token);
		if (!session) return json({ error: "Account session required." }, 401);
		const result = await runClaimPass(env, session, store);
		return json({ ...result, returnPath: session.returnPath }, 200, {
			"Cache-Control": "no-store",
			...(result.status === "complete"
				? { "Set-Cookie": clearGuestCookie(isSecureRequest(request)) }
				: {}),
		});
	} catch (error) {
		if (error instanceof AuthValidationError) return json({ error: error.message }, 409);
		if (error instanceof AuthUnavailableError) return json({ error: error.message }, 503);
		console.error(
			"[account-auth] claim failed",
			error instanceof Error ? error.message : "unknown error",
		);
		return json({ error: "Project claim is temporarily unavailable." }, 503);
	}
}

export async function handleLogout(request: Request, env: AccountAuthEnv): Promise<Response> {
	try {
		requireSameOrigin(request);
		const token = readAccountToken(request);
		if (token) {
			const store = AccountAuthStore.fromEnv(env);
			const session = await store.getSession(token);
			if (session) {
				const fenced = await env.ProjectCatalog.getByName(session.ownerKey).beginSessionRevocation(
					session.ownerKey,
					session.tokenHash,
					session.expiresAt,
				);
				if (!fenced) throw new Error("Account session revocation could not start.");
			}
			await store.revokeSession(token);
		}
		return json({ ok: true }, 200, {
			"Cache-Control": "no-store",
			"Set-Cookie": clearAuthCookie("account", isSecureRequest(request)),
		});
	} catch (error) {
		if (error instanceof AuthValidationError) return json({ error: error.message }, 400);
		if (error instanceof AuthUnavailableError) return json({ error: error.message }, 503);
		return json({ error: "Logout failed." }, 503);
	}
}
