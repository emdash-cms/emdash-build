import { describe, expect, it } from "vitest";
import {
	INITIAL_SCAFFOLD_PATHS,
	InitialScaffoldPrefetch,
	createInitialScaffoldContext,
} from "../src/worker/initial-scaffold.js";
import { drainProvisionTasks } from "../src/worker/provisioning.js";
import { buildBuildPrompt } from "../src/worker/prompts.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("initial scaffold context", () => {
	it("uses only the fixed source-owned allowlist", () => {
		expect(INITIAL_SCAFFOLD_PATHS).toEqual([
			"AGENTS.md",
			"src/components/ui/README.md",
			"src/layouts/SiteLayout.astro",
			"src/styles/global.css",
			"src/pages/index.astro",
			"package.json",
		]);
		expect(INITIAL_SCAFFOLD_PATHS.join("\n")).not.toMatch(
			/\.dev\.vars|\.wrangler|node_modules|\.git/,
		);
	});

	it("renders AGENTS guidance once and delimits the remaining source snapshot", () => {
		const context = createInitialScaffoldContext({
			success: true,
			files: [
				{ path: "AGENTS.md", success: true, content: "Guidance marker." },
				{
					path: "src/pages/index.astro",
					success: true,
					content: "<main>Blank</main>",
				},
				{ path: "src/styles/global.css", success: false, error: "missing" },
			],
		});
		const prompt = buildBuildPrompt({
			templateGuidance: context.templateGuidance,
			initialScaffoldContext: context,
		});

		expect(prompt.match(/Guidance marker\./g)).toHaveLength(1);
		expect(prompt).toContain("Initial blank-scaffold snapshot");
		expect(prompt).toContain(
			'<file path="src/pages/index.astro" bytes="18">\n<main>Blank</main>\n</file>',
		);
		expect(prompt).not.toContain('<file path="AGENTS.md"');
		expect(prompt).toContain("Missing from the snapshot: src/styles/global.css");
		expect(prompt).toContain("one `read_files` call");
		expect(prompt).toContain("write them together with `write_files`");
		expect(prompt).toContain("use `edit_files`");
	});

	it("does not add blank-scaffold context to ordinary follow-up prompts", () => {
		const prompt = buildBuildPrompt({ templateGuidance: "Existing guidance." });
		expect(prompt).not.toContain("Initial blank-scaffold snapshot");
		expect(prompt).not.toContain("Missing from the snapshot");
	});

	it("keeps stale prefetches from publishing or replacing the current promise", async () => {
		const first = deferred<ReturnType<typeof createInitialScaffoldContext>>();
		const second = deferred<ReturnType<typeof createInitialScaffoldContext>>();
		const signals: AbortSignal[] = [];
		const published: string[] = [];
		const prefetch = new InitialScaffoldPrefetch();
		const oldPromise = prefetch.start(
			(signal) => {
				signals.push(signal);
				return first.promise;
			},
			(context) => published.push(context.templateGuidance ?? "old-empty"),
		);
		const currentPromise = prefetch.start(
			(signal) => {
				signals.push(signal);
				return second.promise;
			},
			(context) => published.push(context.templateGuidance ?? "new-empty"),
		);

		expect(signals[0]?.aborted).toBe(true);
		expect(prefetch.current()).toBe(currentPromise);
		first.resolve(
			createInitialScaffoldContext({
				success: true,
				files: [{ path: "AGENTS.md", success: true, content: "stale" }],
			}),
		);
		await oldPromise;
		expect(published).toEqual([]);
		expect(prefetch.current()).toBe(currentPromise);

		second.resolve(
			createInitialScaffoldContext({
				success: true,
				files: [{ path: "AGENTS.md", success: true, content: "current" }],
			}),
		);
		await currentPromise;
		expect(published).toEqual(["current"]);
	});

	it("invalidates a canceled prefetch so a retry loads fresh context", async () => {
		const first = deferred<ReturnType<typeof createInitialScaffoldContext>>();
		const prefetch = new InitialScaffoldPrefetch();
		let signal!: AbortSignal;
		const stale = prefetch.start(
			(nextSignal) => {
				signal = nextSignal;
				return first.promise;
			},
			() => {},
		);

		prefetch.cancel();
		expect(signal.aborted).toBe(true);
		expect(prefetch.current()).toBeUndefined();

		first.resolve(createInitialScaffoldContext({ success: true, files: [] }));
		await stale;
		const fresh = prefetch.start(
			async () =>
				createInitialScaffoldContext({
					success: true,
					files: [{ path: "AGENTS.md", success: true, content: "fresh" }],
				}),
			() => {},
		);
		await expect(fresh).resolves.toMatchObject({ templateGuidance: "fresh" });
	});
});

describe("provision preparation", () => {
	it("drains every required branch before reporting a failure", async () => {
		const failed = deferred<void>();
		const slow = deferred<void>();
		let finished = false;
		const preparation = drainProvisionTasks([failed.promise, slow.promise]).finally(() => {
			finished = true;
		});

		failed.reject(new Error("write failed"));
		await Promise.resolve();
		expect(finished).toBe(false);
		slow.resolve();
		await expect(preparation).rejects.toThrow("write failed");
		expect(finished).toBe(true);
	});
});
