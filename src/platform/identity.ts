import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Principal } from "./contracts.js";

export type AccountPrincipal = Extract<Principal, { kind: "account" }>;

export interface IdentityLoginInput {
	state: string;
	callbackUrl: URL;
}

/**
 * Hosting-provider identity seam. The builder never treats request headers as
 * identity unless a configured adapter has cryptographically verified them.
 */
export interface IdentityAdapter {
	resolveCallback(request: Request): Promise<AccountPrincipal | undefined>;
	beginLogin(input: IdentityLoginInput): Promise<URL>;
}

export interface IdentityAssertionVerifier {
	verify(assertion: string): Promise<{ issuer: string; subject: string }>;
}

/** Cloudflare Access JWT verifier using the rotating account JWKS. */
export class AccessAssertionVerifier implements IdentityAssertionVerifier {
	private readonly getKey: JWTVerifyGetKey;

	constructor(
		private readonly issuer: string,
		private readonly audience: string,
		getKey?: JWTVerifyGetKey,
	) {
		this.getKey =
			getKey ?? createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/cdn-cgi/access/certs`));
	}

	async verify(assertion: string): Promise<{ issuer: string; subject: string }> {
		const { payload } = await jwtVerify(assertion, this.getKey, {
			issuer: this.issuer,
			audience: this.audience,
			algorithms: ["RS256"],
			requiredClaims: ["exp", "nbf"],
		});
		if (payload.type !== "app") throw new Error("Identity assertion type is invalid.");
		if (typeof payload.sub !== "string" || !payload.sub.trim()) {
			throw new Error("Identity assertion subject is missing.");
		}
		return { issuer: this.issuer, subject: payload.sub };
	}
}

/** Access-compatible boundary with verification injected by the auth broker. */
export class AssertionIdentityAdapter implements IdentityAdapter {
	constructor(
		private readonly loginEndpoint: URL,
		private readonly verifier: IdentityAssertionVerifier,
	) {}

	async resolveCallback(request: Request): Promise<AccountPrincipal | undefined> {
		const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
		if (!assertion) return undefined;
		const identity = await this.verifier.verify(assertion);
		if (!identity.issuer || !identity.subject) throw new Error("Identity assertion is incomplete.");
		return { kind: "account", issuer: identity.issuer, subject: identity.subject };
	}

	async beginLogin(input: IdentityLoginInput): Promise<URL> {
		const url = new URL(this.loginEndpoint);
		if (url.origin !== input.callbackUrl.origin || url.pathname !== input.callbackUrl.pathname) {
			throw new Error("Identity login endpoint must match the callback URL.");
		}
		url.searchParams.set("state", input.state);
		return url;
	}
}

/** Default production behavior is fail closed until an identity provider is configured. */
export class UnconfiguredIdentityAdapter implements IdentityAdapter {
	async resolveCallback(_request: Request): Promise<undefined> {
		return undefined;
	}

	async beginLogin(_input: IdentityLoginInput): Promise<never> {
		throw new Error("No identity provider is configured.");
	}
}
