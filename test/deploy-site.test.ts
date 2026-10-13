import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CANONICAL_WRANGLER_JSONC,
	scrubStagedContentCommand,
	stripR2FromWrangler,
	stripStorageFromAstroConfig,
} from "../src/worker/tools.js";

describe("temporary-account deploy config", () => {
	it("drops R2 storage from the scaffold's astro config and keeps the rest", () => {
		const scaffold = readFileSync("prototype/builder-cloudflare/astro.config.mjs", "utf8");
		expect(scaffold).toContain('storage: r2({ binding: "MEDIA" })');

		const stripped = stripStorageFromAstroConfig(scaffold);

		expect(stripped).not.toContain("storage:");
		expect(stripped).toContain('database: d1({ binding: "DB", session: "auto" })');
		expect(scaffold.split("\n").length - stripped.split("\n").length).toBe(1);
	});

	it("drops R2 buckets from the canonical wrangler config and keeps the rest", () => {
		const stripped = JSON.parse(stripR2FromWrangler(CANONICAL_WRANGLER_JSONC));

		expect(stripped).not.toHaveProperty("r2_buckets");
		expect(stripped.d1_databases).toEqual([{ binding: "DB", database_name: "emdash-site" }]);
		expect(stripped.main).toBe("./src/worker.ts");
	});
});

describe("staged content scrub", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function sqlite(db: string, sql: string): string {
		const result = spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	}

	function stagedDatabase(): { staged: string; db: string } {
		root = mkdtempSync(join(tmpdir(), "deploy-scrub-"));
		const staged = join(root, "staged");
		const dir = join(staged, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
		mkdirSync(dir, { recursive: true });
		const db = join(dir, "0123abcd.sqlite");
		sqlite(
			db,
			[
				"CREATE TABLE users (id TEXT PRIMARY KEY);",
				"CREATE TABLE _emdash_entry_locks (id TEXT, user_id TEXT REFERENCES users(id) ON DELETE CASCADE);",
				"CREATE TABLE _emdash_bylines (id TEXT, user_id TEXT REFERENCES users(id) ON DELETE SET NULL);",
				"CREATE TABLE sessions (id TEXT);",
				"CREATE TABLE credentials (id TEXT);",
				"CREATE TABLE _emdash_api_tokens (hash TEXT);",
				"CREATE TABLE _emdash_transfer_leases (lease_token TEXT);",
				"CREATE TABLE _plugin_storage (value TEXT);",
				"CREATE TABLE auth_tokens (token TEXT);",
				'CREATE TABLE "users ""x" (id TEXT);',
				"CREATE TABLE ec_posts (title TEXT);",
				"CREATE TABLE options (name TEXT, value TEXT);",
				"INSERT INTO users VALUES ('admin');",
				"INSERT INTO _emdash_entry_locks VALUES ('lock', 'admin');",
				"INSERT INTO _emdash_bylines VALUES ('byline', 'admin');",
				"INSERT INTO sessions VALUES ('s');",
				"INSERT INTO credentials VALUES ('passkey');",
				"INSERT INTO _emdash_api_tokens VALUES ('pat-hash');",
				"INSERT INTO _emdash_transfer_leases VALUES ('lease');",
				"INSERT INTO _plugin_storage VALUES ('secret');",
				"INSERT INTO auth_tokens VALUES ('t');",
				`INSERT INTO "users ""x" VALUES ('odd');`,
				"INSERT INTO ec_posts VALUES ('Hello');",
				"INSERT INTO options VALUES ('site:title', 'Acme'), ('emdash:setup_complete', 'true'), ('emdash:preview_secret', 's'), ('plugin:forms:key', 'k');",
			].join(" "),
		);
		return { staged, db };
	}

	function run(command: string) {
		return spawnSync("bash", ["-c", command], { encoding: "utf8" });
	}

	it("deletes credentials and non-site options and keeps content", () => {
		const { staged, db } = stagedDatabase();

		const result = run(scrubStagedContentCommand(staged));

		expect(result.status, result.stderr).toBe(0);
		for (const table of [
			"users",
			"sessions",
			"credentials",
			"_emdash_api_tokens",
			"_emdash_transfer_leases",
			"_plugin_storage",
			"auth_tokens",
			'"users ""x"',
		]) {
			expect(sqlite(db, `SELECT count(*) FROM ${table};`), table).toBe("0");
		}
		expect(sqlite(db, "SELECT title FROM ec_posts;")).toBe("Hello");
		// D1 enforces foreign keys, so nothing may point at a deleted user.
		expect(sqlite(db, "SELECT count(*) FROM _emdash_entry_locks;")).toBe("0");
		expect(sqlite(db, "SELECT id || ':' || ifnull(user_id, 'null') FROM _emdash_bylines;")).toBe(
			"byline:null",
		);
		expect(sqlite(db, "PRAGMA foreign_key_check;")).toBe("");
		expect(sqlite(db, "SELECT name FROM options;")).toBe("site:title");
	});

	it("fails when a credential cannot be deleted", () => {
		const { staged, db } = stagedDatabase();
		sqlite(
			db,
			"CREATE TRIGGER keep BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'kept'); END;",
		);

		expect(run(scrubStagedContentCommand(staged)).status).not.toBe(0);
	});

	it("fails when content still refers to a deleted user", () => {
		const { staged, db } = stagedDatabase();
		sqlite(
			db,
			"CREATE TABLE ec_notes (body TEXT, author TEXT REFERENCES users(id)); INSERT INTO ec_notes VALUES ('n', 'admin');",
		);

		expect(run(scrubStagedContentCommand(staged)).status).not.toBe(0);
	});

	it("fails when a database cannot be read", () => {
		const { staged, db } = stagedDatabase();
		writeFileSync(db, "not a database");

		expect(run(scrubStagedContentCommand(staged)).status).not.toBe(0);
	});

	it("fails when there is no database to scrub", () => {
		root = mkdtempSync(join(tmpdir(), "deploy-scrub-"));
		mkdirSync(join(root, ".wrangler/state/v3/d1"), { recursive: true });

		expect(run(scrubStagedContentCommand(root)).status).not.toBe(0);
	});
});
