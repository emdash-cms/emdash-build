import type { UIMessageChunk } from "ai";
import { REASONING_DURATION_FIELD, REASONING_METADATA_NAMESPACE } from "../shared/reasoning.js";

/** Persist elapsed reasoning time in the reasoning-end chunk's provider metadata. */
export function withReasoningDurations(
	stream: ReadableStream<UIMessageChunk>,
	now: () => number = Date.now,
): ReadableStream<UIMessageChunk> {
	const startedAt = new Map<string, number>();

	return stream.pipeThrough(
		new TransformStream<UIMessageChunk, UIMessageChunk>({
			transform(chunk, controller) {
				if (chunk.type === "reasoning-start") {
					startedAt.set(chunk.id, now());
					controller.enqueue(chunk);
					return;
				}

				if (chunk.type === "reasoning-end") {
					const start = startedAt.get(chunk.id);
					startedAt.delete(chunk.id);
					if (start !== undefined) {
						controller.enqueue({
							...chunk,
							providerMetadata: {
								...chunk.providerMetadata,
								[REASONING_METADATA_NAMESPACE]: {
									...chunk.providerMetadata?.[REASONING_METADATA_NAMESPACE],
									[REASONING_DURATION_FIELD]: Math.max(0, Math.round(now() - start)),
								},
							},
						});
						return;
					}
				}

				controller.enqueue(chunk);
			},
		}),
	);
}
