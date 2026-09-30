import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	canReuseFinalSnapshotForTurn,
	canSkipFinalSnapshot,
	publishStagingCommand,
	snapshotCommitCommand,
	snapshotPushCommand,
	snapshotStagingCommand,
} from "../src/worker/session-snapshot.js";

function sh(command: string): string {
	return execFileSync("bash", ["-c", command], { encoding: "utf8" });
}

function write(path: string, content = "x"): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

describe("session snapshot staging", () => {
	it("only skips a final copy when the last saved generation is still current", () => {
		expect(canSkipFinalSnapshot(4, 4, false)).toBe(true);
		expect(canSkipFinalSnapshot(4, 5, false)).toBe(false);
		expect(canSkipFinalSnapshot(undefined, 4, false)).toBe(false);
		expect(canSkipFinalSnapshot(4, undefined, false)).toBe(false);
		expect(canSkipFinalSnapshot(4, 4, true)).toBe(false);
	});

	it("does not reuse a snapshot after shell work, failures or recovery", () => {
		const safe = { kind: "follow-up", resumed: false, tools: {} };
		expect(canReuseFinalSnapshotForTurn(safe)).toBe(true);
		expect(canReuseFinalSnapshotForTurn({ ...safe, kind: "initial-build" })).toBe(false);
		expect(canReuseFinalSnapshotForTurn({ ...safe, resumed: true })).toBe(false);
		expect(
			canReuseFinalSnapshotForTurn({ ...safe, tools: { exec: { calls: 1, failures: 0 } } }),
		).toBe(false);
		expect(
			canReuseFinalSnapshotForTurn({ ...safe, tools: { write_file: { calls: 1, failures: 1 } } }),
		).toBe(false);
	});
	let root: string;
	let site: string;
	let snapshot: string;
	let publish: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "emdash-snapshot-"));
		site = join(root, "site");
		snapshot = join(root, "snapshot");
		publish = join(root, "publish");
		write(join(site, ".gitignore"), "node_modules\ndist\n.astro\n");
		write(join(site, "src/pages/index.astro"), "home");
		const database = join(site, ".wrangler/state/d1/db.sqlite");
		mkdirSync(dirname(database), { recursive: true });
		sh(`sqlite3 '${database}' 'CREATE TABLE content (id INTEGER)'`);
		write(join(site, ".wrangler/state/v3/r2/media/photo"), "photo");
		write(join(site, ".wrangler/state/v3/observability/trace.sqlite"), "trace");
		write(join(site, "node_modules/.pnpm/pkg/index.js"), "dependency");
		write(join(site, "node_modules/.pnpm/pkg/cache.sqlite"), "not a database");
		write(join(site, "node_modules/.astro/cache"), "volatile");
		write(join(site, "node_modules/.vite/cache"), "volatile");
		write(join(site, "dist/index.html"), "built");
		write(join(site, ".astro/types.d.ts"), "generated");
		write(join(site, ".git/HEAD"), "ref: refs/heads/main\n");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("stages persisted site state without dependencies or build output", () => {
		write(join(snapshot, "stale.txt"), "left from the previous checkpoint");

		sh(snapshotStagingCommand(site, snapshot));

		expect(existsSync(join(snapshot, "src/pages/index.astro"))).toBe(true);
		expect(existsSync(join(snapshot, ".wrangler/state/d1/db.sqlite"))).toBe(true);
		expect(existsSync(join(snapshot, ".wrangler/state/v3/r2/media/photo"))).toBe(true);
		expect(existsSync(join(snapshot, ".wrangler/state/v3/observability/trace.sqlite"))).toBe(false);
		expect(existsSync(join(snapshot, ".gitignore"))).toBe(true);
		expect(existsSync(join(snapshot, "stale.txt"))).toBe(false);
		for (const skipped of ["node_modules", "dist", ".astro", ".git"]) {
			expect(existsSync(join(snapshot, skipped))).toBe(false);
		}
	});

	it("backs up committed SQLite WAL data without copying live sidecar files", async () => {
		const database = join(site, ".wrangler/state/v3/d1/content.sqlite");
		mkdirSync(dirname(database), { recursive: true });
		const sqlite = spawn("sqlite3", [database], { stdio: ["pipe", "ignore", "inherit"] });
		sqlite.stdin.write(
			"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE pages (title TEXT); INSERT INTO pages VALUES ('Home');\n",
		);
		await expect.poll(() => existsSync(`${database}-wal`), { timeout: 2_000 }).toBe(true);

		try {
			sh(snapshotStagingCommand(site, snapshot));
			expect(existsSync(join(snapshot, ".wrangler/state/v3/d1/content.sqlite-wal"))).toBe(false);
			expect(existsSync(join(snapshot, ".wrangler/state/v3/d1/content.sqlite-shm"))).toBe(false);
			expect(
				sh(
					`sqlite3 '${join(snapshot, ".wrangler/state/v3/d1/content.sqlite")}' 'SELECT title FROM pages'`,
				).trim(),
			).toBe("Home");
		} finally {
			sqlite.stdin.end();
			sqlite.kill();
		}
	});

	it("fails when the site cannot be staged", () => {
		expect(() => sh(snapshotStagingCommand(join(root, "missing"), snapshot))).toThrow();
	});

	it("stages an isolated publish workspace without sharing installed dependencies", () => {
		sh(snapshotStagingCommand(site, snapshot));
		sh(publishStagingCommand(snapshot, site, publish));

		expect(existsSync(join(publish, "src/pages/index.astro"))).toBe(true);
		expect(existsSync(join(publish, ".wrangler/state/d1/db.sqlite"))).toBe(true);
		expect(existsSync(join(publish, "dist"))).toBe(false);
		expect(lstatSync(join(publish, "node_modules")).isSymbolicLink()).toBe(false);
		expect(existsSync(join(publish, "node_modules/.astro"))).toBe(false);
		expect(existsSync(join(publish, "node_modules/.vite"))).toBe(false);
		write(join(publish, "node_modules/.pnpm/pkg/index.js"), "publish dependency");
		expect(readFileSync(join(site, "node_modules/.pnpm/pkg/index.js"), "utf8")).toBe("dependency");
		expect(publishStagingCommand(snapshot, site, publish)).toContain("available_kib=$(df -Pk");
	});
});

// Real git, tar and sqlite3 round trips; slower than a unit test on a busy host.
describe("incremental session snapshots", { timeout: 30_000 }, () => {
	let root: string;
	let site: string;
	let snapshot: string;
	let gitDir: string;
	let remote: string;

	const identity = { name: "EmDash Build", email: "agent@emdash.build" };
	// GNU timeout is in the container but not on every test host.
	const run = (command: string) =>
		execFileSync("bash", ["-c", command], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
		});
	const looseObjects = () =>
		Number(sh(`find '${remote}/objects' -type f -path '*/[0-9a-f][0-9a-f]/*' | wc -l`).trim());
	const snapshotOnce = (message: string) => {
		run(snapshotStagingCommand(site, snapshot));
		const commit = run(
			snapshotCommitCommand({ snapshotPath: snapshot, gitDir, message, ...identity }),
		).trim();
		const pushed = run(
			snapshotPushCommand({ gitDir, remote: `file://${remote}`, timeoutSeconds: 30 }),
		).trim();
		expect(pushed).toBe(commit);
		return commit;
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "emdash-incremental-"));
		site = join(root, "site");
		snapshot = join(root, "snapshot");
		gitDir = join(root, "snapshot-git");
		remote = join(root, "remote.git");
		for (let index = 0; index < 30; index++) {
			write(join(site, `src/pages/page-${index}.astro`), `page ${index}`);
		}
		write(join(site, ".wrangler/state/v3/r2/media/photo"), "photo bytes");
		sh(`git init -q --bare '${remote}'`);
		write(
			join(root, "bin/timeout"),
			'#!/bin/bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
		);
		sh(`chmod +x '${join(root, "bin/timeout")}'`);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps one commit on the remote while pushing only what changed", () => {
		const first = snapshotOnce("first");
		const afterFirst = looseObjects();
		write(join(site, "src/pages/page-7.astro"), "page 7, edited");
		const second = snapshotOnce("second");
		const added = looseObjects() - afterFirst;

		expect(afterFirst).toBeGreaterThan(30);
		// One blob, the trees on its path, and the commit.
		expect(added).toBeLessThanOrEqual(6);
		expect(second).not.toBe(first);
		expect(sh(`git -C '${remote}' rev-parse main`).trim()).toBe(second);
		// Restores and clones still see a single snapshot commit.
		expect(sh(`git -C '${remote}' rev-list --count main`).trim()).toBe("1");
		expect(sh(`git -C '${remote}' show main:src/pages/page-7.astro`)).toBe("page 7, edited");
		expect(sh(`git -C '${remote}' show main:.wrangler/state/v3/r2/media/photo`)).toBe(
			"photo bytes",
		);
	});

	it("leaves the shell session's environment as it found it", () => {
		run(snapshotStagingCommand(site, snapshot));
		// The sandbox's default session keeps exported variables for later commands,
		// including the model's own shell commands and the restore clone.
		const leaked = run(
			`${snapshotCommitCommand({ snapshotPath: snapshot, gitDir, message: "m", ...identity })} >/dev/null; ` +
				`${snapshotPushCommand({ gitDir, remote: `file://${remote}`, timeoutSeconds: 30 })} >/dev/null; ` +
				'echo "[${GIT_DIR:-}][${GIT_WORK_TREE:-}][$(pwd)]"',
		).trim();

		expect(leaked).toBe(`[][][${process.cwd()}]`);
	});

	it("uploads even when the next checkpoint is rebuilding the staging copy", () => {
		run(snapshotStagingCommand(site, snapshot));
		const commit = run(
			snapshotCommitCommand({ snapshotPath: snapshot, gitDir, message: "m", ...identity }),
		).trim();
		rmSync(snapshot, { recursive: true, force: true });

		const pushed = run(
			snapshotPushCommand({ gitDir, remote: `file://${remote}`, timeoutSeconds: 30 }),
		).trim();

		expect(pushed).toBe(commit);
		expect(sh(`git -C '${remote}' rev-parse main`).trim()).toBe(commit);
		expect(sh(`git --git-dir='${gitDir}' rev-parse refs/heads/pushed`).trim()).toBe(commit);
	});

	it("recovers from lock files a killed commit left behind", () => {
		snapshotOnce("first");
		write(join(gitDir, "index.lock"), "");
		write(join(gitDir, "refs/heads/snapshot.lock"), "");
		write(join(site, "src/pages/page-1.astro"), "page 1, edited");

		snapshotOnce("after a killed commit");

		expect(sh(`git -C '${remote}' show main:src/pages/page-1.astro`)).toBe("page 1, edited");
	});

	it("applies the site's .gitignore afresh to every snapshot", () => {
		write(join(site, ".dev.vars"), "SECRET=1");
		snapshotOnce("before the ignore rule");
		write(join(site, ".gitignore"), ".dev.vars\n");

		snapshotOnce("after the ignore rule");

		expect(sh(`git -C '${remote}' ls-tree -r --name-only main`)).not.toContain(".dev.vars");
	});

	it("records deletions and survives a lost git directory", () => {
		snapshotOnce("first");
		rmSync(join(site, "src/pages/page-3.astro"));
		rmSync(gitDir, { recursive: true, force: true });

		snapshotOnce("after restart");

		expect(sh(`git -C '${remote}' ls-tree -r --name-only main`)).not.toContain("page-3.astro");
		expect(sh(`git -C '${remote}' rev-list --count main`).trim()).toBe("1");
	});
});
