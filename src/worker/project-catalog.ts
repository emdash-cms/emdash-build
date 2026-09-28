import { DurableObject } from "cloudflare:workers";
import {
	BUILD_ACTIVITY_TTL_MS,
	validateProjectCatalogItem,
	type BeginClaimResult,
	type ProjectCatalogItem,
	type ProjectCatalogStatus,
	type RegisterProjectResult,
} from "./project-catalog-contract.js";

export type {
	BeginClaimResult,
	ProjectCatalogItem,
	ProjectCatalogStatus,
	RegisterProjectResult,
} from "./project-catalog-contract.js";

interface CatalogMetaRow extends Record<string, string | null> {
	owner_key: string;
	claim_account_key: string | null;
	claim_status: "active" | "complete";
}

/** One catalogue object per guest/account principal; never on the public-site request path. */
export class ProjectCatalog extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	private migrate(): void {
		this.ctx.storage.sql.exec(
			[
				"CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER);",
				"CREATE INDEX IF NOT EXISTS projects_updated_at ON projects(updated_at DESC);",
				"CREATE TABLE IF NOT EXISTS pending_project_turns (project_id TEXT PRIMARY KEY);",
				"CREATE TABLE IF NOT EXISTS deleting_projects (project_id TEXT PRIMARY KEY);",
				"CREATE TABLE IF NOT EXISTS catalog_meta (id INTEGER PRIMARY KEY CHECK (id = 1), owner_key TEXT NOT NULL, claim_account_key TEXT, claim_status TEXT NOT NULL DEFAULT 'active' CHECK (claim_status IN ('active', 'complete')));",
				"CREATE TABLE IF NOT EXISTS account_session_revocations (session_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);",
				"CREATE TABLE IF NOT EXISTS account_session_revocation_deliveries (session_hash TEXT NOT NULL, project_id TEXT NOT NULL, expires_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, attempted_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_hash, project_id));",
			].join("\n"),
		);
		// Catalogues from before creation times were recorded keep today's order:
		// each site's last update becomes its creation time, once.
		const columns = this.ctx.storage.sql
			.exec<{ name: string }>("PRAGMA table_info(projects)")
			.toArray()
			.map((column) => column.name);
		if (!columns.includes("created_at")) {
			this.ctx.storage.sql.exec("ALTER TABLE projects ADD COLUMN created_at INTEGER");
		}
		if (!columns.includes("active_until")) {
			this.ctx.storage.sql.exec("ALTER TABLE projects ADD COLUMN active_until INTEGER");
		}
		this.ctx.storage.sql.exec(
			"UPDATE projects SET created_at = updated_at WHERE created_at IS NULL",
		);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS projects_created_at ON projects(created_at DESC, id DESC)",
		);
	}

	private ensureOwner(ownerKey: string): CatalogMetaRow | undefined {
		this.ctx.storage.sql.exec(
			"INSERT OR IGNORE INTO catalog_meta (id, owner_key, claim_status) VALUES (1, ?, 'active')",
			ownerKey,
		);
		const row = this.ctx.storage.sql
			.exec<CatalogMetaRow>(
				"SELECT owner_key, claim_account_key, claim_status FROM catalog_meta WHERE id = 1",
			)
			.one();
		return row.owner_key === ownerKey ? row : undefined;
	}

	/**
	 * Creation time is written once, so the list never reorders; last use only
	 * moves forward, so a retried claim cannot make a site look older.
	 */
	private writeProject(project: ProjectCatalogItem): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO projects (id, title, status, updated_at, created_at) VALUES (?, ?, ?, ?, ?) " +
				"ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, " +
				"updated_at = MAX(projects.updated_at, excluded.updated_at), " +
				"created_at = COALESCE(projects.created_at, excluded.created_at)",
			project.id,
			project.title,
			project.status,
			project.updatedAt,
			project.createdAt ?? project.updatedAt,
		);
	}

	private pruneSessionRevocations(now = Date.now()): void {
		this.ctx.storage.sql.exec(
			"DELETE FROM account_session_revocation_deliveries WHERE expires_at <= ?",
			now,
		);
		this.ctx.storage.sql.exec("DELETE FROM account_session_revocations WHERE expires_at <= ?", now);
	}

	private async drainSessionRevocations(filter?: {
		sessionHash?: string;
		projectId?: string;
	}): Promise<boolean> {
		const deliveries = filter?.sessionHash
			? this.ctx.storage.sql
					.exec<{ session_hash: string; project_id: string; expires_at: number }>(
						"SELECT session_hash, project_id, expires_at FROM account_session_revocation_deliveries WHERE delivered = 0 AND session_hash = ? ORDER BY attempted_at, project_id LIMIT 50",
						filter.sessionHash,
					)
					.toArray()
			: filter?.projectId
				? this.ctx.storage.sql
						.exec<{ session_hash: string; project_id: string; expires_at: number }>(
							"SELECT session_hash, project_id, expires_at FROM account_session_revocation_deliveries WHERE delivered = 0 AND project_id = ? ORDER BY attempted_at, session_hash LIMIT 50",
							filter.projectId,
						)
						.toArray()
				: this.ctx.storage.sql
						.exec<{ session_hash: string; project_id: string; expires_at: number }>(
							"SELECT session_hash, project_id, expires_at FROM account_session_revocation_deliveries WHERE delivered = 0 ORDER BY attempted_at, session_hash, project_id LIMIT 50",
						)
						.toArray();
		const results = await Promise.allSettled(
			deliveries.map((delivery) =>
				this.env.BuilderAgent.getByName(delivery.project_id).revokeSessionConnections(
					delivery.session_hash,
					delivery.expires_at,
				),
			),
		);
		const attemptedAt = Date.now();
		for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
			const delivery = deliveries[resultIndex]!;
			this.ctx.storage.sql.exec(
				"UPDATE account_session_revocation_deliveries SET attempted_at = ? WHERE session_hash = ? AND project_id = ?",
				attemptedAt,
				delivery.session_hash,
				delivery.project_id,
			);
			if (results[resultIndex]?.status !== "fulfilled") continue;
			this.ctx.storage.sql.exec(
				"UPDATE account_session_revocation_deliveries SET delivered = 1 WHERE session_hash = ? AND project_id = ?",
				delivery.session_hash,
				delivery.project_id,
			);
		}
		const scopedPending = filter?.sessionHash
			? this.ctx.storage.sql
					.exec<{ count: number }>(
						"SELECT COUNT(*) AS count FROM account_session_revocation_deliveries WHERE delivered = 0 AND session_hash = ?",
						filter.sessionHash,
					)
					.one().count
			: filter?.projectId
				? this.ctx.storage.sql
						.exec<{ count: number }>(
							"SELECT COUNT(*) AS count FROM account_session_revocation_deliveries WHERE delivered = 0 AND project_id = ?",
							filter.projectId,
						)
						.one().count
				: undefined;
		const globalPending = this.ctx.storage.sql
			.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM account_session_revocation_deliveries WHERE delivered = 0",
			)
			.one().count;
		if (globalPending > 0) await this.ctx.storage.setAlarm(Date.now() + 1_000);
		else await this.ctx.storage.deleteAlarm();
		return (scopedPending ?? globalPending) === 0;
	}

	private async fenceProjectForRevokedSessions(projectId: string): Promise<void> {
		this.pruneSessionRevocations();
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO account_session_revocation_deliveries (session_hash, project_id, expires_at)
			 SELECT session_hash, ?, expires_at FROM account_session_revocations`,
			projectId,
		);
		await this.drainSessionRevocations({ projectId });
		const pending = this.ctx.storage.sql
			.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM account_session_revocation_deliveries WHERE project_id = ? AND delivered = 0",
				projectId,
			)
			.one().count;
		if (pending > 0) throw new Error("Account session revocation is still applying.");
	}

	private rows(): ProjectCatalogItem[] {
		return this.ctx.storage.sql
			.exec<{
				id: string;
				title: string;
				status: ProjectCatalogStatus;
				updated_at: number;
				created_at: number;
				active_until: number | null;
			}>(
				"SELECT id, title, status, updated_at, created_at, active_until FROM projects ORDER BY created_at DESC, id DESC LIMIT 100",
			)
			.toArray()
			.map((row) => ({
				id: row.id,
				title: row.title,
				status: row.status,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				building: row.active_until !== null && row.active_until > Date.now(),
			}));
	}

	async registerProject(
		ownerKey: string,
		input: ProjectCatalogItem,
		limit?: number,
	): Promise<RegisterProjectResult> {
		const project = validateProjectCatalogItem(input);
		if (!project) throw new Error("Invalid project catalogue item.");
		const meta = this.ensureOwner(ownerKey);
		if (!meta) return "conflict";
		if (meta.claim_status !== "active") return "claim-in-progress";
		if (
			this.ctx.storage.sql
				.exec("SELECT project_id FROM deleting_projects WHERE project_id = ?", project.id)
				.toArray().length
		)
			return "claim-in-progress";
		const exists = this.ctx.storage.sql
			.exec<{ id: string; title: string }>(
				"SELECT id, title FROM projects WHERE id = ?",
				project.id,
			)
			.toArray()[0];
		if (!exists && meta.claim_account_key) return "claim-in-progress";
		if (!exists && limit !== undefined) {
			const count = this.ctx.storage.sql
				.exec<{ count: number }>("SELECT COUNT(*) AS count FROM projects")
				.one().count;
			if (count >= limit) {
				this.ctx.storage.sql.exec(
					"DELETE FROM pending_project_turns WHERE project_id = ?",
					project.id,
				);
				return "limit-reached";
			}
		}
		// A new chat turn refreshes the project's status; it must not reset a
		// name the user changed through the project UI.
		this.writeProject({ ...project, title: exists?.title ?? project.title });
		if (ownerKey.startsWith("account:")) await this.fenceProjectForRevokedSessions(project.id);
		this.ctx.storage.sql.exec("DELETE FROM pending_project_turns WHERE project_id = ?", project.id);
		return "registered";
	}

	async reconcileProject(ownerKey: string, input: ProjectCatalogItem): Promise<boolean> {
		const project = validateProjectCatalogItem(input);
		if (!project) throw new Error("Invalid project catalogue item.");
		const meta = this.ensureOwner(ownerKey);
		if (!meta || meta.claim_status !== "active") return false;
		if (this.isDeleting(project.id)) return false;
		const exists = this.ctx.storage.sql
			.exec<{ id: string; title: string }>(
				"SELECT id, title FROM projects WHERE id = ?",
				project.id,
			)
			.toArray()[0];
		if (!exists && meta.claim_account_key) return false;
		this.writeProject({ ...project, title: exists?.title ?? project.title });
		return true;
	}

	async updateProject(ownerKey: string, input: ProjectCatalogItem): Promise<boolean> {
		const project = validateProjectCatalogItem(input);
		const meta = this.ensureOwner(ownerKey);
		if (!project || !meta || meta.claim_status !== "active" || meta.claim_account_key) return false;
		if (this.isDeleting(project.id)) return false;
		const exists = this.ctx.storage.sql
			.exec<{ id: string }>("SELECT id FROM projects WHERE id = ?", project.id)
			.toArray()[0];
		if (!exists) return false;
		this.writeProject(project);
		return true;
	}

	async renameProject(ownerKey: string, projectId: string, title: string): Promise<boolean> {
		const meta = this.ensureOwner(ownerKey);
		if (
			!meta ||
			meta.claim_status !== "active" ||
			meta.claim_account_key ||
			this.isDeleting(projectId)
		)
			return false;
		const renamed = this.ctx.storage.sql.exec(
			"UPDATE projects SET title = ?, updated_at = ? WHERE id = ? RETURNING id",
			title,
			Date.now(),
			projectId,
		);
		return renamed.toArray().length === 1;
	}

	async upsertAccountProject(ownerKey: string, input: ProjectCatalogItem): Promise<boolean> {
		if (!ownerKey.startsWith("account:")) return false;
		const project = validateProjectCatalogItem(input);
		if (!project || !this.ensureOwner(ownerKey)) return false;
		this.writeProject(project);
		await this.fenceProjectForRevokedSessions(project.id);
		return true;
	}

	async listProjects(): Promise<ProjectCatalogItem[]> {
		return this.rows();
	}

	/** Mark a site as building for a short while, or clear it; never touches its order. */
	async setProjectActivity(ownerKey: string, projectId: string, active: boolean): Promise<boolean> {
		if (!this.ensureOwner(ownerKey) || this.isDeleting(projectId)) return false;
		return (
			this.ctx.storage.sql
				.exec(
					"UPDATE projects SET active_until = ? WHERE id = ? RETURNING id",
					active ? Date.now() + BUILD_ACTIVITY_TTL_MS : null,
					projectId,
				)
				.toArray().length === 1
		);
	}

	async firstAvailableProjectId(): Promise<string | undefined> {
		return this.ctx.storage.sql
			.exec<{ id: string }>(
				"SELECT id FROM projects WHERE id NOT IN (SELECT project_id FROM deleting_projects) ORDER BY updated_at DESC LIMIT 1",
			)
			.toArray()[0]?.id;
	}

	private isDeleting(projectId: string): boolean {
		return (
			this.ctx.storage.sql
				.exec("SELECT project_id FROM deleting_projects WHERE project_id = ?", projectId)
				.toArray().length > 0
		);
	}

	async isProjectDeletionPending(ownerKey: string, projectId: string): Promise<boolean> {
		return Boolean(this.ensureOwner(ownerKey)) && this.isDeleting(projectId);
	}

	async beginDeleteProject(
		ownerKey: string,
		projectId: string,
	): Promise<"ready" | "busy" | "not-found"> {
		const meta = this.ensureOwner(ownerKey);
		if (!meta || meta.claim_status !== "active") return "not-found";
		const exists =
			this.ctx.storage.sql.exec("SELECT id FROM projects WHERE id = ?", projectId).toArray()
				.length > 0;
		if (!exists) return "not-found";
		if (meta.claim_account_key) return "busy";
		this.ctx.storage.sql.exec(
			"INSERT OR IGNORE INTO deleting_projects (project_id) VALUES (?)",
			projectId,
		);
		return "ready";
	}

	async cancelDeleteProject(ownerKey: string, projectId: string): Promise<void> {
		const meta = this.ensureOwner(ownerKey);
		if (meta?.claim_status === "active") {
			this.ctx.storage.sql.exec("DELETE FROM deleting_projects WHERE project_id = ?", projectId);
		}
	}

	async finishDeleteProject(ownerKey: string, projectId: string): Promise<boolean> {
		const meta = this.ensureOwner(ownerKey);
		if (!meta || meta.claim_status !== "active") return false;
		if (!this.isDeleting(projectId)) {
			return (
				this.ctx.storage.sql.exec("SELECT id FROM projects WHERE id = ?", projectId).toArray()
					.length === 0
			);
		}
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DELETE FROM projects WHERE id = ?", projectId);
			this.ctx.storage.sql.exec(
				"DELETE FROM pending_project_turns WHERE project_id = ?",
				projectId,
			);
			this.ctx.storage.sql.exec(
				"DELETE FROM account_session_revocation_deliveries WHERE project_id = ?",
				projectId,
			);
			this.ctx.storage.sql.exec("DELETE FROM deleting_projects WHERE project_id = ?", projectId);
		});
		return true;
	}

	async beginSessionRevocation(
		accountOwnerKey: string,
		sessionHash: string,
		expiresAt: number,
	): Promise<boolean> {
		if (!accountOwnerKey.startsWith("account:") || !sessionHash) return false;
		if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
		if (!this.ensureOwner(accountOwnerKey)) return false;
		this.pruneSessionRevocations();
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO account_session_revocations (session_hash, expires_at) VALUES (?, ?)",
			sessionHash,
			expiresAt,
		);
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO account_session_revocation_deliveries (session_hash, project_id, expires_at)
			 SELECT ?, id, ? FROM (
				SELECT id FROM projects
				UNION
				SELECT project_id AS id FROM pending_project_turns
			 )`,
			sessionHash,
			expiresAt,
		);
		return this.drainSessionRevocations({ sessionHash });
	}

	override async alarm(): Promise<void> {
		this.pruneSessionRevocations();
		await this.drainSessionRevocations();
	}

	async authorizeActiveGuest(expectedGuestKey: string): Promise<boolean> {
		if (expectedGuestKey.startsWith("account:")) return false;
		const meta = this.ensureOwner(expectedGuestKey);
		return meta?.claim_status === "active";
	}

	async canStartProject(expectedGuestKey: string): Promise<boolean> {
		if (expectedGuestKey.startsWith("account:")) return false;
		const meta = this.ensureOwner(expectedGuestKey);
		return meta?.claim_status === "active" && !meta.claim_account_key;
	}

	async beginProjectTurn(
		expectedOwnerKey: string,
		projectId: string,
		sessionHash?: string,
	): Promise<boolean> {
		const meta = this.ensureOwner(expectedOwnerKey);
		if (!meta || meta.claim_status !== "active") return false;
		if (this.isDeleting(projectId)) return false;
		if (expectedOwnerKey.startsWith("account:")) {
			if (!sessionHash) return false;
			const revoked = this.ctx.storage.sql
				.exec<{ session_hash: string }>(
					"SELECT session_hash FROM account_session_revocations WHERE session_hash = ? AND expires_at > ? LIMIT 1",
					sessionHash,
					Date.now(),
				)
				.toArray()[0];
			if (revoked) return false;
		} else if (sessionHash) {
			return false;
		}
		const exists = this.ctx.storage.sql
			.exec<{ id: string }>("SELECT id FROM projects WHERE id = ?", projectId)
			.toArray()[0];
		if (meta.claim_account_key && !exists) return false;
		this.ctx.storage.sql.exec(
			"INSERT OR IGNORE INTO pending_project_turns (project_id) VALUES (?)",
			projectId,
		);
		return true;
	}

	async beginClaim(
		expectedGuestKey: string,
		accountOwnerKey: string,
		maxProjects: number,
	): Promise<BeginClaimResult> {
		if (!accountOwnerKey.startsWith("account:")) return { status: "conflict" };
		const meta = this.ensureOwner(expectedGuestKey);
		if (!meta) return { status: "conflict" };
		if (
			this.ctx.storage.sql.exec("SELECT project_id FROM deleting_projects LIMIT 1").toArray().length
		) {
			return { status: "busy" };
		}
		const pending = this.ctx.storage.sql
			.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_project_turns")
			.one().count;
		if (meta.claim_account_key) {
			if (meta.claim_account_key !== accountOwnerKey) return { status: "conflict" };
			return pending > 0 ? { status: "busy" } : { status: "resuming", projects: this.rows() };
		}
		if (meta.claim_status === "complete") return { status: "conflict" };
		if (pending > 0) return { status: "busy" };
		const count = this.ctx.storage.sql
			.exec<{ count: number }>("SELECT COUNT(*) AS count FROM projects")
			.one().count;
		if (count > maxProjects) return { status: "too-many", count };
		this.ctx.storage.sql.exec(
			"UPDATE catalog_meta SET claim_account_key = ? WHERE id = 1 AND claim_account_key IS NULL AND claim_status = 'active'",
			accountOwnerKey,
		);
		return { status: "started", projects: this.rows() };
	}

	async removeClaimedProject(accountOwnerKey: string, projectId: string): Promise<boolean> {
		const meta = this.ctx.storage.sql
			.exec<CatalogMetaRow>(
				"SELECT owner_key, claim_account_key, claim_status FROM catalog_meta WHERE id = 1",
			)
			.toArray()[0];
		if (!meta || meta.claim_account_key !== accountOwnerKey) {
			return false;
		}
		this.ctx.storage.sql.exec("DELETE FROM projects WHERE id = ?", projectId);
		return true;
	}

	async completeClaim(accountOwnerKey: string): Promise<boolean> {
		const meta = this.ctx.storage.sql
			.exec<CatalogMetaRow>(
				"SELECT owner_key, claim_account_key, claim_status FROM catalog_meta WHERE id = 1",
			)
			.toArray()[0];
		if (meta?.claim_status === "complete") return meta.claim_account_key === accountOwnerKey;
		const remaining = this.ctx.storage.sql
			.exec<{ count: number }>("SELECT COUNT(*) AS count FROM projects")
			.one().count;
		if (remaining !== 0) return false;
		const result = this.ctx.storage.sql.exec(
			"UPDATE catalog_meta SET claim_status = 'complete' WHERE id = 1 AND claim_account_key = ? AND claim_status = 'active' RETURNING id",
			accountOwnerKey,
		);
		return result.toArray().length === 1;
	}
}
