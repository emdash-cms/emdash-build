import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import { PreviewSnapshots, type PreviewRefreshResult } from "./preview-snapshots.js";

export type { PreviewRefreshResult, PreviewSnapshotState } from "./preview-snapshots.js";

/** Sandbox with a durable last-known-good HTML view for public preview routes. */
export class Sandbox extends CloudflareSandbox<Env> {
	private readonly previews: PreviewSnapshots;

	constructor(ctx: DurableObjectState<{}>, env: Env) {
		super(ctx, env);
		this.previews = new PreviewSnapshots({
			sql: this.ctx.storage.sql,
			waitUntil: (promise) => this.ctx.waitUntil(promise),
			forwardLive: (request) => super.fetch(request),
			renderCanonical: (cachePath) =>
				this.containerFetch(
					new Request(new URL(cachePath, "http://localhost:4321"), {
						headers: { Accept: "text/html" },
						redirect: "manual",
					}),
					4321,
				),
			validatePortToken: (port, token) => this.validatePortToken(port, token),
		});
	}

	/** Tear down the container and clear cached preview documents for a deleted site. */
	async deleteProjectData(): Promise<void> {
		await this.destroy();
		await this.ctx.storage.deleteAll();
	}

	getPreviewGeneration(): number {
		return this.previews.getPreviewGeneration();
	}

	/** Mark every snapshot stale at a builder mutation; renders follow separately. */
	async invalidatePreviewSnapshots(): Promise<number> {
		return this.previews.invalidatePreviewSnapshots();
	}

	/** Whether a last-known-good response already exists for this route. */
	hasCachedPreview(path = "/"): boolean {
		return this.previews.hasCachedPreview(path);
	}

	/** Whether this route's snapshot reflects the latest content change (a cheap DO read). */
	previewSnapshotState(path = "/") {
		return this.previews.previewSnapshotState(path);
	}

	/** Render and persist one public route directly from the dev server. */
	refreshPreview(path = "/") {
		return this.previews.refreshPreview(path);
	}

	/** Refresh the routes a user is looking at after a content or source change. */
	refreshPreviews(
		paths: string[],
		options: { invalidate?: boolean } = {},
	): Promise<PreviewRefreshResult[]> {
		return this.previews.refreshPreviews(paths, options);
	}

	override fetch(request: Request): Promise<Response> {
		return this.previews.fetch(request);
	}
}
