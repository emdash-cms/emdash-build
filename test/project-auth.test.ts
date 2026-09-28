import { describe, expect, it } from "vitest";
import {
	clearGuestCookie,
	equalTokenDigest,
	hashGuestToken,
	httpsRedirectForRequest,
	projectIdFromAgentPath,
	readCookie,
	readGuestToken,
	serializeGuestCookie,
} from "../src/worker/project-auth.js";
import { readVerifiedAgentAuth, withVerifiedAgentAuth } from "../src/worker/agent-authorization.js";

describe("guest project authorization", () => {
	it("reads an encoded cookie without accepting a similarly named cookie", () => {
		const request = new Request("https://build.example.test", {
			headers: { Cookie: "other=1; emdash_guest=hello%20world; emdash_guest_extra=no" },
		});
		expect(readCookie(request, "emdash_guest")).toBe("hello world");
	});

	it("accepts only the host-prefixed production guest cookie", () => {
		expect(
			readGuestToken(
				new Request("https://build.example.test", {
					headers: {
						Cookie: "emdash_guest=attacker; __Host-emdash_guest=trusted",
					},
				}),
			),
		).toBe("trusted");
		expect(
			readGuestToken(
				new Request("https://build.example.test", {
					headers: { Cookie: "emdash_guest=attacker" },
				}),
			),
		).toBeUndefined();
		expect(
			readGuestToken(
				new Request("http://localhost", {
					headers: { Cookie: "emdash_guest_local=developer" },
				}),
			),
		).toBe("developer");
		expect(
			readGuestToken(
				new Request("http://build.example.test", {
					headers: { Cookie: "emdash_guest_local=attacker" },
				}),
			),
		).toBeUndefined();
		expect(
			readGuestToken(
				new Request("http://[::1]", {
					headers: { Cookie: "emdash_guest_local=unsupported" },
				}),
			),
		).toBeUndefined();
	});

	it("redirects production HTTP while keeping localhost development on HTTP", () => {
		expect(httpsRedirectForRequest(new Request("http://build.example.test/api/health"))?.href).toBe(
			"https://build.example.test/api/health",
		);
		expect(
			httpsRedirectForRequest(new Request("http://localhost:5173/api/health")),
		).toBeUndefined();
		expect(
			httpsRedirectForRequest(new Request("http://127.0.0.1:5173/api/health")),
		).toBeUndefined();
		expect(httpsRedirectForRequest(new Request("http://[::1]:5173/api/health"))?.protocol).toBe(
			"https:",
		);
	});

	it("hashes bearer tokens and compares only matching digests", async () => {
		const first = await hashGuestToken("first");
		const same = await hashGuestToken("first");
		const other = await hashGuestToken("other");
		expect(equalTokenDigest(first, same)).toBe(true);
		expect(equalTokenDigest(first, other)).toBe(false);
		expect(equalTokenDigest(first, `${same}0`)).toBe(false);
	});

	it("serializes distinct host-only production and local guest cookies", () => {
		expect(serializeGuestCookie("token", true)).toBe(
			"__Host-emdash_guest=token; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure",
		);
		expect(serializeGuestCookie("token", false)).toBe(
			"emdash_guest_local=token; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000",
		);
		expect(clearGuestCookie(true)).toContain("__Host-emdash_guest=; ");
		expect(clearGuestCookie(false)).toContain("emdash_guest_local=; ");
	});

	it("extracts only BuilderAgent project routes", () => {
		expect(projectIdFromAgentPath("/agents/builder-agent/project-1")).toBe("project-1");
		expect(projectIdFromAgentPath("/agents/BuilderAgent/project%202/socket")).toBe("project 2");
		expect(projectIdFromAgentPath("/agents/another-agent/project-1")).toBeUndefined();
	});

	it("overwrites untrusted internal Agent authorization headers", () => {
		const request = withVerifiedAgentAuth(
			new Request("https://build.example.test/agents/BuilderAgent/project", {
				headers: {
					"X-EmDash-Internal-Owner": "attacker",
					"X-EmDash-Internal-Session": "attacker",
				},
			}),
			{
				ownerKey: "account:owner",
				kind: "account",
				sessionHash: "session",
				expiresAt: 123,
			},
		);
		expect(readVerifiedAgentAuth(request)).toEqual({
			ownerKey: "account:owner",
			kind: "account",
			sessionHash: "session",
			expiresAt: 123,
		});
	});
});
