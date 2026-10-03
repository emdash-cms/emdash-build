import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("migrations");

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/worker/index.ts",
			miniflare: {
				compatibilityDate: "2026-03-24",
				compatibilityFlags: ["nodejs_compat"],
				d1Databases: ["AUTH_DB"],
				r2Buckets: ["SITE_MEDIA", "WFP_RELEASES"],
				durableObjects: {
					ProjectCatalog: { className: "ProjectCatalog", useSQLite: true },
					BuilderAgent: { className: "BuilderAgent", useSQLite: true },
					ProviderControlPlane: { className: "ProviderControlPlane", useSQLite: true },
					SiteService: { className: "SiteService", useSQLite: true },
					SandboxCapacity: { className: "SandboxCapacity", useSQLite: true },
				},
				workerLoaders: { LOADER: {} },
				bindings: {
					TEST_MIGRATIONS: migrations,
					ENABLE_CMS_SCRIPTS: "true",
					SITES_HOSTNAME: "sites.test",
					BRANDED_SITES_HOSTNAME: "em-da.sh",
				},
				workers: [
					{
						name: "fake-wfp-runtime",
						modules: true,
						scriptPath: "./test/fixtures/fake-wfp-runtime.js",
					},
				],
				serviceBindings: { WFP_RUNTIME: "fake-wfp-runtime" },
			},
		}),
	],
	test: {
		include: ["test/**/*.worker.test.ts"],
	},
});
