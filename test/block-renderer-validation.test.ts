import { describe, expect, it } from "vitest";
import {
	validateBlockRendererContract,
	type BlockContractEvidence,
} from "../src/worker/block-renderer-validation.js";

const evidence: BlockContractEvidence = {
	fields: [
		{
			collection: "pages",
			field: "layout",
			fingerprint: "field-fingerprint",
			allowedTypes: ["bakery_intro"],
			retiredTypes: [],
			types: [{ slug: "bakery_intro", currentVersion: 1, versions: [1, 2] }],
		},
	],
};

function validFiles(): Record<string, string> {
	return {
		"src/components/blocks/index.ts": `
import BakeryIntro from "./bakery_intro/index.astro";
export const pages_layout = defineBlockComponents<PagesLayout>({ bakery_intro: BakeryIntro });`,
		"src/components/blocks/bakery_intro/index.astro": `
import { defineBlockVersionComponents, resolveBlockVersionComponent } from "../../ui/block-versions";
import V1 from "./v1.astro";
import V2 from "./v2.astro";
const versions = defineBlockVersionComponents<BakeryIntro>({ 1: V1, 2: V2 });
const Component = resolveBlockVersionComponent(value, versions);
---
<Component {...value} />`,
		"src/components/blocks/bakery_intro/v1.astro": "<section>v1</section>",
		"src/components/blocks/bakery_intro/v2.astro": "<section>v2</section>",
		"src/pages/index.astro": `
import Blocks from "emdash/components/Blocks.astro";
import { pages_layout } from "../components/blocks";
---
<Blocks value={page.data.layout} components={pages_layout} />`,
	};
}

function source(files: Record<string, string>) {
	return {
		listAstroFiles: async () =>
			Object.entries(files)
				.filter(([path]) => path.endsWith(".astro"))
				.map(([path, contents]) => ({ path, size: contents.length })),
		read: async (path: string) => files[path],
	};
}

describe("block renderer validation", () => {
	it("accepts exhaustive fixed-path type and version dispatch", async () => {
		await expect(validateBlockRendererContract(evidence, source(validFiles()))).resolves.toEqual({
			success: true,
			evidence,
			issues: [],
		});
	});

	it("rejects missing or bypassed renderer coverage", async () => {
		for (const mutate of [
			(files: Record<string, string>) =>
				delete files["src/components/blocks/bakery_intro/v2.astro"],
			(files: Record<string, string>) =>
				(files["src/components/blocks/index.ts"] = files["src/components/blocks/index.ts"]!.replace(
					"bakery_intro: BakeryIntro",
					"",
				)),
			(files: Record<string, string>) =>
				(files["src/components/blocks/bakery_intro/index.astro"] = "<section>inline</section>"),
			(files: Record<string, string>) =>
				(files["src/components/blocks/bakery_intro/index.astro"] = files[
					"src/components/blocks/bakery_intro/index.astro"
				]!.replace("<Component", "<section")),
			(files: Record<string, string>) =>
				(files["src/components/blocks/bakery_intro/index.astro"] = files[
					"src/components/blocks/bakery_intro/index.astro"
				]!.replace("{ 1: V1, 2: V2 }", "{ 1: V1 }")),
			(files: Record<string, string>) =>
				(files["src/pages/index.astro"] = files["src/pages/index.astro"]!.replace(
					"components={pages_layout}",
					"components={{ bakery_intro: BakeryIntro }}",
				)),
		]) {
			const files = validFiles();
			mutate(files);
			const result = await validateBlockRendererContract(evidence, source(files));
			expect(result.success).toBe(false);
			expect(result.issues.length).toBeGreaterThan(0);
		}
	});

	it("fails closed above the public Astro file bound", async () => {
		const files = validFiles();
		for (let index = 0; index < 257; index += 1) {
			files[`src/pages/extra-${index}.astro`] = "<main>Extra</main>";
		}
		await expect(validateBlockRendererContract(evidence, source(files))).resolves.toMatchObject({
			success: false,
			issues: [expect.stringContaining("256")],
		});
	});
});
