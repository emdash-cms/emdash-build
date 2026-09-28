import type { AccountSession, IdentityBindings } from "./account-auth.js";
import { AccountAuthStore } from "./account-auth.js";
import type { ProjectCatalogItem } from "./project-catalog-contract.js";

const MAX_CLAIM_PROJECTS = 100;
export const CLAIM_BLOCKED_MESSAGE = "Your projects could not be connected. Please retry.";
const CLAIM_WAIT_MESSAGE =
	"Waiting for your site to finish building. It will connect automatically.";

export type ClaimPassResult =
	| { status: "complete" }
	| { status: "waiting"; message: typeof CLAIM_WAIT_MESSAGE }
	| { status: "blocked"; message: typeof CLAIM_BLOCKED_MESSAGE };

type ClaimEnv = Env & IdentityBindings;

export async function runClaimPass(
	env: ClaimEnv,
	session: AccountSession,
	store = AccountAuthStore.fromEnv(env),
): Promise<ClaimPassResult> {
	const guestOwnerKey = session.claimGuestOwnerKey;
	if (!guestOwnerKey) return { status: "complete" };

	const guestCatalog = env.ProjectCatalog.getByName(guestOwnerKey);
	const accountCatalog = env.ProjectCatalog.getByName(session.ownerKey);
	const begun = await guestCatalog.beginClaim(guestOwnerKey, session.ownerKey, MAX_CLAIM_PROJECTS);
	if (begun.status === "busy") {
		return { status: "waiting", message: CLAIM_WAIT_MESSAGE };
	}
	if (begun.status === "too-many" || begun.status === "conflict") {
		return { status: "blocked", message: CLAIM_BLOCKED_MESSAGE };
	}

	let blocked = false;
	let waiting = false;
	for (const project of begun.projects) {
		const agent = env.BuilderAgent.getByName(project.id);
		const result = await agent.claimOwnership(guestOwnerKey, session.ownerKey);
		if (result === "busy") {
			waiting = true;
			continue;
		}
		if (result === "conflict") {
			blocked = true;
			continue;
		}

		// The build may have finished after beginClaim captured the guest catalogue.
		// Keep its chosen title, creation time and last use (so the account lists
		// it in place and resumes the site last used), but transfer the agent's
		// current build state.
		const current = await agent.getClaimableProjectSummary(session.ownerKey);
		const accountItem: ProjectCatalogItem = {
			...project,
			status: current?.status ?? project.status,
		};
		if (!(await accountCatalog.upsertAccountProject(session.ownerKey, accountItem))) {
			blocked = true;
			continue;
		}
		if (!(await guestCatalog.removeClaimedProject(session.ownerKey, project.id))) {
			blocked = true;
		}
	}

	if (blocked) {
		return { status: "blocked", message: CLAIM_BLOCKED_MESSAGE };
	}
	if (waiting || (await guestCatalog.listProjects()).length > 0) {
		return { status: "waiting", message: CLAIM_WAIT_MESSAGE };
	}
	if (!(await guestCatalog.completeClaim(session.ownerKey))) {
		return { status: "blocked", message: CLAIM_BLOCKED_MESSAGE };
	}
	await store.clearSessionGuestClaim(session.tokenHash, guestOwnerKey);
	return { status: "complete" };
}
