import { describe, expect, it, vi } from "vitest";
import {
	canonicalizeSiteReadPath,
	createTools,
	readFilesFromSandbox,
} from "../src/worker/tools.js";

const encoder = new TextEncoder();

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function byteStream(
	chunks: readonly Uint8Array[],
	onCancel?: () => void,
	close = true,
): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			if (close) controller.close();
		},
		cancel() {
			onCancel?.();
		},
	});
}

/** A file's raw bytes, as the Sandbox port streams them. */
function fileStream(
	chunks: readonly (string | Uint8Array)[],
	options: { close?: boolean; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
	return byteStream(
		chunks.map((chunk) => (typeof chunk === "string" ? encoder.encode(chunk) : chunk)),
		options.onCancel,
		options.close !== false,
	);
}

function errorStream(error: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.error(new Error(error));
		},
	});
}

function readFiles(
	sandbox: unknown,
	paths: readonly string[],
	options: { signal?: AbortSignal; timeoutSignal?: (timeoutMs: number) => AbortSignal } = {},
) {
	return readFilesFromSandbox(sandbox as never, paths, options);
}

function callbacks() {
	return {
		reloadPreview: async () => {},
		checkpointSite: async () => {},
		restartDevServer: async () => ({ success: true }),
		offerClone: () => ({ success: true }),
		capturePreview: async () => ({ ok: false as const, error: "unused" }),
	};
}

function executeReadFiles(sandbox: unknown) {
	const execute = createTools(sandbox as never, callbacks()).read_files.execute as (
		input: { paths: string[] },
		options: { abortSignal?: AbortSignal },
	) => Promise<unknown>;
	return execute;
}

describe("site read paths", () => {
	it("canonicalizes ordinary relative paths without treating backslashes as separators", () => {
		expect(canonicalizeSiteReadPath("./src//pages/./index.astro")).toEqual({
			path: "src/pages/index.astro",
			fullPath: "/home/user/site/src/pages/index.astro",
		});
		expect(canonicalizeSiteReadPath("src\\pages\\index.astro").path).toBe(
			"src\\pages\\index.astro",
		);
	});

	it.each(["", "/etc/passwd", "../secret", "src/../../secret", "a\0b"])(
		"rejects unsafe path %j",
		(path) => {
			expect(() => canonicalizeSiteReadPath(path)).toThrow();
		},
	);

	it("uses the canonical path for the existing single-file tool", async () => {
		const readFile = vi.fn(async (path: string) => ({ success: true, content: path }));
		const execute = createTools({ readFile } as never, callbacks()).read_file.execute as (
			input: { path: string },
			options: object,
		) => Promise<unknown>;

		await expect(execute({ path: "./src//pages/index.astro" }, {})).resolves.toMatchObject({
			success: true,
			path: "src/pages/index.astro",
		});
		expect(readFile).toHaveBeenCalledWith("/home/user/site/src/pages/index.astro", {
			encoding: "utf-8",
		});
	});
});

describe("bounded concurrent file reads", () => {
	it("validates duplicates and excluded trees before opening a stream", async () => {
		const readFileStream = vi.fn();
		const duplicate = await readFiles({ readFileStream }, [
			"src//pages/index.astro",
			"src/pages/index.astro",
		]);
		const excluded = await readFiles({ readFileStream }, [".git/config"]);

		expect(duplicate.success).toBe(false);
		expect(excluded.success).toBe(false);
		expect(readFileStream).not.toHaveBeenCalled();
	});

	it("rejects more than twelve paths before opening a stream", async () => {
		const readFileStream = vi.fn();
		const result = await readFiles(
			{ readFileStream },
			Array.from({ length: 13 }, (_, index) => `${index}.txt`),
		);
		expect(result.success).toBe(false);
		expect(readFileStream).not.toHaveBeenCalled();
	});

	it("uses the transport-neutral streaming API instead of the RPC-only raw mode", async () => {
		const readFile = vi.fn(() => {
			throw new Error("readFile with encoding: 'none' requires the rpc transport");
		});
		const readFileStream = vi.fn(async () => fileStream(["hello"]));

		await expect(readFiles({ readFile, readFileStream }, ["hello.txt"])).resolves.toMatchObject({
			success: true,
			files: [{ path: "hello.txt", success: true, content: "hello" }],
		});
		expect(readFileStream).toHaveBeenCalledWith("/home/user/site/hello.txt");
		expect(readFile).not.toHaveBeenCalled();
	});

	it("decodes UTF-8 split across chunks", async () => {
		const source = '---\nconst title = "Crème & Co.";\n---\n<h1>{title}</h1>\n';
		const bytes = encoder.encode(source);
		const split = bytes.indexOf(0xc3) + 1;
		const readFileStream = vi.fn(async () =>
			fileStream([bytes.slice(0, split), bytes.slice(split)]),
		);

		await expect(readFiles({ readFileStream }, ["src/pages/index.astro"])).resolves.toMatchObject({
			success: true,
			files: [{ path: "src/pages/index.astro", success: true, content: source }],
		});
	});

	it("starts a batch concurrently and preserves input order", async () => {
		const opens = new Map<string, ReturnType<typeof deferred<ReadableStream<Uint8Array>>>>();
		const started: string[] = [];
		const sandbox = {
			readFileStream(path: string) {
				started.push(path);
				const pending = deferred<ReadableStream<Uint8Array>>();
				opens.set(path, pending);
				return pending.promise;
			},
		};

		const resultPromise = readFiles(sandbox, ["a.txt", "b.txt", "c.txt"]);
		await Promise.resolve();
		expect(started).toEqual([
			"/home/user/site/a.txt",
			"/home/user/site/b.txt",
			"/home/user/site/c.txt",
		]);

		opens.get("/home/user/site/c.txt")!.resolve(fileStream(["third"]));
		opens.get("/home/user/site/a.txt")!.resolve(fileStream(["first"]));
		opens.get("/home/user/site/b.txt")!.resolve(fileStream(["second"]));

		await expect(resultPromise).resolves.toMatchObject({
			success: true,
			files: [
				{ path: "a.txt", success: true, content: "first" },
				{ path: "b.txt", success: true, content: "second" },
				{ path: "c.txt", success: true, content: "third" },
			],
		});
	});

	it("reports thrown and resolved failures without discarding successful files", async () => {
		const sandbox = {
			async readFileStream(path: string) {
				if (path.endsWith("throw.txt")) throw new Error("transport failed");
				if (path.endsWith("missing.txt")) return errorStream("missing");
				return fileStream(["ok"]);
			},
		};

		await expect(readFiles(sandbox, ["ok.txt", "throw.txt", "missing.txt"])).resolves.toMatchObject(
			{
				success: true,
				files: [
					{ path: "ok.txt", success: true, content: "ok" },
					{ path: "throw.txt", success: false },
					{ path: "missing.txt", success: false },
				],
			},
		);
	});

	it("does not hide a runtime replacement as a missing file", async () => {
		const interrupted = Object.assign(new Error("runtime replaced"), {
			code: "OPERATION_INTERRUPTED",
			context: { reason: "runtime_replaced" },
		});
		await expect(
			readFiles({ readFileStream: async () => Promise.reject(interrupted) }, ["page.astro"]),
		).rejects.toBe(interrupted);
	});

	it("serializes sibling batches and skips an aborted queued batch", async () => {
		const firstOpen = deferred<ReadableStream<Uint8Array>>();
		const opened: string[] = [];
		const sandbox = {
			readFileStream(path: string) {
				opened.push(path);
				return path.endsWith("first.txt")
					? firstOpen.promise
					: Promise.resolve(fileStream(["second"]));
			},
		};
		const execute = executeReadFiles(sandbox);
		const first = execute({ paths: ["first.txt"] }, {});
		const second = execute({ paths: ["second.txt"] }, {});
		const aborted = new AbortController();
		const third = execute({ paths: ["never.txt"] }, { abortSignal: aborted.signal });

		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(opened).toEqual(["/home/user/site/first.txt"]);
		aborted.abort();
		firstOpen.resolve(fileStream(["first"]));
		await first;
		await second;
		await expect(third).resolves.toMatchObject({ success: false });
		expect(opened).toEqual(["/home/user/site/first.txt", "/home/user/site/second.txt"]);
	});

	it("returns from a never-closing stream when aborted and cancels its reader", async () => {
		let cancelled = false;
		const stream = fileStream(["partial"], {
			close: false,
			onCancel: () => (cancelled = true),
		});
		const controller = new AbortController();
		const pending = readFiles({ readFileStream: async () => stream }, ["open.txt"], {
			signal: controller.signal,
		});
		await Promise.resolve();
		await Promise.resolve();
		controller.abort();

		await expect(pending).resolves.toMatchObject({
			success: false,
			files: [{ path: "open.txt", success: false }],
		});
		expect(cancelled).toBe(true);
	});

	it("uses controlled per-file deadlines without wall-clock sleeps", async () => {
		const batchDeadline = new AbortController();
		const fileDeadline = new AbortController();
		const timeoutSignal = vi
			.fn()
			.mockReturnValueOnce(batchDeadline.signal)
			.mockReturnValueOnce(fileDeadline.signal);
		const pending = readFiles({ readFileStream: () => new Promise(() => {}) }, ["slow.txt"], {
			timeoutSignal,
		});
		await Promise.resolve();
		fileDeadline.abort();

		await expect(pending).resolves.toMatchObject({ success: false });
		expect(timeoutSignal).toHaveBeenNthCalledWith(1, 10_000);
		expect(timeoutSignal).toHaveBeenNthCalledWith(2, 5_000);
	});

	it("applies one controlled deadline to the whole batch", async () => {
		const batchDeadline = new AbortController();
		const fileDeadlines = [new AbortController(), new AbortController()];
		const timeoutSignal = vi
			.fn()
			.mockReturnValueOnce(batchDeadline.signal)
			.mockReturnValueOnce(fileDeadlines[0]!.signal)
			.mockReturnValueOnce(fileDeadlines[1]!.signal);
		const pending = readFiles(
			{ readFileStream: () => new Promise(() => {}) },
			["one.txt", "two.txt"],
			{ timeoutSignal },
		);
		await Promise.resolve();
		batchDeadline.abort();

		await expect(pending).resolves.toMatchObject({
			success: false,
			files: [{ success: false }, { success: false }],
		});
	});

	it("cancels a stream that opens only after the request has aborted", async () => {
		const open = deferred<ReadableStream<Uint8Array>>();
		const controller = new AbortController();
		let cancelled = false;
		const pending = readFiles({ readFileStream: () => open.promise }, ["late.txt"], {
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort();
		await expect(pending).resolves.toMatchObject({ success: false });

		open.resolve(fileStream(["late"], { onCancel: () => (cancelled = true) }));
		await Promise.resolve();
		await Promise.resolve();
		expect(cancelled).toBe(true);
	});

	it("enforces byte, binary, NUL, and aggregate content bounds", async () => {
		let oversizedCancelled = false;
		const exactMultibyte = "é".repeat(24 * 1024);
		const sandbox = {
			async readFileStream(path: string) {
				if (path.endsWith("exact.txt")) return fileStream([exactMultibyte]);
				if (path.endsWith("large.txt")) {
					return fileStream(["a".repeat(48 * 1024 + 1)], {
						close: false,
						onCancel: () => (oversizedCancelled = true),
					});
				}
				if (path.endsWith("invalid.txt")) {
					return fileStream([new Uint8Array([0xc3, 0x28])]);
				}
				if (path.endsWith("nul.txt")) {
					return fileStream(["A\0B"]);
				}
				return fileStream(["A".repeat(48 * 1024)]);
			},
		};

		const bounded = await readFiles(sandbox, ["exact.txt", "large.txt", "invalid.txt", "nul.txt"]);
		expect(bounded.files).toMatchObject([
			{ path: "exact.txt", success: true, content: exactMultibyte },
			{ path: "large.txt", success: false },
			{ path: "invalid.txt", success: false },
			{ path: "nul.txt", success: false },
		]);
		expect(oversizedCancelled).toBe(true);

		const aggregate = await readFiles(sandbox, ["one.txt", "two.txt", "three.txt"]);
		expect(aggregate.files.map((file) => file.success)).toEqual([true, true, false]);
	});
});
