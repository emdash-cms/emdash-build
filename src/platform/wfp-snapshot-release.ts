import { RELEASE_BUNDLE_VERSION, type ReleaseBundle } from "./contracts.js";
import {
	WFP_ASSETS_FORMAT,
	WFP_COMPATIBILITY_DATE,
	WFP_RELEASE_LIMITS,
	WFP_WORKER_FORMAT,
	resolveWfpReleasePackage,
	type ResolvedWfpRelease,
} from "./wfp-release.js";
import { releaseArtifactKey } from "./wfp-runtime.js";
import type { StaticSiteSnapshot } from "../worker/static-site-snapshot.js";

export const SNAPSHOT_HEALTH_PATH = "/_emdash/control-plane/snapshot-health" as const;

interface EncodedFile {
	base64: string;
	digest: string;
	byteLength: number;
}

export interface WfpSnapshotWorkerArtifact {
	version: typeof WFP_WORKER_FORMAT;
	kind: "worker";
	siteId: string;
	releaseId: string;
	sourceRevision: string;
	mainModule: "./src/index.js";
	modules: Array<EncodedFile & { name: "src/index.js"; type: "esm" }>;
	compatibilityDate: typeof WFP_COMPATIBILITY_DATE;
	compatibilityFlags: ["nodejs_compat"];
	bindingIntents: ["ASSETS"];
	healthPath: typeof SNAPSHOT_HEALTH_PATH;
}

export interface WfpSnapshotAssetsArtifact {
	version: typeof WFP_ASSETS_FORMAT;
	kind: "assets";
	siteId: string;
	releaseId: string;
	assets: Array<EncodedFile & { path: string }>;
}

export interface WfpSnapshotRelease {
	bundle: ReleaseBundle;
	workerArtifact: WfpSnapshotWorkerArtifact;
	assetsArtifact: WfpSnapshotAssetsArtifact;
	workerBytes: Uint8Array;
	assetsBytes: Uint8Array;
	resolved: ResolvedWfpRelease;
}

export class WfpSnapshotReleaseError extends Error {
	constructor(
		readonly code: "SNAPSHOT_INVALID" | "ARTIFACT_IMMUTABLE" | "ARTIFACT_CAPACITY",
		message: string,
	) {
		super(message);
		this.name = "WfpSnapshotReleaseError";
	}
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer));
	return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function encodedFile(bytes: Uint8Array): Promise<EncodedFile> {
	return {
		base64: encodeBase64(bytes),
		digest: await sha256(bytes),
		byteLength: bytes.length,
	};
}

function trustedWorkerSource(snapshot: StaticSiteSnapshot): string {
	const assetPaths = new Set(snapshot.assets.map(({ path }) => path));
	for (const route of snapshot.routes) {
		if (route.kind === "page" && !assetPaths.has(route.assetPath)) {
			throw new WfpSnapshotReleaseError(
				"SNAPSHOT_INVALID",
				`Snapshot route ${route.path} has no captured page asset.`,
			);
		}
	}
	const routes = snapshot.routes
		.map((route) =>
			route.kind === "page"
				? [route.path, { kind: "page", assetPath: `/${route.assetPath}` }]
				: [route.path, { kind: "redirect", status: route.status, location: route.location }],
		)
		.sort(([left], [right]) => String(left).localeCompare(String(right)));
	const assets = snapshot.assets.map(({ path }) => `/${path}`).sort();
	const routeLiteral = JSON.stringify(routes).replace(/[\u2028\u2029]/g, (value) =>
		value === "\u2028" ? "\\u2028" : "\\u2029",
	);
	const assetLiteral = JSON.stringify(assets).replace(/[\u2028\u2029]/g, (value) =>
		value === "\u2028" ? "\\u2028" : "\\u2029",
	);
	return `const ROUTES = new Map(${routeLiteral});
const ASSETS = new Set(${assetLiteral});
const HEALTH_PATH = ${JSON.stringify(SNAPSHOT_HEALTH_PATH)};
const LIVE_ORIGIN = ${JSON.stringify(snapshot.liveOrigin)};

function assetRequest(request, path, method = request.method) {
  return new Request(new URL(path, request.url), { method, headers: request.headers });
}

function healthPage() {
  let path = "/";
  const seen = new Set();
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (seen.has(path)) return;
    seen.add(path);
    const route = ROUTES.get(path);
    if (route?.kind === "page") return route;
    if (route?.kind !== "redirect") return;
    const target = new URL(route.location, new URL(path, LIVE_ORIGIN));
    if (target.origin !== LIVE_ORIGIN) return;
    path = target.pathname;
  }
}

export default {
  async fetch(request, env) {
	const url = new URL(request.url);
	if (url.pathname === HEALTH_PATH) {
	  const home = healthPage();
	  if (!home) return new Response(null, { status: 503 });
      const response = await env.ASSETS.fetch(assetRequest(request, home.assetPath, "GET"));
      await response.body?.cancel();
      return new Response(null, {
        status: response.ok ? 200 : 503,
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const route = ROUTES.get(url.pathname);
    if (route?.kind === "redirect") {
      return new Response(null, { status: route.status, headers: { location: route.location } });
    }
    const assetPath = route?.kind === "page" ? route.assetPath : url.pathname;
    if (!ASSETS.has(assetPath)) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(assetRequest(request, assetPath));
  },
};
`;
}

export async function buildWfpSnapshotRelease(
	snapshot: StaticSiteSnapshot,
): Promise<WfpSnapshotRelease> {
	const moduleBytes = new TextEncoder().encode(trustedWorkerSource(snapshot));
	const workerArtifact: WfpSnapshotWorkerArtifact = {
		version: WFP_WORKER_FORMAT,
		kind: "worker",
		siteId: snapshot.siteId,
		releaseId: snapshot.releaseId,
		sourceRevision: snapshot.sourceRevision,
		mainModule: "./src/index.js",
		modules: [
			{
				name: "src/index.js",
				type: "esm",
				...(await encodedFile(moduleBytes)),
			},
		],
		compatibilityDate: WFP_COMPATIBILITY_DATE,
		compatibilityFlags: ["nodejs_compat"],
		bindingIntents: ["ASSETS"],
		healthPath: SNAPSHOT_HEALTH_PATH,
	};
	const assets = [] as WfpSnapshotAssetsArtifact["assets"];
	for (const asset of [...snapshot.assets].sort((left, right) =>
		left.path.localeCompare(right.path),
	)) {
		const digest = await sha256(asset.bytes);
		if (digest !== asset.digest) {
			throw new WfpSnapshotReleaseError(
				"SNAPSHOT_INVALID",
				`Snapshot asset /${asset.path} changed after capture.`,
			);
		}
		assets.push({ path: asset.path, ...(await encodedFile(asset.bytes)) });
	}
	const assetsArtifact: WfpSnapshotAssetsArtifact = {
		version: WFP_ASSETS_FORMAT,
		kind: "assets",
		siteId: snapshot.siteId,
		releaseId: snapshot.releaseId,
		assets,
	};
	const workerBytes = new TextEncoder().encode(JSON.stringify(workerArtifact));
	const assetsBytes = new TextEncoder().encode(JSON.stringify(assetsArtifact));
	if (
		workerBytes.length > WFP_RELEASE_LIMITS.workerObjectBytes ||
		assetsBytes.length > WFP_RELEASE_LIMITS.assetsObjectBytes
	) {
		throw new WfpSnapshotReleaseError(
			"SNAPSHOT_INVALID",
			"Encoded release artifacts are too large.",
		);
	}
	const workerDigest = await sha256(workerBytes);
	const assetsDigest = await sha256(assetsBytes);
	const bundle: ReleaseBundle = {
		version: RELEASE_BUNDLE_VERSION,
		sourceRevision: snapshot.sourceRevision,
		worker: {
			kind: "worker-bundle",
			artifactId: releaseArtifactKey(snapshot.siteId, snapshot.releaseId, "worker", workerDigest),
			formatVersion: WFP_WORKER_FORMAT,
			digest: workerDigest,
			byteLength: workerBytes.length,
		},
		assets: {
			kind: "static-assets",
			artifactId: releaseArtifactKey(snapshot.siteId, snapshot.releaseId, "assets", assetsDigest),
			formatVersion: WFP_ASSETS_FORMAT,
			digest: assetsDigest,
			byteLength: assetsBytes.length,
		},
	};
	const resolved = await resolveWfpReleasePackage({
		siteId: snapshot.siteId,
		releaseId: snapshot.releaseId,
		bundle,
		workerArtifact,
		assetsArtifact,
	});
	return { bundle, workerArtifact, assetsArtifact, workerBytes, assetsBytes, resolved };
}

async function ensureArtifact(
	bucket: R2Bucket,
	key: string,
	bytes: Uint8Array,
	digest: string,
): Promise<void> {
	const existing = await bucket.get(key);
	if (existing) {
		if (existing.size !== bytes.length) {
			await existing.body.cancel();
			throw new WfpSnapshotReleaseError(
				"ARTIFACT_IMMUTABLE",
				"A release artifact key already contains different bytes.",
			);
		}
		const stored = new Uint8Array(await existing.arrayBuffer());
		if ((await sha256(stored)) !== digest) {
			throw new WfpSnapshotReleaseError(
				"ARTIFACT_IMMUTABLE",
				"A release artifact key already contains different bytes.",
			);
		}
		return;
	}
	await bucket.put(key, bytes);
}

export async function storeWfpSnapshotRelease(
	bucket: R2Bucket,
	release: WfpSnapshotRelease,
): Promise<void> {
	const prefix = `wfp-releases/${release.resolved.siteId.replaceAll("-", "")}/`;
	const listed = await bucket.list({ prefix, limit: 41 });
	const existingKeys = new Set(listed.objects.map(({ key }) => key));
	const missing = [release.bundle.worker.artifactId, release.bundle.assets!.artifactId].filter(
		(key) => !existingKeys.has(key),
	).length;
	if (listed.truncated || listed.objects.length + missing > 40) {
		throw new WfpSnapshotReleaseError(
			"ARTIFACT_CAPACITY",
			"This Site has reached the retained release-artifact limit.",
		);
	}
	await ensureArtifact(
		bucket,
		release.bundle.worker.artifactId,
		release.workerBytes,
		release.bundle.worker.digest,
	);
	await ensureArtifact(
		bucket,
		release.bundle.assets!.artifactId,
		release.assetsBytes,
		release.bundle.assets!.digest,
	);
}
