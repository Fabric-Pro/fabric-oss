import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitLabApiError, gitlabRequest } from "../rest-client";

describe("gitlabRequest", () => {
	const originalFetch = global.fetch;
	beforeEach(() => {
		global.fetch = vi.fn();
	});
	afterEach(() => {
		global.fetch = originalFetch;
		vi.useRealTimers();
	});

	it("returns parsed JSON on 2xx", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			new Response(JSON.stringify({ id: 1 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const result = await gitlabRequest<{ id: number }>({
			path: "/user",
			token: "t",
		});
		expect(result.body).toEqual({ id: 1 });
		expect(result.status).toBe(200);
	});

	it("throws GitLabApiError on 4xx with parsed message", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "404 Not Found" }), {
				status: 404,
				headers: {
					"Content-Type": "application/json",
					"X-Request-Id": "req-1",
				},
			}),
		);
		await expect(
			gitlabRequest({ path: "/projects/0", token: "t" }),
		).rejects.toMatchObject({
			name: "GitLabApiError",
			status: 404,
			requestId: "req-1",
		});
	});

	it("retries once on 429 honoring RateLimit-Reset", async () => {
		vi.useFakeTimers();
		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
		const resetAt = Math.floor(Date.now() / 1000) + 1;
		fetchMock
			.mockResolvedValueOnce(
				new Response("", {
					status: 429,
					headers: { "RateLimit-Reset": String(resetAt) },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		const promise = gitlabRequest({ path: "/user", token: "t" });
		await vi.advanceTimersByTimeAsync(2_000);
		const result = await promise;
		expect(result.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("re-issues request once on 401 if onRefreshToken supplied", async () => {
		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
		fetchMock
			.mockResolvedValueOnce(new Response("", { status: 401 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		const onRefreshToken = vi.fn().mockResolvedValue("new-token");
		const result = await gitlabRequest({
			path: "/user",
			token: "old-token",
			onRefreshToken,
		});
		expect(result.status).toBe(200);
		expect(onRefreshToken).toHaveBeenCalledTimes(1);
		const secondCall = fetchMock.mock.calls[1]?.[1] as RequestInit;
		expect(
			(secondCall.headers as Record<string, string>).Authorization,
		).toBe("Bearer new-token");
	});

	it("throws GitLabApiError(401) when no onRefreshToken supplied", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
		);
		await expect(
			gitlabRequest({ path: "/user", token: "t" }),
		).rejects.toMatchObject({
			name: "GitLabApiError",
			status: 401,
		});
	});

	it("wraps fetch network errors as GitLabApiError(0, NETWORK_ERROR)", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new TypeError("fetch failed"),
		);
		await expect(
			gitlabRequest({ path: "/user", token: "t" }),
		).rejects.toMatchObject({
			name: "GitLabApiError",
			status: 0,
			code: "NETWORK_ERROR",
		});
	});

	it("wraps onRefreshToken throw as GitLabApiError(401, REFRESH_FAILED)", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			new Response("", { status: 401 }),
		);
		const onRefreshToken = vi
			.fn()
			.mockRejectedValue(new Error("refresh blew up"));
		await expect(
			gitlabRequest({ path: "/user", token: "t", onRefreshToken }),
		).rejects.toMatchObject({
			name: "GitLabApiError",
			status: 401,
			code: "REFRESH_FAILED",
		});
	});

	it("returns null body for non-JSON 2xx", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			new Response("ok", {
				status: 200,
				headers: { "Content-Type": "text/plain" },
			}),
		);
		const result = await gitlabRequest({ path: "/user", token: "t" });
		expect(result.body).toBeNull();
		expect(result.status).toBe(200);
	});

	it("populates code from X-Gitlab-Error-Code header", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "limit exceeded" }), {
				status: 422,
				headers: {
					"Content-Type": "application/json",
					"X-Gitlab-Error-Code": "limit_exceeded",
				},
			}),
		);
		await expect(
			gitlabRequest({ path: "/projects", token: "t" }),
		).rejects.toMatchObject({
			name: "GitLabApiError",
			status: 422,
			code: "limit_exceeded",
		});
	});

	it("propagates OAuth error_description from JSON body", async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: "invalid_token",
					error_description: "token revoked",
				}),
				{
					status: 401,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		await expect(
			gitlabRequest({ path: "/user", token: "t" }),
		).rejects.toMatchObject({
			name: "GitLabApiError",
			status: 401,
			message: "token revoked",
		});
	});

	it("throws if GitLabApiError constructor receives non-integer status", () => {
		expect(
			() => new GitLabApiError("404" as unknown as number, "bad"),
		).toThrow(/status must be an integer/);
	});

	it("sets retryAfterMs on 429 after retry exhausted", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
		const firstResetAt = Math.floor(Date.now() / 1000) + 1;
		const secondResetAt = Math.floor(Date.now() / 1000) + 5;
		fetchMock
			.mockResolvedValueOnce(
				new Response("", {
					status: 429,
					headers: { "RateLimit-Reset": String(firstResetAt) },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: "rate limited" }), {
					status: 429,
					headers: {
						"Content-Type": "application/json",
						"RateLimit-Reset": String(secondResetAt),
					},
				}),
			);
		const promise = gitlabRequest({ path: "/user", token: "t" });
		const expectation = expect(promise).rejects.toMatchObject({
			name: "GitLabApiError",
			status: 429,
		});
		await vi.advanceTimersByTimeAsync(2_000);
		await expectation;
		// Re-await for retryAfterMs check
		try {
			await promise;
		} catch (err) {
			expect(err).toBeInstanceOf(GitLabApiError);
			const gitlabErr = err as GitLabApiError;
			expect(gitlabErr.retryAfterMs).not.toBeNull();
			expect(gitlabErr.retryAfterMs).toBeGreaterThanOrEqual(0);
			// 5 seconds from initial system time minus the 1s wait already consumed
			// by the first retry = 4000 ms.
			expect(gitlabErr.retryAfterMs).toBe(4_000);
		}
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});
