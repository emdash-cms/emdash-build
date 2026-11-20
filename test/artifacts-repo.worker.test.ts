import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuilderAgent } from "../src/worker/agent.js";

const testEnv = env as typeof env & { BuilderAgent: DurableObjectNamespace<BuilderAgent> };

const REMOTE = "https://artifacts.example/git/emdash-build/site.git";

/** A repo handle shaped like the binding's: metadata only through `info()`, no `remote` property. */
function repoHandle(info: () => Promise<{ remote: string }>) {
	return {
		createToken: async (scope?: "read" | "write") => ({
			plaintext: `token-${scope ?? "write"}`,
			expiresAt: "2026-11-19T12:00:00.000Z",
		}),
		info: vi.fn(info),
	};
}

type Harness = {
	env: { ARTIFACTS: unknown };
	getArtifactsRepoForRead: () => Promise<{ remote: string; token: string } | null>;
	persistArtifactsRemote: (remote: string) => void;
};

describe("Artifacts repo remote", () => {
	// Each test swaps the binding on the env every instance shares; the next one gets it back.
	let restoreArtifacts: (() => void) | undefined;
	const useArtifacts = (harness: Harness, binding: unknown) => {
		const original = harness.env.ARTIFACTS;
		restoreArtifacts ??= () => {
			harness.env.ARTIFACTS = original;
		};
		harness.env.ARTIFACTS = binding;
	};

	beforeEach(async () => {
		await reset();
	});

	afterEach(() => {
		restoreArtifacts?.();
		restoreArtifacts = undefined;
	});

	it("reads the remote through info() when none is stored, then keeps it", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000101");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as Harness;
			const repo = repoHandle(async () => ({ remote: REMOTE }));
			useArtifacts(harness, { get: async () => repo });

			expect(await harness.getArtifactsRepoForRead()).toEqual({
				remote: REMOTE,
				token: "token-read",
			});
			expect(repo.info).toHaveBeenCalledTimes(1);

			repo.info.mockRejectedValue(new Error("info() should not be needed once stored"));
			expect(await harness.getArtifactsRepoForRead()).toEqual({
				remote: REMOTE,
				token: "token-read",
			});
		});
	});

	it("prefers the stored remote without asking the repo", async () => {
		const agent = testEnv.BuilderAgent.getByName("11111111-1111-4111-8111-000000000102");
		await runInDurableObject(agent, async (instance) => {
			const harness = instance as unknown as Harness;
			harness.persistArtifactsRemote(REMOTE);
			const repo = repoHandle(async () => {
				throw new Error("info() should not be called");
			});
			useArtifacts(harness, { get: async () => repo });

			expect(await harness.getArtifactsRepoForRead()).toEqual({
				remote: REMOTE,
				token: "token-read",
			});
			expect(repo.info).not.toHaveBeenCalled();
		});
	});

	it.each([
		{ how: "by its code", id: "103", code: "CREATE_IN_PROGRESS" as string | undefined },
		// A binding error that crossed RPC may keep only its message.
		{ how: "by its message alone", id: "104", code: undefined },
	])(
		"answers the clone panel while the first snapshot's repo is still being created, told $how",
		async ({ id, code }) => {
			const agent = testEnv.BuilderAgent.getByName(`11111111-1111-4111-8111-000000000${id}`);
			await runInDurableObject(agent, async (instance) => {
				const harness = instance as unknown as Harness & {
					getCloneInfo: () => Promise<{ ok: boolean; reason?: string }>;
				};
				instance.setState({ ...instance.state, siteReady: true });
				useArtifacts(harness, {
					get: async () => {
						throw Object.assign(
							new Error("Repository is still being created"),
							code ? { code } : {},
						);
					},
				});

				expect(await harness.getCloneInfo()).toEqual({
					ok: false,
					reason: "Your first snapshot is still being saved. Try again in a moment.",
				});
			});
		},
	);
});
