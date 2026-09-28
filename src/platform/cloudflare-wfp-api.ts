import { z } from "zod";
import type { ResolvedWfpRelease } from "./wfp-release.js";

const API_ORIGIN = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 64 * 1024;
const sessionSchema = z
	.object({
		success: z.literal(true),
		result: z
			.object({
				jwt: z.string().min(1).max(4096),
				buckets: z
					.array(z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(256))
					.max(256)
					.optional(),
			})
			.strict(),
	})
	.passthrough();
const completionSchema = z
	.object({
		success: z.literal(true),
		result: z.object({ jwt: z.string().min(1).max(4096) }).strict(),
	})
	.passthrough();

export interface CloudflareWfpApiOptions {
	accountId: string;
	apiToken: string;
	dispatchNamespace: string;
	fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	requestTimeoutMs?: number;
	operationTimeoutMs?: number;
	retryDelaysMs?: readonly number[];
	scriptUploadAttempts?: number;
	beforeScriptUploadAttempt?: () => void;
	sleep?: (delayMs: number) => Promise<void>;
	now?: () => number;
}

export class WfpApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable: boolean,
		readonly ambiguous: boolean,
		readonly status?: number,
		readonly phase?: RequestPhase,
		readonly mayHaveApplied: boolean = ambiguous,
	) {
		super(message);
		this.name = "WfpApiError";
	}
}

type RequestPhase = "asset-session" | "asset-bucket" | "script-upload" | "script-delete";

function providerName(value: string, label: string): string {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
		throw new WfpApiError("WFP_INVALID_CONFIG", `${label} is invalid.`, false, false);
	}
	return value;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return btoa(binary);
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
	if (
		bytes.buffer instanceof ArrayBuffer &&
		bytes.byteOffset === 0 &&
		bytes.byteLength === bytes.buffer.byteLength
	) {
		return bytes.buffer;
	}
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	return copy.buffer;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function assetHash(siteId: string, bytes: Uint8Array): Promise<string> {
	const salt = new TextEncoder().encode(`${siteId}\0`);
	const input = new Uint8Array(salt.length + bytes.length);
	input.set(salt);
	input.set(bytes, salt.length);
	return (await sha256(input)).slice(0, 32);
}

async function boundedJson(response: Response): Promise<unknown> {
	if (!response.body)
		throw new WfpApiError("WFP_INVALID_RESPONSE", "Provider response was empty.", false, false);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.length;
		if (length > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new WfpApiError(
				"WFP_INVALID_RESPONSE",
				"Provider response exceeded its bound.",
				false,
				false,
			);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new WfpApiError(
			"WFP_INVALID_RESPONSE",
			"Provider response was invalid JSON.",
			false,
			false,
		);
	}
}

function contentType(type: ResolvedWfpRelease["modules"][number]["type"]): string {
	switch (type) {
		case "esm":
			return "application/javascript+module";
		case "commonjs":
			return "application/javascript";
		case "text":
			return "text/plain";
		case "wasm":
			return "application/wasm";
		case "data":
			return "application/octet-stream";
	}
}

function assetContentType(path: string): string {
	const extension = path.split(".").pop()?.toLowerCase();
	return (
		{
			html: "text/html",
			css: "text/css",
			js: "application/javascript",
			json: "application/json",
			svg: "image/svg+xml",
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			webp: "image/webp",
			avif: "image/avif",
			ico: "image/x-icon",
			woff: "font/woff",
			woff2: "font/woff2",
			ttf: "font/ttf",
			otf: "font/otf",
			wasm: "application/wasm",
			pdf: "application/pdf",
			txt: "text/plain",
		}[extension ?? ""] ?? "application/octet-stream"
	);
}

export class CloudflareWfpApi {
	private readonly accountId: string;
	private readonly apiToken: string;
	private readonly dispatchNamespace: string;
	private readonly fetcher: NonNullable<CloudflareWfpApiOptions["fetch"]>;
	private readonly requestTimeoutMs: number;
	private readonly operationTimeoutMs: number;
	private readonly retryDelaysMs: readonly number[];
	private readonly scriptUploadAttempts: number;
	private readonly beforeScriptUploadAttempt: () => void;
	private readonly sleep: (delayMs: number) => Promise<void>;
	private readonly now: () => number;

	constructor(options: CloudflareWfpApiOptions) {
		if (!/^[a-f0-9]{32}$/.test(options.accountId)) {
			throw new WfpApiError("WFP_INVALID_CONFIG", "Account ID is invalid.", false, false);
		}
		if (!options.apiToken || options.apiToken.length > 4096) {
			throw new WfpApiError("WFP_INVALID_CONFIG", "API token is invalid.", false, false);
		}
		this.accountId = options.accountId;
		this.apiToken = options.apiToken;
		this.dispatchNamespace = providerName(options.dispatchNamespace, "Dispatch namespace");
		this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.operationTimeoutMs = options.operationTimeoutMs ?? 120_000;
		this.retryDelaysMs = options.retryDelaysMs ?? [250, 1_000];
		this.scriptUploadAttempts = options.scriptUploadAttempts ?? this.retryDelaysMs.length + 1;
		this.beforeScriptUploadAttempt = options.beforeScriptUploadAttempt ?? (() => undefined);
		this.sleep =
			options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
		this.now = options.now ?? Date.now;
		if (
			this.requestTimeoutMs <= 0 ||
			this.requestTimeoutMs > 30_000 ||
			this.operationTimeoutMs <= 0 ||
			this.operationTimeoutMs > 120_000 ||
			this.retryDelaysMs.length > 2 ||
			!Number.isInteger(this.scriptUploadAttempts) ||
			this.scriptUploadAttempts < 1 ||
			this.scriptUploadAttempts > 3 ||
			this.retryDelaysMs.some((delay) => delay < 0 || delay > 2_000)
		) {
			throw new WfpApiError(
				"WFP_INVALID_CONFIG",
				"Retry or timeout bounds are invalid.",
				false,
				false,
			);
		}
	}

	async uploadScript(scriptNameInput: string, release: ResolvedWfpRelease): Promise<void> {
		const scriptName = providerName(scriptNameInput, "Script name");
		const deadline = this.now() + this.operationTimeoutMs;
		const base = `${API_ORIGIN}/accounts/${encodeURIComponent(this.accountId)}/workers`;
		const scriptUrl = `${base}/dispatch/namespaces/${encodeURIComponent(this.dispatchNamespace)}/scripts/${encodeURIComponent(scriptName)}`;
		let completionJwt: string | undefined;

		if (release.bindingIntents.includes("ASSETS")) {
			const assets = new Map<string, ResolvedWfpRelease["assets"][number]>();
			const manifest: Record<string, { hash: string; size: number }> = {};
			for (const asset of release.assets) {
				const hash = await assetHash(release.siteId, asset.bytes);
				assets.set(hash, asset);
				manifest[`/${asset.path}`] = { hash, size: asset.bytes.length };
			}
			const sessionBody = await this.request(
				"asset-session",
				`${scriptUrl}/assets-upload-session`,
				deadline,
				() => ({
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.apiToken}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ manifest }),
				}),
				boundedJson,
			);
			const parsedSession = sessionSchema.safeParse(sessionBody);
			if (!parsedSession.success) {
				throw new WfpApiError(
					"WFP_INVALID_RESPONSE",
					"Asset session response was invalid.",
					false,
					false,
				);
			}
			const seen = new Set<string>();
			const buckets = parsedSession.data.result.buckets ?? [];
			completionJwt = buckets.length === 0 ? parsedSession.data.result.jwt : undefined;
			for (const bucket of buckets) {
				const form = new FormData();
				for (const hash of bucket) {
					const asset = assets.get(hash);
					if (!asset || seen.has(hash)) {
						throw new WfpApiError(
							"WFP_INVALID_RESPONSE",
							"Asset session requested an unknown hash.",
							false,
							false,
						);
					}
					seen.add(hash);
					form.append(
						hash,
						new Blob([encodeBase64(asset.bytes)], { type: assetContentType(asset.path) }),
						hash,
					);
				}
				const uploadResult = await this.request(
					"asset-bucket",
					`${base}/assets/upload?base64=true`,
					deadline,
					() => ({
						method: "POST",
						headers: { Authorization: `Bearer ${parsedSession.data.result.jwt}` },
						body: form,
					}),
					async (response) => {
						if (response.status === 201) {
							return { status: response.status, body: await boundedJson(response) };
						}
						try {
							await response.body?.cancel();
						} catch {}
						return { status: response.status };
					},
				);
				if (uploadResult.status === 201) {
					const parsedCompletion = completionSchema.safeParse(uploadResult.body);
					if (!parsedCompletion.success) {
						throw new WfpApiError(
							"WFP_INVALID_RESPONSE",
							"Asset completion response was invalid.",
							false,
							false,
						);
					}
					completionJwt = parsedCompletion.data.result.jwt;
				}
			}
			if (!completionJwt) {
				throw new WfpApiError(
					"WFP_INVALID_RESPONSE",
					"Asset upload did not return a completion token.",
					false,
					false,
				);
			}
		}

		const createForm = () => {
			const form = new FormData();
			const bindings: Array<Record<string, string>> = [
				{ type: "plain_text", name: "EMDASH_RELEASE_ID", text: release.releaseId },
				{ type: "plain_text", name: "EMDASH_UPLOAD_DIGEST", text: release.uploadDigest },
			];
			if (release.bindingIntents.includes("ASSETS"))
				bindings.push({ type: "assets", name: "ASSETS" });
			form.append(
				"metadata",
				new Blob(
					[
						JSON.stringify({
							main_module: "__emdash_entry.mjs",
							compatibility_date: release.compatibilityDate,
							compatibility_flags: release.compatibilityFlags,
							bindings,
							...(completionJwt
								? { assets: { jwt: completionJwt, config: { run_worker_first: true } } }
								: {}),
						}),
					],
					{ type: "application/json" },
				),
				"metadata.json",
			);
			form.append(
				"__emdash_entry.mjs",
				new Blob([blobPart(release.wrapperBytes)], { type: "application/javascript+module" }),
				"__emdash_entry.mjs",
			);
			for (const module of release.modules) {
				form.append(
					module.name,
					new Blob([blobPart(module.bytes)], { type: contentType(module.type) }),
					module.name,
				);
			}
			return form;
		};
		await this.request(
			"script-upload",
			scriptUrl,
			deadline,
			() => ({
				method: "PUT",
				headers: { Authorization: `Bearer ${this.apiToken}` },
				body: createForm(),
			}),
			async (response) => {
				try {
					await response.body?.cancel();
				} catch {}
			},
		);
	}

	async deleteScript(scriptNameInput: string): Promise<void> {
		const scriptName = providerName(scriptNameInput, "Script name");
		const deadline = this.now() + this.operationTimeoutMs;
		const url = `${API_ORIGIN}/accounts/${encodeURIComponent(this.accountId)}/workers/dispatch/namespaces/${encodeURIComponent(this.dispatchNamespace)}/scripts/${encodeURIComponent(scriptName)}`;
		await this.request(
			"script-delete",
			url,
			deadline,
			() => ({
				method: "DELETE",
				headers: { Authorization: `Bearer ${this.apiToken}` },
			}),
			async (response) => {
				await response.body?.cancel().catch(() => undefined);
			},
			(response) => response.ok || response.status === 404,
		);
	}

	private async request<Result>(
		phase: RequestPhase,
		url: string,
		deadline: number,
		init: () => RequestInit,
		consume: (response: Response) => Promise<Result>,
		accept: (response: Response) => boolean = (response) => response.ok,
	): Promise<Result> {
		const attempts =
			phase === "script-upload" ? this.scriptUploadAttempts : this.retryDelaysMs.length + 1;
		let priorAmbiguous = false;
		let priorMayHaveApplied = false;
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const remaining = deadline - this.now();
			if (remaining <= 0) {
				throw new WfpApiError(
					"WFP_OPERATION_TIMEOUT",
					"WfP operation timed out.",
					true,
					priorAmbiguous,
					undefined,
					phase,
					priorMayHaveApplied,
				);
			}
			if (phase === "script-upload") this.beforeScriptUploadAttempt();
			const controller = new AbortController();
			const timeout = setTimeout(
				() => controller.abort(new DOMException("WfP request timed out.", "AbortError")),
				Math.min(this.requestTimeoutMs, remaining),
			);
			try {
				const response = await this.fetcher(url, { ...init(), signal: controller.signal });
				if (accept(response)) return await consume(response);
				await response.body?.cancel();
				const retryable = response.status === 429 || response.status >= 500;
				if (phase === "script-upload" && retryable) priorMayHaveApplied = true;
				if (!retryable || attempt === attempts - 1) {
					throw new WfpApiError(
						"WFP_HTTP_ERROR",
						`Cloudflare WfP request failed with status ${response.status}.`,
						retryable,
						phase === "script-upload" && priorAmbiguous,
						response.status,
						phase,
						priorMayHaveApplied,
					);
				}
			} catch (error) {
				if (error instanceof WfpApiError) throw error;
				if (phase === "script-upload") {
					priorAmbiguous = true;
					priorMayHaveApplied = true;
				}
				if (attempt === attempts - 1) {
					const timedOut = controller.signal.aborted;
					throw new WfpApiError(
						timedOut ? "WFP_TIMEOUT" : "WFP_NETWORK_ERROR",
						timedOut
							? "Cloudflare WfP request timed out."
							: "Cloudflare WfP network request failed.",
						true,
						phase === "script-upload",
						undefined,
						phase,
						phase === "script-upload",
					);
				}
			} finally {
				clearTimeout(timeout);
			}
			await this.sleep(this.retryDelaysMs[attempt] ?? 0);
		}
		throw new WfpApiError("WFP_INTERNAL", "Cloudflare WfP request failed.", false, false);
	}
}
