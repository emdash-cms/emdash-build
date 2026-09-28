import { z } from "zod";
import { releaseBundleSchema, type ReleaseBundle } from "./contracts.js";

export const WFP_COMPATIBILITY_DATE = "2026-03-24" as const;
export const WFP_WRAPPER_VERSION = "emdash-wrapper-v1" as const;
export const WFP_WORKER_FORMAT = "wfp-worker-v1" as const;
export const WFP_ASSETS_FORMAT = "wfp-assets-v1" as const;
export const WFP_HEALTH_PATH = "/_emdash/control-plane/health" as const;

export const WFP_RELEASE_LIMITS = {
	modules: 64,
	moduleName: 256,
	moduleBytes: 4 * 1024 * 1024,
	totalModuleBytes: 8 * 1024 * 1024,
	assets: 256,
	assetPath: 512,
	assetBytes: 4 * 1024 * 1024,
	totalAssetBytes: 16 * 1024 * 1024,
	totalReleaseBytes: 24 * 1024 * 1024,
	workerObjectBytes: 12 * 1024 * 1024,
	assetsObjectBytes: 24 * 1024 * 1024,
} as const;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const uuidSchema = z.string().uuid();
const encodedFileFields = {
	base64: z.string(),
	digest: digestSchema,
	byteLength: z.number().int().nonnegative(),
};
const workerArtifactSchema = z
	.object({
		version: z.literal(WFP_WORKER_FORMAT),
		kind: z.literal("worker"),
		siteId: uuidSchema,
		releaseId: uuidSchema,
		sourceRevision: z.string().trim().min(1),
		mainModule: z
			.string()
			.min(1)
			.max(WFP_RELEASE_LIMITS.moduleName + 2),
		modules: z
			.array(
				z
					.object({
						name: z.string().min(1).max(WFP_RELEASE_LIMITS.moduleName),
						type: z.enum(["esm", "commonjs", "text", "data", "wasm"]),
						...encodedFileFields,
					})
					.strict(),
			)
			.min(1)
			.max(WFP_RELEASE_LIMITS.modules),
		compatibilityDate: z.literal(WFP_COMPATIBILITY_DATE),
		compatibilityFlags: z.array(z.literal("nodejs_compat")).max(1),
		bindingIntents: z.array(z.literal("ASSETS")).max(1),
		healthPath: z.string().min(1),
	})
	.strict();
const assetsArtifactSchema = z
	.object({
		version: z.literal(WFP_ASSETS_FORMAT),
		kind: z.literal("assets"),
		siteId: uuidSchema,
		releaseId: uuidSchema,
		assets: z
			.array(
				z
					.object({
						path: z.string().min(1).max(WFP_RELEASE_LIMITS.assetPath),
						...encodedFileFields,
					})
					.strict(),
			)
			.max(WFP_RELEASE_LIMITS.assets),
	})
	.strict();

type ModuleType = z.infer<typeof workerArtifactSchema>["modules"][number]["type"];

export class WfpReleaseError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "WfpReleaseError";
	}
}

export interface ResolvedWfpRelease {
	readonly siteId: string;
	readonly releaseId: string;
	readonly sourceRevision: string;
	readonly mainModule: string;
	readonly compatibilityDate: typeof WFP_COMPATIBILITY_DATE;
	readonly compatibilityFlags: readonly "nodejs_compat"[];
	readonly bindingIntents: readonly "ASSETS"[];
	readonly healthPath: string;
	readonly uploadDigest: string;
	readonly wrapperVersion: typeof WFP_WRAPPER_VERSION;
	readonly wrapperBytes: Uint8Array;
	readonly modules: ReadonlyArray<{
		name: string;
		type: ModuleType;
		bytes: Uint8Array;
		digest: string;
	}>;
	readonly assets: ReadonlyArray<{ path: string; bytes: Uint8Array; digest: string }>;
}

function fail(code: string, message: string): never {
	throw new WfpReleaseError(code, message);
}

export function canonicalWfpUuid(value: string, label = "UUID"): string {
	const parsed = uuidSchema.safeParse(value);
	if (!parsed.success) fail("INVALID_ID", `${label} must be a UUID.`);
	return parsed.data.toLowerCase();
}

function safePath(value: string, label: string): string {
	if (
		!value.split("/").every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment)) ||
		value.includes("\\") ||
		value.includes("..")
	) {
		fail("INVALID_PATH", `${label} is not a safe relative path.`);
	}
	return value;
}

function base64Value(code: number): number {
	if (code >= 65 && code <= 90) return code - 65;
	if (code >= 97 && code <= 122) return code - 71;
	if (code >= 48 && code <= 57) return code + 4;
	if (code === 43) return 62;
	if (code === 47) return 63;
	return -1;
}

function isCanonicalBase64(value: string): boolean {
	if (value.length === 0) return true;
	if (value.length % 4 !== 0) return false;
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	for (let index = 0; index < value.length - padding; index += 1) {
		if (base64Value(value.charCodeAt(index)) < 0) return false;
	}
	if (padding === 2 && (base64Value(value.charCodeAt(value.length - 3)) & 15) !== 0) return false;
	if (padding === 1 && (base64Value(value.charCodeAt(value.length - 2)) & 3) !== 0) return false;
	return true;
}

function decodeBase64(value: string, maxBytes: number, label: string): Uint8Array<ArrayBuffer> {
	if (value.length > Math.ceil(maxBytes / 3) * 4 || !isCanonicalBase64(value)) {
		fail("INVALID_BASE64", `${label} is not bounded canonical base64.`);
	}
	try {
		return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
	} catch {
		return fail("INVALID_BASE64", `${label} is not valid base64.`);
	}
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
	return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function verifyFile(
	file: { base64: string; byteLength: number; digest: string },
	maxBytes: number,
	label: string,
): Promise<Uint8Array> {
	if (file.byteLength > maxBytes) fail("FILE_TOO_LARGE", `${label} exceeds its byte limit.`);
	const bytes = decodeBase64(file.base64, maxBytes, label);
	if (bytes.length !== file.byteLength) fail("LENGTH_MISMATCH", `${label} length does not match.`);
	if ((await sha256(bytes)) !== file.digest)
		fail("DIGEST_MISMATCH", `${label} digest does not match.`);
	return bytes;
}

function trustedWrapper(mainModule: string, version: string): Uint8Array {
	if (version !== WFP_WRAPPER_VERSION) fail("UNSUPPORTED_WRAPPER", "Unsupported wrapper version.");
	const source = `import userWorker from ${JSON.stringify(mainModule)};
export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === ${JSON.stringify(WFP_HEALTH_PATH)}) {
      return new Response(JSON.stringify({ releaseId: env.EMDASH_RELEASE_ID, uploadDigest: env.EMDASH_UPLOAD_DIGEST }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }
    return userWorker.fetch(request, env, ctx);
  },
};
`;
	return new TextEncoder().encode(source);
}

export async function resolveWfpReleasePackage(input: {
	siteId: string;
	releaseId: string;
	bundle: ReleaseBundle;
	workerArtifact: unknown;
	assetsArtifact?: unknown;
	wrapperVersion?: string;
}): Promise<ResolvedWfpRelease> {
	const siteId = canonicalWfpUuid(input.siteId, "Site ID");
	const releaseId = canonicalWfpUuid(input.releaseId, "Release ID");
	const bundleResult = releaseBundleSchema.safeParse(input.bundle);
	if (!bundleResult.success) fail("INVALID_BUNDLE", "Release bundle is invalid.");
	const bundle = bundleResult.data;
	if (bundle.worker.formatVersion !== WFP_WORKER_FORMAT) {
		fail("UNSUPPORTED_FORMAT", "Worker artifact format is unsupported.");
	}
	if (bundle.assets && bundle.assets.formatVersion !== WFP_ASSETS_FORMAT) {
		fail("UNSUPPORTED_FORMAT", "Assets artifact format is unsupported.");
	}
	const workerResult = workerArtifactSchema.safeParse(input.workerArtifact);
	if (!workerResult.success)
		fail("INVALID_WORKER", "Worker artifact does not match the v1 schema.");
	const worker = workerResult.data;
	if (
		canonicalWfpUuid(worker.siteId, "Worker Site ID") !== siteId ||
		canonicalWfpUuid(worker.releaseId, "Worker Release ID") !== releaseId ||
		worker.sourceRevision !== bundle.sourceRevision
	) {
		fail("ARTIFACT_PROVENANCE", "Worker artifact does not belong to this release.");
	}
	const assetsResult = input.assetsArtifact
		? assetsArtifactSchema.safeParse(input.assetsArtifact)
		: undefined;
	if (assetsResult && !assetsResult.success)
		fail("INVALID_ASSETS", "Assets do not match the v1 schema.");
	const assets = assetsResult?.data;
	const hasAssetsIntent = worker.bindingIntents.includes("ASSETS");
	if (Boolean(bundle.assets) !== Boolean(assets) || Boolean(assets) !== hasAssetsIntent) {
		fail("ASSETS_MISMATCH", "ASSETS intent, reference, and artifact must agree.");
	}
	if (
		assets &&
		(canonicalWfpUuid(assets.siteId, "Assets Site ID") !== siteId ||
			canonicalWfpUuid(assets.releaseId, "Assets Release ID") !== releaseId)
	) {
		fail("ARTIFACT_PROVENANCE", "Assets do not belong to this release.");
	}
	if (worker.modules.some(({ byteLength }) => byteLength > WFP_RELEASE_LIMITS.moduleBytes)) {
		fail("FILE_TOO_LARGE", "A module exceeds its byte limit.");
	}
	if (
		worker.modules.reduce((total, { byteLength }) => total + byteLength, 0) >
		WFP_RELEASE_LIMITS.totalModuleBytes
	) {
		fail("MODULES_TOO_LARGE", "Decoded modules exceed the release limit.");
	}
	if (assets?.assets.some(({ byteLength }) => byteLength > WFP_RELEASE_LIMITS.assetBytes)) {
		fail("FILE_TOO_LARGE", "An asset exceeds its byte limit.");
	}
	if (
		(assets?.assets.reduce((total, { byteLength }) => total + byteLength, 0) ?? 0) >
		WFP_RELEASE_LIMITS.totalAssetBytes
	) {
		fail("ASSETS_TOO_LARGE", "Decoded assets exceed the release limit.");
	}

	const mainModule = worker.mainModule.startsWith("./")
		? `./${safePath(worker.mainModule.slice(2), "Main module")}`
		: fail("INVALID_MAIN", "Main module must be a relative specifier.");
	const names = new Set<string>();
	const modules = [] as Array<ResolvedWfpRelease["modules"][number]>;
	let moduleBytes = 0;
	for (const module of worker.modules) {
		const name = safePath(module.name, "Module name");
		if (name === "__emdash_entry.mjs")
			fail("RESERVED_MODULE", "The wrapper module name is reserved.");
		if (names.has(name)) fail("DUPLICATE_MODULE", "Module names must be unique.");
		names.add(name);
		const bytes = await verifyFile(module, WFP_RELEASE_LIMITS.moduleBytes, `Module ${name}`);
		moduleBytes += bytes.length;
		modules.push({ name, type: module.type, bytes, digest: module.digest });
	}
	const entry = modules.find(({ name }) => `./${name}` === mainModule);
	if (!entry || entry.type !== "esm") fail("INVALID_MAIN", "Main module must name an ESM module.");
	if (moduleBytes > WFP_RELEASE_LIMITS.totalModuleBytes) {
		fail("MODULES_TOO_LARGE", "Decoded modules exceed the release limit.");
	}
	const normalizedHealthPath = new URL(worker.healthPath, "https://emdash.invalid").pathname;
	if (
		!/^\/(?!\/)[^?#\\\u0000-\u001f]*$/.test(worker.healthPath) ||
		normalizedHealthPath !== worker.healthPath ||
		normalizedHealthPath === WFP_HEALTH_PATH
	) {
		fail("INVALID_HEALTH_PATH", "Health path must be same-origin and non-reserved.");
	}

	const paths = new Set<string>();
	const resolvedAssets = [] as Array<ResolvedWfpRelease["assets"][number]>;
	let assetBytes = 0;
	for (const asset of assets?.assets ?? []) {
		const path = safePath(asset.path, "Asset path");
		if (paths.has(path)) fail("DUPLICATE_ASSET", "Asset paths must be unique.");
		paths.add(path);
		const bytes = await verifyFile(asset, WFP_RELEASE_LIMITS.assetBytes, `Asset ${path}`);
		assetBytes += bytes.length;
		resolvedAssets.push({ path, bytes, digest: asset.digest });
	}
	if (assetBytes > WFP_RELEASE_LIMITS.totalAssetBytes) {
		fail("ASSETS_TOO_LARGE", "Decoded assets exceed the release limit.");
	}
	if (moduleBytes + assetBytes > WFP_RELEASE_LIMITS.totalReleaseBytes) {
		fail("RELEASE_TOO_LARGE", "Decoded release exceeds the release limit.");
	}

	const wrapperVersion = input.wrapperVersion ?? WFP_WRAPPER_VERSION;
	const wrapperBytes = trustedWrapper(mainModule, wrapperVersion);
	const uploadDigest = await sha256(
		new TextEncoder().encode(
			`emdash-wfp-upload-v1\0${JSON.stringify({
				siteId,
				releaseId,
				sourceRevision: worker.sourceRevision,
				mainModule,
				modules: modules.map(({ name, type, digest }) => ({ name, type, digest })),
				assets: resolvedAssets.map(({ path, digest }) => ({ path, digest })),
				compatibilityDate: worker.compatibilityDate,
				compatibilityFlags: worker.compatibilityFlags,
				bindingIntents: worker.bindingIntents,
				healthPath: worker.healthPath,
				wrapperVersion,
				wrapperSource: new TextDecoder().decode(wrapperBytes),
				releaseBinding: "EMDASH_RELEASE_ID",
				uploadBinding: "<EMDASH_UPLOAD_DIGEST>",
			})}`,
		),
	);
	return {
		siteId,
		releaseId,
		sourceRevision: worker.sourceRevision,
		mainModule,
		compatibilityDate: worker.compatibilityDate,
		compatibilityFlags: worker.compatibilityFlags,
		bindingIntents: worker.bindingIntents,
		healthPath: worker.healthPath,
		uploadDigest,
		wrapperVersion: WFP_WRAPPER_VERSION,
		wrapperBytes,
		modules,
		assets: resolvedAssets,
	};
}

function base32(bytes: Uint8Array): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	let output = "";
	let value = 0;
	let bits = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	return output;
}

async function identityHash(value: string): Promise<string> {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return base32(new Uint8Array(bytes)).slice(0, 20);
}

export async function deriveWfpProviderIdentity(
	siteIdInput: string,
	releaseIdInput: string,
	sitesHostname: string,
): Promise<{ candidateScript: string; liveScript: string; hostname: string }> {
	const siteId = canonicalWfpUuid(siteIdInput, "Site ID");
	const releaseId = canonicalWfpUuid(releaseIdInput, "Release ID");
	if (
		sitesHostname.length > 253 ||
		!sitesHostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
	) {
		fail("INVALID_HOSTNAME", "Sites hostname is invalid.");
	}
	const compactSiteId = siteId.replaceAll("-", "");
	const hostname = `s-${compactSiteId}.${sitesHostname}`;
	if (hostname.length > 253) fail("INVALID_HOSTNAME", "Derived site hostname is too long.");
	return {
		candidateScript: `e-${await identityHash(siteId)}-r-${await identityHash(releaseId)}`,
		liveScript: `e-${compactSiteId}-live`,
		hostname,
	};
}
