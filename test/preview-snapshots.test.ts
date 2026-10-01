import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PreviewSnapshots } from "../src/worker/preview-snapshots.js";

/** Durable Object SQL over node:sqlite, as far as PreviewSnapshots uses it. */
function sql() {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query: string, ...bindings: unknown[]) {
			const args = bindings.map((value) =>
				value instanceof ArrayBuffer ? new Uint8Array(value) : value,
			);
			const statement = db.prepare(query);
			const rows = /^\s*(SELECT|PRAGMA)/i.test(query)
				? statement.all(...(args as never[]))
				: (statement.run(...(args as never[])), []);
			return { toArray: () => rows, one: () => rows[0] };
		},
	} as unknown as SqlStorage;
}

const ID = "77777777-7777-4777-8777-777777777777";

function snapshots(live: (request: Request) => Response) {
	const previews = new PreviewSnapshots({
		sql: sql(),
		waitUntil: () => {},
		forwardLive: async (request) => live(request),
		renderCanonical: async (path) => live(new Request(new URL(path, "http://localhost:4321"))),
		validatePortToken: async (port, token) => port === 4321 && token === "tok",
	});
	const get = (path: string, headers: Record<string, string>) =>
		previews.fetch(
			new Request(`https://4321-${ID}-tok.build.emdashcms.com${path}`, {
				headers: {
					"x-sandbox-preview-proxy": "1",
					"x-sandbox-preview-port": "4321",
					"x-sandbox-preview-token": "tok",
					...headers,
				},
			}),
		);
	return { previews, get };
}

const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } });

describe("preview snapshots of partial HTML", () => {
	it("passes a fragment a page fetches through, without caching it", async () => {
		const { previews, get } = snapshots(() => html("<li>Menu</li>"));

		const response = await get("/partials/menu", { Accept: "*/*", "Sec-Fetch-Dest": "empty" });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("<li>Menu</li>");
		expect(previews.hasCachedPreview("/partials/menu")).toBe(false);
	});

	it("never caches a server island or an action", async () => {
		const { previews, get } = snapshots(() => html("<div>Cart: 2</div>"));

		// Even asked for as HTML by a client without fetch metadata.
		for (const path of ["/_server-islands/Cart?e=default&p=&s=", "/_actions/subscribe"]) {
			const response = await get(path, { Accept: "text/html" });
			expect(response.status, path).toBe(200);
		}
		expect(previews.hasCachedPreview("/_server-islands/Cart?e=default&p=&s=")).toBe(false);
	});

	it("still refuses an incomplete page someone navigates to", async () => {
		const { get } = snapshots(() => html("<!doctype html><html><body><h1>Half"));

		const response = await get("/broken", { Accept: "text/html", "Sec-Fetch-Dest": "document" });

		expect(response.status).toBe(503);
	});
});
