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

	it("still refuses a cut-off page a script fetches, as a client router does", async () => {
		const { get } = snapshots(() => html("<!doctype html><html><body><h1>Half"));

		const response = await get("/about", { Accept: "text/html", "Sec-Fetch-Dest": "empty" });

		expect(response.status).toBe(503);
	});

	it("serves a page larger than a snapshot can hold, live", async () => {
		const page = `<!doctype html><html><body><p>${"x".repeat(1_200_000)}</p></body></html>`;
		const { previews, get } = snapshots(() => html(page));

		const response = await get("/long", { Accept: "text/html", "Sec-Fetch-Dest": "document" });

		expect(response.status).toBe(200);
		expect((await response.text()).length).toBe(page.length);
		expect(previews.hasCachedPreview("/long")).toBe(false);
	});

	it("still refuses an incomplete page someone navigates to", async () => {
		const { get } = snapshots(() => html("<!doctype html><html><body><h1>Half"));

		const response = await get("/broken", { Accept: "text/html", "Sec-Fetch-Dest": "document" });

		expect(response.status).toBe(503);
	});
});

describe("preview renders", () => {
	it("gives up on a render that never answers, so the route can render again", async () => {
		const page = "<!doctype html><html><body><h1>Home</h1></body></html>";
		const signals: AbortSignal[] = [];
		const previews = new PreviewSnapshots({
			sql: sql(),
			waitUntil: () => {},
			forwardLive: async () => html(page),
			renderCanonical: (_path, signal) => {
				signals.push(signal);
				// The first never answers, even to the abort, as a wedged container would not.
				return signals.length === 1 ? new Promise<Response>(() => {}) : Promise.resolve(html(page));
			},
			validatePortToken: async () => true,
		});
		Reflect.set(previews, "renderTimeoutMs", 20);

		const stuck = await Promise.race([
			previews.refreshPreview("/"),
			new Promise((resolve) => setTimeout(() => resolve("still rendering"), 1_000)),
		]);

		expect(stuck).toMatchObject({ success: false, error: expect.stringMatching(/did not render/) });
		expect(signals[0]?.aborted).toBe(true);
		await expect(previews.refreshPreview("/")).resolves.toMatchObject({ success: true });
		expect(previews.previewSnapshotState("/")).toBe("current");
	});
});
