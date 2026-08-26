/**
 * Tests for the `/api/cron/cleanup-oauth-states` hourly cleanup route.
 *
 * The route's only credential is `Authorization: Bearer ${CRON_SECRET}`. It
 * briefly also accepted the spoofable `vercel-cron` User-Agent while the secret
 * was unset, so a misconfigured environment kept purging expired OAuth states
 * instead of 401ing every tick (issue #2331); that fallback was removed because
 * it left the route open to anyone who set the header (issue #2883). These cases
 * pin the shared gate from this route's side: the bearer token in, everything
 * else out — including a Vercel-looking User-Agent, secret configured or not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cleanupExpiredOAuthStatesMock } = vi.hoisted(() => ({
	cleanupExpiredOAuthStatesMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	cleanupExpiredOAuthStates: cleanupExpiredOAuthStatesMock,
}));

import { GET } from "../route";

const CRON_SECRET = "test-cron-secret-123";

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://example.com/api/cron/cleanup-oauth-states", {
		method: "GET",
		headers,
	});
}

beforeEach(() => {
	cleanupExpiredOAuthStatesMock.mockReset();
	cleanupExpiredOAuthStatesMock.mockResolvedValue(0);
	vi.stubEnv("CRON_SECRET", CRON_SECRET);
});

afterEach(() => {
	// `vi.unstubAllEnvs` restores CRON_SECRET even when an assertion above it
	// throws — manual reassignment at the end of a test body does not.
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("GET /api/cron/cleanup-oauth-states", () => {
	it("rejects requests with no credentials at all", async () => {
		const res = await GET(makeRequest());
		expect(res.status).toBe(401);
		expect(cleanupExpiredOAuthStatesMock).not.toHaveBeenCalled();
	});

	it("rejects a wrong bearer token", async () => {
		const res = await GET(makeRequest({ authorization: "Bearer nope" }));
		expect(res.status).toBe(401);
		expect(cleanupExpiredOAuthStatesMock).not.toHaveBeenCalled();
	});

	it("accepts the configured cron secret", async () => {
		cleanupExpiredOAuthStatesMock.mockResolvedValueOnce(7);

		const res = await GET(
			makeRequest({ authorization: `Bearer ${CRON_SECRET}` }),
		);

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({
			success: true,
			deletedCount: 7,
		});
		expect(cleanupExpiredOAuthStatesMock).toHaveBeenCalledTimes(1);
	});

	it("rejects a spoofed vercel-cron User-Agent while CRON_SECRET is configured", async () => {
		// The User-Agent is client-controlled. It must never override a
		// configured secret, or the secret buys nothing.
		const res = await GET(makeRequest({ "user-agent": "vercel-cron/1.0" }));

		expect(res.status).toBe(401);
		expect(cleanupExpiredOAuthStatesMock).not.toHaveBeenCalled();
	});

	it("rejects the vercel-cron User-Agent when CRON_SECRET is unset — the fallback is gone", async () => {
		vi.stubEnv("CRON_SECRET", "");

		const res = await GET(makeRequest({ "user-agent": "vercel-cron/1.0" }));

		expect(res.status).toBe(401);
		expect(cleanupExpiredOAuthStatesMock).not.toHaveBeenCalled();
	});

	it("does not authorize on a bare `Bearer undefined` header when CRON_SECRET is unset", async () => {
		vi.stubEnv("CRON_SECRET", "");

		const res = await GET(
			makeRequest({ authorization: "Bearer undefined" }),
		);

		expect(res.status).toBe(401);
		expect(cleanupExpiredOAuthStatesMock).not.toHaveBeenCalled();
	});

	it("returns 500 when the cleanup query throws", async () => {
		cleanupExpiredOAuthStatesMock.mockRejectedValueOnce(
			new Error("db down"),
		);

		const res = await GET(
			makeRequest({ authorization: `Bearer ${CRON_SECRET}` }),
		);

		expect(res.status).toBe(500);
		await expect(res.json()).resolves.toMatchObject({
			success: false,
			error: "db down",
		});
	});
});
