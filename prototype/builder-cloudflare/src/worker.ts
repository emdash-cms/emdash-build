import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

const localOnlyDevRoutes = new Set([
	"/_emdash/api/setup/dev-bypass",
	"/_emdash/api/setup/dev-reset",
]);
const fetchHandler = handler.fetch;
if (!fetchHandler) throw new Error("The EmDash Worker handler is missing fetch().");

export default {
	...handler,
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		let routePath = url.pathname;
		for (let pass = 0; pass < 8; pass++) {
			let decoded: string;
			try {
				decoded = decodeURIComponent(routePath);
			} catch {
				return new Response("Bad request", { status: 400 });
			}
			if (decoded === routePath) break;
			if (pass === 7) return new Response("Bad request", { status: 400 });
			routePath = decoded;
		}
		if (routePath.length > 1) routePath = routePath.replace(/\/+$/, "");
		if (
			localOnlyDevRoutes.has(routePath) &&
			url.hostname !== "localhost" &&
			url.hostname !== "127.0.0.1"
		) {
			return new Response("Not found", { status: 404 });
		}
		const response = await fetchHandler(request, env, ctx);
		if (!response.headers.get("Content-Type")?.includes("text/html")) return response;
		const headers = new Headers(response.headers);
		headers.delete("X-Frame-Options");
		headers.delete("Content-Security-Policy");
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	},
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler<Env>;
