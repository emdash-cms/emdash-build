import { describe, expect, it, vi } from "vitest";
import {
	BuildConvergence,
	canCompleteBuild,
	mutationKey,
	prepareBuildStep,
	promoteLatestPreviewImage,
	prunePreviewImages,
	releaseStepPreviewImages,
	type MutationScope,
} from "../src/worker/build-convergence.js";

function recordCompleteEvidence(convergence: BuildConvergence) {
	const observation = convergence.beginObservation();
	expect(observation).toBeDefined();
	convergence.recordPreviewCapture(observation!);
	convergence.recordValidation(observation!, { success: true });
	convergence.recordPreviewDelivery(observation!.revision);
}

describe("build convergence evidence", () => {
	it("uses stable keys to reuse an exact successful mutation", () => {
		const firstKey = mutationKey("settings_update", { theme: "dark", nested: { b: 2, a: 1 } });
		const secondKey = mutationKey("settings_update", { nested: { a: 1, b: 2 }, theme: "dark" });
		const convergence = new BuildConvergence();

		expect(firstKey).toBe(secondKey);
		convergence.recordMutationResult(firstKey, { success: true });
		expect(convergence.cachedMutationResult(secondKey)).toEqual({
			hit: true,
			value: { success: true },
		});

		const finishOtherMutation = convergence.beginMutation();
		finishOtherMutation();
		expect(convergence.cachedMutationResult(firstKey)).toEqual({ hit: false });
	});

	it("does not cache a result from an older parallel mutation revision", () => {
		const convergence = new BuildConvergence();
		const darkKey = mutationKey("settings_update", { theme: "dark" });
		const lightKey = mutationKey("settings_update", { theme: "light" });
		const finishDark = convergence.beginMutation();
		const darkRevision = convergence.currentRevision();
		const finishLight = convergence.beginMutation();
		const lightRevision = convergence.currentRevision();

		expect(convergence.recordMutationResult(darkKey, { success: true }, darkRevision)).toBe(false);
		finishDark();
		expect(convergence.recordMutationResult(lightKey, { success: true }, lightRevision)).toBe(true);
		finishLight();

		expect(convergence.cachedMutationResult(darkKey)).toEqual({ hit: false });
		expect(convergence.cachedMutationResult(lightKey)).toEqual({
			hit: true,
			value: { success: true },
		});
	});

	it("single-flights identical concurrent mutations", async () => {
		const convergence = new BuildConvergence();
		const key = mutationKey("settings_update", { theme: "dark" });
		let calls = 0;
		let release!: () => void;
		const operation = async () => {
			calls += 1;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: true, theme: "dark" };
		};

		const first = convergence.runMutation(operation, { key });
		const second = convergence.runMutation(operation, { key });
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(calls).toBe(1);
		release();

		await expect(Promise.all([first, second])).resolves.toEqual([
			{ success: true, theme: "dark" },
			{ success: true, theme: "dark", cached: true, changed: false },
		]);
		expect(calls).toBe(1);
		expect(convergence.currentRevision()).toBe(1);
	});

	it("does not cache partial batch success", async () => {
		const convergence = new BuildConvergence();
		const key = mutationKey("upload_media", { images: ["one", "two"] });
		let calls = 0;
		const operation = async () => {
			calls += 1;
			return { success: true, uploaded: 1, count: 2 };
		};

		await convergence.runMutation(operation, {
			key,
			cacheResult: (result) => result.uploaded === result.count,
		});
		await convergence.runMutation(operation, {
			key,
			cacheResult: (result) => result.uploaded === result.count,
		});

		expect(calls).toBe(2);
	});

	it("orders a fast cache probe after earlier queued mutations", async () => {
		const convergence = new BuildConvergence();
		const batchKey = mutationKey("create_entries_batch", { entries: ["one"] });
		convergence.recordMutationResult(batchKey, { success: true });
		let release!: () => void;
		const earlierMutation = convergence.runMutation(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { success: true };
		});
		const probe = convergence.reusedMutationResultQueued(batchKey);
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		release();
		await earlierMutation;

		await expect(probe).resolves.toEqual({ hit: false });
	});

	it("accepts validation followed by a delivered preview for one stable revision", () => {
		const convergence = new BuildConvergence();

		recordCompleteEvidence(convergence);

		expect(convergence.hasCurrentValidation()).toBe(true);
		expect(convergence.hasCurrentPreviewDelivery()).toBe(true);
		expect(convergence.hasCompleteEvidence()).toBe(true);
	});

	it("does not accept preview delivery before validation without a later acknowledgement", () => {
		const convergence = new BuildConvergence();
		const observation = convergence.beginObservation()!;
		convergence.recordPreviewCapture(observation);
		convergence.recordPreviewDelivery(observation.revision);
		convergence.recordValidation(observation, { success: true });

		expect(convergence.hasCompleteEvidence()).toBe(false);

		convergence.recordPreviewDelivery(observation.revision);
		expect(convergence.hasCompleteEvidence()).toBe(true);
	});

	it("invalidates cached evidence as soon as a mutation begins", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);

		const finishMutation = convergence.beginMutation();

		expect(convergence.currentValidation()).toBeUndefined();
		expect(convergence.hasCurrentPreviewCapture()).toBe(false);
		expect(convergence.hasCompleteEvidence()).toBe(false);

		finishMutation();
		expect(convergence.beginObservation()).toEqual({ revision: 1 });
		expect(convergence.hasCompleteEvidence()).toBe(false);
	});

	it("rejects a check that started before an overlapping mutation", () => {
		const convergence = new BuildConvergence();
		const observation = convergence.beginObservation()!;

		const finishMutation = convergence.beginMutation();
		expect(convergence.recordValidation(observation, { success: true })).toBe(false);
		finishMutation();
		expect(convergence.hasCurrentValidation()).toBe(false);
	});

	it("does not start a check while a mutation is already in flight", () => {
		const convergence = new BuildConvergence();
		const finishMutation = convergence.beginMutation();

		expect(convergence.beginObservation()).toBeUndefined();

		finishMutation();
		expect(convergence.beginObservation()).toEqual({ revision: 1 });
	});

	it("makes mutation completion idempotent", () => {
		const convergence = new BuildConvergence();
		const finishMutation = convergence.beginMutation();

		finishMutation();
		finishMutation();

		expect(convergence.beginObservation()).toEqual({ revision: 1 });
	});
});

describe("build loop convergence", () => {
	it("allows one critique step after complete evidence, then forces prose", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);

		convergence.finishStep({});
		expect(convergence.shouldForceText()).toBe(false);

		convergence.finishStep({});
		expect(convergence.shouldForceText()).toBe(true);
	});

	it("allows one failed repair step but converges after a second unchanged failure", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);
		convergence.finishStep({});

		convergence.finishStep({ toolResults: [{ output: { success: false } }] });
		expect(convergence.shouldForceText()).toBe(false);

		convergence.finishStep({ toolResults: [{ output: { success: false } }] });
		expect(convergence.shouldForceText()).toBe(true);
	});

	it("treats AI SDK tool-error content as a failed repair step", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);
		convergence.finishStep({});

		convergence.finishStep({ content: [{ type: "tool-error" }] });
		expect(convergence.shouldForceText()).toBe(false);

		convergence.finishStep({ content: [{ type: "tool-error" }] });
		expect(convergence.shouldForceText()).toBe(true);
	});

	it("reopens the full loop after a mutation", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);
		convergence.finishStep({});
		convergence.finishStep({});
		expect(convergence.shouldForceText()).toBe(true);

		const finishMutation = convergence.beginMutation();
		finishMutation();

		expect(convergence.shouldForceText()).toBe(false);
		expect(convergence.hasCompleteEvidence()).toBe(false);
	});

	it("carries the failure fuse across an unsuccessful mutation attempt", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);
		convergence.finishStep({});

		const finishMutation = convergence.beginMutation();
		finishMutation(false);
		recordCompleteEvidence(convergence);
		convergence.finishStep({});

		convergence.finishStep({ toolResults: [{ output: { success: false } }] });
		expect(convergence.shouldForceText()).toBe(true);
	});

	it("bounds repeated failed mutations across revalidated revisions", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);
		convergence.finishStep({});

		const finishFirstMutation = convergence.beginMutation();
		finishFirstMutation(false);
		convergence.finishStep({ toolResults: [{ output: { success: false } }] });
		recordCompleteEvidence(convergence);
		convergence.finishStep({});
		expect(convergence.shouldForceText()).toBe(false);

		const finishSecondMutation = convergence.beginMutation();
		finishSecondMutation(false);
		convergence.finishStep({ toolResults: [{ output: { success: false } }] });
		recordCompleteEvidence(convergence);
		convergence.finishStep({});

		expect(convergence.shouldForceText()).toBe(true);
	});

	it("ends incomplete after two mandatory final-preview failures", () => {
		const convergence = new BuildConvergence();
		const observation = convergence.beginObservation()!;
		convergence.recordValidation(observation, { success: true });
		const failedPreview = {
			toolResults: [{ toolName: "view_preview", output: { success: false } }],
		};

		convergence.finishStep(failedPreview);
		expect(convergence.shouldForceText()).toBe(false);
		expect(
			prepareBuildStep(convergence, [] as never, ["view_preview", "write_file"]).allowedTools,
		).toEqual({ toolNames: ["view_preview"], mode: "required" });

		convergence.finishStep(failedPreview);
		expect(convergence.shouldForceText()).toBe(true);
		const textOnly = prepareBuildStep(convergence, [] as never, ["view_preview", "write_file"]);
		expect(textOnly.toolChoice).toBe("none");
		expect(textOnly.allowedTools).toBeUndefined();
		expect(canCompleteBuild(convergence, "stop")).toBe(false);
	});

	it("requires the final preview once validation is current", () => {
		const convergence = new BuildConvergence();
		const observation = convergence.beginObservation()!;
		convergence.recordValidation(observation, { success: true });

		const prepared = prepareBuildStep(convergence, [] as never, [
			"exec",
			"write_file",
			"view_preview",
		]);

		expect(prepared.allowedTools).toEqual({ toolNames: ["view_preview"], mode: "required" });
		expect(prepared.toolChoice).toBeUndefined();
	});

	it("removes shell access while validation is current", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);

		const prepared = prepareBuildStep(convergence, [] as never, [
			"exec",
			"write_file",
			"view_preview",
		]);

		expect(prepared.allowedTools).toEqual({
			toolNames: ["write_file", "view_preview"],
			mode: "auto",
		});
	});

	it("never narrows the tools sent, so the cached prompt prefix survives", () => {
		const toolNames = ["exec", "write_file", "view_preview", "content_create"] as const;
		const validated = new BuildConvergence();
		validated.recordValidation(validated.beginObservation()!, { success: true });
		const converged = new BuildConvergence();
		recordCompleteEvidence(converged);
		converged.finishStep({});
		converged.finishStep({});
		const recovering = new BuildConvergence();
		recovering.recordUnresolvedFailure({
			key: "content:pages:home",
			toolName: "content_create",
			error: "[VALIDATION_ERROR]",
		});

		for (const convergence of [new BuildConvergence(), validated, converged, recovering]) {
			expect(prepareBuildStep(convergence, [] as never, toolNames)).not.toHaveProperty(
				"activeTools",
			);
		}
	});

	it("stops forcing a failure the model could not repair after three forced steps", () => {
		const convergence = new BuildConvergence();
		convergence.recordUnresolvedFailure({
			key: "content:posts:rye",
			toolName: "content_create",
			error: "[VALIDATION_ERROR] body: required",
		});
		const tools = ["content_create", "view_preview"] as const;

		for (let step = 0; step < 3; step++) {
			expect(prepareBuildStep(convergence, [] as never, tools).allowedTools).toEqual({
				toolNames: ["content_create"],
				mode: "required",
			});
			// The retry used a new title, so the original key never resolves.
			convergence.recordUnresolvedFailure({
				key: "content:posts:rye",
				toolName: "content_create",
				error: "[VALIDATION_ERROR] body: required",
			});
		}

		expect(prepareBuildStep(convergence, [] as never, tools).allowedTools).toBeUndefined();
		expect(convergence.hasUnresolvedFailures()).toBe(false);
		expect(convergence.abandonedFailures()).toEqual([
			expect.objectContaining({ key: "content:posts:rye", toolName: "content_create" }),
		]);
		recordCompleteEvidence(convergence);
		convergence.finishStep({});
		convergence.finishStep({});
		expect(canCompleteBuild(convergence, "stop")).toBe(true);
	});

	it("spends one forced-repair budget per tool, not per failed item", () => {
		const convergence = new BuildConvergence();
		for (const name of ["a", "b", "c", "d", "e"]) {
			convergence.recordUnresolvedFailure({
				key: `media\0${name}.jpg`,
				toolName: "upload_media",
				error: "HTTP 503",
			});
		}
		let forced = 0;
		for (let step = 0; step < 10; step++) {
			const prepared = prepareBuildStep(convergence, [] as never, ["upload_media"]);
			if (!prepared.allowedTools) break;
			forced += 1;
			// Each forced batch retries every image, and they all fail again.
			for (const name of ["a", "b", "c", "d", "e"]) {
				convergence.recordUnresolvedFailure({
					key: `media\0${name}.jpg`,
					toolName: "upload_media",
					error: "HTTP 503",
				});
			}
			convergence.finishStep({
				toolResults: [{ toolName: "upload_media", output: { success: false } }],
			});
		}

		expect(forced).toBe(3);
		expect(convergence.abandonedFailures()).toHaveLength(5);
	});

	it("resolves the forced failure when the forced call succeeds under a new identity", () => {
		const convergence = new BuildConvergence();
		convergence.recordUnresolvedFailure({
			key: "content:posts:rye",
			toolName: "content_create",
			error: "[VALIDATION_ERROR]",
		});
		prepareBuildStep(convergence, [] as never, ["content_create"]);
		// The retry used a new title, so the tool resolved no key itself.
		convergence.finishStep({
			toolResults: [{ toolName: "content_create", output: { content: [{ type: "text" }] } }],
		});

		expect(convergence.hasUnresolvedFailures()).toBe(false);
		expect(convergence.abandonedFailures()).toEqual([]);
	});

	it("keeps a forced failure the same step recorded again, even when the call partly succeeded", () => {
		const convergence = new BuildConvergence();
		const failure = { key: "media\0hero.jpg", toolName: "upload_media", error: "HTTP 404" };
		convergence.recordUnresolvedFailure(failure);
		prepareBuildStep(convergence, [] as never, ["upload_media"]);
		convergence.recordUnresolvedFailure(failure);
		convergence.finishStep({
			toolResults: [{ toolName: "upload_media", output: { success: true, uploaded: 2 } }],
		});

		expect(convergence.hasUnresolvedFailures()).toBe(true);
	});

	it("tells the model which repairs it stopped being made to attempt", () => {
		const convergence = new BuildConvergence();
		convergence.recordUnresolvedFailure({
			key: "content:posts:rye",
			toolName: "content_create",
			error: "[VALIDATION_ERROR] body: required",
		});
		for (let step = 0; step < 3; step++) {
			prepareBuildStep(convergence, [] as never, ["content_create"]);
			convergence.finishStep({
				toolResults: [{ toolName: "content_create", output: { success: false } }],
			});
		}

		const { messages } = prepareBuildStep(convergence, [] as never, ["content_create"]);
		const note = JSON.stringify(messages.at(-1));
		expect(messages.at(-1)?.role).toBe("user");
		expect(note).toContain("body: required");
		expect(note).toContain("summary");
	});

	it("forces a new failure again after an earlier one is resolved", () => {
		const convergence = new BuildConvergence();
		const failure = { key: "media\0hero.jpg", toolName: "upload_media", error: "HTTP 404" };
		convergence.recordUnresolvedFailure(failure);
		prepareBuildStep(convergence, [] as never, ["upload_media"]);
		convergence.resolveUnresolvedFailure(failure.key);
		convergence.recordUnresolvedFailure(failure);

		// Resolution resets the budget: a later failure of the same slot is forced again.
		for (let step = 0; step < 3; step++) {
			expect(prepareBuildStep(convergence, [] as never, ["upload_media"]).allowedTools).toEqual({
				toolNames: ["upload_media"],
				mode: "required",
			});
		}
		expect(convergence.hasUnresolvedFailures()).toBe(false);
	});

	it("allows one more step after a refused shell command, then forces text", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);
		// The evidence reached the model; its next step called exec anyway.
		convergence.finishStep({});
		const refusedExec = { toolResults: [{ toolName: "exec", output: { success: false } }] };

		convergence.finishStep(refusedExec);
		expect(convergence.shouldForceText()).toBe(false);
		expect(convergence.hasCompleteEvidence()).toBe(true);

		convergence.finishStep(refusedExec);
		expect(convergence.shouldForceText()).toBe(true);
		expect(canCompleteBuild(convergence, "stop")).toBe(true);
	});

	it("makes the step text-only after unchanged evidence converges", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);
		convergence.finishStep({});
		convergence.finishStep({});

		const prepared = prepareBuildStep(convergence, [] as never, ["exec", "write_file"]);

		expect(prepared.toolChoice).toBe("none");
		expect(prepared.allowedTools).toBeUndefined();
	});

	it("does not mark a non-error finish complete without final evidence", () => {
		const convergence = new BuildConvergence();
		expect(canCompleteBuild(convergence, "stop")).toBe(false);
		expect(canCompleteBuild(convergence, undefined)).toBe(false);

		recordCompleteEvidence(convergence);
		convergence.finishStep({});
		expect(canCompleteBuild(convergence, "tool-calls")).toBe(false);
		expect(canCompleteBuild(convergence, "stop")).toBe(false);
		convergence.finishStep({});
		expect(canCompleteBuild(convergence, "stop")).toBe(true);
		expect(canCompleteBuild(convergence, "tool-calls")).toBe(false);
		expect(canCompleteBuild(convergence, "error")).toBe(false);
	});

	it("forces repair of an unresolved entity before allowing completion", () => {
		const convergence = new BuildConvergence();
		convergence.recordUnresolvedFailure({
			key: "content:pages:submit",
			toolName: "content_create",
			error: "[VALIDATION_ERROR] layout: must be an array",
		});
		recordCompleteEvidence(convergence);
		convergence.finishStep({});
		convergence.finishStep({});

		expect(convergence.hasUnresolvedFailures()).toBe(true);
		expect(canCompleteBuild(convergence, "stop")).toBe(false);
		expect(
			prepareBuildStep(convergence, [] as never, ["content_create", "view_preview"]),
		).toMatchObject({
			allowedTools: { toolNames: ["content_create"], mode: "required" },
		});

		convergence.resolveUnresolvedFailure("content:pages:submit");
		expect(convergence.hasUnresolvedFailures()).toBe(false);
	});
});

describe("preview context pruning", () => {
	const previewMessages = () =>
		[
			{ role: "user", content: [{ type: "text", text: "Build it" }] },
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "preview-1",
						toolName: "view_preview",
						output: {
							type: "content",
							value: [
								{ type: "text", text: "old" },
								{ type: "file-data", data: "old-image", mediaType: "image/png" },
							],
						},
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "preview-2",
						toolName: "view_preview",
						output: {
							type: "content",
							value: [
								{ type: "text", text: "current" },
								{ type: "file-data", data: "current-image", mediaType: "image/png" },
							],
						},
					},
					{
						type: "tool-result",
						toolCallId: "read-1",
						toolName: "read_file",
						output: { type: "text", value: "source" },
					},
				],
			},
		] as never;

	it("keeps only the latest image when it belongs to the current revision", () => {
		const messages = previewMessages();
		const pruned = prunePreviewImages(messages, true) as Array<Record<string, any>>;

		expect(pruned[0]).toEqual(messages[0]);
		expect(pruned[1]!.content[0]).toMatchObject({
			toolCallId: "preview-1",
			output: { type: "text" },
		});
		expect(pruned[2]!.content[0]).toEqual((messages as any)[2].content[0]);
		expect(pruned[2]!.content[1]).toEqual((messages as any)[2].content[1]);
	});

	it("removes every image when the current revision has no delivered preview", () => {
		const messages = previewMessages();
		const pruned = prunePreviewImages(messages, false) as Array<Record<string, any>>;

		expect(pruned[1]!.content[0].output).toMatchObject({ type: "text" });
		expect(pruned[2]!.content[0].output).toMatchObject({ type: "text" });
	});

	it("releases screenshot bytes from retained completed-step messages", () => {
		const messages = previewMessages();
		const step = { response: { messages } };

		releaseStepPreviewImages(step);

		expect(JSON.stringify(step)).not.toContain("old-image");
		expect(JSON.stringify(step)).not.toContain("current-image");
		expect(JSON.stringify(step)).toContain("read_file");
	});

	it("promotes only the latest preview as a provider-visible user file", () => {
		const messages = previewMessages();
		const prepared = promoteLatestPreviewImage(messages, true);

		expect(prepared.promoted).toBe(true);
		expect(JSON.stringify(messages)).not.toContain("old-image");
		expect(JSON.stringify(messages)).not.toContain("current-image");
		expect(prepared.messages.at(-1)).toMatchObject({
			role: "user",
			content: expect.arrayContaining([
				expect.objectContaining({
					type: "file",
					data: "current-image",
					mediaType: "image/png",
				}),
			]),
		});
	});

	it("records final-preview evidence only when preparing the provider-visible image", () => {
		const convergence = new BuildConvergence();
		const observation = convergence.beginObservation()!;
		convergence.recordPreviewCapture(observation);
		convergence.recordValidation(observation, { success: true });

		prepareBuildStep(convergence, previewMessages(), ["view_preview", "write_file"]);

		expect(convergence.hasCompleteEvidence()).toBe(true);
		convergence.finishStep({});
		expect(convergence.shouldForceText()).toBe(true);
	});
});

describe("stopped build mutations", () => {
	it("does not start a queued mutation after the turn is cancelled", async () => {
		const controller = new AbortController();
		const convergence = new BuildConvergence(controller.signal);
		let startFirst!: () => void;
		let finishFirst!: () => void;
		const started = new Promise<void>((resolve) => (startFirst = resolve));
		const finishing = new Promise<void>((resolve) => (finishFirst = resolve));
		const first = convergence.runMutation(async () => {
			startFirst();
			await finishing;
			return "first finished";
		});
		await started;
		const secondAction = vi.fn(async () => "second finished");
		const second = convergence.runMutation(secondAction);
		controller.abort();
		finishFirst();
		await expect(first).resolves.toBe("first finished");
		await expect(second).rejects.toThrow();
		expect(secondAction).not.toHaveBeenCalled();
	});
});

describe("script mutation windows", () => {
	it("leaves a read-only program's revision and evidence alone", async () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);

		const result = await convergence.runScript(async () => ({ success: true, read: 3 }));

		expect(result).toEqual({ success: true, read: 3 });
		expect(convergence.currentRevision()).toBe(0);
		expect(convergence.hasCompleteEvidence()).toBe(true);
	});

	it("advances the revision once for a program's mutations and blocks observations until it ends", async () => {
		const convergence = new BuildConvergence();
		let observedDuring: unknown = "unset";

		await convergence.runScript(async (scope) => {
			await scope.runMutation(async () => ({ success: true }));
			await scope.runConditionalMutation(async () => ({
				changed: true as const,
				operation: async () => ({ success: true }),
			}));
			await scope.runMutation(async () => ({ success: true }));
			observedDuring = convergence.beginObservation();
			return { success: true };
		});

		expect(convergence.currentRevision()).toBe(1);
		expect(observedDuring).toBeUndefined();
		expect(convergence.beginObservation()).toEqual({ revision: 1 });
	});

	it("queues a direct mutation behind a running program without deadlocking inner calls", async () => {
		const convergence = new BuildConvergence();
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const script = convergence.runScript(async (scope) => {
			await scope.runMutation(async () => order.push("inner-1"));
			await gate;
			await scope.runMutation(async () => order.push("inner-2"));
			expect(await scope.reusedMutationResultQueued("any")).toEqual({ hit: false });
			return { success: true };
		});
		const direct = convergence.runMutation(async () => {
			order.push("direct");
			return { success: true };
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		release();
		await Promise.all([script, direct]);

		expect(order).toEqual(["inner-1", "inner-2", "direct"]);
		expect(convergence.currentRevision()).toBe(2);
	});

	it("runs a program's parallel mutations one at a time, as direct calls run", async () => {
		const convergence = new BuildConvergence();
		const order: string[] = [];
		const mutation = (name: string) => async () => {
			order.push(`${name}:start`);
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push(`${name}:end`);
			return { success: true };
		};

		await convergence.runScript(async (scope) => {
			await Promise.all([
				scope.runMutation(mutation("a")),
				scope.runConditionalMutation(async () => ({
					changed: true as const,
					operation: mutation("b"),
				})),
				scope.runMutation(mutation("c")),
			]);
			return { success: true };
		});

		expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
		expect(convergence.currentRevision()).toBe(1);
	});

	it("keeps running a program's queued mutations after one rejects", async () => {
		const convergence = new BuildConvergence();

		const outcomes = await convergence.runScript(async (scope) =>
			Promise.allSettled([
				scope.runMutation(async () => {
					throw new Error("CMS unavailable");
				}),
				scope.runMutation(async () => "second"),
			]),
		);

		expect(outcomes).toEqual([
			{ status: "rejected", reason: new Error("CMS unavailable") },
			{ status: "fulfilled", value: "second" },
		]);
	});

	it("reuses an identical successful program and never a failed one", async () => {
		const convergence = new BuildConvergence();
		const runs: string[] = [];
		const program = (outcome: boolean) => async (scope: MutationScope) => {
			await scope.runMutation(async () => runs.push("ran"));
			return { success: outcome };
		};

		await convergence.runScript(program(true), { key: "script-a" });
		await expect(convergence.runScript(program(true), { key: "script-a" })).resolves.toMatchObject({
			cached: true,
			changed: false,
		});
		await convergence.runScript(program(false), { key: "script-b" });
		await convergence.runScript(program(false), { key: "script-b" });

		expect(runs).toHaveLength(3);
	});

	it("refuses to start a program after Stop", async () => {
		const controller = new AbortController();
		const convergence = new BuildConvergence(controller.signal);
		controller.abort();

		await expect(
			convergence.runScript(async (scope) => scope.runMutation(async () => "ran")),
		).rejects.toThrow();
		expect(convergence.currentRevision()).toBe(0);
	});
});
