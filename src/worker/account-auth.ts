import type { AccountPrincipal, IdentityAdapter } from "../platform/identity.js";
import {
	AccessAssertionVerifier,
	AssertionIdentityAdapter,
	UnconfiguredIdentityAdapter,
} from "../platform/identity.js";
import { readCookie } from "./project-auth.js";

const LOGIN_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ACCOUNT_COOKIE = "__Host-emdash_session";
const DEV_ACCOUNT_COOKIE = "emdash_session";
const LOGIN_COOKIE = "__Host-emdash_login";
const DEV_LOGIN_COOKIE = "emdash_login";
const CLEANUP_LIMIT = 100;

export interface IdentityBindings {
	AUTH_DB?: D1Database;
	IDENTITY_BROKER_URL?: string;
	IDENTITY_ISSUER?: string;
	IDENTITY_AUDIENCE?: string;
}

export interface AccountSession {
	principal: AccountPrincipal;
	ownerKey: string;
	tokenHash: string;
	returnPath: string;
	claimGuestOwnerKey?: string;
	expiresAt: number;
}

export class AuthUnavailableError extends Error {}
export class AuthValidationError extends Error {}

function randomHex(byteLength = 32): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function accountOwnerKey(principal: AccountPrincipal): Promise<string> {
	return `account:${await sha256Hex(`emdash-account\0${JSON.stringify([principal.issuer, principal.subject])}`)}`;
}

export function validateReturnPath(value: unknown): string {
	if (value === undefined || value === null || value === "") return "/";
	if (typeof value !== "string") throw new AuthValidationError("Invalid return path.");
	if (value === "/") return value;
	if (
		/^\/s\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	) {
		return value;
	}
	throw new AuthValidationError("Invalid return path.");
}

export function isSecureRequest(request: Request): boolean {
	return new URL(request.url).protocol === "https:";
}

function cookieName(kind: "account" | "login", secure: boolean): string {
	if (kind === "account") return secure ? ACCOUNT_COOKIE : DEV_ACCOUNT_COOKIE;
	return secure ? LOGIN_COOKIE : DEV_LOGIN_COOKIE;
}

function serializeCookie(name: string, value: string, maxAge: number, secure: boolean): string {
	return [
		`${name}=${encodeURIComponent(value)}`,
		"Path=/",
		"HttpOnly",
		...(secure ? ["Secure"] : []),
		"SameSite=Lax",
		`Max-Age=${maxAge}`,
	].join("; ");
}

export function serializeLoginCookie(value: string, secure: boolean): string {
	return serializeCookie(cookieName("login", secure), value, LOGIN_TTL_MS / 1000, secure);
}

export function serializeAccountCookie(value: string, secure: boolean): string {
	return serializeCookie(cookieName("account", secure), value, SESSION_TTL_MS / 1000, secure);
}

export function clearAuthCookie(kind: "account" | "login", secure: boolean): string {
	return serializeCookie(cookieName(kind, secure), "", 0, secure);
}

export function readLoginNonce(request: Request): string | undefined {
	return readCookie(request, cookieName("login", isSecureRequest(request)));
}

export function readAccountToken(request: Request): string | undefined {
	return readCookie(request, cookieName("account", isSecureRequest(request)));
}

export function resolveIdentityBrokerUrl(request: Request, configuredUrl: string): URL {
	return configuredUrl === "request-origin"
		? new URL("/api/auth/callback", request.url)
		: new URL(configuredUrl);
}

export function requireSameOrigin(request: Request): void {
	const origin = request.headers.get("Origin");
	if (origin && origin !== new URL(request.url).origin) {
		throw new AuthValidationError("Cross-origin request rejected.");
	}
}

export function createIdentityAdapter(request: Request, env: IdentityBindings): IdentityAdapter {
	if (env.IDENTITY_BROKER_URL && env.IDENTITY_ISSUER && env.IDENTITY_AUDIENCE) {
		return new AssertionIdentityAdapter(
			resolveIdentityBrokerUrl(request, env.IDENTITY_BROKER_URL),
			new AccessAssertionVerifier(env.IDENTITY_ISSUER, env.IDENTITY_AUDIENCE),
		);
	}
	return new UnconfiguredIdentityAdapter();
}

export class AccountAuthStore {
	constructor(private readonly db: D1Database) {}

	static fromEnv(env: IdentityBindings): AccountAuthStore {
		if (!env.AUTH_DB) throw new AuthUnavailableError("Account authentication is not configured.");
		return new AccountAuthStore(env.AUTH_DB);
	}

	private async cleanup(now: number): Promise<void> {
		await this.db.batch([
			this.db
				.prepare(
					"DELETE FROM auth_login_attempts WHERE state_hash IN (SELECT state_hash FROM auth_login_attempts WHERE expires_at <= ? LIMIT ?)",
				)
				.bind(now, CLEANUP_LIMIT),
			this.db
				.prepare(
					"DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)",
				)
				.bind(now, CLEANUP_LIMIT),
			this.db
				.prepare(
					"DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE revoked_at IS NOT NULL ORDER BY revoked_at LIMIT ?)",
				)
				.bind(CLEANUP_LIMIT),
		]);
	}

	async createLoginAttempt(input: {
		guestOwnerKey?: string;
		returnPath: string;
		now?: number;
	}): Promise<{ state: string; nonce: string }> {
		const now = input.now ?? Date.now();
		const state = randomHex();
		const nonce = randomHex();
		await this.cleanup(now);
		await this.db
			.prepare(
				`INSERT INTO auth_login_attempts
				 (state_hash, nonce_hash, guest_owner_key, return_path, expires_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				await sha256Hex(state),
				await sha256Hex(nonce),
				input.guestOwnerKey ?? null,
				validateReturnPath(input.returnPath),
				now + LOGIN_TTL_MS,
				now,
			)
			.run();
		return { state, nonce };
	}

	async getLoginReturnPath(
		state: string,
		nonce: string,
		now = Date.now(),
	): Promise<string | undefined> {
		const row = await this.db
			.prepare(
				`SELECT return_path FROM auth_login_attempts
				 WHERE state_hash = ? AND nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
			)
			.bind(await sha256Hex(state), await sha256Hex(nonce), now)
			.first<{ return_path: string }>();
		return row ? validateReturnPath(row.return_path) : undefined;
	}

	async completeLogin(input: {
		state: string;
		nonce: string;
		principal: AccountPrincipal;
		now?: number;
	}): Promise<{ token: string; session: AccountSession }> {
		const now = input.now ?? Date.now();
		const token = randomHex();
		const stateHash = await sha256Hex(input.state);
		const nonceHash = await sha256Hex(input.nonce);
		const tokenHash = await sha256Hex(token);
		const ownerKey = await accountOwnerKey(input.principal);
		const expiresAt = now + SESSION_TTL_MS;
		await this.cleanup(now);
		const results = await this.db.batch([
			this.db
				.prepare(
					`UPDATE auth_login_attempts
					 SET consumed_at = ?, account_owner_key = ?, session_hash = ?
					 WHERE state_hash = ? AND nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
				)
				.bind(now, ownerKey, tokenHash, stateHash, nonceHash, now),
			this.db
				.prepare(
					`INSERT INTO auth_sessions
					 (token_hash, account_owner_key, issuer, subject, return_path,
					  claim_guest_owner_key, expires_at, created_at)
					 SELECT ?, ?, ?, ?, return_path, guest_owner_key, ?, ?
					 FROM auth_login_attempts WHERE state_hash = ? AND session_hash = ?`,
				)
				.bind(
					tokenHash,
					ownerKey,
					input.principal.issuer,
					input.principal.subject,
					expiresAt,
					now,
					stateHash,
					tokenHash,
				),
		]);
		if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
			throw new AuthValidationError("Invalid or expired login attempt.");
		}
		const row = await this.getSession(token, now);
		if (!row) throw new AuthValidationError("Account session was not created.");
		return { token, session: row };
	}

	async getSession(token: string, now = Date.now()): Promise<AccountSession | undefined> {
		const tokenHash = await sha256Hex(token);
		const row = await this.db
			.prepare(
				`SELECT account_owner_key, issuer, subject, return_path, claim_guest_owner_key, expires_at
				 FROM auth_sessions
				 WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
			)
			.bind(tokenHash, now)
			.first<{
				account_owner_key: string;
				issuer: string;
				subject: string;
				return_path: string;
				claim_guest_owner_key: string | null;
				expires_at: number;
			}>();
		if (!row) return undefined;
		return {
			principal: { kind: "account", issuer: row.issuer, subject: row.subject },
			ownerKey: row.account_owner_key,
			tokenHash,
			returnPath: row.return_path,
			claimGuestOwnerKey: row.claim_guest_owner_key ?? undefined,
			expiresAt: row.expires_at,
		};
	}

	async revokeSession(token: string, now = Date.now()): Promise<boolean> {
		const result = await this.db
			.prepare(
				"UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
			)
			.bind(now, await sha256Hex(token))
			.run();
		return (result.meta.changes ?? 0) === 1;
	}

	async isSessionHashLive(tokenHash: string, now = Date.now()): Promise<boolean> {
		const row = await this.db
			.prepare(
				"SELECT token_hash FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
			)
			.bind(tokenHash, now)
			.first();
		return Boolean(row);
	}

	async clearSessionGuestClaim(tokenHash: string, guestOwnerKey: string): Promise<void> {
		await this.db
			.prepare(
				"UPDATE auth_sessions SET claim_guest_owner_key = NULL WHERE token_hash = ? AND claim_guest_owner_key = ?",
			)
			.bind(tokenHash, guestOwnerKey)
			.run();
	}
}
