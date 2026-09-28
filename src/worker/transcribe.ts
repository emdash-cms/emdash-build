export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";
// The client stops recording after two minutes, well under this cap.
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

interface WhisperRunner {
	run(
		model: typeof TRANSCRIBE_MODEL,
		input: { audio: string; task: "transcribe"; vad_filter: boolean },
	): Promise<{ text?: string }>;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

/** Read the body, stopping once it passes the cap (Content-Length is optional). */
async function readAudio(request: Request): Promise<Uint8Array | undefined> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = request.body?.getReader();
	while (reader) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_AUDIO_BYTES) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const audio = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		audio.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return audio;
}

/** Transcribe a short composer dictation clip with Workers AI Whisper. */
export async function transcribeDictation(ai: WhisperRunner, request: Request): Promise<Response> {
	if (!request.headers.get("Content-Type")?.startsWith("audio/")) {
		return Response.json({ error: "Expected an audio recording." }, { status: 415 });
	}
	if (Number(request.headers.get("Content-Length") ?? 0) > MAX_AUDIO_BYTES) {
		return Response.json({ error: "Recording is too long." }, { status: 413 });
	}
	const audio = await readAudio(request);
	if (!audio) {
		return Response.json({ error: "Recording is too long." }, { status: 413 });
	}
	if (!audio.byteLength) {
		return Response.json({ error: "Recording is empty." }, { status: 400 });
	}
	try {
		const result = await ai.run(TRANSCRIBE_MODEL, {
			audio: toBase64(audio),
			task: "transcribe",
			vad_filter: true,
		});
		return Response.json({ text: result.text?.trim() ?? "" });
	} catch (error) {
		console.error("Dictation transcription failed", error);
		return Response.json({ error: "Could not transcribe the recording." }, { status: 502 });
	}
}
