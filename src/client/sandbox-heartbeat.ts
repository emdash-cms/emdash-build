import { useEffect } from "react";

/** More often than the Sandbox's ten-minute idle stop. */
export const SANDBOX_HEARTBEAT_MS = 4 * 60_000;

/**
 * Tell BuilderAgent the owner is using the builder, the Admin tab included,
 * so the site's container is not stopped as idle. Only a builder in front of
 * them counts: seen, with focus in the window or its preview.
 */
export function useSandboxHeartbeat(agent: { call(method: string): Promise<unknown> }): void {
	useEffect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === "visible" && document.hasFocus()) {
				agent.call("keepSandboxAwake").catch(() => {});
			}
		}, SANDBOX_HEARTBEAT_MS);
		return () => clearInterval(timer);
	}, [agent]);
}
