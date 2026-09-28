import { describe, expect, it } from "vitest";
import {
	mostRecentProjectId,
	sortProjects,
	upsertActiveProject,
} from "../src/client/recent-projects.js";

const site = (id: string, createdAt: number | undefined, updatedAt: number) => ({
	id,
	title: id,
	status: "draft" as const,
	createdAt,
	updatedAt,
});

describe("recent sites", () => {
	it("orders by creation, newest first, with legacy entries by their last update", () => {
		const sorted = sortProjects([
			site("a", 10, 90),
			site("b", 30, 30),
			site("legacy", undefined, 20),
			site("c", 30, 40),
		]);
		expect(sorted.map((project) => project.id)).toEqual(["c", "b", "legacy", "a"]);
	});

	it("updates the open site in place instead of moving it to the top", () => {
		const list = [site("new", 20, 20), site("open", 10, 10)];
		const renamed = upsertActiveProject(
			list,
			{ id: "open", title: "Renamed", status: "draft" },
			false,
		);
		expect(renamed.map((project) => project.id)).toEqual(["new", "open"]);
		expect(renamed[1]).toMatchObject({ title: "Renamed", createdAt: 10 });
		// Nothing changed: the same list comes back, so nothing is rewritten.
		expect(
			upsertActiveProject(renamed, { id: "open", title: "Renamed", status: "draft" }, false),
		).toBe(renamed);
	});

	it("puts a brand-new site on top and an unlisted older site at the end", () => {
		const list = [site("existing", Date.now() + 60_000, 1)];
		const created = upsertActiveProject(
			list,
			{ id: "fresh", title: "Fresh", status: "building" },
			true,
		);
		expect(created.map((project) => project.id)).toEqual(["fresh", "existing"]);
		expect(created[0]!.createdAt).toBeGreaterThan(created[1]!.createdAt!);
		const resumed = upsertActiveProject(list, { id: "old", title: "Old", status: "draft" }, false);
		expect(resumed.map((project) => project.id)).toEqual(["existing", "old"]);
	});

	it("picks the last-used site regardless of list order", () => {
		expect(mostRecentProjectId([site("new", 30, 30), site("used", 10, 99)])).toBe("used");
		expect(mostRecentProjectId([])).toBeUndefined();
	});
});
