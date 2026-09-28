import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const highlighter = createHighlighterCore({
	themes: [
		import("@shikijs/themes/github-light-high-contrast"),
		import("@shikijs/themes/github-dark-high-contrast"),
	],
	langs: [
		import("@shikijs/langs/astro"),
		import("@shikijs/langs/css"),
		import("@shikijs/langs/html"),
		import("@shikijs/langs/javascript"),
		import("@shikijs/langs/jsx"),
		import("@shikijs/langs/typescript"),
		import("@shikijs/langs/tsx"),
		import("@shikijs/langs/json"),
		import("@shikijs/langs/markdown"),
	],
	engine: createJavaScriptRegexEngine(),
});

export type HighlightedLine = { content: string; light?: string; dark?: string }[];

const languages: Record<string, string> = {
	astro: "astro",
	css: "css",
	html: "html",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "tsx",
	json: "json",
	md: "markdown",
};

export async function highlightCode(code: string, path: string): Promise<HighlightedLine[] | null> {
	const extension = path.split(".").pop()?.toLowerCase();
	const language = languages[extension ?? ""];
	if (!language) return null;
	const instance = await highlighter;
	return instance
		.codeToTokens(code, {
			lang: language,
			themes: {
				light: "github-light-high-contrast",
				dark: "github-dark-high-contrast",
			},
			defaultColor: false,
		})
		.tokens.map((line) =>
			line.map((token) => ({
				content: token.content,
				light: token.htmlStyle?.["--shiki-light"],
				dark: token.htmlStyle?.["--shiki-dark"],
			})),
		);
}
