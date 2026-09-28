export type ProjectCatalogStatus = "building" | "draft" | "live" | "failed";

/**
 * How long a site shows as building after its agent last said so. The agent
 * renews it well within this while work continues, so an instance that is
 * evicted or crashes stops shimmering on its own.
 */
export const BUILD_ACTIVITY_TTL_MS = 90_000;

export interface ProjectCatalogItem {
	id: string;
	title: string;
	status: ProjectCatalogStatus;
	/** Set once when the catalogue first records the site; lists are ordered by it. */
	createdAt?: number;
	updatedAt: number;
	/** Listed only: the site's agent reported work within the last short while. */
	building?: boolean;
}

export type RegisterProjectResult =
	| "registered"
	| "limit-reached"
	| "claim-in-progress"
	| "conflict";

export type BeginClaimResult =
	| { status: "started" | "resuming"; projects: ProjectCatalogItem[] }
	| { status: "busy" }
	| { status: "too-many"; count: number }
	| { status: "conflict" };

export function validateProjectCatalogItem(value: unknown): ProjectCatalogItem | undefined {
	if (!value || typeof value !== "object") return undefined;
	const item = value as Partial<ProjectCatalogItem>;
	if (typeof item.id !== "string" || !item.id) return undefined;
	if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 200) {
		return undefined;
	}
	if (!item.status || !["building", "draft", "live", "failed"].includes(item.status)) {
		return undefined;
	}
	if (!Number.isSafeInteger(item.updatedAt) || (item.updatedAt ?? 0) < 0) return undefined;
	if (
		item.createdAt !== undefined &&
		(!Number.isSafeInteger(item.createdAt) || item.createdAt < 0)
	) {
		return undefined;
	}
	return {
		id: item.id,
		title: item.title.trim(),
		status: item.status,
		...(item.createdAt !== undefined && { createdAt: item.createdAt }),
		updatedAt: item.updatedAt!,
	};
}
