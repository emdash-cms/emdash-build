import { describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
	AccessAssertionVerifier,
	AssertionIdentityAdapter,
	UnconfiguredIdentityAdapter,
} from "../src/platform/identity.js";

describe("identity adapters", () => {
	it("does not trust identity without a verified assertion", async () => {
		const verify = vi.fn(async () => ({ issuer: "issuer", subject: "subject" }));
		const adapter = new AssertionIdentityAdapter(new URL("https://auth.example.test/login"), {
			verify,
		});
		expect(
			await adapter.resolveCallback(new Request("https://build.example.test")),
		).toBeUndefined();
		expect(verify).not.toHaveBeenCalled();
	});

	it("maps only the verifier result to an account principal", async () => {
		const adapter = new AssertionIdentityAdapter(new URL("https://auth.example.test/login"), {
			verify: async () => ({ issuer: "https://issuer.example.test", subject: "account-1" }),
		});
		const request = new Request("https://build.example.test", {
			headers: { "Cf-Access-Jwt-Assertion": "opaque-signed-value" },
		});
		expect(await adapter.resolveCallback(request)).toEqual({
			kind: "account",
			issuer: "https://issuer.example.test",
			subject: "account-1",
		});
	});

	it("fails closed when no provider is configured", async () => {
		const adapter = new UnconfiguredIdentityAdapter();
		expect(
			await adapter.resolveCallback(new Request("https://build.example.test")),
		).toBeUndefined();
		await expect(
			adapter.beginLogin({
				state: "state",
				callbackUrl: new URL("https://build.example.test/api/auth/callback"),
			}),
		).rejects.toThrow("No identity provider is configured");
	});

	it("builds a login URL from the server state and callback", async () => {
		const adapter = new AssertionIdentityAdapter(
			new URL("https://build.example.test/api/auth/callback"),
			{
				verify: async () => ({ issuer: "issuer", subject: "subject" }),
			},
		);
		const url = await adapter.beginLogin({
			state: "server-state",
			callbackUrl: new URL("https://build.example.test/api/auth/callback"),
		});
		expect(url.href).toBe("https://build.example.test/api/auth/callback?state=server-state");
	});
});

describe("Access assertion verification", () => {
	it("verifies signature, issuer, audience, type, and subject", async () => {
		const issuer = "https://example.cloudflareaccess.com";
		const audience = "access-audience";
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const jwk = await exportJWK(publicKey);
		const verifier = new AccessAssertionVerifier(
			issuer,
			audience,
			createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] }),
		);
		const token = await new SignJWT({ type: "app" })
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setIssuer(issuer)
			.setAudience(audience)
			.setSubject("account-1")
			.setIssuedAt()
			.setNotBefore("0s")
			.setExpirationTime("5m")
			.sign(privateKey);

		await expect(verifier.verify(token)).resolves.toEqual({ issuer, subject: "account-1" });
	});

	it("rejects the wrong audience and service tokens", async () => {
		const issuer = "https://example.cloudflareaccess.com";
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const jwk = await exportJWK(publicKey);
		const verifier = new AccessAssertionVerifier(
			issuer,
			"expected",
			createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] }),
		);
		const wrongAudience = await new SignJWT({ type: "app" })
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setIssuer(issuer)
			.setAudience("wrong")
			.setSubject("account-1")
			.setIssuedAt()
			.setNotBefore("0s")
			.setExpirationTime("5m")
			.sign(privateKey);
		const serviceToken = await new SignJWT({ type: "app" })
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setIssuer(issuer)
			.setAudience("expected")
			.setSubject("")
			.setIssuedAt()
			.setNotBefore("0s")
			.setExpirationTime("5m")
			.sign(privateKey);

		await expect(verifier.verify(wrongAudience)).rejects.toThrow();
		await expect(verifier.verify(serviceToken)).rejects.toThrow("subject");
	});

	it("requires expiry and not-before claims", async () => {
		const issuer = "https://example.cloudflareaccess.com";
		const audience = "expected";
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const jwk = await exportJWK(publicKey);
		const verifier = new AccessAssertionVerifier(
			issuer,
			audience,
			createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] }),
		);
		const missingTimes = await new SignJWT({ type: "app" })
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setIssuer(issuer)
			.setAudience(audience)
			.setSubject("account-1")
			.sign(privateKey);
		const future = await new SignJWT({ type: "app" })
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setIssuer(issuer)
			.setAudience(audience)
			.setSubject("account-1")
			.setIssuedAt()
			.setNotBefore("5m")
			.setExpirationTime("10m")
			.sign(privateKey);

		await expect(verifier.verify(missingTimes)).rejects.toThrow();
		await expect(verifier.verify(future)).rejects.toThrow();
	});
});
