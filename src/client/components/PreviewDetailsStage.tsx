import type { ReactNode } from "react";

export function PreviewDetailsStage({
	children,
	details,
}: {
	children: ReactNode;
	details?: ReactNode;
}) {
	return (
		<>
			<div
				className={`flex min-h-0 flex-1 flex-col ${details ? "invisible pointer-events-none" : ""}`}
				inert={Boolean(details)}
				aria-hidden={details ? true : undefined}
			>
				{children}
			</div>
			{details}
		</>
	);
}
