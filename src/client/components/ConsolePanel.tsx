import { useRef, useEffect } from "react";

export function ConsolePanel({ lines }: { lines: string[] }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && stickRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [lines.length]);

	return (
		<div
			ref={scrollRef}
			onScroll={() => {
				const element = scrollRef.current;
				if (element) {
					stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
				}
			}}
			className="flex-1 overflow-y-auto bg-[#0d1117] p-3 font-mono text-xs leading-5 text-[#c9d1d9]"
		>
			{lines.length === 0 ? (
				<span className="text-[#484f58]">Waiting for output...</span>
			) : (
				lines.map((line, i) => <Line key={i} text={line} />)
			)}
		</div>
	);
}

// ANSI 256-color and standard color maps
const ANSI_COLORS: Record<number, string> = {
	30: "#484f58",
	31: "#ff7b72",
	32: "#7ee787",
	33: "#d29922",
	34: "#79c0ff",
	35: "#d2a8ff",
	36: "#a5d6ff",
	37: "#c9d1d9",
	39: "#c9d1d9", // default
	90: "#6e7681",
	91: "#ffa198",
	92: "#56d364",
	93: "#e3b341",
	94: "#79c0ff",
	95: "#d2a8ff",
	96: "#a5d6ff",
	97: "#f0f6fc",
};

interface Span {
	text: string;
	color?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
}

/** Parse ANSI escape sequences into styled spans */
function parseAnsi(text: string): Span[] {
	const spans: Span[] = [];
	// Match ESC[ ... m sequences
	const re = /\x1b\[([0-9;]*)m/g;
	let lastIndex = 0;
	let color: string | undefined;
	let bold = false;
	let dim = false;
	let italic = false;
	let underline = false;

	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		// Push text before this escape
		if (match.index > lastIndex) {
			spans.push({ text: text.slice(lastIndex, match.index), color, bold, dim, italic, underline });
		}
		lastIndex = re.lastIndex;

		// Parse SGR codes
		const codes = (match[1] ?? "").split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i] ?? 0;
			if (code === 0) {
				color = undefined;
				bold = false;
				dim = false;
				italic = false;
				underline = false;
			} else if (code === 1) {
				bold = true;
			} else if (code === 2) {
				dim = true;
			} else if (code === 3) {
				italic = true;
			} else if (code === 4) {
				underline = true;
			} else if (code === 22) {
				bold = false;
				dim = false;
			} else if (code === 23) {
				italic = false;
			} else if (code === 24) {
				underline = false;
			} else if (code >= 30 && code <= 37) {
				color = ANSI_COLORS[code];
			} else if (code === 39) {
				color = undefined;
			} else if (code >= 90 && code <= 97) {
				color = ANSI_COLORS[code];
			} else if (code === 38 && (codes[i + 1] ?? 0) === 5) {
				// 256-color: ESC[38;5;{n}m
				color = ansi256(codes[i + 2] ?? 0);
				i += 2;
			}
		}
	}

	// Remaining text
	if (lastIndex < text.length) {
		spans.push({ text: text.slice(lastIndex), color, bold, dim, italic, underline });
	}

	return spans;
}

/** Convert a 256-color index to a hex color */
function ansi256(n: number): string {
	if (n < 8) return ANSI_COLORS[30 + n] ?? "#c9d1d9";
	if (n < 16) return ANSI_COLORS[90 + (n - 8)] ?? "#c9d1d9";
	if (n >= 232) {
		// Grayscale: 232-255 -> 8..238
		const v = 8 + (n - 232) * 10;
		return `rgb(${v},${v},${v})`;
	}
	// 216-color cube: 16-231
	const idx = n - 16;
	const r = Math.floor(idx / 36);
	const g = Math.floor((idx % 36) / 6);
	const b = idx % 6;
	const toVal = (c: number) => (c === 0 ? 0 : 55 + c * 40);
	return `rgb(${toVal(r)},${toVal(g)},${toVal(b)})`;
}

function Line({ text }: { text: string }) {
	// Check for our custom prefixes first
	const isCommand = text.startsWith("$ ");
	const isError = text.startsWith("ERROR:");
	const isUrl = text.startsWith("Preview URL:");

	// If line has ANSI escapes, parse them
	if (text.includes("\x1b[")) {
		const spans = parseAnsi(text);
		return (
			<div className="whitespace-pre-wrap break-all">
				{spans.map((span, i) => (
					<span
						key={i}
						style={{
							color: span.color,
							fontWeight: span.bold ? 700 : undefined,
							opacity: span.dim ? 0.6 : undefined,
							fontStyle: span.italic ? "italic" : undefined,
							textDecoration: span.underline ? "underline" : undefined,
						}}
					>
						{span.text}
					</span>
				))}
			</div>
		);
	}

	let className = "";
	if (isCommand) className = "text-[#79c0ff]";
	else if (isError) className = "text-[#ff7b72]";
	else if (isUrl) className = "text-[#7ee787]";

	return <div className={`whitespace-pre-wrap break-all ${className}`}>{text}</div>;
}
