/**
 * Image URLs a turn may upload: ones the user wrote and ones a photo search
 * returned. Asked for photos it could not search for, the model wrote
 * Unsplash URLs from memory with alt text for the photo it expected; some
 * showed another subject, others no longer existed.
 */
export class ImageSources {
	private readonly keys = new Set<string>();

	constructor(urls: Iterable<string> = []) {
		for (const url of urls) this.add(url);
	}

	add(url: string): void {
		const key = imageKey(url);
		if (key) this.keys.add(key);
	}

	has(url: string): boolean {
		const key = imageKey(url);
		return key !== undefined && this.keys.has(key);
	}
}

/** The query only sizes or crops the image, so the same photo matches at any size. */
function imageKey(url: string): string | undefined {
	try {
		const { origin, pathname } = new URL(url);
		return `${origin}${pathname}`;
	} catch {
		return undefined;
	}
}

interface MessageLike {
	role: string;
	parts?: readonly { type: string; text?: string; output?: unknown }[];
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/g;

/** Photos returned by `search_unsplash`, as its result lists them. */
export function searchedPhotoUrls(output: unknown): string[] {
	const photos = (output as { photos?: unknown } | null)?.photos;
	if (!Array.isArray(photos)) return [];
	return photos.flatMap((photo) => (typeof photo?.url === "string" ? [photo.url] : []));
}

/** Sources from earlier turns: the user's messages and past photo searches, not the builder's own words. */
export function imageSourcesFrom(messages: readonly MessageLike[]): ImageSources {
	const sources = new ImageSources();
	for (const message of messages) {
		for (const part of message.parts ?? []) {
			if (message.role === "user" && part.type === "text" && typeof part.text === "string") {
				for (const [url] of part.text.matchAll(URL_IN_TEXT)) {
					sources.add(url.replace(/[.,;:!?]+$/, ""));
				}
			} else if (part.type === "tool-search_unsplash") {
				for (const url of searchedPhotoUrls(part.output)) sources.add(url);
			}
		}
	}
	return sources;
}
