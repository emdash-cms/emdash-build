const SECURE_GUEST_COOKIE = "__Host-emdash_guest";
const LOCAL_GUEST_COOKIE = "emdash_guest_local";
const GUEST_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function guestCookieName(secure: boolean): string {
	return secure ? SECURE_GUEST_COOKIE : LOCAL_GUEST_COOKIE;
}

function isLocalHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1";
}

export function httpsRedirectForRequest(request: Request): URL | undefined {
	const url = new URL(request.url);
	if (url.protocol !== "http:" || isLocalHostname(url.hostname)) return undefined;
	url.protocol = "https:";
	return url;
}

export function readCookie(request: Request, name: string): string | undefined {
	const header = request.headers.get("Cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [rawName, ...rawValue] = part.trim().split("=");
		if (rawName === name) return decodeURIComponent(rawValue.join("="));
	}
	return undefined;
}

export function readGuestToken(request: Request): string | undefined {
	const url = new URL(request.url);
	if (url.protocol === "https:") return readCookie(request, SECURE_GUEST_COOKIE);
	if (isLocalHostname(url.hostname)) {
		return readCookie(request, LOCAL_GUEST_COOKIE);
	}
	return undefined;
}

export function createGuestToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function hashGuestToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
		"",
	);
}

export function serializeGuestCookie(token: string, secure: boolean): string {
	return [
		`${guestCookieName(secure)}=${encodeURIComponent(token)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Strict",
		`Max-Age=${GUEST_COOKIE_MAX_AGE_SECONDS}`,
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function clearGuestCookie(secure: boolean): string {
	return [
		`${guestCookieName(secure)}=`,
		"Path=/",
		"HttpOnly",
		"SameSite=Strict",
		"Max-Age=0",
		...(secure ? ["Secure"] : []),
	].join("; ");
}

/** Extract the BuilderAgent instance name from an Agents SDK route. */
export function projectIdFromAgentPath(pathname: string): string | undefined {
	const match = pathname.match(/^\/agents\/(?:builder-agent|BuilderAgent)\/([^/]+)(?:\/|$)/);
	if (!match?.[1]) return undefined;
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return undefined;
	}
}

/** Constant-work comparison for persisted bearer-token digests. */
export function equalTokenDigest(left: string, right: string): boolean {
	let difference = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}
