import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const projectRoot = new URL("../", import.meta.url);
const publicRoots = ["src/pages", "src/layouts", "src/components"];
const violations = [];

async function visit(directory) {
	for (const entry of await readdir(new URL(`${directory}/`, projectRoot), {
		withFileTypes: true,
	})) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await visit(path);
			continue;
		}
		if (![".astro", ".js", ".mjs", ".ts", ".tsx", ".jsx"].includes(extname(path))) continue;
		if (path.endsWith(".tsx") || path.endsWith(".jsx")) {
			violations.push(`${path}: public frontend source must be Astro or vanilla JavaScript`);
		}
		const source = await readFile(new URL(path, projectRoot), "utf8");
		if (/from\s+["']react(?:-dom)?(?:\/[^"']*)?["']/.test(source)) {
			violations.push(`${path}: imports React in the public frontend`);
		}
		if (/\bclient:(?:load|idle|visible|media|only)\b/.test(source)) {
			violations.push(`${path}: hydrates a public component with client:*`);
		}
	}
}

for (const root of publicRoots) await visit(root);

if (violations.length) {
	console.error(
		"Public frontend validation failed:\n" + violations.map((v) => `- ${v}`).join("\n"),
	);
	process.exitCode = 1;
} else {
	console.log("Public frontend is Astro-only: no React imports, JSX/TSX, or client:* hydration.");
}
