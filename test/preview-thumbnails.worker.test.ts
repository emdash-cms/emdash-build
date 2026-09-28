import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";
import { createTools } from "../src/worker/tools.js";

const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };
const shotId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

async function saveThumbnail(
	agent: DurableObjectStub<BuilderAgent>,
	index: number,
	base64: string,
	mediaType = "image/png",
) {
	await runInDurableObject(agent, (instance) => {
		const save = Reflect.get(instance, "savePreviewThumbnail") as (
			id: string,
			shot: { base64: string; mediaType: string },
		) => void;
		save.call(instance, shotId(index), { base64, mediaType });
	});
}

describe("builder preview thumbnails", () => {
	beforeEach(() => reset());

	it("connects a preview tool result to a durable screenshot without putting bytes in chat", async () => {
		const agent = testEnv.BuilderAgent.getByName("55555555-5555-4555-8555-555555555555");
		const screenshot = "cGljdHVyZQ==";
		const result = await runInDurableObject(agent, async (instance) => {
			const save = Reflect.get(instance, "savePreviewThumbnail") as (
				id: string,
				shot: { base64: string; mediaType: string },
			) => void;
			const callbacks: Parameters<typeof createTools>[1] = {
				reloadPreview: async () => {},
				checkpointSite: async () => {},
				restartDevServer: async () => ({ success: true }),
				offerClone: () => ({ success: true }),
				capturePreview: async () => ({ ok: true, base64: screenshot, mediaType: "image/png" }),
				savePreviewThumbnail: (id, shot) => save.call(instance, id, shot),
			};
			const tools = createTools({} as never, callbacks, { previewImagesEnabled: true });
			const output = await (tools.view_preview.execute as () => Promise<unknown>)();
			const modelOutput = (
				tools.view_preview.toModelOutput as (args: { output: unknown }) => unknown
			)({ output });
			return { output, modelOutput };
		});
		expect(result.output).toEqual({
			success: true,
			shotId: expect.any(String),
			revision: expect.any(Number),
		});
		expect(result.output).not.toHaveProperty("base64");
		expect(result.modelOutput).toMatchObject({
			type: "content",
			value: expect.arrayContaining([
				expect.objectContaining({ type: "file-data", data: screenshot }),
			]),
		});
		expect(await agent.getPreviewThumbnail((result.output as { shotId: string }).shotId)).toEqual({
			base64: screenshot,
			mediaType: "image/png",
		});
	});

	it("keeps a bounded screenshot outside chat history across eviction", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-111111111111");
		for (let index = 0; index < 7; index++)
			await saveThumbnail(agent, index, `cGljdHVyZS0${index}`);
		expect(await agent.getPreviewThumbnail(shotId(0))).toBeNull();
		expect(await agent.getPreviewThumbnail(shotId(6))).toEqual({
			base64: "cGljdHVyZS06",
			mediaType: "image/png",
		});
		await evictDurableObject(agent);
		expect(await agent.getPreviewThumbnail(shotId(6))).toEqual({
			base64: "cGljdHVyZS06",
			mediaType: "image/png",
		});
	});

	it("retains one accepted first-build screenshot alongside six recent follow-up shots", async () => {
		const agent = testEnv.BuilderAgent.getByName("66666666-6666-4666-8666-666666666666");
		await saveThumbnail(agent, 0, "Zmlyc3Q=");
		await runInDurableObject(agent, (instance) => {
			instance.setState({
				siteReady: true,
				complete: true,
				initialGeneration: { id: "opening-brief", status: "ready", previewShotId: shotId(0) },
			});
		});
		for (let index = 1; index <= 9; index++) {
			await saveThumbnail(agent, index, `Zm9sbG93LXVwLQ${index}`);
		}
		await evictDurableObject(agent);
		expect(await agent.getPreviewThumbnail(shotId(0))).toEqual({
			base64: "Zmlyc3Q=",
			mediaType: "image/png",
		});
		expect(await agent.getPreviewThumbnail(shotId(3))).toBeNull();
		await runInDurableObject(agent, (instance) => {
			expect(instance.state.initialGeneration?.previewShotId).toBe(shotId(0));
			const rows = instance.sql<{
				shot_id: string;
			}>`SELECT shot_id FROM builder_preview_thumbnails`;
			expect(rows).toHaveLength(7);
		});
	});

	it("uses the normal six-shot bound when the accepted PNG is too large to store", async () => {
		const agent = testEnv.BuilderAgent.getByName("77777777-7777-4777-8777-777777777777");
		await saveThumbnail(agent, 0, "a".repeat(1_800_001));
		await runInDurableObject(agent, (instance) => {
			instance.setState({
				siteReady: true,
				complete: true,
				initialGeneration: { id: "opening-brief", status: "ready", previewShotId: shotId(0) },
			});
		});
		for (let index = 1; index <= 8; index++) {
			await saveThumbnail(agent, index, `Zm9sbG93LXVwLQ${index}`);
		}
		expect(await agent.getPreviewThumbnail(shotId(0))).toBeNull();
		await runInDurableObject(agent, (instance) => {
			const rows = instance.sql<{
				shot_id: string;
			}>`SELECT shot_id FROM builder_preview_thumbnails`;
			expect(rows).toHaveLength(6);
		});
	});

	it("rejects invalid identifiers, oversized images and unsupported media", async () => {
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-222222222222");
		await saveThumbnail(agent, 1, "a".repeat(1_800_001));
		await saveThumbnail(agent, 2, "cGljdHVyZQ==", "image/svg+xml");
		expect(await agent.getPreviewThumbnail("not-a-shot-id")).toBeNull();
		expect(await agent.getPreviewThumbnail(shotId(1))).toBeNull();
		expect(await agent.getPreviewThumbnail(shotId(2))).toBeNull();
	});

	it("isolates snapshots by project and leaves unauthenticated agent routes closed", async () => {
		const owner = testEnv.BuilderAgent.getByName("33333333-3333-4333-8333-333333333333");
		const other = testEnv.BuilderAgent.getByName("44444444-4444-4444-8444-444444444444");
		await saveThumbnail(owner, 1, "cGljdHVyZQ==");
		expect(await owner.getPreviewThumbnail(shotId(1))).toMatchObject({ base64: "cGljdHVyZQ==" });
		expect(await other.getPreviewThumbnail(shotId(1))).toBeNull();
		const response = await exports.default.fetch(
			new Request("http://localhost/agents/BuilderAgent/33333333-3333-4333-8333-333333333333"),
		);
		expect(response.status).toBe(401);
	});
});
