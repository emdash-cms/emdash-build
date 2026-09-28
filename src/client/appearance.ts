import { useCallback, useLayoutEffect, useState } from "react";

export type Appearance = "system" | "light" | "dark";

const APPEARANCE_KEY = "emdash-build:appearance";

function readAppearance(): Appearance {
	try {
		const stored = localStorage.getItem(APPEARANCE_KEY);
		return stored === "light" || stored === "dark" ? stored : "system";
	} catch {
		return "system";
	}
}

export function useAppearance() {
	const [appearance, setAppearance] = useState<Appearance>(readAppearance);

	useLayoutEffect(() => {
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		const apply = () => {
			const mode = appearance === "system" ? (media?.matches ? "dark" : "light") : appearance;
			document.documentElement.dataset.mode = mode;
			document
				.querySelector('meta[name="theme-color"]')
				?.setAttribute("content", mode === "dark" ? "#1e1e1d" : "#fafafa");
		};
		apply();
		media?.addEventListener("change", apply);
		return () => media?.removeEventListener("change", apply);
	}, [appearance]);

	const updateAppearance = useCallback((next: Appearance) => {
		setAppearance(next);
		try {
			localStorage.setItem(APPEARANCE_KEY, next);
		} catch {}
	}, []);

	return { appearance, updateAppearance };
}
