import { routeProviderSite } from "../../src/worker/site-routing.js";
import type { SiteService } from "../../src/worker/site-service.js";

interface Env {
	DISPATCHER: DispatchNamespace;
	SITES_HOSTNAME: string;
	SiteService: DurableObjectNamespace<SiteService>;
}

const SCRIPT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const FIXTURE_SITE_A = "00000000-0000-4000-8000-0000000000a1";
export const FIXTURE_SITE_B = "00000000-0000-4000-8000-0000000000b2";
const FIXTURE_SITES = new Set([FIXTURE_SITE_A, FIXTURE_SITE_B]);
const FIXTURE_DISPATCH_LIMITS = { limits: { cpuMs: 20, subRequests: 10 } } as const;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const [, prefix, siteOrAction, scriptOrSite, ...rest] = url.pathname.split("/");
		if (prefix !== "fixture") {
			const stable = await routeProviderSite(request, {
				sitesHostname: env.SITES_HOSTNAME,
				dispatcher: env.DISPATCHER,
				siteCapabilityFor: (siteId) => {
					if (!FIXTURE_SITES.has(siteId)) throw new Error("Fixture Site is not allowlisted.");
					return ctx.exports.SiteReadCapability({ props: { siteId } });
				},
			});
			return stable ?? fixtureNotFound();
		}
		if (siteOrAction === "initialize") {
			if (request.method !== "POST" || !scriptOrSite || !FIXTURE_SITES.has(scriptOrSite)) {
				return fixtureNotFound();
			}
			const result = await env.SiteService.getByName(scriptOrSite).initializeFixture(scriptOrSite);
			return Response.json(result, { status: result.ok ? 200 : 409 });
		}
		const siteId = siteOrAction;
		const scriptName = scriptOrSite;
		if (!siteId || !FIXTURE_SITES.has(siteId) || !scriptName || !SCRIPT_NAME.test(scriptName)) {
			return fixtureNotFound();
		}

		url.pathname = `/${rest.join("/")}`;
		const siteCapability = ctx.exports.SiteReadCapability({ props: { siteId } });
		const target = env.DISPATCHER.get(
			scriptName,
			{ props: { SITE: siteCapability } },
			FIXTURE_DISPATCH_LIMITS,
		);
		try {
			return await target.fetch(new Request(url, request));
		} catch (error) {
			console.error(
				JSON.stringify({ event: "wfp.fixture.dispatch_failed", scriptName, error: String(error) }),
			);
			return Response.json({ error: "Fixture release unavailable." }, { status: 502 });
		}
	},
};

function fixtureNotFound(): Response {
	return Response.json(
		{ error: "Use the fixed fixture Site initialization or dispatch routes." },
		{ status: 404 },
	);
}
