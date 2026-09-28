export type PublishedSlugErrorCode =
	| "SLUG_INVALID"
	| "SLUG_TAKEN"
	| "SLUG_LOCKED"
	| "SLUG_UNAVAILABLE";

export class PublishedSlugError extends Error {
	constructor(
		readonly code: PublishedSlugErrorCode,
		message: string,
	) {
		super(message);
		this.name = "PublishedSlugError";
	}
}

const RESERVED_SLUGS = new Set(["www", "api", "admin", "cdn", "build"]);

export function validPublishedSlug(slug: string): boolean {
	return (
		slug.length >= 3 &&
		slug.length <= 63 &&
		/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(slug) &&
		!slug.startsWith("xn--") &&
		!RESERVED_SLUGS.has(slug)
	);
}

export async function reservePublishedSlug(
	db: D1Database,
	siteId: string,
	slug: string,
): Promise<void> {
	if (!validPublishedSlug(slug)) {
		throw new PublishedSlugError(
			"SLUG_INVALID",
			"Choose a name of 3–63 lowercase letters, numbers, or hyphens.",
		);
	}
	const existing = await db
		.prepare("SELECT slug, active FROM published_site_slugs WHERE site_id = ?")
		.bind(siteId)
		.first<{ slug: string; active: number }>();
	if (existing?.active && existing.slug !== slug) {
		throw new PublishedSlugError("SLUG_LOCKED", "This site's live address cannot be changed.");
	}
	try {
		await db
			.prepare(`INSERT INTO published_site_slugs (slug, site_id) VALUES (?, ?)
				ON CONFLICT(site_id) DO UPDATE SET slug = excluded.slug
				WHERE published_site_slugs.active = 0`)
			.bind(slug, siteId)
			.run();
	} catch (error) {
		const occupant = await db
			.prepare("SELECT site_id FROM published_site_slugs WHERE slug = ?")
			.bind(slug)
			.first<{ site_id: string }>()
			.catch(() => undefined);
		if (occupant && occupant.site_id !== siteId) {
			throw new PublishedSlugError("SLUG_TAKEN", "That address is taken. Choose another name.");
		}
		throw new PublishedSlugError("SLUG_UNAVAILABLE", "Could not reserve this address. Try again.");
	}
	const reserved = await db
		.prepare("SELECT slug FROM published_site_slugs WHERE site_id = ?")
		.bind(siteId)
		.first<{ slug: string }>();
	if (reserved?.slug !== slug) {
		throw new PublishedSlugError("SLUG_LOCKED", "This site's live address cannot be changed.");
	}
}

export async function activePublishedSlugForSite(
	db: D1Database,
	siteId: string,
): Promise<string | undefined> {
	const row = await db
		.prepare("SELECT slug FROM published_site_slugs WHERE site_id = ? AND active = 1")
		.bind(siteId)
		.first<{ slug: string }>();
	return row?.slug;
}

export async function publishedSlugForSite(
	db: D1Database,
	siteId: string,
): Promise<string | undefined> {
	const row = await db
		.prepare("SELECT slug FROM published_site_slugs WHERE site_id = ?")
		.bind(siteId)
		.first<{ slug: string }>();
	return row?.slug;
}

export async function unlockPublishedSlug(
	db: D1Database,
	siteId: string,
	slug: string,
): Promise<void> {
	await db
		.prepare("UPDATE published_site_slugs SET active = 0 WHERE site_id = ? AND slug = ?")
		.bind(siteId, slug)
		.run();
}

export async function activatePublishedSlug(
	db: D1Database,
	siteId: string,
	slug: string,
): Promise<void> {
	const result = await db
		.prepare("UPDATE published_site_slugs SET active = 1 WHERE site_id = ? AND slug = ?")
		.bind(siteId, slug)
		.run();
	if (result.meta.changes !== 1) {
		throw new PublishedSlugError(
			"SLUG_UNAVAILABLE",
			"Could not confirm this address. Retry publishing.",
		);
	}
}

export async function siteForPublishedSlug(
	db: D1Database,
	slug: string,
): Promise<string | undefined> {
	if (!validPublishedSlug(slug)) return undefined;
	const row = await db
		.prepare("SELECT site_id FROM published_site_slugs WHERE slug = ? AND active = 1")
		.bind(slug)
		.first<{ site_id: string }>();
	return row?.site_id;
}

export async function deletePublishedSlug(db: D1Database, siteId: string): Promise<void> {
	const table = await db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'published_site_slugs'",
		)
		.first();
	if (!table) return;
	await db.prepare("DELETE FROM published_site_slugs WHERE site_id = ?").bind(siteId).run();
}
