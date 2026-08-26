/**
 * `listRepositoryBranches` — each listed branch carries its remote HEAD commit
 * SHA (for scan-staleness detection), read from the provider's own SHA field:
 * GitHub `commit.sha`, GitLab `commit.id`, Azure DevOps `objectId`. A branch
 * whose provider payload omits the SHA yields `commitSha: null`; name/ordering
 * and the closed failure-outcome set are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRepositoryBranches } from "../repository-branch";

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

function jsonResponse(status: number, body: unknown = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	};
}

const githubInput = {
	provider: "GITHUB" as const,
	token: "gh-token",
	repositoryUrl: "https://github.com/acme/widgets",
	owner: "acme",
	repo: "widgets",
};

const gitlabInput = {
	provider: "GITLAB" as const,
	token: "gl-token",
	repositoryUrl: "https://gitlab.example.com/acme/widgets",
	owner: "acme",
	repo: "widgets",
};

const adoInput = {
	provider: "AZURE_DEVOPS" as const,
	token: "ado-pat",
	repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/widgets",
	owner: "my-org",
	repo: "widgets",
	azureOrganization: "my-org",
};

describe("listRepositoryBranches — GitHub", () => {
	it("carries each branch's commit.sha and nulls a branch missing it", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, [
				{ name: "main", commit: { sha: "gh-sha-main" } },
				{ name: "dev", commit: { sha: "gh-sha-dev" } },
				{ name: "orphan" },
			]),
		);

		const result = await listRepositoryBranches(githubInput);

		expect(result).toEqual({
			ok: true,
			branches: [
				{ name: "main", commitSha: "gh-sha-main" },
				{ name: "dev", commitSha: "gh-sha-dev" },
				{ name: "orphan", commitSha: null },
			],
		});
	});
});

describe("listRepositoryBranches — GitLab", () => {
	it("carries each branch's commit.id and nulls a branch missing it", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, [
				{ name: "main", commit: { id: "gl-id-main" } },
				{ name: "feature/x", commit: { id: "gl-id-feat" } },
				{ name: "orphan" },
			]),
		);

		const result = await listRepositoryBranches(gitlabInput);

		expect(result).toEqual({
			ok: true,
			branches: [
				{ name: "main", commitSha: "gl-id-main" },
				{ name: "feature/x", commitSha: "gl-id-feat" },
				{ name: "orphan", commitSha: null },
			],
		});
	});
});

describe("listRepositoryBranches — Azure DevOps", () => {
	it("carries each head ref's objectId as the SHA and nulls a ref missing it", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				value: [
					{ name: "refs/heads/main", objectId: "ado-oid-main" },
					{ name: "refs/heads/release/1.2", objectId: "ado-oid-rel" },
					{ name: "refs/heads/orphan" },
					// A non-head ref is still excluded — name extraction unchanged.
					{ name: "refs/tags/v1", objectId: "ado-oid-tag" },
				],
			}),
		);

		const result = await listRepositoryBranches(adoInput);

		expect(result).toEqual({
			ok: true,
			branches: [
				{ name: "main", commitSha: "ado-oid-main" },
				{ name: "release/1.2", commitSha: "ado-oid-rel" },
				{ name: "orphan", commitSha: null },
			],
		});
	});
});

describe("listRepositoryBranches — failure path unchanged", () => {
	it("returns { ok: false } with the mapped outcome on a non-2xx", async () => {
		mockFetch.mockResolvedValue(jsonResponse(401));
		await expect(listRepositoryBranches(githubInput)).resolves.toEqual({
			ok: false,
			outcome: "unauthorized",
		});
	});

	it("resolves { ok: false, outcome: 'unreachable' } when fetch rejects", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(listRepositoryBranches(gitlabInput)).resolves.toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});
});
