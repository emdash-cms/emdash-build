import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	artifactsCloneCommand,
	artifactsGitEnv,
	redactArtifactsToken,
} from "../src/worker/artifacts-auth.js";

const run = promisify(execFile);

describe("Artifacts Git authentication", () => {
	it("configures Git HTTP auth through the command environment", () => {
		const token = "art_v2_x_example?expires=1234567890";
		expect(artifactsGitEnv(token)).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.extraHeader",
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
			GIT_TERMINAL_PROMPT: "0",
		});
	});

	it("redacts both token versions in SDK timeout and Git errors", () => {
		const message =
			"Command timed out: Authorization: Bearer art_v2_x_example?expires=1234567890; " +
			"previous art_v1_abc123?expires=1234567890";
		expect(redactArtifactsToken(message)).toBe(
			"Command timed out: Authorization: Bearer art_***; previous art_***",
		);
	});
});

describe("Artifacts clone command", () => {
	const token = "art_v2_0123abcd_example?expires=1893456000";
	const inherited = { ...process.env };
	// A Git hook exports GIT_DIR and GIT_INDEX_FILE, which would aim setup at the caller's repository.
	for (const key of Object.keys(inherited)) if (key.startsWith("GIT_")) delete inherited[key];
	const env = {
		...inherited,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		NO_PROXY: "127.0.0.1",
		no_proxy: "127.0.0.1",
		// The test server speaks plain HTTP, so Git maps the https remote onto it.
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "url.http://.insteadOf",
		GIT_CONFIG_VALUE_0: "https://",
	};
	let root: string;
	let server: Server;
	let remote: string;

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "emdash-clone-"));
		execFileSync(
			"bash",
			[
				"-c",
				[
					"set -e",
					"git init -q --bare -b main session.git",
					"git init -q -b main site",
					"echo site > site/README.md",
					"git -C site add README.md",
					"git -C site -c user.name=t -c user.email=t@t commit -q -m site",
					"git -C site push -q ../session.git main",
					"git -C session.git update-server-info",
				].join("\n"),
			],
			{ cwd: root, env },
		);

		// Artifacts accepts the read token as a bearer header or as the basic-auth password.
		const accepted = [`Bearer ${token}`, `Basic ${Buffer.from(`x:${token}`).toString("base64")}`];
		server = createServer((request, response) => {
			const path = join(root, new URL(request.url ?? "/", "http://host").pathname);
			if (!accepted.includes(request.headers.authorization ?? "")) {
				response.writeHead(401, { "WWW-Authenticate": 'Basic realm="artifacts"' }).end();
			} else if (!existsSync(path)) {
				response.writeHead(404).end();
			} else {
				response.writeHead(200).end(readFileSync(path));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		remote = `https://127.0.0.1:${port}/session.git`;
	});

	afterAll(async () => {
		if (server) await new Promise((resolve) => server.close(resolve));
		rmSync(root, { recursive: true, force: true });
	});

	for (const shell of ["bash", "zsh"]) {
		const installed = spawnSync(shell, ["-c", "true"]).status === 0;
		it.skipIf(!installed)(
			`clones when pasted into ${shell} and keeps the token out of the clone`,
			async () => {
				const cwd = mkdtempSync(join(root, `${shell}-`));
				await run(shell, ["-c", artifactsCloneCommand(remote, token, "my-site")], { cwd, env });
				expect(readFileSync(join(cwd, "my-site/README.md"), "utf8")).toBe("site\n");
				expect(readFileSync(join(cwd, "my-site/.git/config"), "utf8")).not.toContain("art_v2_");
			},
		);
	}
});
