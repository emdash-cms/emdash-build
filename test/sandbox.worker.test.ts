import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PORT_TOKENS_KEY } from "../src/worker/preview-tokens.js";
import { sendableCloseCode, type Sandbox } from "../src/worker/sandbox.js";
import type { SandboxCapacity } from "../src/worker/sandbox-capacity.js";

const testEnv = env as typeof env & {
	Sandbox: DurableObjectNamespace<Sandbox>;
	SandboxCapacity: DurableObjectNamespace<SandboxCapacity>;
};

const ID = "55555555-5555-4555-8555-555555555555";
const HOST = `4321-${ID}-tok.build.emdashcms.com`;

type FetchHandler = (request: Request, port: number) => Promise<Response>;

/** `ctx.container` as far as the Sandbox uses it; nothing really runs. */
function fakeContainer(fetch: FetchHandler = async () => new Response("live")) {
	const state = { running: false, destroyed: 0, starts: [] as unknown[], inactivityMs: 0 };
	const encoder = new TextEncoder();
	return {
		state,
		get running() {
			return state.running;
		},
		images: { sandbox: "registry.example/sandbox@sha256:abc" },
		start(options: unknown) {
			state.starts.push(options);
			state.running = true;
		},
		async destroy() {
			state.running = false;
			state.destroyed += 1;
		},
		async setInactivityTimeout(ms: number) {
			state.inactivityMs = ms;
		},
		getTcpPort(port: number) {
			return {
				fetch: (input: RequestInfo, init?: RequestInit) => fetch(new Request(input, init), port),
			};
		},
		async exec() {
			return {
				exitCode: Promise.resolve(0),
				output: async () => ({
					stdout: encoder.encode("").buffer,
					stderr: encoder.encode("").buffer,
					exitCode: 0,
				}),
				kill() {},
				stdout: null,
				stderr: null,
				stdin: null,
				pid: 1,
				isPty: false,
				resize() {},
			};
		},
	};
}

function install(instance: Sandbox, container?: ReturnType<typeof fakeContainer>) {
	if (container) Reflect.set(instance, "container", () => container);
	return instance;
}

function preview(path = "/", headers: Record<string, string> = {}) {
	return new Request(`https://${HOST}${path}`, {
		headers: {
			"x-sandbox-preview-proxy": "1",
			"x-sandbox-preview-port": "4321",
			"x-sandbox-preview-token": "tok",
			"x-sandbox-preview-sandbox-id": ID,
			...headers,
		},
	});
}

const stub = (name = ID) => testEnv.Sandbox.getByName(name);
const capacityStub = () => testEnv.SandboxCapacity.getByName("global");

describe("Sandbox preview routing", () => {
	beforeEach(async () => {
		await reset();
	});

	it("accepts the tokens the 0.12 SDK stored and refuses anything else", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			const container = fakeContainer();
			container.state.running = true;
			install(instance, container);
			await state.storage.put(PORT_TOKENS_KEY, { "4321": { token: "tok", name: "preview" } });

			expect((await instance.fetch(preview("/style.css"))).status).toBe(200);
			expect(
				(await instance.fetch(preview("/style.css", { "x-sandbox-preview-token": "nope" }))).status,
			).toBe(404);
			expect((await instance.fetch(new Request(`https://${HOST}/`))).status).toBe(404);
			await instance.unexposePort(4321);
			expect((await instance.fetch(preview("/style.css"))).status).toBe(404);
		});
	});

	it("forwards live requests as the 0.12 SDK did, without the routing headers", async () => {
		await runInDurableObject(stub(), async (instance) => {
			let forwarded: Request | undefined;
			const container = fakeContainer(async (request) => {
				forwarded = request;
				return new Response("ok");
			});
			container.state.running = true;
			install(instance, container);
			await instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" });

			await instance.fetch(preview("/_emdash/api/content?x=1", { Accept: "application/json" }));

			expect(forwarded?.url).toBe("http://localhost:4321/_emdash/api/content?x=1");
			expect(forwarded?.redirect).toBe("manual");
			expect(forwarded?.headers.get("X-Forwarded-Host")).toBe(HOST);
			expect(forwarded?.headers.get("X-Forwarded-Proto")).toBe("https");
			expect(forwarded?.headers.get("X-Original-URL")).toBe(
				`https://${HOST}/_emdash/api/content?x=1`,
			);
			expect(forwarded?.headers.get("x-sandbox-preview-token")).toBeNull();
		});
	});

	it("never starts a stopped container for preview traffic, and says it is paused", async () => {
		await runInDurableObject(stub(), async (instance) => {
			const container = fakeContainer();
			install(instance, container);
			await instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" });

			const response = await instance.fetch(preview("/_astro/app.js"));
			expect(response.status).toBe(503);
			expect(response.headers.get("X-EmDash-Sandbox")).toBe("stopped");
			expect(container.state.starts).toEqual([]);
		});
	});

	it("answers 503 while the dev server is not listening", async () => {
		await runInDurableObject(stub(), async (instance) => {
			const container = fakeContainer(async () => {
				throw new Error("The container is not listening in the TCP address 10.0.0.1:4321");
			});
			container.state.running = true;
			install(instance, container);
			await instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" });

			expect((await instance.fetch(preview("/_astro/app.js"))).status).toBe(503);
		});
	});

	it("relays HMR WebSockets with the upstream handshake", async () => {
		await runInDurableObject(stub(), async (instance) => {
			let upstreamServer: WebSocket | undefined;
			const container = fakeContainer(async (request) => {
				expect(request.url).toBe(`http://${HOST}/`);
				const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
				server.accept();
				upstreamServer = server;
				return new Response(null, {
					status: 101,
					webSocket: client,
					headers: { "Sec-WebSocket-Protocol": "vite-hmr" },
				});
			});
			container.state.running = true;
			install(instance, container);
			await instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" });

			const response = await instance.fetch(
				preview("/", { Upgrade: "websocket", "Sec-WebSocket-Protocol": "vite-hmr" }),
			);
			expect(response.status).toBe(101);
			expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("vite-hmr");
			const browser = response.webSocket!;
			browser.accept();
			const received = new Promise<string>((resolve) =>
				browser.addEventListener("message", (event) => resolve(String(event.data))),
			);
			const reached = new Promise<string>((resolve) =>
				upstreamServer!.addEventListener("message", (event) => resolve(String(event.data))),
			);
			browser.send("from browser");
			upstreamServer!.send("from vite");
			expect(await reached).toBe("from browser");
			expect(await received).toBe("from vite");
		});
	});

	it("passes on a close code it can send for every code it can receive", () => {
		expect(sendableCloseCode(1000)).toBe(1000);
		expect(sendableCloseCode(1012)).toBe(1012);
		expect(sendableCloseCode(4001)).toBe(4001);
		expect(sendableCloseCode(1005)).toBe(1000);
		for (const reserved of [1004, 1006, 1015]) expect(sendableCloseCode(reserved)).toBe(1011);
		// Each mapped code is accepted by close().
		for (const code of [1000, 1011, 1012]) {
			const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
			server.accept();
			client.accept();
			expect(() => server.close(code, "test")).not.toThrow();
		}
	});

	it("builds the same preview URL the 0.12 SDK issued", async () => {
		await runInDurableObject(stub(), async (instance) => {
			await expect(
				instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" }),
			).resolves.toEqual({ url: `https://${HOST}/` });
		});
	});
});

describe("Sandbox lifetime", () => {
	beforeEach(async () => {
		await reset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function builderAgent(verdict: { busy: boolean }) {
		const prepareSandboxStop = vi.fn(async (_idleForMs: number) => verdict);
		const markSandboxStopped = vi.fn(async () => {});
		return {
			prepareSandboxStop,
			markSandboxStopped,
			binding: { getByName: () => ({ prepareSandboxStop, markSandboxStopped }) },
		};
	}

	it("starts within the cap, then renews its slot while the owner is active", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			const container = fakeContainer();
			install(instance, container);

			await expect(instance.ensureRunning()).resolves.toEqual({ ok: true });
			expect(container.state.starts).toEqual([
				expect.objectContaining({ enableInternet: true, image: container.images.sandbox }),
			]);
			expect(await state.storage.getAlarm()).not.toBeNull();

			await instance.alarm();
			expect(container.state.running).toBe(true);
			expect(await state.storage.getAlarm()).not.toBeNull();
		});
		const stats = await runInDurableObject(
			testEnv.SandboxCapacity.getByName("global"),
			(capacity) => capacity.stats(),
		);
		expect(stats.active).toBe(1);
	});

	it("stops after ten idle minutes once BuilderAgent has saved the site, and frees its slot", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			const agent = builderAgent({ busy: false });
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", agent.binding);

			vi.setSystemTime(base + 9 * 60_000);
			await instance.alarm();
			expect(container.state.running).toBe(true);

			vi.setSystemTime(base + 10 * 60_000);
			await instance.alarm();
			expect(agent.prepareSandboxStop).toHaveBeenCalledWith(10 * 60_000);
			expect(container.state.running).toBe(false);
			expect(await state.storage.getAlarm()).toBeNull();
		});
		const stats = await runInDurableObject(
			testEnv.SandboxCapacity.getByName("global"),
			(capacity) => capacity.stats(),
		);
		expect(stats.active).toBe(0);
	});

	it("lets BuilderAgent's checkpoint run before the stop without counting as activity", async () => {
		await runInDurableObject(stub(), async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			let work: "checkpoint" | "turn" = "checkpoint";
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", {
				getByName: () => ({
					prepareSandboxStop: async () => {
						// The save runs commands; a new turn's would count, a checkpoint's not.
						await instance.exec("git push", { background: work === "checkpoint" });
						return { busy: false };
					},
					markSandboxStopped: async () => {},
				}),
			});

			vi.setSystemTime(base + 11 * 60_000);
			work = "turn";
			await instance.alarm();
			expect(container.state.running).toBe(true);

			vi.setSystemTime(base + 22 * 60_000);
			work = "checkpoint";
			await instance.alarm();
			expect(container.state.running).toBe(false);
		});
	});

	it("keeps running while BuilderAgent has work under way, or cannot be asked", async () => {
		await runInDurableObject(stub(), async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			Reflect.set(
				Reflect.get(instance, "env") as object,
				"BuilderAgent",
				builderAgent({ busy: true }).binding,
			);

			vi.setSystemTime(base + 30 * 60_000);
			await instance.alarm();
			expect(container.state.running).toBe(true);

			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", {
				getByName: () => ({
					prepareSandboxStop: async () => {
						throw new Error("BuilderAgent unavailable");
					},
				}),
			});
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await instance.alarm();
			} finally {
				warn.mockRestore();
			}
			expect(container.state.running).toBe(true);
		});
	});

	it("counts preview page loads as activity, but not HMR or CMS-connection traffic", async () => {
		await runInDurableObject(stub(), async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer(async (request) => {
				if (request.headers.get("Upgrade") !== "websocket") return new Response("ok");
				const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
				server.accept();
				return new Response(null, { status: 101, webSocket: client });
			});
			install(instance, container);
			await instance.ensureRunning();
			await instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" });
			const agent = builderAgent({ busy: false });
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", agent.binding);

			vi.setSystemTime(base + 8 * 60_000);
			await instance.fetch(preview("/_astro/app.js"));
			vi.setSystemTime(base + 12 * 60_000);
			await instance.alarm();
			expect(container.state.running).toBe(true);

			// HMR and BuilderAgent's MCP calls keep coming; the owner is away.
			vi.setSystemTime(base + 15 * 60_000);
			const hmr = await instance.fetch(preview("/", { Upgrade: "websocket" }));
			hmr.webSocket!.accept();
			const closed = new Promise<number>((resolve) =>
				hmr.webSocket!.addEventListener("close", (event) => resolve(event.code)),
			);
			await instance.fetch(
				new Request(`https://${HOST}/_emdash/api/mcp`, {
					method: "POST",
					headers: preview().headers,
				}),
			);
			vi.setSystemTime(base + 19 * 60_000);
			await instance.alarm();
			expect(container.state.running).toBe(false);
			// The relayed socket closes with the container.
			expect(await closed).toBe(1012);
		});
	});

	it("lets preview traffic alone keep a container for two hours after BuilderAgent last used it", async () => {
		await runInDurableObject(stub(), async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer(async () => new Response("Not found", { status: 404 }));
			install(instance, container);
			await instance.ensureRunning();
			await instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" });
			const agent = builderAgent({ busy: false });
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", agent.binding);

			// The owner left; an uptime monitor keeps fetching a missing asset.
			let stoppedAt: number | undefined;
			for (let minute = 9; minute <= 4 * 60 && stoppedAt === undefined; minute += 9) {
				vi.setSystemTime(base + minute * 60_000);
				await instance.fetch(preview("/nope.ico"));
				await instance.alarm();
				if (!container.state.running) stoppedAt = minute;
			}

			expect(stoppedAt).toBeGreaterThanOrEqual(2 * 60);
			expect(stoppedAt).toBeLessThanOrEqual(2 * 60 + 20);
			expect(agent.prepareSandboxStop).toHaveBeenCalled();
		});
	});

	it("keeps a container while BuilderAgent says the owner's tab is in use, however long", async () => {
		await runInDurableObject(stub(), async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			await instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" });
			Reflect.set(
				Reflect.get(instance, "env") as object,
				"BuilderAgent",
				builderAgent({ busy: false }).binding,
			);

			for (let minute = 4; minute <= 4 * 60; minute += 4) {
				vi.setSystemTime(base + minute * 60_000);
				// The builder's heartbeat, while the owner edits in the Admin tab.
				instance.touch();
				await instance.fetch(preview("/_emdash/api/content/posts", { Cookie: "astro-session=s" }));
				await instance.alarm();
			}

			expect(container.state.running).toBe(true);
		});
	});

	it("counts a preview load with a cookie like any other preview load", async () => {
		await runInDurableObject(stub(), async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			await instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" });
			Reflect.set(
				Reflect.get(instance, "env") as object,
				"BuilderAgent",
				builderAgent({ busy: false }).binding,
			);

			// Anyone can send a cookie; only BuilderAgent can say the owner is here.
			for (let minute = 9; minute <= 4 * 60 && container.state.running; minute += 9) {
				vi.setSystemTime(base + minute * 60_000);
				await instance.fetch(preview("/", { Cookie: "a=1", Authorization: "Bearer x" }));
				await instance.alarm();
			}

			expect(container.state.running).toBe(false);
		});
	});

	it("stops after two idle hours even while BuilderAgent reports work, and says so", async () => {
		await runInDurableObject(stub(), async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			const prepareSandboxStop = vi.fn(async () => ({ busy: true }));
			const markSandboxStopped = vi.fn(async () => {});
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", {
				getByName: () => ({ prepareSandboxStop, markSandboxStopped }),
			});

			vi.setSystemTime(base + 90 * 60_000);
			await instance.alarm();
			expect(container.state.running).toBe(true);

			vi.setSystemTime(base + 2 * 60 * 60_000);
			await instance.alarm();
			expect(container.state.running).toBe(false);
			expect(prepareSandboxStop).toHaveBeenCalledOnce();
			expect(markSandboxStopped).toHaveBeenCalledOnce();
		});
	});

	it("keeps its slot while BuilderAgent's save before a stop is slow, then stays up", async () => {
		await runInDurableObject(capacityStub(), (capacity) => {
			(Reflect.get(capacity, "env") as Record<string, unknown>).SANDBOX_MAX_CONCURRENT = "1";
		});
		await runInDurableObject(stub(), async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			Reflect.set(instance, "prepareStopTimeoutMs", 50);
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", {
				getByName: () => ({
					// The save never finishes, as with an Artifacts outage.
					prepareSandboxStop: () => new Promise(() => {}),
					markSandboxStopped: async () => {},
				}),
			});
			// The lease would have lapsed by now without the alarm's renewal.
			vi.setSystemTime(base + 2.5 * 60_000);
			await instance.alarm();
			vi.setSystemTime(base + 12 * 60_000);
			const asked = Date.now();

			await instance.alarm();

			expect(container.state.running).toBe(true);
			const lease = await runInDurableObject(capacityStub(), (capacity) => {
				const sql = Reflect.get(capacity, "sql") as SqlStorage;
				return sql.exec<{ holder: string; expires_at: number }>("SELECT * FROM leases").toArray();
			});
			expect(lease).toEqual([expect.objectContaining({ holder: ID })]);
			expect(lease[0]!.expires_at).toBeGreaterThanOrEqual(asked + 2 * 60_000);
		});
	});

	it("takes its slot back when the lease lapsed while it ran", async () => {
		await runInDurableObject(capacityStub(), (capacity) => {
			(Reflect.get(capacity, "env") as Record<string, unknown>).SANDBOX_MAX_CONCURRENT = "1";
		});
		await runInDurableObject(stub(), async (instance) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			install(instance, fakeContainer());
			await instance.ensureRunning();
			Reflect.set(
				Reflect.get(instance, "env") as object,
				"BuilderAgent",
				builderAgent({ busy: true }).binding,
			);
			// No alarm ran for four minutes, and another site took the slot.
			vi.setSystemTime(base + 4 * 60_000);
			await expect(capacityStub().acquire("other-site")).resolves.toMatchObject({ granted: true });

			await instance.alarm();
		});
		const stats = await runInDurableObject(capacityStub(), (capacity) => capacity.stats());
		expect(stats).toMatchObject({ active: 2, waiting: 0 });
	});

	it("does not keep a slot for a site deleted while the alarm renewed it", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			install(instance, fakeContainer());
			await instance.ensureRunning();
			const instanceEnv = Reflect.get(instance, "env") as Record<string, unknown>;
			const real = instanceEnv.SandboxCapacity as typeof testEnv.SandboxCapacity;
			let renewing!: () => void;
			let entered!: () => void;
			const renewed = new Promise<void>((resolve) => (renewing = resolve));
			const inRenewal = new Promise<void>((resolve) => (entered = resolve));
			instanceEnv.SandboxCapacity = {
				getByName: () => ({
					renew: async () => {
						entered();
						await renewed;
						return false;
					},
					reclaim: (holder: string) => real.getByName("global").reclaim(holder),
					release: (holder: string) => real.getByName("global").release(holder),
					releaseLease: (holder: string) => real.getByName("global").releaseLease(holder),
				}),
			};
			try {
				const alarm = instance.alarm();
				await inRenewal;
				await instance.deleteProjectData();
				renewing();
				await alarm;
			} finally {
				instanceEnv.SandboxCapacity = real;
			}

			expect(await state.storage.getAlarm()).toBeNull();
		});
		const stats = await runInDurableObject(capacityStub(), (capacity) => capacity.stats());
		expect(stats.active).toBe(0);
	});

	it("leaves a site deleted while BuilderAgent was asked to stop it alone", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			install(instance, fakeContainer());
			await instance.ensureRunning();
			const markSandboxStopped = vi.fn(async () => {});
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", {
				getByName: () => ({
					prepareSandboxStop: async () => {
						await instance.deleteProjectData();
						return { busy: false };
					},
					markSandboxStopped,
				}),
			});

			vi.setSystemTime(base + 10 * 60_000);
			await instance.alarm();

			// Its BuilderAgent is gone with it: telling it the container stopped would wake it.
			expect(markSandboxStopped).not.toHaveBeenCalled();
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it("does not arm an alarm for a site deleted as the alarm finished", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			container.setInactivityTimeout = async () => {
				await instance.deleteProjectData();
			};

			await instance.alarm();

			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it("keeps a container that failed to stop, and its slot, until the alarm tries again", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			const base = Date.now();
			vi.setSystemTime(base);
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			const agent = builderAgent({ busy: false });
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", agent.binding);
			container.destroy = async () => {
				throw new Error("destroy failed");
			};

			vi.setSystemTime(base + 10 * 60_000);
			// The platform clears an alarm as it fires it.
			await state.storage.deleteAlarm();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				await instance.alarm();
			} finally {
				warn.mockRestore();
			}

			expect(container.state.running).toBe(true);
			expect(agent.markSandboxStopped).not.toHaveBeenCalled();
			expect(await state.storage.getAlarm()).not.toBeNull();
			await expect(instance.ensureRunning()).resolves.toEqual({ ok: true });
		});
		const stats = await runInDurableObject(capacityStub(), (capacity) => capacity.stats());
		expect(stats.active).toBe(1);
	});

	it("asks BuilderAgent before stopping a container it never saw used", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			// A container left running by the 0.12 SDK: no activity was ever recorded.
			const container = fakeContainer();
			container.state.running = true;
			install(instance, container);
			await state.storage.put("v1:name", ID);
			const agent = builderAgent({ busy: false });
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", agent.binding);
			const base = Date.now();
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(base);

			await instance.alarm();
			expect(container.state.running).toBe(true);
			vi.setSystemTime(base + 10 * 60_000);
			await instance.alarm();
			expect(agent.prepareSandboxStop).toHaveBeenCalledOnce();
			expect(container.state.running).toBe(false);
		});
	});

	it("keeps a waiting site's place in the queue when its old container is found stopped", async () => {
		const capacity = testEnv.SandboxCapacity.getByName("global");
		await runInDurableObject(capacity, (instance) => {
			const env = Reflect.get(instance, "env") as Record<string, unknown>;
			env.SANDBOX_MAX_CONCURRENT = "1";
			instance.acquire("someone-else");
			expect(instance.acquire(ID)).toMatchObject({ granted: false, position: 1 });
		});
		await runInDurableObject(stub(), async (instance) => {
			install(instance, fakeContainer());
			Reflect.set(
				Reflect.get(instance, "env") as object,
				"BuilderAgent",
				builderAgent({ busy: false }).binding,
			);
			await instance.alarm();
		});
		await runInDurableObject(capacity, (instance) => {
			expect(instance.stats()).toMatchObject({ waiting: 1 });
		});
	});

	it("tells BuilderAgent when the container stopped some other way", async () => {
		await runInDurableObject(stub(), async (instance) => {
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			const markSandboxStopped = vi.fn(async () => {});
			Reflect.set(Reflect.get(instance, "env") as object, "BuilderAgent", {
				getByName: () => ({ markSandboxStopped }),
			});

			container.state.running = false;
			await instance.alarm();
			expect(markSandboxStopped).toHaveBeenCalledOnce();
		});
	});

	it("does nothing on an alarm left from before, when no container runs", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			install(instance, fakeContainer());
			await instance.alarm();
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});

	it("deletes the container, its slot and everything stored", async () => {
		await runInDurableObject(stub(), async (instance, state) => {
			const container = fakeContainer();
			install(instance, container);
			await instance.ensureRunning();
			await instance.exposePort(4321, { hostname: "build.emdashcms.com", token: "tok" });

			await instance.deleteProjectData();

			expect(container.state.destroyed).toBe(1);
			expect(await state.storage.get(PORT_TOKENS_KEY)).toBeUndefined();
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});
});
