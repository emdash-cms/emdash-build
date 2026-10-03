/**
 * Routes public preview hosts (`<port>-<project uuid>-<token>.<preview hostname>`)
 * to the project's Sandbox Durable Object. It runs first in the Worker, before
 * any other routing, so preview traffic never reaches the app.
 */

/** Headers the router sets for the Sandbox; a client's own copies are always dropped. */
export const PREVIEW_PROXY_HEADER = "x-sandbox-preview-proxy";
export const PREVIEW_PORT_HEADER = "x-sandbox-preview-port";
export const PREVIEW_TOKEN_HEADER = "x-sandbox-preview-token";
export const PREVIEW_SANDBOX_ID_HEADER = "x-sandbox-preview-sandbox-id";
const PREVIEW_HEADERS = [
	PREVIEW_PROXY_HEADER,
	PREVIEW_PORT_HEADER,
	PREVIEW_TOKEN_HEADER,
	PREVIEW_SANDBOX_ID_HEADER,
];

const PREVIEW_LABEL =
	/^([1-9]\d{3,4})-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([a-z0-9_]{1,16})$/;

export interface PreviewRoute {
	port: number;
	sandboxId: string;
	token: string;
}

/**
 * The preview route a host names, or undefined. Only hosts directly under the
 * preview hostname (or a `localhost` name in local development) can name one,
 * so other traffic on a shared zone never wakes a Sandbox.
 */
export function parsePreviewHost(
	url: URL,
	previewHostname: string | undefined,
): PreviewRoute | undefined {
	// A fully qualified name ends in a dot; the preview is the same host.
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	const dot = host.indexOf(".");
	if (dot < 0) return undefined;
	const parent = host.slice(dot + 1);
	const local = parent === "localhost" || parent.endsWith(".localhost");
	// Without a preview hostname only local previews route; nothing else may fail on it.
	if (!local && parent !== previewHostname?.toLowerCase()) return undefined;
	const match = PREVIEW_LABEL.exec(host.slice(0, dot));
	if (!match) return undefined;
	const port = Number(match[1]);
	// The Sandbox control plane listens on 3000.
	if (port < 1024 || port > 65535 || port === 3000) return undefined;
	return { port, sandboxId: match[2]!, token: match[3]! };
}

export async function routePreviewRequest(
	request: Request,
	env: Pick<Env, "Sandbox" | "PREVIEW_HOSTNAME">,
): Promise<Response | undefined> {
	const route = parsePreviewHost(new URL(request.url), env.PREVIEW_HOSTNAME);
	if (!route) return undefined;
	const headers = new Headers(request.headers);
	for (const name of PREVIEW_HEADERS) headers.delete(name);
	headers.set(PREVIEW_PROXY_HEADER, "1");
	headers.set(PREVIEW_PORT_HEADER, String(route.port));
	headers.set(PREVIEW_TOKEN_HEADER, route.token);
	headers.set(PREVIEW_SANDBOX_ID_HEADER, route.sandboxId);
	try {
		// The Sandbox checks the token itself, so a request costs one call.
		return await env.Sandbox.getByName(route.sandboxId).fetch(new Request(request, { headers }));
	} catch (error) {
		console.error("Preview routing failed:", error);
		return new Response("Preview routing failed", { status: 500 });
	}
}
