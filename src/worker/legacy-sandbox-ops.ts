/**
 * `SandboxOps` on Sandbox SDK 0.12, which runs commands in sessions, tracks
 * processes by handle and activates exposed ports per container runtime.
 */
import type { getSandbox, Process } from "@cloudflare/sandbox";
import {
	DEV_SERVER_PROCESS_PREFIX,
	type SandboxExecOptions,
	type SandboxOps,
} from "./sandbox-ops.js";

type LegacySandbox = ReturnType<typeof getSandbox>;
type LegacySession = Awaited<ReturnType<LegacySandbox["createSession"]>>;

/** Commands that must not queue behind the default session's, such as uploads. */
const SIDE_SESSION_ID = "builder-side";
const QUICK_TUNNEL_SESSION_ID = "builder-tunnel";
/** In quick-tunnel mode the dev server runs in its own session. */
const DEV_SERVER_SESSION_ID = "builder-dev";
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface LegacySandboxOptions {
	/** The SDK's decoder for its file streams. */
	streamFile: typeof import("@cloudflare/sandbox").streamFile;
	quickTunnel?: boolean;
	log?: (line: string) => void;
}

export function legacySandboxOps(
	sandbox: LegacySandbox,
	options: LegacySandboxOptions,
): SandboxOps {
	const processes = new Map<string, Process>();
	let tunnel: Process | undefined;

	async function session(id: string): Promise<LegacySession> {
		try {
			return await sandbox.createSession({ id });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof Error && error.name === "SessionAlreadyExistsError") {
				return sandbox.getSession(id);
			}
			if (!/already exists/i.test(message)) throw error;
			return sandbox.getSession(id);
		}
	}

	async function tunnelUrl(process: Process): Promise<string | undefined> {
		const status = await process.getStatus().catch(() => process.status);
		if (status !== "starting" && status !== "running") return;
		const logs = await process.getLogs().catch(() => undefined);
		const match = `${logs?.stdout ?? ""}\n${logs?.stderr ?? ""}`.match(QUICK_TUNNEL_URL);
		return match ? `${match[0].replace(/\/$/, "")}/` : undefined;
	}

	const ops: SandboxOps = {
		async exec(command, { concurrent, ...execOptions }: SandboxExecOptions = {}) {
			// Looked up each time: a restarted container does not keep its sessions.
			const runner = concurrent ? await session(SIDE_SESSION_ID) : sandbox;
			return runner.exec(command, execOptions);
		},

		readFile(path, readOptions) {
			return sandbox.readFile(path, readOptions);
		},

		async readFileStream(path) {
			const events = await sandbox.readFileStream(path);
			// The decoder holds a read on the stream; aborting this pipe is what ends a
			// stalled one, since a generator's return() waits behind its pending read.
			const stop = new AbortController();
			const chunks = options.streamFile(
				events.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal: stop.signal }),
			);
			const encoder = new TextEncoder();
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const next = await chunks.next();
						if (next.done) controller.close();
						else {
							controller.enqueue(
								typeof next.value === "string" ? encoder.encode(next.value) : next.value,
							);
						}
					} catch (error) {
						controller.error(error);
					}
				},
				async cancel(reason) {
					stop.abort(reason);
					await chunks.return(undefined as never).catch(() => {});
				},
			});
		},

		writeFile(path, content) {
			return sandbox.writeFile(path, content);
		},

		deleteFile(path) {
			return sandbox.deleteFile(path);
		},

		listFiles(path, listOptions) {
			return sandbox.listFiles(path, listOptions);
		},

		fetchPort(port, url, init = {}) {
			return sandbox.containerFetch(url, init, port);
		},

		async startProcess(id, command, processOptions = {}) {
			const host =
				options.quickTunnel && id.startsWith(DEV_SERVER_PROCESS_PREFIX)
					? await session(DEV_SERVER_SESSION_ID)
					: sandbox;
			processes.set(id, await host.startProcess(command, { ...processOptions, processId: id }));
		},

		followProcessLogs(id) {
			return sandbox.streamProcessLogs(id);
		},

		async waitForProcessExit(id, timeoutMs) {
			const process = processes.get(id) ?? (await sandbox.getProcess(id));
			if (!process) throw new Error(`Process ${id} is not running.`);
			try {
				const { exitCode } = await process.waitForExit(timeoutMs);
				return { exitCode };
			} finally {
				processes.delete(id);
			}
		},

		async stopProcess(id) {
			const process = processes.get(id);
			processes.delete(id);
			await (process ? process.kill("SIGTERM") : sandbox.killProcess(id)).catch(() => {});
		},

		async exposePort(port, { hostname, token }) {
			// Authorization survives a container restart, but 0.12 requires exposePort()
			// again to activate forwarding for the new runtime. getExposedPorts()
			// returns only currently active ports.
			const existing = await sandbox
				.getExposedPorts(hostname)
				.then((ports) => ports.find((entry) => entry.port === port))
				.catch(() => undefined);
			if (existing) return { url: existing.url };
			try {
				return await sandbox.exposePort(port, { hostname, name: "preview", token });
			} catch (error) {
				// Container startup restores persisted ports asynchronously. Close the
				// race where it becomes exposed between the list and expose calls.
				if (!/already exposed/i.test(error instanceof Error ? error.message : String(error))) {
					throw error;
				}
				const restored = (await sandbox.getExposedPorts(hostname)).find(
					(entry) => entry.port === port,
				);
				if (restored) return { url: restored.url };
				// A stale container-side exposure can outlive the SDK token record.
				// Clear that orphan and recreate it with the stable token.
				await sandbox.unexposePort(port);
				return await sandbox.exposePort(port, { hostname, name: "preview", token });
			}
		},

		async unexposePort(port) {
			await sandbox.unexposePort(port);
		},

		async openTunnel(port) {
			if (tunnel) {
				const url = await tunnelUrl(tunnel);
				if (url) return { url };
				tunnel = undefined;
			}
			const tunnels = await session(QUICK_TUNNEL_SESSION_ID);
			for (const process of await tunnels.listProcesses().catch(() => [])) {
				if (!process.command.includes("cloudflared tunnel")) continue;
				const url = await tunnelUrl(process);
				if (url) {
					tunnel = process;
					return { url };
				}
				await process.kill("SIGTERM").catch(() => undefined);
			}

			options.log?.("$ cloudflared tunnel (Worker Preview)");
			const process = await tunnels.startProcess(
				`cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:${port}`,
				{ cwd: "/home/user/site" },
			);
			tunnel = process;
			try {
				const ready = await process.waitForLog(QUICK_TUNNEL_URL, 30_000);
				const url = ready.match?.[0] ?? ready.line.match(QUICK_TUNNEL_URL)?.[0];
				if (!url) throw new Error("cloudflared did not report a public URL.");
				return { url: `${url.replace(/\/$/, "")}/` };
			} catch (error) {
				await process.kill("SIGTERM").catch(() => undefined);
				if (tunnel === process) tunnel = undefined;
				throw error;
			}
		},

		async closeTunnel() {
			tunnel = undefined;
			const tunnels = await session(QUICK_TUNNEL_SESSION_ID);
			const running = await tunnels.listProcesses().catch(() => []);
			await Promise.all(
				running
					.filter((process) => process.command.includes("cloudflared tunnel"))
					.map((process) => process.kill("SIGTERM").catch(() => undefined)),
			);
		},
	};
	return ops;
}
