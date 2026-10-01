/**
 * The site's container on Sandbox SDK 1.0, where the Sandbox Durable Object
 * drives `ctx.container` itself: starting it within the deployment's cap,
 * commands, files, background processes, port requests and quick tunnels.
 * Results keep the shapes `SandboxOps` promises.
 */
import type { CapacityGrant } from "./sandbox-capacity.js";
import {
	NOT_RUNNING,
	type SandboxExecOptions,
	type SandboxExecResult,
	type SandboxFileEntry,
	type SandboxOps,
	type SandboxStart,
} from "./sandbox-ops.js";
import {
	FOLLOW_PROCESS,
	PROCESS_ROOT,
	PROCESS_STATUS,
	RUN_PROCESS,
	STOP_PROCESS,
	parseProcessState,
	processDir,
	processLogEvents,
	type ProcessState,
} from "./sandbox-processes.js";
import { settleWithin } from "./preview-cache.js";

export const SANDBOX_HOME = "/home/user";
/** Commands and file operations all run as the image's user, so ownership never mixes. */
export const SANDBOX_USER = "1001:1001";
const CA_BUNDLE = "/etc/ssl/certs/emdash-ca-bundle.pem";
/** Commands inherit only PATH from the image, so its other ENV is restated. */
export const BASE_ENV: Readonly<Record<string, string>> = {
	HOME: SANDBOX_HOME,
	USER: "user",
	LANG: "C.UTF-8",
	SSL_CERT_FILE: CA_BUNDLE,
	GIT_SSL_CAINFO: CA_BUNDLE,
	NODE_EXTRA_CA_CERTS: CA_BUNDLE,
	COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
};
/** A backstop only: the Sandbox's idle policy stops the container long before this. */
export const SAFETY_INACTIVITY_MS = 15 * 60_000;
const READY_TIMEOUT_MS = 30_000;
/** Every command runs under GNU timeout, which passes Stop on to the command's children. */
const UNTIMED_COMMAND_SECONDS = 24 * 60 * 60;
/** Command output crosses Workers RPC, whose messages are capped. */
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const PLATFORM_RETRY_MS = 15_000;
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export type ContainerLike = Pick<
	Container,
	"running" | "start" | "exec" | "getTcpPort" | "setInactivityTimeout" | "destroy"
>;

/** The subset of the package's `Files` the runtime uses. */
export interface FilesLike {
	readFile(path: string, options?: { user?: string }): Promise<Response>;
	writeFile(path: string, content: string, options?: { user?: string }): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean; user?: string }): Promise<void>;
	remove(path: string, options?: { user?: string }): Promise<void>;
}

export interface CapacityLike {
	acquire(holder: string, options?: { reason?: string }): Promise<CapacityGrant>;
	release(holder: string): Promise<void>;
}

export interface SandboxRuntimeDeps {
	container: ContainerLike;
	files: FilesLike;
	capacity: CapacityLike;
	/** The lease holder: the project's sandbox name. */
	holder(): string;
	startOptions(): ContainerStartupOptions;
	/** Where process directories live; tests use their own. */
	processRoot?: string;
	/** How long a new quick tunnel has to report its URL. */
	tunnelWaitMs?: number;
	/** How long a new container has to become ready. */
	readyTimeoutMs?: number;
}

export type ContainerOps = Omit<SandboxOps, "exposePort" | "unexposePort">;

function decodeLimited(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, OUTPUT_LIMIT_BYTES));
	return new TextDecoder().decode(view);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isPlatformCapacityError(error: unknown): boolean {
	const messages: string[] = [];
	for (let cause = error, depth = 0; cause && depth < 5; depth++) {
		messages.push(cause instanceof Error ? cause.message : String(cause));
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return messages.some((message) =>
		/no container instance (?:that can be provided|available)|maximum number of running container instances/i.test(
			message,
		),
	);
}

function isNotListening(error: unknown): boolean {
	return /not listening/i.test(error instanceof Error ? error.message : String(error));
}

function isFileNotFound(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT",
	);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Kill a container process only while it runs: signalling an exited one raises an uncaught error. */
function killer(process: ExecProcess) {
	let exited = false;
	void process.exitCode.then(
		() => (exited = true),
		() => (exited = true),
	);
	return (signal: number) => {
		if (exited) return;
		try {
			process.kill(signal);
		} catch {
			// It exited between the check and the signal.
		}
	};
}

export class SandboxRuntime implements ContainerOps {
	private starting?: Promise<SandboxStart>;

	constructor(private readonly deps: SandboxRuntimeDeps) {}

	private get container(): ContainerLike {
		return this.deps.container;
	}

	private dir(id: string): string {
		return processDir(id, this.deps.processRoot);
	}

	private requireRunning(): ContainerLike {
		if (!this.container.running) throw new Error(NOT_RUNNING);
		return this.container;
	}

	/** A start is under way: its slot is taken, though the container may not run yet. */
	get startInFlight(): boolean {
		return this.starting !== undefined;
	}

	ensureRunning(): Promise<SandboxStart> {
		// `running` is true as soon as start() returns, before the container is ready.
		if (this.starting) return this.starting;
		if (this.container.running) return Promise.resolve({ ok: true });
		this.starting = this.start().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async cancelStart(): Promise<void> {
		if (!this.container.running) await this.deps.capacity.release(this.deps.holder());
	}

	private async start(): Promise<SandboxStart> {
		const holder = this.deps.holder();
		const lease = await this.deps.capacity.acquire(holder, { reason: "start" });
		if (!lease.granted) {
			return {
				ok: false,
				reason: "capacity",
				position: lease.position,
				retryAfterMs: lease.retryAfterMs,
			};
		}
		const container = this.container;
		try {
			container.start(this.deps.startOptions());
			// exec waits for a starting container. Process directories restored from a
			// snapshot belong to processes that are gone.
			const root = this.deps.processRoot ?? PROCESS_ROOT;
			// The deadline covers the wait for the container to start, which exec does first.
			const ready = (async () => {
				const probe = await container.exec(["bash", "-c", `rm -rf ${shellQuote(root)}`], {
					user: SANDBOX_USER,
					env: { ...BASE_ENV },
				});
				return probe.exitCode;
			})();
			const settled = await settleWithin(ready, this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
			if (settled.status !== "fulfilled") {
				throw settled.status === "rejected"
					? settled.reason
					: new Error("The container did not become ready in time.");
			}
			await container.setInactivityTimeout(SAFETY_INACTIVITY_MS);
			return { ok: true };
		} catch (error) {
			await container.destroy().catch(() => undefined);
			await this.deps.capacity.release(holder).catch(() => undefined);
			if (isPlatformCapacityError(error)) {
				return { ok: false, reason: "capacity", retryAfterMs: PLATFORM_RETRY_MS };
			}
			throw error;
		}
	}

	/** Stop the container and give its slot back. */
	async stop(): Promise<void> {
		if (this.container.running) await this.container.destroy().catch(() => undefined);
		await this.deps.capacity.release(this.deps.holder()).catch(() => undefined);
	}

	exec(command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
		return this.run(["bash", "-c", command], options);
	}

	/** Run one of the process scripts on a process directory. */
	private script(body: string, id: string, ...args: string[]): Promise<SandboxExecResult> {
		return this.run(["bash", "-c", body, "script", this.dir(id), ...args], { timeout: 15_000 });
	}

	private async run(command: string[], options: SandboxExecOptions): Promise<SandboxExecResult> {
		const container = this.requireRunning();
		const { signal } = options;
		signal?.throwIfAborted();
		const seconds =
			options.timeout !== undefined ? Math.max(1, Math.ceil(options.timeout / 1000)) : undefined;
		// GNU timeout stops the command and its children, and exits 124.
		const argv = [
			"timeout",
			"--signal=TERM",
			"--kill-after=2s",
			`${seconds ?? UNTIMED_COMMAND_SECONDS}s`,
			...command,
		];
		const process = await container.exec(argv, {
			cwd: options.cwd ?? SANDBOX_HOME,
			env: { ...BASE_ENV, ...options.env },
			user: SANDBOX_USER,
		});
		const kill = killer(process);
		const onAbort = () => kill(15);
		signal?.addEventListener("abort", onAbort, { once: true });
		// Stop may have come while the command was starting.
		if (signal?.aborted) onAbort();
		const backstop =
			seconds !== undefined ? setTimeout(() => kill(9), (seconds + 5) * 1000) : undefined;
		try {
			const output = await process.output();
			signal?.throwIfAborted();
			return {
				success: output.exitCode === 0,
				exitCode: output.exitCode,
				stdout: decodeLimited(output.stdout),
				stderr: decodeLimited(output.stderr),
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (backstop) clearTimeout(backstop);
		}
	}

	private async readBytes(path: string): Promise<Uint8Array> {
		this.requireRunning();
		try {
			const response = await this.deps.files.readFile(path, { user: SANDBOX_USER });
			return new Uint8Array(await response.arrayBuffer());
		} catch (error) {
			// The message the 0.12 SDK used, which callers recognise.
			if (isFileNotFound(error)) throw new Error(`FileNotFoundError: File not found: ${path}`);
			throw error;
		}
	}

	async readFile(
		path: string,
		options: { encoding?: "utf-8" | "base64" } = {},
	): Promise<{ success: boolean; content: string }> {
		const bytes = await this.readBytes(path);
		if (options.encoding === "base64") {
			let binary = "";
			for (let index = 0; index < bytes.length; index += 0x8000) {
				binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
			}
			return { success: true, content: btoa(binary) };
		}
		return { success: true, content: new TextDecoder().decode(bytes) };
	}

	async readFileStream(path: string): Promise<ReadableStream<Uint8Array>> {
		this.requireRunning();
		try {
			const response = await this.deps.files.readFile(path, { user: SANDBOX_USER });
			return response.body ?? new ReadableStream({ start: (controller) => controller.close() });
		} catch (error) {
			if (isFileNotFound(error)) throw new Error(`FileNotFoundError: File not found: ${path}`);
			throw error;
		}
	}

	async writeFile(path: string, content: string): Promise<{ success: boolean }> {
		this.requireRunning();
		// 0.12 created missing parent directories; Files does not.
		const parent = path.slice(0, path.lastIndexOf("/"));
		if (parent) await this.deps.files.mkdir(parent, { recursive: true, user: SANDBOX_USER });
		await this.deps.files.writeFile(path, content, { user: SANDBOX_USER });
		return { success: true };
	}

	async deleteFile(path: string): Promise<{ success: boolean }> {
		this.requireRunning();
		try {
			await this.deps.files.remove(path, { user: SANDBOX_USER });
		} catch (error) {
			if (isFileNotFound(error)) throw new Error(`FileNotFoundError: File not found: ${path}`);
			throw error;
		}
		return { success: true };
	}

	async listFiles(
		path: string,
		options: { recursive?: boolean } = {},
	): Promise<{ success: boolean; files: SandboxFileEntry[] }> {
		const depth = options.recursive ? "" : "-maxdepth 1 ";
		// NUL-terminated, since a file name may contain a newline.
		const listed = await this.exec(
			`find ${shellQuote(path)} -mindepth 1 ${depth}-printf '%y\\t%s\\t%p\\0'`,
			{ timeout: 30_000 },
		);
		if (!listed.success) return { success: false, files: [] };
		const types: Record<string, SandboxFileEntry["type"]> = {
			f: "file",
			d: "directory",
			l: "symlink",
		};
		const files = listed.stdout
			.split("\0")
			.filter(Boolean)
			.map((line) => {
				const [type = "", size = "0", ...rest] = line.split("\t");
				return { type: types[type] ?? "other", size: Number(size), absolutePath: rest.join("\t") };
			});
		return { success: true, files };
	}

	async fetchPort(port: number, url: string, init: RequestInit = {}): Promise<Response> {
		const container = this.requireRunning();
		// The container's ports speak plain HTTP; the URL's host is kept as the Host header.
		try {
			return await container
				.getTcpPort(port)
				.fetch(new Request(url.replace(/^https:/, "http:"), init));
		} catch (error) {
			if (!isNotListening(error)) throw error;
			return new Response(`Nothing is listening on port ${port}.`, {
				status: 503,
				headers: { "Cache-Control": "no-store" },
			});
		}
	}

	private async processState(id: string): Promise<ProcessState> {
		return parseProcessState((await this.script(PROCESS_STATUS, id)).stdout);
	}

	/** Starts of one id, so two cannot both claim it. */
	private readonly processStarts = new Map<string, Promise<void>>();

	async startProcess(
		id: string,
		command: string,
		options: { cwd?: string; env?: Record<string, string> } = {},
	): Promise<void> {
		const previous = this.processStarts.get(id) ?? Promise.resolve();
		const start = previous.catch(() => undefined).then(() => this.startOnce(id, command, options));
		this.processStarts.set(id, start);
		try {
			await start;
		} finally {
			if (this.processStarts.get(id) === start) this.processStarts.delete(id);
		}
	}

	private async startOnce(
		id: string,
		command: string,
		options: { cwd?: string; env?: Record<string, string> },
	): Promise<void> {
		const container = this.requireRunning();
		const dir = this.dir(id);
		const previous = await this.processState(id);
		if (previous.state === "running" || previous.state === "starting") {
			throw new Error(`Process ${id} is already running.`);
		}
		// An exited process's directory goes first, so its state cannot pass for the new one's.
		if (previous.state === "exited")
			await this.exec(`rm -rf ${shellQuote(dir)}`, { timeout: 15_000 });
		// The runner keeps going until the process exits; nothing waits for it here.
		const runner = await container.exec(
			["bash", "-c", RUN_PROCESS, "run", dir, "bash", "-c", command],
			{
				cwd: options.cwd ?? SANDBOX_HOME,
				env: { ...BASE_ENV, ...options.env },
				user: SANDBOX_USER,
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		let refused = false;
		void runner.exitCode.then(
			(code) => (refused = code === 97),
			() => undefined,
		);
		const deadline = Date.now() + 10_000;
		for (;;) {
			if (refused) throw new Error(`Process ${id} is already running.`);
			// Until it has a pid, stopping it could not reach it.
			const state = (await this.processState(id)).state;
			if (state === "running" || state === "exited") return;
			if (Date.now() > deadline) throw new Error(`Process ${id} did not start.`);
			await sleep(100);
		}
	}

	async followProcessLogs(id: string): Promise<ReadableStream<Uint8Array>> {
		const container = this.requireRunning();
		if ((await this.processState(id)).state === "missing") {
			throw new Error(`Process ${id} is not running.`);
		}
		const follower = await container.exec(["bash", "-c", FOLLOW_PROCESS, "follow", this.dir(id)], {
			env: { ...BASE_ENV },
			user: SANDBOX_USER,
			stderr: "ignore",
		});
		if (!follower.stdout) throw new Error(`Process ${id} output is unavailable.`);
		const kill = killer(follower);
		return processLogEvents(
			follower.stdout as ReadableStream<Uint8Array>,
			async () => {
				const state = await this.processState(id).catch(() => undefined);
				return state?.state === "exited" ? state.exitCode : -1;
			},
			() => kill(15),
		);
	}

	async waitForProcessExit(id: string, timeoutMs: number): Promise<{ exitCode: number }> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const state = await this.processState(id);
			if (state.state === "exited") return { exitCode: state.exitCode };
			if (state.state === "missing") throw new Error(`Process ${id} is not running.`);
			if (Date.now() > deadline)
				throw new Error(`Process ${id} did not exit within ${timeoutMs}ms.`);
			await sleep(500);
		}
	}

	async stopProcess(id: string): Promise<void> {
		if (!this.container.running) return;
		await this.script(STOP_PROCESS, id, "5").catch(() => undefined);
	}

	private async tunnelUrl(id: string): Promise<string | undefined> {
		const found = await this.exec(
			`grep -o -E ${shellQuote(TUNNEL_URL.source)} ${shellQuote(`${this.dir(id)}/output.log`)}`,
			{ timeout: 5_000 },
		).catch(() => undefined);
		// cloudflared names its own API host when a tunnel request fails.
		const url = found?.stdout
			.split("\n")
			.find((line) => TUNNEL_URL.test(line) && !line.startsWith("https://api."));
		return url ? `${url}/` : undefined;
	}

	private async waitForTunnelUrl(id: string): Promise<string | undefined> {
		const deadline = Date.now() + (this.deps.tunnelWaitMs ?? 30_000);
		for (;;) {
			const url = await this.tunnelUrl(id);
			if (url) return url;
			const state = await this.processState(id);
			if (state.state === "exited" || state.state === "missing" || Date.now() > deadline) {
				return undefined;
			}
			await sleep(500);
		}
	}

	async openTunnel(port: number): Promise<{ url: string }> {
		const id = `tunnel-${port}`;
		const state = await this.processState(id);
		if (state.state === "running" || state.state === "starting") {
			const url = await this.waitForTunnelUrl(id);
			if (url) return { url };
			await this.stopProcess(id);
		}
		await this.startProcess(
			id,
			`cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:${port}`,
		);
		const url = await this.waitForTunnelUrl(id);
		if (url) return { url };
		await this.stopProcess(id);
		throw new Error("cloudflared did not report a public URL.");
	}

	async closeTunnel(port: number): Promise<void> {
		await this.stopProcess(`tunnel-${port}`);
	}
}
