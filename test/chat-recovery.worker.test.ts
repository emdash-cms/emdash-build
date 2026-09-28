import { env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRecoveryContext, ChatRecoveryOptions } from "@cloudflare/ai-chat";
import type { UIMessage } from "ai";
import type { BuilderAgent } from "../src/worker/agent.js";
import { markChatTurnFinished } from "../src/worker/turn-gate.js";
import { TurnMetrics } from "../src/worker/turn-metrics.js";

const testEnv = env as typeof env & {
	BuilderAgent: DurableObjectNamespace<BuilderAgent>;
};

interface RecoveryHarness {
	onChatRecovery(ctx: Partial<ChatRecoveryContext>): Promise<ChatRecoveryOptions>;
	restartInterruptedTurn(payload: {
		afterMessageId: string | null;
		pastGate?: boolean;
	}): Promise<void>;
	restartingInterruptedTurn: boolean;
	saveMessages(update: (messages: UIMessage[]) => UIMessage[]): Promise<unknown>;
	registerProjectForCurrentOwner(): Promise<void>;
	waitUntilStable(options: { timeout: number }): Promise<boolean>;
}

describe("chat recovery", () => {
	beforeEach(async () => {
		await reset();
	});

	it("checkpoints a finished reply from the stream's finish callback", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000003");
		await runInDurableObject(agent, async (instance) => {
			let snapshot: string | null = null;
			await instance.runFiber("__cf_internal_chat_turn:req-1", async () => {
				// streamText runs onFinish in a transform flush while the reply is read.
				const reply = new ReadableStream({
					start(controller) {
						controller.enqueue("done");
						controller.close();
					},
				}).pipeThrough(
					new TransformStream({
						flush: async () => {
							await Promise.resolve();
							markChatTurnFinished(instance);
						},
					}),
				);
				for await (const _chunk of reply) {
					// drain
				}
				snapshot = instance.sql<{ snapshot: string | null }>`
					SELECT snapshot FROM cf_agents_runs WHERE name = ${"__cf_internal_chat_turn:req-1"}
				`[0]!.snapshot;
			});

			const harness = instance as unknown as RecoveryHarness;
			expect(
				await harness.onChatRecovery({ recoveryData: JSON.parse(snapshot!), partialParts: [] }),
			).toEqual({ continue: false });
			expect(
				await harness.onChatRecovery({
					recoveryData: null,
					partialParts: [{ type: "text", text: "Building" }],
				}),
			).toEqual({});
		});
	});

	it("records a finished turn once, even when eviction interrupts its final save", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-00000000000b");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveryHarness & {
				backupSite(): Promise<string | undefined>;
				saveAndRecordTurn(metrics: TurnMetrics): Promise<void>;
			};
			const logged: Array<{ turnId: string; outcome: string; finalSaveMs: number | null }> = [];
			const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
				if (typeof line === "string" && line.includes('"builder.turn_metrics"')) {
					logged.push(JSON.parse(line));
				}
			});
			const newTurn = (turnId: string) => {
				const metrics = new TurnMetrics({
					turnId,
					kind: "follow-up",
					resumed: false,
					model: "test-model",
					stepCap: 256,
				});
				metrics.modelFinished("stop");
				return metrics;
			};
			const stashOf = async (turnId: string, run: () => Promise<void>) => {
				const fiber = `__cf_internal_chat_turn:${turnId}`;
				let snapshot: string | null = null;
				await instance.runFiber(fiber, async () => {
					await run().catch(() => {});
					snapshot = instance.sql<{ snapshot: string | null }>`
						SELECT snapshot FROM cf_agents_runs WHERE name = ${fiber}
					`[0]!.snapshot;
				});
				return JSON.parse(snapshot!);
			};

			try {
				// Evicted during the backup: only the stash survives, and recovery logs
				// it without writing state (onStart still resets stale progress).
				const evicted = newTurn("req-evicted");
				const stash = await stashOf("req-evicted", async () => {
					markChatTurnFinished(instance, evicted.pendingRecord());
				});
				expect(await harness.onChatRecovery({ recoveryData: stash, partialParts: [] })).toEqual({
					continue: false,
				});
				expect(logged).toMatchObject([
					{ turnId: "req-evicted", outcome: "finished", finalSaveMs: null },
				]);
				expect(instance.state.lastTurnMetrics).toBeUndefined();

				// Recorded after a failed backup; the stash no longer carries a copy.
				harness.backupSite = async () => "git push failed";
				const saved = newTurn("req-saved");
				const cleared = await stashOf("req-saved", async () => {
					markChatTurnFinished(instance, saved.pendingRecord());
					await harness.saveAndRecordTurn(saved);
				});
				expect(instance.state.lastTurnMetrics).toMatchObject({
					turnId: "req-saved",
					outcome: "error",
					error: "Session backup failed: git push failed",
					finalSaveMs: expect.any(Number),
				});
				expect(cleared).toEqual({ chatTurnFinished: true });
				await harness.onChatRecovery({ recoveryData: cleared, partialParts: [] });
				expect(logged.map((record) => record.turnId)).toEqual(["req-evicted", "req-saved"]);
			} finally {
				log.mockRestore();
			}
		});
	});

	it("does not wait on a server tool orphaned by eviction", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000004");
		await runInDurableObject(agent, async (instance) => {
			instance.messages = [
				{ id: "user-1", role: "user", parts: [{ type: "text", text: "Build a bakery site" }] },
				{
					id: "assistant-1",
					role: "assistant",
					parts: [
						{
							type: "tool-write_file",
							toolCallId: "write-1",
							state: "input-available",
							input: { path: "src/pages/index.astro", content: "" },
						},
					],
				},
			];

			const harness = instance as unknown as RecoveryHarness;
			expect(await harness.waitUntilStable({ timeout: 50 })).toBe(true);
		});
	});

	it("restarts a turn evicted before it streamed as a fresh reply", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000007");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveryHarness;

			const messages: UIMessage[] = [
				{ id: "user-1", role: "user", parts: [{ type: "text", text: "Build a bakery site" }] },
			];

			expect(
				await harness.onChatRecovery({
					recoveryData: { chatTurnStarted: true },
					partialParts: [],
					messages,
				}),
			).toEqual({ continue: false });
			expect(
				instance.getSchedules().map(({ callback, payload }) => ({ callback, payload })),
			).toEqual([
				{
					callback: "restartInterruptedTurn",
					payload: { afterMessageId: "user-1", pastGate: true },
				},
			]);
		});
	});

	it("re-gates a turn evicted before it passed the gate", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000009");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveryHarness;
			const reply: UIMessage = {
				id: "assistant-build",
				role: "assistant",
				parts: [{ type: "text", text: "Built the site" }],
			};
			await harness.onChatRecovery({ recoveryData: null, partialParts: [], messages: [reply] });
			expect(instance.getSchedules().map(({ payload }) => payload)).toEqual([
				{ afterMessageId: "assistant-build", pastGate: false },
			]);

			let restarting: boolean | undefined;
			instance.messages = [reply];
			harness.saveMessages = async (update) => {
				update([reply]);
				restarting = harness.restartingInterruptedTurn;
			};
			await harness.restartInterruptedTurn({ afterMessageId: "assistant-build", pastGate: false });
			expect(restarting).toBe(false);
		});
	});

	it("marks a resumed turn as past the gate before it does anything else", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-00000000000a");
		await agent.initializeOwnership("recovery-guest");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveryHarness;
			harness.registerProjectForCurrentOwner = async () => {
				throw new Error("evicted mid-call");
			};
			harness.restartingInterruptedTurn = true;
			const fiber = "__cf_internal_chat_turn:req-resume";
			await instance.runFiber(fiber, async () => {
				await instance.onChatMessage(async () => {}, { requestId: "req-resume" });
				const snapshot = instance.sql<{ snapshot: string | null }>`
					SELECT snapshot FROM cf_agents_runs WHERE name = ${fiber}
				`[0]!.snapshot;
				expect(JSON.parse(snapshot!)).toEqual({ chatTurnStarted: true });
			});
		});
	});

	it("resumes a restarted turn only while the conversation is where it stopped", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000008");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as RecoveryHarness;
			const user: UIMessage = { id: "user-1", role: "user", parts: [{ type: "text", text: "Hi" }] };
			const later: UIMessage = {
				id: "assistant-2",
				role: "assistant",
				parts: [{ type: "text", text: "Answered a newer message" }],
			};
			const observed: boolean[] = [];
			const restartWith = async (current: UIMessage[], atTurnStart: UIMessage[]) => {
				instance.messages = current;
				harness.saveMessages = async (update) => {
					update(atTurnStart);
					observed.push(harness.restartingInterruptedTurn);
				};
				await harness.restartInterruptedTurn({ afterMessageId: "user-1", pastGate: true });
			};

			await restartWith([user], [user]);
			// A newer turn got in between enqueueing and running.
			await restartWith([user], [user, later]);
			// Already superseded: nothing is enqueued.
			await restartWith([user, later], [user, later]);

			expect(observed).toEqual([true, false]);
			expect(harness.restartingInterruptedTurn).toBe(false);
		});
	});
});
