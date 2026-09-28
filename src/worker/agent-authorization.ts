export const INTERNAL_OWNER_HEADER = "X-EmDash-Internal-Owner";
export const INTERNAL_AUTH_HEADER = "X-EmDash-Internal-Auth";
export const INTERNAL_SESSION_HEADER = "X-EmDash-Internal-Session";
export const INTERNAL_EXPIRES_HEADER = "X-EmDash-Internal-Expires";

export interface VerifiedAgentAuth {
	ownerKey: string;
	kind: "guest" | "account";
	sessionHash?: string;
	expiresAt?: number;
}

export function withVerifiedAgentAuth(request: Request, auth: VerifiedAgentAuth): Request {
	const headers = new Headers(request.headers);
	for (const name of [
		INTERNAL_OWNER_HEADER,
		INTERNAL_AUTH_HEADER,
		INTERNAL_SESSION_HEADER,
		INTERNAL_EXPIRES_HEADER,
	]) {
		headers.delete(name);
	}
	headers.set(INTERNAL_OWNER_HEADER, auth.ownerKey);
	headers.set(INTERNAL_AUTH_HEADER, auth.kind);
	if (auth.sessionHash) headers.set(INTERNAL_SESSION_HEADER, auth.sessionHash);
	if (auth.expiresAt !== undefined) headers.set(INTERNAL_EXPIRES_HEADER, String(auth.expiresAt));
	return new Request(request, { headers });
}

export function readVerifiedAgentAuth(request: Request): VerifiedAgentAuth | undefined {
	const ownerKey = request.headers.get(INTERNAL_OWNER_HEADER);
	const kind = request.headers.get(INTERNAL_AUTH_HEADER);
	const sessionHash = request.headers.get(INTERNAL_SESSION_HEADER) ?? undefined;
	const rawExpiresAt = request.headers.get(INTERNAL_EXPIRES_HEADER);
	const expiresAt = rawExpiresAt === null ? undefined : Number(rawExpiresAt);
	if (!ownerKey) return undefined;
	if (kind !== "guest" && kind !== "account") return undefined;
	if (
		kind === "account" &&
		(!sessionHash || expiresAt === undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)
	) {
		return undefined;
	}
	if (kind === "guest" && (sessionHash || rawExpiresAt !== null)) return undefined;
	return { ownerKey, kind, sessionHash, expiresAt };
}
