import { describe, expect, it } from "vitest";
import {
	AuthValidationError,
	clearAuthCookie,
	requireSameOrigin,
	resolveIdentityBrokerUrl,
	serializeAccountCookie,
	serializeLoginCookie,
	validateReturnPath,
} from "../src/worker/account-auth.js";

describe("account auth request boundaries", () => {
	it("accepts only the landing page and project UUID return paths", () => {
		expect(validateReturnPath("/")).toBe("/");
		expect(validateReturnPath("/s/11111111-1111-4111-8111-111111111111")).toBe(
			"/s/11111111-1111-4111-8111-111111111111",
		);
		for (const value of ["https://evil.test", "//evil.test", "/api/auth/callback", "/s/nope"]) {
			expect(() => validateReturnPath(value)).toThrow(AuthValidationError);
		}
	});

	it("serializes production auth cookies as host-only HttpOnly Lax cookies", () => {
		expect(serializeLoginCookie("nonce", true)).toBe(
			"__Host-emdash_login=nonce; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
		);
		expect(serializeAccountCookie("token", true)).toContain(
			"__Host-emdash_session=token; Path=/; HttpOnly; Secure; SameSite=Lax",
		);
		expect(clearAuthCookie("account", true)).toContain("Max-Age=0");
	});

	it("rejects a present cross-origin mutation origin", () => {
		expect(() =>
			requireSameOrigin(
				new Request("https://build.example.test/api/auth/login", {
					method: "POST",
					headers: { Origin: "https://preview.build.example.test" },
				}),
			),
		).toThrow(AuthValidationError);
	});

	it("resolves a branch Preview callback from the current request origin", () => {
		const request = new Request(
			"https://feature-emdash-build.emdash-cms.workers.dev/api/auth/login?returnTo=%2F",
		);
		expect(resolveIdentityBrokerUrl(request, "request-origin").href).toBe(
			"https://feature-emdash-build.emdash-cms.workers.dev/api/auth/callback",
		);
		expect(
			resolveIdentityBrokerUrl(request, "https://build.emdashcms.com/api/auth/callback").href,
		).toBe("https://build.emdashcms.com/api/auth/callback");
	});
});
