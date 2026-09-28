import { Popover } from "@cloudflare/kumo";
import { CheckCircle, Copy, UploadSimple, X } from "@phosphor-icons/react";
import { useEffect, useId, useState, type FormEvent } from "react";
import type { PublishState } from "../../platform/publish-state.js";
import { fetchWithTransientRetries } from "../retry.js";

const DOMAIN = "em-da.sh";
const actionClass =
	"rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60";

export function PublishPanel({
	projectId,
	open,
	onOpenChange,
	state,
	onPublish,
	onSignIn,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	state: PublishState;
	onPublish: (slug?: string) => void;
	onSignIn: () => void;
}) {
	const inputId = useId();
	const [slug, setSlug] = useState("");
	const [namedPublishing, setNamedPublishing] = useState(false);
	const [publishingAvailable, setPublishingAvailable] = useState(true);
	const [addressReady, setAddressReady] = useState(false);
	const [confirmedUrl, setConfirmedUrl] = useState<string>();
	const [addressError, setAddressError] = useState<string>();
	const [addressAttempt, setAddressAttempt] = useState(0);
	const [copyMessage, setCopyMessage] = useState<string>();

	useEffect(() => {
		if (!open || state.stage === "authentication-required") return;
		const controller = new AbortController();
		setAddressReady(false);
		setAddressError(undefined);
		fetchWithTransientRetries(`/api/projects/${projectId}/publish`, {
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) throw new Error("Could not check your site address.");
				return response.json() as Promise<{
					namedPublishing?: boolean;
					publishingAvailable?: boolean;
					slug?: string;
					active?: boolean;
					liveUrl?: string;
				}>;
			})
			.then((details) => {
				setNamedPublishing(details.namedPublishing === true);
				setPublishingAvailable(details.publishingAvailable !== false);
				if (details.slug) {
					if (details.active) setSlug(details.slug);
					else setSlug((current) => current || details.slug || "");
				}
				setConfirmedUrl(details.active ? details.liveUrl : undefined);
				setAddressReady(true);
			})
			.catch(() => {
				if (controller.signal.aborted) return;
				setAddressError("Could not check your site address.");
				setAddressReady(true);
			});
		return () => controller.abort();
	}, [addressAttempt, open, projectId]);

	const currentUrl = confirmedUrl ?? state.liveUrl;
	const brandedLive = currentUrl ? new URL(currentUrl).hostname.endsWith(`.${DOMAIN}`) : false;
	const permanentSlug = brandedLive
		? new URL(currentUrl!).hostname.slice(0, -(DOMAIN.length + 1))
		: undefined;
	const showAddressInput = namedPublishing && !permanentSlug;
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		onPublish(namedPublishing ? slug : undefined);
	};
	const copyUrl = async () => {
		if (!currentUrl) return;
		try {
			await navigator.clipboard.writeText(currentUrl);
			setCopyMessage("Link copied.");
		} catch {
			setCopyMessage("Could not copy. Select the link above instead.");
		}
	};

	return (
		<Popover open={open} onOpenChange={onOpenChange} modal={false}>
			<Popover.Trigger
				render={<button type="button" className="primary-button" data-publish-button />}
			>
				<UploadSimple size={15} aria-hidden="true" />
				{state.stage === "publishing" ? "Publishing…" : "Publish"}
			</Popover.Trigger>
			<Popover.Content
				side="bottom"
				align="end"
				sideOffset={8}
				positionMethod="fixed"
				className="max-h-[calc(100dvh-5rem)] w-[min(23rem,calc(100vw-1rem))] overflow-y-auto bg-surface-raised p-4"
			>
				<div className="flex items-start justify-between gap-3">
					<div>
						<Popover.Title className="text-base font-semibold">Publish site</Popover.Title>
						<Popover.Description className="mt-1 text-sm text-text-secondary">
							Your draft stays editable after publishing.
						</Popover.Description>
					</div>
					<Popover.Close
						render={
							<button
								type="button"
								aria-label="Close publish panel"
								className="flex size-9 shrink-0 items-center justify-center rounded-lg text-text-tertiary hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent"
							/>
						}
					>
						<X size={16} aria-hidden="true" />
					</Popover.Close>
				</div>

				{state.stage === "authentication-required" ? (
					<div className="mt-5 rounded-lg bg-surface-sunken p-4 text-sm">
						<p className="font-medium">Sign in to publish</p>
						<p className="mt-1 text-text-secondary">Your draft stays here while you sign in.</p>
						<button type="button" onClick={onSignIn} className={`mt-3 ${actionClass}`}>
							Sign in
						</button>
					</div>
				) : null}

				{state.stage === "publishing" ? (
					<div
						role="status"
						aria-live="polite"
						className="mt-5 rounded-lg bg-surface-sunken p-4 text-sm"
					>
						<p className="font-medium">Publishing your site…</p>
						<p className="mt-2 text-text-secondary">
							{state.progress ?? "Preparing the public snapshot…"}
						</p>
						<p className="mt-2 text-xs text-text-tertiary">
							You can close this panel and keep chatting. Publishing continues.
						</p>
					</div>
				) : null}

				{state.stage === "failed" ? (
					<div role="alert" className="mt-5 rounded-lg bg-danger-light p-4 text-sm text-danger">
						<p className="font-medium">Publishing didn’t finish</p>
						<p className="mt-1">{state.error ?? "Publishing failed."}</p>
						{state.liveUrl && !state.error?.includes("may have completed") ? (
							<p className="mt-1">Live is unchanged.</p>
						) : null}
						{state.reference ? <p className="mt-2 text-xs">Reference: {state.reference}</p> : null}
					</div>
				) : null}

				{currentUrl && (state.stage === "live" || state.stage === "failed") ? (
					<div className="mt-5 rounded-lg bg-surface-sunken p-4 text-sm">
						<p className="flex items-center gap-2 font-medium">
							{state.stage === "live" ? (
								<CheckCircle size={19} className="text-success" aria-hidden="true" />
							) : null}
							{state.stage === "live" ? "Your website is live" : "Current live site"}
						</p>
						<a
							href={currentUrl}
							target="_blank"
							rel="noreferrer"
							className="mt-2 block break-all text-accent underline-offset-2 hover:underline"
						>
							{new URL(currentUrl).hostname}
						</a>
						<div className="mt-4 grid grid-cols-2 gap-2">
							<button
								type="button"
								onClick={() => void copyUrl()}
								className="secondary-button justify-center"
							>
								<Copy size={15} aria-hidden="true" /> Copy link
							</button>
							<a
								href={currentUrl}
								target="_blank"
								rel="noreferrer"
								className={`${actionClass} text-center`}
							>
								Visit site ↗
							</a>
						</div>
						<p role="status" aria-live="polite" className="mt-2 text-xs text-text-secondary">
							{copyMessage}
						</p>
					</div>
				) : null}

				{state.stage !== "authentication-required" && state.stage !== "publishing" ? (
					<form onSubmit={submit} className="mt-5">
						{!addressReady ? (
							<p role="status" className="text-sm text-text-secondary">
								Checking address…
							</p>
						) : null}
						{addressError ? (
							<div role="alert" className="flex items-center gap-3 text-sm text-danger">
								<p>{addressError}</p>
								<button
									type="button"
									onClick={() => setAddressAttempt((attempt) => attempt + 1)}
									className="ml-auto shrink-0 rounded-lg px-2 py-1 font-medium ring-1 ring-danger/30 hover:bg-danger/10"
								>
									Retry
								</button>
							</div>
						) : null}
						{addressReady && showAddressInput ? (
							<div>
								<label htmlFor={inputId} className="block text-sm font-medium">
									Site address
								</label>
								<div className="mt-2 flex items-center rounded-lg border border-border bg-surface">
									<input
										id={inputId}
										value={slug}
										required
										minLength={3}
										maxLength={63}
										pattern="[a-z0-9]+([a-z0-9-]*[a-z0-9])?"
										onChange={(event) => setSlug(event.target.value.toLowerCase())}
										autoComplete="off"
										spellCheck={false}
										className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
									/>
									<span className="pr-3 text-sm text-text-secondary">.{DOMAIN}</span>
								</div>
								<p className="mt-1 text-xs text-text-tertiary">
									Choose a memorable name. It stays yours once published.
								</p>
							</div>
						) : null}
						{addressReady && !publishingAvailable ? (
							<p className="text-sm text-text-secondary">
								Publishing is available on the production Builder only.
							</p>
						) : null}
						<button
							type="submit"
							disabled={!addressReady || !publishingAvailable || Boolean(addressError)}
							className={`mt-4 ${actionClass}`}
						>
							{state.stage === "failed"
								? "Try again"
								: state.stage === "live"
									? "Publish again"
									: "Publish site"}
						</button>
					</form>
				) : null}
			</Popover.Content>
		</Popover>
	);
}
