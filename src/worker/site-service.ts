import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

export const SITE_FIXTURE_MEDIA_MAX_BYTES = 64 * 1024;
const SITE_FIXTURE_CONTENT_TYPE = "image/svg+xml; charset=utf-8";
const SITE_FIXTURE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const uuidSchema = z.string().uuid();
const fixtureSchema = z
	.object({
		version: z.literal(1),
		siteId: uuidSchema,
		title: z.literal("EmDash production fixture"),
		body: z.literal("Persistent Site content served through a request-scoped capability."),
		mediaPath: z.literal("/fixture-media"),
	})
	.strict();

export interface SiteFixtureContent {
	readonly version: 1;
	readonly siteId: string;
	readonly title: string;
	readonly body: string;
	readonly mediaPath: "/fixture-media";
}

export type SiteFixtureInitialization =
	| { readonly ok: true }
	| { readonly ok: false; readonly code: "INVALID_SITE_ID" | "SITE_ID_MISMATCH" };

interface SiteServiceEnv {
	SITE_MEDIA: R2Bucket;
	SiteService: DurableObjectNamespace<SiteService>;
}

interface FixtureRow extends Record<string, SqlStorageValue> {
	site_id: string;
	content_json: string;
	media_key: string;
}

export class SiteServiceError extends Error {
	constructor(readonly code: "INVALID_SITE_ID" | "SITE_ID_MISMATCH" | "SITE_STATE_INVALID") {
		super(`${code}: Site fixture request failed.`);
		this.name = "SiteServiceError";
	}
}

export function canonicalSiteId(siteId: string): string {
	const parsed = uuidSchema.safeParse(siteId);
	if (!parsed.success) throw new SiteServiceError("INVALID_SITE_ID");
	return parsed.data.toLowerCase();
}

export function siteFixtureMediaKey(siteId: string): string {
	return `site-fixtures/${canonicalSiteId(siteId).replaceAll("-", "")}/hero.svg`;
}

export class SiteService extends DurableObject<SiteServiceEnv> {
	#tail: Promise<void> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: SiteServiceEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS site_fixture (
					slot INTEGER PRIMARY KEY CHECK (slot = 1),
					site_id TEXT NOT NULL UNIQUE,
					content_json TEXT NOT NULL,
					media_key TEXT NOT NULL UNIQUE,
					created_at TEXT NOT NULL
				)
			`);
		});
	}

	async initializeFixture(siteIdInput: string): Promise<SiteFixtureInitialization> {
		let siteId: string;
		try {
			siteId = canonicalSiteId(siteIdInput);
		} catch {
			return { ok: false, code: "INVALID_SITE_ID" };
		}
		if (!this.ctx.id.equals(this.env.SiteService.idFromName(siteId))) {
			return { ok: false, code: "SITE_ID_MISMATCH" };
		}
		return this.#serial(async () => {
			const existing = this.#row();
			if (existing) {
				return existing.site_id === siteId ? { ok: true } : { ok: false, code: "SITE_ID_MISMATCH" };
			}

			const content = fixtureContent(siteId);
			const mediaKey = siteFixtureMediaKey(siteId);
			await this.env.SITE_MEDIA.put(mediaKey, fixtureSvg(siteId), {
				httpMetadata: {
					contentType: SITE_FIXTURE_CONTENT_TYPE,
					cacheControl: SITE_FIXTURE_CACHE_CONTROL,
				},
				customMetadata: { siteId },
			});
			this.ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO site_fixture
				 (slot, site_id, content_json, media_key, created_at)
				 VALUES (1, ?, ?, ?, ?)`,
				siteId,
				JSON.stringify(content),
				mediaKey,
				new Date().toISOString(),
			);
			return this.#row()?.site_id === siteId
				? { ok: true }
				: { ok: false, code: "SITE_ID_MISMATCH" };
		});
	}

	async readFixtureContent(): Promise<SiteFixtureContent | null> {
		const row = this.#row();
		if (!row) return null;
		const content = fixtureSchema.safeParse(parseJson(row.content_json));
		if (!content.success || content.data.siteId !== row.site_id) {
			throw new SiteServiceError("SITE_STATE_INVALID");
		}
		return content.data;
	}

	async readFixtureMedia(): Promise<Response> {
		const row = this.#row();
		if (!row) return mediaError(404);
		if (row.media_key !== siteFixtureMediaKey(row.site_id)) return mediaError(502);
		const object = await this.env.SITE_MEDIA.get(row.media_key);
		if (!object) return mediaError(404);
		if (
			object.size > SITE_FIXTURE_MEDIA_MAX_BYTES ||
			object.customMetadata?.siteId !== row.site_id ||
			object.httpMetadata?.contentType !== SITE_FIXTURE_CONTENT_TYPE ||
			object.httpMetadata.cacheControl !== SITE_FIXTURE_CACHE_CONTROL
		) {
			await object.body.cancel();
			return mediaError(502);
		}
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set("etag", object.httpEtag);
		return new Response(object.body, { headers });
	}

	#row(): FixtureRow | undefined {
		const row = this.ctx.storage.sql
			.exec<FixtureRow>("SELECT site_id, content_json, media_key FROM site_fixture WHERE slot = 1")
			.toArray()[0];
		if (!row) return undefined;
		try {
			if (!this.ctx.id.equals(this.env.SiteService.idFromName(canonicalSiteId(row.site_id)))) {
				throw new SiteServiceError("SITE_STATE_INVALID");
			}
		} catch {
			throw new SiteServiceError("SITE_STATE_INVALID");
		}
		return row;
	}

	#serial<T>(action: () => Promise<T>): Promise<T> {
		const current = this.#tail.then(action);
		this.#tail = current.then(
			() => undefined,
			() => undefined,
		);
		return current;
	}
}

export class SiteReadCapability extends WorkerEntrypoint<SiteServiceEnv, { siteId: string }> {
	async readFixtureContent(): Promise<SiteFixtureContent | null> {
		return this.#site().readFixtureContent();
	}

	async readFixtureMedia(): Promise<Response> {
		return this.#site().readFixtureMedia();
	}

	#site(): DurableObjectStub<SiteService> {
		const siteId = canonicalSiteId(this.ctx.props.siteId);
		return this.env.SiteService.getByName(siteId);
	}
}

function fixtureContent(siteId: string): SiteFixtureContent {
	return {
		version: 1,
		siteId,
		title: "EmDash production fixture",
		body: "Persistent Site content served through a request-scoped capability.",
		mediaPath: "/fixture-media",
	};
}

function fixtureSvg(siteId: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="EmDash Site fixture ${siteId}"><rect width="640" height="360" fill="#f48120"/><text x="32" y="190" fill="white" font-family="sans-serif" font-size="24">${siteId}</text></svg>`;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function mediaError(status: 404 | 502): Response {
	return new Response(status === 404 ? "Fixture media not found." : "Fixture media unavailable.", {
		status,
		headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
	});
}
