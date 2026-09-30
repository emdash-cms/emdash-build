// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReasoningBlock } from "../src/client/components/ReasoningBlock.js";
import { ShimmerText } from "../src/client/components/ShimmerText.js";
import { ToolCard } from "../src/client/components/ToolCard.js";
import { Markdown } from "../src/client/components/Markdown.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("active chat activity", () => {
	it("loads a retained screenshot only when its preview step opens", async () => {
		const user = userEvent.setup();
		const loadPreviewThumbnail = vi.fn(async () => ({
			base64: "cGljdHVyZQ==",
			mediaType: "image/png" as const,
		}));
		render(
			<ToolCard
				part={{
					type: "tool-view_preview",
					state: "output-available",
					output: { success: true, shotId: "shot-1" },
				}}
				variant="timeline"
				loadPreviewThumbnail={loadPreviewThumbnail}
			/>,
		);
		expect(loadPreviewThumbnail).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Reviewed the preview" }));
		await waitFor(() => expect(loadPreviewThumbnail).toHaveBeenCalledWith("shot-1"));
		const image = await screen.findByRole("img", {
			name: "Preview screenshot captured during this step",
		});
		expect(image.getAttribute("src")).toBe("data:image/png;base64,cGljdHVyZQ==");
	});

	it("shows the final screenshot a passing validation captured", async () => {
		const user = userEvent.setup();
		const loadPreviewThumbnail = vi.fn(async () => ({
			base64: "dmFsaWRhdGVk",
			mediaType: "image/png" as const,
		}));
		render(
			<ToolCard
				part={{
					type: "tool-validate_site",
					state: "output-available",
					output: {
						success: true,
						stdout: "Rendered public-site audit passed for 1 route(s).",
						preview: { shotId: "shot-validated", revision: 3 },
					},
				}}
				variant="timeline"
				loadPreviewThumbnail={loadPreviewThumbnail}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Validated site/ }));
		await waitFor(() => expect(loadPreviewThumbnail).toHaveBeenCalledWith("shot-validated"));
		const image = await screen.findByRole("img", {
			name: "Preview screenshot captured during this step",
		});
		expect(image.getAttribute("src")).toBe("data:image/png;base64,dmFsaWRhdGVk");
	});

	it("explains unavailable older preview screenshots without claiming a current image is historical", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-view_preview",
					state: "output-available",
					output: { success: true, shotId: "old-shot" },
				}}
				variant="timeline"
				loadPreviewThumbnail={async () => null}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Reviewed the preview" }));
		await screen.findByText(
			"Screenshot unavailable for this step. Back to site shows the current site.",
		);
		expect(
			screen.queryByRole("img", { name: "Preview screenshot captured during this step" }),
		).toBeNull();
	});

	it("does not show a stale screenshot when a tool step changes", async () => {
		const user = userEvent.setup();
		const loadPreviewThumbnail = vi.fn(async (shotId: string) => ({
			base64: shotId === "shot-one" ? "b25l" : "dHdv",
			mediaType: "image/png" as const,
		}));
		const part = (shotId: string) => ({
			type: "tool-view_preview",
			state: "output-available",
			output: { success: true, shotId },
		});
		const view = render(
			<ToolCard
				part={part("shot-one")}
				variant="timeline"
				loadPreviewThumbnail={loadPreviewThumbnail}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Reviewed the preview" }));
		await screen.findByRole("img", { name: "Preview screenshot captured during this step" });
		view.rerender(
			<ToolCard
				part={part("shot-two")}
				variant="timeline"
				loadPreviewThumbnail={loadPreviewThumbnail}
			/>,
		);
		expect(
			screen.queryByRole("img", { name: "Preview screenshot captured during this step" }),
		).toBeNull();
		const image = await screen.findByRole("img", {
			name: "Preview screenshot captured during this step",
		});
		expect(image.getAttribute("src")).toBe("data:image/png;base64,dHdv");
	});

	it("keeps one pending screenshot request across parent callback updates", async () => {
		const user = userEvent.setup();
		let finishRequest: ((value: { base64: string; mediaType: "image/png" }) => void) | undefined;
		const firstLoader = vi.fn(
			() =>
				new Promise<{ base64: string; mediaType: "image/png" }>((resolve) => {
					finishRequest = resolve;
				}),
		);
		const secondLoader = vi.fn(async () => ({ base64: "bmV3", mediaType: "image/png" as const }));
		const part = {
			type: "tool-view_preview",
			state: "output-available",
			output: { success: true, shotId: "shot-one" },
		};
		const view = render(
			<ToolCard part={part} variant="timeline" loadPreviewThumbnail={firstLoader} />,
		);
		await user.click(screen.getByRole("button", { name: "Reviewed the preview" }));
		expect(firstLoader).toHaveBeenCalledTimes(1);
		view.rerender(<ToolCard part={part} variant="timeline" loadPreviewThumbnail={secondLoader} />);
		await act(async () => finishRequest?.({ base64: "b2xk", mediaType: "image/png" }));
		expect(secondLoader).not.toHaveBeenCalled();
		expect(
			screen
				.getByRole("img", { name: "Preview screenshot captured during this step" })
				.getAttribute("src"),
		).toBe("data:image/png;base64,b2xk");
	});

	it("retries a transient screenshot load error when reopened", async () => {
		const user = userEvent.setup();
		let attempts = 0;
		const loadPreviewThumbnail = vi.fn(async () => {
			if (++attempts === 1) throw new Error("offline");
			return { base64: "cGljdHVyZQ==", mediaType: "image/png" as const };
		});
		render(
			<ToolCard
				part={{
					type: "tool-view_preview",
					state: "output-available",
					output: { success: true, shotId: "shot-1" },
				}}
				variant="timeline"
				loadPreviewThumbnail={loadPreviewThumbnail}
			/>,
		);
		const trigger = screen.getByRole("button", { name: "Reviewed the preview" });
		await user.click(trigger);
		await screen.findByText("Screenshot could not load. Close and reopen to retry.");
		expect(loadPreviewThumbnail).toHaveBeenCalledTimes(1);
		await user.click(trigger);
		await user.click(trigger);
		await screen.findByRole("img", { name: "Preview screenshot captured during this step" });
		expect(loadPreviewThumbnail).toHaveBeenCalledTimes(2);
	});

	it("shimmers active labels without duplicating accessible text", () => {
		render(<ShimmerText>Thinking</ShimmerText>);

		const label = screen.getByText("Thinking");
		expect(label.classList.contains("shimmer-text")).toBe(true);
		expect(label.hasAttribute("data-text")).toBe(false);
		expect(screen.getAllByText("Thinking")).toHaveLength(1);
	});

	it("uses the compact VibeSDK-style reasoning surface while thinking", () => {
		const view = render(
			<ReasoningBlock text="Checking the current component structure." streaming />,
		);

		const trigger = screen.getByRole("button", { name: "Thinking" });
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(trigger.querySelectorAll("svg")).toHaveLength(1);
		expect(trigger.querySelector("svg")?.classList.contains("motion-reduce:transition-none")).toBe(
			true,
		);
		expect(view.container.querySelector("[data-reasoning-state]")?.className).toContain(
			"border-border",
		);
		expect(screen.getByText("Thinking").classList.contains("shimmer-text")).toBe(true);
		expect(view.container.querySelector(".reasoning-stream .smd-content")?.textContent).toContain(
			"Checking the current component structure",
		);
	});

	it("shimmers active tool text and keeps the row non-interactive", () => {
		render(
			<ToolCard
				part={{
					type: "tool-read_file",
					state: "input-available",
					input: { path: "src/App.tsx" },
				}}
				active
			/>,
		);

		const label = screen.getByText("Reading file src/App.tsx…");
		expect(label.classList.contains("shimmer-text")).toBe(true);
		expect(screen.queryByRole("button", { name: "Reading file src/App.tsx…" })).toBeNull();
		expect(label.closest("[data-tool-state]")?.querySelector("svg")).toBeNull();
		expect(label.closest("[data-tool-state]")?.getAttribute("data-tool-state")).toBe("active");
	});

	it("uses readable block schema activity labels", () => {
		for (const [type, input, label] of [
			["tool-schema_list_block_types", {}, "Listed block types"],
			["tool-schema_get_block_type", { slug: "bakery_intro" }, "Got block type bakery_intro"],
			[
				"tool-schema_update_block_type",
				{ slug: "bakery_intro" },
				"Updated block type bakery_intro",
			],
			[
				"tool-schema_activate_block_type_version",
				{ slug: "bakery_intro", version: 2 },
				"Activated block version bakery_intro · v2",
			],
			[
				"tool-update_blocks_field",
				{ collection: "pages", fieldSlug: "layout" },
				"Updated page sections pages.layout",
			],
		] as const) {
			const view = render(
				<ToolCard part={{ type, state: "output-available", input, output: { success: true } }} />,
			);
			expect(screen.getByText(label)).toBeTruthy();
			view.unmount();
		}
	});

	it("summarizes changed and unchanged schema plans", () => {
		const changed = render(
			<ToolCard
				part={{
					type: "tool-apply_schema_plan",
					state: "output-available",
					output: {
						success: true,
						changed: true,
						createdBlockTypes: 2,
						createdCollections: 2,
					},
				}}
			/>,
		);
		expect(screen.getByText("Created content model · 2 block types, 2 collections")).toBeTruthy();
		changed.unmount();

		render(
			<ToolCard
				part={{
					type: "tool-apply_schema_plan",
					state: "output-available",
					output: { success: true, changed: false, skippedBlockTypes: 2 },
				}}
			/>,
		);
		expect(screen.getByText("Content model up to date")).toBeTruthy();
	});

	it("explains collection repeater schema corrections without implying the turn crashed", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-apply_schema_plan",
					state: "output-error",
					input: {
						collections: [
							{
								slug: "projects",
								fields: [{ slug: "gallery", type: "repeater" }],
							},
						],
					},
					errorText: "Something went wrong on that turn. Please try again in a moment.",
				}}
				variant="timeline"
			/>,
		);

		await user.click(screen.getByRole("button", { name: "Content model needed adjustment" }));
		expect(
			screen.getByText(
				"The proposed projects.gallery field used a collection repeater, which the current schema tools cannot create. No schema changes were applied. The agent should retry with a subject-specific block type and a blocks field.",
			),
		).toBeTruthy();
		expect(screen.queryByText(/Something went wrong on that turn/)).toBeNull();
	});

	it("does not animate an interrupted persisted tool call", () => {
		render(
			<ToolCard
				part={{
					type: "tool-apply_schema_plan",
					state: "input-available",
				}}
			/>,
		);

		const label = screen.getByText("Stopped creating content model");
		expect(label.classList.contains("shimmer-text")).toBe(false);
		expect(screen.queryByRole("button", { name: "Stopped creating content model" })).toBeNull();
		expect(label.closest("[data-tool-state]")?.getAttribute("data-tool-state")).toBe("interrupted");
	});

	it("keeps completed tool text static and reveals details on demand", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-read_file",
					state: "output-available",
					input: { path: "src/App.tsx" },
					output: { content: "export default App" },
				}}
			/>,
		);

		const trigger = screen.getByRole("button", { name: "Read file src/App.tsx" });
		expect(screen.getByText("Read file src/App.tsx").classList.contains("shimmer-text")).toBe(
			false,
		);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(trigger.querySelector("svg")?.classList.contains("motion-reduce:transition-none")).toBe(
			true,
		);
		await user.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Output")).toBeTruthy();
		expect(
			trigger.closest("[data-tool-state]")?.querySelector('[class*="collapsible-panel-height"]')
				?.className,
		).toContain("transition-[height,opacity]");
	});

	it("toggles tool details repeatedly from the keyboard", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-content_create",
					state: "output-available",
					input: { collection: "pages" },
					output: { success: true },
				}}
			/>,
		);
		const trigger = screen.getByRole("button", { name: "Created content pages" });
		trigger.focus();
		await user.keyboard("{Enter}");
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		await user.keyboard("{Enter}");
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		await user.keyboard("{Enter}");
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Output")).toBeTruthy();
	});

	it("summarizes partial media uploads without implying every photo reached the site", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-upload_media",
					state: "output-available",
					input: {
						images: [
							{
								url: "https://images.example/one.jpg",
								alt: "South Coast beach",
								filename: "coast.jpg",
							},
							{ url: "https://images.example/two.jpg", alt: "Mountain ridge" },
						],
					},
					output: {
						success: true,
						count: 2,
						uploaded: 1,
						results: [
							{ url: "https://images.example/one.jpg", success: true, mediaId: "media-1" },
							{
								url: "https://images.example/two.jpg",
								success: false,
								error: "Download timed out",
							},
						],
					},
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Uploaded 1 of 2 photos" }));
		expect(screen.getByText("South Coast beach")).toBeTruthy();
		expect(screen.getByText("Added to media library")).toBeTruthy();
		expect(screen.getByText("Mountain ridge")).toBeTruthy();
		expect(screen.getByText("Could not upload · Download timed out")).toBeTruthy();
		expect(screen.queryByText("Input")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Technical details" }));
		expect(screen.getByText("Input")).toBeTruthy();
	});

	it("shows the recorded replacement rather than inventing a full-file diff", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-edit_file",
					state: "output-available",
					input: {
						path: "src/pages/index.astro",
						oldText: "<h1>Old title</h1>",
						newText: "<h1>New title</h1>",
					},
					output: { success: true, changed: true, path: "src/pages/index.astro" },
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Edited src/pages/index.astro" }));
		expect(screen.getByText("Before").parentElement?.nextElementSibling?.textContent).toContain(
			"<h1>Old title</h1>",
		);
		expect(screen.getByText("After").parentElement?.nextElementSibling?.textContent).toContain(
			"<h1>New title</h1>",
		);
		expect(screen.queryByText(/\+\d+|−\d+/)).toBeNull();
	});

	it("previews a whole-file write without calling it a diff", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-write_file",
					state: "output-available",
					input: { path: "src/site.css", content: "body { color: coral; }" },
					output: { success: true, changed: true },
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Wrote src/site.css" }));
		expect(screen.getByText("File content").nextElementSibling?.textContent).toBe("src/site.css");
		expect(
			screen.getByText("File content").parentElement?.nextElementSibling?.textContent,
		).toContain("body { color: coral; }");
		expect(screen.queryByText("Previous version")).toBeNull();
	});

	it("highlights recorded Astro code in both themes without rendering its markup", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-write_file",
					state: "output-available",
					input: {
						path: "src/components/ProjectCard.astro",
						content: '---\nimport { Image } from "emdash/ui";\n---\n<h1>Hi</h1>',
					},
					output: { success: true, changed: true },
				}}
				variant="timeline"
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Wrote src/components/ProjectCard.astro" }),
		);
		await waitFor(() =>
			expect(document.querySelectorAll(".activity-code-token").length).toBeGreaterThan(2),
		);
		const importToken = screen.getByText("import");
		expect(importToken.getAttribute("style")).toContain("--code-light:");
		expect(importToken.getAttribute("style")).toContain("--code-dark:");
		expect(
			screen.getByText("File content").parentElement?.nextElementSibling?.textContent,
		).toContain("<h1>Hi</h1>");
		expect(document.querySelector("h1")).toBeNull();
		expect(screen.queryByText("Previous version")).toBeNull();
	});

	it("keeps snippets as recorded and falls back to plain text for unsupported files", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-edit_file",
					state: "output-available",
					input: {
						path: "src/components/Card.unknown",
						oldText: "old value",
						newText: "new value",
					},
					output: { success: true, changed: true },
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Edited src/components/Card.unknown" }));
		expect(screen.getByText("Before").parentElement?.nextElementSibling?.textContent).toContain(
			"−old value",
		);
		expect(screen.getByText("After").parentElement?.nextElementSibling?.textContent).toContain(
			"+new value",
		);
		expect(document.querySelector(".activity-code-token")).toBeNull();
	});

	it("reports only verified routes from the validation result", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-validate_site",
					state: "output-available",
					output: {
						success: true,
						publicSiteAudit: { success: true, checkedPaths: ["/", "/about"], issues: [] },
						stdout: "Astro check completed",
					},
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Checked site · 2 routes passed" }));
		expect(screen.getByText("2 public routes checked")).toBeTruthy();
		expect(screen.getByText("Validation passed")).toBeTruthy();
		expect(screen.getByText("/")).toBeTruthy();
		expect(screen.getByText("/about")).toBeTruthy();
		expect(screen.queryByText("0 errors")).toBeNull();
	});

	it("names the loaded, updated, and published Home page from recorded targets", async () => {
		const user = userEvent.setup();
		render(
			<>
				<ToolCard
					part={{
						type: "tool-content_get",
						state: "output-available",
						input: { collection: "pages", id: "home" },
						output: { success: true },
					}}
					variant="timeline"
				/>
				<ToolCard
					part={{
						type: "tool-content_update",
						state: "output-available",
						input: {
							collection: "pages",
							id: "home",
							data: { hero_image: { id: "media-1" } },
						},
						output: { success: true },
					}}
					variant="timeline"
				/>
				<ToolCard
					part={{
						type: "tool-content_publish",
						state: "output-available",
						input: { collection: "pages", id: "home" },
						output: { success: true },
					}}
					variant="timeline"
				/>
			</>,
		);
		expect(screen.getByRole("button", { name: "Loaded Home page" })).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Updated Home page · Hero image" }));
		expect(screen.getByText("Updated field: Hero image")).toBeTruthy();
		expect(screen.queryByRole("img", { name: /hero image/i })).toBeNull();
		expect(screen.getByRole("button", { name: "Published Home page" })).toBeTruthy();
	});

	it("previews an updated image only when the recorded field includes its URL", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-content_update",
					state: "output-available",
					input: {
						collection: "pages",
						id: "home",
						data: {
							hero_image: {
								url: "https://images.example/photo.jpg",
								alt: "South Coast landscape",
							},
						},
					},
					output: { success: true },
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Updated Home page · Hero image" }));
		const image = screen.getByRole("img", { name: "South Coast landscape" });
		expect(image.getAttribute("src")).toBe("https://images.example/photo.jpg");
	});

	it("summarizes multiple fields without marking a failed update as successful", async () => {
		const user = userEvent.setup();
		render(
			<>
				<ToolCard
					part={{
						type: "tool-content_update",
						state: "output-available",
						input: {
							collection: "pages",
							id: "home",
							data: { title: "New title", hero_image: "media-1" },
						},
						output: { success: true },
					}}
					variant="timeline"
				/>
				<ToolCard
					part={{
						type: "tool-content_update",
						state: "output-error",
						input: { collection: "pages", id: "home", data: { hero_image: "media-2" } },
						errorText: "Revision conflict",
					}}
					variant="timeline"
				/>
			</>,
		);
		await user.click(screen.getByRole("button", { name: "Updated Home page · 2 fields" }));
		expect(screen.getByText("Updated fields: Title, Hero image")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Failed to update Home page" })).toBeTruthy();
	});

	it("keeps generic labels for incomplete targets and missing audit evidence", async () => {
		render(
			<>
				<ToolCard
					part={{
						type: "tool-content_update",
						state: "output-available",
						input: { collection: "pages", data: { hero_image: "media-1" } },
						output: { success: true },
					}}
					variant="timeline"
				/>
				<ToolCard
					part={{
						type: "tool-validate_site",
						state: "output-available",
						output: { success: true },
					}}
					variant="timeline"
				/>
			</>,
		);
		expect(screen.getByRole("button", { name: "Updated content" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Validated site" })).toBeTruthy();
	});

	it("does not report success for a failed validation without an output object", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{ type: "tool-validate_site", state: "output-error", errorText: "Timed out" }}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Site validation failed" }));
		expect(screen.getByText("Validation failed")).toBeTruthy();
		expect(screen.queryByText("Validation passed")).toBeNull();
	});

	it("does not invent an upload count for older media results", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-upload_media",
					state: "output-available",
					input: { images: [{ url: "https://images.example/one.jpg", alt: "South Coast beach" }] },
					output: { success: true },
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Added images South Coast beach" }));
		expect(screen.getByText("Upload status unavailable")).toBeTruthy();
		expect(screen.queryByText("Added to media library")).toBeNull();
	});

	it("does not attribute another photo's result to the wrong upload", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-upload_media",
					state: "output-available",
					input: { images: [{ url: "https://images.example/one.jpg", alt: "South Coast beach" }] },
					output: {
						success: true,
						count: 1,
						uploaded: 1,
						results: [{ url: "https://images.example/other.jpg", success: true }],
					},
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Uploaded 1 photo" }));
		expect(screen.getByText("Upload status unavailable")).toBeTruthy();
		expect(screen.queryByText("Added to media library")).toBeNull();
	});

	it("labels a skipped file mutation as up to date, not edited", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-edit_file",
					state: "output-available",
					input: { path: "src/site.css", oldText: "red", newText: "red" },
					output: { success: true, changed: false },
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Up to date src/site.css" }));
		expect(screen.getByText("Already up to date")).toBeTruthy();
		expect(screen.queryByText("Replaced in src/site.css")).toBeNull();
	});

	it("opens a persisted media step even when an old image input is malformed", async () => {
		const user = userEvent.setup();
		render(
			<ToolCard
				part={{
					type: "tool-upload_media",
					state: "output-available",
					input: { images: [null] },
					output: { success: false, count: 1, uploaded: 0, results: [{ success: false }] },
				}}
				variant="timeline"
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Failed to add images image" }));
		expect(screen.getByText("Photo 1")).toBeTruthy();
		expect(screen.getByText("Could not upload")).toBeTruthy();
	});

	it("describes an entry batch by its collection, count, and actual outcome", () => {
		const entries = (count: number) =>
			Array.from({ length: count }, (_, index) => ({ title: `Entry ${index}`, brief: "b" }));
		const label = (part: Record<string, unknown>, active = false) => {
			const view = render(
				<ToolCard
					part={{ type: "tool-create_entries_batch", ...part }}
					active={active}
					variant="timeline"
				/>,
			);
			const text = view.container.querySelector("[data-tool-state] span")?.textContent;
			view.unmount();
			return text;
		};
		const input = { collection: "blog_posts", entries: entries(5) };
		// The collection name is still arriving until a later key starts.
		expect(label({ state: "input-streaming", input: { collection: "blog_po" } }, true)).toBe(
			"Adding entries…",
		);
		expect(
			label({ state: "input-streaming", input: { collection: "blog_posts", entries: [] } }, true),
		).toBe("Adding entries to Blog posts…");
		expect(label({ state: "input-streaming", input: {} }, true)).toBe("Adding entries…");
		expect(label({ state: "input-available", input }, true)).toBe(
			"Adding 5 entries to Blog posts…",
		);
		expect(
			label({ state: "input-available", input: { ...input, entries: entries(1) } }, true),
		).toBe("Adding 1 entry to Blog posts…");
		expect(
			label({
				state: "output-available",
				input,
				output: { success: true, created: 5, total: 5 },
			}),
		).toBe("Added 5 entries to Blog posts");
		expect(
			label({
				state: "output-available",
				input,
				output: { success: true, created: 3, total: 5 },
			}),
		).toBe("Added 3 of 5 entries to Blog posts");
		expect(
			label({
				state: "output-available",
				input,
				output: { success: false, created: 0, total: 5 },
			}),
		).toBe("Failed to add entries to Blog posts");
		expect(label({ state: "output-error", input, errorText: "x" })).toBe(
			"Failed to add entries to Blog posts",
		);
		expect(label({ state: "input-available", input })).toBe("Stopped adding entries to Blog posts");
		expect(label({ state: "output-available", input, output: { success: true, created: 5 } })).toBe(
			"Added 5 entries to Blog posts",
		);
		expect(label({ state: "output-available", input, output: { success: true } })).toBe(
			"Added 5 entries to Blog posts",
		);
	});

	it("names a file only once its streamed path is complete", () => {
		const part = (input: Record<string, unknown>) => ({
			type: "tool-write_file",
			state: "input-streaming",
			input,
		});
		const view = render(<ToolCard part={part({ path: "src/pa" })} active variant="timeline" />);
		const row = () => view.container.querySelector("[data-tool-state]")!;
		expect(row().textContent).toBe("Writing file…");
		view.rerender(
			<ToolCard
				part={part({ path: "src/pages/index.astro", content: "<" })}
				active
				variant="timeline"
			/>,
		);
		expect(row().textContent).toBe("Writing fileindex.astro");
	});

	it("names failed steps in words now that no status dot marks them", () => {
		render(
			<>
				<ToolCard
					part={{
						type: "tool-read_files",
						state: "output-error",
						input: { paths: ["src/a.astro"] },
						errorText: "denied",
					}}
					variant="timeline"
				/>
				<ToolCard
					part={{ type: "tool-mystery_step", state: "output-error", input: {}, errorText: "x" }}
					variant="timeline"
				/>
			</>,
		);
		expect(screen.getByRole("button", { name: "Failed to read files" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Mystery step failed" })).toBeTruthy();
		expect(document.querySelectorAll('[data-tool-state="error"]')).toHaveLength(2);
		expect(document.querySelector('[data-tool-state="error"] span[aria-hidden="true"]')).toBeNull();
	});
});

describe("reasoning stream", () => {
	it("collapses automatically when thinking finishes", () => {
		const view = render(<ReasoningBlock text="Live reasoning" streaming />);
		expect(screen.getByRole("button", { name: "Thinking" }).getAttribute("aria-expanded")).toBe(
			"true",
		);

		view.rerender(<ReasoningBlock text="Live reasoning" streaming={false} />);
		expect(screen.getByRole("button", { name: /Thought/ }).getAttribute("aria-expanded")).toBe(
			"false",
		);
		expect(view.container.querySelector(".reasoning-stream-viewport")).toBeNull();
		expect(view.container.querySelector(".smd-content")?.textContent).toBe("Live reasoning");
	});

	it("keeps finished thinking ready and its outer spacing stable across toggles", async () => {
		const user = userEvent.setup();
		const view = render(<ReasoningBlock text="Live reasoning" streaming />);
		view.rerender(<ReasoningBlock text="Live reasoning" streaming={false} />);
		const root = view.container.querySelector("[data-reasoning-state]")!;
		const content = root.querySelector(".smd-content");
		const initialPadding = root.className.match(/\bpy-\S+/g);
		expect(initialPadding).toEqual(["py-1.5"]);
		expect(content?.textContent).toBe("Live reasoning");
		const trigger = screen.getByRole("button", { name: /Thought/ });
		await user.click(trigger);
		expect(screen.getByText("Live reasoning")).toBeTruthy();
		expect(root.querySelector(".smd-content")).toBe(content);
		expect(root.className.match(/\bpy-\S+/g)).toEqual(initialPadding);
		await user.click(trigger);
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(root.className.match(/\bpy-\S+/g)).toEqual(initialPadding);
		expect(view.container.querySelector(".reasoning-stream-viewport")).toBeNull();
	});

	it("moves the masked viewport to the newest reasoning", () => {
		const view = render(<ReasoningBlock text="First line" streaming />);
		const viewport = view.container.querySelector<HTMLElement>(".reasoning-stream-viewport");
		const scroll = view.container.querySelector<HTMLElement>(".reasoning-stream-scroll");
		expect(viewport).not.toBeNull();
		expect(scroll).not.toBeNull();
		Object.defineProperty(viewport!, "clientHeight", { configurable: true, value: 48 });
		Object.defineProperty(scroll!, "scrollHeight", { configurable: true, value: 120 });

		view.rerender(
			<ReasoningBlock
				text={"First line\nSecond line\nThird line\nFourth line\nFifth line"}
				streaming
			/>,
		);

		expect(scroll!.style.transform).toBe("translateY(-72px)");
		expect(scroll!.style.transition).toContain("var(--reason-step)");
	});

	it("shows the full transcript without the moving viewport after completion", async () => {
		const user = userEvent.setup();
		render(<ReasoningBlock text="Finished reasoning" streaming={false} />);

		await user.click(screen.getByRole("button", { name: "Thought" }));
		expect(screen.getByText("Finished reasoning")).toBeTruthy();
		expect(
			document.querySelector('[data-reasoning-state] [class*="collapsible-panel-height"]')
				?.className,
		).toContain("motion-reduce:transition-none");
		expect(document.querySelector(".reasoning-stream-viewport")).toBeNull();
	});

	it("formats Markdown in live and reopened reasoning instead of showing raw markers", async () => {
		const user = userEvent.setup();
		const text = "**Reviewing user screenshot**\n\nUse `src/styles.css`.";
		const view = render(<ReasoningBlock text={text} streaming />);
		expect(view.container.querySelector(".reasoning-stream strong")?.textContent).toBe(
			"Reviewing user screenshot",
		);
		expect(screen.getByText("src/styles.css").tagName).toBe("CODE");

		view.rerender(<ReasoningBlock text={text} streaming={false} />);
		await user.click(screen.getByRole("button", { name: /Thought/ }));
		expect(view.container.querySelector("[data-reasoning-state] strong")?.textContent).toBe(
			"Reviewing user screenshot",
		);
		expect(screen.getByText("src/styles.css").tagName).toBe("CODE");
		expect(view.container.textContent).not.toContain("**Reviewing user screenshot**");
	});

	it("renders a persisted reasoning duration after reload", () => {
		render(<ReasoningBlock text="Finished reasoning" streaming={false} durationMs={3_400} />);

		const trigger = screen.getByRole("button", { name: "Thought for 3 seconds" });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
	});
});

describe("streaming assistant text", () => {
	it("reveals only newly streamed prose as lightweight word spans", () => {
		vi.useFakeTimers();
		const frames: FrameRequestCallback[] = [];
		const requestFrame = (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		};
		const cancelFrame = () => {};
		vi.stubGlobal("requestAnimationFrame", requestFrame);
		vi.stubGlobal("cancelAnimationFrame", cancelFrame);
		const view = render(<Markdown text="Fresh words now " state="streaming" />);
		const initialWords = [...view.container.querySelectorAll<HTMLElement>(".t-stream-w")];
		expect(initialWords.map((word) => word.textContent)).toEqual(["Fresh", "words", "now"]);
		expect(initialWords.every((word) => !word.classList.contains("is-in"))).toBe(true);
		expect(view.container.querySelector(".t-stream")).toBeTruthy();

		act(() => {
			frames.splice(0).forEach((callback) => callback(0));
		});
		expect(initialWords[0]!.classList.contains("is-in")).toBe(true);
		expect(initialWords[1]!.classList.contains("is-in")).toBe(false);
		act(() => vi.advanceTimersByTime(60));
		expect(initialWords[1]!.classList.contains("is-in")).toBe(true);

		view.rerender(<Markdown text="Fresh words now arrive here " state="streaming" />);
		const allWords = [...view.container.querySelectorAll<HTMLElement>(".t-stream-w")];
		expect(allWords.map((word) => word.textContent)).toEqual([
			"Fresh",
			"words",
			"now",
			"arrive",
			"here",
		]);
		expect(allWords[0]).toBe(initialWords[0]);
		expect(view.container.textContent).toBe("Fresh words now arrive here");
	});

	it("renders completed markdown without streaming wrappers", () => {
		const view = render(<Markdown text="A settled response." state="done" />);

		expect(view.container.textContent).toBe("A settled response.");
		expect(view.container.querySelector(".t-stream-w")).toBeNull();
	});

	it("reveals every queued word as soon as a streaming response completes", () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		const view = render(
			<Markdown text="One two three four five six seven eight " state="streaming" />,
		);
		const words = [...view.container.querySelectorAll<HTMLElement>(".t-stream-w")];
		expect(words.every((word) => !word.classList.contains("is-in"))).toBe(true);

		view.rerender(<Markdown text="One two three four five six seven eight " state="done" />);

		expect(words.every((word) => word.classList.contains("is-in"))).toBe(true);
	});

	it("coalesces parser chunks into complete words", () => {
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		const view = render(<Markdown text="A split wor" state="streaming" />);

		view.rerender(<Markdown text="A split word " state="streaming" />);

		expect(
			[...view.container.querySelectorAll<HTMLElement>(".t-stream-w")].map(
				(word) => word.textContent,
			),
		).toEqual(["A", "split", "word"]);
		expect(view.container.textContent).toBe("A split word");
	});

	it("reveals complete inline and fenced code in transcript order", () => {
		vi.useFakeTimers();
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		const view = render(
			<Markdown
				text={"Before `inline` after\n\n```ts\nconst answer = 42;\n```\n"}
				state="streaming"
			/>,
		);
		const inlineCode = view.container.querySelector<HTMLElement>("p code");
		const fencedCode = view.container.querySelector<HTMLElement>("pre");
		expect(inlineCode?.classList.contains("t-stream-w")).toBe(true);
		expect(fencedCode?.classList.contains("t-stream-w")).toBe(true);
		expect(inlineCode?.classList.contains("is-in")).toBe(false);
		expect(fencedCode?.classList.contains("is-in")).toBe(false);

		act(() => frames.splice(0).forEach((callback) => callback(0)));
		expect(inlineCode?.classList.contains("is-in")).toBe(false);
		act(() => vi.advanceTimersByTime(60));
		expect(inlineCode?.classList.contains("is-in")).toBe(true);
		expect(fencedCode?.classList.contains("is-in")).toBe(false);
	});
});
