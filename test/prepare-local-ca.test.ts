import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareLocalCa } from "../scripts/prepare-local-ca.mjs";

describe("local Sandbox CA preparation", () => {
	it("copies an explicitly configured host trust bundle", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-local-ca-"));
		const source = join(root, "source.pem");
		const targetDirectory = join(root, "target");
		await writeFile(source, "test certificate");

		const result = await prepareLocalCa({ source, targetDirectory });

		expect(result.copied).toBe(true);
		await expect(readFile(join(targetDirectory, "host-ca.pem"), "utf8")).resolves.toBe(
			"test certificate",
		);
	});

	it("does not leave a stale bundle when no source is configured", async () => {
		const root = await mkdtemp(join(tmpdir(), "emdash-local-ca-"));
		const targetDirectory = join(root, "target");
		await mkdir(targetDirectory, { recursive: true });
		await writeFile(join(targetDirectory, "host-ca.pem"), "stale certificate");

		const result = await prepareLocalCa({ source: null, targetDirectory });

		expect(result.copied).toBe(false);
		await expect(readFile(join(targetDirectory, "host-ca.pem"), "utf8")).rejects.toThrow();
	});
});
