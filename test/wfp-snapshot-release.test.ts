import { describe, expect, it } from "vitest";
import {
	SNAPSHOT_HEALTH_PATH,
	buildWfpSnapshotRelease,
} from "../src/platform/wfp-snapshot-release.js";
import type { StaticSiteSnapshot } from "../src/worker/static-site-snapshot.js";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const RELEASE_ID = "00000000-0000-5000-8000-000000000011";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;

async function digest(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	const value = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
	return `sha256:${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function snapshot(): Promise<StaticSiteSnapshot> {
	const home = new TextEncoder().encode("<!doctype html><html><body><h1>Home</h1></body></html>");
	const about = new TextEncoder().encode("<!doctype html><html><body><h1>About</h1></body></html>");
	const css = new TextEncoder().encode("h1{color:red}");
	return {
		siteId: SITE_ID,
		liveOrigin: "https://site.test",
		releaseId: RELEASE_ID,
		sourceRevision: SOURCE_REVISION,
		routes: [
			{ path: "/", kind: "page", assetPath: "__emdash/pages/home.html" },
			{ path: "/about", kind: "page", assetPath: "__emdash/pages/about.html" },
			{ path: "/old", kind: "redirect", status: 308, location: "/about" },
		],
		assets: [
			{
				path: "__emdash/pages/home.html",
				bytes: home,
				contentType: "text/html",
				digest: await digest(home),
			},
			{
				path: "__emdash/pages/about.html",
				bytes: about,
				contentType: "text/html",
				digest: await digest(about),
			},
			{
				path: "assets/app.css",
				bytes: css,
				contentType: "text/css",
				digest: await digest(css),
			},
		],
		manifest: {
			version: 1,
			routes: [
				{ path: "/", kind: "page", assetPath: "__emdash/pages/home.html" },
				{ path: "/about", kind: "page", assetPath: "__emdash/pages/about.html" },
				{ path: "/old", kind: "redirect", status: 308, location: "/about" },
			],
			assets: [],
		},
	};
}

describe("WfP snapshot releases", () => {
	it("builds existing-format artifacts and validates them through the WfP resolver", async () => {
		const release = await buildWfpSnapshotRelease(await snapshot());

		expect(release.bundle).toMatchObject({
			version: 1,
			sourceRevision: SOURCE_REVISION,
			worker: { kind: "worker-bundle", formatVersion: "wfp-worker-v1" },
			assets: { kind: "static-assets", formatVersion: "wfp-assets-v1" },
		});
		expect(release.workerArtifact).toMatchObject({
			mainModule: "./src/index.js",
			bindingIntents: ["ASSETS"],
			healthPath: SNAPSHOT_HEALTH_PATH,
		});
		expect(release.resolved.assets).toHaveLength(3);
		expect(release.resolved.modules).toHaveLength(1);
		expect(release.bundle.worker.artifactId).toContain(RELEASE_ID.replaceAll("-", ""));
	});

	it("serves only captured routes and assets through the trusted module", async () => {
		const source = await snapshot();
		const release = await buildWfpSnapshotRelease(source);
		const workerSource = atob(release.workerArtifact.modules[0]!.base64);
		const module = (await import(`data:text/javascript;base64,${btoa(workerSource)}`)) as {
			default: { fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> };
		};
		const assets = new Map(source.assets.map((asset) => [`/${asset.path}`, asset]));
		const env = {
			ASSETS: {
				async fetch(request: Request) {
					const asset = assets.get(new URL(request.url).pathname);
					return asset
						? new Response(request.method === "HEAD" ? null : asset.bytes.slice().buffer, {
								headers: { "content-type": asset.contentType },
							})
						: new Response("Not found", { status: 404 });
				},
			} as Fetcher,
		};
		const request = (path: string, method = "GET") =>
			module.default.fetch(new Request(`https://site.test${path}`, { method }), env);

		expect(await (await request("/")).text()).toContain("Home");
		expect(await (await request("/about", "HEAD")).text()).toBe("");
		expect(await (await request("/assets/app.css")).text()).toBe("h1{color:red}");
		expect(await request("/old")).toMatchObject({ status: 308 });
		expect((await request("/old")).headers.get("location")).toBe("/about");
		expect((await request("/missing")).status).toBe(404);
		expect((await request("/", "POST")).status).toBe(405);
		expect((await request(SNAPSHOT_HEALTH_PATH)).status).toBe(200);
	});

	it("accepts a captured same-origin root redirect as healthy", async () => {
		const source = await snapshot();
		source.routes = [
			{ path: "/", kind: "redirect", status: 302, location: "https://site.test/blog/" },
			{ path: "/blog/", kind: "redirect", status: 302, location: "article/" },
			{
				path: "/blog/article/",
				kind: "page",
				assetPath: "__emdash/pages/about.html",
			},
			...source.routes.filter(({ path }) => path !== "/"),
		];
		source.manifest.routes = source.routes.map((route) => ({ ...route }));
		const release = await buildWfpSnapshotRelease(source);
		const workerSource = atob(release.workerArtifact.modules[0]!.base64);
		const module = (await import(`data:text/javascript;base64,${btoa(workerSource)}`)) as {
			default: { fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> };
		};
		const assets = new Map(source.assets.map((asset) => [`/${asset.path}`, asset]));
		const response = await module.default.fetch(
			new Request(`https://site.test${SNAPSHOT_HEALTH_PATH}`),
			{
				ASSETS: {
					async fetch(request: Request) {
						const asset = assets.get(new URL(request.url).pathname);
						return asset
							? new Response(asset.bytes.slice().buffer, {
									headers: { "content-type": asset.contentType },
								})
							: new Response("Not found", { status: 404 });
					},
				} as Fetcher,
			},
		);

		expect(response.status).toBe(200);
	});
});
