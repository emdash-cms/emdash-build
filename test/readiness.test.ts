import { describe, expect, it } from "vitest";
import {
	classifyBuildTurn,
	capturedPreviewShotId,
	recordBuilderMilestone,
	recordPersonalizationMilestone,
	summarizeInitialBuildBenchmark,
	type BuilderReadinessState,
} from "../src/worker/readiness.js";

describe("builder readiness", () => {
	it("selects the actual screenshot at the accepted revision, even when final preview is cached", () => {
		const oldShot = "00000000-0000-4000-8000-000000000001";
		const acceptedShot = "00000000-0000-4000-8000-000000000002";
		const steps = [
			{
				toolResults: [
					{ toolName: "view_preview", output: { success: true, shotId: oldShot, revision: 1 } },
				],
			},
			{
				toolResults: [
					{
						toolName: "view_preview",
						output: { success: true, shotId: acceptedShot, revision: 2 },
					},
				],
			},
			{ toolResults: [{ toolName: "validate_site", output: { success: true } }] },
			{
				toolResults: [
					{ toolName: "view_preview", output: { success: true, cached: true, revision: 2 } },
				],
			},
		];
		expect(capturedPreviewShotId(steps, 2)).toBe(acceptedShot);
		expect(capturedPreviewShotId(steps, 3)).toBeUndefined();
	});

	it("ignores cached, skipped, failed and malformed preview outputs", () => {
		const steps = [
			{
				toolResults: [
					{
						toolName: "view_preview",
						output: { success: true, cached: true, revision: 1, shotId: "cached" },
					},
				],
			},
			{
				toolResults: [
					{
						toolName: "view_preview",
						output: { success: true, skipped: true, revision: 1, shotId: "skipped" },
					},
				],
			},
			{
				toolResults: [
					{ toolName: "view_preview", output: { success: false, revision: 1, shotId: "failed" } },
				],
			},
			{
				toolResults: [
					{
						toolName: "view_preview",
						output: { success: true, revision: 1, shotId: "not-a-uuid" },
					},
				],
			},
		];
		expect(capturedPreviewShotId(steps, 1)).toBeUndefined();
	});
	it("records granular flags and elapsed time from container start", () => {
		const started = recordBuilderMilestone({}, "containerStarting", 1_000);
		expect(started).toEqual({
			state: { milestones: { containerStarting: 1_000 } },
			elapsedMs: 0,
		});

		const preview = recordBuilderMilestone(started!.state, "previewReady", 1_450);
		expect(preview).toEqual({
			state: {
				previewReady: true,
				milestones: { containerStarting: 1_000, previewReady: 1_450 },
			},
			elapsedMs: 450,
		});
	});

	it("does not overwrite the first observation of a milestone", () => {
		const state = {
			previewReady: true,
			milestones: { containerStarting: 1_000, previewReady: 1_500 },
		};
		expect(recordBuilderMilestone(state, "previewReady", 9_000)).toBeUndefined();
	});

	it("tracks CMS, tool, personalization, and completion independently", () => {
		let state = recordBuilderMilestone({}, "containerStarting", 1_000)!.state;
		for (const [milestone, at] of [
			["cmsReady", 2_000],
			["agentToolsReady", 2_500],
			["personalized", 3_000],
			["complete", 4_000],
		] as const) {
			state = recordBuilderMilestone(state, milestone, at)!.state;
		}

		expect(state).toMatchObject({
			cmsReady: true,
			agentToolsReady: true,
			personalized: true,
			complete: true,
		});
	});

	it("tracks build eligibility and model start independently", () => {
		let state: BuilderReadinessState = recordBuilderMilestone(
			{},
			"containerStarting",
			1_000,
		)!.state;
		state = recordBuilderMilestone(state, "buildEligible", 2_000)!.state;
		state = recordBuilderMilestone(state, "buildStarting", 2_250)!.state;

		expect(state.milestones).toMatchObject({
			buildEligible: 2_000,
			buildStarting: 2_250,
		});
		expect(state.complete).toBeUndefined();
	});

	it("records personalization only after a successful initial preview refresh", () => {
		const state = { milestones: { buildStarting: 1_000 } };
		expect(recordPersonalizationMilestone(state, true, false, 1_500)).toBeUndefined();
		expect(recordPersonalizationMilestone(state, false, true, 1_500)).toBeUndefined();
		expect(recordPersonalizationMilestone(state, true, true, 1_500)?.state).toEqual({
			personalized: true,
			milestones: { buildStarting: 1_000, personalized: 1_500 },
		});
	});

	it("summarizes only quality-valid completed build steps", () => {
		const summary = summarizeInitialBuildBenchmark(
			{
				buildEligible: 1_000,
				buildStarting: 1_250,
				personalized: 2_000,
				complete: 2_500,
			},
			[
				{
					toolCalls: [{ toolName: "write_file" }],
					toolResults: [],
				},
				{
					toolCalls: [{ toolName: "validate_site" }],
					toolResults: [{ toolName: "validate_site", output: { success: true } }],
				},
				{
					toolCalls: [{ toolName: "view_preview" }],
					toolResults: [{ toolName: "view_preview", output: { success: true } }],
				},
			],
		);

		expect(summary).toEqual({
			qualityValid: true,
			rejectionReasons: [],
			stepCount: 3,
			toolCalls: { validate_site: 1, view_preview: 1, write_file: 1 },
			questionnaireToPersonalizedMs: 1_000,
			modelToPersonalizedMs: 750,
			modelToFinishMs: 1_250,
		});
	});

	it("rejects a build without final preview evidence or with a later mutation", () => {
		const missingPreview = summarizeInitialBuildBenchmark({}, [
			{
				toolCalls: [{ toolName: "validate_site" }],
				toolResults: [{ toolName: "validate_site", output: { success: true } }],
			},
		]);
		expect(missingPreview.qualityValid).toBe(false);
		expect(missingPreview.rejectionReasons).toContain("missing-final-preview");

		const laterMutation = summarizeInitialBuildBenchmark({}, [
			{
				toolCalls: [{ toolName: "validate_site" }],
				toolResults: [{ toolName: "validate_site", output: { success: true } }],
			},
			{
				toolCalls: [{ toolName: "write_files" }],
				toolResults: [{ toolName: "write_files", output: { success: true } }],
			},
			{
				toolCalls: [{ toolName: "view_preview" }],
				toolResults: [{ toolName: "view_preview", output: { success: true } }],
			},
		]);
		expect(laterMutation.qualityValid).toBe(false);
		expect(laterMutation.rejectionReasons).toContain("mutation-after-validation");
	});

	it("does not treat restart or deploy operations as site mutations", () => {
		for (const toolName of ["restart_dev_server", "deploy_site"]) {
			const summary = summarizeInitialBuildBenchmark({}, [
				{
					toolCalls: [{ toolName: "validate_site" }],
					toolResults: [{ toolName: "validate_site", output: { success: true } }],
				},
				{
					toolCalls: [{ toolName }],
					toolResults: [{ toolName, output: { success: true } }],
				},
				{
					toolCalls: [{ toolName: "view_preview" }],
					toolResults: [{ toolName: "view_preview", output: { success: true } }],
				},
			]);

			expect(summary.qualityValid, toolName).toBe(true);
		}
	});

	it("does not reject explicit no-op or cached mutations after validation", () => {
		for (const output of [
			{ success: true, changed: false },
			{ success: true, cached: true, changed: false },
		]) {
			const summary = summarizeInitialBuildBenchmark({}, [
				{
					toolCalls: [{ toolName: "validate_site" }],
					toolResults: [{ toolName: "validate_site", output: { success: true } }],
				},
				{
					toolCalls: [{ toolName: "write_file" }],
					toolResults: [{ toolName: "write_file", output }],
				},
				{
					toolCalls: [{ toolName: "view_preview" }],
					toolResults: [{ toolName: "view_preview", output: { success: true } }],
				},
			]);

			expect(summary.qualityValid).toBe(true);
		}
	});

	it("tracks block schema evolution as a mutation unless it is a no-op", () => {
		for (const toolName of [
			"update_blocks_field",
			"schema_update_block_type",
			"schema_activate_block_type_version",
		]) {
			const summarize = (changed: boolean) =>
				summarizeInitialBuildBenchmark({}, [
					{
						toolCalls: [{ toolName: "validate_site" }],
						toolResults: [{ toolName: "validate_site", output: { success: true } }],
					},
					{
						toolCalls: [{ toolName }],
						toolResults: [{ toolName, output: { success: true, changed } }],
					},
					{
						toolCalls: [{ toolName: "view_preview" }],
						toolResults: [{ toolName: "view_preview", output: { success: true } }],
					},
				]);

			expect(summarize(true).qualityValid, toolName).toBe(false);
			expect(summarize(false).qualityValid, toolName).toBe(true);
		}
	});
});

describe("initial build turn", () => {
	it("owns the whole first build when it starts it", () => {
		expect(classifyBuildTurn({}, false)).toEqual({ startsInitialBuild: true, initialBuild: true });
	});

	it("keeps tracking the first build when recovery resumes it", () => {
		expect(classifyBuildTurn({ buildStarted: true, initialBuildInFlight: true }, true)).toEqual({
			startsInitialBuild: false,
			initialBuild: true,
		});
	});

	it("keeps an incomplete first build eligible for an explicit retry", () => {
		expect(classifyBuildTurn({ buildStarted: true, initialBuildInFlight: false }, false)).toEqual({
			startsInitialBuild: false,
			initialBuild: true,
		});
	});

	it("treats a new user turn after the completed first build as a follow-up", () => {
		expect(
			classifyBuildTurn({ buildStarted: true, initialBuildInFlight: true, complete: true }, false),
		).toEqual({
			startsInitialBuild: false,
			initialBuild: false,
		});
		expect(classifyBuildTurn({ buildStarted: true, complete: true }, true)).toEqual({
			startsInitialBuild: false,
			initialBuild: false,
		});
	});
});
