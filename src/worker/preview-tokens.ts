/**
 * Preview URL authorization: which token opens which port of a Sandbox. It is
 * stored under the 0.12 SDK's own key and format, so the URLs that SDK issued
 * keep working on the Sandbox Durable Object that replaces it.
 */

export const PORT_TOKENS_KEY = "portTokens";

type StoredTokens = Record<string, string | { token: string; name?: string }>;
export type PortTokens = Record<string, { token: string; name?: string }>;

const TOKEN = /^[a-z0-9_]{1,16}$/;

export function isPreviewPort(port: number): boolean {
	// The 0.12 control plane listened on 3000.
	return Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3000;
}

/** The stored tokens, with the oldest format (a bare token string) normalized. */
export async function readPortTokens(
	storage: Pick<DurableObjectStorage, "get">,
): Promise<PortTokens> {
	const stored = (await storage.get<StoredTokens>(PORT_TOKENS_KEY)) ?? {};
	return Object.fromEntries(
		Object.entries(stored).map(([port, entry]) => [
			port,
			typeof entry === "string" ? { token: entry } : entry,
		]),
	);
}

/** Authorize `token` for `port`. A token opens one port only. */
export async function writePortToken(
	storage: Pick<DurableObjectStorage, "transaction">,
	port: number,
	token: string,
	name?: string,
): Promise<void> {
	if (!isPreviewPort(port)) throw new Error(`Invalid preview port: ${port}`);
	if (!TOKEN.test(token)) {
		throw new Error("A preview token is 1-16 lowercase letters, digits or _.");
	}
	await storage.transaction(async (txn) => {
		const tokens = await readPortTokens(txn);
		const other = Object.entries(tokens).find(
			([existing, entry]) => entry.token === token && existing !== String(port),
		);
		if (other) throw new Error(`The token is already used by port ${other[0]}.`);
		tokens[String(port)] = { token, ...(name ? { name } : {}) };
		await txn.put(PORT_TOKENS_KEY, tokens);
	});
}

export async function deletePortToken(
	storage: Pick<DurableObjectStorage, "transaction">,
	port: number,
): Promise<void> {
	await storage.transaction(async (txn) => {
		const tokens = await readPortTokens(txn);
		if (!tokens[String(port)]) return;
		delete tokens[String(port)];
		await txn.put(PORT_TOKENS_KEY, tokens);
	});
}

/** Compare in constant time, so a response's timing says nothing about the token. */
function sameToken(expected: string, actual: string): boolean {
	const a = new TextEncoder().encode(expected);
	const b = new TextEncoder().encode(actual);
	let difference = a.length ^ b.length;
	for (let index = 0; index < a.length; index++) difference |= a[index]! ^ (b[index] ?? 0);
	return difference === 0;
}

export async function validatePortToken(
	storage: Pick<DurableObjectStorage, "get">,
	port: number,
	token: string,
): Promise<boolean> {
	const entry = (await readPortTokens(storage))[String(port)];
	return Boolean(entry) && sameToken(entry!.token, token);
}

/**
 * The public URL for a port, as the 0.12 SDK built it: HTTPS under the
 * preview hostname, or plain HTTP on the app's port for a local hostname.
 * A loopback address becomes `localhost`, whose subdomains also resolve
 * locally; an address cannot take a subdomain.
 */
export function previewUrl(
	port: number,
	sandboxId: string,
	hostname: string,
	token: string,
): string {
	const label = `${port}-${sandboxId.toLowerCase()}-${token}`;
	hostname = hostname.toLowerCase();
	const [host = "", appPort] = hostname.split(":");
	const loopback = host === "127.0.0.1" || host === "0.0.0.0";
	if (loopback || host === "localhost" || host.endsWith(".localhost")) {
		return `http://${label}.${loopback ? "localhost" : host}${appPort ? `:${appPort}` : ""}/`;
	}
	return `https://${label}.${hostname}/`;
}
