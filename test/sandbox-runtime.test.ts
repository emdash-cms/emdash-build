import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapacityGrant } from "../src/worker/sandbox-capacity.js";
import { NOT_RUNNING } from "../src/worker/sandbox-ops.js";
import {
	BASE_ENV,
	CONTAINER_ANSWER_MS,
	CONTAINER_NOT_ANSWERING,
	SAFETY_INACTIVITY_MS,
	SandboxRuntime,
	type FilesLike,
} from "../src/worker/sandbox-runtime.js";
import { MODEL_COMMAND_TIMEOUT_MS, modelCommand } from "../src/worker/tools.js";
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
	// GNU timeout: it puts itself in a new process group, runs the command in it,
	// and passes TERM (its own, or at the deadline) to the command and the whole
	// group, then KILL after --kill-after. It exits 124 at the deadline.
	tool(
		"timeout",
		[
			"#!/usr/bin/perl",
			"use POSIX ();",
			"my @args = @ARGV; my $kill_after = 0;",
			"while (@args && $args[0] =~ /^--/) { my $a = shift @args; $kill_after = $1 if $a =~ /^--kill-after=(\\d+)s?$/; }",
			"my $duration = shift @args; $duration =~ s/s$//;",
			"setpgrp(0, 0);",
			"my $pid = fork(); if (!$pid) { exec @args or POSIX::_exit(127); }",
			"my $timed_out = 0;",
			"sub cleanup { my $sig = shift; if ($sig eq 'ALRM') { $timed_out = 1; $sig = 'TERM'; }",
			"  if ($kill_after) { $SIG{ALRM} = sub { kill 'KILL', $pid; kill 'KILL', 0; }; alarm $kill_after; $kill_after = 0; }",
			"  local $SIG{TERM} = 'IGNORE'; kill $sig, $pid; kill $sig, 0; }",
			"$SIG{TERM} = sub { cleanup('TERM') }; $SIG{ALRM} = sub { cleanup('ALRM') };",
			"alarm $duration;",
			"while (waitpid($pid, 0) == -1) { last unless $!{EINTR}; }",
			"my $st = $?; exit 124 if $timed_out;",
			"exit(($st & 127) ? 128 + ($st & 127) : $st >> 8);",
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
		answerTimeoutMs?: number;
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
		requeue: vi.fn(async () => {}),
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
		answerTimeoutMs: options.answerTimeoutMs,
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
		// The platform had no room: the slot goes back, the place in line stays.
		expect(capacity.release).toHaveBeenCalledTimes(1);
		expect(capacity.requeue).toHaveBeenCalledWith("project-1");
	});

	it("keeps the slot of a start already under way when its wait is cancelled", async () => {
		const { container, capacity, runtime } = setup();
		let grant!: (value: CapacityGrant) => void;
		capacity.acquire.mockImplementationOnce(() => new Promise((resolve) => (grant = resolve)));

		const start = runtime.ensureRunning();
		const cancel = runtime.cancelStart();
		grant({ granted: true, expiresAt: 0 });

		await expect(start).resolves.toEqual({ ok: true });
		await cancel;
		expect(container.running).toBe(true);
		expect(capacity.release).not.toHaveBeenCalled();
	});

	it("gives up the place in line of a start that was refused a slot", async () => {
		const { capacity, runtime } = setup({
			grant: { granted: false, position: 2, retryAfterMs: 1 },
		});

		const start = runtime.ensureRunning();
		await runtime.cancelStart();

		await expect(start).resolves.toMatchObject({ ok: false, position: 2 });
		expect(capacity.release).toHaveBeenCalledWith("project-1");
	});

	it("keeps the slot of a container that failed to stop, so the stop is tried again", async () => {
		const { container, capacity, runtime } = await running();
		container.destroy = async () => {
			throw new Error("destroy failed");
		};

		await expect(runtime.stop()).rejects.toThrow("destroy failed");
		expect(container.running).toBe(true);
		expect(capacity.release).not.toHaveBeenCalled();
	});

	it("answers calls made while the container stops as not running, so callers restore it", async () => {
		const { container, runtime } = await running();
		let destroyed!: () => void;
		const destroy = container.destroy.bind(container);
		container.destroy = () =>
			new Promise<void>((resolve) => {
				destroyed = () => void destroy().then(resolve);
			});

		const stopping = runtime.stop();
		await expect(runtime.exec("true")).rejects.toThrow(NOT_RUNNING);
		await expect(runtime.readFile("/home/user/site/package.json")).rejects.toThrow(NOT_RUNNING);
		destroyed();
		await stopping;
	});

	it("refuses commands until the container runs, instead of starting an empty one", async () => {
		const { container, runtime } = setup();
		await expect(runtime.exec("true")).rejects.toThrow(NOT_RUNNING);
		await expect(runtime.readFile("/home/user/site/package.json")).rejects.toThrow(NOT_RUNNING);
		expect(container.starts).toEqual([]);
	});
});

describe("a container that stops answering", { timeout: 30_000 }, () => {
	// Local workerd's habit with a container that died unnoticed: it reads as
	// running, and calls to it never return.
	it("fails a command the container does not start, and stops it if it starts late", async () => {
		const { container, runtime } = await running({ answerTimeoutMs: 100 });
		const marker = join(root, `late-${crypto.randomUUID()}`);
		container.execDelayMs = 400;

		await expect(runtime.exec(`sleep 0.3; touch ${marker}`, { timeout: 5_000 })).rejects.toThrow(
			CONTAINER_NOT_ANSWERING,
		);
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(existsSync(marker)).toBe(false);
	});

	it("fails to start or follow a background process the container does not start", async () => {
		const { container, runtime } = await running({ answerTimeoutMs: 100 });
		const runner = (argv: string[]) => argv.includes("run");
		container.hang = runner;
		await expect(runtime.startProcess("dev-1", "sleep 5")).rejects.toThrow(CONTAINER_NOT_ANSWERING);

		container.hang = undefined;
		await runtime.startProcess("dev-2", "sleep 5");
		container.hang = (argv) => argv.includes("follow");
		await expect(runtime.followProcessLogs("dev-2")).rejects.toThrow(CONTAINER_NOT_ANSWERING);
		container.hang = undefined;
		await runtime.stopProcess("dev-2");
	});

	it("fails a file call the container does not answer", async () => {
		const { fs, runtime } = await running({ answerTimeoutMs: 100 });
		fs.fake.readFile = () => new Promise<Response>(() => {});
		fs.fake.mkdir = () => new Promise<void>(() => {});

		await expect(runtime.readFile("/home/user/site/package.json")).rejects.toThrow(
			CONTAINER_NOT_ANSWERING,
		);
		await expect(runtime.readFileStream("/home/user/site/package.json")).rejects.toThrow(
			CONTAINER_NOT_ANSWERING,
		);
		await expect(runtime.writeFile("/home/user/site/a/b.txt", "b")).rejects.toThrow(
			CONTAINER_NOT_ANSWERING,
		);
		fs.fake.writeFile = () => new Promise<void>(() => {});
		fs.fake.remove = () => new Promise<void>(() => {});
		// At the root, with no directory to create first.
		await expect(runtime.writeFile("/b.txt", "b")).rejects.toThrow(CONTAINER_NOT_ANSWERING);
		await expect(runtime.deleteFile("/b.txt")).rejects.toThrow(CONTAINER_NOT_ANSWERING);
	});

	it("tries a read the container does not answer once more, since reads are safe to repeat", async () => {
		const { fs, runtime } = await running({
			answerTimeoutMs: 100,
			contents: { "/home/user/site/package.json": "{}" },
		});
		const answering = fs.fake.readFile;
		let reads = 0;
		fs.fake.readFile = (...args) =>
			++reads % 2 === 1 ? new Promise(() => {}) : answering(...args);

		await expect(runtime.readFile("/home/user/site/package.json")).resolves.toEqual({
			success: true,
			content: "{}",
		});
		const stream = await runtime.readFileStream("/home/user/site/package.json");
		expect(await new Response(stream).text()).toBe("{}");
		expect(reads).toBe(4);

		// Only a read that does not answer is tried again.
		reads = 1;
		await expect(runtime.readFile("/missing.txt")).rejects.toThrow("File not found");
		expect(reads).toBe(2);
	});

	it("tries an unanswered read again well before the usual bound", async () => {
		const { fs, runtime } = await running({ contents: { "/a.txt": "a" } });
		const answering = fs.fake.readFile;
		let reads = 0;
		fs.fake.readFile = (...args) => (++reads === 1 ? new Promise(() => {}) : answering(...args));
		vi.useFakeTimers();
		try {
			const read = runtime.readFile("/a.txt");
			await vi.advanceTimersByTimeAsync(CONTAINER_ANSWER_MS / 2);
			// Answered by now, not merely pending: awaiting a pending read would stall the fake clock.
			const outcome = await Promise.race([read, Promise.resolve("still waiting")]);
			expect(outcome).toEqual({ success: true, content: "a" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("still takes a slow read that answers within the usual bound", async () => {
		const { fs, runtime } = await running({ answerTimeoutMs: 300 });
		let reads = 0;
		fs.fake.readFile = () =>
			++reads === 1
				? new Promise((resolve) => setTimeout(() => resolve(new Response("slow")), 450))
				: new Promise(() => {});

		await expect(runtime.readFile("/a.txt")).resolves.toEqual({ success: true, content: "slow" });
		expect(reads).toBe(2);
	});

	it("lets only the second read's error decide, since the first may fail late", async () => {
		const { fs, runtime } = await running({ answerTimeoutMs: 200 });
		let reads = 0;
		fs.fake.readFile = () =>
			++reads === 1
				? new Promise((_, reject) =>
						setTimeout(() => reject(new Error("Network connection lost")), 250),
					)
				: new Promise((resolve) => setTimeout(() => resolve(new Response("second")), 100));

		await expect(runtime.readFile("/a.txt")).resolves.toEqual({ success: true, content: "second" });
	});

	it("closes the read that lost when it answers late", async () => {
		const { fs, runtime } = await running({ answerTimeoutMs: 100, contents: { "/a.txt": "a" } });
		const answering = fs.fake.readFile;
		let answerLate!: (response: Response) => void;
		const cancelled = vi.fn();
		let reads = 0;
		fs.fake.readFile = (...args) =>
			++reads === 1 ? new Promise((resolve) => (answerLate = resolve)) : answering(...args);

		await expect(runtime.readFile("/a.txt")).resolves.toEqual({ success: true, content: "a" });
		answerLate(new Response(new ReadableStream({ cancel: cancelled })));
		await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
	});

	it("fails a start the container does not answer, keeping the slot while it still runs", async () => {
		const { container, capacity, runtime } = setup({ answerTimeoutMs: 100 });
		container.setInactivityTimeout = () => new Promise<void>(() => {});
		container.destroy = () => new Promise<void>(() => {});

		await expect(runtime.ensureRunning()).rejects.toThrow(CONTAINER_NOT_ANSWERING);
		expect(container.running).toBe(true);
		expect(capacity.release).not.toHaveBeenCalled();
	});

	it("gives a container it finds running as long to answer as a start, until it has answered", async () => {
		const { container, runtime } = setup({ answerTimeoutMs: 100, readyTimeoutMs: 2_000 });
		// As after this object restarted while its container was starting.
		container.running = true;
		container.execDelayMs = 300;

		await expect(runtime.exec("true")).resolves.toMatchObject({ success: true });
		await expect(runtime.exec("true")).rejects.toThrow(CONTAINER_NOT_ANSWERING);
	});

	it("gives a container that never answers no more than a start's time, then the usual bound", async () => {
		const { container, runtime } = setup({ answerTimeoutMs: 100, readyTimeoutMs: 400 });
		container.running = true;
		container.execDelayMs = 2_000;

		const first = Date.now();
		await expect(runtime.exec("true")).rejects.toThrow(CONTAINER_NOT_ANSWERING);
		expect(Date.now() - first).toBeGreaterThanOrEqual(350);
		const second = Date.now();
		await expect(runtime.exec("true")).rejects.toThrow(CONTAINER_NOT_ANSWERING);
		expect(Date.now() - second).toBeLessThan(300);
	});

	it("gives a call made while the container starts as long as the start", async () => {
		const { container, runtime } = await running({ answerTimeoutMs: 100, readyTimeoutMs: 600 });
		await runtime.stop();
		// Past the first start's own window, so only the new start's can cover the call.
		await new Promise((resolve) => setTimeout(resolve, 700));
		container.execDelayMs = 300;

		const starting = runtime.ensureRunning();
		// The container counts as running as soon as it is asked to start.
		while (!container.running) await new Promise((resolve) => setTimeout(resolve, 5));
		await expect(runtime.exec("true")).resolves.toMatchObject({ success: true });
		await expect(starting).resolves.toEqual({ ok: true });
	});

	it("keeps the slot of a container whose stop does not answer, so the stop is tried again", async () => {
		const { container, capacity, runtime } = await running({ answerTimeoutMs: 100 });
		container.destroy = () => new Promise<void>(() => {});

		await expect(runtime.stop()).rejects.toThrow(CONTAINER_NOT_ANSWERING);
		expect(capacity.release).not.toHaveBeenCalled();
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
			"--kill-after=6s",
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
			"--kill-after=6s",
			"2s",
			"bash",
			"-c",
			expect.stringContaining('"$@" & child=$!'),
			"exec",
			expect.stringMatching(/^__emdash_exit_[0-9a-f-]{36}__$/),
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

	it("returns when the command does, even if it leaves a process running", async () => {
		const { runtime } = await running();
		const started = Date.now();

		const result = await runtime.exec("sleep 21.5 & echo started", { timeout: 10_000 });

		expect(result).toMatchObject({ success: true, exitCode: 0, stdout: "started\n" });
		expect(Date.now() - started).toBeLessThan(5_000);
		await runtime.exec("pkill -f 'sleep 21.5' || true");
	});

	it("stops on abort even if the command left a process running", async () => {
		const { runtime } = await running();
		const controller = new AbortController();
		const started = Date.now();
		const pending = runtime.exec("sleep 21.6 & sleep 30", { signal: controller.signal });
		setTimeout(() => controller.abort(), 300);

		await expect(pending).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(6_000);
		await runtime.exec("pkill -f 'sleep 21.6' || true");
	});

	it("keeps what a command printed before its timeout", async () => {
		const { runtime } = await running();

		const result = await runtime.exec("echo before; echo warn >&2; sleep 30", { timeout: 1000 });

		expect(result).toEqual({ success: false, exitCode: 124, stdout: "before\n", stderr: "warn\n" });
	});

	it("keeps the first 1 MiB of each stream, and all of a smaller one", async () => {
		const { runtime } = await running();

		const large = await runtime.exec("head -c 1500000 /dev/zero | tr '\\0' a; echo e >&2");
		const small = await runtime.exec("head -c 200000 /dev/zero | tr '\\0' b");

		expect(large.stdout).toHaveLength(1024 * 1024);
		expect(large.stderr).toBe("e\n");
		expect(small.stdout).toBe("b".repeat(200000));
	});

	it("reads output that arrives after the command's exit", async () => {
		const { container, runtime } = await running();
		const exec = container.exec.bind(container);
		// Output crosses the network separately from the exit status, and can trail it.
		container.exec = async (argv, options) => {
			const process = await exec(argv, options);
			const delayed = process.stdout!.pipeThrough(
				new TransformStream({
					async transform(chunk, controller) {
						await new Promise((resolve) => setTimeout(resolve, 300));
						controller.enqueue(chunk);
					},
				}),
			);
			return Object.assign(process, { stdout: delayed });
		};

		const result = await runtime.exec("echo first; echo second");

		expect(result.stdout).toBe("first\nsecond\n");
	});

	it("returns at its deadline even when a process in another group holds the output", async () => {
		const { runtime } = await running();
		const started = Date.now();

		const result = await runtime.exec("setsid sleep 6 & echo before; sleep 30", { timeout: 1000 });

		expect(result).toMatchObject({ exitCode: 124, stdout: "before\n" });
		expect(Date.now() - started).toBeLessThan(3_000);
	});

	it("keeps the end of the output when its mark never comes", async () => {
		const { runtime } = await running();

		// The command outlives TERM, so KILL ends the wrapper before its mark, while
		// a process in another group holds the pipes open.
		const result = await runtime.exec("trap '' TERM; printf tail; setsid sleep 20 & sleep 20", {
			timeout: 1000,
		});

		expect(result.stdout).toBe("tail");
		expect(result.exitCode).toBeGreaterThanOrEqual(124);
	});

	it("finds the end mark when the stream splits it", async () => {
		const { container, runtime } = await running();
		const exec = container.exec.bind(container);
		container.exec = async (argv, options) => {
			const process = await exec(argv, options);
			const split = (stream: ReadableStream<Uint8Array> | null) =>
				stream?.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, controller) {
							for (let at = 0; at < chunk.length; at += 7)
								controller.enqueue(chunk.slice(at, at + 7));
						},
					}),
				) ?? null;
			return Object.assign(process, {
				stdout: split(process.stdout),
				stderr: split(process.stderr),
			});
		};

		const result = await runtime.exec("printf 'no newline'; echo err >&2");

		expect(result).toMatchObject({ stdout: "no newline", stderr: "err\n" });
	});

	it("returns while a process the command left running keeps printing, and leaves it running", async () => {
		const { runtime } = await running();
		const marker = join(mkdtempSync(join(root, "left-")), "done");
		const started = Date.now();

		const result = await runtime.exec(
			`(sleep 0.3; for i in 1 2 3 4 5 6 7 8; do echo tick; sleep 0.1; done; touch ${marker}) & echo started`,
		);

		expect(result).toMatchObject({ exitCode: 0, stdout: "started\n" });
		expect(Date.now() - started).toBeLessThan(4_000);
		// The process lives on and finishes, however slowly a loaded machine runs it.
		for (let waited = 0; waited < 15_000 && !existsSync(marker); waited += 100) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(existsSync(marker)).toBe(true);
	});

	it("restores protected files when the model's command is stopped", async () => {
		const { runtime } = await running();
		const site = mkdtempSync(join(root, "site-"));
		writeFileSync(join(site, "AGENTS.md"), "original\n");
		const tmp = mkdtempSync(join(root, "tmp-"));
		const controller = new AbortController();
		const pending = runtime.exec(modelCommand("echo tampered > AGENTS.md; sleep 3"), {
			cwd: site,
			env: { TMPDIR: tmp },
			timeout: MODEL_COMMAND_TIMEOUT_MS,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 1500);
		const started = Date.now();

		await expect(pending).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(6_000);
		expect(readFileSync(join(site, "AGENTS.md"), "utf8")).toBe("original\n");
		expect(readdirSync(tmp)).toEqual([]);
	});

	it("restores protected files when the model's command runs past its deadline", async () => {
		const { runtime } = await running();
		const site = mkdtempSync(join(root, "site-"));
		writeFileSync(join(site, "AGENTS.md"), "original\n");

		const result = await runtime.exec(modelCommand("echo tampered > AGENTS.md; sleep 30"), {
			cwd: site,
			timeout: 3000,
		});

		expect(result.exitCode).toBe(124);
		expect(result.stderr).toContain("restored protected file AGENTS.md");
		expect(readFileSync(join(site, "AGENTS.md"), "utf8")).toBe("original\n");
	});

	it("stops a model command that ignores TERM, and still restores files and reports output", async () => {
		const { runtime } = await running();
		const site = mkdtempSync(join(root, "site-"));
		writeFileSync(join(site, "AGENTS.md"), "original\n");
		const tmp = mkdtempSync(join(root, "tmp-"));
		const command = modelCommand("trap '' TERM; echo partial; echo tampered > AGENTS.md; sleep 6");
		const started = Date.now();

		const result = await runtime.exec(command, { cwd: site, env: { TMPDIR: tmp }, timeout: 3000 });

		expect(result.exitCode).toBe(124);
		expect(result.stdout).toBe("partial\n");
		expect(result.stderr).toContain("restored protected file AGENTS.md");
		expect(readFileSync(join(site, "AGENTS.md"), "utf8")).toBe("original\n");
		expect(readdirSync(tmp)).toEqual([]);
		expect(Date.now() - started).toBeLessThan(9_000);

		const controller = new AbortController();
		const stopped = runtime.exec(command, {
			cwd: site,
			env: { TMPDIR: tmp },
			timeout: MODEL_COMMAND_TIMEOUT_MS,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 500);
		await expect(stopped).rejects.toThrow();
		expect(readFileSync(join(site, "AGENTS.md"), "utf8")).toBe("original\n");
		expect(readdirSync(tmp)).toEqual([]);
	});

	it("returns from the model's command when it leaves a process running", async () => {
		const { runtime } = await running();
		const site = mkdtempSync(join(root, "site-"));
		const started = Date.now();

		const result = await runtime.exec(modelCommand("sleep 21.7 &"), {
			cwd: site,
			timeout: MODEL_COMMAND_TIMEOUT_MS,
		});

		expect(result.exitCode).toBe(0);
		expect(Date.now() - started).toBeLessThan(5_000);
		await runtime.exec("pkill -f 'sleep 21.7' || true");
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
