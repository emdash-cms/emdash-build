import { useEffect, useRef } from "react";

/** How often the recent-sites list refreshes while another site is building. */
export const PROJECT_REFRESH_MS = 15_000;
/** Otherwise a slow refresh still notices a site that starts building elsewhere. */
export const PROJECT_IDLE_REFRESH_MS = 60_000;

/**
 * Keep other sites' building shimmer current while the tab is visible:
 * refresh often while one shows as building, slowly otherwise, and once
 * whenever the tab comes back.
 */
export function useProjectListRefresh(watching: boolean, refresh: () => void) {
	const refreshRef = useRef(refresh);
	useEffect(() => {
		refreshRef.current = refresh;
	}, [refresh]);

	useEffect(() => {
		const timer = window.setInterval(
			() => {
				if (document.visibilityState === "visible") refreshRef.current();
			},
			watching ? PROJECT_REFRESH_MS : PROJECT_IDLE_REFRESH_MS,
		);
		return () => window.clearInterval(timer);
	}, [watching]);

	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState === "visible") refreshRef.current();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, []);
}
