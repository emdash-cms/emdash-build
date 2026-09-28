import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.{ts,tsx,mjs}"],
		exclude: [...configDefaults.exclude, "test/**/*.worker.test.ts"],
	},
});
