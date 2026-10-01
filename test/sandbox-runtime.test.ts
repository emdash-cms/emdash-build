import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapacityGrant } from "../src/worker/sandbox-capacity.js";
import { NOT_RUNNING } from "../src/worker/sandbox-ops.js";
import {
	BASE_ENV,
	SAFETY_INACTIVITY_MS,
	SandboxRuntime,
	type FilesLike,
} from "../src/worker/sandbox-runtime.js";
import { LocalContainer } from "./fixtures/local-container.js";

let root: string;
let path: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "emdash-runtime-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	const tool = (name: string, body: string) => {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	};
	// util-linux setsid and a cloudflared that prints its URL, then serves.
	tool(
		"setsid",
		'#!/bin/sh\n[ "$1" = "-w" ] && shift\nexec perl -e \'use POSIX qw(setsid); setsid() or die; exec @ARGV or die\' "$@"\n',
	);
	// GNU timeout: TERM after the duration, exit 124.
	tool(
		"timeout",
		[
			"#!/usr/bin/perl",
			"my @args = @ARGV; shift @args while @args && $args[0] =~ /^--/;",
			"my $duration = shift @args; $duration =~ s/s$//;",
			// Like GNU timeout, run the command in its own group and pass TERM on to all of it.
			"my $pid = fork(); if (!$pid) { setpgrp(0, 0); exec @args or exit 127; }",
			"local $SIG{TERM} = sub { kill 'TERM', -$pid };",
			"local $SIG{ALRM} = sub { kill 'TERM', -$pid; waitpid($pid, 0); exit 124 };",
			"alarm $duration; while (waitpid($pid, 0) == -1 && $!{EINTR}) {}",
			"exit(($? & 127) ? 128 + ($? & 127) : $? >> 8);",
			"",
		].join("\n"),
	);
	tool(
		"cloudflared",
		// It names its own API host first, as its error lines do.
		'#!/bin/sh\necho "failed to request quick Tunnel: Post https://api.trycloudflare.com/tunnel"\necho "|  https://quick-brown-fox.trycloudflare.com  |"\nexec sleep 30\n',
	);
	path = `${bin}:/usr/bin:/bin`;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function files(contents: Record<string, string> = {}) {
	const written: Array<[string, string]> = [];
	const dirs: string[] = [];
	const fake: FilesLike = {
		async readFile(file) {
			if (!(file in contents)) {
				throw Object.assign(new Error(`ENOENT: ${file}`), {
					name: "SandboxFileError",
					code: "ENOENT",
				});
			}
			return new Response(contents[file]);
		},
		async writeFile(file, content) {
			written.push([file, content]);
		},
		async mkdir(dir) {
			dirs.push(dir);
		},
		async remove() {},
	};
	return { fake, written, dirs };
}

function setup(
	options: {
		grant?: CapacityGrant;
		contents?: Record<string, string>;
		tunnelWaitMs?: number;
		readyTimeoutMs?: number;
		path?: string;
	} = {},
) {
	const container = new LocalContainer(options.path ?? path);
	const processRoot = mkdtempSync(join(root, "processes-"));
	const capacity = {
		acquire: vi.fn(
			async (): Promise<CapacityGrant> => options.grant ?? { granted: true, expiresAt: 0 },
		),
		release: vi.fn(async () => {}),
	};
	const fs = files(options.contents);
	const runtime = new SandboxRuntime({
		container,
		files: fs.fake,
		capacity,
		holder: () => "project-1",
		startOptions: () => ({ enableInternet: true, image: "sandbox:1" }),
		processRoot,
		tunnelWaitMs: options.tunnelWaitMs,
		readyTimeoutMs: options.readyTimeoutMs,
	});
	return { container, capacity, runtime, fs, processRoot };
}

async function running(options?: Parameters<typeof setup>[0]) {
	const context = setup(options);
	await context.runtime.ensureRunning();
	return context;
}

describe("starting the container", { timeout: 30_000 }, () => {
	it("takes a slot, starts once for concurrent callers, and arms the safety timeout", async () => {
		const { container, capacity, runtime } = setup();

		const [first, second] = await Promise.all([runtime.ensureRunning(), runtime.ensureRunning()]);

		expect(first).toEqual({ ok: true });
		expect(second).toEqual({ ok: true });
		expect(capacity.acquire).toHaveBeenCalledOnce();
		expect(capacity.acquire).toHaveBeenCalledWith("project-1", { reason: "start" });
		expect(container.starts).toEqual([{ enableInternet: true, image: "sandbox:1" }]);
		expect(container.inactivityTimeoutMs).toBe(SAFETY_INACTIVITY_MS);
		await expect(runtime.ensureRunning()).resolves.toEqual({ ok: true });
		expect(container.starts).toHaveLength(1);
	});

	it("makes a second caller wait for a start already under way", async () => {
		const { container, runtime } = setup();
		container.execDelayMs = 300;
		const order: string[] = [];

		const first = runtime.ensureRunning().then(() => order.push("first"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The container counts as running already, but is not ready.
		expect(container.running).toBe(true);
		const second = runtime.ensureRunning().then(() => order.push("second"));
		await Promise.all([first, second]);

		expect(order).toEqual(["first", "second"]);
		expect(container.starts).toHaveLength(1);
	});

	it("gives up on a container that does not become ready, and frees its slot", async () => {
		const { container, capacity, runtime } = setup({ readyTimeoutMs: 200 });
		container.hang = (argv) => argv.at(-1)?.startsWith("rm -rf") ?? false;

		await expect(runtime.ensureRunning()).rejects.toThrow("did not become ready");
		expect(container.destroyed).toBe(1);
		expect(capacity.release).toHaveBeenCalledWith("project-1");
	});

	it("reports the queue position instead of starting past the cap", async () => {
		const { container, runtime } = setup({
			grant: { granted: false, position: 3, retryAfterMs: 10_000 },
		});

		await expect(runtime.ensureRunning()).resolves.toEqual({
			ok: false,
			reason: "capacity",
			position: 3,
			retryAfterMs: 10_000,
		});
		expect(container.starts).toEqual([]);
	});

	it("gives the slot back when a start fails, and waits when the platform is full", async () => {
		const { container, capacity, runtime } = setup();
		container.startError = new Error("invalid image");
		await expect(runtime.ensureRunning()).rejects.toThrow("invalid image");
		expect(capacity.release).toHaveBeenCalledWith("project-1");

		container.startError = new Error(
			"There is no container instance that can be provided to this Durable Object, try again later",
		);
		await expect(runtime.ensureRunning()).resolves.toEqual({
			ok: false,
			reason: "capacity",
			retryAfterMs: 15_000,
		});
		expect(capacity.release).toHaveBeenCalledTimes(2);
	});

	it("refuses commands until the container runs, instead of starting an empty one", async () => {
		const { container, runtime } = setup();
		await expect(runtime.exec("true")).rejects.toThrow(NOT_RUNNING);
		await expect(runtime.readFile("/home/user/site/package.json")).rejects.toThrow(NOT_RUNNING);
		expect(container.starts).toEqual([]);
	});
});

describe("commands", { timeout: 30_000 }, () => {
	it("runs a command in bash with the image environment restated", async () => {
		const { container, runtime } = await running();

		const result = await runtime.exec('echo "$HOME $GREETING"; echo oops >&2; exit 3', {
			env: { GREETING: "hi" },
		});

		expect(result).toEqual({
			success: false,
			exitCode: 3,
			stdout: "/home/user hi\n",
			stderr: "oops\n",
		});
		// Even an untimed command runs under timeout, which passes Stop on to its children.
		expect(container.execs.at(-1)?.slice(0, 6)).toEqual([
			"timeout",
			"--signal=TERM",
			"--kill-after=2s",
			"86400s",
			"bash",
			"-c",
		]);
		expect(BASE_ENV.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/emdash-ca-bundle.pem");
	});

	it("wraps a timed command in GNU timeout, keeping its exit status", async () => {
		const { container, runtime } = await running();
		container.answers.push({ match: (argv) => argv[0] === "timeout", result: { exitCode: 124 } });

		await expect(runtime.exec("sleep 60", { timeout: 1500 })).resolves.toMatchObject({
			success: false,
			exitCode: 124,
		});
		expect(container.execs.at(-1)).toEqual([
			"timeout",
			"--signal=TERM",
			"--kill-after=2s",
			"2s",
			"bash",
			"-c",
			"sleep 60",
		]);
	});

	it("stops a command whose Stop came while it was starting", async () => {
		const { container, runtime } = await running();
		container.execDelayMs = 300;
		const controller = new AbortController();
		const started = Date.now();
		const pending = runtime.exec("sleep 10", { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);

		await expect(pending).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(6_000);
	});

	it("stops every part of a compound command on abort", async () => {
		const { runtime } = await running();
		const controller = new AbortController();
		const started = Date.now();
		const pending = runtime.exec("sleep 10; echo done", { signal: controller.signal });
		setTimeout(() => controller.abort(), 200);

		await expect(pending).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(6_000);
	});

	it("stops a command on abort and rejects", async () => {
		const { runtime } = await running();
		const controller = new AbortController();
		const pending = runtime.exec("sleep 30", { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort();
		await expect(pending).rejects.toThrow();
	});
});

describe("files", { timeout: 30_000 }, () => {
	it("reads text and base64, and reports a missing file the way callers expect", async () => {
		const { runtime } = await running({ contents: { "/a.txt": "héllo" } });

		await expect(runtime.readFile("/a.txt", { encoding: "utf-8" })).resolves.toEqual({
			success: true,
			content: "héllo",
		});
		await expect(runtime.readFile("/a.txt", { encoding: "base64" })).resolves.toEqual({
			success: true,
			content: btoa(String.fromCharCode(...new TextEncoder().encode("héllo"))),
		});
		await expect(runtime.readFile("/missing")).rejects.toThrow(
			"FileNotFoundError: File not found: /missing",
		);
		expect(await new Response(await runtime.readFileStream("/a.txt")).text()).toBe("héllo");
	});

	it("creates parent directories before writing, as 0.12 did", async () => {
		const { runtime, fs } = await running();
		await expect(runtime.writeFile("/home/user/site/src/new/page.astro", "x")).resolves.toEqual({
			success: true,
		});
		expect(fs.dirs).toEqual(["/home/user/site/src/new"]);
		expect(fs.written).toEqual([["/home/user/site/src/new/page.astro", "x"]]);
	});

	it("lists a tree from find's output", async () => {
		const { container, runtime } = await running();
		container.answers.push({
			match: (argv) => argv.at(-1)?.startsWith("find ") ?? false,
			result: {
				exitCode: 0,
				stdout: "d\t4096\t/site/src\0f\t120\t/site/src/index.astro\0l\t7\t/site/src/odd\nname\0",
			},
		});

		await expect(runtime.listFiles("/site", { recursive: true })).resolves.toEqual({
			success: true,
			files: [
				{ type: "directory", size: 4096, absolutePath: "/site/src" },
				{ type: "file", size: 120, absolutePath: "/site/src/index.astro" },
				{ type: "symlink", size: 7, absolutePath: "/site/src/odd\nname" },
			],
		});
	});
});

describe("ports", { timeout: 30_000 }, () => {
	it("fetches a port over plain HTTP with the URL's host, and answers 503 when nothing listens", async () => {
		const { container, runtime } = await running();
		container.ports.set(
			4322,
			async (request) => new Response(`${request.url} ${request.headers.get("x-test")}`),
		);

		const response = await runtime.fetchPort(4322, "https://site.example/about", {
			headers: { "x-test": "kept" },
		});
		expect(await response.text()).toBe("http://site.example/about kept");
		expect((await runtime.fetchPort(4321, "http://localhost:4321/")).status).toBe(503);
	});
});

describe("background processes", { timeout: 30_000 }, () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it("follows a process's output as log events and reports its exit code", async () => {
		const { runtime } = await running();

		await runtime.startProcess("build-1", "echo compiling; sleep 0.3; echo done; exit 2");
		const events = await new Response(await runtime.followProcessLogs("build-1")).text();

		expect(events.trim().split("\n\n")).toEqual([
			'data: {"type":"stdout","data":"compiling\\n"}',
			'data: {"type":"stdout","data":"done\\n"}',
			'data: {"type":"complete","exitCode":2}',
		]);
		await expect(runtime.waitForProcessExit("build-1", 5_000)).resolves.toEqual({ exitCode: 2 });
	});

	it("refuses an id that is running, reuses one that exited, and stops a process", async () => {
		const { runtime } = await running();

		await runtime.startProcess("dev-1", "echo old; sleep 30");
		await expect(runtime.startProcess("dev-1", "echo new")).rejects.toThrow("already running");
		await runtime.stopProcess("dev-1");
		await expect(runtime.waitForProcessExit("dev-1", 10_000)).resolves.toEqual({ exitCode: 143 });

		await runtime.startProcess("dev-1", "echo new");
		const events = await new Response(await runtime.followProcessLogs("dev-1")).text();
		expect(events).toContain('"data":"new\\n"');
		expect(events).not.toContain("old");
		await expect(runtime.waitForProcessExit("missing", 1_000)).rejects.toThrow("not running");
	});

	it("lets one of two starts of the same id run, and stops a process started a moment ago", async () => {
		const { runtime } = await running();

		const starts = await Promise.allSettled([
			runtime.startProcess("dup", "sleep 30"),
			runtime.startProcess("dup", "sleep 30"),
		]);
		expect(starts.map((start) => start.status).sort()).toEqual(["fulfilled", "rejected"]);

		// startProcess returns once the process has a pid, so Stop reaches it.
		await runtime.startProcess("quick", "sleep 30");
		await runtime.stopProcess("quick");
		await expect(runtime.waitForProcessExit("quick", 10_000)).resolves.toEqual({ exitCode: 143 });
		await runtime.stopProcess("dup");
		await expect(runtime.followProcessLogs("never-started")).rejects.toThrow("not running");
	});

	it("opens a quick tunnel, reuses it while it runs, and closes it", async () => {
		const { container, runtime } = await running();

		await expect(runtime.openTunnel(4321)).resolves.toEqual({
			url: "https://quick-brown-fox.trycloudflare.com/",
		});
		const starts = () => container.execs.filter((argv) => argv.includes("run")).length;
		expect(starts()).toBe(1);
		await expect(runtime.openTunnel(4321)).resolves.toEqual({
			url: "https://quick-brown-fox.trycloudflare.com/",
		});
		expect(starts()).toBe(1);

		await runtime.closeTunnel(4321);
		await expect(runtime.waitForProcessExit("tunnel-4321", 10_000)).resolves.toMatchObject({
			exitCode: 143,
		});
	});
});
