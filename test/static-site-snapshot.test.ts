import { describe, expect, it, vi } from "vitest";
import {
	captureStaticSiteSnapshot,
	type BuiltSnapshotAsset,
	type CaptureStaticSiteSnapshotInput,
} from "../src/worker/static-site-snapshot.js";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const PREVIEW_ORIGIN = "https://4321-project-preview.example.test";
const LIVE_ORIGIN = "https://s-00000000000040008000000000000001.sites.example.test";

function html(body: string, head = ""): Response {
	return new Response(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

function built(bytes: string | Uint8Array, contentType: string): BuiltSnapshotAsset {
	return {
		bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
		contentType,
	};
}

type TestCaptureInput = Omit<CaptureStaticSiteSnapshotInput, "inspectBuiltAsset"> & {
	inspectBuiltAsset?: CaptureStaticSiteSnapshotInput["inspectBuiltAsset"];
};

async function capture(input: TestCaptureInput) {
	const inspectBuiltAsset =
		input.inspectBuiltAsset ??
		(async (path: string) => {
			const asset = await input.readBuiltAsset(path, Number.MAX_SAFE_INTEGER);
			return asset
				? { byteLength: asset.bytes.byteLength, contentType: asset.contentType }
				: undefined;
		});
	return captureStaticSiteSnapshot({ ...input, inspectBuiltAsset });
}

function fixture() {
	const pages = new Map<string, Response>([
		[
			"/",
			html(
				`<main><h1>Bakery</h1><a href="/about">About</a><a href="/menu">Menu</a><img src="/media/hero.png" srcset="/media/hero.png 1x, https://images.example.test/hero@2x.png 2x"></main><script type="module" src="/assets/app.js"></script>`,
				`<link rel="canonical" href="${PREVIEW_ORIGIN}/"><link rel="stylesheet" href="/assets/app.css">`,
			),
		],
		["/about", html('<main><h1>About</h1><a href="/">Home</a></main>')],
		["/menu", new Response(null, { status: 308, headers: { location: "/menu/" } })],
		["/menu/", html("<main><h1>Menu</h1></main>")],
		[
			"/media/hero.png",
			new Response(Uint8Array.of(137, 80, 78, 71), {
				headers: { "content-type": "image/png" },
			}),
		],
	]);
	const assets = new Map<string, BuiltSnapshotAsset>([
		[
			"/assets/app.css",
			built(
				'@font-face{src:url("./font.woff2")}main{background:url("/media/hero.png")}',
				"text/css",
			),
		],
		[
			"/assets/app.js",
			built(
				'import "./chunk.js";document.documentElement.dataset.ready="true";',
				"text/javascript",
			),
		],
		["/assets/chunk.js", built("export const ready = true;", "text/javascript")],
		["/assets/font.woff2", built(Uint8Array.of(119, 79, 70, 50), "font/woff2")],
	]);
	return {
		fetch: vi.fn(async (path: string) => {
			const response = pages.get(path);
			return response ? response.clone() : new Response("Not found", { status: 404 });
		}),
		readBuiltAsset: vi.fn(async (path: string) => assets.get(path)),
	};
}

describe("static site snapshots", () => {
	it("captures linked pages, redirects, production assets, srcset, CSS URLs, and local media", async () => {
		const source = fixture();
		const snapshot = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch: source.fetch,
			readBuiltAsset: source.readBuiltAsset,
		});

		expect(snapshot.routes).toEqual([
			expect.objectContaining({ path: "/", kind: "page" }),
			expect.objectContaining({ path: "/about", kind: "page" }),
			{ path: "/menu", kind: "redirect", status: 308, location: "/menu/" },
			expect.objectContaining({ path: "/menu/", kind: "page" }),
		]);
		expect(snapshot.assets.map((asset) => asset.path)).toEqual(
			expect.arrayContaining([
				"assets/app.css",
				"assets/app.js",
				"assets/chunk.js",
				"assets/font.woff2",
			]),
		);
		const rootRoute = snapshot.routes.find(
			(route): route is Extract<(typeof snapshot.routes)[number], { kind: "page" }> =>
				route.path === "/" && route.kind === "page",
		);
		const page = snapshot.assets.find((asset) => asset.path === rootRoute?.assetPath);
		const rendered = new TextDecoder().decode(page?.bytes);
		expect(rendered).toContain(`${LIVE_ORIGIN}/`);
		expect(rendered).not.toContain(PREVIEW_ORIGIN);
		expect(rendered).toMatch(/\/__emdash\/snapshot\/[a-f0-9]{64}\.png/);
		expect(rendered).toContain("https://images.example.test/hero@2x.png 2x");
		expect(source.fetch).toHaveBeenCalledWith("/media/hero.png");
		expect(snapshot.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(snapshot.releaseId).toMatch(/^[a-f0-9-]{36}$/);
	});

	it("captures public EmDash media while rejecting other private routes", async () => {
		const mediaPath = "/_emdash/api/media/file/01M3AJB2YKRJYQCCZXCJRS8KF.jpg";
		const root = html(`<h1>Gallery</h1><img src="${mediaPath}">`);
		const fetch = vi.fn(async (path: string) =>
			path === "/"
				? root.clone()
				: new Response(Uint8Array.of(255, 216, 255, 217), {
						headers: { "content-type": "image/jpeg" },
					}),
		);
		const snapshot = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch,
			readBuiltAsset: async () => undefined,
		});
		const pagePath = snapshot.routes.find((route) => route.kind === "page")?.assetPath;
		const page = snapshot.assets.find((asset) => asset.path === pagePath);

		expect(fetch).toHaveBeenCalledWith(mediaPath);
		expect(new TextDecoder().decode(page?.bytes)).toMatch(
			/\/__emdash\/snapshot\/[a-f0-9]{64}\.jpg/,
		);

		await expect(
			capture({
				siteId: SITE_ID,
				previewOrigin: PREVIEW_ORIGIN,
				liveOrigin: LIVE_ORIGIN,
				fetch: async () => html('<h1>Private</h1><img src="/_emdash/api/private">'),
				readBuiltAsset: async () => undefined,
			}),
		).rejects.toMatchObject({ code: "SNAPSHOT_UNSUPPORTED" });
	});

	it("captures same-origin social images and rewrites their metadata", async () => {
		const root = html(
			"<h1>Social preview</h1>",
			`<meta property="og:image" content="${LIVE_ORIGIN}/media/social.png"><meta name="twitter:image" content="/media/social.png">`,
		);
		const snapshot = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch: async (path) =>
				path === "/"
					? root.clone()
					: new Response(Uint8Array.of(137, 80, 78, 71), {
							headers: { "content-type": "image/png" },
						}),
			readBuiltAsset: async () => undefined,
		});
		const pagePath = snapshot.routes.find((route) => route.kind === "page")?.assetPath;
		const page = snapshot.assets.find((asset) => asset.path === pagePath);
		const rendered = new TextDecoder().decode(page?.bytes);
		const socialPath = snapshot.assets.find((asset) => asset.contentType === "image/png")?.path;

		expect(socialPath).toMatch(/^__emdash\/snapshot\/[a-f0-9]{64}\.png$/);
		expect(rendered.match(new RegExp(`${LIVE_ORIGIN}/${socialPath}`, "g"))).toHaveLength(2);
	});

	it("captures ignored built downloads referenced by anchors", async () => {
		const root = html('<h1>Brochure</h1><a href="/_astro/brochure.hash.pdf#page=2">Download</a>');
		const snapshot = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch: async (path) =>
				path === "/" ? root.clone() : new Response("Not found", { status: 404 }),
			readBuiltAsset: async (path) =>
				path === "/_astro/brochure.hash.pdf"
					? built(Uint8Array.of(37, 80, 68, 70), "application/pdf")
					: undefined,
		});
		const pagePath = snapshot.routes.find((route) => route.kind === "page")?.assetPath;
		const page = snapshot.assets.find((asset) => asset.path === pagePath);

		expect(snapshot.assets).toContainEqual(
			expect.objectContaining({ path: "_astro/brochure.hash.pdf", contentType: "application/pdf" }),
		);
		expect(new TextDecoder().decode(page?.bytes)).toContain(
			'href="/_astro/brochure.hash.pdf#page=2"',
		);
	});

	it("captures public-directory downloads proven present in the production build", async () => {
		const root = html('<h1>Brochure</h1><a href="/brochure.pdf">Download</a>');
		const pdf = Uint8Array.of(37, 80, 68, 70);
		const snapshot = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch: async (path) =>
				path === "/"
					? root.clone()
					: new Response(pdf, { headers: { "content-type": "application/pdf" } }),
			readBuiltAsset: async (path) =>
				path === "/brochure.pdf" ? built(pdf, "application/pdf") : undefined,
		});

		expect(snapshot.assets).toContainEqual(
			expect.objectContaining({ path: "brochure.pdf", contentType: "application/pdf" }),
		);
	});

	it("produces the same canonical manifest and release identity on retry", async () => {
		const firstSource = fixture();
		const secondSource = fixture();
		const first = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch: firstSource.fetch,
			readBuiltAsset: firstSource.readBuiltAsset,
		});
		const second = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch: secondSource.fetch,
			readBuiltAsset: secondSource.readBuiltAsset,
		});

		expect(second.manifest).toEqual(first.manifest);
		expect(second.sourceRevision).toBe(first.sourceRevision);
		expect(second.releaseId).toBe(first.releaseId);
	});

	it.each([
		[
			"query-dependent pages",
			html('<h1>Search</h1><a href="/search?q=bread">Search</a>'),
			"SNAPSHOT_UNSUPPORTED",
		],
		[
			"same-origin forms",
			html('<h1>Contact</h1><form action="/api/contact"><button>Send</button></form>'),
			"SNAPSHOT_UNSUPPORTED",
		],
		[
			"inline runtime requests",
			html('<h1>Live menu</h1><script>fetch("/api/menu")</script>'),
			"SNAPSHOT_UNSUPPORTED",
		],
	])("rejects %s", async (_name, root, code) => {
		await expect(
			capture({
				siteId: SITE_ID,
				previewOrigin: PREVIEW_ORIGIN,
				liveOrigin: LIVE_ORIGIN,
				fetch: async (path) =>
					path === "/" ? root.clone() : new Response("Not found", { status: 404 }),
				readBuiltAsset: async () => undefined,
			}),
		).rejects.toMatchObject({ code });
	});

	it("rejects credentialed or oversized resources before completing a snapshot", async () => {
		const root = html('<h1>Private image</h1><img src="/private.png">');
		await expect(
			capture({
				siteId: SITE_ID,
				previewOrigin: PREVIEW_ORIGIN,
				liveOrigin: LIVE_ORIGIN,
				fetch: async (path) =>
					path === "/"
						? root.clone()
						: new Response(Uint8Array.of(1, 2, 3), {
								headers: { "content-type": "image/png", "set-cookie": "secret=1" },
							}),
				readBuiltAsset: async () => undefined,
			}),
		).rejects.toMatchObject({ code: "SNAPSHOT_UNSUPPORTED" });

		await expect(
			capture({
				siteId: SITE_ID,
				previewOrigin: PREVIEW_ORIGIN,
				liveOrigin: LIVE_ORIGIN,
				fetch: async (path) =>
					path === "/"
						? root.clone()
						: new Response(Uint8Array.of(1, 2, 3, 4), {
								headers: { "content-type": "image/png" },
							}),
				readBuiltAsset: async () => undefined,
				limits: { assetBytes: 3 },
			}),
		).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" });
	});

	it("rejects oversized built downloads before reading their bytes", async () => {
		const readBuiltAsset = vi.fn(async () => built(Uint8Array.of(1, 2, 3, 4), "application/pdf"));
		await expect(
			capture({
				siteId: SITE_ID,
				previewOrigin: PREVIEW_ORIGIN,
				liveOrigin: LIVE_ORIGIN,
				fetch: async () => html('<h1>Large file</h1><a href="/_astro/large.pdf">Download</a>'),
				inspectBuiltAsset: async () => ({
					byteLength: 4,
					contentType: "application/pdf",
				}),
				readBuiltAsset,
				limits: { assetBytes: 3 },
			}),
		).rejects.toMatchObject({ code: "SNAPSHOT_TOO_LARGE" });
		expect(readBuiltAsset).not.toHaveBeenCalled();
	});

	it("fails closed when a proven built download disappears before reading", async () => {
		await expect(
			capture({
				siteId: SITE_ID,
				previewOrigin: PREVIEW_ORIGIN,
				liveOrigin: LIVE_ORIGIN,
				fetch: async () => html('<h1>Missing file</h1><a href="/_astro/missing.pdf">Download</a>'),
				inspectBuiltAsset: async () => ({
					byteLength: 4,
					contentType: "application/pdf",
				}),
				readBuiltAsset: async () => undefined,
			}),
		).rejects.toMatchObject({ code: "SNAPSHOT_UNSUPPORTED" });
	});

	it("rejects bundled first-party JavaScript that needs a backend", async () => {
		const root = html('<h1>Live data</h1><script type="module" src="/assets/app.js"></script>');
		await expect(
			capture({
				siteId: SITE_ID,
				previewOrigin: PREVIEW_ORIGIN,
				liveOrigin: LIVE_ORIGIN,
				fetch: async () => root.clone(),
				readBuiltAsset: async (path) =>
					path === "/assets/app.js" ? built('fetch("/api/live")', "text/javascript") : undefined,
			}),
		).rejects.toMatchObject({ code: "SNAPSHOT_UNSUPPORTED" });
	});

	it("handles cyclic production chunks without stalling", async () => {
		const root = html('<h1>Chunks</h1><script type="module" src="/assets/a.js"></script>');
		const snapshot = await Promise.race([
			capture({
				siteId: SITE_ID,
				previewOrigin: PREVIEW_ORIGIN,
				liveOrigin: LIVE_ORIGIN,
				fetch: async () => root.clone(),
				readBuiltAsset: async (path) =>
					path === "/assets/a.js"
						? built('import "./b.js";', "text/javascript")
						: path === "/assets/b.js"
							? built('import "./a.js";', "text/javascript")
							: undefined,
			}),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cycle stalled")), 100)),
		]);

		expect(snapshot.assets.map((asset) => asset.path)).toEqual(
			expect.arrayContaining(["assets/a.js", "assets/b.js"]),
		);
	});

	it("preserves data URLs in srcset while capturing later same-origin candidates", async () => {
		const root = html(
			'<h1>Responsive</h1><img srcset="data:image/png;base64,AAAA 1x, /media/hero.png 2x">',
		);
		const snapshot = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch: async (path) =>
				path === "/"
					? root.clone()
					: new Response(Uint8Array.of(137, 80, 78, 71), {
							headers: { "content-type": "image/png" },
						}),
			readBuiltAsset: async () => undefined,
		});
		const pagePath = snapshot.routes.find((route) => route.kind === "page")?.assetPath;
		const page = snapshot.assets.find((asset) => asset.path === pagePath);
		expect(new TextDecoder().decode(page?.bytes)).toContain("data:image/png;base64,AAAA 1x");
	});

	it("preserves entity-quoted data URLs in inline CSS without fetching them", async () => {
		const fetch = vi.fn(async (path: string) =>
			path === "/"
				? html(
						'<h1>Placeholder</h1><div style="background: url(&quot;data:image/bmp;base64,Qk32BAAAAAAA&quot;)"></div>',
					)
				: new Response("Not found", { status: 404 }),
		);
		const snapshot = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch,
			readBuiltAsset: async () => undefined,
		});
		const pagePath = snapshot.routes.find((route) => route.kind === "page")?.assetPath;
		const page = snapshot.assets.find((asset) => asset.path === pagePath);

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(new TextDecoder().decode(page?.bytes)).toContain(
			"&quot;data:image/bmp;base64,Qk32BAAAAAAA&quot;",
		);
	});

	it("addresses rewritten dynamic CSS by its final bytes and disposes the response", async () => {
		const disposeSymbol = (Symbol as typeof Symbol & { readonly dispose: symbol }).dispose;
		const dispose = vi.fn();
		const root = html('<h1>Theme</h1><link rel="stylesheet" href="/styles/theme.css">');
		const cssResponse = new Response('main{background:url("/media/hero.png")}', {
			headers: { "content-type": "text/css" },
		}) as Response & { [key: symbol]: unknown };
		cssResponse[disposeSymbol] = dispose;
		const snapshot = await capture({
			siteId: SITE_ID,
			previewOrigin: PREVIEW_ORIGIN,
			liveOrigin: LIVE_ORIGIN,
			fetch: async (path) => {
				if (path === "/") return root.clone();
				if (path === "/styles/theme.css") return cssResponse;
				return new Response(Uint8Array.of(137, 80, 78, 71), {
					headers: { "content-type": "image/png" },
				});
			},
			readBuiltAsset: async () => undefined,
		});
		const css = snapshot.assets.find((asset) => asset.contentType === "text/css");
		expect(css?.path).toBe(`__emdash/snapshot/${css?.digest.slice("sha256:".length)}.css`);
		expect(dispose).toHaveBeenCalledOnce();
	});
});
