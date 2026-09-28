import { describe, expect, it, vi } from "vitest";
import {
	SUGGESTIONS_MODEL,
	suggestNextSteps,
	suggestionCapabilities,
	suggestionContext,
} from "../src/worker/suggestions.js";

const suggestion = (label: string, prompt = `${label} on the site.`) => ({ label, prompt });
const modelSuggestion = (
	label: string,
	prompt = `${label} on the site.`,
	capabilities = ["edit_site"],
) => ({ label, prompt, capabilities });
const session = {
	toolNames: ["write_file", "apply_schema_plan", "content_create", "byline_create"],
	canSearchUnsplash: false,
};

describe("next-step suggestions", () => {
	it("asks the small model for JSON and keeps up to four clean, distinct suggestions", async () => {
		const run = vi.fn(async () => ({
			response: {
				suggestions: [
					modelSuggestion(
						"  Save enquiries in EmDash  ",
						"Save contact form submissions to an EmDash collection.",
						["edit_site", "cms_schema", "cms_content"],
					),
					modelSuggestion("save enquiries in emdash"),
					modelSuggestion("A label that is far too long to fit neatly inside a pill"),
					{ label: "No prompt" },
					modelSuggestion("Build the archive page"),
					modelSuggestion("Create the author byline", undefined, ["site_bylines"]),
					modelSuggestion("Improve the recipe layout"),
					modelSuggestion("One too many"),
				],
			},
		}));

		const result = await suggestNextSteps({ run }, "Brief: a food blog", session);

		expect(result).toEqual([
			{
				label: "Save enquiries in EmDash",
				prompt: "Save contact form submissions to an EmDash collection.",
			},
			suggestion("Build the archive page"),
			suggestion("Create the author byline"),
			suggestion("Improve the recipe layout"),
		]);
		expect(run).toHaveBeenCalledWith(
			SUGGESTIONS_MODEL,
			expect.objectContaining({
				response_format: expect.objectContaining({ type: "json_schema" }),
				temperature: 0.2,
			}),
		);
	});

	it("accepts the JSON as a string", async () => {
		const run = vi.fn(async () => ({
			response: JSON.stringify({ suggestions: [modelSuggestion("Add a menu page")] }),
		}));
		expect(await suggestNextSteps({ run }, "Brief", session)).toEqual([
			suggestion("Add a menu page"),
		]);
	});

	it("returns nothing when the model fails or answers badly", async () => {
		const failing = vi.fn(async () => {
			throw new Error("model unavailable");
		});
		const garbled = vi.fn(async () => ({ response: "Sure! Here are some ideas" }));
		expect(await suggestNextSteps({ run: failing }, "Brief", session)).toEqual([]);
		expect(await suggestNextSteps({ run: garbled }, "Brief", session)).toEqual([]);
	});

	it("only keeps suggestions backed by capabilities available in this session", async () => {
		let request: any;
		const run = vi.fn(async (_model: unknown, input: any) => {
			request = input;
			return {
				response: {
					suggestions: [
						modelSuggestion("Publish the site", undefined, ["edit_site"]),
						modelSuggestion("Publish these changes", undefined, ["edit_site"]),
						modelSuggestion("Publish redesigned site", undefined, ["edit_site"]),
						modelSuggestion(
							"Publish the updated article",
							"Publish the revised site and the updated article.",
							["cms_content"],
						),
						modelSuggestion("Deploy the latest site updates", undefined, ["edit_site"]),
						modelSuggestion("Set up Stripe checkout", undefined, ["edit_site"]),
						modelSuggestion("Add a project page", undefined, ["edit_site", "cms_content"]),
						modelSuggestion("Add comments", undefined, ["edit_site", "cms_content"]),
						modelSuggestion("Missing capability list", undefined, []),
					],
				},
			};
		});

		expect(await suggestNextSteps({ run }, "Brief", session)).toEqual([
			suggestion("Add a project page"),
		]);
		expect(request.messages[0]?.content).toContain(
			"Publishing the site is not available in this session",
		);
		expect(request.messages[0]?.content).toContain("strongest first");
		expect(
			request.response_format.json_schema.properties.suggestions.items.properties.capabilities,
		).toEqual(
			expect.objectContaining({ items: expect.objectContaining({ enum: expect.any(Array) }) }),
		);
		expect(
			request.response_format.json_schema.properties.suggestions.items.properties.capabilities.items
				.enum,
		).not.toContain("publish_site");
	});

	it("derives capabilities from live tools and configured services", () => {
		const toolNames = [
			"write_files",
			"search_unsplash",
			"upload_media",
			"menu_set_items",
			"deploy_site",
		];
		expect(
			suggestionCapabilities({ toolNames, canSearchUnsplash: false }).map(
				(capability) => capability.id,
			),
		).toEqual(["edit_site", "media_upload", "site_menu", "publish_site"]);
		expect(
			suggestionCapabilities({ toolNames, canSearchUnsplash: true }).map(
				(capability) => capability.id,
			),
		).toEqual(["edit_site", "media_upload", "media_search", "site_menu", "publish_site"]);
	});

	it("rejects unavailable media search even when the model labels it as a code edit", async () => {
		const run = vi.fn(async () => ({
			response: {
				suggestions: [modelSuggestion("Find Unsplash photos", undefined, ["edit_site"])],
			},
		}));

		expect(
			await suggestNextSteps({ run }, "The site needs stronger imagery.", {
				toolNames: ["write_file", "search_unsplash", "upload_media"],
				canSearchUnsplash: false,
			}),
		).toEqual([]);
	});

	it("gives the model the brief and the latest reply as plain text only", () => {
		const messages = [
			{ role: "user", parts: [{ type: "text", text: "A food blog called Salt & Smoke" }] },
			{
				role: "assistant",
				parts: [
					{ type: "tool-write_file", input: { path: "src/pages/index.astro" } },
					{ type: "text", text: "Here are a few questions." },
				],
			},
			{
				role: "user",
				parts: [
					{ type: "file", mediaType: "image/jpeg", url: "data:image/jpeg;base64,AAAA" },
					{ type: "text", text: "Use warm colours" },
				],
			},
		];
		const context = suggestionContext(
			messages,
			"Built the home page, recipe collection, and a contact form.",
		);

		expect(context).toContain("A food blog called Salt & Smoke");
		expect(context).toContain("Use warm colours");
		expect(context).toContain("Built the home page, recipe collection, and a contact form.");
		expect(context).not.toContain("index.astro");
		expect(context).not.toContain("base64");
		expect(context).toContain("has not been published");
		const publishedContext = suggestionContext(messages, "Changed the menu.", true);
		expect(publishedContext).toContain("already published");
		expect(publishedContext).not.toContain("suggest republishing");
	});

	it("keeps the context small however long the conversation is", () => {
		const long = "x".repeat(5_000);
		const messages = Array.from({ length: 40 }, (_, i) => ({
			role: i % 2 ? "assistant" : "user",
			parts: [{ type: "text", text: long }],
		}));
		expect(suggestionContext(messages, long).length).toBeLessThan(8_000);
	});
});
