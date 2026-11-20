import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

const localOnlyDevRoutes = new Set([
	"/_emdash/api/setup/dev-bypass",
	"/_emdash/api/setup/dev-reset",
	// EmDash 1.3+: the dev server runs scheduled maintenance through this route.
	"/_emdash/api/dev/scheduled-tasks",
	// What that maintenance published, which the builder reads to refresh its preview.
	"/_emdash-build/scheduled-publishes",
]);
// Counted here: EmDash's own maintenance route does not say what it published.
// Kept on globalThis, which outlives the dev server's reloads of this module.
const scheduledPublishes = ((
	globalThis as { emdashBuildScheduledPublishes?: { boot: string; published: number } }
).emdashBuildScheduledPublishes ??= { boot: "", published: 0 });
const fetchHandler = handler.fetch;
if (!fetchHandler) throw new Error("The EmDash Worker handler is missing fetch().");

const loopbackHosts = new Set(["localhost", "127.0.0.1"]);

/**
 * Whether a request comes from inside the container. The preview sends public
 * traffic to localhost too, so the public host shows only in X-Forwarded-Host.
 */
function isLoopbackRequest(request: Request, url: URL): boolean {
	if (!loopbackHosts.has(url.hostname)) return false;
	const forwarded = request.headers.get("X-Forwarded-Host");
	if (!forwarded) return true;
	return forwarded
		.split(",")
		.every((host) => loopbackHosts.has(host.trim().replace(/:\d+$/, "").toLowerCase()));
}

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
		if (localOnlyDevRoutes.has(routePath) && !isLoopbackRequest(request, url)) {
			return new Response("Not found", { status: 404 });
		}
		if (routePath === "/_emdash-build/scheduled-publishes") {
			// Random values cannot be made at startup, so the first request names this run.
			scheduledPublishes.boot ||= crypto.randomUUID();
			return Response.json(scheduledPublishes, { headers: { "Cache-Control": "no-store" } });
		}
		if (
			routePath === "/_emdash/api/dev/scheduled-tasks" &&
			request.method === "POST" &&
			import.meta.env.DEV
		) {
			// The sweep EmDash's route runs, keeping the count of what it published.
			const { runScheduledTasks } = await import("emdash/middleware");
			const { published } = await runScheduledTasks();
			scheduledPublishes.boot ||= crypto.randomUUID();
			scheduledPublishes.published += published.length;
			return new Response(null, { status: 204 });
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
