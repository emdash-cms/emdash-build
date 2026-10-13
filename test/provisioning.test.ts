import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparedDependenciesCommand } from "../src/worker/provisioning.js";

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

describe("prepared dependencies on restore", () => {
	let root: string;
	let archive: string;
	let preparedLockfile: string;
	let site: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "emdash-prepared-"));
		const template = join(root, "template");
		write(join(template, "package.json"), '{"name":"scaffold"}');
		write(join(template, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
		write(join(template, "node_modules/astro/package.json"), '{"name":"astro"}');
		archive = join(root, "builder.tgz");
		execFileSync("tar", ["-C", template, "-czf", archive, "."]);
		preparedLockfile = join(template, "pnpm-lock.yaml");
		// GNU timeout is in the container but not on every test host.
		write(
			join(root, "bin/timeout"),
			'#!/bin/bash\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"\n',
		);
		execFileSync("chmod", ["+x", join(root, "bin/timeout")]);
		site = join(root, "site");
		write(join(site, "package.json"), '{"name":"restored"}');
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const run = (lockfile: string | undefined = preparedLockfile) =>
		spawnSync("bash", ["-c", preparedDependenciesCommand(archive, site, lockfile)], {
			env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
		});

	it("reuses the image's installed dependencies when the lockfile is unchanged", () => {
		write(join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");

		expect(run().status).toBe(0);
		expect(readFileSync(join(site, "node_modules/astro/package.json"), "utf8")).toContain("astro");
		// Only dependencies come from the image; the restored source stays.
		expect(readFileSync(join(site, "package.json"), "utf8")).toContain("restored");
	});

	it("leaves an edited dependency set to pnpm install", () => {
		write(join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: { extra: {} }\n");

		expect(run().status).toBe(1);
		expect(existsSync(join(site, "node_modules"))).toBe(false);
	});

	it("leaves dependencies declared outside the lockfile to pnpm install", () => {
		write(join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
		// The model added a dependency without pnpm, so the lockfile still matches.
		write(join(site, "package.json"), '{"name":"restored","dependencies":{"sharp":"^0.34.0"}}');

		expect(run().status).toBe(1);
		expect(run(undefined).status).toBe(1);
		expect(existsSync(join(site, "node_modules"))).toBe(false);
	});

	it("reuses dependencies when only other package.json fields changed", () => {
		write(join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
		write(join(site, "package.json"), '{"name":"restored","scripts":{"check":"astro check"}}');

		expect(run().status).toBe(0);
	});

	it("reads the lockfile beside the archive rather than decompressing it twice", () => {
		// Only the uncompressed copy says the lockfiles match.
		write(preparedLockfile, "lockfileVersion: '9.0'\npackages: { beside: {} }\n");
		write(join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: { beside: {} }\n");

		expect(run().status).toBe(0);
		expect(preparedDependenciesCommand(archive, site, preparedLockfile)).toContain("timeout ");
	});

	it("compares against the lockfile in the archive when the image has none beside it", () => {
		write(join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
		rmSync(preparedLockfile);

		expect(run().status).toBe(0);
		expect(existsSync(join(site, "node_modules/astro/package.json"))).toBe(true);
	});

	it("reports a missing archive without touching the site", () => {
		write(join(site, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
		rmSync(archive);

		expect(run().status).not.toBe(0);
		expect(existsSync(join(site, "node_modules"))).toBe(false);
	});
});
