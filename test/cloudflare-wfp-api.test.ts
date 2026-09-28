import { describe, expect, it, vi } from "vitest";
import {
	CloudflareWfpApi,
	WfpApiError,
	type CloudflareWfpApiOptions,
} from "../src/platform/cloudflare-wfp-api.js";
import {
	WFP_COMPATIBILITY_DATE,
	WFP_WRAPPER_VERSION,
	type ResolvedWfpRelease,
} from "../src/platform/wfp-release.js";

const ACCOUNT_ID = "a".repeat(32);
const SITE_ID = "00000000-0000-4000-8000-000000000001";
const RELEASE_ID = "00000000-0000-4000-8000-000000000011";
const UPLOAD_DIGEST = `sha256:${"d".repeat(64)}`;
const SCRIPT_NAME = "e-candidate-r-release";

function release(withAssets = true): ResolvedWfpRelease {
	return {
		siteId: SITE_ID,
		releaseId: RELEASE_ID,
		sourceRevision: "source-1",
		mainModule: "./src/index.js",
		compatibilityDate: WFP_COMPATIBILITY_DATE,
		compatibilityFlags: ["nodejs_compat"],
		bindingIntents: withAssets ? ["ASSETS"] : [],
		healthPath: "/health",
		uploadDigest: UPLOAD_DIGEST,
		wrapperVersion: WFP_WRAPPER_VERSION,
		wrapperBytes: new TextEncoder().encode("export default {}"),
		modules: [
			{
				name: "src/index.js",
				type: "esm",
				bytes: new TextEncoder().encode("export default {}"),
				digest: `sha256:${"1".repeat(64)}`,
			},
			{
				name: "src/module.wasm",
				type: "wasm",
				bytes: Uint8Array.of(0, 97, 115, 109, 255),
				digest: `sha256:${"2".repeat(64)}`,
			},
		],
		assets: withAssets
			? [
					{
						path: "images/logo.png",
						bytes: Uint8Array.of(137, 80, 78, 71, 0, 255),
						digest: `sha256:${"3".repeat(64)}`,
					},
					{
						path: "styles/site.css",
						bytes: new TextEncoder().encode("body { color: red; }"),
						digest: `sha256:${"4".repeat(64)}`,
					},
				]
			: [],
	};
}

function api(overrides: Partial<CloudflareWfpApiOptions> = {}) {
	return new CloudflareWfpApi({
		accountId: ACCOUNT_ID,
		apiToken: "account-secret",
		dispatchNamespace: "emdash-build",
		retryDelaysMs: [0, 0],
		sleep: async () => {},
		...overrides,
	});
}

async function formJson(form: FormData, name: string): Promise<Record<string, unknown>> {
	const value = form.get(name);
	if (!(value instanceof Blob)) throw new Error(`${name} was not a Blob.`);
	return JSON.parse(await value.text()) as Record<string, unknown>;
}

describe("Cloudflare WfP direct upload", () => {
	it("deletes one exact dispatch script and treats an absent script as deleted", async () => {
		const fetchMock = vi
			.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response(null, { status: 404 }));
		const client = api({ fetch: fetchMock });

		await client.deleteScript(SCRIPT_NAME);
		await client.deleteScript(SCRIPT_NAME);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		for (const [url, init] of fetchMock.mock.calls) {
			expect(String(url)).toBe(
				`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/emdash-build/scripts/${SCRIPT_NAME}`,
			);
			expect(init).toMatchObject({
				method: "DELETE",
				headers: { Authorization: "Bearer account-secret" },
			});
		}
	});

	it("uploads only requested site-salted assets, then binary-safe modules", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		let assetHash = "";
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const url = String(input);
			requests.push({ url, init });
			if (url.endsWith("/assets-upload-session")) {
				const body = JSON.parse(String(init.body)) as {
					manifest: Record<string, { hash: string; size: number }>;
				};
				assetHash = body.manifest["/images/logo.png"]!.hash;
				return Response.json({
					success: true,
					result: { jwt: "session-secret", buckets: [[assetHash]] },
				});
			}
			if (url.includes("/workers/assets/upload")) {
				return Response.json(
					{ success: true, result: { jwt: "completion-secret" } },
					{ status: 201 },
				);
			}
			return Response.json({ success: true, result: {} });
		});

		await api({ fetch: fetchMock }).uploadScript(SCRIPT_NAME, release());

		expect(requests.map(({ url }) => url)).toEqual([
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/emdash-build/scripts/${SCRIPT_NAME}/assets-upload-session`,
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/assets/upload?base64=true`,
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/emdash-build/scripts/${SCRIPT_NAME}`,
		]);
		expect(assetHash).toMatch(/^[a-f0-9]{32}$/);
		expect(requests[0]!.init.headers).toMatchObject({ Authorization: "Bearer account-secret" });
		expect(requests[1]!.init.headers).toMatchObject({ Authorization: "Bearer session-secret" });
		expect(requests[2]!.init.headers).toMatchObject({ Authorization: "Bearer account-secret" });

		const assetForm = requests[1]!.init.body;
		expect(assetForm).toBeInstanceOf(FormData);
		expect((assetForm as FormData).get(assetHash)).toBeInstanceOf(Blob);
		expect([...(assetForm as FormData).keys()]).toEqual([assetHash]);

		const scriptForm = requests[2]!.init.body as FormData;
		const metadata = await formJson(scriptForm, "metadata");
		expect(metadata).toMatchObject({
			main_module: "__emdash_entry.mjs",
			compatibility_date: WFP_COMPATIBILITY_DATE,
			compatibility_flags: ["nodejs_compat"],
			assets: { jwt: "completion-secret", config: { run_worker_first: true } },
			bindings: [
				{ type: "plain_text", name: "EMDASH_RELEASE_ID", text: RELEASE_ID },
				{ type: "plain_text", name: "EMDASH_UPLOAD_DIGEST", text: UPLOAD_DIGEST },
				{ type: "assets", name: "ASSETS" },
			],
		});
		expect((scriptForm.get("src/module.wasm") as Blob).type).toBe("application/wasm");
		expect(new Uint8Array(await (scriptForm.get("src/module.wasm") as Blob).arrayBuffer())).toEqual(
			Uint8Array.of(0, 97, 115, 109, 255),
		);
	});

	it("salts identical asset bytes by Site", async () => {
		const manifests: Array<Record<string, { hash: string; size: number }>> = [];
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
			if (typeof init.body === "string") {
				const body = JSON.parse(init.body) as {
					manifest: Record<string, { hash: string; size: number }>;
				};
				manifests.push(body.manifest);
				return Response.json({ success: true, result: { jwt: "cached-assets" } });
			}
			return Response.json({ success: true, result: {} });
		});
		const secondSite = { ...release(), siteId: "00000000-0000-4000-8000-000000000002" };

		await api({ fetch: fetchMock }).uploadScript(SCRIPT_NAME, release());
		await api({ fetch: fetchMock }).uploadScript(SCRIPT_NAME, secondSite);

		expect(manifests[0]?.["/images/logo.png"]?.hash).not.toBe(
			manifests[1]?.["/images/logo.png"]?.hash,
		);
	});

	it("requires a completion token after Cloudflare requests missing buckets", async () => {
		let call = 0;
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
			call += 1;
			if (call === 1) {
				const body = JSON.parse(String(init.body)) as {
					manifest: Record<string, { hash: string; size: number }>;
				};
				const hash = body.manifest["/images/logo.png"]!.hash;
				return Response.json({ success: true, result: { jwt: "upload-only", buckets: [[hash]] } });
			}
			if (call === 2) return new Response(null, { status: 200 });
			return Response.json({ success: true, result: {} });
		});

		await expect(
			api({ fetch: fetchMock }).uploadScript(SCRIPT_NAME, release()),
		).rejects.toMatchObject({
			code: "WFP_INVALID_RESPONSE",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("skips the asset protocol for a module-only release", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			Response.json({ success: true, result: {} }),
		);
		await api({ fetch: fetchMock }).uploadScript(SCRIPT_NAME, release(false));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]![0])).toContain(`/scripts/${SCRIPT_NAME}`);
	});

	it("attaches an empty asset manifest when the release declares ASSETS", async () => {
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			requests.push({ url: String(input), init });
			if (String(input).endsWith("/assets-upload-session")) {
				expect(JSON.parse(String(init.body))).toEqual({ manifest: {} });
				return Response.json({ success: true, result: { jwt: "empty-assets" } });
			}
			return Response.json({ success: true, result: {} });
		});

		await api({ fetch: fetchMock }).uploadScript(SCRIPT_NAME, { ...release(), assets: [] });

		expect(requests.map(({ url }) => url)).toEqual([
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/emdash-build/scripts/${SCRIPT_NAME}/assets-upload-session`,
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/emdash-build/scripts/${SCRIPT_NAME}`,
		]);
		const metadata = await formJson(requests[1]!.init.body as FormData, "metadata");
		expect(metadata).toMatchObject({
			assets: { jwt: "empty-assets", config: { run_worker_first: true } },
			bindings: expect.arrayContaining([{ type: "assets", name: "ASSETS" }]),
		});
	});

	it("retries network, 429, and 5xx responses but never retries another 4xx", async () => {
		const retrying = vi
			.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
			.mockRejectedValueOnce(new TypeError("token account-secret leaked"))
			.mockResolvedValueOnce(new Response("provider secret", { status: 429 }))
			.mockResolvedValueOnce(Response.json({ success: true, result: {} }));
		await api({ fetch: retrying }).uploadScript(SCRIPT_NAME, release(false));
		expect(retrying).toHaveBeenCalledTimes(3);

		const rejected = vi.fn(async () => new Response("account-secret raw body", { status: 403 }));
		const error = await api({ fetch: rejected })
			.uploadScript(SCRIPT_NAME, release(false))
			.catch((reason: unknown) => reason);
		expect(rejected).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(WfpApiError);
		expect(error).toMatchObject({ retryable: false, ambiguous: false, status: 403 });
		expect(String(error)).not.toContain("account-secret");
		expect(String(error)).not.toContain("raw body");
	});

	it("records every script PUT attempt and classifies exhausted HTTP errors as known", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
		const beforeScriptUploadAttempt = vi.fn();
		const error = await api({ fetch: fetchMock, beforeScriptUploadAttempt })
			.uploadScript(SCRIPT_NAME, release(false))
			.catch((reason: unknown) => reason);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(beforeScriptUploadAttempt).toHaveBeenCalledTimes(3);
		expect(error).toMatchObject({
			status: 503,
			retryable: true,
			ambiguous: false,
			phase: "script-upload",
			mayHaveApplied: true,
		});
	});

	it("preserves script ambiguity when a later retry is definitely rejected", async () => {
		const fetchMock = vi
			.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
			.mockRejectedValueOnce(new TypeError("connection reset"))
			.mockResolvedValueOnce(new Response(null, { status: 403 }));
		const error = await api({ fetch: fetchMock })
			.uploadScript(SCRIPT_NAME, release(false))
			.catch((reason: unknown) => reason);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(error).toMatchObject({ status: 403, retryable: false, ambiguous: true });
	});

	it("preserves possible application when a later retry is definitely rejected", async () => {
		const fetchMock = vi
			.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 403 }));
		const error = await api({ fetch: fetchMock })
			.uploadScript(SCRIPT_NAME, release(false))
			.catch((reason: unknown) => reason);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(error).toMatchObject({
			status: 403,
			retryable: false,
			ambiguous: false,
			mayHaveApplied: true,
		});
	});

	it("can delegate each durable script PUT as one actual HTTP attempt", async () => {
		const fetchMock = vi.fn(async () => {
			throw new TypeError("connection reset");
		});
		await api({ fetch: fetchMock, scriptUploadAttempts: 1 })
			.uploadScript(SCRIPT_NAME, release(false))
			.catch(() => undefined);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("bounds request time and marks an exhausted script PUT ambiguous", async () => {
		const hanging = vi.fn(
			async (_input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const error = await api({ fetch: hanging, requestTimeoutMs: 5 })
			.uploadScript(SCRIPT_NAME, release(false))
			.catch((reason: unknown) => reason);

		expect(hanging).toHaveBeenCalledTimes(3);
		expect(error).toMatchObject({ code: "WFP_TIMEOUT", retryable: true, ambiguous: true });
	});

	it("keeps the timeout active while reading a provider response body", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
			const body = new ReadableStream({
				start(controller) {
					init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
						once: true,
					});
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
		});
		const error = await api({ fetch: fetchMock, requestTimeoutMs: 5 })
			.uploadScript(SCRIPT_NAME, release())
			.catch((reason: unknown) => reason);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(error).toMatchObject({ code: "WFP_TIMEOUT", ambiguous: false });
	});

	it("does not claim ambiguity when the operation deadline expires before the PUT", async () => {
		const fetchMock = vi.fn(async () => Response.json({ success: true }));
		const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(120_001);
		const error = await api({ fetch: fetchMock, now })
			.uploadScript(SCRIPT_NAME, release(false))
			.catch((reason: unknown) => reason);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(error).toMatchObject({ code: "WFP_OPERATION_TIMEOUT", ambiguous: false });
	});

	it("rejects unsafe provider configuration and script names", async () => {
		expect(() => api({ accountId: "A".repeat(32) })).toThrow(/account/i);
		expect(() => api({ dispatchNamespace: "bad/name" })).toThrow(/namespace/i);
		await expect(api().uploadScript("../live", release(false))).rejects.toThrow(/script/i);
	});
});
