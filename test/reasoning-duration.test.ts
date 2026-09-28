import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import { withReasoningDurations } from "../src/worker/reasoning-duration.js";

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
	const chunks: UIMessageChunk[] = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

describe("reasoning duration stream", () => {
	it("adds elapsed time to reasoning-end metadata without replacing provider data", async () => {
		const times = [1_000, 4_400];
		const source = new ReadableStream<UIMessageChunk>({
			start(controller) {
				controller.enqueue({ type: "reasoning-start", id: "reasoning-1" });
				controller.enqueue({
					type: "reasoning-end",
					id: "reasoning-1",
					providerMetadata: { workersAI: { traceId: "trace-1" } },
				});
				controller.close();
			},
		});

		const chunks = await collect(withReasoningDurations(source, () => times.shift()!));

		expect(chunks[1]).toEqual({
			type: "reasoning-end",
			id: "reasoning-1",
			providerMetadata: {
				workersAI: { traceId: "trace-1" },
				emdash: { reasoningDurationMs: 3_400 },
			},
		});
	});

	it("leaves an unmatched reasoning-end chunk unchanged", async () => {
		const end = { type: "reasoning-end", id: "reasoning-1" } as const;
		const source = new ReadableStream<UIMessageChunk>({
			start(controller) {
				controller.enqueue(end);
				controller.close();
			},
		});

		expect(await collect(withReasoningDurations(source))).toEqual([end]);
	});
});
