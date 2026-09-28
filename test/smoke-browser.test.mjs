import { describe, expect, it } from "vitest";
import {
	browserResult,
	builderOriginForPreview,
	previewPageFromSnapshot,
} from "../scripts/smoke-browser.mjs";

describe("fresh preview browser audit", () => {
	it("preserves an explicit null browser evaluation result", () => {
		expect(browserResult({ data: { result: null, extra: "command metadata" } })).toBeNull();
	});

	it("derives the Builder origin that is allowed to frame a draft", () => {
		expect(
			builderOriginForPreview("http://4321-project-token.localhost:5177/stories?section=waterways"),
		).toBe("http://localhost:5177");
		expect(builderOriginForPreview("https://4321-project-token.build.emdashcms.com/")).toBe(
			"https://build.emdashcms.com",
		);
		expect(
			builderOriginForPreview(
				"https://4321-project-token.preview.build.example.com/",
				"https://build.example.com",
			),
		).toBe("https://build.example.com");
	});

	it("rejects URLs that are not Sandbox preview hosts", () => {
		expect(() => builderOriginForPreview("http://localhost:5177/")).toThrow(
			"Preview URL does not identify its Builder origin.",
		);
	});

	it("reads user-visible content from an inlined cross-origin iframe snapshot", () => {
		expect(
			previewPageFromSnapshot(
				{
					refs: {
						e1: { role: "Iframe", name: "" },
						e2: { role: "heading", name: "Fresh bread every morning" },
						e3: { role: "link", name: "Menu" },
					},
					snapshot:
						'- Iframe\n  - main\n    - heading "Fresh bread every morning"\n    - paragraph\n      - StaticText "Slow-fermented loaves baked in Bristol."',
				},
				{ title: "Crumb & Crust", links: [{ path: "/menu" }] },
			),
		).toEqual({
			title: "Crumb & Crust",
			heading: "Fresh bread every morning",
			mainText: "Fresh bread every morning Slow-fermented loaves baked in Bristol.",
			links: 1,
		});
	});

	it("only counts accessible content inside main", () => {
		expect(
			previewPageFromSnapshot(
				{
					refs: { e1: { role: "heading", name: "Site name" } },
					snapshot: '- banner\n  - StaticText "Site name"\n- main',
				},
				{ title: "Empty", links: [] },
			).mainText,
		).toBe("");

		expect(
			previewPageFromSnapshot(
				{
					refs: { e1: { role: "heading", name: "Photo journal" } },
					snapshot:
						'- main\n  - heading "Photo journal"\n  - img "Sunrise over the harbour"\n  - link "Open gallery"',
				},
				{ title: "Journal", links: [{ path: "/gallery" }] },
			).mainText,
		).toBe("Photo journal Sunrise over the harbour Open gallery");
	});
});
