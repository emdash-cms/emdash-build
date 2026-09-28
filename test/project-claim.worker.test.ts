import {
	applyD1Migrations,
	env,
	evictDurableObject,
	reset,
	runInDurableObject,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { beforeEach, describe, expect, it } from "vitest";
import { AccountAuthStore } from "../src/worker/account-auth.js";
import { resolveOwner } from "../src/worker/owner-auth.js";
import { withVerifiedAgentAuth } from "../src/worker/agent-authorization.js";
import type { VerifiedAgentAuth } from "../src/worker/agent-authorization.js";
import type { BuilderAgent } from "../src/worker/agent.js";
import type { ProjectCatalog } from "../src/worker/project-catalog.js";
import {
	createGuestToken,
	hashGuestToken,
	serializeGuestCookie,
} from "../src/worker/project-auth.js";

const testEnv = env as typeof env & {
	AUTH_DB: D1Database;
	TEST_MIGRATIONS: D1Migration[];
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
	ProjectCatalog: DurableObjectNamespace<ProjectCatalog>;
};
const publicationEnv = env as { ENABLE_PUBLIC_PUBLISHING: string };

const project = {
	id: "11111111-1111-4111-8111-111111111111",
	title: "Claim me",
	status: "draft" as const,
	updatedAt: 1,
};

async function createSession(guestOwnerKey: string, subject: string) {
	const auth = new AccountAuthStore(testEnv.AUTH_DB);
	const now = Date.now();
	const attempt = await auth.createLoginAttempt({
		guestOwnerKey,
		returnPath: `/s/${project.id}`,
		now,
	});
	const completed = await auth.completeLogin({
		...attempt,
		principal: { kind: "account", issuer: "https://issuer.test", subject },
		now: now + 1,
	});
	return { auth, ...completed };
}

describe("guest project claiming", () => {
	beforeEach(async () => {
		publicationEnv.ENABLE_PUBLIC_PUBLISHING = "false";
		await reset();
		await applyD1Migrations(testEnv.AUTH_DB, testEnv.TEST_MIGRATIONS);
	});

	it("registers meaningful first turns and enforces the guest quota before mutation", async () => {
		const guestKey = "guest-owner";
		for (let index = 0; index < 10; index++) {
			const agent = testEnv.BuilderAgent.getByName(
				`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			);
			await agent.initializeOwnership(guestKey);
			await runInDurableObject(agent, async (instance) => {
				instance.messages = [
					{ id: `user-${index}`, role: "user", parts: [{ type: "text", text: `Site ${index}` }] },
				];
				await instance.registerProjectForCurrentOwner();
			});
		}
		const overflow = testEnv.BuilderAgent.getByName("00000000-0000-4000-8000-999999999999");
		await overflow.initializeOwnership(guestKey);
		await runInDurableObject(overflow, async (instance) => {
			instance.messages = [
				{ id: "user-overflow", role: "user", parts: [{ type: "text", text: "One more site" }] },
			];
			const response = await instance.onChatMessage(async () => {}, {
				requestId: "guest-quota-overflow",
			});
			expect(await response.text()).toContain("Guest project limit reached");
			expect(await instance.claimOwnership(guestKey, "account:owner")).toBe("claimed");
		});
		expect(await testEnv.ProjectCatalog.getByName(guestKey).listProjects()).toHaveLength(10);
	});

	it("keeps a building project usable after sign-in, then transfers it when idle", async () => {
		const guestToken = createGuestToken();
		const guestKey = await hashGuestToken(guestToken);
		const guestCatalog = testEnv.ProjectCatalog.getByName(guestKey);
		const agent = testEnv.BuilderAgent.getByName(project.id);
		await agent.initializeOwnership(guestKey);
		await runInDurableObject(agent, (instance) => {
			instance.setState({
				...instance.state,
				previewUrl: "https://4321-project-preview.example.test/",
			});
		});
		await guestCatalog.registerProject(guestKey, { ...project, status: "building" }, 10);
		await runInDurableObject(agent, (instance) => {
			instance.messages = [
				{ id: "site-brief", role: "user", parts: [{ type: "text", text: "Build my site" }] },
			];
			instance.setState({ ...instance.state, status: "Building your site..." });
		});
		const { session, token } = await createSession(guestKey, "busy-user");
		const cookie = `${serializeGuestCookie(guestToken, false).split(";", 1)[0]}; emdash_session=${token}`;
		expect(
			(
				await resolveOwner(
					new Request("http://localhost/api/projects", { headers: { Cookie: cookie } }),
					testEnv,
				)
			).owner?.kind,
		).toBe("guest");
		const otherGuestToken = createGuestToken();
		const otherGuestKey = await hashGuestToken(otherGuestToken);
		await testEnv.ProjectCatalog.getByName(otherGuestKey).authorizeActiveGuest(otherGuestKey);
		const mismatchedCookie = `${serializeGuestCookie(otherGuestToken, false).split(";", 1)[0]}; emdash_session=${token}`;
		expect(
			(
				await resolveOwner(
					new Request("http://localhost/api/projects", { headers: { Cookie: mismatchedCookie } }),
					testEnv,
				)
			).owner?.kind,
		).toBe("account");
		const projectSession = await exports.default.fetch(
			new Request("http://localhost/api/project-session", {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json" },
				body: JSON.stringify({ projectId: project.id }),
			}),
		);
		expect(projectSession.status).toBe(200);
		expect(await projectSession.clone().json()).toMatchObject({
			publishingEnabled: false,
			previewUrl: "https://4321-project-preview.example.test/",
			initialMessages: [
				{ id: "site-brief", role: "user", parts: [{ type: "text", text: "Build my site" }] },
			],
		});
		publicationEnv.ENABLE_PUBLIC_PUBLISHING = "true";
		const enabledSession = await exports.default.fetch(
			new Request("http://localhost/api/project-session", {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json" },
				body: JSON.stringify({ projectId: project.id }),
			}),
		);
		expect(await enabledSession.json()).toMatchObject({ publishingEnabled: true });
		const claim = () =>
			exports.default.fetch(
				new Request("http://localhost/api/auth/claim", {
					method: "POST",
					headers: { Cookie: `emdash_session=${token}` },
				}),
			);

		expect(await (await claim()).json()).toEqual({
			status: "waiting",
			message: "Waiting for your site to finish building. It will connect automatically.",
			returnPath: `/s/${project.id}`,
		});
		expect(await agent.authorizeProject(guestKey)).toBe(true);
		expect(await agent.authorizeProject(session.ownerKey)).toBe(false);
		expect(await guestCatalog.authorizeActiveGuest(guestKey)).toBe(true);

		expect(await guestCatalog.updateProject(guestKey, { ...project, status: "failed" })).toBe(
			false,
		);
		await runInDurableObject(agent, (instance) => {
			instance.setState({ ...instance.state, status: "", provisionError: "Setup failed" });
		});
		expect(await (await claim()).json()).toMatchObject({ status: "complete" });
		expect(await testEnv.ProjectCatalog.getByName(session.ownerKey).listProjects()).toMatchObject([
			{ title: "Claim me", status: "failed" },
		]);
		expect(await agent.authorizeProject(session.ownerKey)).toBe(true);
		expect(
			(
				await resolveOwner(
					new Request("http://localhost/api/projects", { headers: { Cookie: cookie } }),
					testEnv,
				)
			).owner?.kind,
		).toBe("account");
	});

	it("finishes durable chat activity when an automatic questionnaire turn is gated", async () => {
		const guestKey = "questionnaire-guest";
		const agent = testEnv.BuilderAgent.getByName("44444444-4444-4444-8444-444444444444");
		await agent.initializeOwnership(guestKey);

		await runInDurableObject(agent, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true, status: "" });
			const lifecycle = instance as unknown as {
				provisionPromise: Promise<{ ready: boolean }> | null;
			};
			lifecycle.provisionPromise = Promise.resolve({ ready: true });
			instance.messages = [
				{
					id: "assistant-questions",
					role: "assistant",
					parts: [
						{
							type: "tool-ask_questions",
							toolCallId: "ask-1",
							state: "output-available",
							input: {
								questions: [{ question: "Which tone?", options: ["Editorial", "Playful"] }],
							},
							output: { ok: true },
						},
					],
				},
			];

			const response = await instance.onChatMessage(async () => {}, {
				requestId: "questionnaire-auto-turn",
			});
			expect(response.body).toBeNull();
			expect(lifecycle.provisionPromise).toBeNull();
			expect(await instance.claimOwnership(guestKey, "account:owner")).toBe("claimed");
		});
	});

	it("treats interrupted top-level activity as busy after eviction", async () => {
		const guestKey = "uncertain-guest";
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-222222222222");
		await agent.initializeOwnership(guestKey);
		await runInDurableObject(agent, (instance) => {
			const activity = instance as unknown as {
				beginOwnerActivity(id: string, kind: string): void;
			};
			activity.beginOwnerActivity("interrupted-chat", "chat");
		});
		await evictDurableObject(agent);

		expect(await agent.claimOwnership(guestKey, "account:owner")).toBe("busy");
		expect(await agent.authorizeProject(guestKey)).toBe(true);
	});

	it("releases activity that nothing resumes once the object restarts", async () => {
		const guestKey = "stale-provision-guest";
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000001");
		await agent.initializeOwnership(guestKey);
		await runInDurableObject(agent, (instance) => {
			const activity = instance as unknown as {
				beginOwnerActivity(id: string, kind: string): void;
			};
			activity.beginOwnerActivity("provision:interrupted", "provision");
		});
		await evictDurableObject(agent);

		expect(await agent.claimOwnership(guestKey, "account:owner")).toBe("claimed");
	});

	it("releases an interrupted chat turn once recovery settles it", async () => {
		const guestKey = "settled-chat-guest";
		const skipped = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000002");
		const superseded = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000003");
		for (const agent of [skipped, superseded]) {
			await agent.initializeOwnership(guestKey);
			await runInDurableObject(agent, (instance) => {
				const activity = instance as unknown as {
					beginOwnerActivity(id: string, kind: string): void;
				};
				activity.beginOwnerActivity("chat:interrupted", "chat");
			});
			await evictDurableObject(agent);
		}

		await runInDurableObject(skipped, async (instance) => {
			const recovery = instance as unknown as {
				onChatRecovery(ctx: object): Promise<unknown>;
			};
			// The reply had finished; eviction hit the post-turn backup.
			await recovery.onChatRecovery({
				requestId: "interrupted",
				recoveryData: { chatTurnFinished: true },
				partialParts: [],
				messages: [],
			});
		});
		expect(await skipped.claimOwnership(guestKey, "account:owner")).toBe("claimed");

		await runInDurableObject(superseded, async (instance) => {
			instance.setState({ ...instance.state, siteReady: true, buildStarted: true, status: "" });
			// The next turn runs alone, so any other chat activity is left over.
			await instance.onChatMessage(async () => {}, { requestId: "next-turn" });
		});
		expect(await superseded.claimOwnership(guestKey, "account:owner")).toBe("claimed");
	});

	it("clears progress left in state by an evicted instance", async () => {
		const guestKey = "stale-status-guest";
		const agent = testEnv.BuilderAgent.getByName("22222222-2222-4222-8222-000000000004");
		await agent.initializeOwnership(guestKey);
		await runInDurableObject(agent, (instance) => {
			instance.setState({
				...instance.state,
				status: "Saving your site...",
				previewRestarting: true,
			});
		});
		await evictDurableObject(agent);

		// Claims arrive by RPC, the first call to reach the new instance.
		expect(await agent.claimOwnership(guestKey, "account:owner")).toBe("claimed");
	});

	it("blocks claiming while validation capture is active", async () => {
		const guestKey = "validation-guest";
		const agent = testEnv.BuilderAgent.getByName("33333333-3333-4333-8333-333333333333");
		await agent.initializeOwnership(guestKey);

		await runInDurableObject(agent, async (instance) => {
			let finishCapture!: () => void;
			const captureFinished = new Promise<void>((resolve) => {
				finishCapture = resolve;
			});
			const validationAgent = instance as unknown as {
				capturePreview: () => Promise<{
					ok: true;
					base64: string;
					mediaType: "image/png";
				}>;
				capturePreviewForValidation: BuilderAgent["capturePreviewForValidation"];
			};
			validationAgent.capturePreview = async () => {
				await captureFinished;
				return { ok: true, base64: "AAAA", mediaType: "image/png" };
			};

			const capture = validationAgent.capturePreviewForValidation();
			expect(await instance.claimOwnership(guestKey, "account:owner")).toBe("busy");
			finishCapture();
			expect(await capture).toEqual({ success: true, bytes: 3 });
		});
	});

	it("reopens an existing guest project after claim reservation", async () => {
		const guestToken = createGuestToken();
		const guestKey = await hashGuestToken(guestToken);
		const catalog = testEnv.ProjectCatalog.getByName(guestKey);
		const agent = testEnv.BuilderAgent.getByName(project.id);
		await agent.initializeOwnership(guestKey);
		await catalog.registerProject(guestKey, project, 10);
		await catalog.beginClaim(guestKey, "account:owner", 100);

		const response = await exports.default.fetch(
			new Request("http://localhost/api/project-session", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: serializeGuestCookie(guestToken, false).split(";", 1)[0]!,
				},
				body: JSON.stringify({}),
			}),
		);
		expect(await response.json()).toMatchObject({ projectId: project.id, resuming: true });
		const createResponse = await exports.default.fetch(
			new Request("http://localhost/api/project-session", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: serializeGuestCookie(guestToken, false).split(";", 1)[0]!,
				},
				body: JSON.stringify({ createNew: true }),
			}),
		);
		expect(createResponse.status).toBe(409);
	});

	it("moves ownership idempotently and rejects stale guest and logged-out connections", async () => {
		const guestKey = "guest-owner";
		const guestCatalog = testEnv.ProjectCatalog.getByName(guestKey);
		const agent = testEnv.BuilderAgent.getByName(project.id);
		await agent.initializeOwnership(guestKey);
		await guestCatalog.registerProject(guestKey, project, 10);
		const { auth, session, token } = await createSession(guestKey, "user-1");

		const claimResponse = await exports.default.fetch(
			new Request("http://localhost/api/auth/claim", {
				method: "POST",
				headers: { Cookie: `emdash_session=${token}` },
			}),
		);
		expect(await claimResponse.json()).toMatchObject({ status: "complete" });
		expect(await agent.authorizeProject(guestKey)).toBe(false);
		expect(await agent.authorizeProject(session.ownerKey)).toBe(true);
		expect(await guestCatalog.listProjects()).toEqual([]);
		expect(await testEnv.ProjectCatalog.getByName(session.ownerKey).listProjects()).toMatchObject([
			{ id: project.id, title: project.title, status: project.status },
		]);

		const openResponse = await exports.default.fetch(
			new Request("http://localhost/api/project-session", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: `emdash_session=${token}` },
				body: JSON.stringify({ projectId: project.id }),
			}),
		);
		expect(openResponse.status).toBe(200);
		const landingResponse = await exports.default.fetch(
			new Request("http://localhost/api/project-session", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: `emdash_session=${token}` },
				body: JSON.stringify({}),
			}),
		);
		expect(await landingResponse.json()).toMatchObject({
			projectId: project.id,
			resuming: true,
		});
		const newProjectResponse = await exports.default.fetch(
			new Request("http://localhost/api/project-session", {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: `emdash_session=${token}` },
				body: JSON.stringify({ createNew: true }),
			}),
		);
		const newProject = await newProjectResponse.json<{ projectId: string; resuming: boolean }>();
		expect(newProject).toMatchObject({ resuming: false });
		expect(newProject.projectId).not.toBe(project.id);

		const stale = await runInDurableObject(agent, async (instance) => {
			const response = await instance.onRequest(
				withVerifiedAgentAuth(new Request(`https://build.test/agents/BuilderAgent/${project.id}`), {
					ownerKey: guestKey,
					kind: "guest",
				}),
			);
			let closeCode: number | undefined;
			const connection = {
				state: { emdashAuth: { ownerKey: guestKey, kind: "guest" as const } },
				close(code?: number) {
					closeCode = code;
				},
			} as unknown as Parameters<BuilderAgent["onMessage"]>[0];
			await instance.onMessage(connection, JSON.stringify({ type: "cf_agent_state", state: {} }));
			return { status: response.status, closeCode };
		});
		expect(stale).toEqual({ status: 404, closeCode: 4404 });

		await auth.revokeSession(token);
		const loggedOutClose = await runInDurableObject(agent, async (instance) => {
			let closeCode: number | undefined;
			const connection = {
				state: {
					emdashAuth: {
						ownerKey: session.ownerKey,
						kind: "account" as const,
						sessionHash: session.tokenHash,
					},
				},
				close(code?: number) {
					closeCode = code;
				},
			} as unknown as Parameters<BuilderAgent["onMessage"]>[0];
			await instance.onMessage(connection, JSON.stringify({ type: "cf_agent_chat_clear" }));
			return closeCode;
		});
		expect(loggedOutClose).toBe(4404);
	});

	it("closes only the revoked session and expires passive account connections", async () => {
		const agent = testEnv.BuilderAgent.getByName("55555555-5555-4555-8555-555555555555");
		const closed = new Map<string, number | undefined>();
		await runInDurableObject(agent, async (instance) => {
			const now = Date.now();
			let active: Array<{
				id: string;
				state: { emdashAuth: VerifiedAgentAuth };
				close: (code?: number) => void;
			}> = [];
			const connection = (
				id: string,
				sessionHash: string,
				expiresAt: number,
			): (typeof active)[number] => ({
				id,
				state: {
					emdashAuth: {
						ownerKey: "account:owner",
						kind: "account",
						sessionHash,
						expiresAt,
					},
				},
				close(code?: number) {
					closed.set(id, code);
					active = active.filter((candidate) => candidate.id !== id);
				},
			});
			active = [
				connection("revoked", "session:revoked", now + 10_000),
				connection("expired", "session:other", now - 1),
				connection("live", "session:other", now + 10_000),
			];
			const security = instance as unknown as {
				getConnections: () => typeof active;
				revokeSessionConnections: (sessionHash: string, expiresAt: number) => Promise<void>;
				closeInvalidAccountConnections: (now: number) => string[];
			};
			security.getConnections = () => active;

			await security.revokeSessionConnections("session:revoked", now + 10_000);
			active.push(connection("reconnect", "session:revoked", now + 10_000));
			expect(security.closeInvalidAccountConnections(now)).toEqual(["expired", "reconnect"]);
		});

		expect(closed).toEqual(
			new Map<string, number | undefined>([
				["revoked", 4404],
				["expired", 4404],
				["reconnect", 4404],
			]),
		);
	});
});

describe("project session creation", () => {
	beforeEach(async () => {
		await reset();
		await applyD1Migrations(testEnv.AUTH_DB, testEnv.TEST_MIGRATIONS);
	});

	it("reuses a client-minted project id after an ambiguous creation response", async () => {
		const createProjectId = "33333333-3333-4333-8333-333333333333";
		const creationToken = "ab".repeat(32);
		const request = (cookie?: string) =>
			exports.default.fetch(
				new Request("http://localhost/api/project-session", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(cookie ? { Cookie: cookie } : {}),
					},
					body: JSON.stringify({ createProjectId, creationToken }),
				}),
			);

		const first = await request();
		expect(first.status).toBe(200);
		expect(await first.clone().json()).toMatchObject({ projectId: createProjectId });
		const setCookie = first.headers.get("Set-Cookie");
		expect(setCookie).not.toContain(creationToken);
		const cookie = setCookie?.split(";", 1)[0];
		expect(cookie).toBeTruthy();

		const retry = await request();
		expect(retry.status).toBe(200);
		expect(await retry.json()).toMatchObject({ projectId: createProjectId });
	});
});
