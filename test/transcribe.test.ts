import { describe, expect, it, vi } from "vitest";
import { TRANSCRIBE_MODEL, transcribeDictation } from "../src/worker/transcribe.js";

function recording(body: Uint8Array<ArrayBuffer>, type = "audio/webm;codecs=opus") {
	return new Request("http://localhost/api/transcribe", {
		method: "POST",
		headers: { "Content-Type": type },
		body,
	});
}

describe("dictation transcription", () => {
	it("sends the recording to Whisper and returns the trimmed transcript", async () => {
		const run = vi.fn(async () => ({ text: "  Add a contact page. " }));
		const response = await transcribeDictation({ run }, recording(new Uint8Array([1, 2, 3])));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: "Add a contact page." });
		expect(run).toHaveBeenCalledWith(
			TRANSCRIBE_MODEL,
			expect.objectContaining({ audio: "AQID", task: "transcribe" }),
		);
	});

	it("rejects non-audio, empty, and oversized uploads without calling the model", async () => {
		const run = vi.fn();
		const statuses = await Promise.all([
			transcribeDictation({ run }, recording(new Uint8Array([1]), "text/plain")),
			transcribeDictation({ run }, recording(new Uint8Array())),
			transcribeDictation({ run }, recording(new Uint8Array(4 * 1024 * 1024 + 1))),
		]).then((responses) => responses.map((response) => response.status));

		expect(statuses).toEqual([415, 400, 413]);
		expect(run).not.toHaveBeenCalled();
	});

	it("stops reading an oversized upload sent without a Content-Length", async () => {
		const run = vi.fn();
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (++pulls > 64) controller.close();
				else controller.enqueue(new Uint8Array(128 * 1024));
			},
		});
		const request = new Request("http://localhost/api/transcribe", {
			method: "POST",
			headers: { "Content-Type": "audio/webm" },
			body,
			duplex: "half",
		} as RequestInit);

		expect((await transcribeDictation({ run }, request)).status).toBe(413);
		expect(pulls).toBeLessThan(64);
		expect(run).not.toHaveBeenCalled();
	});

	it("does not expose model failure details", async () => {
		const run = vi.fn(async () => {
			throw new Error("upstream account 1234 quota exceeded");
		});
		const response = await transcribeDictation({ run }, recording(new Uint8Array([1])));

		expect(response.status).toBe(502);
		expect(JSON.stringify(await response.json())).not.toContain("1234");
	});
});
