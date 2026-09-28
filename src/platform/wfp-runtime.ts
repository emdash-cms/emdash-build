import { z } from "zod";
import { releaseBundleSchema, type ReleaseBundle } from "./contracts.js";
import {
	WFP_HEALTH_PATH,
	WFP_ASSETS_FORMAT,
	WFP_RELEASE_LIMITS,
	WFP_WORKER_FORMAT,
	resolveWfpReleasePackage,
	type ResolvedWfpRelease,
} from "./wfp-release.js";
import { CloudflareWfpApi, WfpApiError } from "./cloudflare-wfp-api.js";
import { WFP_DISPATCH_LIMITS } from "../worker/site-routing.js";

const uuidSchema = z.string().uuid();
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export class ReleaseArtifactError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ReleaseArtifactError";
	}
}

function canonicalUuid(value: string, label: string): string {
	const result = uuidSchema.safeParse(value);
	if (!result.success) throw new ReleaseArtifactError("INVALID_ID", `${label} must be a UUID.`);
	return result.data.toLowerCase();
}

export function releaseArtifactKey(
	siteIdInput: string,
	releaseIdInput: string,
	kind: "worker" | "assets",
	digestInput: string,
): string {
	const siteId = canonicalUuid(siteIdInput, "Site ID");
	const releaseId = canonicalUuid(releaseIdInput, "Release ID");
	const digest = digestSchema.safeParse(digestInput);
	if (!digest.success)
		throw new ReleaseArtifactError("INVALID_DIGEST", "Artifact digest is invalid.");
	return `wfp-releases/${siteId.replaceAll("-", "")}/${releaseId.replaceAll("-", "")}/${kind}-${digest.data}.json`;
}

export interface ReleaseArtifactReader {
	read(
		siteId: string,
		releaseId: string,
		bundle: ReleaseBundle,
		wrapperVersion?: string,
	): Promise<ResolvedWfpRelease>;
}

export type WfpIdentity =
	| { status: "present"; releaseId: string; uploadDigest: string }
	| { status: "absent" | "unavailable" };

export interface WfpRuntime {
	upload(scriptName: string, release: ResolvedWfpRelease, options: WfpUploadOptions): Promise<void>;
	identity(scriptName: string): Promise<WfpIdentity>;
	health(scriptName: string, path: string): Promise<boolean>;
	delete(scriptName: string): Promise<void>;
}

export interface WfpUploadOptions {
	attempts: number;
	beforeAttempt: () => void;
}

export interface WfpRuntimeEnv {
	WFP_RELEASES: R2Bucket;
	WFP_RUNTIME?: Fetcher;
	WFP_ACCOUNT_ID?: string;
	WFP_API_TOKEN?: string;
	WFP_DISPATCH_NAMESPACE?: string;
	WFP_DISPATCHER?: DispatchNamespace;
}

export class WfpRuntimeError extends Error {
	constructor(
		readonly code: string,
		readonly retryable: boolean,
		readonly ambiguous: boolean,
		readonly status?: number,
		readonly phase?: "asset-session" | "asset-bucket" | "script-upload" | "script-delete",
		readonly mayHaveApplied: boolean = ambiguous,
	) {
		super(code);
		this.name = "WfpRuntimeError";
	}
}

async function smallJson(response: Response, limit = 1024): Promise<unknown> {
	if (!response.body) return undefined;
	const reader = response.body.getReader();
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (text.length + value.length > limit) {
			await reader.cancel();
			return undefined;
		}
		text += new TextDecoder().decode(value, { stream: true });
	}
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

class ServiceWfpRuntime implements WfpRuntime {
	constructor(private readonly service: Fetcher) {}
	async upload(scriptName: string, release: ResolvedWfpRelease, options: WfpUploadOptions) {
		let priorMayHaveApplied = false;
		for (let attempt = 0; attempt < options.attempts; attempt += 1) {
			options.beforeAttempt();
			try {
				const response = await this.service.fetch("https://runtime.internal/upload", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						scriptName,
						releaseId: release.releaseId,
						uploadDigest: release.uploadDigest,
					}),
				});
				if (response.ok) {
					await response.body?.cancel();
					return;
				}
				await response.body?.cancel();
				const ambiguous = response.status === 599;
				const retryable = response.status === 429 || response.status >= 500;
				if (retryable) priorMayHaveApplied = true;
				if (ambiguous || !retryable || attempt === options.attempts - 1) {
					throw new WfpRuntimeError(
						"WFP_UPLOAD_FAILED",
						retryable,
						ambiguous,
						response.status,
						"script-upload",
						priorMayHaveApplied,
					);
				}
			} catch (error) {
				if (error instanceof WfpRuntimeError) throw error;
				throw new WfpRuntimeError(
					"WFP_UPLOAD_FAILED",
					true,
					true,
					undefined,
					"script-upload",
					true,
				);
			}
		}
	}
	async identity(scriptName: string): Promise<WfpIdentity> {
		try {
			const response = await this.service.fetch(
				`https://runtime.internal/identity?script=${encodeURIComponent(scriptName)}`,
			);
			if (response.status === 404) return { status: "absent" };
			if (!response.ok) return { status: "unavailable" };
			const parsed = z
				.object({ releaseId: uuidSchema, uploadDigest: digestSchema })
				.strict()
				.safeParse(await smallJson(response));
			return parsed.success
				? {
						status: "present",
						releaseId: parsed.data.releaseId.toLowerCase(),
						uploadDigest: parsed.data.uploadDigest,
					}
				: { status: "unavailable" };
		} catch {
			return { status: "unavailable" };
		}
	}
	async health(scriptName: string, path: string) {
		try {
			const response = await this.service.fetch(
				`https://runtime.internal/health?script=${encodeURIComponent(scriptName)}&path=${encodeURIComponent(path)}`,
			);
			await response.body?.cancel();
			return response.status === 200;
		} catch {
			return false;
		}
	}
	async delete(scriptName: string) {
		try {
			const response = await this.service.fetch("https://runtime.internal/delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ scriptName }),
			});
			await response.body?.cancel();
			if (!response.ok && response.status !== 404) {
				throw new WfpRuntimeError(
					"WFP_DELETE_FAILED",
					response.status === 429 || response.status >= 500,
					false,
					response.status,
					"script-delete",
				);
			}
		} catch (error) {
			if (error instanceof WfpRuntimeError) throw error;
			throw new WfpRuntimeError("WFP_DELETE_FAILED", true, true, undefined, "script-delete");
		}
	}
}

class DirectWfpRuntime implements WfpRuntime {
	constructor(private readonly env: Required<Omit<WfpRuntimeEnv, "WFP_RUNTIME">>) {}
	async upload(scriptName: string, release: ResolvedWfpRelease, options: WfpUploadOptions) {
		const api = new CloudflareWfpApi({
			accountId: this.env.WFP_ACCOUNT_ID,
			apiToken: this.env.WFP_API_TOKEN,
			dispatchNamespace: this.env.WFP_DISPATCH_NAMESPACE,
			scriptUploadAttempts: options.attempts,
			beforeScriptUploadAttempt: options.beforeAttempt,
		});
		try {
			await api.uploadScript(scriptName, release);
		} catch (error) {
			if (error instanceof WfpApiError)
				throw new WfpRuntimeError(
					error.code,
					error.retryable,
					error.ambiguous,
					error.status,
					error.phase,
					error.mayHaveApplied,
				);
			throw new WfpRuntimeError("WFP_UPLOAD_FAILED", true, true);
		}
	}
	async identity(scriptName: string): Promise<WfpIdentity> {
		let worker: Fetcher;
		try {
			worker = this.env.WFP_DISPATCHER.get(scriptName, {}, WFP_DISPATCH_LIMITS);
		} catch {
			return { status: "absent" };
		}
		try {
			const response = await worker.fetch(
				new Request(`https://runtime.internal${WFP_HEALTH_PATH}`, {
					signal: AbortSignal.timeout(5_000),
				}),
			);
			if (
				response.status !== 200 ||
				response.headers.get("content-type") !== "application/json; charset=utf-8" ||
				response.headers.get("cache-control") !== "no-store"
			) {
				await response.body?.cancel();
				return { status: "unavailable" };
			}
			const parsed = z
				.object({ releaseId: uuidSchema, uploadDigest: digestSchema })
				.strict()
				.safeParse(await smallJson(response, 512));
			return parsed.success
				? {
						status: "present",
						releaseId: parsed.data.releaseId.toLowerCase(),
						uploadDigest: parsed.data.uploadDigest,
					}
				: { status: "unavailable" };
		} catch {
			return { status: "unavailable" };
		}
	}
	async health(scriptName: string, path: string) {
		try {
			const response = await this.env.WFP_DISPATCHER.get(scriptName, {}, WFP_DISPATCH_LIMITS).fetch(
				new Request(`https://runtime.internal${path}`, { signal: AbortSignal.timeout(5_000) }),
			);
			await response.body?.cancel();
			return response.status === 200;
		} catch {
			return false;
		}
	}
	async delete(scriptName: string) {
		const api = new CloudflareWfpApi({
			accountId: this.env.WFP_ACCOUNT_ID,
			apiToken: this.env.WFP_API_TOKEN,
			dispatchNamespace: this.env.WFP_DISPATCH_NAMESPACE,
		});
		try {
			await api.deleteScript(scriptName);
		} catch (error) {
			if (error instanceof WfpApiError) {
				throw new WfpRuntimeError(
					error.code,
					error.retryable,
					error.ambiguous,
					error.status,
					error.phase,
					error.mayHaveApplied,
				);
			}
			throw new WfpRuntimeError("WFP_DELETE_FAILED", true, true, undefined, "script-delete");
		}
	}
}

export function createWfpRuntime(env: WfpRuntimeEnv): WfpRuntime {
	if (env.WFP_RUNTIME) return new ServiceWfpRuntime(env.WFP_RUNTIME);
	if (
		!env.WFP_ACCOUNT_ID ||
		!env.WFP_API_TOKEN ||
		!env.WFP_DISPATCH_NAMESPACE ||
		!env.WFP_DISPATCHER
	) {
		throw new WfpRuntimeError("WFP_NOT_CONFIGURED", false, false);
	}
	return new DirectWfpRuntime(env as Required<Omit<WfpRuntimeEnv, "WFP_RUNTIME">>);
}

interface ReadPlan {
	key: string;
	digest: string;
	byteLength: number;
	maxBytes: number;
}

function planReference(
	siteId: string,
	releaseId: string,
	kind: "worker" | "assets",
	reference: { artifactId: string; digest: string; byteLength: number; formatVersion: string },
): ReadPlan {
	const expectedFormat = kind === "worker" ? WFP_WORKER_FORMAT : WFP_ASSETS_FORMAT;
	const maxBytes =
		kind === "worker" ? WFP_RELEASE_LIMITS.workerObjectBytes : WFP_RELEASE_LIMITS.assetsObjectBytes;
	const key = releaseArtifactKey(siteId, releaseId, kind, reference.digest);
	if (reference.formatVersion !== expectedFormat || reference.artifactId !== key) {
		throw new ReleaseArtifactError(
			"ARTIFACT_PROVENANCE",
			"Artifact reference does not belong to this release.",
		);
	}
	if (reference.byteLength > maxBytes) {
		throw new ReleaseArtifactError(
			"ARTIFACT_TOO_LARGE",
			"Artifact reference exceeds its encoded bound.",
		);
	}
	return { key, digest: reference.digest, byteLength: reference.byteLength, maxBytes };
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
	return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class R2ReleaseArtifactReader implements ReleaseArtifactReader {
	constructor(private readonly bucket: R2Bucket) {}

	async read(
		siteIdInput: string,
		releaseIdInput: string,
		bundleInput: ReleaseBundle,
		wrapperVersion?: string,
	): Promise<ResolvedWfpRelease> {
		const siteId = canonicalUuid(siteIdInput, "Site ID");
		const releaseId = canonicalUuid(releaseIdInput, "Release ID");
		const bundleResult = releaseBundleSchema.safeParse(bundleInput);
		if (!bundleResult.success)
			throw new ReleaseArtifactError("INVALID_BUNDLE", "Release bundle is invalid.");
		const bundle = bundleResult.data;
		if (bundle.cms) {
			throw new ReleaseArtifactError("CMS_TRANSFER_UNSUPPORTED", "CMS transfer is not supported.");
		}
		const workerPlan = planReference(siteId, releaseId, "worker", bundle.worker);
		const assetsPlan = bundle.assets
			? planReference(siteId, releaseId, "assets", bundle.assets)
			: undefined;
		const workerArtifact = await this.readObject(workerPlan);
		const assetsArtifact = assetsPlan ? await this.readObject(assetsPlan) : undefined;
		return resolveWfpReleasePackage({
			siteId,
			releaseId,
			bundle,
			workerArtifact,
			...(assetsArtifact === undefined ? {} : { assetsArtifact }),
			...(wrapperVersion === undefined ? {} : { wrapperVersion }),
		});
	}

	private async readObject(plan: ReadPlan): Promise<unknown> {
		const object = await this.bucket.get(plan.key);
		if (!object)
			throw new ReleaseArtifactError("ARTIFACT_NOT_FOUND", "Release artifact was not found.");
		if (object.size > plan.maxBytes) {
			await object.body.cancel();
			throw new ReleaseArtifactError(
				"ARTIFACT_TOO_LARGE",
				"Stored artifact exceeds its encoded bound.",
			);
		}
		if (object.size !== plan.byteLength) {
			await object.body.cancel();
			throw new ReleaseArtifactError(
				"ARTIFACT_LENGTH_MISMATCH",
				"Stored artifact length does not match.",
			);
		}
		const bytes = new Uint8Array(await object.arrayBuffer());
		if (bytes.length !== plan.byteLength) {
			throw new ReleaseArtifactError(
				"ARTIFACT_LENGTH_MISMATCH",
				"Read artifact length does not match.",
			);
		}
		if ((await sha256(bytes)) !== plan.digest) {
			throw new ReleaseArtifactError(
				"ARTIFACT_DIGEST_MISMATCH",
				"Stored artifact digest does not match.",
			);
		}
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		} catch {
			throw new ReleaseArtifactError(
				"ARTIFACT_INVALID_JSON",
				"Release artifact is not valid JSON.",
			);
		}
	}
}
