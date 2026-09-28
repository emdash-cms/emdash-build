import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
	providerOperationSchema,
	providerRequestFingerprint,
	releaseBundleSchema,
	type DeployReleaseRequest,
	type EnsureSiteRequest,
	type ProviderOperation,
	type ProviderOperationReference,
	type ReleaseMutationRequest,
	type SetHostnameRequest,
} from "../platform/contracts.js";
import { deriveWfpProviderIdentity, WFP_WRAPPER_VERSION } from "../platform/wfp-release.js";
import {
	R2ReleaseArtifactReader,
	WfpRuntimeError,
	createWfpRuntime,
	type WfpIdentity,
	type WfpRuntime,
	type WfpRuntimeEnv,
} from "../platform/wfp-runtime.js";

interface ControlPlaneEnv extends WfpRuntimeEnv {
	SITES_HOSTNAME?: string;
}

interface OperationRow extends Record<string, SqlStorageValue> {
	id: string;
	site_id: string;
	release_id: string | null;
	kind: ProviderOperation["kind"];
	status: ProviderOperation["status"];
	idempotency_key: string;
	request_hash: string;
	phase: string;
	put_attempts: number;
	error_code: string | null;
	error_message: string | null;
	retryable: number | null;
	created_at: string;
	updated_at: string;
}

interface SiteRow extends Record<string, SqlStorageValue> {
	site_id: string;
	hostname: string;
	candidate_release_id: string | null;
	candidate_operation_id: string | null;
	active_release_id: string | null;
	live_operation_id: string | null;
}

interface ReleaseRow extends Record<string, SqlStorageValue> {
	release_id: string;
	bundle_json: string;
	request_hash: string;
	wrapper_version: string | null;
	upload_digest: string | null;
	candidate_script: string;
	state: string;
}

export class ProviderControlPlaneError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "ProviderControlPlaneError";
	}
}

const uuid = z.string().uuid();
const MAX_RELEASES = 20;
const MAX_OPERATIONS = 200;
const MAX_PUT_ATTEMPTS = 5;
const MAX_INVOCATION_PUT_ATTEMPTS = 3;
const CANDIDATE_HEALTH_RETRY_DELAYS_MS = [0, 250, 750] as const;

function canonicalId(value: string, label: string) {
	const result = uuid.safeParse(value);
	if (!result.success)
		throw new ProviderControlPlaneError("INVALID_ID", `${label} must be a UUID.`);
	return result.data.toLowerCase();
}

function reference(id: string): ProviderOperationReference {
	return { operationId: id };
}

function logWfpRuntimeFailure(
	operation: "candidate-upload" | "live-upload",
	siteId: string,
	releaseId: string,
	error: unknown,
): void {
	const runtimeError = error instanceof WfpRuntimeError ? error : undefined;
	console.error(
		JSON.stringify({
			event: "builder.wfp_runtime_failure",
			operation,
			siteId,
			releaseId,
			code: runtimeError?.code ?? "WFP_UNEXPECTED_ERROR",
			status: runtimeError?.status ?? null,
			phase: runtimeError?.phase ?? null,
			retryable: runtimeError?.retryable ?? false,
			ambiguous: runtimeError?.ambiguous ?? false,
			mayHaveApplied: runtimeError?.mayHaveApplied ?? false,
		}),
	);
}

export type ControlPlaneRpcResult<T> = { ok: true; value: T } | { ok: false; code: string };

function matches(identity: WfpIdentity, releaseId: string, digest: string) {
	return (
		identity.status === "present" &&
		identity.releaseId === releaseId &&
		identity.uploadDigest === digest
	);
}

async function waitForCandidateHealth(runtime: WfpRuntime, scriptName: string, path: string) {
	for (const delay of CANDIDATE_HEALTH_RETRY_DELAYS_MS) {
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
		if (await runtime.health(scriptName, path)) return true;
	}
	return false;
}

export class ProviderControlPlane extends DurableObject<ControlPlaneEnv> {
	private tail: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: ControlPlaneEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				PRAGMA foreign_keys = ON;
				CREATE TABLE IF NOT EXISTS sites (
					site_id TEXT PRIMARY KEY, hostname TEXT NOT NULL,
					candidate_release_id TEXT, candidate_operation_id TEXT,
					active_release_id TEXT, live_operation_id TEXT,
					created_at TEXT NOT NULL, updated_at TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS releases (
					site_id TEXT NOT NULL, release_id TEXT NOT NULL, bundle_json TEXT NOT NULL,
					request_hash TEXT NOT NULL, wrapper_version TEXT, upload_digest TEXT,
					candidate_script TEXT NOT NULL, state TEXT NOT NULL,
					checked_at TEXT, failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
					PRIMARY KEY (site_id, release_id), FOREIGN KEY (site_id) REFERENCES sites(site_id)
				);
				CREATE TABLE IF NOT EXISTS operations (
					id TEXT PRIMARY KEY, site_id TEXT NOT NULL, release_id TEXT, kind TEXT NOT NULL,
					status TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
					phase TEXT NOT NULL, put_attempts INTEGER NOT NULL DEFAULT 0,
					error_code TEXT, error_message TEXT, retryable INTEGER,
					created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
					UNIQUE (site_id, kind, idempotency_key),
					FOREIGN KEY (site_id) REFERENCES sites(site_id)
				);
			`);
		});
	}

	async ensureSite(request: EnsureSiteRequest) {
		return this.rpc(() => this.ensureSiteImpl(request));
	}

	private async ensureSiteImpl(request: EnsureSiteRequest) {
		return this.serial(async () => {
			const siteId = canonicalId(request.siteId, "Site ID");
			const canonical = { ...request, siteId };
			const hash = await providerRequestFingerprint("ensure-site", canonical);
			const existing = this.existing("ensure-site", siteId, request.idempotencyKey, hash);
			if (existing) return reference(existing.id);
			this.ensureOperationCapacity();
			const now = new Date().toISOString();
			const hostname = `s-${siteId.replaceAll("-", "")}.${this.env.SITES_HOSTNAME ?? "sites.test"}`;
			return reference(
				this.ctx.storage.transactionSync(() => {
					this.ctx.storage.sql.exec(
						"INSERT OR IGNORE INTO sites (site_id, hostname, created_at, updated_at) VALUES (?, ?, ?, ?)",
						siteId,
						hostname,
						now,
						now,
					);
					return this.insertOperation(
						"ensure-site",
						siteId,
						null,
						request.idempotencyKey,
						hash,
						"succeeded",
						"commit",
						now,
					);
				}),
			);
		});
	}

	async deployRelease(request: DeployReleaseRequest) {
		return this.rpc(() => this.deployReleaseImpl(request));
	}

	private async deployReleaseImpl(request: DeployReleaseRequest) {
		return this.serial(async () => {
			const siteId = canonicalId(request.siteId, "Site ID");
			const releaseId = canonicalId(request.releaseId, "Release ID");
			const bundle = releaseBundleSchema.parse(request.bundle);
			const canonical = { ...request, siteId, releaseId, bundle };
			this.site(siteId);
			const hash = await providerRequestFingerprint("deploy-release", canonical);
			let operation = this.existing("deploy-release", siteId, request.idempotencyKey, hash);
			if (operation && operation.status !== "running") return reference(operation.id);
			if (!operation && bundle.cms) {
				this.ensureOperationCapacity();
				return reference(
					this.insertFailed(
						"deploy-release",
						siteId,
						releaseId,
						request.idempotencyKey,
						hash,
						"CMS_TRANSFER_UNSUPPORTED",
					),
				);
			}
			if (!operation) {
				this.ensureOperationCapacity();
				const site = this.site(siteId);
				const prior = this.release(siteId, releaseId);
				if (prior && prior.request_hash !== hash) {
					throw new ProviderControlPlaneError(
						"RELEASE_IMMUTABLE",
						"Release ID is already bound to another bundle.",
					);
				}
				if (prior && (prior.state === "active" || prior.state === "superseded")) {
					throw new ProviderControlPlaneError(
						"RELEASE_ALREADY_LIVE",
						"A previously Live Release cannot be deployed as a candidate.",
					);
				}
				if (site.candidate_operation_id || site.live_operation_id) {
					throw new ProviderControlPlaneError(
						"CANDIDATE_BUSY",
						"Another candidate owns this Site.",
					);
				}
				const replacedCandidateId = site.candidate_release_id;
				if (replacedCandidateId === releaseId) {
					throw new ProviderControlPlaneError(
						"CANDIDATE_BUSY",
						"Another candidate owns this Site.",
					);
				}
				if (!prior) this.ensureReleaseCapacity();
				const identity = await deriveWfpProviderIdentity(
					siteId,
					releaseId,
					this.env.SITES_HOSTNAME ?? "sites.test",
				);
				const now = new Date().toISOString();
				const id = this.operationId(siteId);
				this.ctx.storage.transactionSync(() => {
					if (replacedCandidateId) {
						this.ctx.storage.sql.exec(
							"UPDATE releases SET state = 'failed', failure_code = 'CANDIDATE_REPLACED', updated_at = ? WHERE site_id = ? AND release_id = ? AND state = 'candidate'",
							now,
							siteId,
							replacedCandidateId,
						);
					}
					this.ctx.storage.sql.exec(
						`INSERT INTO operations (id, site_id, release_id, kind, status, idempotency_key, request_hash, phase, created_at, updated_at)
					 VALUES (?, ?, ?, 'deploy-release', 'running', ?, ?, 'recorded', ?, ?)`,
						id,
						siteId,
						releaseId,
						request.idempotencyKey,
						hash,
						now,
						now,
					);
					this.ctx.storage.sql.exec(
						`INSERT INTO releases (site_id, release_id, bundle_json, request_hash, wrapper_version, upload_digest, candidate_script, state, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, NULL, ?, 'deploying', ?, ?)
					 ON CONFLICT(site_id, release_id) DO UPDATE SET state = 'deploying', failure_code = NULL, updated_at = excluded.updated_at`,
						siteId,
						releaseId,
						JSON.stringify(bundle),
						hash,
						prior?.wrapper_version ?? WFP_WRAPPER_VERSION,
						identity.candidateScript,
						now,
						now,
					);
					this.ctx.storage.sql.exec(
						"UPDATE sites SET candidate_operation_id = ?, candidate_release_id = NULL, updated_at = ? WHERE site_id = ?",
						id,
						now,
						siteId,
					);
				});
				operation = this.operation(id);
			}
			return this.runDeploy(canonical, operation);
		});
	}

	async promoteRelease(request: ReleaseMutationRequest) {
		return this.rpc(() => this.liveMutation("promote-release", request));
	}

	async rollbackRelease(request: ReleaseMutationRequest) {
		return this.rpc(() => this.liveMutation("rollback-release", request));
	}

	async setHostname(request: SetHostnameRequest) {
		return this.rpc(() => this.setHostnameImpl(request));
	}

	private async setHostnameImpl(request: SetHostnameRequest) {
		return this.serial(async () => {
			const siteId = canonicalId(request.siteId, "Site ID");
			this.site(siteId);
			const canonical = { ...request, siteId };
			const hash = await providerRequestFingerprint("set-hostname", canonical);
			const existing = this.existing("set-hostname", siteId, request.idempotencyKey, hash);
			if (existing) return reference(existing.id);
			this.ensureOperationCapacity();
			return reference(
				this.insertFailed(
					"set-hostname",
					siteId,
					null,
					request.idempotencyKey,
					hash,
					"CUSTOM_HOSTNAME_UNSUPPORTED",
				),
			);
		});
	}

	async getOperation(operationId: string) {
		return this.rpc(async () => this.toOperation(this.operation(operationId)));
	}

	async cleanupSite(siteId: string) {
		return this.rpc(() => this.cleanupSiteImpl(siteId));
	}

	private async cleanupSiteImpl(siteIdInput: string) {
		return this.serial(async () => {
			const siteId = canonicalId(siteIdInput, "Site ID");
			const prefix = `wfp-releases/${siteId.replaceAll("-", "")}/`;
			const listed = await this.env.WFP_RELEASES.list({ prefix, limit: 41 });
			if (listed.truncated || listed.objects.length > 40) {
				throw new ProviderControlPlaneError(
					"CLEANUP_CAPACITY",
					"Site release cleanup exceeded its bounded object count.",
				);
			}
			const site = this.ctx.storage.sql
				.exec<SiteRow>("SELECT * FROM sites WHERE site_id = ?", siteId)
				.toArray()[0];
			const candidates = this.ctx.storage.sql
				.exec<{ candidate_script: string }>(
					"SELECT candidate_script FROM releases WHERE site_id = ? ORDER BY release_id LIMIT 21",
					siteId,
				)
				.toArray()
				.map(({ candidate_script }) => candidate_script);
			if (candidates.length > 20) {
				throw new ProviderControlPlaneError(
					"CLEANUP_CAPACITY",
					"Site script cleanup exceeded its bounded release count.",
				);
			}
			if (site) {
				let runtime: ReturnType<typeof createWfpRuntime>;
				try {
					runtime = createWfpRuntime(this.env);
				} catch {
					throw new ProviderControlPlaneError(
						"WFP_NOT_CONFIGURED",
						"Published Site cleanup is not configured.",
					);
				}
				const liveScript = (
					await deriveWfpProviderIdentity(siteId, siteId, this.env.SITES_HOSTNAME ?? "sites.test")
				).liveScript;
				for (const script of [liveScript, ...new Set(candidates)]) await runtime.delete(script);
			}
			if (listed.objects.length) {
				await this.env.WFP_RELEASES.delete(listed.objects.map(({ key }) => key));
			}
			this.ctx.storage.transactionSync(() => {
				this.ctx.storage.sql.exec("DELETE FROM operations WHERE site_id = ?", siteId);
				this.ctx.storage.sql.exec("DELETE FROM releases WHERE site_id = ?", siteId);
				this.ctx.storage.sql.exec("DELETE FROM sites WHERE site_id = ?", siteId);
			});
			return { deleted: true };
		});
	}

	private async runDeploy(request: DeployReleaseRequest, operation: OperationRow) {
		const release = this.release(request.siteId, request.releaseId)!;
		let resolved;
		try {
			resolved = await new R2ReleaseArtifactReader(this.env.WFP_RELEASES).read(
				request.siteId,
				request.releaseId,
				request.bundle,
				release.wrapper_version ?? WFP_WRAPPER_VERSION,
			);
		} catch {
			return reference(this.failCandidate(operation, "ARTIFACT_INVALID", false));
		}
		if (release.upload_digest && release.upload_digest !== resolved.uploadDigest) {
			return reference(this.failCandidate(operation, "RELEASE_DIGEST_CHANGED", false));
		}
		this.ctx.storage.sql.exec(
			"UPDATE releases SET wrapper_version = ?, upload_digest = ?, updated_at = ? WHERE site_id = ? AND release_id = ?",
			resolved.wrapperVersion,
			resolved.uploadDigest,
			new Date().toISOString(),
			request.siteId,
			request.releaseId,
		);
		let runtime: ReturnType<typeof createWfpRuntime>;
		try {
			runtime = createWfpRuntime(this.env);
		} catch {
			return reference(this.failCandidate(operation, "WFP_NOT_CONFIGURED", false));
		}
		let identity =
			operation.put_attempts > 0
				? await runtime.identity(release.candidate_script)
				: ({ status: "absent" } as WfpIdentity);
		if (!matches(identity, request.releaseId, resolved.uploadDigest)) {
			if (operation.put_attempts >= MAX_PUT_ATTEMPTS) {
				return reference(
					identity.status === "unavailable"
						? this.reconciliation(operation)
						: this.failCandidate(operation, "PUT_LIMIT_REACHED", true),
				);
			}
			try {
				await runtime.upload(release.candidate_script, resolved, {
					attempts: Math.min(
						MAX_INVOCATION_PUT_ATTEMPTS,
						MAX_PUT_ATTEMPTS - operation.put_attempts,
					),
					beforeAttempt: () => {
						operation = this.beforePut(operation, "candidate-upload");
					},
				});
			} catch (error) {
				logWfpRuntimeFailure("candidate-upload", request.siteId, request.releaseId, error);
				if (error instanceof WfpRuntimeError && error.ambiguous)
					return reference(this.reconciliation(operation));
				return reference(
					this.failCandidate(
						operation,
						"CANDIDATE_UPLOAD_FAILED",
						error instanceof WfpRuntimeError && error.retryable,
					),
				);
			}
			identity = await runtime.identity(release.candidate_script);
		}
		if (!matches(identity, request.releaseId, resolved.uploadDigest))
			return reference(this.reconciliation(operation));
		this.updateOperation(operation.id, "running", "candidate-health");
		if (!(await waitForCandidateHealth(runtime, release.candidate_script, resolved.healthPath))) {
			return reference(this.failCandidate(operation, "CANDIDATE_HEALTH_FAILED", false));
		}
		const now = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				"UPDATE releases SET state = 'candidate', checked_at = ?, failure_code = NULL, updated_at = ? WHERE site_id = ? AND release_id = ?",
				now,
				now,
				request.siteId,
				request.releaseId,
			);
			this.ctx.storage.sql.exec(
				"UPDATE sites SET candidate_release_id = ?, candidate_operation_id = NULL, updated_at = ? WHERE site_id = ?",
				request.releaseId,
				now,
				request.siteId,
			);
			this.updateOperation(operation.id, "succeeded", "commit", null, null, null);
		});
		return reference(operation.id);
	}

	private async liveMutation(
		kind: "promote-release" | "rollback-release",
		request: ReleaseMutationRequest,
	) {
		return this.serial(async () => {
			const siteId = canonicalId(request.siteId, "Site ID");
			const releaseId = canonicalId(request.releaseId, "Release ID");
			const canonical = { ...request, siteId, releaseId };
			const site = this.site(siteId);
			const hash = await providerRequestFingerprint(kind, canonical);
			let operation = this.existing(kind, siteId, request.idempotencyKey, hash);
			if (operation && operation.status !== "running") return reference(operation.id);
			if (!operation) {
				this.ensureOperationCapacity();
				if (site.live_operation_id)
					throw new ProviderControlPlaneError("LIVE_BUSY", "Another Live mutation owns this Site.");
				const target = this.release(siteId, releaseId);
				const eligible =
					kind === "promote-release"
						? site.candidate_release_id === releaseId && target?.state === "candidate"
						: target?.state === "active" || target?.state === "superseded";
				if (!eligible)
					throw new ProviderControlPlaneError("INVALID_RELEASE_STATE", "Release is not eligible.");
				const now = new Date().toISOString();
				const id = this.ctx.storage.transactionSync(() => {
					const value = this.insertOperation(
						kind,
						siteId,
						releaseId,
						request.idempotencyKey,
						hash,
						"running",
						"recorded",
						now,
					);
					this.ctx.storage.sql.exec(
						"UPDATE sites SET live_operation_id = ?, updated_at = ? WHERE site_id = ?",
						value,
						now,
						siteId,
					);
					return value;
				});
				operation = this.operation(id);
			}
			return this.runLive(kind, canonical, operation);
		});
	}

	private async runLive(
		kind: "promote-release" | "rollback-release",
		request: ReleaseMutationRequest,
		operation: OperationRow,
	) {
		const target = this.release(request.siteId, request.releaseId)!;
		const bundle = releaseBundleSchema.parse(JSON.parse(target.bundle_json));
		let resolved;
		try {
			resolved = await new R2ReleaseArtifactReader(this.env.WFP_RELEASES).read(
				request.siteId,
				request.releaseId,
				bundle,
				target.wrapper_version ?? undefined,
			);
		} catch {
			return reference(this.failLive(operation, "ARTIFACT_INVALID", false));
		}
		if (resolved.uploadDigest !== target.upload_digest)
			return reference(this.failLive(operation, "RELEASE_DIGEST_CHANGED", false));
		let runtime: ReturnType<typeof createWfpRuntime>;
		let identityName: string;
		try {
			runtime = createWfpRuntime(this.env);
			identityName = (
				await deriveWfpProviderIdentity(
					request.siteId,
					request.releaseId,
					this.env.SITES_HOSTNAME ?? "sites.test",
				)
			).liveScript;
		} catch {
			return reference(this.failLive(operation, "WFP_NOT_CONFIGURED", false));
		}
		let identity =
			operation.put_attempts > 0
				? await runtime.identity(identityName)
				: ({ status: "absent" } as WfpIdentity);
		if (!matches(identity, request.releaseId, resolved.uploadDigest)) {
			if (operation.put_attempts >= MAX_PUT_ATTEMPTS) {
				const site = this.site(request.siteId);
				const active = site.active_release_id
					? this.release(request.siteId, site.active_release_id)
					: undefined;
				const unchanged =
					(identity.status === "absent" && !active) ||
					Boolean(
						active?.upload_digest && matches(identity, active.release_id, active.upload_digest),
					);
				return reference(
					unchanged
						? this.failLive(operation, "PUT_LIMIT_REACHED", true)
						: this.reconciliation(operation),
				);
			}
			try {
				await runtime.upload(identityName, resolved, {
					attempts: Math.min(
						MAX_INVOCATION_PUT_ATTEMPTS,
						MAX_PUT_ATTEMPTS - operation.put_attempts,
					),
					beforeAttempt: () => {
						operation = this.beforePut(operation, "live-upload");
					},
				});
			} catch (error) {
				logWfpRuntimeFailure("live-upload", request.siteId, request.releaseId, error);
				if (error instanceof WfpRuntimeError && error.mayHaveApplied)
					return reference(this.reconciliation(operation));
				return reference(
					this.failLive(
						operation,
						"LIVE_UPLOAD_FAILED",
						error instanceof WfpRuntimeError && error.retryable,
					),
				);
			}
			identity = await runtime.identity(identityName);
		}
		if (!matches(identity, request.releaseId, resolved.uploadDigest))
			return reference(this.reconciliation(operation));
		const site = this.site(request.siteId);
		const now = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			if (site.active_release_id && site.active_release_id !== request.releaseId) {
				this.ctx.storage.sql.exec(
					"UPDATE releases SET state = 'superseded', updated_at = ? WHERE site_id = ? AND release_id = ?",
					now,
					request.siteId,
					site.active_release_id,
				);
			}
			this.ctx.storage.sql.exec(
				"UPDATE releases SET state = 'active', updated_at = ? WHERE site_id = ? AND release_id = ?",
				now,
				request.siteId,
				request.releaseId,
			);
			this.ctx.storage.sql.exec(
				`UPDATE sites SET active_release_id = ?, live_operation_id = NULL,
			 candidate_release_id = CASE WHEN ? = 'promote-release' THEN NULL ELSE candidate_release_id END,
			 updated_at = ? WHERE site_id = ?`,
				request.releaseId,
				kind,
				now,
				request.siteId,
			);
			this.updateOperation(operation.id, "succeeded", "commit", null, null, null);
		});
		return reference(operation.id);
	}

	private serial<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.then(work, work);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async rpc<T>(work: () => Promise<T>): Promise<ControlPlaneRpcResult<T>> {
		try {
			return { ok: true, value: await work() };
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
				return { ok: false, code: error.code };
			}
			if (error instanceof z.ZodError) return { ok: false, code: "INVALID_REQUEST" };
			throw error;
		}
	}

	private site(siteId: string) {
		const row = this.ctx.storage.sql
			.exec<SiteRow>("SELECT * FROM sites WHERE site_id = ?", siteId)
			.toArray()[0];
		if (!row) throw new ProviderControlPlaneError("SITE_NOT_FOUND", "Site is not provisioned.");
		return row;
	}

	private release(siteId: string, releaseId: string) {
		return this.ctx.storage.sql
			.exec<ReleaseRow>(
				"SELECT * FROM releases WHERE site_id = ? AND release_id = ?",
				siteId,
				releaseId,
			)
			.toArray()[0];
	}

	private operation(id: string) {
		const row = this.ctx.storage.sql
			.exec<OperationRow>("SELECT * FROM operations WHERE id = ?", id)
			.toArray()[0];
		if (!row)
			throw new ProviderControlPlaneError("OPERATION_NOT_FOUND", "Operation was not found.");
		return row;
	}

	private existing(kind: ProviderOperation["kind"], siteId: string, key: string, hash: string) {
		const row = this.ctx.storage.sql
			.exec<OperationRow>(
				"SELECT * FROM operations WHERE site_id = ? AND kind = ? AND idempotency_key = ?",
				siteId,
				kind,
				key,
			)
			.toArray()[0];
		if (row && row.request_hash !== hash)
			throw new ProviderControlPlaneError(
				"IDEMPOTENCY_KEY_REUSED",
				"Idempotency key was reused for another request.",
			);
		return row;
	}

	private insertOperation(
		kind: ProviderOperation["kind"],
		siteId: string,
		releaseId: string | null,
		key: string,
		hash: string,
		status: ProviderOperation["status"],
		phase: string,
		now = new Date().toISOString(),
	) {
		const id = this.operationId(siteId);
		this.ctx.storage.sql.exec(
			"INSERT INTO operations (id, site_id, release_id, kind, status, idempotency_key, request_hash, phase, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			id,
			siteId,
			releaseId,
			kind,
			status,
			key,
			hash,
			phase,
			now,
			now,
		);
		return id;
	}

	private insertFailed(
		kind: ProviderOperation["kind"],
		siteId: string,
		releaseId: string | null,
		key: string,
		hash: string,
		code: string,
	) {
		return this.ctx.storage.transactionSync(() => {
			const id = this.insertOperation(kind, siteId, releaseId, key, hash, "failed", "commit");
			this.updateOperation(id, "failed", "commit", code, "Operation is unsupported.", false);
			return id;
		});
	}

	private beforePut(operation: OperationRow, phase: string) {
		this.ctx.storage.sql.exec(
			"UPDATE operations SET phase = ?, put_attempts = put_attempts + 1, error_code = NULL, error_message = NULL, retryable = NULL, updated_at = ? WHERE id = ?",
			phase,
			new Date().toISOString(),
			operation.id,
		);
		return this.operation(operation.id);
	}

	private reconciliation(operation: OperationRow) {
		this.updateOperation(
			operation.id,
			"running",
			operation.phase,
			"RECONCILIATION_REQUIRED",
			"Remote state requires exact replay.",
			true,
		);
		return operation.id;
	}

	private failCandidate(operation: OperationRow, code: string, retryable: boolean) {
		const now = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				"UPDATE releases SET state = 'failed', failure_code = ?, updated_at = ? WHERE site_id = ? AND release_id = ?",
				code,
				now,
				operation.site_id,
				operation.release_id,
			);
			this.ctx.storage.sql.exec(
				"UPDATE sites SET candidate_operation_id = NULL, updated_at = ? WHERE site_id = ? AND candidate_operation_id = ?",
				now,
				operation.site_id,
				operation.id,
			);
			this.updateOperation(
				operation.id,
				"failed",
				operation.phase,
				code,
				"Candidate deployment failed.",
				retryable,
			);
		});
		return operation.id;
	}

	private failLive(operation: OperationRow, code: string, retryable: boolean) {
		const now = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				"UPDATE sites SET live_operation_id = NULL, updated_at = ? WHERE site_id = ? AND live_operation_id = ?",
				now,
				operation.site_id,
				operation.id,
			);
			this.updateOperation(
				operation.id,
				"failed",
				operation.phase,
				code,
				"Live mutation failed.",
				retryable,
			);
		});
		return operation.id;
	}

	private updateOperation(
		id: string,
		status: ProviderOperation["status"],
		phase: string,
		code?: string | null,
		message?: string | null,
		retryable?: boolean | null,
	) {
		this.ctx.storage.sql.exec(
			"UPDATE operations SET status = ?, phase = ?, error_code = ?, error_message = ?, retryable = ?, updated_at = ? WHERE id = ?",
			status,
			phase,
			code ?? null,
			message ?? null,
			retryable == null ? null : Number(retryable),
			new Date().toISOString(),
			id,
		);
	}

	private toOperation(row: OperationRow): ProviderOperation {
		return providerOperationSchema.parse({
			id: row.id,
			kind: row.kind,
			status: row.status,
			siteId: row.site_id,
			...(row.release_id ? { releaseId: row.release_id } : {}),
			...(row.error_code
				? {
						error: {
							code: row.error_code,
							message: row.error_message ?? "Operation failed.",
							retryable: Boolean(row.retryable),
						},
					}
				: {}),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		});
	}

	private operationId(siteId: string) {
		return `${siteId.replaceAll("-", "")}.${crypto.randomUUID()}`;
	}

	private ensureOperationCapacity() {
		if (
			this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations").one()
				.count >= MAX_OPERATIONS
		) {
			throw new ProviderControlPlaneError(
				"OPERATION_CAPACITY",
				"Operation retention limit reached.",
			);
		}
	}

	private ensureReleaseCapacity() {
		if (
			this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM releases").one()
				.count >= MAX_RELEASES
		) {
			throw new ProviderControlPlaneError("RELEASE_CAPACITY", "Release retention limit reached.");
		}
	}
}
