import { Collapsible } from "@cloudflare/kumo";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityCollapsiblePanel } from "./ActivityCollapsiblePanel.js";
import { Markdown } from "./Markdown.js";
import { ShimmerText } from "./ShimmerText.js";

function ReasoningStream({ text }: { text: string }) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		const scroll = scrollRef.current;
		if (!viewport || !scroll) return;

		const followLatest = () => {
			const offset = Math.max(0, scroll.scrollHeight - viewport.clientHeight);
			scroll.style.transition = "transform var(--reason-step) var(--reason-ease)";
			scroll.style.transform = `translateY(-${offset}px)`;
		};

		followLatest();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(followLatest);
		observer.observe(viewport);
		observer.observe(scroll);
		return () => observer.disconnect();
	}, [text]);

	return (
		<div className="reasoning-stream">
			<div ref={viewportRef} className="reasoning-stream-viewport">
				<div ref={scrollRef} className="reasoning-stream-scroll">
					<Markdown text={text} state="streaming" />
				</div>
			</div>
		</div>
	);
}

/** A compact VibeSDK-style reasoning surface that opens while reasoning is live. */
export function ReasoningBlock({
	text,
	streaming,
	durationMs,
}: {
	text: string;
	streaming: boolean;
	durationMs?: number;
}) {
	const [expanded, setExpanded] = useState(streaming);
	const startRef = useRef<number | null>(null);
	const wasStreamingRef = useRef(streaming);
	const [seconds, setSeconds] = useState<number | null>(null);

	useEffect(() => {
		const wasStreaming = wasStreamingRef.current;
		if (streaming) {
			if (startRef.current === null) startRef.current = Date.now();
			if (!wasStreaming) {
				setExpanded(true);
			}
		} else if (wasStreaming) {
			setExpanded(false);
			if (durationMs === undefined && startRef.current !== null && seconds === null) {
				setSeconds(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)));
			}
		}
		wasStreamingRef.current = streaming;
	}, [streaming, seconds]);

	if (!text.trim()) return null;
	const displayedSeconds =
		durationMs !== undefined ? Math.max(1, Math.round(durationMs / 1000)) : seconds;
	const doneLabel = displayedSeconds
		? `Thought for ${displayedSeconds} second${displayedSeconds === 1 ? "" : "s"}`
		: "Thought";

	return (
		<Collapsible.Root
			open={expanded}
			onOpenChange={setExpanded}
			className={`my-1 min-w-0 rounded-xl border px-4 py-1.5 transition-[background-color,border-color] duration-200 motion-reduce:transition-none ${expanded ? "border-border bg-surface-raised" : "border-transparent bg-transparent"}`}
			data-reasoning-state={streaming ? "active" : "complete"}
		>
			<Collapsible.Trigger className="group/reasoning flex min-h-7 w-full items-center gap-1.5 rounded-sm py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
				<span className="min-w-0 truncate text-[13px] leading-snug text-text-tertiary">
					{streaming ? <ShimmerText>{"Thinking"}</ShimmerText> : doneLabel}
				</span>
				<CaretRight
					size={12}
					className={`shrink-0 text-text-tertiary opacity-60 transition-[opacity,transform] duration-150 group-hover/reasoning:opacity-100 motion-reduce:transition-none ${expanded ? "rotate-90 opacity-100" : ""}`}
					aria-hidden="true"
				/>
			</Collapsible.Trigger>
			<ActivityCollapsiblePanel keepMounted>
				<div className="mt-2 mb-1 max-h-96 overflow-y-auto text-[13px] leading-relaxed text-text-secondary">
					{streaming ? <ReasoningStream text={text} /> : <Markdown text={text} />}
				</div>
			</ActivityCollapsiblePanel>
		</Collapsible.Root>
	);
}
