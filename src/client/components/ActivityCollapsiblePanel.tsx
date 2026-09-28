import { Collapsible } from "@cloudflare/kumo";
import type { ComponentProps } from "react";

export function ActivityCollapsiblePanel({
	children,
	className = "",
	...props
}: ComponentProps<typeof Collapsible.Panel>) {
	return (
		<Collapsible.Panel
			{...props}
			className={`h-[var(--collapsible-panel-height)] overflow-hidden transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 [&[hidden]:not([hidden='until-found'])]:hidden motion-reduce:transition-none ${className}`}
		>
			<div className="flow-root">{children}</div>
		</Collapsible.Panel>
	);
}
