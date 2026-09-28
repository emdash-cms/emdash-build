import { describe, expect, it } from "vitest";
import { preventPreviewErrorCaching, previewDocumentKey } from "../src/worker/preview-cache.js";

describe("preview document cache routing", () => {
	it("selects public document routes", () => {
		expect(
			previewDocumentKey(
				new Request("https://preview.example/about?draft=1", {
					headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" },
				}),
			),
		).toBe("/about?draft=1");
	});

	it("does not cache CMS, static asset, or WebSocket traffic", () => {
		expect(
			previewDocumentKey(
				new Request("https://preview.example/_emdash/admin", {
					headers: { Accept: "text/html" },
				}),
			),
		).toBeUndefined();
		expect(
			previewDocumentKey(
				new Request("https://preview.example/hero.svg", {
					headers: { Accept: "image/svg+xml" },
				}),
			),
		).toBeUndefined();
		expect(
			previewDocumentKey(
				new Request("https://preview.example/?token=hmr", {
					headers: { Upgrade: "websocket" },
				}),
			),
		).toBeUndefined();
	});
});

describe("preview error responses", () => {
	it("does not cache a stale runtime response while image assets are requested", async () => {
		const request = new Request("https://preview.example/_image?href=photo.jpg", {
			headers: { "x-sandbox-preview-proxy": "1", Accept: "image/webp" },
		});
		const response = preventPreviewErrorCaching(
			request,
			new Response('{"code":"STALE_PREVIEW_URL"}', { status: 410 }),
		);
		expect(response.status).toBe(410);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).toBe('{"code":"STALE_PREVIEW_URL"}');
		const missingAsset = preventPreviewErrorCaching(
			request,
			new Response("missing", {
				status: 404,
				headers: { "Cache-Control": "public, max-age=3600" },
			}),
		);
		expect(missingAsset.headers.get("Cache-Control")).toBe("no-store");
	});

	it("leaves successful, non-preview, and WebSocket responses unchanged", () => {
		const preview = new Request("https://preview.example/photo.webp", {
			headers: { "x-sandbox-preview-proxy": "1" },
		});
		const success = new Response("image", {
			headers: { "Cache-Control": "public, max-age=3600" },
		});
		expect(preventPreviewErrorCaching(preview, success)).toBe(success);

		const failure = new Response("error", { status: 410 });
		expect(preventPreviewErrorCaching(new Request(preview.url), failure)).toBe(failure);
		const upgrade = new Request(preview.url, {
			headers: { "x-sandbox-preview-proxy": "1", Upgrade: "websocket" },
		});
		expect(preventPreviewErrorCaching(upgrade, failure)).toBe(failure);
	});
});
