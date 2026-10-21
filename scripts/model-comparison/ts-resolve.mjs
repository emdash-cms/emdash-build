// Lets plain Node load the worker's TypeScript modules, so the probe runs the
// builder's own model code: `node --import ./scripts/model-comparison/ts-resolve.mjs`.
// Relative imports name `.js` files that exist as `.ts`, and Node's type
// stripping cannot handle constructor parameter properties, so `.ts` files are
// transpiled with the project's TypeScript.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
			const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
			if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
		const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
			fileName: fileURLToPath(url),
		});
		return { format: "module", source: outputText, shortCircuit: true };
	},
});
