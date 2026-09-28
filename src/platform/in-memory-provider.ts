import {
	PROVIDER_CONTRACT_VERSION,
	type DeployReleaseRequest,
	type EnsureSiteRequest,
	type ProviderAdapter,
	ProviderContractError,
	releaseBundleSchema,
	type ProviderOperation,
	type ProviderOperationReference,
	type ReleaseMutationRequest,
	type SetHostnameRequest,
	providerRequestFingerprint,
} from "./contracts.js";

interface FixtureRelease {
	fingerprint: string;
	deployable: boolean;
	wasActive: boolean;
}

class FixtureOperationError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

interface FixtureSite {
	hostname?: string;
	candidateReleaseId?: string;
	activeReleaseId?: string;
	releases: Map<string, FixtureRelease>;
}

export interface InMemoryProviderOptions {
	now?: () => string;
	failDeployForRelease?: (releaseId: string) => boolean;
}

/** Deterministic provider used by the UI, lifecycle tests, and failure injection. */
export class InMemoryProviderAdapter implements ProviderAdapter {
	private nextOperation = 1;
	private readonly operations = new Map<string, ProviderOperation>();
	private readonly idempotency = new Map<
		string,
		{ fingerprint: string; reference: ProviderOperationReference }
	>();
	private readonly sites = new Map<string, FixtureSite>();

	constructor(private readonly options: InMemoryProviderOptions = {}) {}

	async getCapabilities() {
		return {
			contractVersion: PROVIDER_CONTRACT_VERSION,
			features: ["candidate-releases", "stable-hostnames", "rollback", "failure-injection"],
		};
	}

	async ensureSite(request: EnsureSiteRequest) {
		return this.mutate("ensure-site", request, undefined, () => {
			if (!this.sites.has(request.siteId)) this.sites.set(request.siteId, { releases: new Map() });
		});
	}

	async deployRelease(request: DeployReleaseRequest) {
		const canonicalRequest = { ...request, bundle: releaseBundleSchema.parse(request.bundle) };
		const fingerprint = await providerRequestFingerprint("deploy-release", canonicalRequest);
		const existing = this.resolveExisting(
			"deploy-release",
			canonicalRequest.siteId,
			canonicalRequest.idempotencyKey,
			fingerprint,
		);
		if (existing) return existing;
		const site = this.requireSite(canonicalRequest.siteId);
		const release = site.releases.get(canonicalRequest.releaseId);
		if (release && release.fingerprint !== fingerprint) {
			throw new ProviderContractError(
				"RELEASE_IMMUTABLE",
				"A release ID cannot identify more than one bundle.",
			);
		}
		return this.mutateWithFingerprint(
			"deploy-release",
			canonicalRequest,
			canonicalRequest.releaseId,
			fingerprint,
			() => {
				if (canonicalRequest.bundle.cms) {
					throw new FixtureOperationError(
						"CMS_TRANSFER_UNSUPPORTED",
						"CMS transfer is not supported by this provider slice.",
						false,
					);
				}
				const storedRelease = site.releases.get(canonicalRequest.releaseId) ?? {
					fingerprint,
					deployable: false,
					wasActive: false,
				};
				site.releases.set(canonicalRequest.releaseId, storedRelease);
				if (this.options.failDeployForRelease?.(canonicalRequest.releaseId)) {
					throw new Error("Injected candidate deployment failure.");
				}
				storedRelease.deployable = true;
				site.candidateReleaseId = canonicalRequest.releaseId;
			},
		);
	}

	async promoteRelease(request: ReleaseMutationRequest) {
		return this.mutate("promote-release", request, request.releaseId, () => {
			const site = this.requireSite(request.siteId);
			if (site.candidateReleaseId !== request.releaseId) {
				throw new Error("Only the validated candidate can be promoted.");
			}
			const release = site.releases.get(request.releaseId);
			if (!release?.deployable) throw new Error("Release is not deployable.");
			release.wasActive = true;
			site.activeReleaseId = request.releaseId;
			site.candidateReleaseId = undefined;
		});
	}

	async rollbackRelease(request: ReleaseMutationRequest) {
		return this.mutate("rollback-release", request, request.releaseId, () => {
			const site = this.requireSite(request.siteId);
			if (!site.releases.get(request.releaseId)?.wasActive)
				throw new Error("Rollback release was never active.");
			site.activeReleaseId = request.releaseId;
		});
	}

	async setHostname(request: SetHostnameRequest) {
		return this.mutate("set-hostname", request, undefined, () => {
			this.requireSite(request.siteId).hostname = request.hostname;
		});
	}

	async getOperation(operationId: string) {
		const operation = this.operations.get(operationId);
		if (!operation) throw new Error(`Unknown operation: ${operationId}`);
		return operation;
	}

	inspectSite(siteId: string) {
		const site = this.requireSite(siteId);
		return {
			hostname: site.hostname,
			candidateReleaseId: site.candidateReleaseId,
			activeReleaseId: site.activeReleaseId,
			releaseIds: [...site.releases.keys()],
		};
	}

	private requireSite(siteId: string): FixtureSite {
		const site = this.sites.get(siteId);
		if (!site) throw new Error(`Site is not provisioned: ${siteId}`);
		return site;
	}

	private resolveExisting(
		kind: ProviderOperation["kind"],
		siteId: string,
		idempotencyKey: string,
		fingerprint: string,
	): ProviderOperationReference | undefined {
		const existing = this.idempotency.get(JSON.stringify([kind, siteId, idempotencyKey]));
		if (!existing) return undefined;
		if (existing.fingerprint !== fingerprint) {
			throw new ProviderContractError(
				"IDEMPOTENCY_KEY_REUSED",
				"An idempotency key cannot be reused for another request.",
			);
		}
		return existing.reference;
	}

	private async mutate(
		kind: ProviderOperation["kind"],
		request: EnsureSiteRequest | DeployReleaseRequest | ReleaseMutationRequest | SetHostnameRequest,
		releaseId: string | undefined,
		mutation: () => void,
	): Promise<ProviderOperationReference> {
		const fingerprint = await providerRequestFingerprint(kind, request);
		return this.mutateWithFingerprint(kind, request, releaseId, fingerprint, mutation);
	}

	private mutateWithFingerprint(
		kind: ProviderOperation["kind"],
		request: EnsureSiteRequest | DeployReleaseRequest | ReleaseMutationRequest | SetHostnameRequest,
		releaseId: string | undefined,
		fingerprint: string,
		mutation: () => void,
	): ProviderOperationReference {
		const key = JSON.stringify([kind, request.siteId, request.idempotencyKey]);
		const existing = this.resolveExisting(
			kind,
			request.siteId,
			request.idempotencyKey,
			fingerprint,
		);
		if (existing) return existing;

		const id = `operation-${this.nextOperation++}`;
		const now = this.options.now?.() ?? new Date().toISOString();
		let failure: Error | undefined;
		try {
			mutation();
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		}
		const operation: ProviderOperation = {
			id,
			kind,
			status: failure ? "failed" : "succeeded",
			siteId: request.siteId,
			...(releaseId ? { releaseId } : {}),
			...(failure
				? {
						error: {
							code:
								failure instanceof FixtureOperationError
									? failure.code
									: "fixture-operation-failed",
							message: failure.message,
							retryable: failure instanceof FixtureOperationError ? failure.retryable : true,
						},
					}
				: {}),
			createdAt: now,
			updatedAt: now,
		};
		const reference = { operationId: id };
		this.operations.set(id, operation);
		this.idempotency.set(key, { fingerprint, reference });
		return reference;
	}
}
