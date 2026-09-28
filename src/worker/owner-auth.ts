import type { Principal } from "../platform/contracts.js";
import {
	AccountAuthStore,
	readAccountToken,
	type AccountSession,
	type IdentityBindings,
} from "./account-auth.js";
import { hashGuestToken, readGuestToken } from "./project-auth.js";

export interface ResolvedOwner {
	principal: Principal;
	ownerKey: string;
	kind: "guest" | "account";
	session?: AccountSession;
}

export interface OwnerResolution {
	owner?: ResolvedOwner;
	staleGuest: boolean;
}

type OwnerEnv = Env & IdentityBindings;

export async function resolveOwner(request: Request, env: OwnerEnv): Promise<OwnerResolution> {
	const accountToken = readAccountToken(request);
	if (accountToken) {
		const session = await AccountAuthStore.fromEnv(env).getSession(accountToken);
		if (session) {
			// A login does not interrupt an in-flight guest build. Until its project
			// claim completes, the matching guest cookie remains the project credential.
			const guestToken = session.claimGuestOwnerKey ? readGuestToken(request) : undefined;
			if (guestToken) {
				const guestOwnerKey = await hashGuestToken(guestToken);
				if (
					guestOwnerKey === session.claimGuestOwnerKey &&
					(await env.ProjectCatalog.getByName(guestOwnerKey).authorizeActiveGuest(guestOwnerKey))
				) {
					return {
						owner: {
							principal: { kind: "guest", capabilityId: guestOwnerKey },
							ownerKey: guestOwnerKey,
							kind: "guest",
						},
						staleGuest: false,
					};
				}
			}
			return {
				owner: {
					principal: session.principal,
					ownerKey: session.ownerKey,
					kind: "account",
					session,
				},
				staleGuest: false,
			};
		}
	}

	const guestToken = readGuestToken(request);
	if (!guestToken) return { staleGuest: false };
	const ownerKey = await hashGuestToken(guestToken);
	const active = await env.ProjectCatalog.getByName(ownerKey).authorizeActiveGuest(ownerKey);
	if (!active) return { staleGuest: true };
	return {
		owner: {
			principal: { kind: "guest", capabilityId: ownerKey },
			ownerKey,
			kind: "guest",
		},
		staleGuest: false,
	};
}
