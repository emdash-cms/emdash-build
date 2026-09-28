import { describe, expect, it, vi } from "vitest";
import {
	BuildConvergence,
	canCompleteBuild,
	mutationKey,
	prepareBuildStep,
	promoteLatestPreviewImage,
	prunePreviewImages,
	releaseStepPreviewImages,
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
			prepareBuildStep(convergence, [] as never, ["view_preview", "write_file"]).toolChoice,
		).toEqual({ type: "tool", toolName: "view_preview" });

		convergence.finishStep(failedPreview);
		expect(convergence.shouldForceText()).toBe(true);
		expect(
			prepareBuildStep(convergence, [] as never, ["view_preview", "write_file"]),
		).toMatchObject({ activeTools: [], toolChoice: "none" });
		expect(canCompleteBuild(convergence, "stop")).toBe(false);
	});

	it("removes shell access while validation is current", () => {
		const convergence = new BuildConvergence();
		const observation = convergence.beginObservation()!;
		convergence.recordValidation(observation, { success: true });

		const prepared = prepareBuildStep(convergence, [] as never, [
			"exec",
			"write_file",
			"view_preview",
		]);

		expect(prepared.activeTools).toEqual(["write_file", "view_preview"]);
		expect(prepared.toolChoice).toEqual({ type: "tool", toolName: "view_preview" });
	});

	it("makes the step text-only after unchanged evidence converges", () => {
		const convergence = new BuildConvergence();
		recordCompleteEvidence(convergence);
		convergence.finishStep({});
		convergence.finishStep({});

		const prepared = prepareBuildStep(convergence, [] as never, ["exec", "write_file"]);

		expect(prepared.activeTools).toEqual([]);
		expect(prepared.toolChoice).toBe("none");
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
			toolChoice: { type: "tool", toolName: "content_create" },
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
