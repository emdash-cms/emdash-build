import { z } from "zod";

/** Version of the application-to-provider contract defined in this file. */
export const PROVIDER_CONTRACT_VERSION = 1 as const;

/** Version of the outer release envelope. Artifact formats version independently. */
export const RELEASE_BUNDLE_VERSION = 1 as const;
export const PROVIDER_IDEMPOTENCY_KEY_MAX_LENGTH = 200 as const;

const idSchema = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const principalSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("guest"),
			capabilityId: idSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("account"),
			issuer: idSchema,
			subject: idSchema,
		})
		.strict(),
]);

export type Principal = z.infer<typeof principalSchema>;

export const projectSchema = z
	.object({
		id: idSchema,
		owner: principalSchema,
		builderSessionId: idSchema,
		title: z.string().trim().min(1).max(200),
		state: z.enum(["creating", "ready", "failed", "archived"]),
		siteId: idSchema.optional(),
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
	})
	.strict();

export type Project = z.infer<typeof projectSchema>;

export const siteSchema = z
	.object({
		id: idSchema,
		projectId: idSchema,
		owner: principalSchema,
		state: z.enum(["draft", "published", "archived"]),
		hostname: idSchema.optional(),
		activeReleaseId: idSchema.optional(),
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
	})
	.strict();

export type Site = z.infer<typeof siteSchema>;

const storedArtifactFields = {
	artifactId: idSchema,
	formatVersion: idSchema,
	digest: sha256Schema,
	byteLength: z.number().int().nonnegative(),
};

export const workerArtifactReferenceSchema = z
	.object({
		kind: z.literal("worker-bundle"),
		...storedArtifactFields,
	})
	.strict();

export type WorkerArtifactReference = z.infer<typeof workerArtifactReferenceSchema>;

export const staticAssetsArtifactReferenceSchema = z
	.object({
		kind: z.literal("static-assets"),
		...storedArtifactFields,
	})
	.strict();

export type StaticAssetsArtifactReference = z.infer<typeof staticAssetsArtifactReferenceSchema>;

/**
 * A reference to CMS state produced by EmDash core.
 *
 * The application and provider deliberately know only how to identify, version,
 * and verify the stored bytes. They do not know the artifact's tables, schema,
 * content model, or serialization format.
 */
export const cmsArtifactReferenceSchema = z
	.object({
		kind: z.literal("cms-artifact"),
		...storedArtifactFields,
	})
	.strict();

export type CmsArtifactReference = z.infer<typeof cmsArtifactReferenceSchema>;

export const releaseBundleSchema = z
	.object({
		version: z.literal(RELEASE_BUNDLE_VERSION),
		sourceRevision: idSchema,
		worker: workerArtifactReferenceSchema,
		assets: staticAssetsArtifactReferenceSchema.optional(),
		cms: cmsArtifactReferenceSchema.optional(),
	})
	.strict();

export type ReleaseBundle = z.infer<typeof releaseBundleSchema>;

export const releaseSchema = z
	.object({
		id: idSchema,
		siteId: idSchema,
		state: z.enum(["draft", "deploying", "candidate", "active", "failed", "superseded"]),
		bundle: releaseBundleSchema,
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
	})
	.strict();

export type Release = z.infer<typeof releaseSchema>;

export const providerOperationSchema = z
	.object({
		id: idSchema,
		kind: z.enum([
			"ensure-site",
			"deploy-release",
			"promote-release",
			"rollback-release",
			"set-hostname",
		]),
		status: z.enum(["pending", "running", "succeeded", "failed"]),
		siteId: idSchema,
		releaseId: idSchema.optional(),
		error: z
			.object({
				code: idSchema,
				message: z.string().min(1),
				retryable: z.boolean(),
			})
			.strict()
			.optional(),
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
	})
	.strict();

export type ProviderOperation = z.infer<typeof providerOperationSchema>;

export class ProviderContractError extends Error {
	constructor(
		readonly code: "IDEMPOTENCY_KEY_REUSED" | "INVALID_IDEMPOTENCY_KEY" | "RELEASE_IMMUTABLE",
		message: string,
	) {
		super(message);
		this.name = "ProviderContractError";
	}
}

export const providerOperationReferenceSchema = z
	.object({
		operationId: idSchema,
	})
	.strict();

export type ProviderOperationReference = z.infer<typeof providerOperationReferenceSchema>;

/** Feature names are intentionally extensible without changing the contract envelope. */
export const providerCapabilitiesSchema = z
	.object({
		contractVersion: z.literal(PROVIDER_CONTRACT_VERSION),
		features: z.array(idSchema),
	})
	.strict();

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

interface MutationRequest {
	/** Stable across retries. Reusing it must not create duplicate side effects. */
	readonly idempotencyKey: string;
}

export interface EnsureSiteRequest extends MutationRequest {
	readonly siteId: string;
}

export interface DeployReleaseRequest extends MutationRequest {
	readonly siteId: string;
	readonly releaseId: string;
	readonly bundle: ReleaseBundle;
}

export interface ReleaseMutationRequest extends MutationRequest {
	readonly siteId: string;
	readonly releaseId: string;
}

export interface SetHostnameRequest extends MutationRequest {
	readonly siteId: string;
	readonly hostname: string;
}

export type ProviderMutationRequest =
	| EnsureSiteRequest
	| DeployReleaseRequest
	| ReleaseMutationRequest
	| SetHostnameRequest;

/** Hashes only fixed, validated request fields; caller object key order is irrelevant. */
export async function providerRequestFingerprint(
	kind: ProviderOperation["kind"],
	request: ProviderMutationRequest,
): Promise<string> {
	if (
		request.idempotencyKey.trim().length === 0 ||
		request.idempotencyKey.length > PROVIDER_IDEMPOTENCY_KEY_MAX_LENGTH
	) {
		throw new ProviderContractError(
			"INVALID_IDEMPOTENCY_KEY",
			"Idempotency keys must contain 1 to 200 characters.",
		);
	}
	let input: object;
	switch (kind) {
		case "ensure-site":
			input = { kind, siteId: request.siteId };
			break;
		case "deploy-release": {
			const deploy = request as DeployReleaseRequest;
			input = {
				kind,
				siteId: deploy.siteId,
				releaseId: deploy.releaseId,
				bundle: releaseBundleSchema.parse(deploy.bundle),
			};
			break;
		}
		case "promote-release":
		case "rollback-release": {
			const release = request as ReleaseMutationRequest;
			input = { kind, siteId: release.siteId, releaseId: release.releaseId };
			break;
		}
		case "set-hostname": {
			const hostname = request as SetHostnameRequest;
			input = { kind, siteId: hostname.siteId, hostname: hostname.hostname };
			break;
		}
	}
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(input)),
	);
	return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Provider-neutral deployment boundary.
 *
 * Mutations are asynchronous and idempotent. The adapter owns Cloudflare API
 * details; callers persist and poll the returned operation identifier.
 */
export interface ProviderAdapter {
	getCapabilities(): Promise<ProviderCapabilities>;
	ensureSite(request: EnsureSiteRequest): Promise<ProviderOperationReference>;
	deployRelease(request: DeployReleaseRequest): Promise<ProviderOperationReference>;
	promoteRelease(request: ReleaseMutationRequest): Promise<ProviderOperationReference>;
	rollbackRelease(request: ReleaseMutationRequest): Promise<ProviderOperationReference>;
	setHostname(request: SetHostnameRequest): Promise<ProviderOperationReference>;
	getOperation(operationId: string): Promise<ProviderOperation>;
}
