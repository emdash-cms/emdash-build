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
