import type { ProjectSummary } from "./components/ProjectSidebar.js";

/** Entries saved before creation times existed fall back to their last update. */
function createdAt(project: ProjectSummary): number {
	return project.createdAt ?? project.updatedAt ?? 0;
}

/** Newest-created first, ties by id descending (the catalogue's SQLite order). */
export function compareProjects(a: ProjectSummary, b: ProjectSummary): number {
	const byCreation = createdAt(b) - createdAt(a);
	if (byCreation !== 0) return byCreation;
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
	return [...projects].sort(compareProjects);
}

/**
 * Reflect the open site in the list without reordering it: opening or
 * renaming a site must never move it. A brand-new site joins at the top; an
 * older site outside the loaded list joins at the end.
 */
export function upsertActiveProject(
	projects: ProjectSummary[],
	active: Pick<ProjectSummary, "id" | "title" | "status">,
	isNew: boolean,
): ProjectSummary[] {
	const index = projects.findIndex((project) => project.id === active.id);
	const existing = projects[index];
	if (existing) {
		if (existing.title === active.title && existing.status === active.status) return projects;
		const next = [...projects];
		next[index] = { ...existing, title: active.title, status: active.status };
		return next;
	}
	const now = Date.now();
	if (!isNew) return [...projects, { ...active, createdAt: 0, updatedAt: now }];
	// Stay on top even when this browser's clock is behind the server's.
	const newest = projects.reduce((latest, project) => Math.max(latest, createdAt(project)), 0);
	return sortProjects([
		{ ...active, createdAt: Math.max(now, newest + 1), updatedAt: now },
		...projects,
	]);
}

/** The site used most recently, whatever its place in the creation-ordered list. */
export function mostRecentProjectId(projects: ProjectSummary[]): string | undefined {
	let recent: ProjectSummary | undefined;
	for (const project of projects) {
		if (!recent || project.updatedAt > recent.updatedAt) recent = project;
	}
	return recent?.id;
}

/** Drop the live building flag before saving: a stale copy must never shimmer. */
export function withoutLiveFlags(projects: ProjectSummary[]): ProjectSummary[] {
	return projects.map(({ building: _building, ...project }) => project);
}
