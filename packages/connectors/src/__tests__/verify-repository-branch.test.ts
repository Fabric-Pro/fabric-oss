/**
 * `verifyRepositoryBranch` — per-provider remote existence checks.
 *
 * Locks the contract: each provider maps 200 → "exists", 404 → "not-found",
 * 401/403 → "unauthorized", and network/5xx → "unreachable"; branch names with
 * slashes (release/1.2) are URL-encoded; the helper never throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyRepositoryBranch } from "../repository-branch";

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
	branch: "main",
};

const gitlabInput = {
	provider: "GITLAB" as const,
	token: "gl-token",
	repositoryUrl: "https://gitlab.example.com/acme/widgets",
	owner: "acme",
	repo: "widgets",
	branch: "main",
};

const adoInput = {
	provider: "AZURE_DEVOPS" as const,
	token: "ado-pat",
	repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/widgets",
	owner: "my-org",
	repo: "widgets",
	azureOrganization: "my-org",
	branch: "main",
};

describe("verifyRepositoryBranch — GitHub", () => {
	it("returns 'exists' for a 200 and calls the branches endpoint with a Bearer token", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, { name: "main" }));

		const outcome = await verifyRepositoryBranch(githubInput);

		expect(outcome).toBe("exists");
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe(
			"https://api.github.com/repos/acme/widgets/branches/main",
		);
		expect(init.headers.Authorization).toBe("Bearer gh-token");
	});

	it("returns 'not-found' for a 404", async () => {
		mockFetch.mockResolvedValue(jsonResponse(404));
		await expect(verifyRepositoryBranch(githubInput)).resolves.toBe(
			"not-found",
		);
	});

	it("returns 'unauthorized' for 401 and 403", async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse(401));
		await expect(verifyRepositoryBranch(githubInput)).resolves.toBe(
			"unauthorized",
		);
		mockFetch.mockResolvedValueOnce(jsonResponse(403));
		await expect(verifyRepositoryBranch(githubInput)).resolves.toBe(
			"unauthorized",
		);
	});

	it("returns 'unreachable' for a 5xx", async () => {
		mockFetch.mockResolvedValue(jsonResponse(502));
		await expect(verifyRepositoryBranch(githubInput)).resolves.toBe(
			"unreachable",
		);
	});

	it("URL-encodes a slashed branch name (release/1.2)", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200));

		await verifyRepositoryBranch({ ...githubInput, branch: "release/1.2" });

		const [url] = mockFetch.mock.calls[0];
		expect(url).toBe(
			"https://api.github.com/repos/acme/widgets/branches/release%2F1.2",
		);
	});
});

describe("verifyRepositoryBranch — GitLab", () => {
	it("hits the API v4 branches endpoint on the pinned gitlab.com host", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, { name: "main" }));

		const outcome = await verifyRepositoryBranch(gitlabInput);

		expect(outcome).toBe("exists");
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe(
			"https://gitlab.com/api/v4/projects/acme%2Fwidgets/repository/branches/main",
		);
		expect(init.headers.Authorization).toBe("Bearer gl-token");
	});

	// SSRF pin (Fizzy #2252 follow-up): a stored URL naming another host must
	// not steer these authenticated requests off gitlab.com.
	it("pins the host to gitlab.com even when the stored URL names another host", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, { name: "main" }));

		await verifyRepositoryBranch({
			...gitlabInput,
			repositoryUrl: "https://internal-host.attacker.tld/acme/widgets",
		});

		const [url] = mockFetch.mock.calls[0];
		expect(url).toMatch(/^https:\/\/gitlab\.com\//);
	});

	it("authenticates GitLab PATs with PRIVATE-TOKEN when told to", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, { name: "main" }));

		await verifyRepositoryBranch({
			...gitlabInput,
			gitlabAuth: "private-token",
		});

		const [, init] = mockFetch.mock.calls[0];
		expect(init.headers["PRIVATE-TOKEN"]).toBe("gl-token");
		expect(init.headers.Authorization).toBeUndefined();
	});

	it("returns 'not-found' for a 404", async () => {
		mockFetch.mockResolvedValue(jsonResponse(404));
		await expect(verifyRepositoryBranch(gitlabInput)).resolves.toBe(
			"not-found",
		);
	});

	it("returns 'unauthorized' for a 401", async () => {
		mockFetch.mockResolvedValue(jsonResponse(401));
		await expect(verifyRepositoryBranch(gitlabInput)).resolves.toBe(
			"unauthorized",
		);
	});

	it("URL-encodes both the project path and a slashed branch", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200));

		await verifyRepositoryBranch({ ...gitlabInput, branch: "release/1.2" });

		const [url] = mockFetch.mock.calls[0];
		expect(url).toContain("/repository/branches/release%2F1.2");
	});
});

describe("verifyRepositoryBranch — Azure DevOps", () => {
	it("returns 'exists' only when the prefix-filtered refs include the exact branch", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				value: [
					{ name: "refs/heads/main-backup" },
					{ name: "refs/heads/main" },
				],
			}),
		);

		const outcome = await verifyRepositoryBranch(adoInput);

		expect(outcome).toBe("exists");
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toContain(
			"https://dev.azure.com/my-org/Proj/_apis/git/repositories/widgets/refs?",
		);
		expect(url).toContain("filter=heads%2Fmain");
		expect(init.headers.Authorization).toMatch(/^Basic /);
	});

	it("returns 'not-found' when the prefix filter matches only other branches", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, { value: [{ name: "refs/heads/main-backup" }] }),
		);
		await expect(verifyRepositoryBranch(adoInput)).resolves.toBe(
			"not-found",
		);
	});

	it("returns 'not-found' for an empty refs list", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, { value: [] }));
		await expect(verifyRepositoryBranch(adoInput)).resolves.toBe(
			"not-found",
		);
	});

	it("returns 'unauthorized' for 401 and for ADO's 203 sign-in-page quirk", async () => {
		mockFetch.mockResolvedValueOnce(jsonResponse(401));
		await expect(verifyRepositoryBranch(adoInput)).resolves.toBe(
			"unauthorized",
		);
		mockFetch.mockResolvedValueOnce(jsonResponse(203));
		await expect(verifyRepositoryBranch(adoInput)).resolves.toBe(
			"unauthorized",
		);
	});

	it("matches a slashed branch exactly via the refs filter", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, { value: [{ name: "refs/heads/release/1.2" }] }),
		);

		const outcome = await verifyRepositoryBranch({
			...adoInput,
			branch: "release/1.2",
		});

		expect(outcome).toBe("exists");
		const [url] = mockFetch.mock.calls[0];
		expect(url).toContain("filter=heads%2Frelease%2F1.2");
	});

	it("does not double-encode a repository name stored percent-encoded (My%20Repo)", async () => {
		// Repo names are stored RAW from the connect URL, so a browser-copied
		// "My%20Repo" is already encoded — encoding it again would yield
		// "My%2520Repo" and a misleading branch-not-found for every branch.
		mockFetch.mockResolvedValue(
			jsonResponse(200, { value: [{ name: "refs/heads/main" }] }),
		);

		const outcome = await verifyRepositoryBranch({
			...adoInput,
			repo: "My%20Repo",
		});

		expect(outcome).toBe("exists");
		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("/_apis/git/repositories/My%20Repo/refs?");
		expect(url).not.toContain("My%2520Repo");
		expect(url.match(/My%20Repo/g)).toHaveLength(1);
	});

	it("encodes a plain repository name with a literal space exactly once", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, { value: [{ name: "refs/heads/main" }] }),
		);

		await verifyRepositoryBranch({ ...adoInput, repo: "My Repo" });

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("/_apis/git/repositories/My%20Repo/refs?");
		expect(url).not.toContain("My%2520Repo");
	});
});

describe("verifyRepositoryBranch — never throws", () => {
	it("resolves 'unreachable' when fetch rejects (network failure)", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		await expect(verifyRepositoryBranch(githubInput)).resolves.toBe(
			"unreachable",
		);
		await expect(verifyRepositoryBranch(gitlabInput)).resolves.toBe(
			"unreachable",
		);
		await expect(verifyRepositoryBranch(adoInput)).resolves.toBe(
			"unreachable",
		);
	});

	it("resolves 'unreachable' when the ADO body is not parseable JSON", async () => {
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => {
				throw new Error("not json");
			},
		});

		await expect(verifyRepositoryBranch(adoInput)).resolves.toBe(
			"unreachable",
		);
	});
});

import { parseAdoRepositoryUrl } from "../repository-branch";

describe("parseAdoRepositoryUrl (exported)", () => {
	it("parses dev.azure.com URLs", () => {
		expect(
			parseAdoRepositoryUrl(
				"https://dev.azure.com/my-org/My%20Proj/_git/widgets",
			),
		).toEqual({
			organization: "my-org",
			project: "My Proj",
			host: "https://dev.azure.com",
		});
	});
	it("parses legacy visualstudio.com URLs", () => {
		expect(
			parseAdoRepositoryUrl(
				"https://my-org.visualstudio.com/Proj/_git/widgets",
			),
		).toMatchObject({ organization: "my-org", project: "Proj" });
	});
	it("returns null for non-ADO URLs", () => {
		expect(parseAdoRepositoryUrl("https://github.com/o/r")).toBeNull();
	});
});
