import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import type { ContainerLike } from "../../src/worker/sandbox-runtime.js";

type ExecResult = { stdout?: string; stderr?: string; exitCode: number };

/**
 * A stand-in for `ctx.container` that runs commands as local processes, with
 * the platform's habits that matter: commands see only PATH plus the env they
 * pass, `kill()` on an exited process throws, and nothing runs while stopped.
 */
export class LocalContainer implements ContainerLike {
	running = false;
	readonly starts: ContainerStartupOptions[] = [];
	readonly execs: string[][] = [];
	destroyed = 0;
	inactivityTimeoutMs?: number;
	/** Fail the next start with this error. */
	startError?: Error;
	/** Delay before each command starts, as a slow or starting container adds. */
	execDelayMs = 0;
	/** Commands whose exec never returns, by a test of their argv. */
	hang?: (argv: string[]) => boolean;
	/** Commands answered without running, by a test of their argv. */
	readonly answers: Array<{ match: (argv: string[]) => boolean; result: ExecResult }> = [];
	readonly ports = new Map<number, (request: Request) => Promise<Response>>();
	private readonly children = new Set<ChildProcess>();

	constructor(private readonly path: string) {}

	start(options?: ContainerStartupOptions): void {
		if (this.running) throw new Error("The container is already running.");
		if (this.startError) {
			const error = this.startError;
			this.startError = undefined;
			throw error;
		}
		this.starts.push(options!);
		this.running = true;
	}

	async destroy(): Promise<void> {
		this.running = false;
		this.destroyed += 1;
		for (const child of this.children) child.kill("SIGKILL");
	}

	async setInactivityTimeout(durationMs: number | bigint): Promise<void> {
		this.inactivityTimeoutMs = Number(durationMs);
	}

	getTcpPort(port: number): Fetcher {
		return {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const handler = this.ports.get(port);
				if (!handler) {
					throw new Error(`The container is not listening in the TCP address 10.0.0.1:${port}`);
				}
				return handler(new Request(input, init));
			},
		} as unknown as Fetcher;
	}

	async exec(argv: string[], options: ContainerExecOptions = {}): Promise<ExecProcess> {
		this.execs.push(argv);
		if (!this.running) throw new Error("The container is not running.");
		if (this.hang?.(argv)) return new Promise<never>(() => {});
		if (this.execDelayMs) await new Promise((resolve) => setTimeout(resolve, this.execDelayMs));
		const answer = this.answers.find((candidate) => candidate.match(argv));
		if (answer) return answeredProcess(answer.result);
		const child = spawn(argv[0]!, argv.slice(1), {
			cwd: options.cwd && existsSync(options.cwd) ? options.cwd : undefined,
			env: { PATH: this.path, ...options.env } as unknown as NodeJS.ProcessEnv,
			stdio: [
				"ignore",
				options.stdout === "ignore" ? "ignore" : "pipe",
				options.stderr === "ignore" ? "ignore" : "pipe",
			],
		});
		this.children.add(child);
		const exitCode = new Promise<number>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (code, signal) => {
				this.children.delete(child);
				resolve(code ?? 128 + (signal ? signalNumber(signal) : 0));
			});
		});
		let exited = false;
		void exitCode.then(
			() => (exited = true),
			() => (exited = true),
		);
		const stdout = child.stdout ? (Readable.toWeb(child.stdout) as ReadableStream) : null;
		const stderr = child.stderr ? (Readable.toWeb(child.stderr) as ReadableStream) : null;
		return {
			stdin: null,
			stdout,
			stderr,
			pid: child.pid ?? 0,
			isPty: false,
			exitCode,
			async output() {
				const [out, err, code] = await Promise.all([
					stdout ? new Response(stdout).arrayBuffer() : new ArrayBuffer(0),
					stderr ? new Response(stderr).arrayBuffer() : new ArrayBuffer(0),
					exitCode,
				]);
				return { stdout: out, stderr: err, exitCode: code };
			},
			kill(signal = 15) {
				// The platform raises an internal error for a process that has exited.
				if (exited) throw new Error("internal error");
				child.kill(signal);
			},
			resize() {},
		};
	}
}

function signalNumber(signal: NodeJS.Signals): number {
	return { SIGTERM: 15, SIGKILL: 9, SIGINT: 2 }[signal as string] ?? 1;
}

function answeredProcess(result: ExecResult): ExecProcess {
	const encoder = new TextEncoder();
	const bytes = (text = "") => encoder.encode(text).buffer as ArrayBuffer;
	const stream = (text = "") =>
		new ReadableStream({
			start(controller) {
				if (text) controller.enqueue(encoder.encode(text));
				controller.close();
			},
		});
	return {
		stdin: null,
		stdout: stream(result.stdout),
		stderr: stream(result.stderr),
		pid: 0,
		isPty: false,
		exitCode: Promise.resolve(result.exitCode),
		async output() {
			return {
				stdout: bytes(result.stdout),
				stderr: bytes(result.stderr),
				exitCode: result.exitCode,
			};
		},
		kill() {
			throw new Error("internal error");
		},
		resize() {},
	};
}
