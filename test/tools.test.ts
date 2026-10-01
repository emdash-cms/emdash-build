import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_RUNNING } from "../src/worker/sandbox-ops.js";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, simulateReadableStream, stepCountIs, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
	BuildConvergence,
	canCompleteBuild,
	prepareBuildStep,
	releaseStepPreviewImages,
} from "../src/worker/build-convergence.js";
import { capturedPreviewShotId } from "../src/worker/readiness.js";
import {
	createTools,
	ensurePreviewHmr,
	guardProtectedFiles,
	MODEL_COMMAND_TIMEOUT_MS,
	modelCommand,
	typecheckInputsFingerprintCommand,
} from "../src/worker/tools.js";

function toolCallbacks(capturePreview = vi.fn()) {
	return {
		reloadPreview: async () => {},
		checkpointSite: async () => {},
		restartDevServer: async () => ({ success: true }),
		offerClone: () => ({ success: true }),
		capturePreview,
	};
}

function validatingSandbox(
	exec: ReturnType<typeof vi.fn>,
	body = "<!doctype html><html><body><h1>Finished site</h1></body></html>",
) {
	return {
		exec,
		fetchPort: vi.fn(
			async () =>
				new Response(body, {
					status: 200,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				}),
		),
	};
}

describe("preview HMR configuration", () => {
	const config = `import { defineConfig } from "astro/config";

export default defineConfig({
	vite: {
		ssr: { optimizeDeps: { include: [] } },
	},
});`;

	it("routes the Vite client through the session preview URL", () => {
		const output = ensurePreviewHmr(config);
		expect(output).toContain("process.env.EMDASH_PREVIEW_URL");
		expect(output).toContain('protocol: emdashPreviewUrl.protocol === "https:" ? "wss" : "ws"');
		expect(output).toContain("host: emdashPreviewUrl.hostname");
		expect(output).toContain("clientPort: Number(");
	});

	it("is idempotent", () => {
		const once = ensurePreviewHmr(config);
		expect(ensurePreviewHmr(once)).toBe(once);
	});
});

describe("unchanged final checks", () => {
	it("refreshes types from the live expanded schema and checkpoints the generated file", async () => {
		const types = `export interface PageLayoutHeroV1Block { _type: "hero"; _version: 1; _key: string; }
declare module "emdash" { interface EmDashCollections { pages: { layout?: PageLayoutHeroV1Block[] } } }`;
		const sandbox = {
			fetchPort: vi.fn(
				async () =>
					new Response(types, {
						status: 200,
						headers: { "Content-Type": "text/typescript", "Content-Length": String(types.length) },
					}),
			),
			writeFile: vi.fn(async () => ({ success: true })),
			exec: vi.fn(),
		};
		const checkpointSite = vi.fn(async () => {});
		const refresh = createTools(sandbox as never, { ...toolCallbacks(), checkpointSite } as never)
			.refresh_types.execute as unknown as () => Promise<Record<string, unknown>>;

		// The declarations come back with the result, so no separate read is needed.
		await expect(refresh()).resolves.toMatchObject({
			success: true,
			generatedFile: "emdash-env.d.ts",
			declarations: types,
		});
		expect(sandbox.fetchPort).toHaveBeenCalledWith(
			4321,
			"http://localhost:4321/_emdash/api/typegen",
			{ redirect: "manual" },
		);
		expect(sandbox.writeFile).toHaveBeenCalledWith("/home/user/site/emdash-env.d.ts", types);
		expect(sandbox.exec).not.toHaveBeenCalled();
		expect(checkpointSite).toHaveBeenCalledOnce();
	});

	it("shortens very large declarations and points at the file for the rest", async () => {
		const types = `declare module "emdash" {}\n${"// generated\n".repeat(10_000)}`;
		const sandbox = {
			fetchPort: vi.fn(async () => new Response(types, { status: 200 })),
			writeFile: vi.fn(async () => ({ success: true })),
			exec: vi.fn(),
		};
		const refresh = createTools(sandbox as never, toolCallbacks() as never).refresh_types
			.execute as unknown as () => Promise<Record<string, unknown>>;

		const result = await refresh();

		expect(result).toMatchObject({ success: true, declarationsTruncated: true });
		expect(String(result.declarations).length).toBeLessThan(types.length);
		expect(String(result.note)).toContain("emdash-env.d.ts");
		expect(sandbox.writeFile).toHaveBeenCalledWith("/home/user/site/emdash-env.d.ts", types);
	});

	it("reports legacy typegen fallback and never checkpoints a failed refresh", async () => {
		const checkpointSite = vi.fn(async () => {});
		const sandbox = {
			fetchPort: vi
				.fn()
				.mockResolvedValueOnce(new Response("Not found", { status: 404 }))
				.mockResolvedValueOnce(new Response("not generated types", { status: 200 })),
			writeFile: vi.fn(),
			exec: vi.fn(async () => ({
				success: true,
				exitCode: 0,
				stdout: "Generated .emdash/types.ts",
				stderr: "",
			})),
		};
		const refresh = createTools(sandbox as never, { ...toolCallbacks(), checkpointSite } as never)
			.refresh_types.execute as unknown as () => Promise<Record<string, unknown>>;

		await expect(refresh()).resolves.toMatchObject({
			success: true,
			generatedFile: ".emdash/types.ts",
		});
		await expect(refresh()).resolves.toMatchObject({ success: false, exitCode: 1 });
		expect(sandbox.exec).toHaveBeenCalledOnce();
		expect(sandbox.writeFile).not.toHaveBeenCalled();
		expect(checkpointSite).toHaveBeenCalledOnce();
	});

	it("retries live typegen once the stopped container is restored", async () => {
		const interrupted = new Error(NOT_RUNNING);
		const types = 'declare module "emdash" { interface EmDashCollections {} }';
		const oldSandbox = { fetchPort: vi.fn(async () => Promise.reject(interrupted)) };
		const newSandbox = {
			fetchPort: vi.fn(async () => new Response(types)),
			writeFile: vi.fn(async () => ({ success: true })),
		};
		let current: {
			fetchPort: () => Promise<Response>;
			writeFile?: (path: string, content: string) => Promise<{ success: boolean }>;
		} = oldSandbox;
		const runSandboxRead = async <T>(operation: (sandbox: typeof current) => Promise<T>) => {
			try {
				return await operation(current);
			} catch {
				current = newSandbox;
				return operation(current);
			}
		};
		const refresh = createTools(() => current as never, {
			...toolCallbacks(),
			runSandboxRead,
		} as never).refresh_types.execute as unknown as () => Promise<Record<string, unknown>>;

		await expect(refresh()).resolves.toMatchObject({ success: true });
		expect(oldSandbox.fetchPort).toHaveBeenCalledOnce();
		expect(newSandbox.writeFile).toHaveBeenCalledWith("/home/user/site/emdash-env.d.ts", types);
	});

	it("rejects chunked live typegen above the response bound without writing", async () => {
		const sandbox = {
			fetchPort: vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1))),
			writeFile: vi.fn(),
		};
		const checkpointSite = vi.fn(async () => {});
		const refresh = createTools(sandbox as never, { ...toolCallbacks(), checkpointSite } as never)
			.refresh_types.execute as unknown as () => Promise<Record<string, unknown>>;

		await expect(refresh()).resolves.toMatchObject({
			success: false,
			stderr: expect.stringContaining("exceeds"),
		});
		expect(sandbox.writeFile).not.toHaveBeenCalled();
		expect(checkpointSite).not.toHaveBeenCalled();
	});

	it("includes a recent render error when public HTML is incomplete", async () => {
		const exec = vi.fn(async () => ({ success: true, exitCode: 0, stdout: "typed", stderr: "" }));
		const sandbox = validatingSandbox(exec, "");
		const callbacks = {
			...toolCallbacks(),
			getRecentRenderErrors: () => ["Unable to render RichText because it is undefined!"],
		};
		const tools = createTools(sandbox as never, callbacks as never);
		const result = await (
			tools.validate_site.execute as unknown as () => Promise<{ stderr: string }>
		)();
		expect(result.stderr).toContain("/: returned an empty HTML document");
		expect(result.stderr).toContain("Unable to render RichText because it is undefined!");
	});

	it("retries a safe read once the stopped container is restored", async () => {
		const interrupted = new Error(NOT_RUNNING);
		const oldSandbox = { readFile: vi.fn(async () => Promise.reject(interrupted)) };
		const newSandbox = {
			readFile: vi.fn(async () => ({ success: true, content: "recovered" })),
		};
		let current = oldSandbox;
		const runSandboxRead = async <T>(operation: (sandbox: typeof oldSandbox) => Promise<T>) => {
			try {
				return await operation(current);
			} catch {
				current = newSandbox as typeof oldSandbox;
				return operation(current);
			}
		};
		const tools = createTools(() => current as never, {
			...toolCallbacks(),
			runSandboxRead,
		} as never);
		const read = tools.read_file.execute as (input: { path: string }) => Promise<unknown>;

		await expect(read({ path: "src/pages/index.astro" })).resolves.toMatchObject({
			success: true,
			content: "recovered",
		});
		expect(oldSandbox.readFile).toHaveBeenCalledOnce();
		expect(newSandbox.readFile).toHaveBeenCalledOnce();
	});

	describe("typecheck reuse", () => {
		const digest = (char: string) => char.repeat(64);
		function fingerprintingSandbox(fingerprint: () => string, validate: () => unknown) {
			const exec = vi.fn(async (command: string) =>
				command.includes("sha256sum")
					? { success: true, exitCode: 0, stdout: `${fingerprint()}\n`, stderr: "" }
					: validate(),
			);
			return { exec, sandbox: validatingSandbox(exec) };
		}
		function cache(initial?: string) {
			let passed = initial;
			return {
				lastPassed: vi.fn(() => passed),
				recordPassed: vi.fn((fingerprint: string) => {
					passed = fingerprint;
				}),
			};
		}
		const passing = () => ({ success: true, exitCode: 0, stdout: "typed", stderr: "" });
		const validateCalls = (exec: ReturnType<typeof vi.fn>) =>
			exec.mock.calls.filter(([command]) => command === "pnpm validate").length;

		it("skips the typecheck in a later turn when the source is unchanged", async () => {
			const typecheckCache = cache();
			const { exec, sandbox } = fingerprintingSandbox(() => digest("a"), passing);
			const turn = () =>
				createTools(sandbox as never, { ...toolCallbacks(), typecheckCache } as never).validate_site
					.execute as unknown as () => Promise<Record<string, unknown>>;

			await expect(turn()()).resolves.toMatchObject({ success: true });
			expect(typecheckCache.recordPassed).toHaveBeenCalledWith(digest("a"));
			// A content-only follow-up: same source, new turn.
			const second = await turn()();

			expect(second).toMatchObject({ success: true, typecheckSkipped: true });
			expect(String(second.stdout)).toContain("unchanged");
			expect(validateCalls(exec)).toBe(1);
			// The rendered crawl still runs: content may have changed.
			expect(sandbox.fetchPort).toHaveBeenCalledTimes(2);
		});

		it("typechecks again when the source changed", async () => {
			const typecheckCache = cache(digest("a"));
			const { exec, sandbox } = fingerprintingSandbox(() => digest("b"), passing);
			const validate = createTools(
				sandbox as never,
				{ ...toolCallbacks(), typecheckCache } as never,
			).validate_site.execute as unknown as () => Promise<Record<string, unknown>>;

			await expect(validate()).resolves.toMatchObject({ success: true });
			expect(validateCalls(exec)).toBe(1);
			expect(typecheckCache.recordPassed).toHaveBeenCalledWith(digest("b"));
		});

		it("does not record a pass when the source changed while it was being checked", async () => {
			const typecheckCache = cache();
			const digests = [digest("a"), digest("b")];
			const { sandbox } = fingerprintingSandbox(() => digests.shift() ?? digest("b"), passing);
			const validate = createTools(
				sandbox as never,
				{ ...toolCallbacks(), typecheckCache } as never,
			).validate_site.execute as unknown as () => Promise<unknown>;

			await expect(validate()).resolves.toMatchObject({ success: true });
			expect(typecheckCache.recordPassed).not.toHaveBeenCalled();
		});

		it("fingerprints every source file outside dependencies, output and local state", () => {
			const root = mkdtempSync(join(tmpdir(), "emdash-fingerprint-"));
			try {
				const write = (path: string, content: string) => {
					mkdirSync(posix.dirname(join(root, path)), { recursive: true });
					writeFileSync(join(root, path), content);
				};
				write("src/pages/index.astro", "home");
				write("worker-configuration.d.ts", "declare const env: {}");
				write("node_modules/pkg/index.js", "dependency");
				write(".wrangler/state/db.sqlite", "content");
				const fingerprint = () =>
					spawnSync("bash", ["-c", typecheckInputsFingerprintCommand()], {
						cwd: root,
						encoding: "utf8",
					}).stdout.trim();
				const first = fingerprint();
				write("node_modules/pkg/index.js", "changed dependency");
				write(".wrangler/state/db.sqlite", "changed content");
				expect(fingerprint()).toBe(first);
				write("worker-configuration.d.ts", "declare const env: { DB: D1Database }");
				expect(fingerprint()).not.toBe(first);
				expect(first).toMatch(/^[0-9a-f]{64}$/);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});

		it("never records a failed typecheck and typechecks when fingerprinting fails", async () => {
			const typecheckCache = cache();
			const failing = () => ({ success: false, exitCode: 1, stdout: "", stderr: "Type error" });
			const { sandbox } = fingerprintingSandbox(() => digest("c"), failing);
			const validate = createTools(
				sandbox as never,
				{ ...toolCallbacks(), typecheckCache } as never,
			).validate_site.execute as () => Promise<unknown>;
			await expect(validate()).resolves.toMatchObject({ success: false });
			expect(typecheckCache.recordPassed).not.toHaveBeenCalled();

			const unreadable = fingerprintingSandbox(() => "not a digest", passing);
			const again = createTools(
				unreadable.sandbox as never,
				{ ...toolCallbacks(), typecheckCache: cache(digest("c")) } as never,
			).validate_site.execute as () => Promise<unknown>;
			await expect(again()).resolves.toMatchObject({ success: true });
			expect(validateCalls(unreadable.exec)).toBe(1);
		});
	});

	it("coalesces overlapping successful validation calls", async () => {
		const exec = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			stdout: "validated",
			stderr: "",
		}));
		const tools = createTools(validatingSandbox(exec) as never, toolCallbacks() as never);
		const validate = tools.validate_site.execute as () => Promise<unknown>;

		const [first, second] = await Promise.all([validate(), validate()]);

		expect(first).toMatchObject({ success: true });
		expect(second).toMatchObject({ success: true, cached: true });
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it("records live block renderer evidence with successful validation", async () => {
		const exec = vi.fn(async () => ({ success: true, exitCode: 0, stdout: "typed", stderr: "" }));
		const sandbox = validatingSandbox(exec);
		const convergence = new BuildConvergence();
		const evidence = {
			fields: [
				{
					collection: "pages",
					field: "layout",
					fingerprint: "live-fingerprint",
					allowedTypes: ["bakery_intro"],
					retiredTypes: [],
					types: [{ slug: "bakery_intro", currentVersion: 1, versions: [1, 2] }],
				},
			],
		};
		const tools = createTools(
			sandbox as never,
			{
				...toolCallbacks(),
				validateBlockContracts: async () => ({ success: true, evidence, issues: [] }),
			} as never,
			{ convergence },
		);

		const result = await (tools.validate_site.execute as () => Promise<unknown>)();

		expect(result).toMatchObject({
			success: true,
			blockRendererValidation: { success: true, evidence },
		});
		expect(convergence.currentValidation()).toMatchObject({
			blockRendererValidation: { evidence },
		});
	});

	it("caches a block renderer validation failure without crawling the site", async () => {
		const exec = vi.fn(async () => ({ success: true, exitCode: 0, stdout: "typed", stderr: "" }));
		const sandbox = validatingSandbox(exec);
		const validateBlockContracts = vi.fn(async () => ({
			success: false,
			evidence: { fields: [] },
			issues: ["pages.layout is missing bakery_intro"],
		}));
		const tools = createTools(
			sandbox as never,
			{ ...toolCallbacks(), validateBlockContracts } as never,
		);
		const validate = tools.validate_site.execute as () => Promise<unknown>;

		await expect(validate()).resolves.toMatchObject({
			success: false,
			stderr: expect.stringContaining("pages.layout is missing bakery_intro"),
		});
		await expect(validate()).resolves.toMatchObject({ success: false, cached: true });
		expect(validateBlockContracts).toHaveBeenCalledOnce();
		expect(sandbox.fetchPort).not.toHaveBeenCalled();
	});

	it("rejects a source-valid site that still renders the blank scaffold", async () => {
		const exec = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			stdout: "validated",
			stderr: "",
		}));
		const sandbox = validatingSandbox(
			exec,
			"<!doctype html><html><head><title>New EmDash site</title></head><body><h1>Your site is taking shape.</h1></body></html>",
		);
		const tools = createTools(sandbox as never, toolCallbacks() as never);
		const validate = tools.validate_site.execute as () => Promise<unknown>;

		await expect(validate()).resolves.toMatchObject({
			success: false,
			exitCode: 1,
			publicSiteAudit: {
				success: false,
				issues: [{ path: "/", reason: "scaffold-placeholder" }],
			},
		});
		await expect(validate()).resolves.toMatchObject({ success: false, cached: true });
		expect(sandbox.fetchPort).toHaveBeenCalledTimes(1);
		expect(sandbox.fetchPort).toHaveBeenCalledWith(4321, "http://localhost:4321/", {
			headers: { Accept: "text/html" },
			redirect: "manual",
		});
	});

	it("retries one wholly truncated rendered crawl before failing validation", async () => {
		const exec = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			stdout: "validated",
			stderr: "",
		}));
		const sandbox = validatingSandbox(exec);
		sandbox.fetchPort
			.mockResolvedValueOnce(
				new Response("<!doctype html><html><body><main>Still streaming", {
					headers: { "Content-Type": "text/html" },
				}),
			)
			.mockResolvedValueOnce(
				new Response("<!doctype html><html><body><main>Complete site</main></body></html>", {
					headers: { "Content-Type": "text/html" },
				}),
			);

		const validate = createTools(sandbox as never, toolCallbacks() as never).validate_site
			.execute as unknown as () => Promise<unknown>;

		await expect(validate()).resolves.toMatchObject({ success: true });
		expect(sandbox.fetchPort).toHaveBeenCalledTimes(2);
	});

	it("fails after exactly one retry when rendered HTML stays truncated", async () => {
		const exec = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			stdout: "validated",
			stderr: "",
		}));
		const sandbox = validatingSandbox(exec);
		sandbox.fetchPort.mockImplementation(
			async () =>
				new Response("<!doctype html><html><body><main>Still streaming", {
					headers: { "Content-Type": "text/html" },
				}),
		);
		const validate = createTools(sandbox as never, toolCallbacks() as never).validate_site
			.execute as unknown as () => Promise<unknown>;

		await expect(validate()).resolves.toMatchObject({
			success: false,
			publicSiteAudit: { issues: [{ reason: "truncated-html" }] },
		});
		expect(sandbox.fetchPort).toHaveBeenCalledTimes(2);
	});

	it("returns rendered server errors to the model", async () => {
		const exec = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			stdout: "validated",
			stderr: "",
		}));
		const sandbox = validatingSandbox(exec);
		sandbox.fetchPort.mockResolvedValue(
			new Response("<pre>TypeError: cannot read project.title</pre>", {
				status: 500,
				headers: { "Content-Type": "text/html" },
			}),
		);
		const validate = createTools(sandbox as never, toolCallbacks() as never).validate_site
			.execute as unknown as () => Promise<{ stderr: string }>;

		expect((await validate()).stderr).toContain("cannot read project.title");
	});

	it("reuses unchanged validation errors until the site mutates", async () => {
		const exec = vi.fn(async () => ({
			success: false,
			exitCode: 1,
			stdout: "type error",
			stderr: "",
		}));
		const tools = createTools({ exec } as never, toolCallbacks() as never);
		const validate = tools.validate_site.execute as () => Promise<unknown>;

		const first = await validate();
		const second = await validate();

		expect(first).toMatchObject({ success: false, stdout: "type error" });
		expect(second).toMatchObject({ success: false, cached: true });
		expect(exec).toHaveBeenCalledTimes(1);
	});

	it("coalesces overlapping preview captures for one revision", async () => {
		const capturePreview = vi.fn(async () => ({
			ok: true as const,
			base64: "cHJldmlldw==",
			mediaType: "image/png",
		}));
		const tools = createTools({} as never, toolCallbacks(capturePreview) as never, {
			previewImagesEnabled: true,
		});
		const viewPreview = tools.view_preview.execute as () => Promise<unknown>;

		const [first, second] = await Promise.all([viewPreview(), viewPreview()]);

		expect(first).toMatchObject({ success: true });
		expect(second).toMatchObject({ success: true, cached: true });
		expect(capturePreview).toHaveBeenCalledTimes(1);
	});

	it("does not start validation while a mutation is in flight", async () => {
		const convergence = new BuildConvergence();
		const finishMutation = convergence.beginMutation();
		const exec = vi.fn();
		const tools = createTools({ exec } as never, toolCallbacks() as never, {
			convergence,
		});
		const validate = tools.validate_site.execute as () => Promise<unknown>;

		await expect(validate()).resolves.toMatchObject({
			success: false,
			retryable: true,
		});
		expect(exec).not.toHaveBeenCalled();
		finishMutation();
	});

	it("treats every shell command as a potential site mutation", async () => {
		const convergence = new BuildConvergence();
		const observation = convergence.beginObservation()!;
		// A failed validation leaves shell access open for diagnosis.
		convergence.recordValidationResult(observation, { success: false }, false);
		const exec = vi.fn(async () => ({ success: true, exitCode: 0, stdout: "ok", stderr: "" }));
		const tools = createTools({ exec } as never, toolCallbacks() as never, {
			convergence,
		});
		const run = tools.exec.execute as (input: { command: string }) => Promise<unknown>;

		await expect(run({ command: "curl http://localhost:4321" })).resolves.toMatchObject({
			success: true,
		});

		expect(convergence.currentRevision()).toBe(1);
		expect(convergence.currentValidationResult()).toBeUndefined();
	});

	it("does not advance the revision for an edit precondition miss", async () => {
		const convergence = new BuildConvergence();
		const readFile = vi.fn(async () => ({ success: true, content: "current source" }));
		const writeFile = vi.fn();
		const tools = createTools({ readFile, writeFile } as never, toolCallbacks() as never, {
			convergence,
		});
		const edit = tools.edit_file.execute as (input: {
			path: string;
			oldText: string;
			newText: string;
		}) => Promise<unknown>;

		await expect(
			edit({ path: "src/pages/index.astro", oldText: "missing", newText: "replacement" }),
		).resolves.toMatchObject({ success: false });

		expect(convergence.currentRevision()).toBe(0);
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("does not write a file after Stop arrives during its read", async () => {
		const controller = new AbortController();
		const readFile = vi.fn(async () => {
			controller.abort();
			return { success: false };
		});
		const writeFile = vi.fn();
		const tools = createTools({ readFile, writeFile } as never, toolCallbacks() as never, {
			abortSignal: controller.signal,
		});
		const write = tools.write_file.execute as (input: {
			path: string;
			content: string;
		}) => Promise<unknown>;

		await expect(
			write({ path: "src/pages/index.astro", content: "<h1>New</h1>" }),
		).rejects.toThrow();
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("does not advance the revision for an identical whole-file write", async () => {
		const convergence = new BuildConvergence();
		const readFile = vi.fn(async () => ({ success: true, content: "current source" }));
		const writeFile = vi.fn();
		const tools = createTools({ readFile, writeFile } as never, toolCallbacks() as never, {
			convergence,
		});
		const write = tools.write_file.execute as (input: {
			path: string;
			content: string;
		}) => Promise<unknown>;

		await expect(
			write({ path: "src/pages/index.astro", content: "current source" }),
		).resolves.toMatchObject({ success: true, changed: false });

		expect(convergence.currentRevision()).toBe(0);
		expect(writeFile).not.toHaveBeenCalled();
	});

	it("does not cache validation that overlaps a later mutation", async () => {
		let resolveValidation!: (result: {
			success: boolean;
			exitCode: number;
			stdout: string;
			stderr: string;
		}) => void;
		const exec = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveValidation = resolve;
				}),
		);
		const convergence = new BuildConvergence();
		const tools = createTools(validatingSandbox(exec) as never, toolCallbacks() as never, {
			convergence,
		});
		const validate = tools.validate_site.execute as () => Promise<unknown>;

		const pending = validate();
		await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
		const finishMutation = convergence.beginMutation();
		resolveValidation({ success: true, exitCode: 0, stdout: "validated", stderr: "" });

		await expect(pending).resolves.toMatchObject({ success: false, retryable: true });
		finishMutation();
		expect(convergence.currentValidation()).toBeUndefined();
	});

	it("discards failed validation diagnostics that overlap a later mutation", async () => {
		let resolveValidation!: (result: {
			success: boolean;
			exitCode: number;
			stdout: string;
			stderr: string;
		}) => void;
		const exec = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveValidation = resolve;
					}),
			)
			.mockResolvedValueOnce({ success: false, exitCode: 1, stdout: "current", stderr: "" });
		const convergence = new BuildConvergence();
		const tools = createTools({ exec } as never, toolCallbacks() as never, {
			convergence,
		});
		const validate = tools.validate_site.execute as () => Promise<unknown>;

		const pending = validate();
		await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
		const finishMutation = convergence.beginMutation();
		resolveValidation({ success: false, exitCode: 1, stdout: "stale", stderr: "" });

		await expect(pending).resolves.toMatchObject({ success: false, retryable: true });
		finishMutation();
		await expect(validate()).resolves.toMatchObject({ success: false, stdout: "current" });
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it("keeps screenshot bytes through both AI SDK model-output conversions", async () => {
		const capturePreview = vi.fn(async () => ({
			ok: true as const,
			base64: "cHJldmlldw==",
			mediaType: "image/png",
		}));
		const tools = createTools({} as never, toolCallbacks(capturePreview) as never, {
			previewImagesEnabled: true,
		});
		const output = await (tools.view_preview.execute as () => Promise<unknown>)();
		const convert = tools.view_preview.toModelOutput as (input: { output: unknown }) => unknown;

		const first = convert({ output });
		const second = convert({ output });

		expect(first).toEqual(second);
		expect(first).toMatchObject({
			type: "content",
			value: expect.arrayContaining([
				expect.objectContaining({ type: "file-data", data: "cHJldmlldw==" }),
			]),
		});
	});

	it("stores a separate thumbnail without adding image bytes to the chat tool result", async () => {
		const capturePreview = vi.fn(async () => ({
			ok: true as const,
			base64: "cGljdHVyZQ==",
			mediaType: "image/png",
		}));
		const savePreviewThumbnail = vi.fn();
		const tools = createTools(
			{} as never,
			{
				...toolCallbacks(capturePreview),
				savePreviewThumbnail,
			} as never,
		);
		const output = await (tools.view_preview.execute as () => Promise<unknown>)();
		expect(output).toEqual({
			success: true,
			shotId: expect.any(String),
			revision: expect.any(Number),
		});
		expect(savePreviewThumbnail).toHaveBeenCalledWith((output as { shotId: string }).shotId, {
			base64: "cGljdHVyZQ==",
			mediaType: "image/png",
		});
	});

	it("does not fail the model preview if optional thumbnail storage fails", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const tools = createTools(
				{} as never,
				{
					...toolCallbacks(
						vi.fn(async () => ({
							ok: true as const,
							base64: "cGljdHVyZQ==",
							mediaType: "image/png",
						})),
					),
					savePreviewThumbnail: () => {
						throw new Error("storage unavailable");
					},
				} as never,
			);
			const output = await (tools.view_preview.execute as () => Promise<unknown>)();
			expect(output).toMatchObject({ success: true, shotId: expect.any(String) });
			expect(warning).toHaveBeenCalledWith("Could not retain preview thumbnail");
		} finally {
			warning.mockRestore();
		}
	});

	it("sends screenshot bytes in the actual second streamText model request", async () => {
		const convergence = new BuildConvergence();
		const tools = createTools(
			{} as never,
			toolCallbacks(
				vi.fn(async () => ({
					ok: true as const,
					base64: "c2Vjb25kLXJlcXVlc3QtaW1hZ2U=",
					mediaType: "image/png",
				})),
			) as never,
			{
				convergence,
				previewImagesEnabled: true,
			},
		);
		const usage = {
			inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 1, text: 1, reasoning: 0 },
		};
		const model = new MockLanguageModelV3({
			doStream: [
				{
					stream: simulateReadableStream({
						chunks: [
							{ type: "stream-start" as const, warnings: [] },
							{
								type: "tool-call" as const,
								toolCallId: "preview-call",
								toolName: "view_preview",
								input: "{}",
							},
							{
								type: "finish" as const,
								finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
								usage,
							},
						],
					}),
				},
				{
					stream: simulateReadableStream({
						chunks: [
							{ type: "stream-start" as const, warnings: [] },
							{ type: "text-start" as const, id: "text-1" },
							{ type: "text-delta" as const, id: "text-1", delta: "Done" },
							{ type: "text-end" as const, id: "text-1" },
							{
								type: "finish" as const,
								finishReason: { unified: "stop" as const, raw: "stop" },
								usage,
							},
						],
					}),
				},
			],
		});

		const result = streamText({
			model,
			prompt: "Inspect the preview",
			tools: { view_preview: tools.view_preview },
			stopWhen: stepCountIs(2),
			prepareStep: ({ messages }) => prepareBuildStep(convergence, messages, ["view_preview"]),
			onStepFinish: (step) => {
				convergence.finishStep(step);
				releaseStepPreviewImages(step);
			},
		});
		await result.text;
		const steps = await result.steps;

		expect(model.doStreamCalls).toHaveLength(2);
		expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain(
			"c2Vjb25kLXJlcXVlc3QtaW1hZ2U=",
		);
		expect(JSON.stringify(steps[0]!.response.messages)).not.toContain(
			"c2Vjb25kLXJlcXVlc3QtaW1hZ2U=",
		);
	});

	it("promotes the preview into a Luna Responses user image message", async () => {
		const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
		const responses = [
			{
				id: "response-1",
				created_at: 1,
				model: "gpt-5.6-luna",
				output: [
					{
						type: "function_call",
						id: "function-1",
						call_id: "preview-call",
						name: "view_preview",
						arguments: "{}",
					},
				],
				usage,
			},
			{
				id: "response-2",
				created_at: 2,
				model: "gpt-5.6-luna",
				output: [
					{
						type: "message",
						role: "assistant",
						id: "message-1",
						content: [{ type: "output_text", text: "Done", annotations: [] }],
					},
				],
				usage,
			},
		];
		const requestBodies: unknown[] = [];
		const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestBodies.push(JSON.parse(String(init?.body)) as unknown);
			return Response.json(responses.shift());
		});
		const model = createOpenAI({
			apiKey: "test",
			baseURL: "https://example.test",
			fetch,
		}).responses("gpt-5.6-luna");
		const convergence = new BuildConvergence();
		const tools = createTools(
			{} as never,
			toolCallbacks(
				vi.fn(async () => ({
					ok: true as const,
					base64: "d29ya2Vycy1haS1pbWFnZQ==",
					mediaType: "image/png",
				})),
			) as never,
			{ convergence, previewImagesEnabled: true },
		);

		await generateText({
			model,
			prompt: "Inspect the preview",
			tools: { view_preview: tools.view_preview },
			stopWhen: stepCountIs(2),
			prepareStep: ({ messages }) => prepareBuildStep(convergence, messages, ["view_preview"]),
			onStepFinish: (step) => {
				convergence.finishStep(step);
				releaseStepPreviewImages(step);
			},
		});

		expect(fetch).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(requestBodies[1])).toContain(
			"data:image/png;base64,d29ya2Vycy1haS1pbWFnZQ==",
		);
		expect(requestBodies[1]).toMatchObject({
			input: expect.arrayContaining([expect.objectContaining({ role: "user" })]),
		});
	});

	it("does not deliver or charge a screenshot after its revision becomes stale", async () => {
		const convergence = new BuildConvergence();
		const capturePreview = vi.fn(async () => ({
			ok: true as const,
			base64: "cHJldmlldw==",
			mediaType: "image/png",
		}));
		const tools = createTools({} as never, toolCallbacks(capturePreview) as never, {
			convergence,
			previewImagesEnabled: true,
			maxPreviewImages: 1,
		});
		const viewPreview = tools.view_preview.execute as () => Promise<unknown>;
		const convert = tools.view_preview.toModelOutput as (input: { output: unknown }) => unknown;

		const staleOutput = await viewPreview();
		const finishMutation = convergence.beginMutation();
		finishMutation();

		expect(convert({ output: staleOutput })).toMatchObject({ type: "error-text" });

		const currentOutput = await viewPreview();
		expect(convert({ output: currentOutput })).toMatchObject({
			type: "content",
			value: expect.arrayContaining([expect.objectContaining({ type: "file-data" })]),
		});
		expect(capturePreview).toHaveBeenCalledTimes(2);
	});

	it("does not acknowledge a cached preview after its revision becomes stale", async () => {
		const convergence = new BuildConvergence();
		const capturePreview = vi.fn(async () => ({
			ok: true as const,
			base64: "cHJldmlldw==",
			mediaType: "image/png",
		}));
		const tools = createTools({} as never, toolCallbacks(capturePreview) as never, {
			convergence,
			previewImagesEnabled: true,
		});
		const viewPreview = tools.view_preview.execute as () => Promise<unknown>;
		const convert = tools.view_preview.toModelOutput as (input: { output: unknown }) => unknown;

		const captured = await viewPreview();
		convert({ output: captured });
		convert({ output: captured });
		const cached = await viewPreview();
		const finishMutation = convergence.beginMutation();
		finishMutation();

		expect(convert({ output: cached })).toMatchObject({ type: "error-text" });
		expect(convergence.hasCompleteEvidence()).toBe(false);
	});

	it("delivers a validated revision after the exploratory image budget", async () => {
		const convergence = new BuildConvergence();
		const exec = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			stdout: "validated",
			stderr: "",
		}));
		const capturePreview = vi.fn(async () => ({
			ok: true as const,
			base64: `cHJldmlldy0${capturePreview.mock.calls.length}`,
			mediaType: "image/png",
		}));
		const tools = createTools(
			validatingSandbox(exec) as never,
			toolCallbacks(capturePreview) as never,
			{
				convergence,
				previewImagesEnabled: true,
				maxPreviewImages: 1,
			},
		);
		const viewPreview = tools.view_preview.execute as () => Promise<unknown>;
		const validate = tools.validate_site.execute as () => Promise<unknown>;
		const convert = tools.view_preview.toModelOutput as (input: { output: unknown }) => unknown;

		const exploratory = await viewPreview();
		convert({ output: exploratory });
		convert({ output: exploratory });
		const finishMutation = convergence.beginMutation();
		finishMutation();

		// Passing validation captures the final preview itself, past the exploratory budget.
		const validated = await validate();
		const convertValidation = tools.validate_site.toModelOutput as (input: {
			output: unknown;
		}) => unknown;

		expect(validated).toMatchObject({ success: true, preview: { shotId: expect.any(String) } });
		expect(convertValidation({ output: validated })).toMatchObject({
			type: "content",
			value: expect.arrayContaining([expect.objectContaining({ type: "file-data" })]),
		});
		expect(capturePreview).toHaveBeenCalledTimes(2);
		expect(convergence.hasCurrentPreviewCapture()).toBe(true);
		// A later view_preview of the same revision reuses that capture.
		await expect(viewPreview()).resolves.toMatchObject({ success: true, cached: true });
		expect(capturePreview).toHaveBeenCalledTimes(2);
	});

	it("finishes a build one step after validation by delivering the final preview with it", async () => {
		const exec = vi.fn(async () => ({ success: true, exitCode: 0, stdout: "ok", stderr: "" }));
		const convergence = new BuildConvergence();
		const tools = createTools(
			validatingSandbox(exec) as never,
			toolCallbacks(
				vi.fn(async () => ({
					ok: true as const,
					base64: "ZmluYWwtcHJldmlldw==",
					mediaType: "image/png",
				})),
			) as never,
			{ convergence, previewImagesEnabled: true },
		);
		const usage = {
			inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
			outputTokens: { total: 1, text: 1, reasoning: 0 },
		};
		const model = new MockLanguageModelV3({
			doStream: [
				{
					stream: simulateReadableStream({
						chunks: [
							{ type: "stream-start" as const, warnings: [] },
							{
								type: "tool-call" as const,
								toolCallId: "validate-call",
								toolName: "validate_site",
								input: "{}",
							},
							{
								type: "finish" as const,
								finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
								usage,
							},
						],
					}),
				},
				{
					stream: simulateReadableStream({
						chunks: [
							{ type: "stream-start" as const, warnings: [] },
							{ type: "text-start" as const, id: "text-1" },
							{ type: "text-delta" as const, id: "text-1", delta: "Done" },
							{ type: "text-end" as const, id: "text-1" },
							{
								type: "finish" as const,
								finishReason: { unified: "stop" as const, raw: "stop" },
								usage,
							},
						],
					}),
				},
			],
		});
		const toolNames = ["validate_site", "view_preview"] as const;

		const result = streamText({
			model,
			prompt: "Finish the site",
			tools: { validate_site: tools.validate_site, view_preview: tools.view_preview },
			stopWhen: stepCountIs(4),
			prepareStep: ({ messages }) => prepareBuildStep(convergence, messages, toolNames),
			onStepFinish: (step) => {
				convergence.finishStep(step);
				releaseStepPreviewImages(step);
			},
		});
		await result.text;
		const steps = await result.steps;

		// No separate view_preview step: the model saw the image right after validating.
		expect(model.doStreamCalls).toHaveLength(2);
		expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("ZmluYWwtcHJldmlldw==");
		expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("Rendered public-site audit");
		expect(JSON.stringify(steps[0]!.response.messages)).not.toContain("ZmluYWwtcHJldmlldw==");
		expect(convergence.hasCompleteEvidence()).toBe(true);
		expect(canCompleteBuild(convergence, await result.finishReason)).toBe(true);
		expect(capturedPreviewShotId(steps, convergence.currentRevision())).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("leaves the final preview to view_preview when validation fails", async () => {
		const exec = vi.fn(async () => ({
			success: false,
			exitCode: 1,
			stdout: "",
			stderr: "Type error",
		}));
		const capturePreview = vi.fn();
		const tools = createTools(
			validatingSandbox(exec) as never,
			toolCallbacks(capturePreview) as never,
			{
				previewImagesEnabled: true,
			},
		);

		const failed = await (tools.validate_site.execute as () => Promise<unknown>)();

		expect(failed).toMatchObject({ success: false });
		expect(failed).not.toHaveProperty("preview");
		expect(capturePreview).not.toHaveBeenCalled();
	});
});

describe("stopped media batch", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("does not start another upload and checkpoints a completed one", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
			if (init?.method === "POST") {
				controller.abort();
				return Response.json({ item: { id: "uploaded-one" } });
			}
			if (url.includes("two")) {
				return new Promise((_resolve, reject) => {
					controller.signal.addEventListener("abort", () => reject(new Error("stopped")), {
						once: true,
					});
				});
			}
			return new Response(new Uint8Array([1]), {
				headers: { "content-type": "image/png" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const checkpointSite = vi.fn(async () => {});
		const tools = createTools({} as never, { ...toolCallbacks(), checkpointSite } as never, {
			apiToken: "test-token",
			cmsBaseUrl: "https://site.example/",
			abortSignal: controller.signal,
		});
		const upload = tools.upload_media.execute as (input: {
			images: Array<{ url: string }>;
		}) => Promise<unknown>;

		await expect(
			upload({
				images: [
					{ url: "https://images.example/one" },
					{ url: "https://images.example/two" },
					{ url: "https://images.example/three" },
				],
			}),
		).rejects.toThrow();
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
		expect(fetchMock.mock.calls.some(([url]) => url.includes("three"))).toBe(false);
		expect(checkpointSite).toHaveBeenCalledTimes(1);
	});

	it("keeps a failed image unresolved until the same media slot uploads", async () => {
		const convergence = new BuildConvergence();
		const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
			if (init?.method === "POST") {
				return Response.json({ item: { id: "uploaded-gallery" } });
			}
			if (url.includes("missing")) return new Response("gone", { status: 404 });
			return new Response(new Uint8Array([1]), {
				headers: { "content-type": "image/jpeg" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const tools = createTools({} as never, toolCallbacks() as never, {
			apiToken: "test-token",
			cmsBaseUrl: "https://site.example/",
			convergence,
		});
		const upload = tools.upload_media.execute as (input: {
			images: Array<{ url: string; filename: string; alt: string }>;
		}) => Promise<unknown>;

		await expect(
			upload({
				images: [
					{
						url: "https://images.example/missing",
						filename: "elephant-times-gallery.jpg",
						alt: "Visitors gathered in a gallery",
					},
				],
			}),
		).resolves.toMatchObject({ success: false });
		expect(convergence.hasUnresolvedFailures()).toBe(true);
		expect(
			prepareBuildStep(convergence, [] as never, ["upload_media", "view_preview"]),
		).toMatchObject({ allowedTools: { toolNames: ["upload_media"], mode: "required" } });

		await expect(
			upload({
				images: [
					{
						url: "https://images.example/replacement",
						filename: "elephant-times-gallery.jpg",
						alt: "Visitors gathered in a gallery",
					},
				],
			}),
		).resolves.toMatchObject({ success: true, uploaded: 1 });
		expect(convergence.hasUnresolvedFailures()).toBe(false);
	});
});

describe("stopped server restart", () => {
	it("does not restart after Stop or checkpoint a restart completed after Stop", async () => {
		const controller = new AbortController();
		let finishRestart!: (result: { success: boolean }) => void;
		const restartDevServer = vi.fn(
			() => new Promise<{ success: boolean }>((resolve) => (finishRestart = resolve)),
		);
		const checkpointSite = vi.fn(async () => {});
		const tools = createTools(
			{} as never,
			{
				...toolCallbacks(),
				restartDevServer,
				checkpointSite,
			} as never,
			{ abortSignal: controller.signal },
		);
		const restart = tools.restart_dev_server.execute as () => Promise<unknown>;

		const pending = restart();
		await vi.waitFor(() => expect(restartDevServer).toHaveBeenCalledTimes(1));
		controller.abort();
		finishRestart({ success: true });
		await expect(pending).rejects.toThrow();
		await expect(restart()).rejects.toThrow();
		expect(restartDevServer).toHaveBeenCalledTimes(1);
		expect(checkpointSite).not.toHaveBeenCalled();
	});
});

describe("write_files", () => {
	function batchHarness(
		initial: Record<string, string>,
		writeFailure?: (path: string) => boolean,
		readFailure?: (path: string) => boolean | Error | undefined,
	) {
		const store = new Map(Object.entries(initial));
		const sandbox = {
			readFile: vi.fn(async (path: string) => {
				const failure = readFailure?.(path);
				if (failure instanceof Error) throw failure;
				if (failure) throw new Error("read failed");
				const content = store.get(posix.normalize(path));
				return content === undefined ? { success: false } : { success: true, content };
			}),
			writeFile: vi.fn(async (path: string, content: string) => {
				store.set(posix.normalize(path), content);
				if (writeFailure?.(path)) throw new Error("write failed");
				return { success: true };
			}),
			deleteFile: vi.fn(async (path: string) => {
				store.delete(posix.normalize(path));
				return { success: true };
			}),
		};
		const reloadPreview = vi.fn(async () => {});
		const checkpointSite = vi.fn(async () => {});
		const convergence = new BuildConvergence();
		const tools = createTools(
			sandbox as never,
			{ ...toolCallbacks(), reloadPreview, checkpointSite } as never,
			{ convergence },
		);
		const write = tools.write_files.execute as unknown as (input: {
			files: Array<{ path: string; content: string }>;
		}) => Promise<{ success: boolean; changed: boolean; error?: string }>;
		return { write, store, sandbox, reloadPreview, checkpointSite, convergence };
	}

	it("writes a coherent source batch with one reload and checkpoint", async () => {
		const page = "/home/user/site/src/pages/index.astro";
		const layout = "/home/user/site/src/layouts/SiteLayout.astro";
		const { write, store, sandbox, reloadPreview, checkpointSite, convergence } = batchHarness({
			[page]: "old page",
		});

		await expect(
			write({
				files: [
					{ path: "src/pages/index.astro", content: "new page" },
					{ path: "src/layouts/SiteLayout.astro", content: "new layout" },
				],
			}),
		).resolves.toMatchObject({
			success: true,
			changed: true,
			files: [
				{ path: "src/pages/index.astro", changed: true },
				{ path: "src/layouts/SiteLayout.astro", changed: true },
			],
		});

		expect(store.get(page)).toBe("new page");
		expect(store.get(layout)).toBe("new layout");
		expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
		expect(reloadPreview).toHaveBeenCalledOnce();
		expect(checkpointSite).toHaveBeenCalledOnce();
		expect(convergence.currentRevision()).toBe(1);
	});

	it("creates new destinations when Sandbox readFile throws FILE_NOT_FOUND", async () => {
		const page = "/home/user/site/src/pages/index.astro";
		const menu = "/home/user/site/src/pages/menu.astro";
		const blocks = "/home/user/site/src/components/blocks/index.ts";
		const missingFile = () => {
			const error = new Error("File not found");
			error.name = "FileNotFoundError";
			Object.assign(error, { code: "FILE_NOT_FOUND", httpStatus: 404 });
			return error;
		};
		const { write, store, sandbox, reloadPreview, checkpointSite, convergence } = batchHarness(
			{ [page]: "old page" },
			undefined,
			(path) => (path === page ? undefined : missingFile()),
		);

		await expect(
			write({
				files: [
					{ path: "src/pages/index.astro", content: "new page" },
					{ path: "src/pages/menu.astro", content: "menu page" },
					{ path: "src/components/blocks/index.ts", content: "block map" },
				],
			}),
		).resolves.toMatchObject({
			success: true,
			changed: true,
			files: [
				{ path: "src/pages/index.astro", changed: true },
				{ path: "src/pages/menu.astro", changed: true },
				{ path: "src/components/blocks/index.ts", changed: true },
			],
		});

		expect(store.get(page)).toBe("new page");
		expect(store.get(menu)).toBe("menu page");
		expect(store.get(blocks)).toBe("block map");
		expect(sandbox.writeFile).toHaveBeenCalledTimes(3);
		expect(reloadPreview).toHaveBeenCalledOnce();
		expect(checkpointSite).toHaveBeenCalledOnce();
		expect(convergence.currentRevision()).toBe(1);
	});

	it("creates new destinations when RPC flattens FileNotFoundError", async () => {
		const page = "/home/user/site/src/pages/index.astro";
		const block = "/home/user/site/src/components/blocks/bakery_hero/v1.astro";
		const { write, store, sandbox, reloadPreview, checkpointSite } = batchHarness(
			{ [page]: "old page" },
			undefined,
			(path) =>
				path === block ? new Error(`FileNotFoundError: File not found: ${path}`) : undefined,
		);

		await expect(
			write({
				files: [
					{ path: "src/pages/index.astro", content: "new page" },
					{ path: "src/components/blocks/bakery_hero/v1.astro", content: "hero" },
				],
			}),
		).resolves.toMatchObject({ success: true, changed: true });

		expect(store.get(page)).toBe("new page");
		expect(store.get(block)).toBe("hero");
		expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
		expect(reloadPreview).toHaveBeenCalledOnce();
		expect(checkpointSite).toHaveBeenCalledOnce();
	});

	it("rejects the entire batch before writing when a protected path is present", async () => {
		const { write, sandbox, reloadPreview, checkpointSite, convergence } = batchHarness({});

		await expect(
			write({
				files: [
					{ path: "src/pages/index.astro", content: "page" },
					{ path: "src/worker.ts", content: "unsafe" },
				],
			}),
		).resolves.toMatchObject({
			success: false,
			changed: false,
			error: expect.stringMatching(/protected/),
		});

		expect(sandbox.readFile).not.toHaveBeenCalled();
		expect(sandbox.writeFile).not.toHaveBeenCalled();
		expect(reloadPreview).not.toHaveBeenCalled();
		expect(checkpointSite).not.toHaveBeenCalled();
		expect(convergence.currentRevision()).toBe(0);
	});

	it("rolls back earlier files when a later write fails", async () => {
		const page = "/home/user/site/src/pages/index.astro";
		const layout = "/home/user/site/src/layouts/SiteLayout.astro";
		const { write, store, sandbox, reloadPreview, checkpointSite } = batchHarness(
			{ [page]: "old page" },
			(path) => path === layout,
		);

		await expect(
			write({
				files: [
					{ path: "src/pages/index.astro", content: "new page" },
					{ path: "src/layouts/SiteLayout.astro", content: "new layout" },
				],
			}),
		).resolves.toMatchObject({
			success: false,
			changed: true,
			error: expect.stringMatching(/rolled back/),
		});

		expect(store.get(page)).toBe("old page");
		expect(store.has(layout)).toBe(false);
		expect(sandbox.writeFile).toHaveBeenCalledTimes(3);
		expect(reloadPreview).not.toHaveBeenCalled();
		expect(checkpointSite).not.toHaveBeenCalled();
	});

	it("fails preflight without writing when an existing file cannot be read", async () => {
		const page = "/home/user/site/src/pages/index.astro";
		const layout = "/home/user/site/src/layouts/SiteLayout.astro";
		const { write, store, sandbox, reloadPreview, checkpointSite, convergence } = batchHarness(
			{ [page]: "old page", [layout]: "old layout" },
			undefined,
			(path) => path === layout,
		);

		await expect(
			write({
				files: [
					{ path: "src/pages/index.astro", content: "new page" },
					{ path: "src/layouts/SiteLayout.astro", content: "new layout" },
				],
			}),
		).resolves.toMatchObject({
			success: false,
			changed: false,
			error: expect.stringMatching(/read.*SiteLayout/i),
		});

		expect(store.get(page)).toBe("old page");
		expect(store.get(layout)).toBe("old layout");
		expect(sandbox.writeFile).not.toHaveBeenCalled();
		expect(reloadPreview).not.toHaveBeenCalled();
		expect(checkpointSite).not.toHaveBeenCalled();
		expect(convergence.currentRevision()).toBe(0);
	});
});

describe("edit_files", () => {
	function batchEditHarness(
		initial: Record<string, string>,
		writeFailure?: (path: string, content: string) => boolean,
	) {
		const store = new Map(Object.entries(initial));
		const sandbox = {
			readFile: vi.fn(async (path: string) => {
				const content = store.get(posix.normalize(path));
				return content === undefined ? { success: false } : { success: true, content };
			}),
			writeFile: vi.fn(async (path: string, content: string) => {
				store.set(posix.normalize(path), content);
				if (writeFailure?.(path, content)) throw new Error("write failed");
				return { success: true };
			}),
		};
		const reloadPreview = vi.fn(async () => {});
		const checkpointSite = vi.fn(async () => {});
		const convergence = new BuildConvergence();
		const tools = createTools(
			sandbox as never,
			{ ...toolCallbacks(), reloadPreview, checkpointSite } as never,
			{ convergence },
		);
		const edit = tools.edit_files.execute as unknown as (input: {
			edits: Array<{ path: string; oldText: string; newText: string }>;
		}) => Promise<{
			success: boolean;
			changed: boolean;
			files?: Array<{ path: string; changed: boolean }>;
			error?: string;
		}>;
		return { edit, store, sandbox, reloadPreview, checkpointSite, convergence };
	}

	const page = "/home/user/site/src/pages/index.astro";
	const layout = "/home/user/site/src/layouts/SiteLayout.astro";

	it("applies exact edits atomically with one reload and checkpoint", async () => {
		const { edit, store, sandbox, reloadPreview, checkpointSite, convergence } = batchEditHarness({
			[page]: "<p>price</p>",
			[layout]: '<header class="static">',
		});

		await expect(
			edit({
				edits: [
					{ path: "src/pages/index.astro", oldText: "price", newText: "$& costs $$5" },
					{
						path: "src/layouts/SiteLayout.astro",
						oldText: 'class="static"',
						newText: 'class="sticky"',
					},
				],
			}),
		).resolves.toMatchObject({
			success: true,
			changed: true,
			files: [
				{ path: "src/pages/index.astro", changed: true },
				{ path: "src/layouts/SiteLayout.astro", changed: true },
			],
		});

		expect(store.get(page)).toBe("<p>$& costs $$5</p>");
		expect(store.get(layout)).toBe('<header class="sticky">');
		expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
		expect(reloadPreview).toHaveBeenCalledOnce();
		expect(checkpointSite).toHaveBeenCalledOnce();
		expect(convergence.currentRevision()).toBe(1);
	});

	it("validates every replacement before writing any file", async () => {
		const { edit, store, sandbox, reloadPreview, checkpointSite, convergence } = batchEditHarness({
			[page]: "<p>price</p>",
			[layout]: "item item",
		});

		await expect(
			edit({
				edits: [
					{ path: "src/pages/index.astro", oldText: "price", newText: "cost" },
					{ path: "src/layouts/SiteLayout.astro", oldText: "item", newText: "card" },
				],
			}),
		).resolves.toMatchObject({
			success: false,
			changed: false,
			error: expect.stringMatching(/more than one place/),
		});

		expect(store.get(page)).toBe("<p>price</p>");
		expect(sandbox.writeFile).not.toHaveBeenCalled();
		expect(reloadPreview).not.toHaveBeenCalled();
		expect(checkpointSite).not.toHaveBeenCalled();
		expect(convergence.currentRevision()).toBe(0);
	});

	it("rolls back every attempted file after an ambiguous write failure", async () => {
		const { edit, store, reloadPreview, checkpointSite } = batchEditHarness(
			{
				[page]: "old page",
				[layout]: "old layout",
			},
			(path, content) => path === layout && content === "new layout",
		);

		await expect(
			edit({
				edits: [
					{ path: "src/pages/index.astro", oldText: "old page", newText: "new page" },
					{
						path: "src/layouts/SiteLayout.astro",
						oldText: "old layout",
						newText: "new layout",
					},
				],
			}),
		).resolves.toMatchObject({
			success: false,
			changed: true,
			error: expect.stringMatching(/rolled back/),
		});

		expect(store.get(page)).toBe("old page");
		expect(store.get(layout)).toBe("old layout");
		expect(reloadPreview).not.toHaveBeenCalled();
		expect(checkpointSite).not.toHaveBeenCalled();
	});

	it("preflights multiple replacements in one file and writes it once", async () => {
		const { edit, store, sandbox, reloadPreview, checkpointSite } = batchEditHarness({
			[page]: "old page price",
		});

		await expect(
			edit({
				edits: [
					{ path: "src/pages/index.astro", oldText: "old", newText: "new" },
					{ path: "./src/pages/index.astro", oldText: "price", newText: "cost" },
				],
			}),
		).resolves.toMatchObject({
			success: true,
			changed: true,
			files: [{ path: "src/pages/index.astro", changed: true }],
		});

		expect(store.get(page)).toBe("new page cost");
		expect(sandbox.readFile).toHaveBeenCalledOnce();
		expect(sandbox.writeFile).toHaveBeenCalledOnce();
		expect(reloadPreview).toHaveBeenCalledOnce();
		expect(checkpointSite).toHaveBeenCalledOnce();
	});

	it("rejects config edits before reading", async () => {
		const { edit, sandbox } = batchEditHarness({ [page]: "old page" });

		await expect(
			edit({
				edits: [
					{ path: "src/pages/index.astro", oldText: "old", newText: "new" },
					{ path: "astro.config.mjs", oldText: "old", newText: "new" },
				],
			}),
		).resolves.toMatchObject({
			success: false,
			changed: false,
			error: expect.stringMatching(/config/),
		});
		expect(sandbox.readFile).not.toHaveBeenCalled();
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});
});

describe("edit_file", () => {
	function editHarness(
		files: Record<string, string>,
		restartDevServer = vi.fn(async () => ({ success: true })),
	) {
		// Resolve paths like the container filesystem does, so unnormalised paths still hit files.
		const store = new Map(Object.entries(files));
		const sandbox = {
			readFile: vi.fn(async (path: string) => {
				const content = store.get(posix.normalize(path));
				return content === undefined ? { success: false } : { success: true, content };
			}),
			writeFile: vi.fn(async (path: string, content: string) => {
				store.set(posix.normalize(path), content);
			}),
		};
		const tools = createTools(
			sandbox as never,
			{
				...toolCallbacks(),
				restartDevServer,
			} as never,
		);
		const edit = tools.edit_file.execute as unknown as (input: {
			path: string;
			oldText: string;
			newText: string;
		}) => Promise<{ success: boolean; error?: string }>;
		return { edit, store, sandbox, restartDevServer };
	}

	const page = "/home/user/site/src/pages/index.astro";

	it("inserts replacement text literally", async () => {
		const { edit, store } = editHarness({ [page]: "<p>price</p>" });

		await expect(
			edit({ path: "src/pages/index.astro", oldText: "price", newText: "$& costs $$5" }),
		).resolves.toMatchObject({ success: true });

		expect(store.get(page)).toBe("<p>$& costs $$5</p>");
	});

	it("refuses text that matches more than once", async () => {
		const { edit, sandbox } = editHarness({ [page]: "<li>Item</li><li>Item</li>" });

		const result = await edit({ path: "src/pages/index.astro", oldText: "Item", newText: "Cake" });

		expect(result).toMatchObject({ success: false });
		expect(result.error).toMatch(/more than one place/);
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});

	it("treats overlapping matches as ambiguous", async () => {
		const { edit, sandbox } = editHarness({ [page]: "aaa" });

		await expect(
			edit({ path: "src/pages/index.astro", oldText: "aa", newText: "b" }),
		).resolves.toMatchObject({ success: false, error: expect.stringMatching(/more than one/) });
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});

	it("refuses an empty search string", async () => {
		const { edit, sandbox } = editHarness({ [page]: "<p>home</p>" });

		await expect(
			edit({ path: "src/pages/index.astro", oldText: "", newText: "prepended" }),
		).resolves.toMatchObject({ success: false, error: expect.stringMatching(/must not be empty/) });
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});

	it("keeps edits inside the site root", async () => {
		const { edit, sandbox } = editHarness({ "/home/user/.bashrc": "export PATH" });

		await expect(
			edit({ path: "../.bashrc", oldText: "export", newText: "unset" }),
		).resolves.toMatchObject({
			success: false,
			error: expect.stringMatching(/inside the site root/),
		});
		expect(sandbox.readFile).not.toHaveBeenCalled();
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});

	it("restarts the preview for an equivalent astro.config.mjs path", async () => {
		const config = "/home/user/site/astro.config.mjs";
		const { edit, store, restartDevServer } = editHarness({ [config]: "fonts: []" });

		await expect(
			edit({ path: "./astro.config.mjs", oldText: "fonts: []", newText: "fonts: [serif]" }),
		).resolves.toMatchObject({ success: true });

		expect(store.get(config)).toBe("fonts: [serif]");
		expect(restartDevServer).toHaveBeenCalledTimes(1);
	});

	it("rolls back an equivalent astro.config.mjs path when the preview fails", async () => {
		const config = "/home/user/site/astro.config.mjs";
		const restartDevServer = vi
			.fn()
			.mockResolvedValueOnce({ success: false, error: "port closed" })
			.mockResolvedValueOnce({ success: true });
		const { edit, store } = editHarness({ [config]: "fonts: []" }, restartDevServer);

		await expect(
			edit({ path: "./astro.config.mjs", oldText: "fonts: []", newText: "fonts: [" }),
		).resolves.toMatchObject({ success: false, error: expect.stringMatching(/rolled back/) });

		expect(store.get(config)).toBe("fonts: []");
		expect(restartDevServer).toHaveBeenCalledTimes(2);
	});
});

describe("protected site files", () => {
	const protectedPaths = [
		"src/worker.ts",
		"./src/live.config.ts",
		"src/../wrangler.jsonc",
		".dev.vars",
		"AGENTS.md",
	];

	function fileTools() {
		const sandbox = {
			readFile: vi.fn(async () => ({ success: true, content: "original" })),
			writeFile: vi.fn(),
		};
		const tools = createTools(sandbox as never, toolCallbacks() as never);
		return {
			sandbox,
			write: tools.write_file.execute as unknown as (input: {
				path: string;
				content: string;
			}) => Promise<{ success: boolean; error?: string }>,
			edit: tools.edit_file.execute as unknown as (input: {
				path: string;
				oldText: string;
				newText: string;
			}) => Promise<{ success: boolean; error?: string }>,
		};
	}

	it.each(protectedPaths)("refuses to write %s", async (path) => {
		const { write, edit, sandbox } = fileTools();

		await expect(write({ path, content: "replaced" })).resolves.toMatchObject({
			success: false,
			error: expect.stringMatching(/protected/),
		});
		await expect(edit({ path, oldText: "original", newText: "replaced" })).resolves.toMatchObject({
			success: false,
			error: expect.stringMatching(/protected/),
		});
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});

	it.each([".dev.vars", "./.dev.vars", ".dev.vars.production"])(
		"refuses to read the runtime env file %s",
		async (path) => {
			const sandbox = { readFile: vi.fn(async () => ({ success: true, content: "SECRET=1" })) };
			const tools = createTools(sandbox as never, toolCallbacks() as never);
			const read = tools.read_file.execute as unknown as (input: {
				path: string;
			}) => Promise<{ success: boolean; content?: string; error?: string }>;

			await expect(read({ path })).resolves.toMatchObject({
				success: false,
				error: expect.stringMatching(/\.dev\.vars/),
			});
			expect(sandbox.readFile).not.toHaveBeenCalled();
		},
	);

	it("keeps whole-file writes inside the site root", async () => {
		const { write, sandbox } = fileTools();

		await expect(write({ path: "../.bashrc", content: "unset PATH" })).resolves.toMatchObject({
			success: false,
			error: expect.stringMatching(/inside the site root/),
		});
		await expect(
			write({ path: "./astro.config.mjs", content: "export default {}" }),
		).resolves.toMatchObject({ success: false, error: expect.stringMatching(/astro\.config/) });
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});

	describe("shell commands", () => {
		let site: string;

		beforeEach(() => {
			site = mkdtempSync(join(tmpdir(), "emdash-protected-"));
			mkdirSync(join(site, "src"));
			writeFileSync(join(site, "wrangler.jsonc"), '{ "name": "site" }');
			writeFileSync(join(site, "AGENTS.md"), "# Guidance");
			writeFileSync(join(site, "src/worker.ts"), "export default {}");
		});

		afterEach(() => {
			rmSync(site, { recursive: true, force: true });
		});

		const run = (command: string) => {
			const tmp = join(site, ".tmp");
			mkdirSync(tmp, { recursive: true });
			const quoted = `'${command.replace(/'/g, `'\\''`)}'`;
			return spawnSync("bash", ["-c", guardProtectedFiles(`bash -c ${quoted}`)], {
				cwd: site,
				encoding: "utf8",
				env: { ...process.env, TMPDIR: tmp },
			});
		};

		it("restores protected files a command changed and keeps its exit status", () => {
			const result = run(
				'echo "{}" > wrangler.jsonc; rm AGENTS.md; mkdir -p src/pages; echo hi > src/pages/index.astro; exit 3',
			);

			expect(result.status).toBe(3);
			expect(readFileSync(join(site, "wrangler.jsonc"), "utf8")).toBe('{ "name": "site" }');
			expect(readFileSync(join(site, "AGENTS.md"), "utf8")).toBe("# Guidance");
			expect(readFileSync(join(site, "src/pages/index.astro"), "utf8")).toBe("hi\n");
			expect(result.stderr).toContain("emdash-build-guard: restored protected file wrangler.jsonc");
			expect(result.stderr).toContain("emdash-build-guard: restored protected file AGENTS.md");
		});

		it("restores a protected file replaced by a directory", () => {
			const result = run("rm AGENTS.md; mkdir AGENTS.md; cd /");

			expect(result.status).toBe(0);
			expect(readFileSync(join(site, "AGENTS.md"), "utf8")).toBe("# Guidance");
		});

		it("says so when a backup was removed", () => {
			const result = run('find "$TMPDIR" -type f -delete; rm AGENTS.md');

			expect(result.stderr).toContain(
				"emdash-build-guard: could not check protected file AGENTS.md: its backup was removed",
			);
		});

		it("restores a protected file replaced by a symlink to a directory", () => {
			const result = run("mkdir other; rm wrangler.jsonc; ln -s other wrangler.jsonc");

			expect(result.stderr).toContain("restored protected file wrangler.jsonc");
			expect(readFileSync(join(site, "wrangler.jsonc"), "utf8")).toBe('{ "name": "site" }');
		});

		it("leaves untouched protected files alone", () => {
			const result = run("cat src/worker.ts");

			expect(result.status).toBe(0);
			expect(result.stdout).toBe("export default {}");
			expect(result.stderr).not.toContain("restored");
		});
	});

	it("reports restored files to the model even when stderr is long", async () => {
		const exec = vi.fn(async () => ({
			success: true,
			exitCode: 0,
			stdout: "",
			stderr: `${"noise\n".repeat(400)}no newline>emdash-build-guard: restored protected file wrangler.jsonc\n`,
		}));
		const tools = createTools({ exec } as never, toolCallbacks() as never);
		const run = tools.exec.execute as unknown as (input: { command: string }) => Promise<unknown>;

		await expect(run({ command: "sed -i s/a/b/ wrangler.jsonc" })).resolves.toMatchObject({
			protectedFiles: ["restored protected file wrangler.jsonc"],
		});
		const [command, options] = exec.mock.calls[0] as unknown as [string, { timeout: number }];
		expect(command).toBe(modelCommand("sed -i s/a/b/ wrangler.jsonc"));
		expect(command.startsWith("{ guard=$(mktemp -d")).toBe(true);
		expect(options.timeout).toBe(MODEL_COMMAND_TIMEOUT_MS);
	});

	it("refuses shell commands while validation is current, so a diagnostic cannot void it", async () => {
		const exec = vi.fn();
		const convergence = new BuildConvergence();
		convergence.recordValidation(convergence.beginObservation()!, { success: true });
		const tools = createTools({ exec } as never, toolCallbacks() as never, { convergence });
		const run = tools.exec.execute as unknown as (input: { command: string }) => Promise<unknown>;

		await expect(run({ command: "curl -s localhost:4321" })).resolves.toMatchObject({
			success: false,
			error: expect.stringContaining("passed validation"),
		});
		expect(exec).not.toHaveBeenCalled();
		expect(convergence.hasCurrentValidation()).toBe(true);
	});

	it("passes Stop to an active sandbox command", async () => {
		const controller = new AbortController();
		const exec = vi.fn(
			(_command: string, options: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
						once: true,
					});
				}),
		);
		const tools = createTools({ exec } as never, toolCallbacks() as never, {
			abortSignal: controller.signal,
		});
		const run = tools.exec.execute as unknown as (input: { command: string }) => Promise<unknown>;

		const pending = run({ command: "sleep 12" });
		await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce());
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(exec.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
	});

	it("refuses local secret variants", async () => {
		const { write, sandbox } = fileTools();

		await expect(
			write({ path: ".dev.vars.production", content: "SECRET=1" }),
		).resolves.toMatchObject({ success: false, error: expect.stringMatching(/protected/) });
		expect(sandbox.writeFile).not.toHaveBeenCalled();
	});
});
