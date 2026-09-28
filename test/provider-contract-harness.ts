import { describe, expect, it } from "vitest";
import {
	providerCapabilitiesSchema,
	providerOperationReferenceSchema,
	providerOperationSchema,
	type ProviderAdapter,
	type ReleaseBundle,
} from "../src/platform/contracts.js";

export interface ProviderContractFixture {
	provider: ProviderAdapter;
	siteId: string;
	releaseId: string;
	bundle: ReleaseBundle;
}

/** Reusable conformance tests for provider adapter implementations. */
export function providerContractTests(
	name: string,
	createFixture: () => ProviderContractFixture | Promise<ProviderContractFixture>,
) {
	describe(`${name} provider contract`, () => {
		it("returns a valid capabilities envelope", async () => {
			const { provider } = await createFixture();
			providerCapabilitiesSchema.parse(await provider.getCapabilities());
		});

		it("deduplicates retried mutations by idempotency key", async () => {
			const { provider, siteId, releaseId, bundle } = await createFixture();
			await provider.ensureSite({ siteId, idempotencyKey: "ensure-before-deploy" });
			const request = { siteId, releaseId, bundle, idempotencyKey: "deploy-once" };
			const first = providerOperationReferenceSchema.parse(await provider.deployRelease(request));
			const retry = providerOperationReferenceSchema.parse(await provider.deployRelease(request));

			expect(retry).toEqual(first);
			const operation = providerOperationSchema.parse(
				await provider.getOperation(first.operationId),
			);
			expect(operation).toMatchObject({
				kind: "deploy-release",
				status: "succeeded",
				siteId,
				releaseId,
			});
		});

		it("rejects reusing an idempotency key for another request", async () => {
			const { provider, siteId, releaseId, bundle } = await createFixture();
			await provider.ensureSite({ siteId, idempotencyKey: "ensure-before-collision" });
			await provider.deployRelease({
				siteId,
				releaseId,
				bundle,
				idempotencyKey: "deploy-collision",
			});

			await expect(
				provider.deployRelease({
					siteId,
					releaseId: "00000000-0000-4000-8000-000000000099",
					bundle,
					idempotencyKey: "deploy-collision",
				}),
			).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
		});

		it("rejects an idempotency key above the contract bound", async () => {
			const { provider, siteId } = await createFixture();
			await expect(
				provider.ensureSite({ siteId, idempotencyKey: "x".repeat(201) }),
			).rejects.toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
		});

		it("represents the site, release, and hostname lifecycle as operations", async () => {
			const { provider, siteId, releaseId, bundle } = await createFixture();
			const references = [];
			references.push(await provider.ensureSite({ siteId, idempotencyKey: "ensure" }));
			references.push(
				await provider.deployRelease({ siteId, releaseId, bundle, idempotencyKey: "deploy" }),
			);
			references.push(
				await provider.promoteRelease({ siteId, releaseId, idempotencyKey: "promote" }),
			);
			references.push(
				await provider.rollbackRelease({ siteId, releaseId, idempotencyKey: "rollback" }),
			);
			references.push(
				await provider.setHostname({
					siteId,
					hostname: "site.example.test",
					idempotencyKey: "hostname",
				}),
			);

			const operations = await Promise.all(
				references.map(async (reference) => {
					const { operationId } = providerOperationReferenceSchema.parse(reference);
					return providerOperationSchema.parse(await provider.getOperation(operationId));
				}),
			);

			expect(operations.map(({ kind }) => kind)).toEqual([
				"ensure-site",
				"deploy-release",
				"promote-release",
				"rollback-release",
				"set-hostname",
			]);
			expect(operations.every(({ status }) => status === "succeeded")).toBe(true);
		});

		it("retains a checked candidate while rolling back Live", async () => {
			const { provider, siteId, releaseId, bundle } = await createFixture();
			const candidateReleaseId = "00000000-0000-4000-8000-000000000098";
			await provider.ensureSite({ siteId, idempotencyKey: "ensure-before-rollback" });
			await provider.deployRelease({
				siteId,
				releaseId,
				bundle,
				idempotencyKey: "deploy-live-before-rollback",
			});
			await provider.promoteRelease({
				siteId,
				releaseId,
				idempotencyKey: "promote-live-before-rollback",
			});
			await provider.deployRelease({
				siteId,
				releaseId: candidateReleaseId,
				bundle,
				idempotencyKey: "deploy-candidate-before-rollback",
			});
			await provider.rollbackRelease({
				siteId,
				releaseId,
				idempotencyKey: "rollback-with-candidate",
			});

			const promoted = await provider.promoteRelease({
				siteId,
				releaseId: candidateReleaseId,
				idempotencyKey: "promote-retained-candidate",
			});
			expect(await provider.getOperation(promoted.operationId)).toMatchObject({
				status: "succeeded",
				releaseId: candidateReleaseId,
			});
		});
	});
}
