import { describe, expect, it } from "vitest";
import type { AccountAuthStore, AccountSession } from "../src/worker/account-auth.js";
import { CLAIM_BLOCKED_MESSAGE, runClaimPass } from "../src/worker/project-claim.js";
import type { ProjectCatalogItem } from "../src/worker/project-catalog-contract.js";

const item: ProjectCatalogItem = {
	id: "11111111-1111-4111-8111-111111111111",
	title: "Example",
	status: "draft",
	updatedAt: 1,
};

class FakeStore {
	cleared = false;
	async clearSessionGuestClaim() {
		this.cleared = true;
	}
}

class FakeCatalog {
	projects = new Map([[item.id, item]]);
	allowUpsert = true;
	allowRemove = true;

	async beginClaim() {
		return { status: "started" as const, projects: [...this.projects.values()] };
	}
	async listProjects() {
		return [...this.projects.values()];
	}
	async upsertAccountProject(_owner: string, project: ProjectCatalogItem) {
		if (!this.allowUpsert) return false;
		this.projects.set(project.id, project);
		return true;
	}
	async removeClaimedProject(_owner: string, projectId: string) {
		if (!this.allowRemove) return false;
		this.projects.delete(projectId);
		return true;
	}
	async completeClaim() {
		return this.projects.size === 0;
	}
}

const session = {
	principal: { kind: "account", issuer: "issuer", subject: "subject" },
	ownerKey: "account:owner",
	tokenHash: "session",
	returnPath: "/",
	claimGuestOwnerKey: "guest",
	expiresAt: Date.now() + 60_000,
} satisfies AccountSession;

describe("idle project claiming", () => {
	it("retries catalogue movement after the owner has already changed", async () => {
		const store = new FakeStore();
		const guest = new FakeCatalog();
		const account = new FakeCatalog();
		account.projects.clear();
		account.allowUpsert = false;
		let claimed = false;
		const env = {
			ProjectCatalog: {
				getByName(name: string) {
					return name === "guest" ? guest : account;
				},
			},
			BuilderAgent: {
				getByName() {
					return {
						async claimOwnership() {
							if (claimed) return "already-claimed" as const;
							claimed = true;
							return "claimed" as const;
						},
						async getClaimableProjectSummary() {
							return undefined;
						},
					};
				},
			},
		};

		expect(
			await runClaimPass(env as unknown as Env, session, store as unknown as AccountAuthStore),
		).toEqual({ status: "blocked", message: CLAIM_BLOCKED_MESSAGE });
		expect(guest.projects.has(item.id)).toBe(true);

		account.allowUpsert = true;
		guest.allowRemove = false;
		expect(
			await runClaimPass(env as unknown as Env, session, store as unknown as AccountAuthStore),
		).toEqual({ status: "blocked", message: CLAIM_BLOCKED_MESSAGE });
		expect(account.projects.has(item.id)).toBe(true);
		expect(guest.projects.has(item.id)).toBe(true);

		guest.allowRemove = true;
		expect(
			await runClaimPass(env as unknown as Env, session, store as unknown as AccountAuthStore),
		).toEqual({ status: "complete" });
		expect(guest.projects.has(item.id)).toBe(false);
		expect(account.projects.has(item.id)).toBe(true);
		expect(store.cleared).toBe(true);
	});

	it("leaves a busy project guest-owned until retry", async () => {
		const store = new FakeStore();
		const guest = new FakeCatalog();
		const account = new FakeCatalog();
		account.projects.clear();
		let result: "busy" | "claimed" = "busy";
		const env = {
			ProjectCatalog: {
				getByName(name: string) {
					return name === "guest" ? guest : account;
				},
			},
			BuilderAgent: {
				getByName() {
					return {
						claimOwnership: async () => result,
						getClaimableProjectSummary: async () => undefined,
					};
				},
			},
		};

		expect(
			await runClaimPass(env as unknown as Env, session, store as unknown as AccountAuthStore),
		).toEqual({ status: "waiting", message: expect.stringContaining("automatically") });
		expect(guest.projects.has(item.id)).toBe(true);

		result = "claimed";
		expect(
			await runClaimPass(env as unknown as Env, session, store as unknown as AccountAuthStore),
		).toEqual({ status: "complete" });
	});

	it("moves each site with its own creation and last-used times", async () => {
		const store = new FakeStore();
		const guest = new FakeCatalog();
		const older = { ...item, createdAt: 10, updatedAt: 90 };
		const newer = {
			...item,
			id: "22222222-2222-4222-8222-222222222222",
			createdAt: 50,
			updatedAt: 60,
		};
		guest.projects = new Map([
			[newer.id, newer],
			[older.id, older],
		]);
		const account = new FakeCatalog();
		account.projects.clear();
		const env = {
			ProjectCatalog: {
				getByName(name: string) {
					return name === "guest" ? guest : account;
				},
			},
			BuilderAgent: {
				getByName() {
					return {
						claimOwnership: async () => "claimed" as const,
						getClaimableProjectSummary: async () => ({ ...item, status: "building" as const }),
					};
				},
			},
		};

		expect(
			await runClaimPass(env as unknown as Env, session, store as unknown as AccountAuthStore),
		).toEqual({ status: "complete" });
		// The build's current status moves across; its place and recency stay the guest's.
		expect(account.projects.get(older.id)).toEqual({ ...older, status: "building" });
		expect(account.projects.get(newer.id)).toEqual({ ...newer, status: "building" });
	});
});
