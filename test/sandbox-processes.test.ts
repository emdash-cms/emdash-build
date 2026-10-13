import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	FOLLOW_PROCESS,
	PROCESS_STATUS,
	RUN_PROCESS,
	STOP_PROCESS,
	parseProcessState,
	processDir,
	processLogEvents,
} from "../src/worker/sandbox-processes.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "emdash-processes-"));
	// macOS has no util-linux setsid; perl's setsid() gives the same new session.
	const bin = join(root, "bin");
	spawnSync("mkdir", [bin]);
	const shim = join(bin, "setsid");
	writeFileSync(
		shim,
		'#!/bin/sh\n[ "$1" = "-w" ] && shift\nexec perl -e \'use POSIX qw(setsid); setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"\' "$@"\n',
	);
	chmodSync(shim, 0o755);
	env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const script = (body: string, ...args: string[]) =>
	spawnSync("bash", ["-c", body, "script", ...args], { env, encoding: "utf8", timeout: 20_000 });

/** Start a process the way the runtime does: the runner is not awaited. */
function run(dir: string, command: string) {
	const runner = spawn("bash", ["-c", RUN_PROCESS, "run", dir, "bash", "-c", command], {
		env,
		stdio: "ignore",
	});
	return new Promise<number | null>((resolve) => runner.on("exit", resolve));
}

async function until(check: () => boolean, ms = 20_000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("container process scripts", { timeout: 30_000 }, () => {
	it("records output and the exit code, and reuses an id only once its process exits", async () => {
		const dir = join(root, "exits");
		await run(dir, "echo one; echo two >&2; exit 3");

		expect(readFileSync(join(dir, "output.log"), "utf8")).toBe("one\ntwo\n");
		expect(script(PROCESS_STATUS, dir).stdout.trim()).toBe("exited 3");

		await run(dir, "echo again");
		expect(readFileSync(join(dir, "output.log"), "utf8")).toBe("again\n");

		const busy = join(root, "busy");
		const first = run(busy, "sleep 30");
		await until(() => script(PROCESS_STATUS, busy).stdout.startsWith("running "));
		await expect(run(busy, "echo second")).resolves.toBe(97);
		script(STOP_PROCESS, busy, "1");
		await first;
	});

	it("stops the whole process group, children included", async () => {
		const dir = join(root, "group");
		const childFile = `${dir}.child`;
		const exited = run(dir, `sleep 30 & echo $! > ${childFile}; wait`);
		await until(() => script(PROCESS_STATUS, dir).stdout.startsWith("running "));
		await until(() => existsSync(childFile) && readFileSync(childFile, "utf8").trim() !== "");
		const pid = Number(script(PROCESS_STATUS, dir).stdout.split(" ")[1]);
		const child = Number(readFileSync(childFile, "utf8"));

		expect(script(STOP_PROCESS, dir, "2").status).toBe(0);
		await exited;

		expect(script(PROCESS_STATUS, dir).stdout.trim()).toBe("exited 143");
		expect(spawnSync("kill", ["-0", String(pid)]).status).not.toBe(0);
		expect(spawnSync("kill", ["-0", String(child)]).status).not.toBe(0);
		// Stopping again, or a process that never started, succeeds.
		expect(script(STOP_PROCESS, dir).status).toBe(0);
		expect(script(STOP_PROCESS, join(root, "never")).status).toBe(0);
		expect(script(PROCESS_STATUS, join(root, "never")).stdout.trim()).toBe("missing");
	});

	it("stops a process that has not recorded its pid yet", async () => {
		const dir = join(root, "early");
		// A setsid that takes a while to start the process.
		const slowBin = join(root, "slow-bin");
		spawnSync("mkdir", ["-p", slowBin]);
		writeFileSync(
			join(slowBin, "setsid"),
			'#!/bin/sh\nsleep 0.5\n[ "$1" = "-w" ] && shift\nexec perl -e \'use POSIX qw(setsid); setsid() or die; exec @ARGV or die\' "$@"\n',
		);
		chmodSync(join(slowBin, "setsid"), 0o755);
		const slowEnv = { ...env, PATH: `${slowBin}:${env.PATH}` };
		const runner = spawn("bash", ["-c", RUN_PROCESS, "run", dir, "bash", "-c", "sleep 5; exit 7"], {
			env: slowEnv,
			stdio: "ignore",
		});
		const exited = new Promise((resolve) => runner.on("exit", resolve));
		await until(() => existsSync(join(dir, "runner")));
		expect(script(PROCESS_STATUS, dir).stdout.trim()).toBe("starting");

		expect(script(STOP_PROCESS, dir, "2").status).toBe(0);
		await exited;
		expect(script(PROCESS_STATUS, dir).stdout.trim()).toBe("exited 143");
	});

	it("kills group members that outlive a leader stopped first", async () => {
		const dir = join(root, "stubborn");
		const childFile = `${dir}.child`;
		const exited = run(dir, `sh -c 'trap "" TERM; exec sleep 30' & echo $! > ${childFile}; wait`);
		await until(() => existsSync(childFile) && readFileSync(childFile, "utf8").trim() !== "");
		await until(() => script(PROCESS_STATUS, dir).stdout.startsWith("running "));
		const child = Number(readFileSync(childFile, "utf8"));

		expect(script(STOP_PROCESS, dir, "1").status).toBe(0);
		await exited;
		await until(() => spawnSync("kill", ["-0", String(child)]).status !== 0, 5_000);
	});

	it("stops following, and reports the process lost, when its runner is killed with it", async () => {
		const dir = join(root, "lost");
		const runner = spawn("bash", ["-c", RUN_PROCESS, "run", dir, "bash", "-c", "sleep 30"], {
			env,
			stdio: "ignore",
		});
		await until(() => script(PROCESS_STATUS, dir).stdout.startsWith("running "));
		const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
		process.kill(-pid, "SIGKILL");
		runner.kill("SIGKILL");
		await new Promise((resolve) => runner.on("exit", resolve));

		const follow = spawnSync("bash", ["-c", FOLLOW_PROCESS, "follow", dir], {
			env,
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(follow.status).toBe(0);
		expect(script(PROCESS_STATUS, dir).stdout.trim()).toBe("exited 137");
	});

	it("follows output from the start until the process exits", async () => {
		const dir = join(root, "follow");
		const exited = run(dir, "echo a; sleep 0.6; printf 'b\\nc'; exit 0");
		await until(() => script(PROCESS_STATUS, dir).stdout.trim() !== "missing");

		const follow = spawnSync("bash", ["-c", FOLLOW_PROCESS, "follow", dir], {
			env,
			encoding: "utf8",
			timeout: 10_000,
		});
		await exited;

		expect(follow.status).toBe(0);
		expect(follow.stdout).toBe("a\nb\nc");
	});

	it("names process directories only from safe ids", () => {
		expect(processDir("dev-1a2b3c4d")).toBe("/tmp/emdash-build/processes/dev-1a2b3c4d");
		expect(() => processDir("../escape")).toThrow();
		expect(() => processDir("Dev")).toThrow();
	});
});

describe("process log events", () => {
	it("emits one stdout event per line, then the exit code", async () => {
		const encoder = new TextEncoder();
		const bytes = encoder.encode("first\nsé");
		const output = new ReadableStream<Uint8Array>({
			start(controller) {
				// A character split across chunks still decodes whole.
				controller.enqueue(bytes.slice(0, bytes.length - 1));
				controller.enqueue(bytes.slice(bytes.length - 1));
				controller.enqueue(encoder.encode("cond\nlast"));
				controller.close();
			},
		});

		const text = await new Response(processLogEvents(output, async () => 2)).text();

		expect(text.trim().split("\n\n")).toEqual([
			'data: {"type":"stdout","data":"first\\n"}',
			'data: {"type":"stdout","data":"sécond\\n"}',
			'data: {"type":"stdout","data":"last"}',
			'data: {"type":"complete","exitCode":2}',
		]);
	});

	it("parses process states", () => {
		expect(parseProcessState("running 41\n")).toEqual({ state: "running", pid: 41 });
		expect(parseProcessState("exited 0")).toEqual({ state: "exited", exitCode: 0 });
		expect(parseProcessState("starting")).toEqual({ state: "starting" });
		expect(parseProcessState("")).toEqual({ state: "missing" });
	});
});
