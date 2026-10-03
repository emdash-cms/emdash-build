import { describe, expect, it, vi } from "vitest";
import { legacySandboxOps } from "../src/worker/legacy-sandbox-ops.js";
import { readFilesFromSandbox } from "../src/worker/tools.js";

const encoder = new TextEncoder();

/** A 0.12 file stream: server-sent `metadata`, `chunk` and `complete` events. */
function sseFileStream(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
	const isBinary = chunks.some((chunk) => chunk instanceof Uint8Array);
	const events = [
		{
			type: "metadata",
			mimeType: "text/plain",
			size: 0,
			isBinary,
			encoding: isBinary ? "base64" : "utf-8",
		},
		...chunks.map((chunk) => ({
			type: "chunk",
			data: typeof chunk === "string" ? chunk : btoa(String.fromCharCode(...Array.from(chunk))),
		})),
		{ type: "complete" },
	];
	return new ReadableStream({
		start(controller) {
			for (const event of events)
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			controller.close();
		},
	});
}

/** The SDK's `streamFile` (it cannot be imported outside workerd): it reads events as they arrive. */
async function* decodeFileStream(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let binary = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) throw new Error("Stream ended unexpectedly");
			buffer += decoder.decode(value, { stream: true });
			let boundary: number;
			while ((boundary = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				if (!frame.startsWith("data: ")) continue;
				const event = JSON.parse(frame.slice(6)) as {
					type: string;
					isBinary?: boolean;
					data?: string;
					error?: string;
				};
				if (event.type === "metadata") binary = Boolean(event.isBinary);
				else if (event.type === "chunk") {
					yield binary ? Uint8Array.from(atob(event.data!), (c) => c.charCodeAt(0)) : event.data!;
				} else if (event.type === "error") throw new Error(`File streaming error: ${event.error}`);
				else if (event.type === "complete") {
					return { mimeType: "text/plain", size: 0, isBinary: binary, encoding: "utf-8" as const };
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function ops(
	sandbox: Record<string, unknown>,
	options: { quickTunnel?: boolean; log?: (line: string) => void } = {},
) {
	return legacySandboxOps(sandbox as never, { streamFile: decodeFileStream as never, ...options });
}

function process(overrides: Record<string, unknown> = {}) {
	return {
		id: "p",
		command: "",
		status: "running",
		getStatus: vi.fn(async () => "running"),
		getLogs: vi.fn(async () => ({ stdout: "", stderr: "" })),
		waitForExit: vi.fn(async () => ({ exitCode: 0 })),
		waitForLog: vi.fn(),
		kill: vi.fn(async () => undefined),
		...overrides,
	};
}

describe("Sandbox SDK 0.12 adapter", () => {
	it("runs commands in the default session, and concurrent ones beside it", async () => {
		const exec = vi.fn(async () => ({ success: true, exitCode: 0, stdout: "", stderr: "" }));
		const sideExec = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			stdout: "pushed",
			stderr: "",
		}));
		const createSession = vi
			.fn()
			.mockResolvedValueOnce({ exec: sideExec })
			.mockRejectedValueOnce(new Error("Session builder-side already exists"));
		const getSession = vi.fn(async () => ({ exec: sideExec }));
		const sandbox = ops({ exec, createSession, getSession });

		await sandbox.exec("git status", { cwd: "/home/user/site", timeout: 5000 });
		await sandbox.exec("git push", { cwd: "/tmp", concurrent: true });
		await sandbox.exec("git push", { cwd: "/tmp", concurrent: true });

		expect(exec).toHaveBeenCalledWith("git status", { cwd: "/home/user/site", timeout: 5000 });
		expect(sideExec).toHaveBeenCalledTimes(2);
		expect(sideExec).toHaveBeenCalledWith("git push", { cwd: "/tmp" });
		// Looked up per command: a restarted container does not keep its sessions.
		expect(createSession).toHaveBeenCalledWith({ id: "builder-side" });
		expect(getSession).toHaveBeenCalledWith("builder-side");
	});

	it("streams a file's raw bytes, including text the SDK labels as binary", async () => {
		const source = "<h1>Crème & Co.</h1>\n";
		const readFileStream = vi
			.fn()
			.mockResolvedValueOnce(sseFileStream(["<h1>", "Hi</h1>"]))
			.mockResolvedValueOnce(sseFileStream([encoder.encode(source)]));
		const sandbox = ops({ readFileStream });

		expect(await new Response(await sandbox.readFileStream("/a.astro")).text()).toBe("<h1>Hi</h1>");
		expect(await new Response(await sandbox.readFileStream("/b.astro")).text()).toBe(source);
	});

	it("fails the byte stream when the SDK reports a streaming error", async () => {
		const readFileStream = vi.fn(
			async () =>
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify({ type: "error", error: "ENOENT" })}\n\n`),
						);
						controller.close();
					},
				}),
		);
		const stream = await ops({ readFileStream }).readFileStream("/missing");

		await expect(new Response(stream).text()).rejects.toThrow("File streaming error: ENOENT");
	});

	it("cancels a stalled file stream when the read is abandoned", async () => {
		let cancelled = false;
		const stalled = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({ type: "metadata", isBinary: false })}\n\n`),
				);
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({ type: "chunk", data: "partial" })}\n\n`),
				);
			},
			cancel() {
				cancelled = true;
			},
		});
		const sandbox = ops({ readFileStream: vi.fn(async () => stalled) });
		const controller = new AbortController();

		const pending = readFilesFromSandbox(sandbox, ["open.txt"], { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort();

		await expect(pending).resolves.toMatchObject({ success: false });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(cancelled).toBe(true);
	});

	it("fetches a container port with the URL's host", async () => {
		const containerFetch = vi.fn(async () => new Response("ok"));
		await ops({ containerFetch }).fetchPort(4322, "https://site.example/", { redirect: "manual" });
		expect(containerFetch).toHaveBeenCalledWith(
			"https://site.example/",
			{ redirect: "manual" },
			4322,
		);
	});

	it("tracks processes by id and waits on the handle it started", async () => {
		const started = process({ waitForExit: vi.fn(async () => ({ exitCode: 3 })) });
		const startProcess = vi.fn(async () => started);
		const sandbox = ops({ startProcess, getProcess: vi.fn(async () => null) });

		await sandbox.startProcess("install-1", "pnpm install", { cwd: "/home/user/site" });
		await expect(sandbox.waitForProcessExit("install-1", 300_000)).resolves.toEqual({
			exitCode: 3,
		});

		expect(startProcess).toHaveBeenCalledWith("pnpm install", {
			cwd: "/home/user/site",
			processId: "install-1",
		});
		expect(started.waitForExit).toHaveBeenCalledWith(300_000);
		// The handle is released once the process has exited.
		await expect(sandbox.waitForProcessExit("install-1", 1)).rejects.toThrow("is not running");
	});

	it("stops a tracked process with SIGTERM, an untracked one by id, and ignores failures", async () => {
		const started = process({ kill: vi.fn(async () => Promise.reject(new Error("exited"))) });
		const killProcess = vi.fn(async () => undefined);
		const sandbox = ops({ startProcess: vi.fn(async () => started), killProcess });

		await sandbox.startProcess("dev-1", "pnpm dev");
		await expect(sandbox.stopProcess("dev-1")).resolves.toBeUndefined();
		await sandbox.stopProcess("dev-0");

		expect(started.kill).toHaveBeenCalledWith("SIGTERM");
		expect(killProcess).toHaveBeenCalledWith("dev-0");
	});

	it("runs the dev server in its own session only in quick-tunnel mode", async () => {
		const sessionStart = vi.fn(async () => process());
		const startProcess = vi.fn(async () => process());
		const sandbox = {
			startProcess,
			createSession: vi.fn(async () => ({ startProcess: sessionStart })),
		};

		await ops(sandbox).startProcess("dev-1", "pnpm dev");
		await ops(sandbox, { quickTunnel: true }).startProcess("install-1", "pnpm install");
		await ops(sandbox, { quickTunnel: true }).startProcess("dev-2", "pnpm dev");

		expect(startProcess).toHaveBeenCalledTimes(2);
		expect(sandbox.createSession).toHaveBeenCalledWith({ id: "builder-dev" });
		expect(sessionStart).toHaveBeenCalledWith("pnpm dev", { processId: "dev-2" });
	});

	it("reuses an active exposure and exposes with the stable token otherwise", async () => {
		const active = ops({
			getExposedPorts: vi.fn(async () => [{ port: 4321, url: "https://4321-a-b.example/" }]),
			exposePort: vi.fn(),
		});
		await expect(active.exposePort(4321, { hostname: "example", token: "b" })).resolves.toEqual({
			url: "https://4321-a-b.example/",
		});

		const exposePort = vi.fn(async () => ({ url: "https://4321-a-tok.example/" }));
		const fresh = ops({ getExposedPorts: vi.fn(async () => []), exposePort });
		await expect(fresh.exposePort(4321, { hostname: "example", token: "tok" })).resolves.toEqual({
			url: "https://4321-a-tok.example/",
		});
		expect(exposePort).toHaveBeenCalledWith(4321, {
			hostname: "example",
			name: "preview",
			token: "tok",
		});
	});

	it("recovers an exposure that raced container startup or outlived its token record", async () => {
		const raced = ops({
			getExposedPorts: vi
				.fn()
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce([{ port: 4321, url: "https://restored.example/" }]),
			exposePort: vi.fn(async () => Promise.reject(new Error("Port 4321 is already exposed"))),
		});
		await expect(raced.exposePort(4321, { hostname: "example", token: "t" })).resolves.toEqual({
			url: "https://restored.example/",
		});

		const unexposePort = vi.fn(async () => undefined);
		const exposePort = vi
			.fn()
			.mockRejectedValueOnce(new Error("Port 4321 is already exposed"))
			.mockResolvedValueOnce({ url: "https://recreated.example/" });
		const orphaned = ops({ getExposedPorts: vi.fn(async () => []), exposePort, unexposePort });
		await expect(orphaned.exposePort(4321, { hostname: "example", token: "t" })).resolves.toEqual({
			url: "https://recreated.example/",
		});
		expect(unexposePort).toHaveBeenCalledWith(4321);
	});

	it("opens a quick tunnel in its own session and reuses it while it runs", async () => {
		const tunnel = process({
			command: "cloudflared tunnel --url http://127.0.0.1:4321",
			waitForLog: vi.fn(async () => ({
				line: "Visit https://branch-preview.trycloudflare.com",
				match: ["https://branch-preview.trycloudflare.com"],
			})),
			getLogs: vi.fn(async () => ({
				stdout: "https://branch-preview.trycloudflare.com",
				stderr: "",
			})),
		});
		const session = {
			listProcesses: vi.fn(async () => []),
			startProcess: vi.fn(async () => tunnel),
		};
		const log = vi.fn();
		const sandbox = ops({ createSession: vi.fn(async () => session) }, { quickTunnel: true, log });

		await expect(sandbox.openTunnel(4321)).resolves.toEqual({
			url: "https://branch-preview.trycloudflare.com/",
		});
		await expect(sandbox.openTunnel(4321)).resolves.toEqual({
			url: "https://branch-preview.trycloudflare.com/",
		});

		expect(session.startProcess).toHaveBeenCalledOnce();
		expect(session.startProcess).toHaveBeenCalledWith(
			"cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:4321",
			{ cwd: "/home/user/site" },
		);
		expect(log).toHaveBeenCalledWith("$ cloudflared tunnel (Worker Preview)");
	});

	it("stops a tunnel that reports no URL, and closes running tunnels", async () => {
		const failed = process({ waitForLog: vi.fn(async () => ({ line: "starting" })) });
		const running = process({ command: "cloudflared tunnel --url http://127.0.0.1:4321" });
		const session = {
			listProcesses: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([running]),
			startProcess: vi.fn(async () => failed),
		};
		const sandbox = ops({ createSession: vi.fn(async () => session) }, { quickTunnel: true });

		await expect(sandbox.openTunnel(4321)).rejects.toThrow("did not report a public URL");
		expect(failed.kill).toHaveBeenCalledWith("SIGTERM");

		await sandbox.closeTunnel(4321);
		expect(running.kill).toHaveBeenCalledWith("SIGTERM");
	});
});
