import { describe, expect, it } from "vitest";
import {
	BUILDER_MODEL_ID,
	BUILDER_PROVIDER_OPTIONS,
	createBuilderModel,
} from "../src/worker/model.js";

const env = {
	AI_GATEWAY_TOKEN: "gateway-token",
	AI_GATEWAY_ACCOUNT_ID: "account",
	AI_GATEWAY_ID: "gateway",
};

function completedResponse() {
	return new Response(
		JSON.stringify({
			id: "resp_1",
			object: "response",
			created_at: 1,
			model: BUILDER_MODEL_ID,
			status: "completed",
			output: [
				{
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "ok", annotations: [] }],
				},
			],
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("builder model configuration", () => {
	it("uses Luna high without stored response references", () => {
		expect(BUILDER_MODEL_ID).toBe("openai/gpt-5.6-luna");
		expect(BUILDER_PROVIDER_OPTIONS).toEqual({
			openai: {
				forceReasoning: true,
				reasoningEffort: "high",
				reasoningSummary: "auto",
				store: false,
			},
		});
	});

	it("reports every model response status and tags gateway requests", async () => {
		const statuses: number[] = [];
		const requests: Request[] = [];
		let attempt = 0;
		const model = createBuilderModel(env, {
			metadata: { session: "session-1", turn: "turn-1", kind: "follow-up" },
			onResponse: (status) => statuses.push(status),
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				attempt += 1;
				// A short Retry-After keeps the SDK's backoff out of the test's time budget.
				const retryAfter = { "retry-after-ms": "1" };
				if (attempt === 1) return new Response("busy", { status: 429, headers: retryAfter });
				if (attempt === 2) {
					return new Response("unavailable", { status: 503, headers: retryAfter });
				}
				return completedResponse();
			},
		});
		const { generateText } = await import("ai");

		const result = await generateText({ model, prompt: "hi", maxRetries: 2 });

		expect(result.text).toBe("ok");
		expect(statuses).toEqual([429, 503, 200]);
		expect(requests).toHaveLength(3);
		expect(requests[0]?.headers.get("cf-aig-gateway-id")).toBe("gateway");
		expect(JSON.parse(requests[0]?.headers.get("cf-aig-metadata") ?? "null")).toEqual({
			session: "session-1",
			turn: "turn-1",
			kind: "follow-up",
		});
	});

	it("does not report a request the caller aborted", async () => {
		const statuses: number[] = [];
		const controller = new AbortController();
		const model = createBuilderModel(env, {
			onResponse: (status) => statuses.push(status),
			fetch: async () => {
				controller.abort();
				throw new DOMException("The operation was aborted.", "AbortError");
			},
		});
		const { generateText } = await import("ai");

		await expect(
			generateText({ model, prompt: "hi", maxRetries: 0, abortSignal: controller.signal }),
		).rejects.toThrow();
		expect(statuses).toEqual([]);
	});

	it("reports a failed request as status 0 and rethrows it", async () => {
		const statuses: number[] = [];
		const model = createBuilderModel(env, {
			onResponse: (status) => statuses.push(status),
			fetch: async () => {
				throw new TypeError("network lost");
			},
		});
		const { generateText } = await import("ai");

		await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow(
			"network lost",
		);
		expect(statuses).toEqual([0]);
	});
});
