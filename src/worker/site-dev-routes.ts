/**
 * Where the site's worker (CANONICAL_WORKER_TS) reports how many items EmDash's
 * scheduled maintenance has published, for the Sandbox to refresh the preview.
 */
export const SCHEDULED_PUBLISHES_PATH = "/_emdash-build/scheduled-publishes";

/**
 * The site's dev-only routes, which only the container itself may call. The
 * site's worker (CANONICAL_WORKER_TS) refuses them to everyone else and keeps
 * its own copy of this list; the preview router refuses them as well, so a
 * site still running an older worker is covered until its dev server restarts.
 */
export const SITE_DEV_ONLY_ROUTES: ReadonlySet<string> = new Set([
	"/_emdash/api/setup/dev-bypass",
	"/_emdash/api/setup/dev-reset",
	"/_emdash/api/dev/scheduled-tasks",
	SCHEDULED_PUBLISHES_PATH,
]);

/**
 * The path Astro routes on, as the site's worker reads it: decoded until it
 * stops changing, with `\` read as `/`, dot segments resolved and repeated
 * slashes collapsed. Null when the path will not decode.
 */
export function siteRoutePath(url: URL): string | null {
	const parsed = new URL("http://localhost/");
	let path = url.pathname;
	for (let pass = 0; pass < 8; pass++) {
		let decoded: string;
		try {
			decoded = decodeURIComponent(path);
		} catch {
			return null;
		}
		parsed.pathname = decoded;
		const next = parsed.pathname.replace(/\/{2,}/g, "/");
		if (next === path) return next.length > 1 ? next.replace(/\/$/, "") : next;
		path = next;
	}
	return null;
}

/**
 * Whether a path from siteRoutePath reaches a dev-only route. Astro's dev server
 * also routes `<route>.html` and `<route>/index.html` to a route, so any path
 * that begins with one counts, in any letter case.
 */
export function isSiteDevOnlyRoute(routePath: string): boolean {
	const path = routePath.toLowerCase();
	return [...SITE_DEV_ONLY_ROUTES].some((route) => path.startsWith(route));
}
