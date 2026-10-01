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
/**
 * How long a container call that answers at once may take. A container that
 * died without the platform noticing can leave every call waiting for good.
 */
export const CONTAINER_ANSWER_MS = 15_000;
/**
 * How long a file read may take to answer before a second one races it. Reads
 * answer in milliseconds, but under local workerd a few never answer at all,
 * while one tried again at once does.
 */
export const READ_ANSWER_MS = 5_000;
/** What a call fails with when the container does not answer it in time. */
export const CONTAINER_NOT_ANSWERING = "The container did not answer.";
const READY_TIMEOUT_MS = 30_000;
/** Every command runs under GNU timeout, which passes Stop on to the command's children. */
const UNTIMED_COMMAND_SECONDS = 24 * 60 * 60;
/** Command output crosses Workers RPC, whose messages are capped. */
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
/**
 * Runs the command, then prints the end mark on both streams: the reader
 * stops there, so output that trails the exit is not lost and a process the
 * command left running cannot hold the call. A TERM waits for the command,
 * so what it printed is still marked.
 */
const EXIT_MARK_WRAPPER = [
	"mark=$1; shift",
	"trap true TERM",
	// In the background, which bash does not report as "Terminated" when a TERM kills it.
	'"$@" & child=$!',
	'wait "$child"; rc=$?',
	// A TERM interrupts the wait; wait again for the command to exit.
	'while kill -0 "$child" 2>/dev/null; do wait "$child"; rc=$?; done',
	'printf %s "$mark"; printf %s "$mark" >&2',
	'exit "$rc"',
].join("\n");
/** How long after the exit the marks may take, or the streams to end without them. */
const OUTPUT_DRAIN_MAX_MS = 5_000;
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
	/** Give a slot back after the platform refused its start, keeping the place in line. */
	requeue(holder: string): Promise<void>;
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
	/** How long a call that answers at once may take; tests shorten it. */
	answerTimeoutMs?: number;
}

export type ContainerOps = Omit<SandboxOps, "exposePort" | "unexposePort">;

/**
 * Reads one of a command's output streams up to the end mark the exec wrapper
 * prints once the command exits, keeping the first `OUTPUT_LIMIT_BYTES`.
 * Whatever a process the command left running prints afterwards is drained
 * and dropped, so it neither blocks on a full pipe nor dies of a closed one.
 */
class OutputReader {
	private readonly chunks: Uint8Array[] = [];
	private kept = 0;
	/** Bytes that might begin the mark, held until the next chunk decides. */
	private pending = new Uint8Array(0);
	private resolveEnded!: () => void;
	/** Resolves at the mark, or when the stream ends without one. */
	readonly ended = new Promise<void>((resolve) => (this.resolveEnded = resolve));
	private marked = false;

	constructor(
		stream: ReadableStream<Uint8Array> | null,
		private readonly mark: Uint8Array,
	) {
		if (stream) void this.read(stream.getReader());
		else this.resolveEnded();
	}

	private async read(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (this.marked) continue;
				const bytes = concat(this.pending, value);
				const at = indexOf(bytes, this.mark);
				if (at >= 0) {
					this.keep(bytes.subarray(0, at));
					this.pending = new Uint8Array(0);
					this.marked = true;
					this.resolveEnded();
					continue;
				}
				const safe = Math.max(0, bytes.length - (this.mark.length - 1));
				this.keep(bytes.subarray(0, safe));
				this.pending = bytes.slice(safe);
			}
		} catch {
			// The container went away.
		}
		if (!this.marked) this.keep(this.pending);
		this.pending = new Uint8Array(0);
		this.resolveEnded();
	}

	private keep(bytes: Uint8Array): void {
		const room = OUTPUT_LIMIT_BYTES - this.kept;
		if (room <= 0 || bytes.length === 0) return;
		const kept = bytes.length > room ? bytes.slice(0, room) : bytes.slice();
		this.chunks.push(kept);
		this.kept += kept.length;
	}

	text(): string {
		// Without the mark, bytes held back for it are output too: the wait may have given up.
		const tail = this.marked
			? new Uint8Array(0)
			: this.pending.subarray(0, Math.max(0, OUTPUT_LIMIT_BYTES - this.kept));
		return new TextDecoder().decode(concat(...this.chunks, tail));
	}
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
		for (let index = 0; index < needle.length; index++) {
			if (haystack[start + index] !== needle[index]) continue outer;
		}
		return start;
	}
	return -1;
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
	private stopping = false;
	/** The container has answered since it last started; until then it may still be starting. */
	private answering = false;
	/** How long a container that has not answered yet may still be starting: a start's deadline. */
	private startingUntil?: number;

	constructor(private readonly deps: SandboxRuntimeDeps) {}

	private get container(): ContainerLike {
		return this.deps.container;
	}

	private dir(id: string): string {
		return processDir(id, this.deps.processRoot);
	}

	/** A container call that answers at once, failing instead of waiting for good when it does not. */
	private async answered<T>(
		call: Promise<T>,
		answerMs = this.deps.answerTimeoutMs ?? CONTAINER_ANSWER_MS,
	): Promise<T> {
		// A container still starting answers once it is up, which a start may take longer for;
		// one this object found running gets as long, from its first call.
		this.startingUntil ??= Date.now() + (this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
		const ms = this.answering ? answerMs : Math.max(answerMs, this.startingUntil - Date.now());
		const settled = await settleWithin(call, ms);
		if (settled.status === "fulfilled") {
			this.answering = true;
			return settled.value;
		}
		if (settled.status === "rejected") throw settled.reason;
		throw new Error(CONTAINER_NOT_ANSWERING);
	}

	/** Start a process in the container; one that starts after its caller gave up is stopped. */
	private async spawn(argv: string[], options: ContainerExecOptions): Promise<ExecProcess> {
		const spawned = this.container.exec(argv, options);
		try {
			return await this.answered(spawned);
		} catch (error) {
			void spawned.then(
				(late) => killer(late)(15),
				() => undefined,
			);
			throw error;
		}
	}

	private requireRunning(): ContainerLike {
		// A container being stopped is as good as stopped: callers restore the site.
		if (!this.container.running || this.stopping) throw new Error(NOT_RUNNING);
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
		// A start under way holds a slot it is about to use; only a refused one leaves a place to give up.
		const starting = this.starting;
		if (
			starting &&
			(await starting.then(
				(start) => start.ok,
				() => false,
			))
		)
			return;
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
		this.answering = false;
		this.startingUntil = Date.now() + (this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
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
			this.answering = true;
			await this.answered(container.setInactivityTimeout(SAFETY_INACTIVITY_MS));
			return { ok: true };
		} catch (error) {
			await this.answered(container.destroy()).catch(() => undefined);
			if (isPlatformCapacityError(error)) {
				await this.deps.capacity.requeue(holder).catch(() => undefined);
				return { ok: false, reason: "capacity", retryAfterMs: PLATFORM_RETRY_MS };
			}
			// One that still runs keeps its slot, as one that failed to stop does.
			if (!container.running) await this.deps.capacity.release(holder).catch(() => undefined);
			throw error;
		}
	}

	/** Stop the container and give its slot back. */
	async stop(): Promise<void> {
		this.stopping = true;
		try {
			if (this.container.running) {
				try {
					await this.answered(this.container.destroy());
				} catch (error) {
					// Still running, it keeps its slot, and the caller tries again.
					if (this.container.running) throw error;
				}
			}
		} finally {
			this.stopping = false;
		}
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
		this.requireRunning();
		const { signal } = options;
		signal?.throwIfAborted();
		const seconds =
			options.timeout !== undefined ? Math.max(1, Math.ceil(options.timeout / 1000)) : undefined;
		const mark = `__emdash_exit_${crypto.randomUUID()}__`;
		// GNU timeout stops the command and its children, and exits 124.
		const argv = [
			"timeout",
			"--signal=TERM",
			// Time for a command's own cleanup on TERM, such as the exec tool's restore.
			"--kill-after=6s",
			`${seconds ?? UNTIMED_COMMAND_SECONDS}s`,
			"bash",
			"-c",
			EXIT_MARK_WRAPPER,
			"exec",
			mark,
			...command,
		];
		const process = await this.spawn(argv, {
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
			seconds !== undefined ? setTimeout(() => kill(9), (seconds + 9) * 1000) : undefined;
		const markBytes = new TextEncoder().encode(mark);
		const stdout = new OutputReader(process.stdout, markBytes);
		const stderr = new OutputReader(process.stderr, markBytes);
		try {
			const exitCode = await process.exitCode;
			// A command killed before its marks ends its streams instead, unless
			// something it left running holds them.
			await settleWithin(Promise.all([stdout.ended, stderr.ended]), OUTPUT_DRAIN_MAX_MS);
			signal?.throwIfAborted();
			return {
				success: exitCode === 0,
				exitCode,
				stdout: stdout.text(),
				stderr: stderr.text(),
			};
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (backstop) clearTimeout(backstop);
		}
	}

	/**
	 * Open a file. A read that has not answered in READ_ANSWER_MS races a second
	 * one for the rest of the usual bound, since a read is safe to repeat.
	 */
	private async openFile(path: string): Promise<Response> {
		const answerMs = this.deps.answerTimeoutMs ?? CONTAINER_ANSWER_MS;
		const readMs = Math.min(READ_ANSWER_MS, answerMs);
		const read = () => this.deps.files.readFile(path, { user: SANDBOX_USER });
		const first = read();
		try {
			return await this.answered(first, readMs);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== CONTAINER_NOT_ANSWERING) throw error;
		}
		const second = read();
		let response: Response | undefined;
		try {
			// The first read counts only if it answers: an error it gives up with late is not the file's.
			const answer = new Promise<Response>((resolve, reject) => {
				first.then(resolve, () => undefined);
				second.then(resolve, reject);
			});
			response = await this.answered(answer, Math.max(answerMs - readMs, readMs));
			return response;
		} finally {
			// The read that lost, or both when neither answered, may yet answer; nothing reads it.
			for (const attempt of [first, second]) {
				void attempt.then(
					(late) => late !== response && void late.body?.cancel().catch(() => undefined),
					() => undefined,
				);
			}
		}
	}

	private async readBytes(path: string): Promise<Uint8Array> {
		this.requireRunning();
		try {
			const response = await this.openFile(path);
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
			const response = await this.openFile(path);
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
		if (parent) {
			await this.answered(this.deps.files.mkdir(parent, { recursive: true, user: SANDBOX_USER }));
		}
		await this.answered(this.deps.files.writeFile(path, content, { user: SANDBOX_USER }));
		return { success: true };
	}

	async deleteFile(path: string): Promise<{ success: boolean }> {
		this.requireRunning();
		try {
			await this.answered(this.deps.files.remove(path, { user: SANDBOX_USER }));
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
		this.requireRunning();
		const dir = this.dir(id);
		const previous = await this.processState(id);
		if (previous.state === "running" || previous.state === "starting") {
			throw new Error(`Process ${id} is already running.`);
		}
		// An exited process's directory goes first, so its state cannot pass for the new one's.
		if (previous.state === "exited")
			await this.exec(`rm -rf ${shellQuote(dir)}`, { timeout: 15_000 });
		// The runner keeps going until the process exits; nothing waits for it here.
		const runner = await this.spawn(
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
		this.requireRunning();
		if ((await this.processState(id)).state === "missing") {
			throw new Error(`Process ${id} is not running.`);
		}
		const follower = await this.spawn(["bash", "-c", FOLLOW_PROCESS, "follow", this.dir(id)], {
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
