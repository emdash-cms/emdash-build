import { describe, expect, it } from "vitest";
import { reducePublishState, type PublishState } from "../src/platform/publish-state.js";

describe("publish state", () => {
	it("moves through one observable publish request", () => {
		let state: PublishState = { stage: "authentication-required" };
		for (const event of [
			{ type: "authenticated" },
			{ type: "started" },
			{
				type: "succeeded",
				releaseId: "release-2",
				liveUrl: "https://site.test",
				publishedAt: 2,
			},
		] as const) {
			state = reducePublishState(state, event);
		}
		expect(state).toEqual({
			stage: "live",
			releaseId: "release-2",
			liveUrl: "https://site.test",
			publishedAt: 2,
		});
	});

	it("keeps the previous live URL when a republish fails", () => {
		const state = reducePublishState(
			{
				stage: "publishing",
				releaseId: "release-1",
				liveUrl: "https://site.test",
			},
			{ type: "failed", message: "Health check failed", reference: "12ab34cd" },
		);
		expect(state).toEqual({
			stage: "failed",
			releaseId: "release-1",
			liveUrl: "https://site.test",
			error: "Health check failed",
			reference: "12ab34cd",
		});
	});

	it("tracks real progress only while a publish is running", () => {
		const ready: PublishState = { stage: "ready" };
		expect(
			reducePublishState(ready, { type: "progress", message: "Checking pages and assets…" }),
		).toEqual(ready);

		const publishing = reducePublishState(ready, { type: "started" });
		expect(
			reducePublishState(publishing, {
				type: "progress",
				message: "Checking pages and assets…",
			}),
		).toEqual({
			stage: "publishing",
			progress: "Checking pages and assets…",
		});
	});

	it("does not mistake a stale publication sync for republish success", () => {
		const publishing: PublishState = {
			stage: "publishing",
			releaseId: "release-1",
			liveUrl: "https://site.test",
			publishedAt: 1,
		};
		expect(
			reducePublishState(publishing, {
				type: "synced",
				releaseId: "release-1",
				liveUrl: "https://site.test",
				publishedAt: 1,
			}),
		).toEqual(publishing);
		expect(
			reducePublishState(publishing, {
				type: "synced",
				releaseId: "release-2",
				liveUrl: "https://site.test",
				publishedAt: 2,
			}),
		).toMatchObject({ stage: "live", releaseId: "release-2" });
		const failed = reducePublishState(publishing, {
			type: "failed",
			message: "Health check failed",
			reference: "12ab34cd",
		});
		expect(
			reducePublishState(failed, {
				type: "synced",
				releaseId: "release-1",
				liveUrl: "https://site.test",
				publishedAt: 1,
			}),
		).toEqual(failed);
	});

	it("recognizes a newer publication of the same snapshot", () => {
		const publishing: PublishState = {
			stage: "publishing",
			releaseId: "release-1",
			liveUrl: "https://site.test",
			publishedAt: 1,
		};

		expect(
			reducePublishState(publishing, {
				type: "synced",
				releaseId: "release-1",
				liveUrl: "https://site.test",
				publishedAt: 2,
			}),
		).toMatchObject({ stage: "live", releaseId: "release-1", publishedAt: 2 });
	});

	it("does not overwrite server-confirmed Live after the HTTP response is lost", () => {
		const live: PublishState = {
			stage: "live",
			releaseId: "release-2",
			liveUrl: "https://site.test",
		};
		expect(reducePublishState(live, { type: "failed", message: "Network error" })).toEqual(live);
	});

	it("clears an old failure reference when a retry starts", () => {
		expect(
			reducePublishState(
				{ stage: "failed", error: "Failed", reference: "12ab34cd" },
				{ type: "started" },
			),
		).toEqual({ stage: "publishing", error: undefined, progress: undefined, reference: undefined });
	});
});
