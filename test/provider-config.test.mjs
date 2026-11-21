import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderStudioWrangler, validateProviderConfig } from "../scripts/provider-config.mjs";

const config = {
	version: 3,
	providerId: "example-host",
	zoneName: "example.com",
	appHostname: "build.example.com",
	previewHostname: "preview.build.example.com",
	sitesHostname: "sites.example.com",
	artifactsNamespace: "example-build",
	dispatchNamespace: "example-production",
	accountId: "a".repeat(32),
	releaseBucketName: "example-wfp-releases",
	siteMediaBucketName: "example-site-media",
	sandboxMaxInstances: 5,
	identityBrokerUrl: "https://build.example.com/api/auth/callback",
	identityIssuer: "https://example.cloudflareaccess.com",
	identityAudience: "access-audience",
	identityDatabaseName: "example-auth",
	identityDatabaseId: "11111111-1111-4111-8111-111111111111",
};

/** The deployed Worker's compatibility settings, as `wrangler.jsonc` declares them. */
function workerCompatibility() {
	const source = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
	const date = /"compatibility_date":\s*"([^"]+)"/.exec(source)?.[1];
	const flags = /"compatibility_flags":\s*(\[[^\]]*\])/.exec(source)?.[1];
	return { date, flags: flags ? JSON.parse(flags) : undefined };
}

describe("provider configuration", () => {
	it("runs provider deployments on the Worker's compatibility date and flags", () => {
		const wrangler = renderStudioWrangler(validateProviderConfig(config));
		const worker = workerCompatibility();
		// The same code: without enable_abortsignal_rpc, a Stop's signal cannot reach the Sandbox.
		expect(worker.date).toBeDefined();
		expect(wrangler.compatibility_date).toBe(worker.date);
		expect(wrangler.compatibility_flags).toEqual(worker.flags);
	});

	it("leaves out nodejs_compat, which the compatibility date turns on", () => {
		// On by default from 2026-08-04: workerd reports it as redundant, and Wrangler's setup leaves it out.
		expect(workerCompatibility().date >= "2026-08-04").toBe(true);
		expect(workerCompatibility().flags).not.toContain("nodejs_compat");
	});

	it("runs the worker tests on the Worker's compatibility date and flags", () => {
		const source = readFileSync(new URL("../vitest.worker.config.ts", import.meta.url), "utf8");
		const date = /compatibilityDate:\s*"([^"]+)"/.exec(source)?.[1];
		const flags = /compatibilityFlags:\s*(\[[^\]]*\])/.exec(source)?.[1];
		expect({ date, flags: flags ? JSON.parse(flags) : undefined }).toEqual(workerCompatibility());
	});

	it("renders provider-owned names, routes, and capacity", () => {
		const wrangler = renderStudioWrangler(validateProviderConfig(config));
		expect(wrangler).toMatchObject({
			name: "example-host-emdash-build",
			containers: [
				{
					class_name: "Sandbox",
					name: "example-host-emdash-build-sandbox-do",
					scheduling_policy: "durable_object",
					images: { sandbox: { dockerfile: "./Dockerfile" } },
				},
			],
			artifacts: [{ namespace: "example-build" }],
			// CMS programs run in Dynamic Workers.
			worker_loaders: [{ binding: "LOADER" }],
			vars: expect.objectContaining({ ENABLE_CMS_SCRIPTS: "true" }),
			r2_buckets: [
				{ binding: "WFP_RELEASES", bucket_name: "example-wfp-releases" },
				{ binding: "SITE_MEDIA", bucket_name: "example-site-media" },
			],
			dispatch_namespaces: [{ binding: "WFP_DISPATCHER", namespace: "example-production" }],
			durable_objects: {
				bindings: expect.arrayContaining([
					{ name: "ProviderControlPlane", class_name: "ProviderControlPlane" },
					{ name: "SiteService", class_name: "SiteService" },
				]),
			},
			vars: {
				APP_HOSTNAME: "build.example.com",
				PREVIEW_HOSTNAME: "preview.build.example.com",
				IDENTITY_BROKER_URL: "https://build.example.com/api/auth/callback",
				IDENTITY_ISSUER: "https://example.cloudflareaccess.com",
				IDENTITY_AUDIENCE: "access-audience",
				SITES_HOSTNAME: "sites.example.com",
				WFP_DISPATCH_NAMESPACE: "example-production",
				WFP_ACCOUNT_ID: "a".repeat(32),
			},
		});
		expect(wrangler.d1_databases).toEqual([
			{
				binding: "AUTH_DB",
				database_name: "example-auth",
				database_id: "11111111-1111-4111-8111-111111111111",
				migrations_dir: "migrations",
			},
		]);
		expect(wrangler.routes).toContainEqual({
			pattern: "*.preview.build.example.com/*",
			zone_name: "example.com",
		});
		expect(wrangler.routes).toContainEqual({
			pattern: "*.sites.example.com/*",
			zone_name: "example.com",
		});
		expect(wrangler.migrations).toContainEqual({
			tag: "v3",
			new_sqlite_classes: ["ProviderControlPlane"],
		});
		expect(wrangler.migrations).toContainEqual({
			tag: "v4",
			new_sqlite_classes: ["SiteService"],
		});
		// The app owns the container cap.
		expect(wrangler.migrations.at(-1)).toEqual({
			tag: "v5",
			new_sqlite_classes: ["SandboxCapacity"],
		});
		expect(wrangler.durable_objects.bindings).toContainEqual({
			name: "SandboxCapacity",
			class_name: "SandboxCapacity",
		});
		expect(wrangler.vars.SANDBOX_MAX_CONCURRENT).toBe("5");
		expect(wrangler.secrets.required).toEqual([
			"UNSPLASH_ACCESS_KEY",
			"WFP_API_TOKEN",
			"AI_GATEWAY_TOKEN",
			"AI_GATEWAY_ACCOUNT_ID",
			"AI_GATEWAY_ID",
		]);
	});

	it("rejects ambiguous hostnames and invalid provider ids", () => {
		expect(() =>
			validateProviderConfig({ ...config, previewHostname: config.appHostname }),
		).toThrow("hosts must differ");
		expect(() => validateProviderConfig({ ...config, providerId: "Not Valid" })).toThrow(
			"providerId",
		);
		expect(() => validateProviderConfig({ ...config, accountId: "not-an-account" })).toThrow(
			"accountId",
		);
	});

	it("normalizes provider hostnames and compares uniqueness case-insensitively", () => {
		const normalized = validateProviderConfig({
			...config,
			appHostname: "BUILD.EXAMPLE.COM",
			previewHostname: "PREVIEW.BUILD.EXAMPLE.COM",
			sitesHostname: "SITES.EXAMPLE.COM",
		});
		expect(normalized).toMatchObject({
			appHostname: "build.example.com",
			previewHostname: "preview.build.example.com",
			sitesHostname: "sites.example.com",
		});
		expect(() =>
			validateProviderConfig({ ...config, previewHostname: "BUILD.EXAMPLE.COM" }),
		).toThrow("hosts must differ");
	});

	it("bounds the Sites suffix after adding the generated Site label", () => {
		const prefix = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.`;
		expect(
			validateProviderConfig({ ...config, sitesHostname: `${prefix}${"d".repeat(26)}` })
				.sitesHostname,
		).toHaveLength(218);
		expect(() =>
			validateProviderConfig({ ...config, sitesHostname: `${prefix}${"d".repeat(27)}` }),
		).toThrow("sitesHostname");
	});

	it("keeps provider config v1 identity-unconfigured for compatibility", () => {
		const legacy = validateProviderConfig({
			...config,
			version: 1,
			identityIssuer: undefined,
			identityAudience: undefined,
			identityDatabaseName: undefined,
			identityDatabaseId: undefined,
		});
		const wrangler = renderStudioWrangler(legacy);
		expect(wrangler.d1_databases).toBeUndefined();
		expect(wrangler.vars).not.toHaveProperty("IDENTITY_AUDIENCE");
	});

	it("migrates the same classes in every config version, so an upgrade applies none twice or never", () => {
		const { siteMediaBucketName: _, ...versionTwo } = { ...config, version: 2 };
		for (const rendered of [config, versionTwo].map((value) =>
			renderStudioWrangler(validateProviderConfig(value)),
		)) {
			expect(rendered.migrations.map((migration) => migration.tag)).toEqual([
				"v1",
				"v2",
				"v3",
				"v4",
				"v5",
			]);
		}
	});

	it("keeps provider config v2 Site-service-unconfigured for compatibility", () => {
		const legacy = validateProviderConfig({
			...config,
			version: 2,
			siteMediaBucketName: undefined,
		});
		const wrangler = renderStudioWrangler(legacy);
		expect(wrangler.r2_buckets).toEqual([
			{ binding: "WFP_RELEASES", bucket_name: "example-wfp-releases" },
		]);
		expect(wrangler.durable_objects.bindings).not.toContainEqual({
			name: "SiteService",
			class_name: "SiteService",
		});
		// The class is still migrated, unbound, so a later move to version 3 needs no earlier tag.
		expect(wrangler.migrations).toContainEqual({
			tag: "v4",
			new_sqlite_classes: ["SiteService"],
		});
	});

	it("requires a distinct provider-safe Site-media bucket in version 3", () => {
		expect(() => validateProviderConfig({ ...config, siteMediaBucketName: undefined })).toThrow(
			"siteMediaBucketName",
		);
		expect(() =>
			validateProviderConfig({ ...config, siteMediaBucketName: config.releaseBucketName }),
		).toThrow("must differ");
	});

	it("requires a same-origin broker and complete identity config for version 2", () => {
		expect(() =>
			validateProviderConfig({ ...config, identityBrokerUrl: "https://auth.example.com/callback" }),
		).toThrow("application origin");
		expect(() =>
			validateProviderConfig({ ...config, identityBrokerUrl: "https://build.example.com/other" }),
		).toThrow("application origin");
		expect(() => validateProviderConfig({ ...config, identityAudience: undefined })).toThrow(
			"identityAudience",
		);
		expect(() => validateProviderConfig({ ...config, identityDatabaseId: "not-a-uuid" })).toThrow(
			"identityDatabaseId",
		);
	});
});
