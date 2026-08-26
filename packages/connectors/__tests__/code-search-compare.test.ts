import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compareRepositoryCommits } from "../src/code-search";

/**
 * `compareRepositoryCommits` — the provider-agnostic "indexed commit → branch
 * HEAD" diff behind both the "N commits behind" line and the manual incremental
 * re-index. Locks the per-provider request shape + response mapping:
 *   - changedFiles extraction (GitHub `files[].filename`, GitLab `diffs[]`,
 *     ADO `changes[].item.path`),
 *   - aheadBy / behindBy,
 *   - truncation (GitHub 300-file cap, ADO paged diff),
 *   - and the never-throws degrade to `status: "unknown"`.
 */

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

describe("compareRepositoryCommits — GitHub", () => {
	it("maps files[].filename, ahead/behind counts, head SHA and status", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				status: "ahead",
				ahead_by: 3,
				behind_by: 0,
				files: [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
				commits: [{ sha: "aaa" }, { sha: "bbb" }],
			}),
		);

		const result = await compareRepositoryCommits({
			provider: "GITHUB",
			token: "gh-token",
			owner: "acme",
			repo: "widgets",
			base: "0000000000000000000000000000000000000000",
			head: "main",
		});

		expect(result).toEqual({
			status: "ahead",
			aheadBy: 3,
			behindBy: 0,
			changedFiles: ["src/a.ts", "src/b.ts"],
			headSha: "bbb",
			truncated: false,
		});
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe(
			"https://api.github.com/repos/acme/widgets/compare/0000000000000000000000000000000000000000...main",
		);
		expect(init.headers.Authorization).toBe("Bearer gh-token");
	});

	it("flags truncation at the 300-file cap", async () => {
		const files = Array.from({ length: 300 }, (_, i) => ({
			filename: `f${i}.ts`,
		}));
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				status: "ahead",
				ahead_by: 1,
				files,
				commits: [{ sha: "abc" }],
			}),
		);

		const result = await compareRepositoryCommits({
			provider: "GITHUB",
			token: "t",
			owner: "acme",
			repo: "widgets",
			base: "base",
			head: "main",
		});

		expect(result.truncated).toBe(true);
		expect(result.changedFiles).toHaveLength(300);
	});

	it("degrades to unknown on a non-ok response (force-pushed-away base)", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(404, { message: "Not Found" }),
		);

		const result = await compareRepositoryCommits({
			provider: "GITHUB",
			token: "t",
			owner: "acme",
			repo: "widgets",
			base: "gone",
			head: "main",
		});

		expect(result.status).toBe("unknown");
		expect(result.changedFiles).toEqual([]);
	});
});

describe("compareRepositoryCommits — GitLab", () => {
	it("uses from/to, counts commits as aheadBy, and dedupes new_path/old_path", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				commit: { id: "head-sha" },
				commits: [{ id: "c1" }, { id: "c2" }],
				diffs: [
					{ new_path: "src/a.ts", old_path: "src/a.ts" },
					{ new_path: "src/new.ts", old_path: "src/old.ts" },
				],
			}),
		);

		const result = await compareRepositoryCommits({
			provider: "GITLAB",
			token: "gl-token",
			owner: "group/sub",
			repo: "widgets",
			base: "base-sha",
			head: "main",
		});

		expect(result.status).toBe("ahead");
		expect(result.aheadBy).toBe(2);
		expect(result.behindBy).toBe(0);
		expect(result.headSha).toBe("head-sha");
		expect(new Set(result.changedFiles)).toEqual(
			new Set(["src/a.ts", "src/new.ts", "src/old.ts"]),
		);
		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toBe(
			"https://gitlab.com/api/v4/projects/group%2Fsub%2Fwidgets/repository/compare?from=base-sha&to=main",
		);
		expect(init.headers.Authorization).toBe("Bearer gl-token");
	});

	it("reports identical when no commits separate base and head", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, { commit: { id: "x" }, commits: [], diffs: [] }),
		);

		const result = await compareRepositoryCommits({
			provider: "GITLAB",
			token: "t",
			owner: "acme",
			repo: "widgets",
			base: "same",
			head: "main",
		});

		expect(result.status).toBe("identical");
		expect(result.aheadBy).toBe(0);
		expect(result.changedFiles).toEqual([]);
	});
});

describe("compareRepositoryCommits — Azure DevOps", () => {
	const adoParams = {
		provider: "AZURE_DEVOPS" as const,
		token: "pat",
		owner: "my-org",
		repo: "widgets",
		azureProject: "Proj",
		base: "0123456789abcdef0123456789abcdef01234567",
		head: "main",
	};

	it("hits diffs/commits with base/target version types and strips the leading slash", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				allChangesIncluded: true,
				aheadCount: 2,
				behindCount: 0,
				changes: [
					{ item: { path: "/src/a.ts" } },
					{ item: { path: "/src/dir", isFolder: true } },
					{ item: { path: "/src/b.ts" } },
				],
			}),
		);

		const result = await compareRepositoryCommits(adoParams);

		expect(result.status).toBe("ahead");
		expect(result.aheadBy).toBe(2);
		expect(result.behindBy).toBe(0);
		expect(result.truncated).toBe(false);
		// Folder entry filtered out; leading "/" stripped.
		expect(result.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);

		const [url, init] = mockFetch.mock.calls[0];
		expect(url).toContain(
			"https://dev.azure.com/my-org/Proj/_apis/git/repositories/widgets/diffs/commits?",
		);
		// base is a full SHA → commit; head is a branch name → branch.
		expect(url).toContain("baseVersionType=commit");
		expect(url).toContain("targetVersionType=branch");
		expect(init.headers.Authorization).toMatch(/^Basic /);
	});

	it("flags truncation when the diff is paged (allChangesIncluded=false)", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				allChangesIncluded: false,
				aheadCount: 5,
				behindCount: 0,
				changes: [{ item: { path: "/src/a.ts" } }],
			}),
		);

		const result = await compareRepositoryCommits(adoParams);
		expect(result.truncated).toBe(true);
	});

	it("returns unknown (no fetch) when azureProject is missing", async () => {
		const result = await compareRepositoryCommits({
			...adoParams,
			azureProject: undefined,
		});
		expect(result.status).toBe("unknown");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("reports diverged when both ahead and behind", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, {
				allChangesIncluded: true,
				aheadCount: 2,
				behindCount: 1,
				changes: [],
			}),
		);
		const result = await compareRepositoryCommits(adoParams);
		expect(result.status).toBe("diverged");
	});
});

describe("compareRepositoryCommits — never throws", () => {
	it("resolves unknown when fetch rejects, for every provider", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		for (const provider of ["GITHUB", "GITLAB", "AZURE_DEVOPS"] as const) {
			const result = await compareRepositoryCommits({
				provider,
				token: "t",
				owner: "acme",
				repo: "widgets",
				azureProject: "Proj",
				base: "base",
				head: "main",
			});
			expect(result.status).toBe("unknown");
			expect(result.changedFiles).toEqual([]);
		}
	});

	it("returns unknown for an unsupported provider", async () => {
		const result = await compareRepositoryCommits({
			provider: "BITBUCKET",
			token: "t",
			owner: "acme",
			repo: "widgets",
			base: "base",
			head: "main",
		} as unknown as Parameters<typeof compareRepositoryCommits>[0]);
		expect(result.status).toBe("unknown");
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
