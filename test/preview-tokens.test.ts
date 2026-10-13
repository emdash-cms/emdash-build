import { describe, expect, it } from "vitest";
import {
	PORT_TOKENS_KEY,
	deletePortToken,
	previewUrl,
	readPortTokens,
	validatePortToken,
	writePortToken,
} from "../src/worker/preview-tokens.js";

interface FakeStorage {
	data: Map<string, unknown>;
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	transaction<T>(run: (txn: FakeStorage) => Promise<T>): Promise<T>;
}

/** Durable Object storage, as far as the tokens use it. */
function storage(initial: Record<string, unknown> = {}): FakeStorage & DurableObjectStorage {
	const data = new Map(Object.entries(initial));
	const api: FakeStorage = {
		data,
		async get<T>(key: string) {
			return structuredClone(data.get(key)) as T | undefined;
		},
		async put(key: string, value: unknown) {
			data.set(key, structuredClone(value));
		},
		async transaction<T>(run: (txn: FakeStorage) => Promise<T>) {
			return run(api);
		},
	};
	return api as FakeStorage & DurableObjectStorage;
}

const ID = "77777777-7777-4777-8777-777777777777";

describe("preview tokens", () => {
	it("keeps working with the tokens the 0.12 SDK stored, in either format", async () => {
		const legacy = storage({
			[PORT_TOKENS_KEY]: { "4321": { token: "abc123", name: "preview" }, "8080": "oldtoken" },
		});
		expect(await readPortTokens(legacy)).toEqual({
			"4321": { token: "abc123", name: "preview" },
			"8080": { token: "oldtoken" },
		});
		expect(await validatePortToken(legacy, 4321, "abc123")).toBe(true);
		expect(await validatePortToken(legacy, 8080, "oldtoken")).toBe(true);
		expect(await validatePortToken(legacy, 4321, "abc124")).toBe(false);
		expect(await validatePortToken(legacy, 4321, "abc12")).toBe(false);
		expect(await validatePortToken(legacy, 4322, "abc123")).toBe(false);
	});

	it("writes and revokes a port's token, one port per token", async () => {
		const store = storage();
		await writePortToken(store, 4321, "a1b2c3d4e5f60718", "preview");
		expect(store.data.get(PORT_TOKENS_KEY)).toEqual({
			"4321": { token: "a1b2c3d4e5f60718", name: "preview" },
		});
		// Writing the same token again is idempotent.
		await writePortToken(store, 4321, "a1b2c3d4e5f60718", "preview");
		await expect(writePortToken(store, 4322, "a1b2c3d4e5f60718")).rejects.toThrow("already used");
		await expect(writePortToken(store, 3000, "other")).rejects.toThrow("Invalid preview port");
		await expect(writePortToken(store, 4321, "Not-Valid")).rejects.toThrow();

		await deletePortToken(store, 4321);
		expect(await validatePortToken(store, 4321, "a1b2c3d4e5f60718")).toBe(false);
	});

	it("builds the URLs the 0.12 SDK built, and usable local ones", () => {
		expect(previewUrl(4321, ID, "build.emdashcms.com", "tok")).toBe(
			`https://4321-${ID}-tok.build.emdashcms.com/`,
		);
		expect(previewUrl(4321, ID, "localhost:5173", "tok")).toBe(
			`http://4321-${ID}-tok.localhost:5173/`,
		);
		expect(previewUrl(4321, ID, "127.0.0.1:5173", "tok")).toBe(
			`http://4321-${ID}-tok.localhost:5173/`,
		);
		expect(previewUrl(4321, ID.toUpperCase(), "emdash.localhost", "tok")).toBe(
			`http://4321-${ID}-tok.emdash.localhost/`,
		);
	});
});
