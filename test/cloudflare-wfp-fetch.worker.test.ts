import { expect, it } from "vitest";
import { CloudflareWfpApi } from "../src/platform/cloudflare-wfp-api.js";

it("uses native Workers fetch without binding it to the API client", async () => {
	const client = new CloudflareWfpApi({
		accountId: "a".repeat(32),
		apiToken: "test-token",
		dispatchNamespace: "test",
		retryDelaysMs: [],
	});
	const transport = client as unknown as {
		request(
			phase: "asset-session",
			url: string,
			deadline: number,
			init: () => RequestInit,
			consume: (response: Response) => Promise<string>,
		): Promise<string>;
	};

	await expect(
		transport.request(
			"asset-session",
			"data:text/plain,native-fetch-ok",
			Date.now() + 5_000,
			() => ({}),
			(response) => response.text(),
		),
	).resolves.toBe("native-fetch-ok");
});
