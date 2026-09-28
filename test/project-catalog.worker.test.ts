import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";
import type { ProjectCatalog } from "../src/worker/project-catalog.js";

const testEnv = env as typeof env & {
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
	ProjectCatalog: DurableObjectNamespace<ProjectCatalog>;
};

const project = {
	id: "11111111-1111-4111-8111-111111111111",
	title: "Example",
	status: "draft" as const,
	updatedAt: 1,
};

describe("project catalogue ownership", () => {
	beforeEach(() => reset());

	it("keeps a renamed site across later turns and sign-in reconciliation", async () => {
		const guest = "renamed-guest";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		expect(await catalog.registerProject(guest, project)).toBe("registered");
		expect(await catalog.updateProject(guest, { ...project, title: "Iceland by Noah" })).toBe(true);
		expect(await catalog.registerProject(guest, { ...project, status: "building" })).toBe(
			"registered",
		);
		expect(await catalog.reconcileProject(guest, project)).toBe(true);
		expect(await catalog.listProjects()).toMatchObject([
			{ title: "Iceland by Noah", status: "draft" },
		]);
	});

	it("renames only the title and fences a deletion until cleanup finishes", async () => {
		const guest = "delete-guest";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		await catalog.registerProject(guest, project);
		expect(await catalog.renameProject(guest, project.id, "New name")).toBe(true);
		expect(await catalog.listProjects()).toMatchObject([{ title: "New name", status: "draft" }]);
		expect(await catalog.beginProjectTurn(guest, project.id)).toBe(true);
		expect(await catalog.beginDeleteProject(guest, project.id)).toBe("ready");
		expect(await catalog.firstAvailableProjectId()).toBeUndefined();
		expect(await catalog.beginProjectTurn(guest, project.id)).toBe(false);
		expect(await catalog.renameProject(guest, project.id, "Another name")).toBe(false);
		expect(await catalog.registerProject(guest, project)).toBe("claim-in-progress");
		expect(await catalog.beginClaim(guest, "account:new-owner", 100)).toEqual({ status: "busy" });
		await catalog.cancelDeleteProject(guest, project.id);
		expect(await catalog.registerProject(guest, project)).toBe("registered");
		expect(await catalog.beginDeleteProject(guest, project.id)).toBe("ready");
		expect(await catalog.finishDeleteProject(guest, project.id)).toBe(true);
		expect(await catalog.listProjects()).toEqual([]);
		expect(await catalog.beginDeleteProject(guest, project.id)).toBe("not-found");
	});

	it("reserves one target account without blocking unfinished guest work", async () => {
		const guest = "guest-owner";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		expect(await catalog.registerProject(guest, project, 1)).toBe("registered");
		expect(await catalog.beginProjectTurn(guest, "22222222-2222-4222-8222-222222222222")).toBe(
			true,
		);
		expect(
			await catalog.registerProject(
				guest,
				{ ...project, id: "22222222-2222-4222-8222-222222222222" },
				1,
			),
		).toBe("limit-reached");
		expect(await catalog.beginClaim(guest, "account:owner", 100)).toMatchObject({
			status: "started",
			projects: [project],
		});
		expect(await catalog.authorizeActiveGuest(guest)).toBe(true);
		expect(await catalog.canStartProject(guest)).toBe(false);
		expect(
			await catalog.registerProject(
				guest,
				{ ...project, id: "33333333-3333-4333-8333-333333333333" },
				10,
			),
		).toBe("claim-in-progress");
		expect(await catalog.updateProject(guest, { ...project, title: "Changed" })).toBe(false);
		expect(await catalog.renameProject(guest, project.id, "Changed name")).toBe(false);
		expect(await catalog.listProjects()).toMatchObject([{ title: "Example", status: "draft" }]);
	});

	it("resumes only the same account and completes after rows move", async () => {
		const guest = "guest-owner";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		await catalog.registerProject(guest, project, 10);
		await catalog.beginClaim(guest, "account:owner", 100);
		expect(await catalog.beginClaim(guest, "account:other", 100)).toEqual({ status: "conflict" });
		expect(await catalog.beginProjectTurn(guest, project.id)).toBe(true);
		expect(await catalog.beginClaim(guest, "account:owner", 100)).toEqual({ status: "busy" });
		expect(await catalog.registerProject(guest, project, 10)).toBe("registered");
		expect(await catalog.beginClaim(guest, "account:owner", 100)).toMatchObject({
			status: "resuming",
		});
		expect(await catalog.completeClaim("account:owner")).toBe(false);
		expect(await catalog.removeClaimedProject("account:owner", project.id)).toBe(true);
		expect(await catalog.completeClaim("account:owner")).toBe(true);
		expect(await catalog.authorizeActiveGuest(guest)).toBe(false);
	});

	it("blocks claim reservation while a first turn is entering the catalogue", async () => {
		const guest = "guest-owner";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		expect(await catalog.beginProjectTurn(guest, project.id)).toBe(true);
		expect(await catalog.beginClaim(guest, "account:owner", 100)).toEqual({ status: "busy" });
		expect(await catalog.registerProject(guest, project, 10)).toBe("registered");
		expect(await catalog.beginClaim(guest, "account:owner", 100)).toMatchObject({
			status: "started",
		});
	});

	it("refuses an over-bound claim without fencing the guest", async () => {
		const guest = "guest-owner";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		await catalog.registerProject(guest, project);
		await catalog.registerProject(guest, {
			...project,
			id: "22222222-2222-4222-8222-222222222222",
		});
		expect(await catalog.beginClaim(guest, "account:owner", 1)).toEqual({
			status: "too-many",
			count: 2,
		});
		expect(await catalog.authorizeActiveGuest(guest)).toBe(true);
	});

	it("fences a revoked session beyond the normal 100-project view", async () => {
		const owner = "account:owner";
		const catalog = testEnv.ProjectCatalog.getByName(owner);
		for (let index = 0; index < 101; index++) {
			expect(
				await catalog.upsertAccountProject(owner, {
					...project,
					id: `project-${String(index).padStart(3, "0")}`,
					updatedAt: index,
				}),
			).toBe(true);
		}

		const sessionHash = "a".repeat(64);
		const expiresAt = Date.now() + 60_000;
		expect(await catalog.beginProjectTurn(owner, "project-pending", "b".repeat(64))).toBe(true);
		expect(await catalog.beginSessionRevocation(owner, sessionHash, expiresAt)).toBe(false);
		expect(await catalog.beginProjectTurn(owner, "project-pending", sessionHash)).toBe(false);
		await runInDurableObject(catalog, (instance) => instance.alarm());
		await runInDurableObject(catalog, (instance) => instance.alarm());
		expect(await catalog.beginSessionRevocation(owner, sessionHash, expiresAt)).toBe(true);
		expect(
			await catalog.upsertAccountProject(owner, {
				...project,
				id: "project-101",
				updatedAt: 101,
			}),
		).toBe(true);
		for (const projectId of ["project-000", "project-100", "project-101", "project-pending"]) {
			const agent = testEnv.BuilderAgent.getByName(projectId);
			expect(
				await runInDurableObject(agent, (instance) =>
					(
						instance as unknown as {
							isAccountSessionRevoked: (value: string) => boolean;
						}
					).isAccountSessionRevoked(sessionHash),
				),
			).toBe(true);
		}
		expect(await catalog.listProjects()).toHaveLength(100);
	});

	it("does not let an old failed delivery block a later session logout", async () => {
		const owner = "account:owner";
		const catalog = testEnv.ProjectCatalog.getByName(owner);
		await catalog.upsertAccountProject(owner, { ...project, id: "later-project" });
		const oldSession = "c".repeat(64);
		const expiresAt = Date.now() + 60_000;
		await runInDurableObject(catalog, (instance) => {
			const state = (instance as unknown as { ctx: DurableObjectState }).ctx;
			state.storage.sql.exec(
				"INSERT INTO account_session_revocations (session_hash, expires_at) VALUES (?, ?)",
				oldSession,
				expiresAt,
			);
			state.storage.sql.exec(
				"INSERT INTO account_session_revocation_deliveries (session_hash, project_id, expires_at) VALUES (?, ?, ?)",
				oldSession,
				"x".repeat(100),
				expiresAt,
			);
		});

		const laterSession = "d".repeat(64);
		expect(await catalog.beginSessionRevocation(owner, laterSession, expiresAt)).toBe(true);
		const oldPending = await runInDurableObject(catalog, (instance) => {
			const state = (instance as unknown as { ctx: DurableObjectState }).ctx;
			return state.storage.sql
				.exec<{ count: number }>(
					"SELECT COUNT(*) AS count FROM account_session_revocation_deliveries WHERE session_hash = ? AND delivered = 0",
					oldSession,
				)
				.one().count;
		});
		expect(oldPending).toBe(1);
	});
});

describe("project catalogue order", () => {
	beforeEach(() => reset());

	const second = { ...project, id: "22222222-2222-4222-8222-222222222222", title: "Second" };

	it("lists sites newest-created first, however they are used later", async () => {
		const guest = "order-guest";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		await catalog.registerProject(guest, { ...project, updatedAt: 1 });
		await catalog.registerProject(guest, { ...second, updatedAt: 2 });
		const ids = async () => (await catalog.listProjects()).map((item) => item.id);
		expect(await ids()).toEqual([second.id, project.id]);

		// Opening, renaming, a new turn, and sign-in reconciliation all touch the older site.
		await catalog.updateProject(guest, { ...project, status: "building", updatedAt: 50 });
		await catalog.renameProject(guest, project.id, "Renamed");
		await catalog.registerProject(guest, { ...project, updatedAt: 60 });
		await catalog.reconcileProject(guest, { ...project, updatedAt: 70 });
		expect(await ids()).toEqual([second.id, project.id]);
		const older = (await catalog.listProjects()).find((item) => item.id === project.id);
		expect(older).toMatchObject({ createdAt: 1, title: "Renamed" });
		// The rename stamped the real current time, which later, older stamps cannot undo.
		expect(older!.updatedAt).toBeGreaterThan(70);
		// Resuming the last-used site still follows use, not creation.
		expect(await catalog.firstAvailableProjectId()).toBe(project.id);
	});

	it("breaks a creation-time tie by id and keeps a claimed site's creation time", async () => {
		const guest = "tie-guest";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		await catalog.registerProject(guest, { ...project, updatedAt: 5 });
		await catalog.registerProject(guest, { ...second, updatedAt: 5 });
		expect((await catalog.listProjects()).map((item) => item.id)).toEqual([second.id, project.id]);

		const account = "account:order-owner";
		const accountCatalog = testEnv.ProjectCatalog.getByName(account);
		await accountCatalog.upsertAccountProject(account, { ...project, createdAt: 3, updatedAt: 90 });
		await accountCatalog.upsertAccountProject(account, {
			...project,
			createdAt: 80,
			updatedAt: 95,
		});
		expect(await accountCatalog.listProjects()).toMatchObject([{ createdAt: 3, updatedAt: 95 }]);
		// A retried claim carries the guest's older last use; it must not win.
		await accountCatalog.upsertAccountProject(account, { ...project, createdAt: 3, updatedAt: 40 });
		expect(await accountCatalog.listProjects()).toMatchObject([{ createdAt: 3, updatedAt: 95 }]);
	});

	it("backfills creation time for sites stored before it existed", async () => {
		const catalog = testEnv.ProjectCatalog.getByName("legacy-guest");
		const result = await runInDurableObject(catalog, (instance, state) => {
			const sql = state.storage.sql;
			sql.exec("DROP TABLE projects");
			sql.exec(
				"CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL)",
			);
			sql.exec(
				"INSERT INTO projects VALUES ('old', 'Old', 'draft', 10), ('new', 'New', 'draft', 20)",
			);
			(instance as unknown as { migrate(): void }).migrate();
			(instance as unknown as { migrate(): void }).migrate();
			return {
				rows: sql.exec("SELECT id, created_at FROM projects ORDER BY id").toArray(),
				index: sql
					.exec(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_created_at'",
					)
					.toArray().length,
			};
		});
		expect(result).toEqual({
			rows: [
				{ id: "new", created_at: 20 },
				{ id: "old", created_at: 10 },
			],
			index: 1,
		});
	});
});

describe("project catalogue building flag", () => {
	beforeEach(() => reset());

	it("shows a site as building only until its short-lived flag lapses", async () => {
		const guest = "activity-guest";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		await catalog.registerProject(guest, { ...project, updatedAt: 1 });
		const listed = async () => (await catalog.listProjects())[0]!;
		expect((await listed()).building).toBe(false);

		expect(await catalog.setProjectActivity(guest, project.id, true)).toBe(true);
		expect(await listed()).toMatchObject({ building: true, createdAt: 1, updatedAt: 1 });
		// Writes from turns or the client neither set nor clear it.
		await catalog.updateProject(guest, { ...project, updatedAt: 5 });
		expect((await listed()).building).toBe(true);

		// An instance that stopped renewing (evicted, crashed) lets it lapse.
		await runInDurableObject(catalog, (_instance, state) => {
			state.storage.sql.exec("UPDATE projects SET active_until = ?", Date.now() - 1);
		});
		expect((await listed()).building).toBe(false);

		await catalog.setProjectActivity(guest, project.id, true);
		expect(await catalog.setProjectActivity(guest, project.id, false)).toBe(true);
		expect((await listed()).building).toBe(false);
	});

	it("refuses the flag for unknown sites, other owners, and sites being deleted", async () => {
		const guest = "activity-owner";
		const catalog = testEnv.ProjectCatalog.getByName(guest);
		await catalog.registerProject(guest, project);
		expect(
			await catalog.setProjectActivity(guest, "33333333-3333-4333-8333-333333333333", true),
		).toBe(false);
		expect(await catalog.setProjectActivity("someone-else", project.id, true)).toBe(false);
		expect(await catalog.beginDeleteProject(guest, project.id)).toBe("ready");
		expect(await catalog.setProjectActivity(guest, project.id, true)).toBe(false);
	});
});
