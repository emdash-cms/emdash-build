import { useCallback, useEffect, useRef, useState } from "react";

export const COMPACT_WORKSPACE_QUERY = "(max-width: 1120px)";

export function useWorkspacePreview(onCompactChange?: (compact: boolean) => void) {
	const [compact, setCompact] = useState(
		() => window.matchMedia?.(COMPACT_WORKSPACE_QUERY).matches ?? false,
	);
	const compactRef = useRef(compact);
	const onCompactChangeRef = useRef(onCompactChange);
	onCompactChangeRef.current = onCompactChange;
	const [compactPreviewOpen, setCompactPreviewOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);

	useEffect(() => {
		const media = window.matchMedia?.(COMPACT_WORKSPACE_QUERY);
		if (!media) return;
		const update = () => {
			if (compactRef.current === media.matches) return;
			onCompactChangeRef.current?.(media.matches);
			compactRef.current = media.matches;
			setCompact(media.matches);
		};
		media.addEventListener("change", update);
		update();
		return () => media.removeEventListener("change", update);
	}, []);

	useEffect(() => {
		if (compact) setExpanded(false);
	}, [compact]);

	return {
		compact,
		previewCollapsed: compact && !compactPreviewOpen,
		previewExpanded: !compact && expanded,
		showPreview: useCallback(() => setCompactPreviewOpen(true), []),
		hidePreview: useCallback(() => {
			setCompactPreviewOpen(false);
			setExpanded(false);
		}, []),
		toggleExpanded: useCallback(() => setExpanded((value) => !value), []),
		restoreExpanded: useCallback(() => setExpanded(false), []),
	};
}
