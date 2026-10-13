import { readFile } from "node:fs/promises";

export async function loadProviderConfig(path) {
	return validateProviderConfig(JSON.parse(await readFile(path, "utf8")));
}

export function validateProviderConfig(value) {
	if (!value || typeof value !== "object") throw new Error("provider config must be an object");
	const requiredStrings = [
		"providerId",
		"zoneName",
		"appHostname",
		"previewHostname",
		"sitesHostname",
		"artifactsNamespace",
		"dispatchNamespace",
		"identityBrokerUrl",
		"accountId",
		"releaseBucketName",
	];
	if (value.version !== 1 && value.version !== 2 && value.version !== 3) {
		throw new Error("provider config version must be 1, 2 or 3");
	}
	if (value.version >= 2) {
		requiredStrings.push(
			"identityIssuer",
			"identityAudience",
			"identityDatabaseName",
			"identityDatabaseId",
		);
	}
	if (value.version === 3) requiredStrings.push("siteMediaBucketName");
	for (const key of requiredStrings) {
		if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`${key} is required`);
	}
	value = {
		...value,
		appHostname: value.appHostname.toLowerCase(),
		previewHostname: value.previewHostname.toLowerCase(),
		sitesHostname: value.sitesHostname.toLowerCase(),
	};
	if (!/^[a-z0-9][a-z0-9-]*$/.test(value.providerId)) {
		throw new Error("providerId must contain lowercase letters, digits, and hyphens");
	}
	if (!Number.isSafeInteger(value.sandboxMaxInstances) || value.sandboxMaxInstances < 1) {
		throw new Error("sandboxMaxInstances must be a positive integer");
	}
	if (!/^[a-f0-9]{32}$/.test(value.accountId))
		throw new Error("accountId must be 32 lowercase hex characters");
	if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value.releaseBucketName)) {
		throw new Error("releaseBucketName must be a provider-safe bucket name");
	}
	if (
		value.version === 3 &&
		!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(value.siteMediaBucketName)
	) {
		throw new Error("siteMediaBucketName must be a provider-safe bucket name");
	}
	if (value.version === 3 && value.siteMediaBucketName === value.releaseBucketName) {
		throw new Error("siteMediaBucketName and releaseBucketName must differ");
	}
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.dispatchNamespace)) {
		throw new Error("dispatchNamespace must be a provider-safe namespace");
	}
	const hostnames = [value.appHostname, value.previewHostname, value.sitesHostname];
	if (new Set(hostnames).size !== hostnames.length) {
		throw new Error("application, preview and site hosts must differ");
	}
	for (const hostname of hostnames) {
		if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(hostname)) {
			throw new Error(`invalid hostname: ${hostname}`);
		}
	}
	if (value.sitesHostname.length > 218) {
		throw new Error("sitesHostname is too long for generated Site labels");
	}
	const identityBrokerUrl = new URL(value.identityBrokerUrl);
	if (value.version >= 2) {
		if (
			identityBrokerUrl.protocol !== "https:" ||
			identityBrokerUrl.origin !== `https://${value.appHostname}` ||
			identityBrokerUrl.pathname !== "/api/auth/callback" ||
			identityBrokerUrl.search ||
			identityBrokerUrl.hash
		) {
			throw new Error("identityBrokerUrl must be an HTTPS URL on the application origin");
		}
		const issuer = new URL(value.identityIssuer);
		if (issuer.protocol !== "https:" || issuer.pathname !== "/" || issuer.search || issuer.hash) {
			throw new Error("identityIssuer must be an HTTPS origin");
		}
		if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.identityDatabaseId)) {
			throw new Error("identityDatabaseId must be a UUID");
		}
	}
	return value;
}

export function renderStudioWrangler(config) {
	const identityConfigured = config.version >= 2;
	const siteServiceConfigured = config.version === 3;
	return {
		$schema: "node_modules/wrangler/config-schema.json",
		name: `${config.providerId}-emdash-build`,
		compatibility_date: "2026-09-13",
		compatibility_flags: ["nodejs_compat"],
		main: "./src/worker/index.ts",
		observability: { enabled: true },
		workers_dev: true,
		assets: {
			directory: "./public",
			not_found_handling: "single-page-application",
			binding: "ASSETS",
			run_worker_first: true,
		},
		containers: [
			{
				class_name: "Sandbox",
				name: `${config.providerId}-emdash-build-sandbox-do`,
				scheduling_policy: "durable_object",
				images: { sandbox: { dockerfile: "./Dockerfile" } },
			},
		],
		durable_objects: {
			bindings: [
				{ name: "BuilderAgent", class_name: "BuilderAgent" },
				{ name: "Sandbox", class_name: "Sandbox" },
				{ name: "ProjectCatalog", class_name: "ProjectCatalog" },
				{ name: "ProviderControlPlane", class_name: "ProviderControlPlane" },
				...(siteServiceConfigured ? [{ name: "SiteService", class_name: "SiteService" }] : []),
				{ name: "SandboxCapacity", class_name: "SandboxCapacity" },
			],
		},
		migrations: [
			{ tag: "v1", new_sqlite_classes: ["BuilderAgent", "Sandbox"] },
			{ tag: "v2", new_sqlite_classes: ["ProjectCatalog"] },
			{ tag: "v3", new_sqlite_classes: ["ProviderControlPlane"] },
			// Every version migrates every class, so moving to a later config version
			// never needs a migration earlier than the last one applied.
			{ tag: "v4", new_sqlite_classes: ["SiteService"] },
			{ tag: "v5", new_sqlite_classes: ["SandboxCapacity"] },
		],
		ai: { binding: "AI", remote: true },
		worker_loaders: [{ binding: "LOADER" }],
		artifacts: [{ binding: "ARTIFACTS", namespace: config.artifactsNamespace, remote: true }],
		...(identityConfigured
			? {
					d1_databases: [
						{
							binding: "AUTH_DB",
							database_name: config.identityDatabaseName,
							database_id: config.identityDatabaseId,
							migrations_dir: "migrations",
						},
					],
				}
			: {}),
		r2_buckets: [
			{ binding: "WFP_RELEASES", bucket_name: config.releaseBucketName },
			...(siteServiceConfigured
				? [{ binding: "SITE_MEDIA", bucket_name: config.siteMediaBucketName }]
				: []),
		],
		dispatch_namespaces: [{ binding: "WFP_DISPATCHER", namespace: config.dispatchNamespace }],
		routes: [
			{ pattern: config.appHostname, zone_name: config.zoneName, custom_domain: true },
			{ pattern: `*.${config.previewHostname}/*`, zone_name: config.zoneName },
			{ pattern: `*.${config.sitesHostname}/*`, zone_name: config.zoneName },
		],
		vars: {
			APP_HOSTNAME: config.appHostname,
			PREVIEW_HOSTNAME: config.previewHostname,
			IDENTITY_BROKER_URL: config.identityBrokerUrl,
			...(identityConfigured
				? {
						IDENTITY_ISSUER: config.identityIssuer,
						IDENTITY_AUDIENCE: config.identityAudience,
					}
				: {}),
			SITES_HOSTNAME: config.sitesHostname,
			ENABLE_CMS_SCRIPTS: "true",
			SANDBOX_MAX_CONCURRENT: String(config.sandboxMaxInstances),
			WFP_DISPATCH_NAMESPACE: config.dispatchNamespace,
			WFP_ACCOUNT_ID: config.accountId,
		},
		secrets: {
			required: [
				"UNSPLASH_ACCESS_KEY",
				"WFP_API_TOKEN",
				"AI_GATEWAY_TOKEN",
				"AI_GATEWAY_ACCOUNT_ID",
				"AI_GATEWAY_ID",
			],
		},
	};
}
