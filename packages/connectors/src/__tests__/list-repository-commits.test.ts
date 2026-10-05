/**
 * `listRepositoryCommits` — a branch's history within a folder, for the
 * History tab of a repository-backed Coding Instructions project (Fizzy #2878
 * §10). The three providers' own request shapes are pinned (so a changed query
 * parameter fails here, not in production), every provider failure is a closed
 * `ok: false` outcome, never an empty history, and the token never leaves the
 * request. Every identifier is synthetic; no network is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COMMIT_MESSAGE_MAX_CHARS,
	COMMITS_PAGE_SIZE,
	listRepositoryCommits,
} from "../repository-commits";

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// Distinctive and token-shaped, so a leak assertion cannot pass by accident.
const SECRET_TOKEN = "ghs_example_commits_secret";
const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);

function json(status: number, body: unknown = {}) {
	return new Response(JSON.stringify(body), { status });
}

const githubInput = {
	provider: "GITHUB" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://github.com/example-org/memory",
	owner: "example-org",
	repo: "memory",
	branch: "release/1.2",
	path: "agents/my skills",
	page: 2,
};

const gitlabInput = {
	...githubInput,
	provider: "GITLAB" as const,
	repositoryUrl: "https://gitlab.com/example-org/memory",
};

const adoInput = {
	provider: "AZURE_DEVOPS" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://dev.azure.com/example-org/Proj/_git/memory",
	owner: "example-org",
	repo: "memory",
	azureOrganization: "example-org",
	branch: "main",
	path: "agents",
	page: 3,
};

function requested(): { url: URL; headers: Record<string, string> } {
	const [url, init] = mockFetch.mock.calls[0] as [
		string,
		{ headers: Record<string, string> },
	];
	return { url: new URL(url), headers: init.headers };
}

const gitHubEntry = {
	sha: SHA,
	commit: {
		author: { name: "Pat Example", date: "2026-10-01T09:00:00Z" },
		committer: { name: "Fabric", date: "2026-10-01T09:00:05+00:00" },
		message: "Tighten the review skill\n\nBecause it was flaky",
	},
	html_url: "https://example.invalid/never-used",
	parents: [{ sha: PARENT }],
};

describe("GitHub", () => {
	it("asks for the branch's commits that touched the folder, one page of 30", async () => {
		mockFetch.mockResolvedValue(json(200, [gitHubEntry]));

		const result = await listRepositoryCommits(githubInput);

		const { url, headers } = requested();
		expect(url.origin + url.pathname).toBe(
			"https://api.github.com/repos/example-org/memory/commits",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			sha: "release/1.2",
			path: "agents/my skills",
			per_page: String(COMMITS_PAGE_SIZE),
			page: "2",
		});
		expect(headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
		expect(result).toEqual({
			ok: true,
			hasMore: false,
			commits: [
				{
					sha: SHA,
					authorName: "Pat Example",
					committerName: "Fabric",
					date: "2026-10-01T09:00:05.000Z",
					message: "Tighten the review skill\n\nBecause it was flaky",
					url: `https://github.com/example-org/memory/commit/${SHA}`,
					parent: PARENT,
				},
			],
		});
	});

	it("leaves the path out for the repository root", async () => {
		mockFetch.mockResolvedValue(json(200, []));

		await listRepositoryCommits({ ...githubInput, path: "" });

		expect(requested().url.searchParams.has("path")).toBe(false);
	});

	it("says there may be more only for a full page", async () => {
		mockFetch.mockResolvedValue(
			json(
				200,
				Array.from({ length: COMMITS_PAGE_SIZE }, () => gitHubEntry),
			),
		);

		expect(await listRepositoryCommits(githubInput)).toMatchObject({
			ok: true,
			hasMore: true,
		});
	});

	it("reads a root commit as having no parent and cuts an overlong message", async () => {
		mockFetch.mockResolvedValue(
			json(200, [
				{
					...gitHubEntry,
					parents: [],
					commit: {
						...gitHubEntry.commit,
						message: "m".repeat(COMMIT_MESSAGE_MAX_CHARS + 50),
					},
				},
			]),
		);

		const result = await listRepositoryCommits(githubInput);

		expect(result).toMatchObject({ ok: true });
		const [commit] = (
			result as { commits: Array<{ parent: unknown; message: string }> }
		).commits;
		expect(commit?.parent).toBeNull();
		expect(commit?.message).toHaveLength(COMMIT_MESSAGE_MAX_CHARS);
	});
});

describe("GitLab", () => {
	it("asks the pinned gitlab.com for the ref's commits that touched the folder", async () => {
		mockFetch.mockResolvedValue(
			json(200, [
				{
					id: SHA,
					parent_ids: [PARENT],
					author_name: "Pat Example",
					committer_name: "Fabric",
					committed_date: "2026-10-01T09:00:05.000+00:00",
					message: "Tighten the review skill",
					web_url: "https://example.invalid/never-used",
				},
			]),
		);

		const result = await listRepositoryCommits(gitlabInput);

		const { url, headers } = requested();
		expect(url.origin + url.pathname).toBe(
			"https://gitlab.com/api/v4/projects/example-org%2Fmemory/repository/commits",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			ref_name: "release/1.2",
			path: "agents/my skills",
			per_page: "30",
			page: "2",
		});
		expect(headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
		expect(result).toEqual({
			ok: true,
			hasMore: false,
			commits: [
				{
					sha: SHA,
					authorName: "Pat Example",
					committerName: "Fabric",
					date: "2026-10-01T09:00:05.000Z",
					message: "Tighten the review skill",
					url: `https://gitlab.com/example-org/memory/-/commit/${SHA}`,
					parent: PARENT,
				},
			],
		});
	});

	it("authenticates a personal access token with PRIVATE-TOKEN", async () => {
		mockFetch.mockResolvedValue(json(200, []));

		await listRepositoryCommits({
			...gitlabInput,
			gitlabAuth: "private-token",
		});

		expect(requested().headers).toEqual({ "PRIVATE-TOKEN": SECRET_TOKEN });
	});
});

describe("Azure DevOps", () => {
	it("pages with $skip and filters by item path under the branch", async () => {
		mockFetch.mockResolvedValue(
			json(200, {
				count: 1,
				value: [
					{
						commitId: SHA,
						author: {
							name: "Pat Example",
							date: "2026-10-01T09:00:00Z",
						},
						committer: {
							name: "Fabric",
							date: "2026-10-01T09:00:05Z",
						},
						comment: "Tighten the review skill",
						parents: [PARENT],
						remoteUrl: "https://example.invalid/never-used",
					},
				],
			}),
		);

		const result = await listRepositoryCommits(adoInput);

		const { url, headers } = requested();
		expect(url.origin + url.pathname).toBe(
			"https://dev.azure.com/example-org/Proj/_apis/git/repositories/memory/commits",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			"searchCriteria.itemVersion.version": "main",
			"searchCriteria.itemVersion.versionType": "branch",
			"searchCriteria.itemPath": "/agents",
			"searchCriteria.$top": "30",
			"searchCriteria.$skip": "60",
			"api-version": "7.1",
		});
		expect(headers.Authorization).toBe(
			`Basic ${Buffer.from(`:${SECRET_TOKEN}`).toString("base64")}`,
		);
		expect(result).toEqual({
			ok: true,
			hasMore: false,
			commits: [
				{
					sha: SHA,
					authorName: "Pat Example",
					committerName: "Fabric",
					date: "2026-10-01T09:00:05.000Z",
					message: "Tighten the review skill",
					url: `https://dev.azure.com/example-org/Proj/_git/memory/commit/${SHA}`,
					parent: PARENT,
				},
			],
		});
	});

	// The real list leaves `parents` out (observed against Azure DevOps with
	// api-version 7.1); only `GET commits/{id}` carries them. Without a parent
	// the Commits view offers no Revert and no Compare.
	describe("a list without parents", () => {
		const OTHER = "c".repeat(40);
		const entry = (commitId: string) => ({
			commitId,
			author: { name: "Pat Example", date: "2026-10-01T09:00:00Z" },
			committer: { name: "Fabric", date: "2026-10-01T09:00:05Z" },
			comment: "Tighten the review skill",
		});

		it("reads each commit's first parent on its own", async () => {
			mockFetch.mockImplementation(async (url: string) => {
				const path = new URL(url).pathname;
				if (path.endsWith(`/commits/${SHA}`)) {
					return json(200, { commitId: SHA, parents: [PARENT] });
				}
				if (path.endsWith(`/commits/${OTHER}`)) {
					return json(200, { commitId: OTHER, parents: [SHA] });
				}
				return json(200, { value: [entry(SHA), entry(OTHER)] });
			});

			const result = await listRepositoryCommits(adoInput);

			expect(result.ok && result.commits.map((c) => c.parent)).toEqual([
				PARENT,
				SHA,
			]);
			const single = mockFetch.mock.calls
				.map(([url]) => new URL(url as string))
				.filter((url) => /\/commits\/[0-9a-f]{40}$/.test(url.pathname));
			expect(single).toHaveLength(2);
			expect(single[0]?.searchParams.get("api-version")).toBe("7.1");
		});

		it("leaves only the commit whose read fails without a parent", async () => {
			mockFetch.mockImplementation(async (url: string) => {
				const path = new URL(url).pathname;
				if (path.endsWith(`/commits/${SHA}`)) {
					return json(500);
				}
				if (path.endsWith(`/commits/${OTHER}`)) {
					return json(200, { commitId: OTHER, parents: [SHA] });
				}
				return json(200, { value: [entry(SHA), entry(OTHER)] });
			});

			const result = await listRepositoryCommits(adoInput);

			expect(result.ok && result.commits.map((c) => c.parent)).toEqual([
				null,
				SHA,
			]);
		});
	});

	// Azure DevOps answers a history filtered by a folder that is no longer on
	// the branch with a 404 (TF401174), and so does a branch that is gone.
	// Telling them apart takes one look at the branch, on the failure path only.
	describe("a 404 for a folder history", () => {
		function answer(branchExists: boolean) {
			mockFetch.mockImplementation(async (url: string) => {
				const path = new URL(url).pathname;
				if (path.endsWith("/refs")) {
					return json(200, {
						value: branchExists
							? [{ name: "refs/heads/main" }]
							: [],
					});
				}
				return json(404, {
					message: "TF401174: The item could not be found",
				});
			});
		}

		it("is a missing folder when the branch is still there", async () => {
			answer(true);

			expect(await listRepositoryCommits(adoInput)).toEqual({
				ok: false,
				outcome: "missing-path",
			});
		});

		it("is a missing branch when the branch is gone too", async () => {
			answer(false);

			expect(await listRepositoryCommits(adoInput)).toEqual({
				ok: false,
				outcome: "not-found",
			});
		});

		it("never asks about the branch for the repository root", async () => {
			answer(true);

			expect(
				await listRepositoryCommits({ ...adoInput, path: "" }),
			).toEqual({
				ok: false,
				outcome: "not-found",
			});
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});

	it("leaves the item path out for the repository root", async () => {
		mockFetch.mockResolvedValue(json(200, { value: [] }));

		await listRepositoryCommits({ ...adoInput, path: "" });

		expect(
			requested().url.searchParams.has("searchCriteria.itemPath"),
		).toBe(false);
	});

	it("uses the legacy host the stored URL names, without an organization segment", async () => {
		mockFetch.mockResolvedValue(json(200, { value: [] }));

		await listRepositoryCommits({
			...adoInput,
			repositoryUrl:
				"https://example-org.visualstudio.com/Proj/_git/memory",
		});

		expect(requested().url.origin + requested().url.pathname).toBe(
			"https://example-org.visualstudio.com/Proj/_apis/git/repositories/memory/commits",
		);
	});

	it("has nothing to ask without an organization", async () => {
		const result = await listRepositoryCommits({
			...adoInput,
			repositoryUrl: "https://example.invalid/not-azure",
			azureOrganization: null,
		});

		expect(result).toEqual({ ok: false, outcome: "unreachable" });
		expect(mockFetch).not.toHaveBeenCalled();
	});
});

describe("failures are a closed set and never an empty history", () => {
	it.each([
		[401, "unauthorized"],
		[403, "unauthorized"],
		[203, "unauthorized"],
		[404, "not-found"],
		[409, "unreachable"],
		[500, "unreachable"],
	])("answers a %s as %s", async (status, outcome) => {
		mockFetch.mockResolvedValue(json(status, { message: "x" }));

		expect(await listRepositoryCommits(githubInput)).toEqual({
			ok: false,
			outcome,
		});
	});

	it("answers a network failure as unreachable", async () => {
		mockFetch.mockRejectedValue(
			new Error(`connect failed ${SECRET_TOKEN}`),
		);

		const result = await listRepositoryCommits(githubInput);

		expect(result).toEqual({ ok: false, outcome: "unreachable" });
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});

	it.each([
		["a body that is not a list", { commits: [] }],
		["an entry with no sha", [{ commit: gitHubEntry.commit }]],
		[
			"an entry with an unreadable date",
			[{ ...gitHubEntry, commit: { message: "m" } }],
		],
		["a sha that is not an object id", [{ ...gitHubEntry, sha: "main" }]],
	])("answers %s as unreachable", async (_label, body) => {
		mockFetch.mockResolvedValue(json(200, body));

		expect(await listRepositoryCommits(githubInput)).toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});

	it("answers a body that is not JSON as unreachable", async () => {
		mockFetch.mockResolvedValue(new Response("<html>", { status: 200 }));

		expect(await listRepositoryCommits(githubInput)).toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});

	it.each([0, -1, 1.5, Number.NaN])(
		"refuses page %s without a request",
		async (page) => {
			expect(
				await listRepositoryCommits({ ...githubInput, page }),
			).toEqual({
				ok: false,
				outcome: "unreachable",
			});
			expect(mockFetch).not.toHaveBeenCalled();
		},
	);
});
