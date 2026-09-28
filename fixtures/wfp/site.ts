interface Env {
	RELEASE_ID: string;
	FAIL_HEALTH?: string;
	fixtureScript?: string;
}

interface SiteCapability {
	readFixtureContent(): Promise<{
		version: 1;
		siteId: string;
		title: string;
		body: string;
		mediaPath: "/fixture-media";
	} | null>;
	readFixtureMedia(): Promise<Response>;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext<{ SITE: SiteCapability }>,
	): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return Response.json(
				{ ok: env.FAIL_HEALTH !== "1", releaseId: env.RELEASE_ID },
				{ status: env.FAIL_HEALTH === "1" ? 500 : 200 },
			);
		}
		if (url.pathname === "/fixture-media") return ctx.props.SITE.readFixtureMedia();
		const site = await ctx.props.SITE.readFixtureContent();
		if (!site) return Response.json({ error: "Fixture Site is not initialized." }, { status: 503 });
		return Response.json(
			{
				ok: true,
				releaseId: env.RELEASE_ID,
				scriptName: env.fixtureScript,
				path: url.pathname,
				site,
			},
			{ headers: { "X-EmDash-Fixture-Release": env.RELEASE_ID } },
		);
	},
};
