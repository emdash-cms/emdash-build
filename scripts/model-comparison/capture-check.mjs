// Proves the capture against a local page that refuses top-level document
// loads the way the draft preview does, with a 100vh hero: the page must
// render, vh must equal the emulated viewport, and tiles must cover the page.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VIEWPORTS, captureSite } from "./capture.mjs";

const page = (
	title,
) => `<!doctype html><html><head><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;font-family:sans-serif}.hero{height:100vh;background:#123}.body{height:3000px;background:linear-gradient(#fa0,#0af)}</style>
</head><body><div class="hero"></div><div class="body"><a href="/about">About</a></div></body></html>`;

const server = createServer((request, response) => {
	if (request.headers["sec-fetch-dest"] === "document") {
		response.writeHead(404).end("Not found.");
		return;
	}
	response.writeHead(200, { "content-type": "text/html" }).end(page(request.url));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
	const pages = await captureSite(
		`${origin}/`,
		["/", "/about"],
		mkdtempSync(join(tmpdir(), "capture-check-")),
	);
	assert.equal(pages.length, 3, "home desktop, home mobile, one inner page");
	for (const captured of pages) {
		assert.equal(captured.error, undefined, `${captured.path} ${captured.viewport} captured`);
		assert.equal(captured.documentStatus, 200, "document answered as an iframe load");
		const viewport = VIEWPORTS[captured.viewport];
		assert.equal(captured.height, viewport.height + 3000, "100vh is the emulated viewport");
		assert.equal(
			captured.tiles.length,
			Math.ceil(captured.height / (viewport.height * 2)),
			"tiles cover the page",
		);
	}
	assert.equal(pages[2].title, "/about", "inner page is its own route");
	console.log(
		"capture check passed",
		pages.map((p) => `${p.path} ${p.viewport} ${p.height}px ${p.tiles.length} tiles`),
	);
} finally {
	server.close();
}
