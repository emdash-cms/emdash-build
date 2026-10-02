import { describe, expect, it } from "vitest";
import { ImageSources, imageSourcesFrom } from "../src/worker/image-sources.js";

describe("image sources", () => {
	it("allows a searched stock photo at any size or crop", () => {
		const sources = new ImageSources();
		sources.recordSearchResult("https://images.unsplash.com/photo-abc?ixid=1&w=1200");

		expect(sources.allows("https://images.unsplash.com/photo-abc?auto=format&w=2200")).toBe(true);
		expect(sources.allows("https://images.unsplash.com/photo-abd?w=1200")).toBe(false);
		expect(sources.allows("not a url")).toBe(false);
	});

	it("checks only stock photo hosts, whose catalogues the model remembers", () => {
		const sources = new ImageSources();

		expect(sources.allows("https://images.pexels.com/photos/1/pexels-photo-1.jpeg")).toBe(false);
		// The user's own images: a site they named, a share link the model rewrote.
		expect(sources.allows("https://mybakery.com/wp-content/uploads/hero.jpg")).toBe(true);
		expect(sources.allows("https://drive.google.com/uc?export=download&id=abc")).toBe(true);
		expect(sources.allows("https://upload.wikimedia.org/wikipedia/commons/a/ab/A_(b).jpg")).toBe(
			true,
		);
	});

	it("takes stock photos from the user's words and earlier searches, never from the builder's", () => {
		const messages = [
			{
				role: "user",
				parts: [
					{
						type: "text",
						text: "Use **https://images.unsplash.com/photo-given?w=800** for the hero.",
					},
				],
			},
			{
				role: "assistant",
				parts: [
					{ type: "text", text: "The hero will use https://images.unsplash.com/photo-guessed." },
					{
						type: "tool-search_unsplash",
						output: {
							success: true,
							photos: [{ url: "https://images.unsplash.com/photo-found?w=1200" }],
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

		expect(sources.allows("https://images.unsplash.com/photo-given?w=2000")).toBe(true);
		expect(sources.allows("https://images.unsplash.com/photo-found?w=2200")).toBe(true);
		expect(sources.allows("https://images.unsplash.com/photo-guessed")).toBe(false);
		expect(sources.allows("https://images.unsplash.com/photo-written")).toBe(false);
	});
});
