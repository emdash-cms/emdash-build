import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Contains render-phase crashes (e.g. a React "maximum update depth" loop, #185)
 * so one bad render can't take down the whole session, and logs the component
 * stack -- which the minified prod build otherwise strips -- to point at the
 * offending component.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[ErrorBoundary]", error.message, "\ncomponentStack:", info.componentStack);
	}

	override render() {
		if (this.state.error) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-3 bg-surface p-6 text-center">
					<p className="text-sm text-text-secondary">Something went wrong rendering this view.</p>
					<p className="text-xs text-text-tertiary">Reload to continue.</p>
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="rounded-md bg-text-primary px-4 py-2 text-sm font-medium text-surface-raised"
					>
						Reload
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
