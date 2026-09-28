import { describe, expect, it } from "vitest";
import {
	validateProjectCatalogItem,
	type BeginClaimResult,
	type RegisterProjectResult,
} from "../src/worker/project-catalog-contract.js";

describe("project catalogue input", () => {
	it("normalizes a valid project", () => {
		expect(
			validateProjectCatalogItem({
				id: "project-1",
				title: "  Example site  ",
				status: "draft",
				updatedAt: 123,
			}),
		).toEqual({ id: "project-1", title: "Example site", status: "draft", updatedAt: 123 });
	});

	it("passes a creation time through and rejects an invalid one", () => {
		const item = { id: "project-1", title: "Example", status: "draft", updatedAt: 123 };
		expect(validateProjectCatalogItem({ ...item, createdAt: 100 })).toEqual({
			...item,
			createdAt: 100,
		});
		expect(validateProjectCatalogItem({ ...item, createdAt: -1 })).toBeUndefined();
		expect(validateProjectCatalogItem({ ...item, createdAt: "yesterday" })).toBeUndefined();
	});

	it("rejects invalid status and timestamps", () => {
		expect(
			validateProjectCatalogItem({
				id: "project-1",
				title: "Example",
				status: "deleted",
				updatedAt: -1,
			}),
		).toBeUndefined();
	});

	it("defines bounded registration and claim outcomes", () => {
		const registration: RegisterProjectResult = "claim-in-progress";
		const claim: BeginClaimResult = { status: "too-many", count: 101 };
		expect(registration).toBe("claim-in-progress");
		expect(claim).toEqual({ status: "too-many", count: 101 });
	});
});
