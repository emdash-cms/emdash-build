import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import {
	PREVIEW_PORT_HEADER,
	PREVIEW_PROXY_HEADER,
	PREVIEW_SANDBOX_ID_HEADER,
	PREVIEW_TOKEN_HEADER,
} from "./preview-router.js";
import { settleWithin } from "./preview-cache.js";
import { PreviewSnapshots, type PreviewRefreshResult } from "./preview-snapshots.js";
import {
	deletePortToken,
	previewUrl,
	validatePortToken,
	writePortToken,
} from "./preview-tokens.js";
import { CAPACITY_LEASE_TTL_MS } from "./sandbox-capacity.js";
import type { SandboxExecOptions, SandboxOps, SandboxStart } from "./sandbox-ops.js";
import {
	CONTAINER_ANSWER_MS,
	SAFETY_INACTIVITY_MS,
	SandboxRuntime,
	type ContainerLike,
} from "./sandbox-runtime.js";

export type { PreviewRefreshResult, PreviewSnapshotState } from "./preview-snapshots.js";

const PREVIEW_HEADERS = [
	PREVIEW_PROXY_HEADER,
	PREVIEW_PORT_HEADER,
	PREVIEW_TOKEN_HEADER,
	PREVIEW_SANDBOX_ID_HEADER,
];
/** While the container runs, the alarm renews its lease and checks for idleness this often. */
const ALARM_INTERVAL_MS = 60_000;
/** Stop the container after this long without activity from the site's owner. */
const IDLE_STOP_MS = 10 * 60_000;
/** Quick-tunnel traffic never reaches this object, so it cannot count as activity. */
const QUICK_TUNNEL_IDLE_STOP_MS = 30 * 60_000;
/**
 * Stop regardless of BuilderAgent after this long without owner activity, so
 * a hung turn or an unreachable agent cannot hold a container and its slot.
 */
const HARD_IDLE_STOP_MS = 2 * 60 * 60_000;
/** Activity is kept in memory and written at most this often. */
const ACTIVITY_WRITE_MS = 30_000;
const ACTIVITY_KEY = "v1:activityAt";
const PREVIEW_ACTIVITY_KEY = "v1:previewActivityAt";
/**
 * Preview traffic alone keeps a container at most this long after BuilderAgent
 * last used it: anyone holding the preview URL, a shared link or a monitor,
 * could otherwise hold a container and its slot for good.
 */
const PREVIEW_ONLY_MAX_MS = 2 * 60 * 60_000;
const NAME_KEY = "v1:name";
/** Where the 0.12 SDK kept the sandbox's name. */
const LEGACY_NAME_KEY = "sandboxName";
/** Close code for sockets of a container that stopped: the client should reconnect later. */
const SERVICE_RESTART = 1012;
const INSTANCE = { vcpu: 4, memoryMib: 12288, diskMb: 10240 };

function paused(message: string): Response {
	return new Response(message, {
		status: 503,
		headers: { "Cache-Control": "no-store", "X-EmDash-Sandbox": "stopped" },
	});
}

function isNotListening(error: unknown): boolean {
	return /not listening/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * The close code to pass on for one received. Reserved codes say what happened
 * to a connection and cannot be sent: no status becomes a normal close, and an
 * abnormal or failed connection an internal error, so the far side still closes.
 */
export function sendableCloseCode(code: number): number {
	if (code === 1005) return 1000;
	if (code === 1004 || code === 1006 || code === 1015) return 1011;
	return code;
}

/**
 * Relay a WebSocket between the browser and the container. Holding both ends
 * here keeps this object, and with it the container, awake while a preview
 * tab is open, so HMR survives; the idle policy decides when to stop.
 */
export function bridgeWebSocket(upstream: Response, sockets?: Set<WebSocket>): Response {
	const remote = upstream.webSocket!;
	const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
	remote.accept();
	server.accept();
	// A binary frame would arrive as a Blob, which send() does not take.
	remote.binaryType = "arraybuffer";
	server.binaryType = "arraybuffer";
	sockets?.add(server);
	const relay = (from: WebSocket, to: WebSocket) => {
		from.addEventListener("message", (event) => {
			try {
				to.send(event.data);
			} catch {
				try {
					from.close(1011, "The other side closed.");
				} catch {
					// Already closed.
				}
			}
		});
		from.addEventListener("close", (event) => {
			sockets?.delete(server);
			try {
				to.close(sendableCloseCode(event.code), event.reason);
			} catch {
				// Already closed.
			}
		});
		from.addEventListener("error", () => {
			sockets?.delete(server);
			try {
				to.close(1011, "The other side failed.");
			} catch {
				// Already closed.
			}
		});
	};
	relay(server, remote);
	relay(remote, server);
	// Vite asks for the vite-hmr subprotocol; the upstream handshake answers it.
	return new Response(null, { status: 101, webSocket: client, headers: upstream.headers });
}

/**
 * The project's container, on Sandbox SDK 1.0: this Durable Object starts it
 * through `ctx.container`, serves its preview with the last-known-good
 * snapshots, and stops it when the owner has been away. Every container call
 * BuilderAgent makes is an RPC to one of the `SandboxOps` methods here.
 */
export class Sandbox extends DurableObject<Env> implements SandboxOps {
	private readonly previews: PreviewSnapshots;
	private runtimeInstance?: SandboxRuntime;
	private activityAt?: number;
	private activityWrittenAt = 0;
	private previewActivityAt?: number;
	private previewActivityWrittenAt = 0;
	/** The browser ends of relayed HMR sockets, closed when the container stops. */
	private readonly sockets = new Set<WebSocket>();
	/** An idle stop under way; a start waits for it. */
	private stopping?: Promise<void>;
	/** How long an alarm waits for BuilderAgent to agree to an idle stop. */
	private prepareStopTimeoutMs = 60_000;
	/** How long this object waits on a container call before going on without it. */
	private containerAnswerMs = CONTAINER_ANSWER_MS;
	private nameStored = false;
	/** The site was deleted; an alarm already running must not take its slot back. */
	private deleted = false;
	/** The stored name, for an instance woken without one (an old alarm). */
	private storedNameValue?: string;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.previews = new PreviewSnapshots({
			sql: ctx.storage.sql,
			waitUntil: (promise) => ctx.waitUntil(promise),
			forwardLive: (request) => this.forwardLive(request),
			renderCanonical: (cachePath, signal) => this.renderCanonical(cachePath, signal),
			validatePortToken: (port, token) => validatePortToken(ctx.storage, port, token),
		});
		void ctx.blockConcurrencyWhile(async () => {
			this.storedNameValue =
				(await ctx.storage.get<string>(NAME_KEY)) ??
				(await ctx.storage.get<string>(LEGACY_NAME_KEY));
			// A new version of this object finds its container still running with the
			// old version's timeout, which a restart does not keep.
			const container = this.container();
			// Unbounded, a container that does not answer would reset this object on every request.
			if (container?.running) {
				await this.answered(
					"set the container's inactivity timeout",
					container.setInactivityTimeout(SAFETY_INACTIVITY_MS),
				);
				await this.armAlarm();
			}
		});
	}

	/** The Container API; absent where containers are not enabled, as in tests. */
	private container(): ContainerLike | undefined {
		return this.ctx.container;
	}

	/**
	 * The project id this Sandbox belongs to. Requests by name carry it; it is
	 * kept so an alarm, which may not, still knows whose container it is.
	 */
	private get name(): string {
		const name = this.ctx.id.name;
		if (name && !this.nameStored) {
			this.nameStored = true;
			this.storedNameValue = name;
			void this.ctx.storage.put(NAME_KEY, name);
		}
		return name ?? this.storedNameValue ?? this.ctx.id.toString();
	}

	private async storedName(): Promise<string | undefined> {
		return this.ctx.id.name ?? this.storedNameValue;
	}

	private runtime(): SandboxRuntime {
		const container = this.container();
		if (!container) throw new Error("This Sandbox has no container binding.");
		const capacity = () => this.env.SandboxCapacity.getByName("global");
		this.runtimeInstance ??= new SandboxRuntime({
			container,
			files: new Files(container as Container),
			capacity: {
				acquire: (holder, options) => capacity().acquire(holder, options),
				release: (holder) => capacity().release(holder),
				requeue: (holder) => capacity().requeue(holder),
			},
			holder: () => this.name,
			startOptions: () => this.startOptions(),
			answerTimeoutMs: this.containerAnswerMs,
		});
		return this.runtimeInstance;
	}

	private startOptions(): ContainerStartupOptions {
		const labels = { app: "emdash-build", project: this.name.slice(0, 64) };
		const env = this.env as Env & { SANDBOX_SCHEDULING_POLICY?: string };
		// Worker Previews run on the default policy, where wrangler picks the image and size.
		if (env.SANDBOX_SCHEDULING_POLICY === "default") return { enableInternet: true, labels };
		const image = (this.container() as Container).images.sandbox;
		if (!image) throw new Error("The sandbox image is not configured.");
		return { enableInternet: true, labels, image, instance: INSTANCE };
	}

	private idleStopMs(): number {
		const mode = (this.env as Env & { SANDBOX_PREVIEW_MODE?: string }).SANDBOX_PREVIEW_MODE;
		return mode === "quick-tunnel" ? QUICK_TUNNEL_IDLE_STOP_MS : IDLE_STOP_MS;
	}

	/** BuilderAgent used the container: a turn, a save, or the owner's builder tab in use. */
	touch(): void {
		const now = Date.now();
		this.activityAt = now;
		if (now - this.activityWrittenAt >= ACTIVITY_WRITE_MS) {
			this.activityWrittenAt = now;
			void this.ctx.storage.put(ACTIVITY_KEY, now);
		}
	}

	/** Someone loaded a page or an asset of the preview. */
	private touchPreview(): void {
		const now = Date.now();
		this.previewActivityAt = now;
		if (now - this.previewActivityWrittenAt >= ACTIVITY_WRITE_MS) {
			this.previewActivityWrittenAt = now;
			void this.ctx.storage.put(PREVIEW_ACTIVITY_KEY, now);
		}
	}

	private async lastBuilderActivity(): Promise<number> {
		if (this.activityAt !== undefined) return this.activityAt;
		const stored = await this.ctx.storage.get<number>(ACTIVITY_KEY);
		if (stored !== undefined) return (this.activityAt = stored);
		// A container this object never saw used, such as one the 0.12 SDK started,
		// gets a full idle period, so the stop goes through BuilderAgent's save.
		this.activityAt = Date.now();
		await this.ctx.storage.put(ACTIVITY_KEY, this.activityAt);
		return this.activityAt;
	}

	/** The last activity that keeps the container: BuilderAgent's, or preview traffic within its limit. */
	private async lastActivity(): Promise<number> {
		const builder = await this.lastBuilderActivity();
		this.previewActivityAt ??= (await this.ctx.storage.get<number>(PREVIEW_ACTIVITY_KEY)) ?? 0;
		return Math.max(builder, Math.min(this.previewActivityAt, builder + PREVIEW_ONLY_MAX_MS));
	}

	private async armAlarm(): Promise<void> {
		const next = Date.now() + ALARM_INTERVAL_MS;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > next) await this.ctx.storage.setAlarm(next);
	}

	override async alarm(): Promise<void> {
		const name = await this.storedName();
		const container = this.container();
		if (!container?.running) {
			// It stopped some other way: a crash, the safety timeout, or a deploy.
			// A start between taking its slot and starting the container keeps the slot.
			if (!this.runtimeInstance?.startInFlight) {
				this.closeSockets();
				if (name) {
					// Only the slot: a place in the queue belongs to a start waiting for one.
					await this.env.SandboxCapacity.getByName("global")
						.releaseLease(name)
						.catch(() => undefined);
					await this.notifyStopped(name);
				}
			}
			return;
		}
		// Without a name there is no BuilderAgent to ask and no slot to renew; the
		// safety timeout stops the container.
		if (!name) return;
		// The slot first, so a slow save before an idle stop cannot let it lapse.
		await this.keepSlot(name);
		// Deleted meanwhile: the slot taken back must not outlive the site.
		if (this.deleted) {
			await this.releaseSlot(name);
			return;
		}
		const idleFor = Date.now() - (await this.lastActivity());
		if (idleFor >= this.idleStopMs()) {
			const lastActivity = await this.lastActivity();
			const verdict =
				idleFor >= HARD_IDLE_STOP_MS ? { busy: false } : await this.askToStop(name, idleFor);
			// Deleted while BuilderAgent was asked: deleteProjectData did the rest.
			if (this.deleted) return;
			if (!verdict.busy && (await this.lastActivity()) === lastActivity) {
				await this.stopContainer(name);
				return;
			}
		}
		await this.answered(
			"renew the container's inactivity timeout",
			container.setInactivityTimeout(SAFETY_INACTIVITY_MS),
		);
		if (!this.deleted) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
	}

	/** Wait on a container call, but go on, with a warning, if it fails or does not answer. */
	private async answered(what: string, call: Promise<unknown>): Promise<void> {
		const settled = await settleWithin(call, this.containerAnswerMs);
		if (settled.status === "fulfilled") return;
		console.warn(
			`[Sandbox] could not ${what}:`,
			settled.status === "rejected" ? settled.reason : "the container did not answer",
		);
	}

	/**
	 * Renew the running container's slot, or take it again, past the cap if need
	 * be, if it lapsed. A failure only warns: the alarm must still re-arm, or
	 * nothing would renew the slot again or stop the container with a save.
	 */
	private async keepSlot(name: string): Promise<void> {
		const capacity = this.env.SandboxCapacity.getByName("global");
		try {
			if (!(await capacity.renew(name, CAPACITY_LEASE_TTL_MS))) {
				await capacity.reclaim(name, CAPACITY_LEASE_TTL_MS);
			}
		} catch (error) {
			console.warn("[Sandbox] could not renew the container's slot:", error);
		}
	}

	/**
	 * BuilderAgent saves the site first, and keeps it running while work is under
	 * way. An answer that does not come within the deadline counts as busy, so
	 * the next alarm renews the slot and asks again.
	 */
	private async askToStop(name: string, idleFor: number): Promise<{ busy: boolean }> {
		const asked = this.env.BuilderAgent.getByName(name).prepareSandboxStop(idleFor);
		const settled = await settleWithin(asked, this.prepareStopTimeoutMs);
		if (settled.status === "fulfilled") return settled.value;
		console.warn(
			"[Sandbox] could not prepare an idle stop:",
			settled.status === "rejected" ? settled.reason : "no answer in time",
		);
		return { busy: true };
	}

	/** Stop the idle container; a start that arrives meanwhile waits for it. */
	private async stopContainer(name: string): Promise<void> {
		const stopping = (async () => {
			this.closeSockets();
			await this.runtime().stop();
			await this.ctx.storage.deleteAlarm();
			await this.notifyStopped(name);
		})();
		this.stopping = stopping;
		try {
			await stopping;
		} catch (error) {
			// Still running, with its slot: the next alarm tries again, rather than
			// the platform's few alarm retries.
			console.warn("[Sandbox] could not stop the idle container:", error);
			if (!this.deleted) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
		} finally {
			if (this.stopping === stopping) this.stopping = undefined;
		}
	}

	private async notifyStopped(name: string): Promise<void> {
		try {
			await this.env.BuilderAgent.getByName(name).markSandboxStopped();
		} catch {
			// The preview shows the stopped container as an error instead.
		}
	}

	private closeSockets(): void {
		for (const socket of this.sockets) {
			try {
				socket.close(SERVICE_RESTART, "The preview stopped.");
			} catch {
				// Already closed.
			}
		}
		this.sockets.clear();
	}

	private async releaseSlot(name = this.name): Promise<void> {
		await this.env.SandboxCapacity.getByName("global")
			.release(name)
			.catch(() => undefined);
	}

	/** Tear down the container and everything stored for a deleted site. */
	async deleteProjectData(): Promise<void> {
		this.deleted = true;
		const container = this.container();
		this.closeSockets();
		if (container?.running) await this.answered("destroy the container", container.destroy());
		await this.releaseSlot();
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	async ensureRunning(): Promise<SandboxStart> {
		// A stop that failed leaves the container running; the next alarm tries again.
		await this.stopping?.catch(() => undefined);
		const start = await this.runtime().ensureRunning();
		if (start.ok) {
			this.touch();
			await this.armAlarm();
		}
		return start;
	}

	cancelStart(): Promise<void> {
		return this.runtime().cancelStart();
	}

	exec(command: string, options?: SandboxExecOptions) {
		if (!options?.background) this.touch();
		return this.runtime().exec(command, options);
	}

	readFile(path: string, options?: { encoding?: "utf-8" | "base64" }) {
		this.touch();
		return this.runtime().readFile(path, options);
	}

	readFileStream(path: string) {
		this.touch();
		return this.runtime().readFileStream(path);
	}

	writeFile(path: string, content: string) {
		this.touch();
		return this.runtime().writeFile(path, content);
	}

	deleteFile(path: string) {
		this.touch();
		return this.runtime().deleteFile(path);
	}

	listFiles(path: string, options?: { recursive?: boolean }) {
		this.touch();
		return this.runtime().listFiles(path, options);
	}

	fetchPort(port: number, url: string, init?: RequestInit) {
		this.touch();
		return this.runtime().fetchPort(port, url, init);
	}

	startProcess(
		id: string,
		command: string,
		options?: { cwd?: string; env?: Record<string, string> },
	) {
		this.touch();
		return this.runtime().startProcess(id, command, options);
	}

	followProcessLogs(id: string) {
		return this.runtime().followProcessLogs(id);
	}

	waitForProcessExit(id: string, timeoutMs: number) {
		return this.runtime().waitForProcessExit(id, timeoutMs);
	}

	stopProcess(id: string) {
		return this.runtime().stopProcess(id);
	}

	async exposePort(port: number, options: { hostname: string; token: string }) {
		await writePortToken(this.ctx.storage, port, options.token, "preview");
		return { url: previewUrl(port, this.name, options.hostname, options.token) };
	}

	unexposePort(port: number): Promise<void> {
		return deletePortToken(this.ctx.storage, port);
	}

	openTunnel(port: number) {
		this.touch();
		return this.runtime().openTunnel(port);
	}

	closeTunnel(port: number) {
		return this.runtime().closeTunnel(port);
	}

	getPreviewGeneration(): number {
		return this.previews.getPreviewGeneration();
	}

	/** Mark every snapshot stale at a builder mutation; renders follow separately. */
	async invalidatePreviewSnapshots(): Promise<number> {
		return this.previews.invalidatePreviewSnapshots();
	}

	/** Whether a last-known-good response already exists for this route. */
	hasCachedPreview(path = "/"): boolean {
		return this.previews.hasCachedPreview(path);
	}

	/** Whether this route's snapshot reflects the latest content change (a cheap read). */
	previewSnapshotState(path = "/") {
		return this.previews.previewSnapshotState(path);
	}

	/** Render and persist one public route directly from the dev server. */
	refreshPreview(path = "/") {
		return this.previews.refreshPreview(path);
	}

	/** Refresh the routes a user is looking at after a content or source change. */
	refreshPreviews(
		paths: string[],
		options: { invalidate?: boolean } = {},
	): Promise<PreviewRefreshResult[]> {
		return this.previews.refreshPreviews(paths, options);
	}

	/** Preview traffic routed here by `routePreviewRequest`. It never starts the container. */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get(PREVIEW_PROXY_HEADER) !== "1") {
			return new Response("Not found", { status: 404 });
		}
		const port = Number(request.headers.get(PREVIEW_PORT_HEADER));
		const token = request.headers.get(PREVIEW_TOKEN_HEADER) ?? "";
		if (!(await validatePortToken(this.ctx.storage, port, token))) {
			return new Response("Not found", { status: 404 });
		}
		// Page and asset loads mean someone is looking. HMR frames do not, and
		// neither does BuilderAgent's CMS connection, which also runs between turns.
		const { pathname } = new URL(request.url);
		if (
			request.headers.get("Upgrade")?.toLowerCase() !== "websocket" &&
			!pathname.startsWith("/_emdash/api/mcp")
		) {
			// Anyone with the URL can send these, cookies included; the owner's own
			// presence comes through BuilderAgent (keepSandboxAwake).
			this.touchPreview();
		}
		return this.previews.fetch(request);
	}

	private async forwardLive(request: Request): Promise<Response> {
		const container = this.container();
		if (!container?.running) return paused("The preview is paused. Open the project to wake it.");
		const port = Number(request.headers.get(PREVIEW_PORT_HEADER));
		const url = new URL(request.url);
		const headers = new Headers(request.headers);
		for (const name of PREVIEW_HEADERS) headers.delete(name);
		try {
			if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
				// The upgrade keeps the public host, which Vite's HMR server checks.
				url.protocol = "http:";
				const upstream = await container
					.getTcpPort(port)
					.fetch(new Request(url, { method: request.method, headers }));
				return upstream.webSocket ? bridgeWebSocket(upstream, this.sockets) : upstream;
			}
			// Requests reach the dev server as they did through the 0.12 SDK.
			headers.set("X-Original-URL", request.url);
			headers.set("X-Forwarded-Host", url.hostname);
			headers.set("X-Forwarded-Proto", url.protocol.slice(0, -1));
			return await container.getTcpPort(port).fetch(
				new Request(`http://localhost:${port}${url.pathname}${url.search}`, {
					method: request.method,
					headers,
					body: request.body,
					redirect: "manual",
				}),
			);
		} catch (error) {
			if (isNotListening(error)) return paused("The preview is starting. Try again shortly.");
			// It stopped during the request.
			if (!this.container()?.running) {
				return paused("The preview is paused. Open the project to wake it.");
			}
			throw error;
		}
	}

	private renderCanonical(cachePath: string, signal: AbortSignal): Promise<Response> {
		const container = this.container();
		// A stopped container serves the last good snapshot instead of waiting for a render.
		if (!container?.running) return Promise.resolve(paused("The preview is paused."));
		// The signal goes in fetch's own options: workerd ignores a Request's signal there.
		return container.getTcpPort(4321).fetch(new URL(cachePath, "http://localhost:4321"), {
			headers: { Accept: "text/html" },
			redirect: "manual",
			signal,
		});
	}
}
