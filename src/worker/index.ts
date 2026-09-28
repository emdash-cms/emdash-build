import { proxyToSandbox } from "@cloudflare/sandbox";
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import {
	createGuestToken,
	clearGuestCookie,
	hashGuestToken,
	httpsRedirectForRequest,
	projectIdFromAgentPath,
	serializeGuestCookie,
} from "./project-auth.js";
import {
	handleCurrentAccount,
	handleClaim,
	handleLoginCallback,
	handleLoginStart,
	handleLogout,
	type AccountAuthEnv,
} from "./account-auth-routes.js";
import { resolveOwner } from "./owner-auth.js";
import { withVerifiedAgentAuth } from "./agent-authorization.js";
import { enableLocalPreviewEditorSessionCookie, injectPreviewBridge } from "./preview-bridge.js";
import { routeProviderSite } from "./site-routing.js";
import { activePublishedSlugForSite, publishedSlugForSite } from "./published-slugs.js";
import { transcribeDictation } from "./transcribe.js";
import { publicPublishingEnabled } from "./publication-config.js";
import type { SiteService } from "./site-service.js";

export { BuilderAgent } from "./agent.js";
export { ProjectCatalog } from "./project-catalog.js";
export { ProviderControlPlane } from "./provider-control-plane.js";
export { Sandbox } from "./sandbox.js";
export { SiteReadCapability, SiteService } from "./site-service.js";

const app = new Hono<{ Bindings: Env }>();
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CREATION_TOKEN = /^[0-9a-f]{64}$/i;
const PUBLISH_DISABLED = {
	code: "PUBLISH_DISABLED",
	message: "Publishing is temporarily unavailable.",
} as const;

interface PublishBindings {
	SITES_HOSTNAME?: string;
	BRANDED_SITES_HOSTNAME?: string;
	SANDBOX_PREVIEW_MODE?: string;
	WFP_RELEASES?: R2Bucket;
	ProviderControlPlane?: DurableObjectNamespace;
	WFP_RUNTIME?: Fetcher;
	WFP_ACCOUNT_ID?: string;
	WFP_API_TOKEN?: string;
	WFP_DISPATCH_NAMESPACE?: string;
	WFP_DISPATCHER?: DispatchNamespace;
}

function isSameOrigin(request: Request): boolean {
	const origin = request.headers.get("Origin");
	return !origin || origin === new URL(request.url).origin;
}

// Health check
app.get("/api/health", (c) => c.json({ ok: true }));

app.post("/api/auth/login", (c) => handleLoginStart(c.req.raw, c.env as AccountAuthEnv));
app.get("/api/auth/callback", (c) => handleLoginCallback(c.req.raw, c.env as AccountAuthEnv));
app.get("/api/auth/account", (c) => handleCurrentAccount(c.req.raw, c.env as AccountAuthEnv));
app.post("/api/auth/claim", (c) => handleClaim(c.req.raw, c.env as AccountAuthEnv));
app.post("/api/auth/logout", (c) => handleLogout(c.req.raw, c.env as AccountAuthEnv));

// Resolve a server-minted project for a new guest, or prove ownership of an
// existing project before the client opens its Agent WebSocket.
app.post("/api/project-session", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	const requested = await c.req
		.json<{
			projectId?: string;
			createProjectId?: string;
			creationToken?: string;
			createNew?: boolean;
		}>()
		.catch(
			() =>
				({}) as {
					projectId?: string;
					createProjectId?: string;
					creationToken?: string;
					createNew?: boolean;
				},
		);
	if (requested.projectId && !PROJECT_ID.test(requested.projectId)) {
		return c.json({ error: "Invalid project identifier." }, 400);
	}
	if (requested.createProjectId && !PROJECT_ID.test(requested.createProjectId)) {
		return c.json({ error: "Invalid project identifier." }, 400);
	}
	if (requested.creationToken && !CREATION_TOKEN.test(requested.creationToken)) {
		return c.json({ error: "Invalid project request." }, 400);
	}
	if (Boolean(requested.createProjectId) !== Boolean(requested.creationToken)) {
		return c.json({ error: "Invalid project request." }, 400);
	}
	if (requested.projectId && requested.createProjectId) {
		return c.json({ error: "Invalid project request." }, 400);
	}
	if (requested.createNew !== undefined && typeof requested.createNew !== "boolean") {
		return c.json({ error: "Invalid project request." }, 400);
	}
	let resolution;
	try {
		resolution = await resolveOwner(c.req.raw, c.env as AccountAuthEnv);
	} catch {
		return c.json({ error: "Account state unavailable." }, 503);
	}
	let owner = resolution.owner;
	let newGuestToken: string | undefined;
	if (!owner && !requested.projectId) {
		newGuestToken = createGuestToken();
		const ownerKey = await hashGuestToken(newGuestToken);
		await c.env.ProjectCatalog.getByName(ownerKey).authorizeActiveGuest(ownerKey);
		owner = {
			principal: { kind: "guest", capabilityId: ownerKey },
			ownerKey,
			kind: "guest",
		};
	}
	if (!owner) {
		if (resolution.staleGuest) {
			c.header("Set-Cookie", clearGuestCookie(new URL(c.req.url).protocol === "https:"));
		}
		return c.json({ error: "Project not found." }, 404);
	}
	const catalog = c.env.ProjectCatalog.getByName(owner.ownerKey);
	const existingProjects = await catalog.listProjects();
	const accountProjectId =
		owner.kind === "account" && !requested.createNew
			? await catalog.firstAvailableProjectId()
			: undefined;
	let reservedGuestProjectId: string | undefined;
	if (
		!requested.projectId &&
		owner.kind === "guest" &&
		!(await catalog.canStartProject(owner.ownerKey))
	) {
		reservedGuestProjectId = await catalog.firstAvailableProjectId();
		if (requested.createNew || !reservedGuestProjectId) {
			return c.json({ error: "Finish claiming your projects before starting another." }, 409);
		}
	}
	const isNewProject = !requested.projectId && !accountProjectId && !reservedGuestProjectId;
	const projectId =
		requested.projectId ??
		accountProjectId ??
		reservedGuestProjectId ??
		requested.createProjectId ??
		crypto.randomUUID();
	const project = c.env.BuilderAgent.getByName(projectId);
	const resuming = Boolean(requested.projectId || accountProjectId || reservedGuestProjectId);
	const creationDigest = requested.creationToken
		? await hashGuestToken(requested.creationToken)
		: undefined;
	const sessionAccess = resuming
		? await project.openProjectSession(owner.ownerKey)
		: requested.createProjectId === projectId && creationDigest
			? {
					authorized: await project.initializeCreationOwnership(owner.ownerKey, creationDigest),
					previewUrl: undefined,
					initialMessages: undefined,
				}
			: {
					authorized: await project.initializeOwnership(owner.ownerKey),
					previewUrl: undefined,
					initialMessages: undefined,
				};
	const authorized = sessionAccess.authorized;

	if (!authorized) {
		if (
			requested.projectId &&
			(await catalog.isProjectDeletionPending(owner.ownerKey, requested.projectId))
		) {
			return c.json({ code: "PROJECT_DELETION_PENDING" }, 409);
		}
		return c.json({ error: "Project not found or not owned by this session." }, 404);
	}
	if (isNewProject && owner.kind === "guest" && !(await catalog.canStartProject(owner.ownerKey))) {
		return c.json({ error: "Finish claiming your projects before starting another." }, 409);
	}
	if (newGuestToken) {
		c.header(
			"Set-Cookie",
			serializeGuestCookie(newGuestToken, new URL(c.req.url).protocol === "https:"),
		);
	} else if (resolution.staleGuest) {
		c.header("Set-Cookie", clearGuestCookie(new URL(c.req.url).protocol === "https:"));
	}
	c.header("Cache-Control", "no-store");
	return c.json({
		projectId,
		resuming,
		publishingEnabled: publicPublishingEnabled(c.env.ENABLE_PUBLIC_PUBLISHING),
		projects: existingProjects,
		...(sessionAccess.previewUrl ? { previewUrl: sessionAccess.previewUrl } : {}),
		...(sessionAccess.initialMessages ? { initialMessages: sessionAccess.initialMessages } : {}),
	});
});

// Composer dictation. Like the chat, it needs a guest or account session.
app.post("/api/transcribe", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	let resolution;
	try {
		resolution = await resolveOwner(c.req.raw, c.env as AccountAuthEnv);
	} catch {
		return c.json({ error: "Account state unavailable." }, 503);
	}
	if (!resolution.owner) return c.json({ error: "Session required." }, 401);
	return transcribeDictation(c.env.AI, c.req.raw);
});

app.get("/api/projects", async (c) => {
	let resolution;
	try {
		resolution = await resolveOwner(c.req.raw, c.env as AccountAuthEnv);
	} catch {
		return c.json({ error: "Account state unavailable." }, 503);
	}
	if (!resolution.owner) return c.json({ error: "Project session required." }, 401);
	c.header("Cache-Control", "no-store");
	return c.json({
		projects: await c.env.ProjectCatalog.getByName(resolution.owner.ownerKey).listProjects(),
	});
});

app.put("/api/projects/:projectId", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	let resolution;
	try {
		resolution = await resolveOwner(c.req.raw, c.env as AccountAuthEnv);
	} catch {
		return c.json({ error: "Account state unavailable." }, 503);
	}
	if (!resolution.owner) return c.json({ error: "Project session required." }, 401);
	const ownerKey = resolution.owner.ownerKey;
	const projectId = c.req.param("projectId");
	if (!(await c.env.BuilderAgent.getByName(projectId).authorizeProject(ownerKey))) {
		return c.json({ error: "Project not found." }, 404);
	}
	const body: {
		title?: string;
		status?: "building" | "draft" | "live" | "failed";
	} = await c.req
		.json<{ title?: string; status?: "building" | "draft" | "live" | "failed" }>()
		.catch(() => ({}));
	if (
		typeof body.title !== "string" ||
		!body.title.trim() ||
		body.title.length > 200 ||
		!body.status ||
		!["building", "draft", "live", "failed"].includes(body.status)
	) {
		return c.json({ error: "Invalid project update." }, 400);
	}
	const updated = await c.env.ProjectCatalog.getByName(ownerKey).updateProject(ownerKey, {
		id: projectId,
		title: body.title,
		status: body.status,
		updatedAt: Date.now(),
	});
	if (!updated) return c.json({ error: "Project ownership is changing." }, 409);
	return c.json({ ok: true });
});

app.patch("/api/projects/:projectId", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	const projectId = c.req.param("projectId");
	if (!PROJECT_ID.test(projectId)) return c.json({ error: "Invalid project identifier." }, 400);
	let owner;
	try {
		owner = (await resolveOwner(c.req.raw, c.env as AccountAuthEnv)).owner;
	} catch {
		return c.json({ error: "Account state unavailable." }, 503);
	}
	if (!owner || !(await c.env.BuilderAgent.getByName(projectId).authorizeProject(owner.ownerKey))) {
		return c.json({ error: "Project not found." }, 404);
	}
	const body: { title?: unknown } = await c.req.json<{ title?: unknown }>().catch(() => ({}));
	if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200) {
		return c.json({ error: "Invalid site name." }, 400);
	}
	const renamed = await c.env.ProjectCatalog.getByName(owner.ownerKey).renameProject(
		owner.ownerKey,
		projectId,
		body.title.trim(),
	);
	return renamed ? c.json({ ok: true }) : c.json({ error: "Project unavailable." }, 409);
});

app.delete("/api/projects/:projectId", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	const projectId = c.req.param("projectId");
	if (!PROJECT_ID.test(projectId)) return c.json({ error: "Invalid project identifier." }, 400);
	let owner;
	try {
		owner = (await resolveOwner(c.req.raw, c.env as AccountAuthEnv)).owner;
	} catch {
		return c.json({ error: "Account state unavailable." }, 503);
	}
	if (!owner) return c.json({ error: "Project not found." }, 404);
	const catalog = c.env.ProjectCatalog.getByName(owner.ownerKey);
	const reserved = await catalog.beginDeleteProject(owner.ownerKey, projectId);
	if (reserved === "not-found") return c.json({ error: "Project not found." }, 404);
	if (reserved === "busy") return c.json({ error: "Finish connecting your projects first." }, 409);
	try {
		const result = await c.env.BuilderAgent.getByName(projectId).deleteProjectForOwner(
			owner.ownerKey,
		);
		if (result === "busy") {
			await catalog.cancelDeleteProject(owner.ownerKey, projectId);
			return c.json({ error: "Wait for the current build to finish, then delete this site." }, 409);
		}
		if (result === "forbidden") {
			await catalog.cancelDeleteProject(owner.ownerKey, projectId);
			return c.json({ error: "Project not found." }, 404);
		}
		if (result === "retry") {
			return c.json({ error: "Could not finish deleting this site. Retry deletion." }, 503);
		}
		if (!(await catalog.finishDeleteProject(owner.ownerKey, projectId))) {
			return c.json({ error: "Could not finish deleting this site. Retry deletion." }, 503);
		}
		return c.json({ ok: true });
	} catch (error) {
		console.error("[project-delete] cleanup failed", error);
		return c.json({ error: "Could not finish deleting this site. Retry deletion." }, 503);
	}
});

app.post("/api/projects/:projectId/publish", async (c) => {
	if (!publicPublishingEnabled(c.env.ENABLE_PUBLIC_PUBLISHING)) {
		return c.json(PUBLISH_DISABLED, 404);
	}
	if (!isSameOrigin(c.req.raw)) return c.json({ code: "CROSS_ORIGIN_REQUEST" }, 403);
	const projectId = c.req.param("projectId");
	if (!PROJECT_ID.test(projectId)) return c.json({ code: "INVALID_PROJECT_ID" }, 400);
	let resolution;
	try {
		resolution = await resolveOwner(c.req.raw, c.env as AccountAuthEnv);
	} catch {
		return c.json({ code: "ACCOUNT_STATE_UNAVAILABLE" }, 503);
	}
	const owner = resolution.owner;
	if (!owner || owner.kind !== "account") {
		return c.json(
			{
				code: "AUTHENTICATION_REQUIRED",
				message: "Sign in through the configured identity provider before publishing.",
			},
			401,
		);
	}
	const agent = c.env.BuilderAgent.getByName(projectId);
	if (!(await agent.authorizeProject(owner.ownerKey))) {
		return c.json({ code: "PROJECT_NOT_FOUND" }, 404);
	}
	let requestedSlug: string | undefined;
	if (c.req.raw.body) {
		const body = await c.req.json<unknown>().catch(() => null);
		if (
			!body ||
			typeof body !== "object" ||
			!("slug" in body) ||
			typeof body.slug !== "string" ||
			Object.keys(body).length !== 1
		) {
			return c.json({ code: "SLUG_INVALID", message: "Choose a valid site address." }, 400);
		}
		requestedSlug = body.slug;
	}
	const publicationEnv = c.env as Env & PublishBindings;
	if (publicationEnv.SANDBOX_PREVIEW_MODE === "quick-tunnel") {
		return c.json(
			{
				code: "PUBLISH_NOT_CONFIGURED",
				message: "Publishing is available on the production Builder only.",
			},
			503,
		);
	}
	if (
		!publicationEnv.SITES_HOSTNAME ||
		!publicationEnv.WFP_RELEASES ||
		!publicationEnv.ProviderControlPlane ||
		(!publicationEnv.WFP_RUNTIME &&
			(!publicationEnv.WFP_ACCOUNT_ID ||
				!publicationEnv.WFP_API_TOKEN ||
				!publicationEnv.WFP_DISPATCH_NAMESPACE ||
				!publicationEnv.WFP_DISPATCHER))
	) {
		return c.json(
			{
				code: "PUBLISH_NOT_CONFIGURED",
				message: "Publishing is not configured for this EmDash Build deployment.",
			},
			503,
		);
	}
	let result;
	try {
		result = await agent.publishSiteForOwner(
			owner.ownerKey,
			publicationEnv.SITES_HOSTNAME,
			requestedSlug,
		);
	} catch (error) {
		console.error("[project-publish] request failed", error);
		return c.json(
			{
				code: "PUBLISH_FAILED",
				message:
					"Publishing may have completed, but Live could not be confirmed. Retry Publish site to reconcile.",
			},
			503,
		);
	}
	if (result.ok) {
		return c.json({
			status: result.status,
			liveUrl: result.liveUrl,
			releaseId: result.releaseId,
			sourceRevision: result.sourceRevision,
			publishedAt: result.publishedAt,
		});
	}
	const status =
		result.code === "PROJECT_NOT_FOUND"
			? 404
			: result.code === "SLUG_INVALID"
				? 400
				: result.code === "SNAPSHOT_TOO_LARGE"
					? 413
					: result.code === "PUBLISH_NOT_CONFIGURED" ||
						  result.code === "PUBLISH_FAILED" ||
						  result.code === "SLUG_UNAVAILABLE"
						? 503
						: 409;
	return c.json(
		{
			code: result.code,
			message: result.message,
			...(result.reference ? { reference: result.reference } : {}),
		},
		status,
	);
});

app.get("/api/projects/:projectId/publish", async (c) => {
	if (!publicPublishingEnabled(c.env.ENABLE_PUBLIC_PUBLISHING)) {
		return c.json(PUBLISH_DISABLED, 404);
	}
	const projectId = c.req.param("projectId");
	if (!PROJECT_ID.test(projectId)) return c.json({ code: "INVALID_PROJECT_ID" }, 400);
	let resolution;
	try {
		resolution = await resolveOwner(c.req.raw, c.env as AccountAuthEnv);
	} catch {
		return c.json({ code: "ACCOUNT_STATE_UNAVAILABLE" }, 503);
	}
	if (!resolution.owner || resolution.owner.kind !== "account") {
		return c.json({ code: "AUTHENTICATION_REQUIRED" }, 401);
	}
	if (
		!(await c.env.BuilderAgent.getByName(projectId).authorizeProject(resolution.owner.ownerKey))
	) {
		return c.json({ code: "PROJECT_NOT_FOUND" }, 404);
	}
	const brandedHostname = (c.env as Env & PublishBindings).BRANDED_SITES_HOSTNAME;
	if ((c.env as Env & PublishBindings).SANDBOX_PREVIEW_MODE === "quick-tunnel") {
		return c.json({ namedPublishing: false, publishingAvailable: false });
	}
	if (!brandedHostname) return c.json({ namedPublishing: false, publishingAvailable: true });
	try {
		const slug = await publishedSlugForSite(c.env.AUTH_DB, projectId);
		const liveUrl = slug ? `https://${slug}.${brandedHostname}` : undefined;
		const active = Boolean(
			slug &&
			slug === (await activePublishedSlugForSite(c.env.AUTH_DB, projectId)) &&
			liveUrl ===
				(await c.env.BuilderAgent.getByName(projectId).confirmedPublicationUrlForOwner(
					resolution.owner.ownerKey,
				)),
		);
		return c.json({
			namedPublishing: true,
			slug,
			active,
			liveUrl: active ? liveUrl : undefined,
		});
	} catch {
		return c.json({ code: "SLUG_UNAVAILABLE" }, 503);
	}
});

async function authorizeLocalValidation(c: {
	req: { raw: Request; param(name: string): string; url: string };
	env: Env;
}) {
	const url = new URL(c.req.url);
	if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return undefined;
	const owner = (await resolveOwner(c.req.raw, c.env as AccountAuthEnv)).owner;
	if (!owner) return undefined;
	const projectId = c.req.param("projectId");
	return (await c.env.BuilderAgent.getByName(projectId).authorizeProject(owner.ownerKey))
		? c.env.BuilderAgent.getByName(projectId)
		: undefined;
}

app.post("/api/projects/:projectId/validation/provision", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	const agent = await authorizeLocalValidation(c);
	if (!agent) return c.json({ error: "Local project session required." }, 404);
	const result = await agent.provisionPreviewForValidation(new URL(c.req.url).host);
	return c.json(result, result.ready ? 200 : 500);
});

app.post("/api/projects/:projectId/validation/restart", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	const agent = await authorizeLocalValidation(c);
	if (!agent) return c.json({ error: "Local project session required." }, 404);
	const result = await agent.restartPreviewForValidation();
	return c.json(result, result.success ? 200 : 500);
});

app.post("/api/projects/:projectId/validation/capture", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	const agent = await authorizeLocalValidation(c);
	if (!agent) return c.json({ error: "Local project session required." }, 404);
	const result = await agent.capturePreviewForValidation();
	return c.json(result, result.success ? 200 : 500);
});

app.post("/api/projects/:projectId/validation/deactivate-preview", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	const agent = await authorizeLocalValidation(c);
	if (!agent) return c.json({ error: "Local project session required." }, 404);
	return c.json(await agent.deactivatePreviewForValidation());
});

app.post("/api/projects/:projectId/validation/resume-preview", async (c) => {
	if (!isSameOrigin(c.req.raw)) return c.json({ error: "Cross-origin request rejected." }, 403);
	const agent = await authorizeLocalValidation(c);
	if (!agent) return c.json({ error: "Local project session required." }, 404);
	const result = await agent.resumePreview(new URL(c.req.url).host);
	return c.json(result, result.ready ? 200 : 500);
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		// Sandbox preview proxy must be checked first
		const proxyResponse = await proxyToSandbox(request, env);
		if (proxyResponse) {
			// Reconstructing a 101 Response drops its WebSocket. Return upgrades
			// unchanged so Vite HMR can traverse the Sandbox preview proxy.
			if (proxyResponse.webSocket) return proxyResponse;
			// Strip frame-blocking headers so the preview loads in our iframe
			const headers = new Headers(proxyResponse.headers);
			headers.delete("X-Frame-Options");
			headers.delete("Content-Security-Policy");
			enableLocalPreviewEditorSessionCookie(request, headers);
			headers.set("X-EmDash-Proxy", "true");
			return injectPreviewBridge(
				request,
				new Response(proxyResponse.body, {
					status: proxyResponse.status,
					statusText: proxyResponse.statusText,
					headers,
				}),
				env.APP_HOSTNAME,
			);
		}
		const httpsRedirect = httpsRedirectForRequest(request);
		if (httpsRedirect) return Response.redirect(httpsRedirect, 308);

		const url = new URL(request.url);
		const providerEnv = env as Env & {
			SITES_HOSTNAME?: string;
			BRANDED_SITES_HOSTNAME?: string;
			WFP_DISPATCHER?: DispatchNamespace;
			SiteService?: DurableObjectNamespace<SiteService>;
		};
		const siteResponse = await routeProviderSite(request, {
			enabled: publicPublishingEnabled(env.ENABLE_PUBLIC_PUBLISHING),
			sitesHostname: providerEnv.SITES_HOSTNAME,
			brandedSitesHostname: providerEnv.BRANDED_SITES_HOSTNAME,
			slugDatabase: providerEnv.AUTH_DB,
			dispatcher: providerEnv.WFP_DISPATCHER,
			siteCapabilityFor: providerEnv.SiteService
				? (siteId) => ctx.exports.SiteReadCapability({ props: { siteId } })
				: undefined,
		});
		if (siteResponse) return siteResponse;
		const projectId = projectIdFromAgentPath(url.pathname);
		let agentRequest = request;
		if (projectId) {
			if (!isSameOrigin(request)) {
				return Response.json({ error: "Cross-origin request rejected." }, { status: 403 });
			}
			let resolution;
			try {
				resolution = await resolveOwner(request, env as AccountAuthEnv);
			} catch {
				return Response.json({ error: "Account state unavailable." }, { status: 503 });
			}
			const owner = resolution.owner;
			if (!owner) return Response.json({ error: "Project session required." }, { status: 401 });
			const authorization = await env.BuilderAgent.getByName(projectId).authorizeOwner(
				owner.ownerKey,
			);
			if (!authorization.authorized) {
				return Response.json({ error: "Project not found." }, { status: 404 });
			}
			agentRequest = withVerifiedAgentAuth(request, {
				ownerKey: owner.ownerKey,
				kind: owner.kind,
				sessionHash: owner.session?.tokenHash,
				expiresAt: owner.session?.expiresAt,
			});
		}

		// API routes
		if (url.pathname.startsWith("/api/")) {
			return app.fetch(request, env, ctx);
		}

		// Agent WebSocket routing (handles /agents/BuilderAgent/:id)
		const agentResponse = await routeAgentRequest(agentRequest, env);
		if (agentResponse) return agentResponse;

		// Everything else: fall through to static assets / SPA
		return env.ASSETS.fetch(request);
	},
};
