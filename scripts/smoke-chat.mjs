import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { auditPublicSite } from "../src/worker/public-site-audit.ts";
import { auditFreshBrowser } from "./smoke-browser.mjs";
import {
	askedQuestions,
	auditUrl,
	containsText,
	followUpFailure,
	hasStoryLinkOnSection,
	questionsPending,
	replyPersisted,
	selectBrief,
	storyMovedBetweenSections,
	summarizeTurns,
	visibleText,
} from "./smoke-turns.mjs";

const REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function userMessage(text) {
	return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
}

/**
 * Audit the public routes, rendered live for this round. Reports cached
 * responses (there should be none) and the pages whose visible text contains
 * `expect`.
 */
async function auditPreview(previewUrl, round, expect, requestSignal, storyMove) {
	let cacheHits = 0;
	const expectFoundOn = [];
	const storyLinksByPath = {};
	const audit = await auditPublicSite(async (path) => {
		const response = await fetch(auditUrl(previewUrl, path, round), {
			headers: { Accept: "text/html" },
			redirect: "manual",
			signal: requestSignal(15_000),
		});
		if (response.headers.has("X-EmDash-Preview-Cache")) cacheHits += 1;
		if (
			response.ok &&
			response.headers.get("content-type")?.includes("text/html") &&
			(expect || path === storyMove?.from || path === storyMove?.to)
		) {
			const html = await response.clone().text();
			if (expect && containsText(visibleText(html), expect)) expectFoundOn.push(path);
			if (path === storyMove?.from || path === storyMove?.to) {
				storyLinksByPath[path] = hasStoryLinkOnSection(html, storyMove.storyPath);
			}
		}
		return response;
	});
	return {
		...audit,
		cacheHits,
		...(expect ? { expectFoundOn } : {}),
		...(storyMove ? { storyLinksByPath } : {}),
	};
}

async function run(env) {
	const baseUrl = new URL(env.EMDASH_SMOKE_URL ?? "http://localhost:5173");
	const requireQuestionnaire = env.EMDASH_SMOKE_REQUIRE_QUESTIONNAIRE === "1";
	const browserAuditEnabled = env.EMDASH_SMOKE_BROWSER === "1";
	const timeoutMs = Number(env.EMDASH_SMOKE_TIMEOUT_MS ?? 12 * 60 * 1000);
	// Node fires timers above 2^31-1 ms (or Infinity) almost immediately.
	if (!(timeoutMs > 0 && timeoutMs <= 2_147_483_647)) {
		throw new Error("EMDASH_SMOKE_TIMEOUT_MS must be a positive number of milliseconds.");
	}
	const brief = selectBrief(
		JSON.parse(readFileSync(new URL("./smoke-briefs.json", import.meta.url), "utf8")),
		env,
	);

	// Ends the run at the deadline and cancels every request still in flight.
	const stop = new AbortController();
	const deadline = setTimeout(
		() => stop.abort(new Error(`Chat smoke timed out after ${timeoutMs}ms.`)),
		timeoutMs,
	);
	const requestSignal = (ms = REQUEST_TIMEOUT_MS) =>
		AbortSignal.any([stop.signal, AbortSignal.timeout(ms)]);
	try {
		return await chat({
			baseUrl,
			brief,
			requireQuestionnaire,
			browserAuditEnabled,
			stop,
			requestSignal,
		});
	} finally {
		clearTimeout(deadline);
		stop.abort();
	}
}

async function chat({
	baseUrl,
	brief,
	requireQuestionnaire,
	browserAuditEnabled,
	stop,
	requestSignal,
}) {
	const sessionResponse = await fetch(new URL("/api/project-session", baseUrl), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
		signal: requestSignal(),
	});
	if (!sessionResponse.ok) throw new Error(`Project session failed: ${sessionResponse.status}`);
	const session = await sessionResponse.json();
	const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
	if (!cookie || typeof session.projectId !== "string") {
		throw new Error("Project session was incomplete.");
	}

	const agentPath = `/agents/builder-agent/${session.projectId}`;
	const socketUrl = new URL(agentPath, baseUrl);
	socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
	const socket = new WebSocket(socketUrl, { headers: { Cookie: cookie } });

	function sendChat(id, messages) {
		socket.send(
			JSON.stringify({
				type: "cf_agent_use_chat_request",
				id,
				init: {
					method: "POST",
					body: JSON.stringify({ messages, trigger: "submit-message", appHost: baseUrl.host }),
				},
			}),
		);
	}

	async function storedMessages(timeoutMs) {
		const response = await fetch(new URL(`${agentPath}/get-messages`, baseUrl), {
			headers: { Cookie: cookie },
			signal: requestSignal(timeoutMs),
		});
		if (!response.ok) throw new Error(`Reading messages failed: ${response.status}`);
		return response.json();
	}

	return new Promise((resolve) => {
		const turns = new Map();
		let latestState;
		let reportedMilestones = 0;
		let questionnaireAnswered = false;
		let questionnaireObserved = false;
		let messagesAtBuildStart;
		let followUpId;
		let firstBuild;
		// building → auditing → following-up → done
		let phase = "building";

		const report = (value) => ({
			brief: brief.id,
			projectId: session.projectId,
			questionnaireObserved,
			...value,
			turns: [...turns.values()],
			totals: summarizeTurns([...turns.values()]),
		});
		const finish = (value) => {
			if (phase === "done") return;
			phase = "done";
			socket.terminate();
			resolve(report(value));
		};
		const fail = (reason) => finish({ ...firstBuild, ok: false, reason, state: latestState });
		const onStop = () => fail(stop.signal.reason?.message ?? "The smoke run was stopped.");
		if (stop.signal.aborted) onStop();
		stop.signal.addEventListener("abort", onStop, { once: true });

		function answerQuestions(messages) {
			if (questionnaireAnswered || !questionsPending(messages)) return;
			questionnaireObserved = true;
			questionnaireAnswered = true;
			sendChat(`smoke-answer-${Date.now()}`, [...messages, userMessage(brief.answer)]);
		}

		// The SDK doesn't echo a connection's own turns back to it as
		// cf_agent_chat_messages, so read the saved history instead. The reply
		// can be saved just after its turn record, so retry briefly.
		async function answerSavedQuestions() {
			const deadline = Date.now() + 15_000;
			while (!questionnaireAnswered && phase !== "done" && Date.now() < deadline) {
				try {
					answerQuestions(await storedMessages(Math.max(1, deadline - Date.now())));
				} catch (error) {
					if (stop.signal.aborted) throw error;
				}
				if (!questionnaireAnswered) await sleep(1_000);
			}
			if (!questionnaireAnswered && phase !== "done") {
				throw new Error(
					"The interview asked questions, but they were not saved within 15 seconds.",
				);
			}
		}

		async function waitForReply(countBefore) {
			const replyDeadline = Date.now() + 60_000;
			while (Date.now() < replyDeadline && phase !== "done") {
				const messages = await storedMessages();
				if (replyPersisted(messages, countBefore)) return messages;
				await sleep(1_000);
			}
			throw new Error("The build reply was not saved within 60 seconds.");
		}

		function firstBuildFailure(state, turn, publicSiteAudit, browserAudit) {
			if (turn.outcome !== "finished") {
				return `The first build turn ended as ${turn.outcome}${turn.error ? `: ${turn.error}` : ""}.`;
			}
			if (state.initialBuildBenchmark?.qualityValid !== true) {
				return "The first build did not pass the build quality check.";
			}
			if (requireQuestionnaire && !questionnaireObserved) {
				return "The agent built without asking its interview questions.";
			}
			if (!publicSiteAudit.success) return "The public site audit failed after the first build.";
			if (browserAudit && !browserAudit.success) return browserAudit.error;
			if (
				brief.followUpStoryMove &&
				publicSiteAudit.storyLinksByPath?.[brief.followUpStoryMove.from] !== true
			) {
				return "The first build did not put the requested story in its original section.";
			}
			return undefined;
		}

		async function completeFirstBuild(state, turn) {
			const previewUrl = state.previewUrl;
			const publicSiteAudit = await auditPreview(
				previewUrl,
				1,
				brief.followUpExpect,
				requestSignal,
				brief.followUpStoryMove,
			);
			const browserAudit =
				browserAuditEnabled && publicSiteAudit.success
					? await auditFreshBrowser(previewUrl, publicSiteAudit.checkedPaths, baseUrl.origin)
					: undefined;
			const startedAt = state.milestones?.containerStarting;
			const reason = firstBuildFailure(state, turn, publicSiteAudit, browserAudit);
			firstBuild = {
				ok: !reason,
				...(reason ? { reason } : {}),
				previewUrl,
				readiness: {
					previewReady: state.previewReady,
					cmsReady: state.cmsReady,
					agentToolsReady: state.agentToolsReady,
					personalized: state.personalized,
					complete: state.complete,
				},
				elapsedMs: Object.fromEntries(
					Object.entries(state.milestones ?? {}).map(([key, at]) => [
						key,
						typeof startedAt === "number" && typeof at === "number" ? at - startedAt : null,
					]),
				),
				initialBuildBenchmark: state.initialBuildBenchmark,
				publicSiteAudit,
				...(browserAudit ? { browserAudit } : {}),
			};
			if (
				!brief.followUp ||
				browserAudit?.success === false ||
				(reason && brief.followUpStoryMove)
			) {
				finish({ ...firstBuild, followUp: null });
				return;
			}
			const countBefore = await messagesAtBuildStart;
			if (countBefore === undefined) {
				fail("Could not read the message history when the build started.");
				return;
			}
			const messages = await waitForReply(countBefore);
			if (phase === "done") return;
			followUpId = `smoke-follow-up-${Date.now()}`;
			phase = "following-up";
			console.error("smoke: follow-up");
			sendChat(followUpId, [...messages, userMessage(brief.followUp)]);
		}

		async function completeFollowUp(state, turn) {
			const audit = await auditPreview(
				state.previewUrl,
				2,
				brief.followUpExpect,
				requestSignal,
				brief.followUpStoryMove,
			);
			const storyMove = brief.followUpStoryMove;
			const publicSiteAudit = storyMove
				? {
						...audit,
						storyMoved: storyMovedBetweenSections(audit.storyLinksByPath, storyMove),
					}
				: audit;
			const browserAudit =
				browserAuditEnabled && publicSiteAudit.success
					? await auditFreshBrowser(state.previewUrl, publicSiteAudit.checkedPaths, baseUrl.origin)
					: undefined;
			// null: the text was already on the site before the edit, so it proves nothing.
			const landed = !brief.followUpExpect
				? undefined
				: firstBuild.publicSiteAudit.expectFoundOn.length > 0
					? null
					: publicSiteAudit.expectFoundOn.length > 0 && publicSiteAudit.storyMoved !== false;
			const reason =
				firstBuild.reason ??
				followUpFailure(turn, publicSiteAudit, landed, brief.followUpExpect) ??
				(browserAudit?.success === false ? browserAudit.error : undefined);
			finish({
				...firstBuild,
				ok: !reason,
				...(reason ? { reason } : {}),
				followUp: {
					prompt: brief.followUp,
					outcome: turn.outcome,
					landed,
					publicSiteAudit,
					...(browserAudit ? { browserAudit } : {}),
				},
			});
		}

		socket.addEventListener("error", (event) => {
			fail(`The agent WebSocket failed: ${event.message || event.error?.message || "unknown"}.`);
		});
		// Includes a server restart mid-turn: recovery runs without this client.
		socket.addEventListener("close", (event) => {
			fail(`The agent WebSocket closed (code ${event.code}).`);
		});
		socket.addEventListener("message", async (event) => {
			let message;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (message.type === "console" && /^Setup attempt \d+:/.test(message.text)) {
				console.error(`smoke: ${message.text}`);
			}
			if (message.type === "cf_agent_chat_messages") {
				answerQuestions(Array.isArray(message.messages) ? message.messages : []);
				return;
			}
			if (message.type !== "cf_agent_state" || phase === "done") return;
			latestState = message.state;
			const milestones = Object.keys(latestState?.milestones ?? {});
			if (milestones.length > reportedMilestones) {
				reportedMilestones = milestones.length;
				console.error(`smoke: ${milestones.at(-1)}`);
			}
			if (latestState?.milestones?.buildStarting && !messagesAtBuildStart) {
				messagesAtBuildStart = storedMessages().then(
					(messages) => messages.length,
					() => undefined,
				);
			}
			if (latestState?.provisionError) {
				fail(`Provisioning failed: ${latestState.provisionError}`);
				return;
			}
			const turn = latestState?.lastTurnMetrics;
			if (!turn || turns.has(turn.turnId)) return;
			turns.set(turn.turnId, turn);
			console.error(`smoke: ${turn.kind} turn ${turn.outcome} in ${turn.wallMs}ms`);
			try {
				if (askedQuestions(turn)) {
					await answerSavedQuestions();
				} else if (phase === "building" && turn.kind === "initial-build") {
					if (
						!latestState.complete ||
						!latestState.initialBuildBenchmark ||
						!latestState.previewUrl
					) {
						fail(`The first build ended (${turn.outcome}) without completing.`);
						return;
					}
					phase = "auditing";
					await completeFirstBuild(latestState, turn);
				} else if (phase === "following-up" && turn.turnId === followUpId) {
					phase = "auditing";
					await completeFollowUp(latestState, turn);
				}
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
		});
		socket.addEventListener("open", () => {
			sendChat(`smoke-${Date.now()}`, [userMessage(brief.prompt)]);
		});
	});
}

let result;
try {
	result = await run(process.env);
} catch (error) {
	result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
}
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
