import { useEffect, useState } from "react";

export interface DeployInfo {
	liveUrl?: string;
	claimUrl?: string;
	/** Epoch ms when the deploy completed. The claim window is 60 minutes. */
	at: number;
}

const CLAIM_WINDOW_MS = 60 * 60 * 1000;

/** Minutes left in the 60-minute claim window, never below zero. */
function minutesLeft(at: number, now: number): number {
	return Math.max(0, Math.ceil((at + CLAIM_WINDOW_MS - now) / 60000));
}

/**
 * Banner shown after a temporary-account deploy: the live URL plus a claim
 * button the user must use within 60 minutes to keep the site.
 */
export function DeployCard({
	deploy,
	onDismiss,
	onClone,
}: {
	deploy: DeployInfo;
	onDismiss: () => void;
	onClone: () => void;
}) {
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 30000);
		return () => clearInterval(t);
	}, []);

	const left = minutesLeft(deploy.at, now);
	const expired = left === 0;

	return (
		<div className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface-raised px-4 py-3">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm font-medium text-text-primary">
					{expired ? "Deploy expired" : "Your site is live on Cloudflare"}
				</span>
				<button
					type="button"
					onClick={onDismiss}
					className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-tertiary hover:bg-surface-sunken hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					aria-label="Dismiss deployment details"
				>
					&times;
				</button>
			</div>

			{deploy.liveUrl ? (
				<a
					href={deploy.liveUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="truncate text-xs text-text-secondary underline decoration-border-strong hover:text-text-primary"
				>
					{deploy.liveUrl}
				</a>
			) : null}

			<div className="flex flex-wrap items-center gap-2.5">
				{deploy.claimUrl && !expired ? (
					<a
						href={deploy.claimUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex min-h-9 shrink-0 items-center rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						Claim on Cloudflare
					</a>
				) : null}
				<span className="min-w-[180px] flex-1 text-xs text-text-tertiary">
					{expired
						? "The claim window has closed. Deploy again to get a fresh link."
						: `Claim within ${left} min to keep it. Media and plugins are disabled in this preview deploy.`}
				</span>
			</div>

			<button
				type="button"
				onClick={onClone}
				className="self-start text-xs text-text-secondary underline decoration-border-strong hover:text-text-primary"
			>
				Or grab the source to run it locally
			</button>
		</div>
	);
}
