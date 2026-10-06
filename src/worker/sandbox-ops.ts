/**
 * Everything the builder does inside a site's container goes through this
 * port: commands, files, background processes, ports and preview exposure.
 * The Sandbox Durable Object implements it on Sandbox SDK 1.0. Results keep
 * the 0.12 SDK's shapes, so callers read `success`, `exitCode`, `stdout` and
 * `content` as before.
 */

/** What a container call throws, before doing anything, when no container runs. */
export const NOT_RUNNING = "SANDBOX_NOT_RUNNING: The site's container is not running.";

/** Nothing ran, so the call can be repeated once the container is started. */
export function isSandboxNotRunning(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error)).startsWith("SANDBOX_NOT_RUNNING");
}

export interface SandboxExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Milliseconds before the command is stopped. */
	timeout?: number;
	signal?: AbortSignal;
	/** Upkeep the owner did not ask for, such as a checkpoint: it does not keep the container awake. */
	background?: boolean;
}

export interface SandboxExecResult {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface SandboxFileEntry {
	absolutePath: string;
	type: "file" | "directory" | "symlink" | "other";
	size: number;
}

/**
 * Whether the Sandbox has a running container, or else its place in the queue
 * for one (`position` is unknown when the platform, not the queue, is full).
 */
export type SandboxStart =
	| { ok: true }
	| { ok: false; reason: "capacity"; position?: number; retryAfterMs: number };

export interface SandboxOps {
	/** Start the container unless it runs, within the deployment's cap. */
	ensureRunning(): Promise<SandboxStart>;
	/** Give up the site's place in the queue for a container. Does nothing once one runs. */
	cancelStart(): Promise<void>;
	exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;
	readFile(
		path: string,
		options?: { encoding?: "utf-8" | "base64" },
	): Promise<{ success: boolean; content: string }>;
	/** The file's raw bytes. */
	readFileStream(path: string): Promise<ReadableStream<Uint8Array>>;
	writeFile(path: string, content: string): Promise<{ success: boolean }>;
	deleteFile(path: string): Promise<{ success: boolean }>;
	listFiles(
		path: string,
		options?: { recursive?: boolean },
	): Promise<{ success: boolean; files: SandboxFileEntry[] }>;
	/** A request to a port inside the container. The URL's host is sent as the Host header. */
	fetchPort(port: number, url: string, init?: RequestInit): Promise<Response>;

	/** Start a background process under an id no running process uses. */
	startProcess(
		id: string,
		command: string,
		options?: { cwd?: string; env?: Record<string, string> },
	): Promise<void>;
	/**
	 * The process's output as server-sent events: `data: {"type":"stdout"|"stderr","data":"..."}`
	 * lines, then `data: {"type":"complete","exitCode":N}`.
	 */
	followProcessLogs(id: string): Promise<ReadableStream<Uint8Array>>;
	waitForProcessExit(id: string, timeoutMs: number): Promise<{ exitCode: number }>;
	/** Stop a process. Stopping one that has exited, or was never started, does nothing. */
	stopProcess(id: string): Promise<void>;

	/** Serve `port` on its stable preview URL (the token is part of the URL) and return that URL. */
	exposePort(port: number, options: { hostname: string; token: string }): Promise<{ url: string }>;
	unexposePort(port: number): Promise<void>;
	/** A public quick tunnel to `port`, reused while it runs. */
	openTunnel(port: number): Promise<{ url: string }>;
	closeTunnel(port: number): Promise<void>;
}

/** Background processes whose ids start with this are the site's dev server. */
export const DEV_SERVER_PROCESS_PREFIX = "dev-";
