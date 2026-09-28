import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { HighlightedLine } from "./highlightCode.js";

const MAX_PREVIEW_LENGTH = 1600;

export function CodePreview({
	code,
	path,
	label,
	active,
	change,
}: {
	code: string;
	path: string;
	label: string;
	active: boolean;
	change?: "removed" | "added";
}) {
	const [highlighted, setHighlighted] = useState<{
		key: string;
		lines: HighlightedLine[] | null;
	}>();
	const preview = code.slice(0, MAX_PREVIEW_LENGTH);
	const key = `${path}\0${preview}`;
	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		void import("./highlightCode.js")
			.then(({ highlightCode }) => highlightCode(preview, path))
			.then((lines) => {
				if (!cancelled) setHighlighted({ key, lines });
			})
			.catch(() => {
				if (!cancelled) setHighlighted({ key, lines: null });
			});
		return () => {
			cancelled = true;
		};
	}, [active, key, path, preview]);
	const lines = highlighted?.key === key ? highlighted.lines : null;
	const plainLines = preview.split("\n");
	const count = Math.max(lines?.length ?? 0, plainLines.length);
	return (
		<div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface-sunken text-text-primary">
			<div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
				<span className="shrink-0 font-medium">{label}</span>
				<span className="min-w-0 truncate font-mono text-text-secondary" title={path}>
					{path}
				</span>
			</div>
			<div className="overflow-x-auto py-2 font-mono text-xs leading-5">
				<pre className="w-max min-w-full">
					<code>
						{Array.from({ length: count }, (_, index) => (
							<span
								key={index}
								className={`flex min-w-0 border-s-2 ${change === "removed" ? "border-danger bg-danger-light/40" : change === "added" ? "border-success bg-success/10" : "border-transparent"}`}
							>
								<span
									aria-hidden="true"
									className="sticky start-0 w-10 shrink-0 select-none border-e border-border bg-surface-sunken pe-2 text-end text-text-tertiary tabular-nums"
								>
									{change === "removed" ? "−" : change === "added" ? "+" : index + 1}
								</span>
								<span className="px-3 whitespace-pre">
									{lines?.[index]?.map((token, tokenIndex) => (
										<span
											key={tokenIndex}
											className="activity-code-token"
											style={
												{
													"--code-light": token.light,
													"--code-dark": token.dark,
												} as CSSProperties
											}
										>
											{token.content}
										</span>
									)) ?? plainLines[index]}
								</span>
							</span>
						))}
					</code>
				</pre>
			</div>
			{code.length > MAX_PREVIEW_LENGTH ? (
				<p className="border-t border-border px-3 py-2 text-xs text-text-tertiary">
					{change ? "Showing an excerpt of the replacement" : "Showing the first 1,600 characters"}
				</p>
			) : null}
		</div>
	);
}
