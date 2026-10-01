import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { buildBuildPrompt, buildInterviewPrompt } from "../src/worker/prompts.js";

describe("builder template prototype", () => {
	it("uses a domain-neutral interview for the blank scaffold", () => {
		const prompt = buildInterviewPrompt();
		expect(prompt).toContain("content model or site direction");
		expect(prompt).toContain("ask_questions");
		expect(prompt).toContain("Call `ask_questions` at most once");
		expect(prompt).toContain("do not call the questionnaire");
		expect(prompt).not.toContain("do not call `ask_questions`");
		expect(prompt).toContain("provisioning continues in parallel");
		expect(prompt).toContain(
			"what the organisation, person, product, or publication actually does",
		);
		expect(prompt).toContain("Every predefined choice must be an answer");
		expect(prompt).toContain("Aim for three or four useful questions");
		expect(prompt).toContain("identity or positioning");
		expect(prompt).toContain("Choose the answer control intentionally");
		expect(prompt).toContain("Do not use `allow_multiple` for a question asking what is primary");
		expect(prompt.replace(/\s+/g, " ")).toContain("Set `allow_custom: false` only when");
		expect(prompt).toContain("Use a custom-only response");
		expect(prompt).not.toContain("Whether placeholder content is acceptable");
		expect(prompt).not.toContain("clearly marked editable placeholder");
		expect(prompt).not.toContain("Do not call any tools right now");
		expect(prompt).not.toContain("Always call `ask_questions`");
		expect(prompt).not.toContain("Pricing: tiers and prices");
	});

	it("gives the blank scaffold schema and no-public-React constraints", () => {
		const prompt = buildBuildPrompt({
			templateGuidance: "Template guidance marker.",
		});
		expect(prompt).toContain("Design the schema before the UI");
		expect(prompt).toContain("The public site must not use React");
		expect(prompt).toContain("Do not call validation, preview, or ad hoc `exec` checks again");
		expect(prompt).toContain("Template guidance marker.");
		expect(prompt).toContain("Render rich text with `<RichText");
		expect(prompt).toContain("`emdash/ui` has no `RichText`");
		expect(prompt).toContain('import RichText from "../../ui/RichText.astro";');
		expect(prompt).not.toContain("Render rich text with `<PortableText");
		expect(prompt).not.toContain("Keep the template's existing typefaces");
		expect(prompt).toContain("Current structured-block contract");
		expect(prompt).toContain("src/components/blocks/<block_slug>/index.astro");
		expect(prompt).toContain("Create `vN.astro`");
		expect(prompt).toContain("Preserve every surviving block’s `_key`, `_type`, `_version`");
		expect(prompt).toContain(
			'Do not declare `type: "repeater"` directly in a collection\'s fields',
		);
		expect(prompt).toContain("from `src/components/blocks/index.ts` with `../../../emdash-env`");
		// Edits match current text themselves; re-reading a file the model just wrote costs a step.
		expect(prompt).toContain("without reading it again");
		expect(prompt).not.toContain("Do this even if you authored the files earlier in the turn");
		expect(prompt).toContain("use `edit_files`");
		expect(prompt).toContain(
			"Never call `exec` in the same model step as `validate_site` or `view_preview`",
		);
		expect(prompt).toContain("smallest complete, navigable, editable version");
		expect(prompt).toContain(
			"default to a small, coherent set of subject-specific Unsplash images",
		);
		expect(prompt).toContain("do not describe the images as stock, sample, or placeholders");
		expect(prompt).toContain("never put scaffolding language");
		expect(prompt).not.toContain("strong, editable first version");
		expect(prompt).not.toContain(".agents/skills/frontend-design/SKILL.md");
		// A mid-build look is optional; validation delivers the final preview.
		expect(prompt).toContain("only when a visual decision is genuinely uncertain");
		expect(prompt).toContain("When it passes it also returns the final preview screenshot");
		expect(prompt).toContain('`status: "published"`');
		expect(prompt).not.toContain("Custom Portable Text blocks");
	});

	it("describes CMS programs only when the tool is available", () => {
		expect(buildBuildPrompt({})).not.toContain("run_cms_script");
		for (const editMode of [false, true]) {
			const prompt = buildBuildPrompt({ editMode, cmsScripts: true });
			expect(prompt).toContain("`run_cms_script`");
			expect(prompt).toContain("do not re-run it whole");
		}
	});

	it("puts initial block guidance after stale pinned and snapshot guidance", () => {
		const prompt = buildBuildPrompt({
			templateGuidance: "Obsolete pinned Custom Portable Text marker.",
			initialScaffoldContext: {
				templateGuidance: "Obsolete pinned Custom Portable Text marker.",
				files: [{ path: "src/pages/index.astro", content: "snapshot marker", bytes: 15 }],
				missingPaths: [],
			},
		});
		const contract = prompt.lastIndexOf("## Current structured-block contract");
		expect(contract).toBeGreaterThan(prompt.indexOf("Obsolete pinned"));
		expect(contract).toBeGreaterThan(prompt.indexOf("snapshot marker"));
		expect(prompt.slice(contract)).toContain("A `blocks` field");
		expect(prompt.slice(contract)).toContain("migrateBlocks: true");
		expect(prompt.trim()).toMatch(/rather than bypassing the validator\.$/);
	});

	it("ships first-class block guidance and the exhaustive version helper", async () => {
		const [guidance, helper] = await Promise.all([
			readFile(new URL("../prototype/builder-cloudflare/AGENTS.md", import.meta.url), "utf8"),
			readFile(
				new URL(
					"../prototype/builder-cloudflare/src/components/ui/block-versions.ts",
					import.meta.url,
				),
				"utf8",
			),
		]);
		expect(guidance).toContain("First-class `blocks` field");
		expect(guidance).toContain("src/components/blocks/<block_slug>/index.astro");
		expect(guidance).toContain("components={pages_layout}");
		expect(guidance).not.toContain("Custom Portable Text block");
		expect(helper).toContain('[Version in T["_version"]]');
		expect(helper).toContain("Record<number, BlockComponent<T> | undefined>");
		expect(helper).toContain("No renderer exists for block");
		expect(buildBuildPrompt({}).replace(/\s+/g, " ")).toContain(helper.trim().replace(/\s+/g, " "));
	});

	it("uses a compact follow-up prompt without first-build or scaffold guidance", () => {
		const prompt = buildBuildPrompt({
			editMode: true,
			templateGuidance: "Template guidance marker that must stay initial-only.",
			initialScaffoldContext: {
				templateGuidance: "Template guidance marker that must stay initial-only.",
				files: [{ path: "src/pages/index.astro", content: "snapshot marker", bytes: 15 }],
				missingPaths: [],
			},
		});
		expect(prompt).toContain("editing an existing EmDash CMS site");
		expect(prompt).toContain("Old tool output was omitted");
		expect(prompt).toContain("Preserve every surviving block's `_key`, `_type`, and `_version`");
		expect(prompt).toContain("read `.agents/skills/blocks-schema-evolution/SKILL.md`");
		expect(prompt).toContain("An older recovered project may lack");
		expect(prompt).toContain("defineBlockVersionComponents");
		expect(prompt).toContain("migrateBlocks: true");
		expect(prompt).toContain("do not set `replaceBlocks`");
		expect(prompt).not.toContain("A new site from a blank EmDash");
		expect(prompt).not.toContain("First useful version");
		expect(prompt).not.toContain("Template guidance marker");
		expect(prompt).not.toContain("snapshot marker");
		expect(prompt).not.toContain("### Initial generation");
		expect(prompt).toContain("The public site must not use React");
		expect(prompt).toContain("EmDashHead`, `EmDashBodyStart`, and `EmDashBodyEnd");
		expect(prompt).toContain("Astro.cache.set(cacheHint)");
		expect(prompt).toContain(
			"Never call `exec` in the same model step as `validate_site` or `view_preview`",
		);
		expect(prompt.length).toBeLessThan(6_000);
	});

	it("ships the focused block-evolution skill", async () => {
		const evolution = await readFile(
			new URL(
				"../prototype/builder-cloudflare/.agents/skills/blocks-schema-evolution/SKILL.md",
				import.meta.url,
			),
			"utf8",
		);
		expect(evolution).toContain("name: blocks-schema-evolution");
		expect(evolution).toContain("expectedFingerprint");
		expect(evolution).toContain("migrateBlocks: true");
	});

	it("uses Astro's pass-through image service in the local Sandbox scaffold", async () => {
		const config = await readFile(
			new URL("../prototype/builder-cloudflare/astro.config.mjs", import.meta.url),
			"utf8",
		);

		expect(config).toContain(
			'import { defineConfig, passthroughImageService } from "astro/config";',
		);
		expect(config).toContain("service: passthroughImageService(),");
	});
});
