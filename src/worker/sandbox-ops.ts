/**
 * Everything the builder does inside a site's container goes through this
 * port: commands, files, background processes, ports and preview exposure.
 * `legacySandboxOps` implements it on Sandbox SDK 0.12; results keep that
 * SDK's shapes, so callers read `success`, `exitCode`, `stdout` and `content`
 * as before.
 */

export interface SandboxExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	/** Milliseconds before the command is stopped. */
	timeout?: number;
	signal?: AbortSignal;
	/**
	 * Run beside other commands instead of after them. On 0.12 the default
	 * session runs its commands one at a time.
	 */
	concurrent?: boolean;
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

export interface SandboxOps {
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
