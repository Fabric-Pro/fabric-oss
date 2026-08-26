import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyRepositoryAccess } from "../repository-access";

/**
 * Direct coverage for the probe whose 401-vs-403-vs-404 classification IS the
 * repo-status feature: every consumer mocks this module, so a regression here
 * would otherwise ship green.
 */

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => {
	mockFetch.mockReset();
});

function response(status: number, ok = status >= 200 && status < 300) {
	return {
		ok,
		status,
		headers: new Headers(),
		// Successful probes now read default_branch from the payload.
		json: async () => ({ default_branch: "main" }),
	};
}

const githubInput = {
	provider: "GITHUB" as const,
	token: "t",
	repositoryUrl: "https://github.com/owner/repo",
	owner: "owner",
	repo: "repo",
};

describe("verifyRepositoryAccess", () => {
	it("probes GET /repos/{owner}/{repo} on api.github.com", async () => {
		mockFetch.mockResolvedValueOnce(response(200));
		await verifyRepositoryAccess(githubInput);
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://api.github.com/repos/owner/repo");
		expect(init.headers.Authorization).toBe("Bearer t");
		expect(init.headers.Accept).toContain("vnd.github");
	});

	it.each([
		[200, "accessible"],
		[401, "unauthorized"],
		[403, "forbidden"],
		[404, "not-found"],
		[500, "unreachable"],
	])("GitHub %i maps to %s", async (status, expected) => {
		mockFetch.mockResolvedValueOnce(response(status));
		const result = await verifyRepositoryAccess(githubInput);
		expect(result.outcome).toBe(expected);
	});

	// A rate-limit wall says nothing about access — the same token succeeds
	// after the window — so it must resolve inconclusive, never forbidden.
	it("GitHub 403 with the quota exhausted is unreachable, not forbidden", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 403,
			headers: new Headers({ "x-ratelimit-remaining": "0" }),
		});
		expect((await verifyRepositoryAccess(githubInput)).outcome).toBe(
			"unreachable",
		);
	});

	it("GitHub 403 with a retry-after is unreachable too (secondary limiter)", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 403,
			headers: new Headers({ "retry-after": "30" }),
		});
		expect((await verifyRepositoryAccess(githubInput)).outcome).toBe(
			"unreachable",
		);
	});

	it("GitHub 429 is unreachable", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 429,
			headers: new Headers(),
		});
		expect((await verifyRepositoryAccess(githubInput)).outcome).toBe(
			"unreachable",
		);
	});

	it("a network failure resolves to unreachable, never throws", async () => {
		mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		expect((await verifyRepositoryAccess(githubInput)).outcome).toBe(
			"unreachable",
		);
	});

	it("GitLab probes the project endpoint with PRIVATE-TOKEN when asked", async () => {
		mockFetch.mockResolvedValueOnce(response(200));
		await verifyRepositoryAccess({
			provider: "GITLAB",
			token: "glpat",
			gitlabAuth: "private-token",
			repositoryUrl: "https://gitlab.com/group/app",
			owner: "group",
			repo: "app",
		});
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe("https://gitlab.com/api/v4/projects/group%2Fapp");
		expect(init.headers["PRIVATE-TOKEN"]).toBe("glpat");
		expect(init.headers.Authorization).toBeUndefined();
	});

	it("GitLab defaults to a Bearer header for OAuth tokens", async () => {
		mockFetch.mockResolvedValueOnce(response(404));
		await verifyRepositoryAccess({
			provider: "GITLAB",
			token: "oauth-token",
			repositoryUrl: "https://gitlab.com/group/app",
			owner: "group",
			repo: "app",
		});
		const [, init] = mockFetch.mock.calls[0];
		expect(init.headers.Authorization).toBe("Bearer oauth-token");
	});
});
