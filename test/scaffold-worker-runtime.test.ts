import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCHEDULED_PUBLISHES_PATH, SITE_DEV_ONLY_ROUTES } from "../src/worker/site-dev-routes.js";
import { CANONICAL_WORKER_TS } from "../src/worker/tools.js";

const emdash = {
	fetch: vi.fn(async (_request: Request) => new Response("from EmDash")),
	runScheduledTasks: vi.fn(async () => ({ published: [] as unknown[] })),
};
const stubs: Record<string, () => Record<string, unknown>> = {
	"@emdash-cms/cloudflare/worker": () => ({
		default: { fetch: emdash.fetch },
		createScheduledHandler: () => () => {},
		PluginBridge: class {},
	}),
	"emdash/middleware": () => ({ runScheduledTasks: emdash.runScheduledTasks }),
};
// Outside the repository, so the worker loads with nothing installed beside it but these stubs.
const workerFile = join(mkdtempSync(join(tmpdir(), "site-worker-")), "worker.ts");
writeFileSync(workerFile, CANONICAL_WORKER_TS);

type SiteWorker = { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };

/** The site's worker entry as a fresh module, as the dev server loads it again after a reload. */
async function loadWorker(): Promise<SiteWorker> {
	vi.resetModules();
	for (const [specifier, stub] of Object.entries(stubs)) vi.doMock(specifier, stub);
	return (await import(/* @vite-ignore */ pathToFileURL(workerFile).href)).default as SiteWorker;
}

const call = (worker: SiteWorker, url: string, init?: RequestInit) =>
	worker.fetch(new Request(url, init), {}, {});
const sweep = (worker: SiteWorker, host = "localhost:4321") =>
	call(worker, `http://${host}/_emdash/api/dev/scheduled-tasks`, { method: "POST" });
const count = async (worker: SiteWorker) =>
	(await call(worker, `http://localhost:4321${SCHEDULED_PUBLISHES_PATH}`)).json();

describe("the site worker's count of scheduled publishes", () => {
	beforeEach(() => {
		delete (globalThis as { emdashBuildScheduledPublishes?: unknown })
			.emdashBuildScheduledPublishes;
		emdash.fetch.mockClear();
		emdash.runScheduledTasks.mockClear();
	});

	it("runs EmDash's maintenance sweep itself and counts what it published", async () => {
		const worker = await loadWorker();
		const before = (await count(worker)) as { boot: string; published: number };
		expect(before).toEqual({ boot: expect.any(String), published: 0 });

		emdash.runScheduledTasks.mockResolvedValueOnce({ published: [{}, {}, {}] });
		const response = await sweep(worker);
		await sweep(worker);

		expect(response.status).toBe(204);
		expect(emdash.runScheduledTasks).toHaveBeenCalledTimes(2);
		expect(emdash.fetch).not.toHaveBeenCalled();
		expect(await count(worker)).toEqual({ boot: before.boot, published: 3 });
	});

	it("keeps the count when the dev server loads the module again", async () => {
		emdash.runScheduledTasks.mockResolvedValueOnce({ published: [{}] });
		const first = await loadWorker();
		await sweep(first);
		const counted = await count(first);

		expect(await count(await loadWorker())).toEqual(counted);
	});

	it("keeps the same dev-only routes as the preview router", () => {
		const list = /const localOnlyDevRoutes = new Set\(\[([^\]]*)\]\);/.exec(
			CANONICAL_WORKER_TS,
		)?.[1];
		const routes = [...(list ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
		expect(new Set(routes)).toEqual(SITE_DEV_ONLY_ROUTES);
	});

	const devRoutes = [...SITE_DEV_ONLY_ROUTES];
	/**
	 * Ways to write a route that must not get through. Astro's dev server routes a
	 * leading `//`, dot segments and an `.html` or `/index.html` suffix, encoded or
	 * not, to the route; the others are refused as well.
	 */
	const spellings = (route: string) => {
		const cut = route.lastIndexOf("/");
		const [head, tail] = [route.slice(0, cut), route.slice(cut + 1)];
		return [
			route,
			`${route}/`,
			`/${route}`,
			`${head}//${tail}`,
			`${head}%5C${tail}`,
			`${head}%255C${tail}`,
			`${head}%2F${tail}`,
			`${head}/%2e/${tail}`,
			`${head}/x/%252e%252e/${tail}`,
			route.toUpperCase(),
			`${route}.html`,
			`${route}/index.html`,
			`${route}.html.html`,
			`${route}.htm%6c`,
			`${route}%2ehtml`,
		].map((path) => `${path}?token=1`);
	};

	it.each(devRoutes.flatMap(spellings))("keeps %s off the public preview", async (path) => {
		const worker = await loadWorker();
		const host = "4321-project-token.build.emdashcms.com";
		const asked = (url: string, headers: Record<string, string> = {}) =>
			Promise.all(
				["GET", "POST"].map(
					async (method) => (await call(worker, url, { method, headers })).status,
				),
			);

		// The Sandbox forwards preview traffic to localhost, naming the public host here.
		expect(
			await asked(`http://localhost:4321${path}`, {
				"X-Forwarded-Host": host,
				"X-Forwarded-Proto": "https",
			}),
		).toEqual([404, 404]);
		// A quick tunnel reaches the dev server under the public host itself.
		expect(await asked(`https://${host}${path}`)).toEqual([404, 404]);
		expect(emdash.runScheduledTasks).not.toHaveBeenCalled();
		expect(emdash.fetch).not.toHaveBeenCalled();
	});

	it.each([
		"/blog//first-post",
		"/caf%C3%A9",
		"/_emdash/api/setup/status",
		"/_emdash/api/dev/emails",
	])("still passes %s from the public preview to EmDash", async (path) => {
		const worker = await loadWorker();
		const response = await call(worker, `http://localhost:4321${path}`, {
			headers: { "X-Forwarded-Host": "4321-project-token.build.emdashcms.com" },
		});

		expect(await response.text()).toBe("from EmDash");
	});

	it("still answers the container's own requests, which name no other host", async () => {
		const worker = await loadWorker();
		const local = await call(worker, "http://localhost:4321/_emdash/api/setup/dev-bypass?token=1", {
			headers: { "X-Forwarded-Host": "localhost:4321" },
		});

		expect(await local.text()).toBe("from EmDash");
		expect((await sweep(worker)).status).toBe(204);
	});

	it("leaves the maintenance route's other methods to EmDash", async () => {
		const worker = await loadWorker();
		const response = await call(worker, "http://localhost:4321/_emdash/api/dev/scheduled-tasks");

		expect(await response.text()).toBe("from EmDash");
		expect(emdash.runScheduledTasks).not.toHaveBeenCalled();
	});
});
