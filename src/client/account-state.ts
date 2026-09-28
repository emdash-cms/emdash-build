export interface AccountStatus {
	authenticated: boolean;
	claimStatus?: "available" | "complete";
	returnPath?: string;
}

export function needsAuthCompletion(account: AccountStatus, pathname: string): boolean {
	if (!account.authenticated) return false;
	return pathname === "/auth/complete" || (account.claimStatus ?? "complete") !== "complete";
}

export function postAuthDestination(returnPath: string, recentProjectId?: string): string {
	return returnPath === "/" && recentProjectId ? `/s/${recentProjectId}` : returnPath;
}

export async function revokeAccountSession(): Promise<void> {
	const response = await fetch("/api/auth/logout", { method: "POST" });
	if (!response.ok) throw new Error("Sign out is temporarily unavailable.");
}
