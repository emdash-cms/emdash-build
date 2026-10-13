import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";
import { NOT_RUNNING } from "../src/worker/sandbox-ops.js";
import { CANONICAL_WRANGLER_JSONC } from "../src/worker/tools.js";

const PROJECT_ID = "88888888-8888-4888-8888-888888888888";
const SITE = "/home/user/site";
const STAGED = "/tmp/emdash-build-deploy";
const ASTRO = `import { d1, r2 } from "@emdash-cms/cloudflare";
export default defineConfig({
	integrations: [
		emdash({
			database: d1({ binding: "DB" }),
			storage: r2({ binding: "MEDIA" }),
		}),
	],
});
`;
const DEPLOY_OUTPUT = [
	"Uploaded emdash-site",
	"Deployed emdash-site triggers",
	"  https://emdash-site.tmp-account.workers.dev",
	"Claim this account within 60 minutes: https://dash.cloudflare.com/claim?token=abc123",
].join("\n");
const WRANGLER_ENV =
	"CLOUDFLARE_API_TOKEN= CLOUDFLARE_API_KEY= CLOUDFLARE_EMAIL= CI=1 " +
	"HOME=/tmp/emdash-build-deploy-home npm_config_cache=/home/user/.npm ";

const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

type DeployResult = { success: boolean; liveUrl?: string; claimUrl?: string; error?: string };

interface DeployHarness {
	sandboxOps: () => unknown;
	execRecoveryCommand: (command: string, timeout: number) => Promise<{ success: boolean }>;
	recoverSite: (hostname: string) => Promise<{ ready: boolean; error?: string }>;
	backupSite: () => Promise<string | undefined>;
	stopDevServer: () => Promise<void>;
	startDevServer: () => Promise<void>;
	registerProjectForCurrentOwner: () => Promise<void>;
	beginOwnerActivity: (id: string, kind: string) => void;
	finishOwnerActivity: (id: string) => void;
	liveOwnerWork: Set<string>;
	deploySite(): Promise<DeployResult>;
	runChatTurn(onFinish: () => Promise<void>, options?: unknown): Promise<Response>;
}

function emptyLogStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.close();
		},
	});
}

function step(command: string): string | undefined {
	if (command.includes("checkpoint_kib")) return "stage";
	if (command.includes("sqlite3")) return "scrub";
	if (command.includes("d1 export")) return "export";
	if (command.includes("deploy --temporary")) return "deploy";
	if (command.includes("d1 execute")) return "load";
	if (command.startsWith("rm -rf") && command.includes(STAGED)) return "cleanup";
	return undefined;
}

function deploySandbox(
	options: {
		build?: () => Promise<{ exitCode: number }>;
		fail?: string;
		unreadable?: boolean;
		onBuild?: () => void;
	} = {},
) {
	const events: string[] = [];
	const files = new Map<string, string>([
		[`${STAGED}/astro.config.mjs`, ASTRO],
		[`${STAGED}/wrangler.jsonc`, CANONICAL_WRANGLER_JSONC],
	]);
	const commands: string[] = [];
	const started: Array<{ id: string; command: string; cwd?: string }> = [];
	const sandbox = {
		// Sandbox SDK 1.0 throws for a file it cannot read.
		readFile: async (path: string) => {
			if (options.unreadable || !files.has(path)) throw new Error(`File not found: ${path}`);
			return { success: true, content: files.get(path)! };
		},
		writeFile: async (path: string, content: string) => {
			events.push(`write:${path}`);
			files.set(path, content);
			return { success: true };
		},
		exec: vi.fn(async (command: string) => {
			commands.push(command);
			const name = step(command);
			if (name) events.push(name);
			const failed = name !== undefined && name === options.fail;
			const stdout = name === "deploy" ? DEPLOY_OUTPUT : "";
			return { success: !failed, exitCode: failed ? 1 : 0, stdout, stderr: "" };
		}),
		startProcess: async (id: string, command: string, opts?: { cwd?: string }) => {
			started.push({ id, command, cwd: opts?.cwd });
			events.push("build");
			options.onBuild?.();
		},
		followProcessLogs: async () => emptyLogStream(),
		waitForProcessExit: async () => (options.build ? options.build() : { exitCode: 0 }),
		stopProcess: async (id: string) => {
			events.push(`stop:${id}`);
		},
	};
	return { sandbox, files, commands, started, events };
}

async function withDeployHarness(
	run: (harness: DeployHarness, instance: BuilderAgent) => Promise<void>,
) {
	const agent = testEnv.BuilderAgent.getByName(PROJECT_ID);
	await runInDurableObject(agent, async (instance) => {
		instance.setState({ ...instance.state, siteReady: true });
		const harness = instance as unknown as DeployHarness;
		harness.execRecoveryCommand = async () => ({ success: true });
		harness.backupSite = async () => undefined;
		harness.stopDevServer = async () => {
			throw new Error("A deploy must not stop the preview.");
		};
		harness.startDevServer = async () => {
			throw new Error("A deploy must not restart the preview.");
		};
		await run(harness, instance);
	});
}

describe("temporary-account deploy", () => {
	beforeEach(async () => {
		await reset();
	});

	it("deploys a staged copy without R2 and with scrubbed content, leaving the preview alone", async () => {
		await withDeployHarness(async (harness, instance) => {
			let ownerWorkDuringBuild = 0;
			const runtime = deploySandbox({
				onBuild: () => {
					ownerWorkDuringBuild = harness.liveOwnerWork.size;
				},
			});
			harness.sandboxOps = () => runtime.sandbox;
			const backupSite = vi.fn(async () => {
				runtime.events.push("backup");
				return undefined;
			});
			harness.backupSite = backupSite;

			const result = await harness.deploySite();

			expect(result).toEqual({
				success: true,
				liveUrl: "https://emdash-site.tmp-account.workers.dev",
				claimUrl: "https://dash.cloudflare.com/claim?token=abc123",
			});
			expect(instance.state.deploy).toMatchObject({
				liveUrl: "https://emdash-site.tmp-account.workers.dev",
				claimUrl: "https://dash.cloudflare.com/claim?token=abc123",
			});
			expect(runtime.events).toEqual([
				"backup",
				"stage",
				`write:${STAGED}/astro.config.mjs`,
				`write:${STAGED}/wrangler.jsonc`,
				"scrub",
				"export",
				"build",
				"deploy",
				"load",
				"cleanup",
			]);
			expect(runtime.files.get(`${STAGED}/astro.config.mjs`)).not.toContain("storage:");
			expect(JSON.parse(runtime.files.get(`${STAGED}/wrangler.jsonc`)!)).not.toHaveProperty(
				"r2_buckets",
			);
			expect(runtime.started).toEqual([
				expect.objectContaining({
					command: "EMDASH_DEPLOY_MODE=temporary pnpm build",
					cwd: STAGED,
				}),
			]);
			expect(ownerWorkDuringBuild).toBe(1);
			expect(harness.liveOwnerWork.size).toBe(0);
			for (const name of ["export", "deploy", "load"]) {
				const command = runtime.commands.find((candidate) => step(candidate) === name)!;
				expect(command.startsWith(WRANGLER_ENV), name).toBe(true);
			}
			expect(runtime.commands.find((command) => step(command) === "cleanup")).toContain(
				"/tmp/emdash-build-deploy-home",
			);
			// The copy builds without the preview's .dev.vars and exports real content.
			expect(runtime.commands.find((command) => step(command) === "stage")).toContain(
				"rm -f /tmp/emdash-build-deploy/.dev.vars",
			);
			expect(runtime.commands.find((command) => step(command) === "export")).toContain(
				"_emdash_migrations",
			);
			expect(instance.state.status).toBe("");
		});
	});

	it("refuses while other site work, such as publishing, runs", async () => {
		await withDeployHarness(async (harness) => {
			const runtime = deploySandbox();
			harness.sandboxOps = () => runtime.sandbox;
			harness.beginOwnerActivity("publish:run", "publish");

			const result = await harness.deploySite();

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/Wait for the current site activity to finish/);
			expect(runtime.commands).toEqual([]);
			harness.finishOwnerActivity("publish:run");
		});
	});

	it("holds chat turns until a deploy finishes", async () => {
		await withDeployHarness(async (harness) => {
			harness.registerProjectForCurrentOwner = async () => undefined;
			harness.beginOwnerActivity("deploy:run", "deploy");

			const response = await harness.runChatTurn(async () => {}, {});

			expect(await response.text()).toContain("A deploy is in progress.");
			harness.finishOwnerActivity("deploy:run");
		});
	});

	it("restores a stopped site before staging it", async () => {
		await withDeployHarness(async (harness) => {
			const runtime = deploySandbox();
			const recoverSite = vi.fn(async () => ({ ready: true }));
			let probes = 0;
			harness.execRecoveryCommand = async () => {
				probes++;
				if (probes === 1) throw new Error(NOT_RUNNING);
				return { success: true };
			};
			harness.recoverSite = recoverSite;
			harness.sandboxOps = () => runtime.sandbox;

			const result = await harness.deploySite();

			expect(recoverSite).toHaveBeenCalledTimes(1);
			expect(probes).toBe(2);
			expect(result.success).toBe(true);
		});
	});

	it("fails without staging when the site cannot be restored", async () => {
		await withDeployHarness(async (harness) => {
			const runtime = deploySandbox();
			harness.execRecoveryCommand = async () => {
				throw new Error(NOT_RUNNING);
			};
			harness.recoverSite = async () => ({ ready: false, error: "No saved snapshot." });
			harness.sandboxOps = () => runtime.sandbox;

			const result = await harness.deploySite();

			expect(result).toEqual({ success: false, error: "No saved snapshot." });
			expect(runtime.events).not.toContain("stage");
		});
	});

	it("fails without deploying when the site cannot be saved first", async () => {
		await withDeployHarness(async (harness) => {
			const runtime = deploySandbox();
			harness.sandboxOps = () => runtime.sandbox;
			harness.backupSite = async () => "push rejected";

			const result = await harness.deploySite();

			expect(result.success).toBe(false);
			expect(runtime.events).not.toContain("stage");
			expect(runtime.events).not.toContain("deploy");
		});
	});

	it("deploys without content when the credential scrub fails", async () => {
		await withDeployHarness(async (harness) => {
			const runtime = deploySandbox({ fail: "scrub" });
			harness.sandboxOps = () => runtime.sandbox;

			const result = await harness.deploySite();

			expect(result.success).toBe(true);
			expect(runtime.events).not.toContain("export");
			expect(runtime.events).not.toContain("load");
		});
	});

	it("returns a failed deploy's error after cleaning up", async () => {
		await withDeployHarness(async (harness) => {
			const runtime = deploySandbox({ fail: "deploy" });
			harness.sandboxOps = () => runtime.sandbox;

			const result = await harness.deploySite();

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/^Deploy failed/);
			expect(runtime.events).not.toContain("load");
			expect(runtime.events.at(-1)).toBe("cleanup");
		});
	});

	it("still reports the deploy when its content does not load", async () => {
		await withDeployHarness(async (harness) => {
			const runtime = deploySandbox({ fail: "load" });
			harness.sandboxOps = () => runtime.sandbox;

			const result = await harness.deploySite();

			expect(result).toMatchObject({ success: true });
			expect(runtime.events.at(-1)).toBe("cleanup");
		});
	});

	it("cleans up without deploying when the build fails", async () => {
		await withDeployHarness(async (harness) => {
			const runtime = deploySandbox({ build: async () => ({ exitCode: 1 }) });
			harness.sandboxOps = () => runtime.sandbox;

			const result = await harness.deploySite();

			expect(result).toEqual({ success: false, error: "Build failed with exit code 1" });
			expect(runtime.events).not.toContain("deploy");
			expect(runtime.events.at(-1)).toBe("cleanup");
		});
	});

	it("stops a build that outlives its wait before cleaning up", async () => {
		await withDeployHarness(async (harness) => {
			const runtime = deploySandbox({
				build: async () => {
					throw new Error("Process did not exit within 300000ms");
				},
			});
			harness.sandboxOps = () => runtime.sandbox;

			const result = await harness.deploySite();

			expect(result.success).toBe(false);
			const buildId = runtime.started[0]!.id;
			expect(runtime.events.slice(-3)).toEqual(["build", `stop:${buildId}`, "cleanup"]);
		});
	});

	it("returns a failure for a staged config it cannot read", async () => {
		await withDeployHarness(async (harness, instance) => {
			const runtime = deploySandbox({ unreadable: true });
			harness.sandboxOps = () => runtime.sandbox;

			const result = await harness.deploySite();

			expect(result.success).toBe(false);
			expect(runtime.events.at(-1)).toBe("cleanup");
			expect(instance.state.status).toBe("");
		});
	});
});
