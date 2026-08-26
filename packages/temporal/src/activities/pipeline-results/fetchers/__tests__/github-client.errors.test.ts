/**
 * The GitHub client's failure path, end to end through the real classifier.
 *
 * `provider-http-error.test.ts` proves the classifier decides correctly. This
 * proves the client actually ASKS it — the wiring is three lines, and the bug
 * being guarded is precisely that those three lines were once an inline string
 * that said "authentication failed — check the connected GitHub token and its
 * scope (Actions: read)" for every 401 and 403 alike, with the response body
 * read only for other statuses and discarded for those two.
 *
 * That is why the Foundry bench's 403 could not be diagnosed from the outside:
 * the sentence GitHub sent explaining itself was thrown away before anyone saw
 * it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubTokenClient } from "../github-client";
import { ProviderHttpError } from "../provider-http-error";

const realFetch = globalThis.fetch;

function mockFetch(
	status: number,
	headers: Record<string, string>,
	body: string,
) {
	globalThis.fetch = vi.fn(
		async () => new Response(body, { status, headers }),
	) as unknown as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

describe("createGithubTokenClient error reporting", () => {
	it("does not blame the credential when GitHub is rate limiting", async () => {
		mockFetch(
			403,
			{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
			'{"message":"API rate limit exceeded"}',
		);
		const client = createGithubTokenClient("tok");

		await expect(client.get("/repos/a/b/actions/runs")).rejects.toThrow(
			/does not need reconnecting/i,
		);
	});

	it("carries GitHub's own explanation on the error, apart from the message", async () => {
		// The half that made the live failure undiagnosable. It is kept as a
		// property rather than concatenated into the message, so the banner can
		// show a readable sentence and reveal this on hover.
		mockFetch(
			403,
			{},
			'{"message":"Resource protected by organization SAML enforcement"}',
		);
		const client = createGithubTokenClient("tok");

		const err = await client
			.get("/repos/a/b/actions/runs")
			.catch((e: unknown) => e);

		expect(err).toBeInstanceOf(ProviderHttpError);
		expect((err as ProviderHttpError).providerDetail).toContain(
			"Resource protected by organization SAML enforcement",
		);
		expect((err as ProviderHttpError).kind).toBe("FORBIDDEN");
		// And the readable half stays free of the JSON.
		expect((err as Error).message).not.toContain('{"message"');
	});

	it("hands back the SSO authorisation URL when GitHub offers one", async () => {
		mockFetch(
			403,
			{
				"x-github-sso":
					"https://github.com/orgs/acme/sso?authorization_request=x",
			},
			'{"message":"Resource protected by organization SAML enforcement"}',
		);
		const client = createGithubTokenClient("tok");

		await expect(client.get("/repos/a/b/actions/runs")).rejects.toThrow(
			/authorization_request=x/,
		);
	});

	it("still advises reconnecting on a genuine 401", async () => {
		mockFetch(401, {}, '{"message":"Bad credentials"}');
		const client = createGithubTokenClient("tok");

		await expect(client.get("/repos/a/b/actions/runs")).rejects.toThrow(
			/reconnect/i,
		);
	});

	it("keeps the status and path in the message", async () => {
		// Both are what makes a worker log searchable.
		mockFetch(500, {}, "boom");
		const client = createGithubTokenClient("tok");

		await expect(client.get("/repos/a/b/actions/runs")).rejects.toThrow(
			/\(500\) for \/repos\/a\/b\/actions\/runs/,
		);
	});

	it("rejects an artifact from Content-Length before buffering it", async () => {
		mockFetch(200, { "content-length": String(50 * 1024 * 1024 + 1) }, "x");
		const client = createGithubTokenClient("tok");

		await expect(client.getArtifactZip("/artifact/1/zip")).rejects.toThrow(
			/download limit/i,
		);
	});
});
