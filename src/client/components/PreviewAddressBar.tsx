import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { Check } from "@phosphor-icons/react/Check";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Combobox } from "@base-ui/react/combobox";
import { useMemo, useRef, useState } from "react";
import {
	normalizePreviewPath,
	previewDocumentPath,
	type PreviewLink,
} from "../../shared/preview-navigation.js";

/**
 * Pill-shaped address control: reload on the left, the current route as a
 * trigger for a searchable route list. Typing any path offers "Go to" it.
 *
 * The pill, search row and list rows share one geometry: a 24px icon column
 * after a 4px inset, then text at the same x, so everything lines up.
 */
export function PreviewAddressBar({
	label,
	path,
	routes,
	loading,
	stale,
	disabled,
	onReload,
	onNavigate,
}: {
	label: string;
	path?: string;
	routes: PreviewLink[];
	loading: boolean;
	stale: boolean;
	disabled: boolean;
	onReload?: () => void;
	onNavigate: (path: string) => void;
}) {
	const anchorRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const current = path ? previewDocumentPath(path) : undefined;
	const labels = useMemo(() => new Map(routes.map((route) => [route.path, route.label])), [routes]);
	const typed = normalizePreviewPath(query);
	const items = useMemo(() => {
		const paths = routes.map((route) => route.path);
		return typed && !labels.has(typed) ? [...paths, typed] : paths;
	}, [routes, labels, typed]);

	return (
		<Combobox.Root<string>
			items={items}
			value={current ?? null}
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) setQuery("");
			}}
			inputValue={query}
			onInputValueChange={setQuery}
			onValueChange={(value) => {
				if (typeof value === "string") onNavigate(value);
			}}
			autoHighlight
			disabled={disabled}
		>
			<div
				ref={anchorRef}
				data-open={open || undefined}
				className="preview-address-pill group flex h-8 min-w-0 items-center gap-2 rounded-full border border-border bg-surface-raised pl-1 pr-2.5 transition-colors duration-150 hover:border-border-strong data-open:border-border-strong"
			>
				<button
					type="button"
					onClick={onReload}
					disabled={!onReload}
					className="flex size-6 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors duration-150 hover:bg-surface-sunken hover:text-text-primary disabled:opacity-40"
					title={onReload ? "Reload preview" : "Choose a page to reload the live site"}
					aria-label="Reload preview"
				>
					<ArrowClockwise
						size={14}
						weight="bold"
						className={loading ? "animate-spin motion-reduce:animate-none" : undefined}
					/>
				</button>
				<Combobox.Trigger
					className="flex h-full min-w-0 flex-1 items-center gap-2 text-left text-sm text-text-primary outline-none focus-visible:underline disabled:cursor-default disabled:text-text-secondary"
					aria-label={`Choose page, current page ${label}`}
					title={disabled ? undefined : "Choose page"}
				>
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{stale ? (
						<span
							className="size-1.5 shrink-0 rounded-full bg-warning"
							title="Showing the last saved version while the preview server catches up. It refreshes automatically when the new version is ready."
						>
							<span className="sr-only">Showing an earlier snapshot</span>
						</span>
					) : null}
					{disabled ? null : (
						<CaretDown
							size={12}
							weight="bold"
							aria-hidden="true"
							className="shrink-0 text-text-tertiary transition-transform duration-200 ease-out motion-reduce:transition-none group-data-open:rotate-180"
						/>
					)}
				</Combobox.Trigger>
			</div>
			<Combobox.Portal>
				<Combobox.Positioner anchor={anchorRef} align="start" sideOffset={6} className="z-50">
					<Combobox.Popup className="preview-popover preview-route-menu flex max-h-[min(var(--available-height),22rem)] flex-col overflow-clip rounded-2xl border border-border bg-surface-raised text-text-primary shadow-lg">
						<div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-1 pr-3">
							<span className="flex size-6 shrink-0 items-center justify-center text-text-tertiary">
								<MagnifyingGlass size={15} aria-hidden="true" />
							</span>
							<Combobox.Input
								placeholder="Search pages or type a path"
								aria-label="Search pages or type a path"
								className="h-full min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
							/>
						</div>
						<Combobox.Empty className="px-4 py-3 text-sm text-text-tertiary empty:hidden">
							No pages found. Type a path starting with /.
						</Combobox.Empty>
						<Combobox.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1 empty:hidden">
							{(item: string) => {
								const known = labels.has(item);
								const detail = labels.get(item);
								return (
									<Combobox.Item
										key={item}
										value={item}
										className="flex h-9 cursor-default items-center gap-2 rounded-xl pr-3 text-sm outline-none select-none data-highlighted:bg-surface-sunken"
									>
										<span className="flex size-6 shrink-0 items-center justify-center">
											<Combobox.ItemIndicator>
												<Check size={14} weight="bold" />
											</Combobox.ItemIndicator>
										</span>
										<span className="min-w-0 flex-1 truncate">
											{known ? item : `Go to ${item}`}
										</span>
										{detail ? (
											<span className="max-w-[45%] shrink-0 truncate text-xs text-text-tertiary">
												{detail}
											</span>
										) : null}
									</Combobox.Item>
								);
							}}
						</Combobox.List>
					</Combobox.Popup>
				</Combobox.Positioner>
			</Combobox.Portal>
		</Combobox.Root>
	);
}
