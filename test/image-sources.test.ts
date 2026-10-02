import { describe, expect, it } from "vitest";
import { ImageSources, imageSourcesFrom } from "../src/worker/image-sources.js";

describe("image sources", () => {
	it("matches a provided image at any size or crop", () => {
		const sources = new ImageSources(["https://images.unsplash.com/photo-abc?ixid=1&w=1200"]);

		expect(sources.has("https://images.unsplash.com/photo-abc?auto=format&w=2200")).toBe(true);
		expect(sources.has("https://images.unsplash.com/photo-abd?w=1200")).toBe(false);
		expect(sources.has("not a url")).toBe(false);
	});

	it("takes URLs from the user's words and earlier photo searches, never from the builder's", () => {
		const messages = [
			{
				role: "user",
				parts: [{ type: "text", text: "Use https://example.com/hero.jpg, please." }],
			},
			{
				role: "assistant",
				parts: [
					{ type: "text", text: "The hero will use https://images.unsplash.com/photo-guessed." },
					{
						type: "tool-search_unsplash",
						output: {
							success: true,
							photos: [
								{
									url: "https://images.unsplash.com/photo-found?w=1200",
									thumb: "https://images.unsplash.com/photo-found?w=400",
								},
							],
						},
					},
					{
						type: "tool-write_file",
						input: { content: "<img src='https://images.unsplash.com/photo-written'>" },
						output: { success: true },
					},
				],
			},
		];
		const sources = imageSourcesFrom(messages);

		expect(sources.has("https://example.com/hero.jpg")).toBe(true);
		expect(sources.has("https://images.unsplash.com/photo-found?w=2200")).toBe(true);
		expect(sources.has("https://images.unsplash.com/photo-guessed")).toBe(false);
		expect(sources.has("https://images.unsplash.com/photo-written")).toBe(false);
	});
});
