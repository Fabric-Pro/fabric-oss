import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------
// Imports (AFTER mocks are set up)
// ---------------------------------------------------------------------------

import { verifyTurnstileToken } from "../turnstile";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalEnv = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("verifyTurnstileToken", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		// Reset env
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.restoreAllMocks();
	});

	describe("when CAPTCHA is disabled", () => {
		it("returns success without calling Cloudflare API", async () => {
			setEnv({ NEXT_PUBLIC_ENABLE_CAPTCHA: "false" });
			const fetchSpy = vi.spyOn(globalThis, "fetch");

			const result = await verifyTurnstileToken("", "127.0.0.1");

			expect(result.success).toBe(true);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("returns success even without a token", async () => {
			setEnv({ NEXT_PUBLIC_ENABLE_CAPTCHA: undefined });

			const result = await verifyTurnstileToken("", "127.0.0.1");

			expect(result.success).toBe(true);
		});
	});

	describe("when CAPTCHA is enabled", () => {
		beforeEach(() => {
			setEnv({
				NEXT_PUBLIC_ENABLE_CAPTCHA: "true",
				TURNSTILE_SECRET_KEY: "test-secret-key",
			});
		});

		it("returns failure when token is empty", async () => {
			const result = await verifyTurnstileToken("", "127.0.0.1");

			expect(result.success).toBe(false);
			expect(result.errorCodes).toContain("missing-input-response");
		});

		it("returns success when Cloudflare API confirms token", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true }), {
					status: 200,
				}),
			);

			const result = await verifyTurnstileToken(
				"valid-token",
				"127.0.0.1",
			);

			expect(result.success).toBe(true);
			expect(globalThis.fetch).toHaveBeenCalledOnce();
		});

		it("returns failure when Cloudflare API rejects token", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: false,
						"error-codes": ["invalid-input-response"],
					}),
					{ status: 200 },
				),
			);

			const result = await verifyTurnstileToken(
				"invalid-token",
				"127.0.0.1",
			);

			expect(result.success).toBe(false);
			expect(result.errorCodes).toContain("invalid-input-response");
		});

		it("fails closed when Cloudflare API returns non-OK status", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
				new Response("Internal Server Error", { status: 500 }),
			);

			const result = await verifyTurnstileToken(
				"some-token",
				"127.0.0.1",
			);

			expect(result.success).toBe(false);
			expect(result.errorCodes).toContain("captcha-unavailable");
		});

		it("fails closed when fetch throws a network error", async () => {
			vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
				new Error("Network error"),
			);

			const result = await verifyTurnstileToken(
				"some-token",
				"127.0.0.1",
			);

			expect(result.success).toBe(false);
			expect(result.errorCodes).toContain("captcha-unavailable");
		});

		it("fails closed when secret key is not configured", async () => {
			setEnv({ TURNSTILE_SECRET_KEY: undefined });

			const result = await verifyTurnstileToken(
				"some-token",
				"127.0.0.1",
			);

			expect(result.success).toBe(false);
			expect(result.errorCodes).toContain("captcha-unavailable");
		});

		it("sends correct body to Cloudflare API", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ success: true }), {
						status: 200,
					}),
				);

			await verifyTurnstileToken("test-token", "192.168.1.1");

			expect(fetchSpy).toHaveBeenCalledWith(
				"https://challenges.cloudflare.com/turnstile/v0/siteverify",
				expect.objectContaining({
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
				}),
			);

			// Verify the body contains correct params
			const call = fetchSpy.mock.calls[0];
			const body = call[1]?.body as URLSearchParams;
			expect(body.get("secret")).toBe("test-secret-key");
			expect(body.get("response")).toBe("test-token");
			expect(body.get("remoteip")).toBe("192.168.1.1");
		});

		it("omits remoteip when client IP is unknown", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ success: true }), {
						status: 200,
					}),
				);

			await verifyTurnstileToken("test-token", "unknown");

			const call = fetchSpy.mock.calls[0];
			const body = call[1]?.body as URLSearchParams;
			expect(body.get("secret")).toBe("test-secret-key");
			expect(body.get("response")).toBe("test-token");
			expect(body.has("remoteip")).toBe(false);
		});
	});
});
