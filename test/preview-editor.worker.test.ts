import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { describe, expect, it, vi } from "vitest";
import { injectPreviewBridge } from "../src/worker/preview-bridge.js";
import { Sandbox } from "../src/worker/sandbox.js";

describe("editor preview documents", () => {
	it("rejects ordinary top-level preview navigations for every request method", async () => {
		for (const method of ["GET", "POST"] as const) {
			const response = injectPreviewBridge(
				new Request("https://4321-project-token.build.emdashcms.com/work", {
					method,
					headers: { "Sec-Fetch-Dest": "document" },
				}),
				new Response("<html><body>Private draft</body></html>", {
					headers: { "Content-Type": "text/html" },
				}),
			);
			expect(response.status).toBe(404);
			expect(await response.text()).toBe("Not found.");
		}
		const redirect = injectPreviewBridge(
			new Request("https://4321-project-token.build.emdashcms.com/work", {
				headers: { "Sec-Fetch-Dest": "document" },
			}),
			new Response(null, { status: 302, headers: { Location: "https://example.test/" } }),
		);
		expect(redirect.status).toBe(404);
		expect(redirect.headers.get("Location")).toBeNull();
	});

	it("frames GET and POST HTML only in Builder and rewrites GET only", async () => {
		for (const method of ["GET", "POST"] as const) {
			const response = injectPreviewBridge(
				new Request("https://4321-project-token.build.emdashcms.com/work", {
					method,
					headers: { "Sec-Fetch-Dest": "iframe" },
				}),
				new Response("<html><head></head><body>Draft</body></html>", {
					headers: { "Content-Type": "text/html" },
				}),
			);
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Security-Policy")).toBe(
				"frame-ancestors 'self' https://build.emdashcms.com",
			);
			const body = await response.text();
			expect(body.includes("data-emdash-preview-bridge")).toBe(method === "GET");
		}
		const distinctHost = injectPreviewBridge(
			new Request("https://4321-project-token.preview.build.example.com/work", {
				headers: { "Sec-Fetch-Dest": "iframe" },
			}),
			new Response("<html><head></head><body>Draft</body></html>", {
				headers: { "Content-Type": "text/html" },
			}),
			"build.example.com",
		);
		expect(distinctHost.headers.get("Content-Security-Policy")).toBe(
			"frame-ancestors 'self' https://build.example.com",
		);
	});

	it("leaves non-document subresources on their existing path", async () => {
		const response = injectPreviewBridge(
			new Request("https://4321-project-token.build.emdashcms.com/site.css", {
				headers: { "Sec-Fetch-Dest": "style" },
			}),
			new Response("body{}", { headers: { "Content-Type": "text/css" } }),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("body{}");
	});

	it("leaves disposable quick-tunnel review documents unchanged", async () => {
		const response = injectPreviewBridge(
			new Request("https://branch-preview.trycloudflare.com/", {
				headers: { "Sec-Fetch-Dest": "document" },
			}),
			new Response("<html>Branch Preview</html>", {
				headers: { "Content-Type": "text/html" },
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Security-Policy")).toBeNull();
		expect(await response.text()).toBe("<html>Branch Preview</html>");
	});

	it("enables local edit-mode cookie handling only in localhost preview HTML", async () => {
		const response = () =>
			new Response("<html><head></head><body>Site</body></html>", {
				headers: { "Content-Type": "text/html" },
			});
		const local = await injectPreviewBridge(
			new Request("http://4321-project-token.localhost:5175/"),
			response(),
		).text();
		expect(local).toContain('"localEditorCookies":true');
		const production = await injectPreviewBridge(
			new Request("https://4321-project-token.build.emdashcms.com/"),
			response(),
		).text();
		expect(production).toContain('"localEditorCookies":false');
	});

	it("returns a first-party editor login only to the originating builder project", async () => {
		const response = () =>
			new Response("<html><head></head><body>Site</body></html>", {
				headers: { "Content-Type": "text/html" },
			});
		const projectPath = "/s/11111111-1111-4111-8111-111111111111";
		const valid = await injectPreviewBridge(
			new Request(
				`https://4321-project-token.build.emdashcms.com/work?__emdash_build_return=${encodeURIComponent(projectPath)}`,
				{ headers: { "Sec-Fetch-Dest": "document" } },
			),
			response(),
		).text();
		expect(valid).toContain(
			'"editorReturnUrl":"https://build.emdashcms.com/s/11111111-1111-4111-8111-111111111111"',
		);
		const unsafePost = injectPreviewBridge(
			new Request(
				`https://4321-project-token.build.emdashcms.com/work?__emdash_build_return=${encodeURIComponent(projectPath)}`,
				{ method: "POST", headers: { "Sec-Fetch-Dest": "document" } },
			),
			response(),
		);
		expect(unsafePost.status).toBe(404);

		const escaped = await injectPreviewBridge(
			new Request(
				"https://4321-project-token.build.emdashcms.com/work?__emdash_build_return=https%3A%2F%2Fevil.test%2F",
			),
			response(),
		).text();
		expect(escaped).toContain('"editorReturnUrl":null');

		const nonProject = await injectPreviewBridge(
			new Request(
				"https://4321-project-token.build.emdashcms.com/work?__emdash_build_return=%2Fsettings",
			),
			response(),
		).text();
		expect(nonProject).toContain('"editorReturnUrl":null');
	});

	it("keeps the validated builder return marker through same-origin redirects", () => {
		const projectPath = "/s/11111111-1111-4111-8111-111111111111";
		const request = new Request(
			`https://4321-project-token.build.emdashcms.com/_emdash/api/auth/dev-bypass?redirect=%2Fwork&__emdash_build_return=${encodeURIComponent(projectPath)}`,
			{ headers: { "Sec-Fetch-Dest": "document" } },
		);
		const redirected = injectPreviewBridge(
			request,
			new Response(null, { status: 302, headers: { Location: "/work/" } }),
		);
		expect(redirected.headers.get("Location")).toBe(
			`https://4321-project-token.build.emdashcms.com/work/?__emdash_build_return=${encodeURIComponent(projectPath)}`,
		);

		const external = injectPreviewBridge(
			request,
			new Response(null, { status: 302, headers: { Location: "https://example.test/work" } }),
		);
		expect(external.headers.get("Location")).toBe("https://example.test/work");
	});

	it("serves anonymous snapshots but renders cookie and bearer requests privately", async () => {
		const sandbox = Object.create(Sandbox.prototype) as Sandbox;
		Reflect.set(sandbox, "readCachedPreview", () => ({
			status: 200,
			status_text: "OK",
			headers_json: JSON.stringify([["Content-Type", "text/html"]]),
			body: new TextEncoder().encode("<html>public snapshot</html>").buffer,
			generation: 0,
		}));
		Reflect.set(sandbox, "currentGeneration", () => 0);
		Reflect.set(sandbox, "validatePortToken", async () => true);
		const live = vi.spyOn(CloudflareSandbox.prototype, "fetch").mockImplementation(
			async () =>
				new Response("<html>editor toolbar</html>", {
					headers: { "Content-Type": "text/html", "Cache-Control": "private, no-store" },
				}),
		);
		const request = (headers: Record<string, string> = {}) =>
			new Request("https://4321-project-token.example.test/about", {
				headers: {
					"x-sandbox-preview-proxy": "1",
					"x-sandbox-preview-port": "4321",
					"x-sandbox-preview-token": "token",
					Accept: "text/html",
					...headers,
				},
			});
		try {
			expect(await (await sandbox.fetch(request())).text()).toBe("<html>public snapshot</html>");
			expect(await (await sandbox.fetch(request({ Cookie: "astro-session=editor" }))).text()).toBe(
				"<html>editor toolbar</html>",
			);
			expect(await (await sandbox.fetch(request({ Authorization: "Bearer editor" }))).text()).toBe(
				"<html>editor toolbar</html>",
			);
			expect(await (await sandbox.fetch(request())).text()).toBe("<html>public snapshot</html>");
			expect(live).toHaveBeenCalledTimes(2);

			Reflect.set(sandbox, "readCachedPreview", () => undefined);
			const refresh = vi.fn(async () => ({ success: true }));
			const waitUntil = vi.fn();
			Reflect.set(sandbox, "refreshPreview", refresh);
			Reflect.set(sandbox, "ctx", { waitUntil });
			expect(await (await sandbox.fetch(request({ Cookie: "astro-session=editor" }))).text()).toBe(
				"<html>editor toolbar</html>",
			);
			expect(refresh).toHaveBeenCalledOnce();
			expect(refresh).toHaveBeenCalledWith("/about");
			expect(waitUntil).toHaveBeenCalledOnce();
		} finally {
			live.mockRestore();
		}
	});
});

describe("malformed public preview responses", () => {
	it("retains the last good snapshot when a fresh 200 HTML render is empty", async () => {
		const sandbox = Object.create(Sandbox.prototype) as Sandbox;
		Reflect.set(
			sandbox,
			"renderCanonical",
			async () => new Response("", { headers: { "Content-Type": "text/html" } }),
		);
		Reflect.set(sandbox, "storePreview", async () => "invalid");
		const deleted = vi.fn();
		Reflect.set(sandbox, "deleteCachedPreview", deleted);
		const result = await (
			Reflect.get(sandbox, "renderAndStore") as (
				path: string,
				generation: number,
			) => Promise<unknown>
		).call(sandbox, "/", 2);
		expect(result).toMatchObject({ success: false, rendered: false, invalidHtml: true });
		expect(deleted).not.toHaveBeenCalled();

		const row = {
			status: 200,
			status_text: "OK",
			headers_json: JSON.stringify([["Content-Type", "text/html"]]),
			body: new TextEncoder().encode("<html><body>Earlier site</body></html>").buffer,
			generation: 1,
		};
		Reflect.set(sandbox, "refreshPreview", async () => result);
		Reflect.set(sandbox, "readCachedPreview", () => row);
		Reflect.set(sandbox, "currentGeneration", () => 2);
		const response = await (
			Reflect.get(sandbox, "revalidate") as (
				request: Request,
				path: string,
				cached: typeof row,
			) => Promise<Response>
		).call(sandbox, new Request("https://preview.example/"), "/", row);
		expect(response.headers.get("X-EmDash-Preview-Cache")).toBe("STALE");
		expect(await response.text()).toBe("<html><body>Earlier site</body></html>");
	});

	it("returns an error instead of an empty document on a cache miss", async () => {
		const sandbox = Object.create(Sandbox.prototype) as Sandbox;
		Reflect.set(sandbox, "readCachedPreview", () => undefined);
		Reflect.set(sandbox, "currentGeneration", () => 0);
		Reflect.set(sandbox, "validatePortToken", async () => true);
		Reflect.set(sandbox, "storePreview", async () => "invalid");
		const live = vi
			.spyOn(CloudflareSandbox.prototype, "fetch")
			.mockResolvedValue(new Response("", { headers: { "Content-Type": "text/html" } }));
		try {
			const response = await sandbox.fetch(
				new Request("https://4321-project-token.example.test/", {
					headers: {
						"x-sandbox-preview-proxy": "1",
						"x-sandbox-preview-port": "4321",
						"x-sandbox-preview-token": "token",
						Accept: "text/html",
					},
				}),
			);
			expect(response.status).toBe(503);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		} finally {
			live.mockRestore();
		}
	});

	it("rejects empty HTML even when Vary prevents shared caching", async () => {
		const sandbox = Object.create(Sandbox.prototype) as Sandbox;
		const response = () =>
			new Response("", { headers: { "Content-Type": "text/html", Vary: "Origin" } });
		const store = Reflect.get(sandbox, "storePreview") as (
			path: string,
			response: Response,
			generation: number,
		) => Promise<string>;
		expect(await store.call(sandbox, "/", response(), 1)).toBe("invalid");
		expect(
			await store.call(
				sandbox,
				"/",
				new Response("<html><body><main>Public site</main></body></html>", {
					headers: { "Content-Type": "text/html", Vary: "Origin" },
				}),
				1,
			),
		).toBe("uncacheable");

		Reflect.set(sandbox, "readCachedPreview", () => undefined);
		Reflect.set(sandbox, "currentGeneration", () => 0);
		Reflect.set(sandbox, "validatePortToken", async () => true);
		const live = vi
			.spyOn(CloudflareSandbox.prototype, "fetch")
			.mockImplementation(async () => response());
		try {
			const result = await sandbox.fetch(
				new Request("https://4321-project-token.example.test/", {
					headers: {
						"x-sandbox-preview-proxy": "1",
						"x-sandbox-preview-port": "4321",
						"x-sandbox-preview-token": "token",
						Accept: "text/html",
					},
				}),
			);
			expect(result.status).toBe(503);
		} finally {
			live.mockRestore();
		}
	});

	it("drops a malformed snapshot left by an older version", () => {
		const sandbox = Object.create(Sandbox.prototype) as Sandbox;
		const row = {
			status: 200,
			status_text: "OK",
			headers_json: "[]",
			body: new TextEncoder().encode("<html><body>Partial").buffer,
			generation: 2,
			updated_at: 123,
		};
		const sql = {
			exec: vi.fn((statement: string) => ({
				toArray: () => (statement.startsWith("SELECT") ? [row] : []),
			})),
		};
		Reflect.set(sandbox, "verifiedPreviewRows", new Map());
		Reflect.set(sandbox, "ctx", { storage: { sql } });
		const read = Reflect.get(sandbox, "readCachedPreview") as (path: string) => unknown;
		expect(read.call(sandbox, "/")).toBeUndefined();
		expect(sql.exec).toHaveBeenCalledWith(
			"DELETE FROM builder_preview_cache WHERE path = ? AND generation <= ?",
			"/",
			2,
		);
	});
});
