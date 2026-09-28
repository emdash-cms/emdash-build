interface __BaseEnv_Env {
	SITES_HOSTNAME: string;
	WFP_RELEASES: R2Bucket;
	SITE_MEDIA: R2Bucket;
	WFP_RUNTIME: Fetcher;
	ProviderControlPlane: DurableObjectNamespace<
		import("../src/worker/provider-control-plane").ProviderControlPlane
	>;
	SiteService: DurableObjectNamespace<import("../src/worker/site-service").SiteService>;
}

declare namespace Cloudflare {
	interface Env {
		SITES_HOSTNAME: string;
		WFP_RELEASES: R2Bucket;
		SITE_MEDIA: R2Bucket;
		WFP_RUNTIME: Fetcher;
		ProviderControlPlane: DurableObjectNamespace<
			import("../src/worker/provider-control-plane").ProviderControlPlane
		>;
		SiteService: DurableObjectNamespace<import("../src/worker/site-service").SiteService>;
	}
}
