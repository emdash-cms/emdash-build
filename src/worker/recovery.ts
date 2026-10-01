const PREVIEW_TOKEN = /^[a-z0-9_]{1,16}$/;

export function previewTokenForRoute(bytes: Uint8Array, suffix?: string): string {
	if (bytes.length !== 8) throw new Error("A preview token needs eight random bytes.");
	if (suffix && !/^[a-z0-9]{2,4}$/.test(suffix)) {
		throw new Error("PREVIEW_ROUTE_SUFFIX must contain two to four lowercase letters or digits.");
	}
	const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return suffix ? `${random.slice(0, 16 - suffix.length)}${suffix}` : random;
}

/**
 * Recover the stable token embedded in a preview URL created before the
 * BuilderAgent began persisting the token separately. Keeping it means an SDK
 * upgrade or Sandbox restart can reactivate the same public URL.
 */
export function previewTokenFromUrl(
	previewUrl: string | undefined,
	sandboxId: string,
	port = 4321,
): string | undefined {
	if (!previewUrl) return undefined;
	try {
		const hostname = new URL(previewUrl).hostname.toLowerCase();
		const prefix = `${port}-${sandboxId.toLowerCase()}-`;
		if (!hostname.startsWith(prefix)) return undefined;
		const token = hostname.slice(prefix.length).split(".", 1)[0];
		return token && PREVIEW_TOKEN.test(token) ? token : undefined;
	} catch {
		return undefined;
	}
}
