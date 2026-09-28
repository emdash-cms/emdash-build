import { Popover } from "@cloudflare/kumo";
import { DownloadSimple } from "@phosphor-icons/react/DownloadSimple";
import { useCallback, useEffect, useRef, useState } from "react";

export interface CloneInfo {
	ok: boolean;
	reason?: string;
	cloneUrl?: string;
	repoUrl?: string;
	command?: string;
	expiresAt?: string;
}

/** Local time-of-day for the token expiry, e.g. "3:45 PM". */
function expiryLabel(iso?: string): string | undefined {
	if (!iso) return undefined;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return undefined;
	return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function ExportPanel({
	open,
	onOpenChange,
	fetchCloneInfo,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	fetchCloneInfo: () => Promise<CloneInfo>;
}) {
	return (
		<Popover open={open} onOpenChange={onOpenChange} modal={false}>
			<Popover.Trigger
				render={
					<button type="button" className="secondary-button" aria-label="Export" title="Export" />
				}
			>
				<DownloadSimple size={15} aria-hidden="true" />
				<span className="hidden sm:inline">Export</span>
			</Popover.Trigger>
			<Popover.Content
				side="bottom"
				align="end"
				sideOffset={8}
				positionMethod="fixed"
				className="max-h-[calc(100dvh-5rem)] w-[min(23rem,calc(100vw-1rem))] overflow-y-auto bg-surface-raised p-4"
			>
				<Popover.Title className="sr-only">Export site</Popover.Title>
				<CloneCard
					active={open}
					fetchCloneInfo={fetchCloneInfo}
					onDismiss={() => onOpenChange(false)}
				/>
			</Popover.Content>
		</Popover>
	);
}

export function CloneCard({
	active = true,
	fetchCloneInfo,
	onDismiss,
}: {
	active?: boolean;
	fetchCloneInfo: () => Promise<CloneInfo>;
	onDismiss: () => void;
}) {
	const [info, setInfo] = useState<CloneInfo>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string>();
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const requestId = useRef(0);
	const copyId = useRef(0);
	const copyReset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const load = useCallback(async () => {
		const currentRequest = ++requestId.current;
		setLoading(true);
		setError(undefined);
		setCopied(false);
		setCopyError(false);
		copyId.current++;
		clearTimeout(copyReset.current);
		try {
			const nextInfo = await fetchCloneInfo();
			if (requestId.current === currentRequest) setInfo(nextInfo);
		} catch {
			if (requestId.current === currentRequest) {
				setError("Could not generate a clone link. Try again.");
			}
		} finally {
			if (requestId.current === currentRequest) setLoading(false);
		}
	}, [fetchCloneInfo]);

	useEffect(() => {
		if (active) void load();
		return () => {
			requestId.current++;
			copyId.current++;
			clearTimeout(copyReset.current);
		};
	}, [active, load]);

	const copy = useCallback(() => {
		const command = info?.command;
		if (!command) return;
		const currentCopy = ++copyId.current;
		clearTimeout(copyReset.current);
		setCopied(false);
		setCopyError(false);
		void (async () => {
			try {
				await navigator.clipboard.writeText(command);
				if (copyId.current !== currentCopy) return;
				setCopyError(false);
				setCopied(true);
				clearTimeout(copyReset.current);
				copyReset.current = setTimeout(() => setCopied(false), 2000);
			} catch {
				if (copyId.current === currentCopy) setCopyError(true);
			}
		})();
	}, [info]);

	const expires = expiryLabel(info?.expiresAt);

	return (
		<div className="flex min-w-0 flex-col gap-2">
			<div className="flex items-center justify-between">
				<span className="text-sm font-medium text-text-primary">Clone this site locally</span>
				<button
					type="button"
					onClick={onDismiss}
					className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary hover:bg-surface-sunken hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					aria-label="Dismiss clone details"
				>
					&times;
				</button>
			</div>

			{loading ? (
				<span className="text-xs text-text-tertiary">Generating a clone link...</span>
			) : error ? (
				<div className="flex items-center gap-3">
					<span className="text-xs text-text-secondary">{error}</span>
					<button
						type="button"
						onClick={() => void load()}
						className="text-xs text-text-secondary underline hover:text-text-primary"
					>
						Retry
					</button>
				</div>
			) : info && !info.ok ? (
				<span className="text-xs text-text-secondary">{info.reason}</span>
			) : info?.command ? (
				<>
					<div>
						<pre className="overflow-x-auto rounded-lg bg-surface-sunken px-3 py-2 font-mono text-xs leading-relaxed text-text-secondary">
							{info.command}
						</pre>
						<button type="button" onClick={copy} className="secondary-button mt-2 min-h-8">
							{copied ? "Copied" : "Copy"}
						</button>
						{copyError ? (
							<span role="alert" className="ml-2 text-xs text-danger">
								Could not copy. Select the command and copy it.
							</span>
						) : null}
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<span className="min-w-0 flex-1 text-xs text-text-tertiary">
							Includes your content and media. Needs Node 22+ and pnpm.
							{expires ? ` Link expires around ${expires}.` : ""}
						</span>
						<button
							type="button"
							onClick={() => void load()}
							className="ml-auto shrink-0 rounded px-1 py-1 text-xs text-text-secondary underline hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
						>
							Regenerate
						</button>
					</div>
				</>
			) : null}
		</div>
	);
}
