import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

interface ResizeHandleProps {
	direction: "horizontal" | "vertical";
	onResize: (delta: number) => void;
	value: number;
	min: number;
	max: number;
	controls: string;
	label: string;
}

let activeDragOwner: symbol | null = null;

export function ResizeHandle({
	direction,
	onResize,
	value,
	min,
	max,
	controls,
	label,
}: ResizeHandleProps) {
	const pointerId = useRef<number | null>(null);
	const dragOwner = useRef(Symbol("resize-handle"));
	const startPosition = useRef(0);
	const startValue = useRef(value);
	const latestResize = useRef({ value, onResize });
	const restoreStyles = useRef<(() => void) | null>(null);
	const isVerticalSeparator = direction === "horizontal";
	useLayoutEffect(() => {
		latestResize.current = { value, onResize };
	}, [value, onResize]);

	const finishDrag = useCallback(() => {
		if (activeDragOwner === dragOwner.current) activeDragOwner = null;
		pointerId.current = null;
		restoreStyles.current?.();
		restoreStyles.current = null;
	}, []);

	useEffect(() => finishDrag, [finishDrag]);

	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || pointerId.current !== null || activeDragOwner !== null) return;
		event.preventDefault();
		activeDragOwner = dragOwner.current;
		pointerId.current = event.pointerId;
		startPosition.current = isVerticalSeparator ? event.clientX : event.clientY;
		startValue.current = value;
		try {
			event.currentTarget.setPointerCapture?.(event.pointerId);
		} catch {}

		const cursor = document.body.style.cursor;
		const userSelect = document.body.style.userSelect;
		const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe")).map(
			(frame) => [frame, frame.style.pointerEvents] as const,
		);
		document.body.style.cursor = isVerticalSeparator ? "col-resize" : "row-resize";
		document.body.style.userSelect = "none";
		for (const [frame] of frames) frame.style.pointerEvents = "none";
		window.addEventListener("blur", finishDrag);
		const onDocumentPointerMove = (event: PointerEvent) => {
			if (pointerId.current !== event.pointerId) return;
			const position = isVerticalSeparator ? event.clientX : event.clientY;
			const displacement = position - startPosition.current;
			const desiredValue =
				startValue.current + (isVerticalSeparator ? displacement : -displacement);
			const { value: currentValue, onResize: resize } = latestResize.current;
			const delta = isVerticalSeparator ? desiredValue - currentValue : currentValue - desiredValue;
			if (delta) resize(delta);
		};
		const onDocumentPointerEnd = (event: PointerEvent) => {
			if (pointerId.current === event.pointerId) finishDrag();
		};
		document.addEventListener("pointermove", onDocumentPointerMove);
		document.addEventListener("pointerup", onDocumentPointerEnd);
		document.addEventListener("pointercancel", onDocumentPointerEnd);
		restoreStyles.current = () => {
			window.removeEventListener("blur", finishDrag);
			document.removeEventListener("pointermove", onDocumentPointerMove);
			document.removeEventListener("pointerup", onDocumentPointerEnd);
			document.removeEventListener("pointercancel", onDocumentPointerEnd);
			document.body.style.cursor = cursor;
			document.body.style.userSelect = userSelect;
			for (const [frame, pointerEvents] of frames) frame.style.pointerEvents = pointerEvents;
		};
	};

	const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
		if (pointerId.current === event.pointerId) finishDrag();
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? 40 : 16;
		let delta: number;
		switch (event.key) {
			case "ArrowLeft":
				if (!isVerticalSeparator) return;
				delta = -step;
				break;
			case "ArrowRight":
				if (!isVerticalSeparator) return;
				delta = step;
				break;
			case "ArrowUp":
				if (isVerticalSeparator) return;
				delta = -step;
				break;
			case "ArrowDown":
				if (isVerticalSeparator) return;
				delta = step;
				break;
			case "Home":
				delta = isVerticalSeparator ? min - value : value - min;
				break;
			case "End":
				delta = isVerticalSeparator ? max - value : value - max;
				break;
			default:
				return;
		}
		event.preventDefault();
		if (delta) onResize(delta);
	};

	return (
		<div
			role="separator"
			tabIndex={0}
			aria-label={label}
			aria-controls={controls}
			aria-orientation={isVerticalSeparator ? "vertical" : "horizontal"}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={value}
			aria-valuetext={`${value} pixels`}
			onPointerDown={onPointerDown}
			onPointerUp={onPointerEnd}
			onPointerCancel={onPointerEnd}
			onLostPointerCapture={finishDrag}
			onKeyDown={onKeyDown}
			className={`group relative z-10 flex shrink-0 touch-none items-center justify-center focus-visible:outline-2 focus-visible:outline-accent ${isVerticalSeparator ? "-me-2.5 w-2.5 cursor-col-resize" : "h-4 cursor-row-resize"}`}
		>
			<span
				aria-hidden="true"
				className={`${isVerticalSeparator ? "absolute inset-y-0 start-0 w-px" : "h-px w-full"} bg-border-strong group-hover:bg-accent group-focus-visible:bg-accent group-active:bg-accent`}
			/>
		</div>
	);
}
