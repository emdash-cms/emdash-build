import { useRef, useEffect } from "react";
import {
	CODE_BLOCK,
	CODE_FENCE,
	CODE_INLINE,
	parser,
	parser_write,
	parser_end,
	default_renderer,
} from "streaming-markdown";

type StreamingRenderer = ReturnType<typeof default_renderer> & {
	finish: () => void;
	dispose: () => void;
};

const STREAM_GAP_MS = 60;

function createStreamingRenderer(root: HTMLElement): StreamingRenderer {
	const renderer = default_renderer(root) as StreamingRenderer;
	const addText = renderer.add_text;
	const addToken = renderer.add_token;
	const endToken = renderer.end_token;
	const configuredGap = Number.parseFloat(
		window.getComputedStyle(root).getPropertyValue("--stream-gap"),
	);
	const streamGap = Number.isFinite(configuredGap) ? configuredGap : STREAM_GAP_MS;
	let frame: number | null = null;
	let timer: number | null = null;
	let pending: HTMLElement[] = [];
	let openWord: { parent: HTMLElement; element: HTMLSpanElement } | null = null;
	const codeTargets = new Map<HTMLElement, HTMLElement>();

	const revealNext = () => {
		const word = pending.shift();
		if (word?.isConnected) word.classList.add("is-in");
		if (pending.length > 0) {
			timer = window.setTimeout(() => {
				timer = null;
				revealNext();
			}, streamGap);
		}
	};

	const scheduleReveal = () => {
		if (pending.length === 0 || frame !== null || timer !== null) return;
		frame = window.requestAnimationFrame(() => {
			frame = null;
			revealNext();
		});
	};

	const finishWord = () => {
		if (!openWord) return;
		pending.push(openWord.element);
		openWord = null;
		scheduleReveal();
	};

	const finish = () => {
		finishWord();
		for (const target of codeTargets.values()) pending.push(target);
		codeTargets.clear();
		if (frame !== null) window.cancelAnimationFrame(frame);
		if (timer !== null) window.clearTimeout(timer);
		for (const target of pending) {
			if (target.isConnected) target.classList.add("is-in");
		}
		pending = [];
		frame = null;
		timer = null;
	};

	renderer.finish = finish;
	renderer.dispose = () => {
		if (frame !== null) window.cancelAnimationFrame(frame);
		if (timer !== null) window.clearTimeout(timer);
		pending = [];
		openWord = null;
		codeTargets.clear();
		frame = null;
		timer = null;
	};
	renderer.add_token = (data, type) => {
		const isCode = type === CODE_INLINE || type === CODE_BLOCK || type === CODE_FENCE;
		if (isCode) finishWord();
		addToken(data, type);
		if (!isCode) return;

		const code = data.nodes[data.index];
		const target = type === CODE_INLINE ? code : code?.parentElement;
		if (!code || !target) return;
		target.classList.add("t-stream-w");
		codeTargets.set(code, target);
	};
	renderer.end_token = (data) => {
		const current = data.nodes[data.index];
		const codeTarget = current ? codeTargets.get(current) : undefined;
		if (current && codeTarget) {
			codeTargets.delete(current);
			pending.push(codeTarget);
			scheduleReveal();
		}
		endToken(data);
	};
	renderer.add_text = (data, text) => {
		const parent = data.nodes[data.index];
		if (!parent) {
			addText(data, text);
			return;
		}
		if (openWord && openWord.parent !== parent) finishWord();
		if (parent.closest("pre, code")) {
			finishWord();
			addText(data, text);
			return;
		}

		for (const segment of text.split(/(\s+)/u)) {
			if (!segment) continue;
			if (/^\s+$/u.test(segment)) {
				finishWord();
				parent.appendChild(document.createTextNode(segment));
				continue;
			}

			if (!openWord) {
				const word = document.createElement("span");
				word.className = "t-stream-w";
				parent.appendChild(word);
				openWord = { parent, element: word };
			}
			openWord.element.append(segment);
		}
	};

	return renderer;
}

/**
 * Strip model reasoning that leaks into the visible text as `<think>…</think>`
 * (Kimi does this intermittently), including orphan tags. Reasoning is shown
 * separately in its own block, so it should never appear in the answer body.
 */
function stripThink(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, "") // complete blocks
		.replace(/^[\s\S]*?<\/think>/i, "") // leaked reasoning before an orphan close
		.replace(/<think>[\s\S]*$/i, "") // orphan open through the end
		.trimStart();
}

/**
 * Renders markdown text using streaming-markdown.
 * Handles both streaming (state="streaming") and complete text.
 */
export function Markdown({ text, state }: { text: string; state?: string }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const parserRef = useRef<ReturnType<typeof parser> | null>(null);
	const rendererRef = useRef<StreamingRenderer | null>(null);
	// The cleaned text already written to the parser, so we can stream deltas.
	const renderedRef = useRef("");

	// Reset parser when the container mounts.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		el.innerHTML = "";
		const streamingRenderer = state === "streaming" ? createStreamingRenderer(el) : null;
		const renderer = streamingRenderer ?? default_renderer(el);
		rendererRef.current = streamingRenderer;
		parserRef.current = parser(renderer);
		renderedRef.current = "";

		return () => {
			rendererRef.current?.dispose();
			rendererRef.current = null;
			parserRef.current = null;
		};
	}, []);

	// Feed new text to the parser. Normally the cleaned text only grows, so we
	// write the delta; but stripping a `<think>` block can shrink it (the leaked
	// reasoning disappears once `</think>` arrives), so re-parse from scratch
	// whenever the new text isn't a continuation of what we've rendered.
	useEffect(() => {
		const el = containerRef.current;
		let p = parserRef.current;
		if (!el || !p) return;

		const clean = stripThink(text);
		if (clean.startsWith(renderedRef.current)) {
			const delta = clean.slice(renderedRef.current.length);
			if (delta) {
				parser_write(p, delta);
			}
		} else {
			rendererRef.current?.dispose();
			el.innerHTML = "";
			const streamingRenderer = state === "streaming" ? createStreamingRenderer(el) : null;
			const renderer = streamingRenderer ?? default_renderer(el);
			rendererRef.current = streamingRenderer;
			p = parser(renderer);
			parserRef.current = p;
			if (clean) {
				parser_write(p, clean);
			}
		}
		renderedRef.current = clean;

		if (state === "done" || !state) {
			parser_end(p);
			rendererRef.current?.finish();
		}
	}, [text, state]);

	return (
		<div ref={containerRef} className={`smd-content ${state === "streaming" ? "t-stream" : ""}`} />
	);
}
