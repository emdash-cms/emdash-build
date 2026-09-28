import { WFP_HEALTH_PATH, canonicalWfpUuid } from "../platform/wfp-release.js";
import { SNAPSHOT_HEALTH_PATH } from "../platform/wfp-snapshot-release.js";
import { siteForPublishedSlug, validPublishedSlug } from "./published-slugs.js";

export const WFP_DISPATCH_LIMITS = { limits: { cpuMs: 50, subRequests: 20 } } as const;

export async function routeProviderSite(
	request: Request,
	options: {
		enabled?: boolean;
		sitesHostname?: string;
		brandedSitesHostname?: string;
		slugDatabase?: D1Database;
		dispatcher?: DispatchNamespace;
		siteCapabilityFor?: (siteId: string) => unknown;
	},
): Promise<Response | undefined> {
	const url = new URL(request.url);
	const brandedSuffix = options.brandedSitesHostname && `.${options.brandedSitesHostname}`;
	if (brandedSuffix && url.hostname.endsWith(brandedSuffix)) {
		if (options.enabled === false) return new Response("Not found.", { status: 404 });
		const slug = url.hostname.slice(0, -brandedSuffix.length);
		if (
			!validPublishedSlug(slug) ||
			url.pathname === WFP_HEALTH_PATH ||
			url.pathname === SNAPSHOT_HEALTH_PATH
		) {
			return new Response("Not found.", { status: 404 });
		}
		if (!options.slugDatabase || !options.dispatcher) {
			return new Response("Site unavailable.", { status: 503 });
		}
		let siteId: string | undefined;
		try {
			siteId = await siteForPublishedSlug(options.slugDatabase, slug);
		} catch {
			return new Response("Site unavailable.", { status: 503 });
		}
		if (!siteId) return new Response("Not found.", { status: 404 });
		try {
			const compact = canonicalWfpUuid(siteId).replaceAll("-", "");
			const dispatchArgs = options.siteCapabilityFor
				? { props: { SITE: options.siteCapabilityFor(siteId) } }
				: {};
			return await options.dispatcher
				.get(`e-${compact}-live`, dispatchArgs, WFP_DISPATCH_LIMITS)
				.fetch(request);
		} catch {
			return new Response("Site unavailable.", { status: 502 });
		}
	}
	if (!options.sitesHostname) return undefined;
	const suffix = `.${options.sitesHostname}`;
	if (!url.hostname.endsWith(suffix)) return undefined;
	const label = url.hostname.slice(0, -suffix.length);
	const match = /^s-([0-9a-f]{32})$/.exec(label);
	if (!match) return undefined;
	if (options.enabled === false) return new Response("Not found.", { status: 404 });
	if (!options.dispatcher) return undefined;
	const compact = match[1]!;
	let siteId: string;
	try {
		siteId = canonicalWfpUuid(
			`${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`,
		);
	} catch {
		return undefined;
	}
	if (url.pathname === WFP_HEALTH_PATH || url.pathname === SNAPSHOT_HEALTH_PATH) {
		return new Response("Not found.", { status: 404 });
	}
	try {
		const dispatchArgs = options.siteCapabilityFor
			? { props: { SITE: options.siteCapabilityFor(siteId) } }
			: {};
		return await options.dispatcher
			.get(`e-${compact}-live`, dispatchArgs, WFP_DISPATCH_LIMITS)
			.fetch(request);
	} catch {
		return new Response("Site unavailable.", { status: 502 });
	}
}
