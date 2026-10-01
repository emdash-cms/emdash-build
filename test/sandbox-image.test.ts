import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
	dependencies: Record<string, string>;
};

/** Every `COPY --from=<image>:<tag> <source> <target>` line, keyed by source path. */
function copiesFromImages(): Map<string, { image: string; tag: string; target: string }> {
	const copies = new Map<string, { image: string; tag: string; target: string }>();
	for (const match of dockerfile.matchAll(/^COPY --from=([^:\s]+):(\S+) (\S+) (\S+)$/gm)) {
		copies.set(match[3]!, { image: match[1]!, tag: match[2]!, target: match[4]! });
	}
	return copies;
}

describe("sandbox image", () => {
	it("ships the file helper and cloudflared that SDK 1.0 needs, and no 0.12 server", () => {
		const copies = copiesFromImages();
		// Files, DirectoryBackup and S3Mount run this helper, which must match the package.
		expect(copies.get("/usr/local/bin/sandbox-shim")).toEqual({
			image: "docker.io/cloudflare/sandbox",
			tag: pkg.dependencies["@cloudflare/sandbox"],
			target: "/usr/local/bin/sandbox-shim",
		});
		expect(copies.get("/usr/local/bin/cloudflared")).toMatchObject({
			image: "docker.io/cloudflare/cloudflared",
			target: "/usr/local/bin/cloudflared",
		});
		expect(copies.has("/container-server/sandbox")).toBe(false);
	});

	it("keeps the container up under an init that reaps background processes", () => {
		// The Durable Object runs every command itself; the main process only has to live.
		expect(dockerfile).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m);
		expect(dockerfile).toMatch(/^CMD \["sleep", "infinity"\]$/m);
		expect(dockerfile).toMatch(/^\s+tini \\$/m);
		expect(dockerfile).not.toMatch(/^EXPOSE /m);
	});

	it("pins the sandbox user to the uid that exec and Files run as", () => {
		const users = [...dockerfile.matchAll(/useradd (.+)$/gm)].map((match) => match[1]);
		expect(users.length).toBeGreaterThan(0);
		for (const user of users) expect(user).toBe("-m -u 1001 -s /bin/bash user");
	});
});
