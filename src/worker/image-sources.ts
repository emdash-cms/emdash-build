/**
 * Domains whose image URLs the model writes without having seen the image:
 * stock catalogues it remembers, random-photo and random-face services, and
 * placeholder generators. Asked for photos it could not search for, it wrote
 * Unsplash URLs from memory with alt text for the photo it expected; some
 * showed another subject, others no longer existed. Images anywhere else are
 * the user's own, wherever they live, and are not checked.
 */
const GUESSED_IMAGE_DOMAINS = [
	"unsplash.com",
	"pexels.com",
	"pixabay.com",
	"picsum.photos",
	"loremflickr.com",
	"pravatar.cc",
	"randomuser.me",
	"placehold.co",
	"placeholder.com",
	"dummyimage.com",
];

/** Photos on those hosts a turn may upload: ones a photo search returned or the user wrote. */
export class ImageSources {
	private readonly searched = new Set<string>();
	private readonly userTexts: string[];

	constructor(userTexts: readonly string[] = []) {
		this.userTexts = userTexts.map((text) => text.toLowerCase());
	}

	recordSearchResult(url: string): void {
		const photo = stockPhoto(url);
		if (photo) this.searched.add(photo);
	}

	allows(url: string): boolean {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return false;
		}
		const photo = stockPhoto(parsed);
		if (!photo) return true;
		return this.searched.has(photo) || this.userTexts.some((text) => text.includes(photo));
	}
}

/** The host and path of a photo on those hosts; the query only sizes or crops it. */
function stockPhoto(url: string | URL): string | undefined {
	try {
		const { hostname, pathname } = typeof url === "string" ? new URL(url) : url;
		// `images.unsplash.com.` names the same host.
		const host = hostname.replace(/\.$/, "");
		const guessed = GUESSED_IMAGE_DOMAINS.some(
			(domain) => host === domain || host.endsWith(`.${domain}`),
		);
		return guessed ? `${host}${pathname}`.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

interface MessageLike {
	role: string;
	parts?: readonly { type: string; text?: string; output?: unknown }[];
}

/** Photos returned by `search_unsplash`, as its result lists them. */
export function searchedPhotoUrls(output: unknown): string[] {
	const photos = (output as { photos?: unknown } | null)?.photos;
	if (!Array.isArray(photos)) return [];
	return photos.flatMap((photo) => (typeof photo?.url === "string" ? [photo.url] : []));
}

/** Sources from earlier turns: the user's messages and past photo searches, not the builder's own words. */
export function imageSourcesFrom(messages: readonly MessageLike[]): ImageSources {
	const userTexts: string[] = [];
	const searched: string[] = [];
	for (const message of messages) {
		for (const part of message.parts ?? []) {
			if (message.role === "user" && part.type === "text" && typeof part.text === "string") {
				userTexts.push(part.text);
			} else if (part.type === "tool-search_unsplash") {
				searched.push(...searchedPhotoUrls(part.output));
			}
		}
	}
	const sources = new ImageSources(userTexts);
	for (const url of searched) sources.recordSearchResult(url);
	return sources;
}
