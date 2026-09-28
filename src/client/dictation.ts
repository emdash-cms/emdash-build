import { useEffect, useRef, useState } from "react";
import { toasts } from "./toasts.js";
import { fetchWithTransientRetries, isTransientResponse } from "./retry.js";

// Keeps a recording well under the server's upload cap.
const MAX_RECORDING_MS = 120_000;

export type DictationState = "idle" | "recording" | "transcribing";

export function canDictate(): boolean {
	return typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** Record from the microphone and transcribe it via `/api/transcribe`. */
export function useDictation(onTranscript: (text: string) => void) {
	const [state, setState] = useState<DictationState>("idle");
	const recorderRef = useRef<MediaRecorder | null>(null);
	const recordedAudioRef = useRef<Blob | null>(null);
	const transcribingRef = useRef(false);
	const transcriptionControllerRef = useRef<AbortController | null>(null);
	const startingRef = useRef(false);
	const mountedRef = useRef(true);
	const onTranscriptRef = useRef(onTranscript);
	onTranscriptRef.current = onTranscript;

	const transcribe = async (audio: Blob) => {
		if (transcribingRef.current) return;
		transcribingRef.current = true;
		recordedAudioRef.current = audio;
		const controller = new AbortController();
		transcriptionControllerRef.current = controller;
		setState("transcribing");
		try {
			const response = await fetchWithTransientRetries("/api/transcribe", {
				method: "POST",
				headers: { "Content-Type": audio.type },
				body: audio,
				signal: controller.signal,
			});
			const result = (await response.json().catch(() => ({}))) as { text?: string; error?: string };
			if (!response.ok) {
				const retryable = isTransientResponse(response);
				if (!retryable) recordedAudioRef.current = null;
				throw Object.assign(new Error("Could not transcribe the recording."), { retryable });
			}
			recordedAudioRef.current = null;
			if (!mountedRef.current) return;
			toasts.close("dictation-error");
			if (result.text) onTranscriptRef.current(result.text);
			else toasts.add({ title: "No speech was detected." });
		} catch (cause) {
			if (!mountedRef.current) return;
			const retryable = (cause as { retryable?: unknown })?.retryable !== false;
			let actionUsed = false;
			toasts.add({
				id: "dictation-error",
				title: "Could not transcribe the recording",
				description: retryable ? "Your recording is still available to retry." : undefined,
				variant: "error",
				priority: "high",
				...(retryable
					? {
							timeout: 0,
							actions: [
								{
									children: "Retry",
									onClick: () => {
										if (actionUsed) return;
										actionUsed = true;
										const recording = recordedAudioRef.current;
										if (recording) void transcribe(recording);
									},
									variant: "secondary" as const,
									size: "sm" as const,
								},
							],
						}
					: {}),
			});
		} finally {
			if (transcriptionControllerRef.current === controller) {
				transcriptionControllerRef.current = null;
			}
			transcribingRef.current = false;
			if (mountedRef.current) setState("idle");
		}
	};

	const start = async () => {
		if (startingRef.current || recorderRef.current) return;
		recordedAudioRef.current = null;
		toasts.close("dictation-error");
		startingRef.current = true;
		let stream: MediaStream | undefined;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			// The composer can unmount while the permission prompt is open.
			if (!mountedRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			const recorder = new MediaRecorder(stream);
			const chunks: Blob[] = [];
			const limit = window.setTimeout(() => {
				if (recorder.state !== "inactive") recorder.stop();
			}, MAX_RECORDING_MS);
			recorder.ondataavailable = (event) => {
				if (event.data.size) chunks.push(event.data);
			};
			recorder.onstop = () => {
				window.clearTimeout(limit);
				for (const track of recorder.stream.getTracks()) track.stop();
				recorderRef.current = null;
				const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
				if (audio.size) void transcribe(audio);
				else setState("idle");
			};
			recorder.start();
			recorderRef.current = recorder;
			setState("recording");
		} catch {
			for (const track of stream?.getTracks() ?? []) track.stop();
			toasts.add({
				title: stream ? "Recording is not supported here." : "Microphone access is blocked.",
				variant: "error",
			});
		} finally {
			startingRef.current = false;
		}
	};

	const stop = () => {
		if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
	};

	// Release the microphone if the composer unmounts mid-recording.
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			transcriptionControllerRef.current?.abort();
			transcriptionControllerRef.current = null;
			recordedAudioRef.current = null;
			toasts.close("dictation-error");
			const recorder = recorderRef.current;
			if (!recorder) return;
			recorder.onstop = null;
			recorder.stop();
			for (const track of recorder.stream.getTracks()) track.stop();
		};
	}, []);

	return { state, start, stop };
}
