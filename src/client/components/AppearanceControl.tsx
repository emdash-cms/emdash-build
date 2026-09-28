import { Collapsible } from "@cloudflare/kumo";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { Check } from "@phosphor-icons/react/Check";
import { CircleHalf } from "@phosphor-icons/react/CircleHalf";
import { Desktop } from "@phosphor-icons/react/Desktop";
import { Moon } from "@phosphor-icons/react/Moon";
import { Sun } from "@phosphor-icons/react/Sun";
import { useRef, useState } from "react";
import type { Appearance } from "../appearance.js";

const choices = [
	{ value: "system", label: "System", icon: Desktop },
	{ value: "light", label: "Light", icon: Sun },
	{ value: "dark", label: "Dark", icon: Moon },
] as const;

export function AppearanceControl({
	appearance,
	onChange,
	compact = false,
	floating = false,
}: {
	appearance: Appearance;
	onChange: (appearance: Appearance) => void;
	compact?: boolean;
	floating?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const showLabels = !compact || floating;
	const keepTriggerLabels = !compact || !floating;

	return (
		<Collapsible.Root
			open={open}
			onOpenChange={setOpen}
			className={`${compact && floating ? "w-9" : "w-full"} ${floating ? "relative" : ""}`}
		>
			<Collapsible.Trigger
				ref={triggerRef}
				aria-label="Appearance"
				title={compact ? "Appearance" : undefined}
				className={`flex h-9 w-full items-center justify-center rounded-lg px-2 text-sm text-text-secondary transition-[gap] duration-(--sidebar-animation-duration) ease-(--sidebar-easing) hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none ${compact ? "gap-0" : "gap-2"}`}
			>
				<CircleHalf size={17} className="shrink-0" aria-hidden="true" />
				{keepTriggerLabels ? (
					<span
						aria-hidden={compact || undefined}
						className={`flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-(--sidebar-animation-duration) ease-(--sidebar-easing) motion-reduce:transition-none ${compact ? "max-w-0 opacity-0" : "max-w-52 opacity-100"}`}
					>
						<span>Appearance</span>
						<span className="ml-auto text-xs text-text-tertiary">
							{appearance === "system" ? "System" : appearance === "light" ? "Light" : "Dark"}
						</span>
						<CaretDown
							size={12}
							aria-hidden="true"
							className="ml-2 shrink-0 transition-transform duration-200 [[data-panel-open]_&]:rotate-180 motion-reduce:transition-none"
						/>
					</span>
				) : null}
			</Collapsible.Trigger>
			<Collapsible.Panel
				className={`h-[var(--collapsible-panel-height)] overflow-hidden transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 [&[hidden]:not([hidden='until-found'])]:hidden motion-reduce:transition-none ${floating ? "absolute end-0 top-full z-30 mt-1 w-44" : "w-full"}`}
			>
				<div
					role="group"
					aria-label="Theme"
					className={`flex flex-col gap-0.5 ${compact && !floating ? "items-center py-1" : "mt-1 rounded-lg border border-border bg-surface-raised p-1 shadow-sm"}`}
				>
					{choices.map((choice) => {
						const Icon = choice.icon;
						return (
							<button
								key={choice.value}
								type="button"
								aria-label={showLabels ? undefined : choice.label}
								aria-pressed={appearance === choice.value}
								onClick={() => {
									onChange(choice.value);
									setOpen(false);
									triggerRef.current?.focus();
								}}
								className={`flex h-9 w-full items-center gap-2 rounded-md text-sm focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent focus-visible:outline-none ${showLabels ? "px-2" : "justify-center px-0"} ${appearance === choice.value ? "bg-surface-sunken text-text-primary" : "text-text-secondary hover:bg-surface-sunken hover:text-text-primary"}`}
							>
								<Icon size={16} aria-hidden="true" />
								{showLabels ? <span>{choice.label}</span> : null}
								{showLabels && appearance === choice.value ? (
									<Check size={14} className="ml-auto" aria-hidden="true" />
								) : null}
							</button>
						);
					})}
				</div>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}
