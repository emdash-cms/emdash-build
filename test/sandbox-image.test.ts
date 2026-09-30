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
	it("runs the Sandbox server from the same release as the installed SDK", () => {
		expect(copiesFromImages().get("/container-server/sandbox")).toEqual({
			image: "docker.io/cloudflare/sandbox",
			tag: pkg.dependencies["@cloudflare/sandbox"],
			target: "/sandbox",
		});
	});

	it("already carries what the 1.0 SDK needs, so its first deploy can reach this image", () => {
		const copies = copiesFromImages();
		// Files, DirectoryBackup and S3Mount run this helper, which must match the 1.0 package.
		expect(copies.get("/usr/local/bin/sandbox-shim")).toEqual({
			image: "docker.io/cloudflare/sandbox",
			tag: "1.0.0",
			target: "/usr/local/bin/sandbox-shim",
		});
		// The 1.0 image no longer ships cloudflared.
		expect(copies.get("/usr/local/bin/cloudflared")).toMatchObject({
			image: "docker.io/cloudflare/cloudflared",
			target: "/usr/local/bin/cloudflared",
		});
		// Background processes need an init to reap orphans once `/sandbox` is gone.
		expect(dockerfile).toMatch(/^\s+tini \\$/m);
	});

	it("pins the sandbox user to the uid that exec and Files run as", () => {
		const users = [...dockerfile.matchAll(/useradd (.+)$/gm)].map((match) => match[1]);
		expect(users.length).toBeGreaterThan(0);
		for (const user of users) expect(user).toBe("-m -u 1001 -s /bin/bash user");
	});
});
