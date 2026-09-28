import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { auditPublicSite } from "../src/worker/public-site-audit.js";

function html(body: string, init: ResponseInit = {}): Response {
	return new Response(`<!doctype html><html><head></head><body>${body}</body></html>`, {
		status: 200,
		headers: { "Content-Type": "text/html; charset=utf-8" },
		...init,
	});
}

describe("public site acceptance audit", () => {
	it("loads in native Node for the hosted smoke runner", () => {
		const moduleUrl = new URL("../src/worker/public-site-audit.ts", import.meta.url);
		const result = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(moduleUrl.href)})`]);
		expect(result.status).toBe(0);
	});

	it("crawls rendered same-origin links and follows internal redirects", async () => {
		const pages = new Map<string, Response>([
			[
				"/",
				html(
					'<main><h1>Acme Observatory</h1><a href="/about">About</a><a href="/events">Events</a><a href="#main">Skip</a><a href="https://example.com">External</a></main>',
				),
			],
			["/about", html('<h1>About the club</h1><a href="/">Home</a>')],
			["/events", new Response(null, { status: 308, headers: { Location: "/events/" } })],
			["/events/", html("<h1>Observing nights</h1>")],
		]);
		const fetchPage = vi.fn(async (path: string) => pages.get(path)!.clone());

		await expect(auditPublicSite(fetchPage)).resolves.toEqual({
			success: true,
			checkedPaths: ["/", "/about", "/events", "/events/"],
			issues: [],
		});
		expect(fetchPage).toHaveBeenCalledTimes(4);
	});

	it("crawls absolute links for an explicitly equivalent site origin", async () => {
		const fetchPage = vi.fn(async (path: string) =>
			path === "/"
				? html('<h1>Home</h1><a href="https://site.example.test/about">About</a>')
				: html("<h1>About</h1>"),
		);

		await expect(
			auditPublicSite(fetchPage, { sameSiteOrigins: ["https://site.example.test"] }),
		).resolves.toMatchObject({ success: true, checkedPaths: ["/", "/about"] });
	});

	it("rejects the untouched blank-builder homepage", async () => {
		const fetchPage = vi.fn(async () =>
			html(
				"<title>New EmDash site — Acme Observatory</title><h1>Your site is taking shape.</h1><p>The builder is designing the content model, pages, and visual system from your brief.</p>",
			),
		);

		await expect(auditPublicSite(fetchPage)).resolves.toMatchObject({
			success: false,
			issues: [
				{
					path: "/",
					reason: "scaffold-placeholder",
				},
			],
		});
	});

	it("rejects a rendered block with no registered Astro component", async () => {
		await expect(
			auditPublicSite(async () =>
				html('<main><h1>Bakery</h1><div data-emdash-missing-block="bakery_intro"></div></main>'),
			),
		).resolves.toMatchObject({
			success: false,
			issues: [
				{
					path: "/",
					reason: "missing-block-renderer",
					detail: "bakery_intro",
				},
			],
		});
	});

	it("rejects a broken rendered internal link", async () => {
		const fetchPage = vi.fn(async (path: string) => {
			if (path === "/") {
				return html('<h1>Acme Observatory</h1><a href="/events">Events</a>');
			}
			if (path === "/events") {
				return new Response(null, { status: 302, headers: { Location: "/404" } });
			}
			return new Response("Not found", { status: 404 });
		});

		await expect(auditPublicSite(fetchPage)).resolves.toMatchObject({
			success: false,
			checkedPaths: ["/", "/events", "/404"],
			issues: [
				{
					path: "/events",
					reason: "http-status",
					status: 404,
					detail: "Redirected to /404.",
				},
			],
		});
	});

	it("rejects unsupported same-origin download links only in snapshot mode", async () => {
		const fetchPage = vi.fn(async (path: string) =>
			path === "/"
				? html('<h1>Reports</h1><a href="/api/report.csv">Download report</a>')
				: new Response("name,total\nBread,12", {
						headers: { "content-type": "text/csv" },
					}),
		);

		await expect(auditPublicSite(fetchPage)).resolves.toMatchObject({ success: true });
		await expect(auditPublicSite(fetchPage, { rejectNonHtmlRoutes: true })).resolves.toMatchObject({
			success: false,
			issues: [{ path: "/api/report.csv", reason: "non-html-route" }],
		});
	});

	it("does not count an accepted built download as a rendered route", async () => {
		const fetchPage = vi.fn(async (path: string) =>
			path === "/"
				? html('<h1>Brochure</h1><a href="/brochure.pdf">Download</a>')
				: new Response(Uint8Array.of(37, 80, 68, 70), {
						headers: { "content-type": "application/pdf" },
					}),
		);

		await expect(
			auditPublicSite(fetchPage, {
				maxRoutes: 1,
				maxRequests: 2,
				rejectNonHtmlRoutes: true,
				allowNonHtmlRoute: (path) => path === "/brochure.pdf",
			}),
		).resolves.toMatchObject({ success: true, checkedPaths: ["/", "/brochure.pdf"] });
	});

	it("includes a rendered server error in the audit result", async () => {
		await expect(
			auditPublicSite(async () =>
				html(
					'<title>Error</title><script type="module">\nconst error = {"message":"ReferenceError: project is not defined","stack":"at index.astro:3:1"};\n</script>',
					{ status: 500 },
				),
			),
		).resolves.toMatchObject({
			success: false,
			issues: [
				{ reason: "http-status", status: 500, detail: expect.stringContaining("ReferenceError") },
			],
		});
	});

	it("rejects a streamed document that ends before its closing html tag", async () => {
		const fetchPage = vi.fn(
			async () =>
				new Response("<!doctype html><html><body><main><h1>Half-rendered site</h1>", {
					headers: { "Content-Type": "text/html" },
				}),
		);

		await expect(auditPublicSite(fetchPage)).resolves.toMatchObject({
			success: false,
			issues: [
				{
					path: "/",
					reason: "truncated-html",
				},
			],
		});
	});

	it("rejects an empty successful document instead of accepting a one-route site", async () => {
		const fetchPage = vi.fn(async () => html(""));
		await expect(auditPublicSite(fetchPage)).resolves.toMatchObject({
			success: false,
			checkedPaths: ["/"],
			issues: [{ path: "/", reason: "truncated-html" }],
		});
		await expect(
			auditPublicSite(async () => new Response("", { headers: { "Content-Type": "text/html" } })),
		).resolves.toMatchObject({ success: false, issues: [{ path: "/", reason: "empty-html" }] });
	});

	it("reports request failures without throwing", async () => {
		const fetchPage = vi.fn(async () => {
			throw new Error("preview unavailable");
		});

		await expect(auditPublicSite(fetchPage)).resolves.toMatchObject({
			success: false,
			issues: [
				{
					path: "/",
					reason: "request-failed",
					detail: "preview unavailable",
				},
			],
		});
	});

	it("does not turn a runtime replacement into a site defect", async () => {
		const interrupted = Object.assign(new Error("runtime replaced"), {
			code: "OPERATION_INTERRUPTED",
			context: { reason: "runtime_replaced" },
		});
		await expect(auditPublicSite(async () => Promise.reject(interrupted))).rejects.toBe(
			interrupted,
		);
	});

	it("disposes RPC-backed responses after reading them", async () => {
		const disposeSymbol = (Symbol as typeof Symbol & { readonly dispose: symbol }).dispose;
		const dispose = vi.fn();
		const response = html("<h1>Finished site</h1>") as Response & {
			[key: symbol]: unknown;
		};
		response[disposeSymbol] = dispose;

		await expect(auditPublicSite(async () => response)).resolves.toMatchObject({
			success: true,
		});
		expect(dispose).toHaveBeenCalledOnce();
	});
});
