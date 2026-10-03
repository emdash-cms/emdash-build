import { describe, expect, it, vi } from "vitest";
import { parsePreviewHost, routePreviewRequest } from "../src/worker/preview-router.js";

const ID = "77777777-7777-4777-8777-777777777777";
const HOST = "build.emdashcms.com";

describe("preview hosts", () => {
	it("names the port, project and token of a preview URL", () => {
		expect(
			parsePreviewHost(new URL(`https://4321-${ID}-a1b2c3d4e5f60718.${HOST}/work`), HOST),
		).toEqual({
			port: 4321,
			sandboxId: ID,
			token: "a1b2c3d4e5f60718",
		});
		// Hostnames are case-insensitive.
		expect(
			parsePreviewHost(
				new URL(`https://4321-${ID.toUpperCase()}-TOKEN.BUILD.emdashcms.com/`),
				HOST,
			),
		).toMatchObject({
			sandboxId: ID,
			token: "token",
		});
		// Local development serves previews under localhost names.
		expect(parsePreviewHost(new URL(`http://4321-${ID}-tok.localhost:5173/`), HOST)).toMatchObject({
			port: 4321,
		});
		expect(
			parsePreviewHost(new URL(`http://4321-${ID}-tok.emdash.localhost:5173/`), HOST),
		).toMatchObject({ port: 4321 });
	});

	it.each([
		["another zone", `https://4321-${ID}-tok.example.com/`],
		["a nested subdomain", `https://x.4321-${ID}-tok.${HOST}/`],
		["the app host itself", `https://${HOST}/`],
		["an id that is not a project id", `https://4321-project-tok.${HOST}/`],
		["the control-plane port", `https://3000-${ID}-tok.${HOST}/`],
		["a privileged port", `https://0080-${ID}-tok.${HOST}/`],
		["a token longer than 16 characters", `https://4321-${ID}-${"a".repeat(17)}.${HOST}/`],
		["a token with other characters", `https://4321-${ID}-to-k.${HOST}/`],
	])("ignores %s", (_, url) => {
		expect(parsePreviewHost(new URL(url), HOST)).toBeUndefined();
	});
});

describe("preview routing", () => {
	function sandbox(response: Response | Error = new Response("ok")) {
		const fetch = vi.fn(async (_request: Request) => {
			if (response instanceof Error) throw response;
			return response;
		});
		const getByName = vi.fn(() => ({ fetch }));
		return { fetch, getByName, env: { PREVIEW_HOSTNAME: HOST, Sandbox: { getByName } } as never };
	}

	it("forwards a preview request to its Sandbox with trusted routing headers", async () => {
		const { fetch, getByName, env } = sandbox();
		const response = await routePreviewRequest(
			new Request(`https://4321-${ID}-tok.${HOST}/about?x=1`, {
				headers: {
					Accept: "text/html",
					"x-sandbox-preview-port": "3000",
					"x-sandbox-preview-token": "forged",
					"x-sandbox-preview-sandbox-id": "someone-else",
				},
			}),
			env,
		);

		expect(await response?.text()).toBe("ok");
		expect(getByName).toHaveBeenCalledWith(ID);
		const forwarded = fetch.mock.calls[0]![0];
		expect(forwarded.url).toBe(`https://4321-${ID}-tok.${HOST}/about?x=1`);
		expect(Object.fromEntries(forwarded.headers)).toMatchObject({
			accept: "text/html",
			"x-sandbox-preview-proxy": "1",
			"x-sandbox-preview-port": "4321",
			"x-sandbox-preview-token": "tok",
			"x-sandbox-preview-sandbox-id": ID,
		});
	});

	it("keeps a request's method, body and WebSocket upgrade", async () => {
		const { fetch, env } = sandbox();
		await routePreviewRequest(
			new Request(`https://4321-${ID}-tok.${HOST}/_emdash/api/media`, {
				method: "POST",
				body: "upload",
				redirect: "manual",
			}),
			env,
		);
		await routePreviewRequest(
			new Request(`https://4321-${ID}-tok.${HOST}/`, {
				headers: {
					Upgrade: "websocket",
					Connection: "Upgrade",
					"Sec-WebSocket-Protocol": "vite-hmr",
				},
			}),
			env,
		);

		const [post, upgrade] = fetch.mock.calls.map(([request]) => request);
		expect(post!.method).toBe("POST");
		expect(post!.redirect).toBe("manual");
		expect(await post!.text()).toBe("upload");
		expect(upgrade!.headers.get("Upgrade")).toBe("websocket");
		expect(upgrade!.headers.get("Sec-WebSocket-Protocol")).toBe("vite-hmr");
	});

	it("leaves other hosts to the app", async () => {
		const { getByName, env } = sandbox();
		await expect(
			routePreviewRequest(new Request(`https://${HOST}/s/${ID}`), env),
		).resolves.toBeUndefined();
		expect(getByName).not.toHaveBeenCalled();
	});

	it("answers 500 when the Sandbox call fails", async () => {
		const { env } = sandbox(new Error("Durable Object reset"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await routePreviewRequest(
				new Request(`https://4321-${ID}-tok.${HOST}/`),
				env,
			);
			expect(response?.status).toBe(500);
		} finally {
			error.mockRestore();
		}
	});
});
