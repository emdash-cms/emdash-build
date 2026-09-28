import { Browser } from "@phosphor-icons/react/Browser";
import { PencilSimple } from "@phosphor-icons/react/PencilSimple";
import { Sidebar, useSidebar } from "@cloudflare/kumo";
import { useEffect, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";

export function ProjectHeader({
	title,
	previewCollapsed,
	onRename,
	onTogglePreview,
	previewTriggerRef,
	publishControl,
	exportControl,
	accountActions,
}: {
	title: string;
	previewCollapsed: boolean;
	onRename: (title: string) => Promise<void>;
	onTogglePreview: () => void;
	previewTriggerRef?: Ref<HTMLButtonElement>;
	publishControl?: ReactNode;
	exportControl?: ReactNode;
	accountActions?: ReactNode;
}) {
	const { isMobile, openMobile } = useSidebar();
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(title);
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const renameButton = useRef<HTMLButtonElement>(null);
	const wasEditing = useRef(false);
	useEffect(() => {
		if (wasEditing.current && !editing) renameButton.current?.focus();
		wasEditing.current = editing;
	}, [editing]);

	const saveName = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || trimmed === title) {
			setEditing(false);
			return;
		}
		setSaving(true);
		setError(undefined);
		try {
			await onRename(trimmed);
			setEditing(false);
		} catch {
			setError("Name couldn't be saved. Try again.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<header className="workspace-header flex h-13 shrink-0 items-center gap-2 border-b border-border px-3">
			<Sidebar.Trigger
				className="shrink-0 md:hidden"
				aria-label={isMobile && openMobile ? "Close projects" : "Open projects"}
				title={isMobile && openMobile ? "Close projects" : "Open projects"}
				aria-expanded={isMobile ? openMobile : false}
			/>
			<div className="flex min-w-0 items-center gap-2 text-sm">
				<span className="hidden text-text-tertiary sm:inline">Projects</span>
				<span className="hidden text-text-tertiary sm:inline" aria-hidden="true">
					/
				</span>
				{editing ? (
					<form
						onSubmit={(event) => void saveName(event)}
						className="flex min-w-0 items-center gap-1"
					>
						<h1 className="sr-only">{title}</h1>
						<input
							autoFocus
							aria-label="Site name"
							maxLength={200}
							value={name}
							onChange={(event) => setName(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									setEditing(false);
									setError(undefined);
								}
							}}
							className="min-w-0 rounded border border-border bg-surface px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-accent"
						/>
						<button type="submit" disabled={saving || !name.trim()} className="secondary-button">
							Save
						</button>
					</form>
				) : (
					<>
						<h1 data-project-title tabIndex={-1} className="truncate font-medium outline-none">
							{title}
						</h1>
						<button
							ref={renameButton}
							type="button"
							aria-label="Rename site"
							title="Rename site"
							onClick={() => {
								setName(title);
								setError(undefined);
								setEditing(true);
							}}
							className="flex size-8 shrink-0 items-center justify-center rounded text-text-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
						>
							<PencilSimple size={15} aria-hidden="true" />
						</button>
					</>
				)}
			</div>
			{error ? (
				<span role="alert" className="truncate text-xs text-danger">
					{error}
				</span>
			) : null}

			<div className="ml-auto flex items-center gap-1.5">
				{accountActions}
				{previewCollapsed ? (
					<button
						ref={previewTriggerRef}
						type="button"
						onClick={onTogglePreview}
						aria-label="Show preview"
						title="Show preview"
						className="secondary-button"
					>
						<Browser size={15} aria-hidden="true" />
						<span className="hidden sm:inline">Show preview</span>
					</button>
				) : null}
				{exportControl}
				{publishControl}
			</div>
		</header>
	);
}
