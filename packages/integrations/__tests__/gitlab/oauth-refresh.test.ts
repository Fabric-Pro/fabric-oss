import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
	GitLabReauthRequiredError,
	refreshGitLabToken,
} from "../../src/gitlab/oauth-refresh";

describe("refreshGitLabToken", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("throws GitLabReauthRequiredError when HTTP non-OK body is invalid_grant", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: "invalid_grant",
					error_description: "Refresh token revoked",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(
			refreshGitLabToken("dead-refresh", "client-id", "client-secret"),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("throws GitLabReauthRequiredError when HTTP non-OK body is invalid_token", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: "invalid_token",
					error_description: "Token was revoked",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await expect(
			refreshGitLabToken("dead-refresh", "client-id", "client-secret"),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("throws a plain Error on a 401 carrying unauthorized_client", async () => {
		// `unauthorized_client` is the OAUTH APPLICATION being refused, not
		// the user's grant. Reconnecting cannot fix it, so it must not reach
		// the breaker that only a user reconnect clears.
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "unauthorized_client" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const err = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("throws a plain Error on a 401 carrying invalid_client", async () => {
		// Same class of failure as `unauthorized_client`: the application's
		// own credentials are wrong or revoked. Every user of the app would
		// see this 401, and condemning all of their grants over a
		// configuration mistake is the worst available response.
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "invalid_client" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const err = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("throws a plain Error on HTTP 403", async () => {
		// A 403 can be instance policy, an authentication ban or a proxy in
		// front of a self-hosted instance. None of those identify the user's
		// grant as the thing that failed.
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "access_denied" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const err = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("throws a plain Error on a 401 whose body is not JSON", async () => {
		// Self-hosted instances behind a proxy answer with an HTML error page.
		// There is no OAuth error code to read, so nothing decisive is left —
		// and a bare status is not evidence the grant died.
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("<html><body>401 Unauthorized</body></html>", {
				status: 401,
				headers: { "Content-Type": "text/html" },
			}),
		);

		const err = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
		expect((err as Error).message).toMatch(
			/GitLab token refresh failed: 401/,
		);
	});

	it("throws a plain Error on a 429 (rate limited)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "too_many_requests" }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const err = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
		expect((err as Error).message).toMatch(
			/GitLab token refresh failed: 429/,
		);
	});

	it("throws a plain Error on an unrecognized OAuth error code", async () => {
		// Anything outside `invalid_grant` / `invalid_token` is undecisive,
		// including on a 200 body.
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: "temporarily_unavailable",
					error_description: "Try again shortly",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const err = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
		expect((err as Error).message).toMatch(/Try again shortly/);
	});

	it("throws a plain Error when the request never reaches GitLab", async () => {
		// A DNS/TLS/connection failure rejects before any status exists.
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
			new TypeError("fetch failed"),
		);

		const err = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		).catch((e: unknown) => e);

		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("throws GitLabReauthRequiredError when HTTP 200 body carries error=invalid_grant", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "invalid_grant" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(
			refreshGitLabToken("dead-refresh", "client-id", "client-secret"),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("throws GitLabReauthRequiredError when HTTP 200 body carries error=invalid_token", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "invalid_token" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(
			refreshGitLabToken("dead-refresh", "client-id", "client-secret"),
		).rejects.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("throws generic Error on HTTP 500", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("Server Error", { status: 500 }),
		);

		const err = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		).catch((e: unknown) => e);

		// A 5xx says nothing about the credential. Arriving as
		// GitLabReauthRequiredError would let an outage condemn every
		// integration that happened to refresh during it.
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
		expect((err as Error).message).toMatch(
			/GitLab token refresh failed: 500/,
		);
	});

	it("bounds the exchange with an AbortSignal.timeout at GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS, so a hanging GitLab response cannot outrun the advisory-lock transaction", async () => {
		// Spy on the real `AbortSignal.timeout`, not just the passed
		// `signal`'s type: `expect(init.signal).toBeInstanceOf(AbortSignal)`
		// alone is satisfied by ANY AbortSignal, including a plain
		// `new AbortController().signal` that would never fire on its own —
		// it proves nothing about there being an actual bound, let alone the
		// right one.
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({ access_token: "tok", expires_in: 7200 }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		await refreshGitLabToken("refresh", "client-id", "client-secret");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		// A REAL timeout signal, at the exact documented bound.
		expect(timeoutSpy).toHaveBeenCalledWith(
			GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS,
		);
		// And it's the SAME signal object `fetch` actually received — not a
		// coincidentally-equal one constructed some other way.
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(init.signal).toBe(timeoutSpy.mock.results[0]?.value);
	});

	it("does not classify an aborted/timed-out exchange as a dead grant", async () => {
		// What AbortSignal.timeout(...) actually produces when it fires —
		// a DOMException named "TimeoutError", not an HTTP response at all.
		// `refreshGitLabToken` never wraps the `fetch` call in a try/catch of
		// its own, so this must propagate UNCHANGED: never
		// GitLabReauthRequiredError, which is reserved for a positive
		// provider verdict (`invalid_grant` / `invalid_token`) and — enforced
		// downstream — condemns the credential until the user reconnects. A
		// request that never got a response is not that evidence.
		const timeoutError = new DOMException(
			"The operation was aborted due to timeout",
			"TimeoutError",
		);
		vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(timeoutError);

		const err = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		).catch((e: unknown) => e);

		expect(err).toBe(timeoutError);
		expect(err).not.toBeInstanceOf(GitLabReauthRequiredError);
	});

	it("GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS stays a sane bound (used by the transaction-budget invariant tests)", () => {
		// Sanity guard, not a duplicate of the arithmetic assertions in
		// get-valid-access-token.test.ts / gitlab-token.test.ts: this just
		// pins that the exported constant is what those tests assume it is,
		// so a change here fails loudly at the source instead of only in a
		// budget test elsewhere.
		expect(GITLAB_TOKEN_EXCHANGE_TIMEOUT_MS).toBe(10_000);
	});

	it("returns the refresh payload on success", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					access_token: "new-token",
					refresh_token: "new-refresh",
					expires_in: 7200,
					token_type: "Bearer",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);

		const result = await refreshGitLabToken(
			"refresh",
			"client-id",
			"client-secret",
		);
		expect(result.access_token).toBe("new-token");
		expect(result.refresh_token).toBe("new-refresh");
	});
});
