import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";

const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

const PREVIEW_URL = "https://4321-site-tok.preview.example.test/";
const MCP_URL = `${PREVIEW_URL}_emdash/api/mcp`;

interface CmsConnectionHarness {
	connectMcp(exposedUrl: string, apiToken: string, signal?: AbortSignal): Promise<boolean>;
	getMcpServers(): {
		servers: Record<string, { state: string }>;
		tools: { name: string }[];
	};
}

/**
 * EmDash's MCP server behind the preview URL: stateless Streamable HTTP, so a
 * POST per message and 405 for the GET stream. The first `times` requests for
 * `failing` get the 503 the preview answers while the dev server starts.
 */
function fakeCms(
	failing: string,
	{ times = 1, onFail = () => {} }: { times?: number; onFail?: () => void } = {},
) {
	const methods: string[] = [];
	let failures = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		if (request.url !== MCP_URL) throw new Error(`Unexpected fetch: ${request.url}`);
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const message = (await request.json()) as {
			id?: number | string;
			method: string;
			params?: { protocolVersion?: string };
		};
		methods.push(message.method);
		if (message.method === failing && failures < times) {
			failures += 1;
			onFail();
			return new Response("The preview is starting. Try again shortly.", { status: 503 });
		}
		if (message.id === undefined) return new Response(null, { status: 202 });
		if (message.method === "initialize") {
			return Response.json({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: message.params?.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "emdash", version: "1.0.0" },
				},
			});
		}
		if (message.method === "tools/list") {
			return Response.json({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: [{ name: "schema_list_collections", inputSchema: { type: "object" } }] },
			});
		}
		return Response.json({
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32601, message: "Method not found" },
		});
	});
	return methods;
}

describe("CMS connection", () => {
	beforeEach(async () => {
		await reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{ failure: "the dev server is still starting", failOnce: "initialize" },
		{ failure: "listing the tools fails", failOnce: "tools/list" },
	])("connects on a retry when $failure", async ({ failOnce }) => {
		const agent = testEnv.BuilderAgent.getByName("77777777-7777-4777-8777-000000000001");
		const outcome = await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as CmsConnectionHarness;
			const methods = fakeCms(failOnce);
			// No wait between attempts.
			vi.spyOn(Math, "random").mockReturnValue(0);

			const connected = await harness.connectMcp(PREVIEW_URL, "test-token");
			const { servers, tools } = harness.getMcpServers();
			return {
				connected,
				servers: Object.values(servers).map(({ state }) => state),
				tools: tools.map(({ name }) => name),
				initializes: methods.filter((method) => method === "initialize").length,
			};
		});

		expect(outcome).toEqual({
			connected: true,
			servers: ["ready"],
			tools: ["schema_list_collections"],
			initializes: 2,
		});
	});

	it.each([
		{
			limit: "ten quick attempts",
			id: "77777777-7777-4777-8777-000000000003",
			attemptMs: 0,
			initializes: 10,
		},
		{
			limit: "half a minute of slow ones",
			id: "77777777-7777-4777-8777-000000000004",
			attemptMs: 20_000,
			initializes: 2,
		},
	])("gives up after $limit", async ({ id, attemptMs, initializes }) => {
		const agent = testEnv.BuilderAgent.getByName(id);
		const outcome = await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as CmsConnectionHarness;
			// Each failed attempt takes `attemptMs`, as when the dev server holds requests.
			let elapsed = 0;
			const now = Date.now.bind(Date);
			vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
			const methods = fakeCms("initialize", {
				times: Infinity,
				onFail: () => (elapsed += attemptMs),
			});
			vi.spyOn(Math, "random").mockReturnValue(0);

			const connected = await harness.connectMcp(PREVIEW_URL, "test-token");
			vi.mocked(Date.now).mockRestore();
			return {
				connected,
				initializes: methods.filter((method) => method === "initialize").length,
			};
		});

		expect(outcome).toEqual({ connected: false, initializes });
	});

	it("stops retrying as soon as setup is stopped", async () => {
		const agent = testEnv.BuilderAgent.getByName("77777777-7777-4777-8777-000000000002");
		const outcome = await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as CmsConnectionHarness;
			const stop = new AbortController();
			// The user stops setup while the first attempt fails.
			const methods = fakeCms("initialize", { onFail: () => stop.abort() });
			// The longest wait between attempts.
			vi.spyOn(Math, "random").mockReturnValue(0.999);

			const connecting = harness.connectMcp(PREVIEW_URL, "test-token", stop.signal).then(
				() => "connected",
				() => "stopped",
			);
			const result = await Promise.race([
				connecting,
				new Promise((resolve) => setTimeout(resolve, 1000, "still retrying")),
			]);
			return { result, methods };
		});

		expect(outcome).toEqual({ result: "stopped", methods: ["initialize"] });
	});
});
