import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountStatus } from "../account-state.js";

interface ClaimResponse {
	status: "complete" | "waiting" | "blocked";
	message?: string;
	returnPath: string;
}

export function AuthComplete({
	initial,
	onComplete,
	onSignOut,
	errorMessage,
}: {
	initial: AccountStatus;
	onComplete: (returnPath: string) => Promise<void>;
	onSignOut: () => void;
	errorMessage?: string;
}) {
	const [busy, setBusy] = useState(false);
	const [blockedMessage, setBlockedMessage] = useState<string>();
	const [waitingMessage, setWaitingMessage] = useState<string>();
	const [retryCount, setRetryCount] = useState(0);
	const [sessionExpired, setSessionExpired] = useState(false);
	const [error, setError] = useState<string>();
	const started = useRef(false);
	const headingRef = useRef<HTMLHeadingElement>(null);

	const runClaim = useCallback(async () => {
		setBusy(true);
		setBlockedMessage(undefined);
		setSessionExpired(false);
		setError(undefined);
		try {
			const response = await fetch("/api/auth/claim", { method: "POST" });
			if (response.status === 401) {
				setSessionExpired(true);
				throw new Error("Your sign in has expired. Sign out and try again.");
			}
			if (!response.ok) throw new Error("Your projects could not be connected right now.");
			const result = (await response.json()) as ClaimResponse;
			if (result.status === "complete") {
				await onComplete(result.returnPath);
				return;
			}
			if (result.status === "waiting") {
				setWaitingMessage(result.message ?? "Waiting for your site to finish building…");
				setRetryCount((count) => count + 1);
				setBusy(false);
				return;
			}
			setWaitingMessage(undefined);
			setBlockedMessage(result.message ?? "Your projects could not be connected. Please retry.");
		} catch (claimError) {
			setWaitingMessage(undefined);
			setError(
				claimError instanceof Error ? claimError.message : "Your projects could not be connected.",
			);
			headingRef.current?.focus();
		}
		setBusy(false);
	}, [onComplete]);

	useEffect(() => {
		if (!waitingMessage) return;
		const timeout = window.setTimeout(() => void runClaim(), 3_000);
		return () => window.clearTimeout(timeout);
	}, [waitingMessage, retryCount, runClaim]);

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		if (initial.claimStatus === "complete") {
			setBusy(true);
			void onComplete(initial.returnPath ?? "/").catch((completionError: unknown) => {
				setError(
					completionError instanceof Error
						? completionError.message
						: "Your projects could not be loaded right now.",
				);
				headingRef.current?.focus();
				setBusy(false);
			});
			return;
		}
		void runClaim();
	}, [initial.claimStatus, initial.returnPath, onComplete, runClaim]);

	useEffect(() => {
		if (errorMessage) headingRef.current?.focus();
	}, [errorMessage]);

	return (
		<main className="flex h-full items-center justify-center bg-surface px-6 text-text-primary">
			<section className="w-full max-w-md rounded-xl border border-border bg-surface-raised p-6 shadow-xl">
				<h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold">
					{waitingMessage
						? "Connecting after the build"
						: blockedMessage
							? "Projects need attention"
							: "Connecting your projects"}
				</h1>
				<div className="mt-2 text-sm leading-relaxed text-text-secondary" aria-live="polite">
					{error ??
						errorMessage ??
						waitingMessage ??
						blockedMessage ??
						(busy ? "Finishing access to your projects…" : "Ready to retry.")}
				</div>
				<div className="mt-5 flex flex-wrap gap-2">
					{!busy && !waitingMessage ? (
						<button type="button" onClick={() => void runClaim()} className="primary-button">
							Retry
						</button>
					) : null}
					{(blockedMessage || sessionExpired) && !busy ? (
						<button type="button" onClick={onSignOut} className="secondary-button">
							Sign out
						</button>
					) : null}
				</div>
			</section>
		</main>
	);
}
