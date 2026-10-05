/**
 * `compareRepositoryRefs` and `readRepositoryFileAtCommit` — the commit diff
 * of a repository-backed Coding Instructions project (Fizzy #2878 §10). The
 * three providers' compare endpoints are pinned, renames become a removal and
 * an addition, a listing the provider capped is `truncated` and never passed
 * off as complete, and every failure is a closed outcome. Every identifier is
 * synthetic; no network is touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compareRepositoryRefs,
	isCommitOnBranch,
	readRepositoryFileAtCommit,
} from "../repository-compare";

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

const SECRET_TOKEN = "ghs_example_compare_secret";
const FROM = "a".repeat(40);
const TO = "b".repeat(40);

function json(status: number, body: unknown = {}) {
	return new Response(JSON.stringify(body), { status });
}

const github = {
	provider: "GITHUB" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://github.com/example-org/memory",
	owner: "example-org",
	repo: "memory",
	from: FROM,
	to: TO,
};
const gitlab = {
	...github,
	provider: "GITLAB" as const,
	repositoryUrl: "https://gitlab.com/example-org/memory",
};
const ado = {
	provider: "AZURE_DEVOPS" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://dev.azure.com/example-org/Proj/_git/memory",
	owner: "example-org",
	repo: "memory",
	azureOrganization: "example-org",
	from: FROM,
	to: TO,
};

function call(n: number): { url: URL; headers: Record<string, string> } {
	const [url, init] = mockFetch.mock.calls[n] as [
		string,
		{ headers: Record<string, string> },
	];
	return { url: new URL(url), headers: init.headers };
}

describe("GitHub", () => {
	it("compares base...head and maps every file status", async () => {
		mockFetch.mockResolvedValue(
			json(200, {
				files: [
					{ filename: "rules/new.md", status: "added" },
					{ filename: "rules/old.md", status: "removed" },
					{ filename: "rules/a.md", status: "modified" },
					{ filename: "bin/run.sh", status: "changed" },
					{ filename: "rules/copy.md", status: "copied" },
					{
						filename: "rules/renamed.md",
						previous_filename: "rules/before.md",
						status: "renamed",
					},
					{ filename: "rules/same.md", status: "unchanged" },
				],
			}),
		);

		const result = await compareRepositoryRefs(github);

		const { url, headers } = call(0);
		expect(url.origin + url.pathname).toBe(
			`https://api.github.com/repos/example-org/memory/compare/${FROM}...${TO}`,
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			per_page: "100",
			page: "1",
		});
		expect(headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
		expect(result).toEqual({
			ok: true,
			truncated: false,
			files: [
				{ path: "rules/new.md", status: "added" },
				{ path: "rules/old.md", status: "removed" },
				{ path: "rules/a.md", status: "modified" },
				{ path: "bin/run.sh", status: "modified" },
				{ path: "rules/copy.md", status: "added" },
				{ path: "rules/before.md", status: "removed" },
				{ path: "rules/renamed.md", status: "added" },
			],
		});
	});

	it("reads the next page while the provider returns full ones", async () => {
		const page = (prefix: string, count: number) =>
			json(200, {
				files: Array.from({ length: count }, (_, i) => ({
					filename: `${prefix}/${i}.md`,
					status: "modified",
				})),
			});
		mockFetch
			.mockResolvedValueOnce(page("a", 100))
			.mockResolvedValueOnce(page("b", 40));

		const result = await compareRepositoryRefs(github);

		expect(mockFetch).toHaveBeenCalledTimes(2);
		expect(call(1).url.searchParams.get("page")).toBe("2");
		expect(result).toMatchObject({ ok: true, truncated: false });
		expect((result as { files: unknown[] }).files).toHaveLength(140);
	});

	it("is truncated, not complete, when three full pages are still full", async () => {
		mockFetch.mockImplementation(async () =>
			json(200, {
				files: Array.from({ length: 100 }, (_, i) => ({
					filename: `f/${Math.random()}/${i}.md`,
					status: "modified",
				})),
			}),
		);

		const result = await compareRepositoryRefs(github);

		expect(mockFetch).toHaveBeenCalledTimes(3);
		expect(result).toMatchObject({ ok: true, truncated: true });
	});

	it("lists a path that is both removed and added as modified", async () => {
		mockFetch.mockResolvedValue(
			json(200, {
				files: [
					{ filename: "rules/b.md", status: "removed" },
					{
						filename: "rules/b.md",
						previous_filename: "rules/a.md",
						status: "renamed",
					},
				],
			}),
		);

		expect(await compareRepositoryRefs(github)).toEqual({
			ok: true,
			truncated: false,
			files: [
				{ path: "rules/b.md", status: "modified" },
				{ path: "rules/a.md", status: "removed" },
			],
		});
	});

	it("refuses a status it does not know rather than guessing", async () => {
		mockFetch.mockResolvedValue(
			json(200, { files: [{ filename: "a.md", status: "teleported" }] }),
		);

		expect(await compareRepositoryRefs(github)).toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});
});

describe("GitLab", () => {
	it("compares from..to on the pinned host and maps the diff flags", async () => {
		mockFetch.mockResolvedValue(
			json(200, {
				compare_timeout: false,
				diffs: [
					{
						new_path: "rules/new.md",
						old_path: "rules/new.md",
						new_file: true,
					},
					{
						new_path: "rules/old.md",
						old_path: "rules/old.md",
						deleted_file: true,
					},
					{ new_path: "rules/a.md", old_path: "rules/a.md" },
					{
						new_path: "rules/renamed.md",
						old_path: "rules/before.md",
						renamed_file: true,
					},
				],
			}),
		);

		const result = await compareRepositoryRefs(gitlab);

		const { url, headers } = call(0);
		expect(url.origin + url.pathname).toBe(
			"https://gitlab.com/api/v4/projects/example-org%2Fmemory/repository/compare",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			from: FROM,
			to: TO,
		});
		expect(headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
		expect(result).toEqual({
			ok: true,
			truncated: false,
			files: [
				{ path: "rules/new.md", status: "added" },
				{ path: "rules/old.md", status: "removed" },
				{ path: "rules/a.md", status: "modified" },
				{ path: "rules/before.md", status: "removed" },
				{ path: "rules/renamed.md", status: "added" },
			],
		});
	});

	it("is truncated when the provider's compare timed out", async () => {
		mockFetch.mockResolvedValue(
			json(200, { compare_timeout: true, diffs: [] }),
		);

		expect(await compareRepositoryRefs(gitlab)).toMatchObject({
			ok: true,
			truncated: true,
		});
	});
});

describe("Azure DevOps", () => {
	it("diffs two commits against their common commit, skipping folders", async () => {
		mockFetch.mockResolvedValue(
			json(200, {
				allChangesIncluded: true,
				changes: [
					{
						changeType: "edit",
						item: {
							gitObjectType: "tree",
							isFolder: true,
							path: "/rules",
						},
					},
					{
						changeType: "add",
						item: { gitObjectType: "blob", path: "/rules/new.md" },
					},
					{
						changeType: "delete",
						item: { gitObjectType: "blob", path: "/rules/old.md" },
					},
					{
						changeType: "edit",
						item: { gitObjectType: "blob", path: "/rules/a.md" },
					},
					{
						changeType: "edit, rename",
						originalPath: "/rules/before.md",
						item: {
							gitObjectType: "blob",
							path: "/rules/renamed.md",
						},
					},
				],
			}),
		);

		const result = await compareRepositoryRefs(ado);

		const { url, headers } = call(0);
		expect(url.origin + url.pathname).toBe(
			"https://dev.azure.com/example-org/Proj/_apis/git/repositories/memory/diffs/commits",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			baseVersion: FROM,
			baseVersionType: "commit",
			targetVersion: TO,
			targetVersionType: "commit",
			diffCommonCommit: "true",
			$top: "100",
			$skip: "0",
			"api-version": "7.1",
		});
		expect(headers.Authorization).toBe(
			`Basic ${Buffer.from(`:${SECRET_TOKEN}`).toString("base64")}`,
		);
		expect(result).toEqual({
			ok: true,
			truncated: false,
			files: [
				{ path: "rules/new.md", status: "added" },
				{ path: "rules/old.md", status: "removed" },
				{ path: "rules/a.md", status: "modified" },
				{ path: "rules/before.md", status: "removed" },
				{ path: "rules/renamed.md", status: "added" },
			],
		});
	});

	it("is truncated when the provider says not every change is included", async () => {
		mockFetch.mockResolvedValue(
			json(200, { allChangesIncluded: false, changes: [] }),
		);

		expect(await compareRepositoryRefs(ado)).toMatchObject({
			ok: true,
			truncated: true,
		});
	});
});

describe("isCommitOnBranch", () => {
	const base = { branch: "release/1.2", sha: TO };

	it("asks GitHub to compare the branch to the commit and reads ahead_by", async () => {
		mockFetch.mockResolvedValue(json(200, { ahead_by: 0, behind_by: 4 }));

		const result = await isCommitOnBranch({ ...github, ...base });

		const { url } = call(0);
		expect(url.origin + url.pathname).toBe(
			`https://api.github.com/repos/example-org/memory/compare/release%2F1.2...${TO}`,
		);
		expect(result).toEqual({ ok: true, onBranch: true });
	});

	it("is not on the branch when GitHub says the commit is ahead of it", async () => {
		mockFetch.mockResolvedValue(json(200, { ahead_by: 2, behind_by: 0 }));

		expect(await isCommitOnBranch({ ...github, ...base })).toEqual({
			ok: true,
			onBranch: false,
		});
	});

	it("asks GitLab to compare from the branch to the commit and reads the commits list", async () => {
		mockFetch.mockResolvedValueOnce(json(200, { commits: [] }));
		expect(await isCommitOnBranch({ ...gitlab, ...base })).toEqual({
			ok: true,
			onBranch: true,
		});
		expect(Object.fromEntries(call(0).url.searchParams)).toEqual({
			from: "release/1.2",
			to: TO,
		});

		mockFetch.mockResolvedValueOnce(json(200, { commits: [{ id: TO }] }));
		expect(await isCommitOnBranch({ ...gitlab, ...base })).toEqual({
			ok: true,
			onBranch: false,
		});
	});

	it("asks Azure DevOps for the diff from the branch to the commit and reads aheadCount", async () => {
		mockFetch.mockResolvedValueOnce(
			json(200, { aheadCount: 0, changes: [] }),
		);
		expect(await isCommitOnBranch({ ...ado, ...base })).toEqual({
			ok: true,
			onBranch: true,
		});
		const { url } = call(0);
		expect(url.searchParams.get("baseVersion")).toBe("release/1.2");
		expect(url.searchParams.get("baseVersionType")).toBe("branch");
		expect(url.searchParams.get("targetVersion")).toBe(TO);
		expect(url.searchParams.get("targetVersionType")).toBe("commit");

		mockFetch.mockResolvedValueOnce(json(200, { aheadCount: 3 }));
		expect(await isCommitOnBranch({ ...ado, ...base })).toEqual({
			ok: true,
			onBranch: false,
		});
	});

	it.each([
		["GitHub", github, { behind_by: 1 }],
		["GitLab", gitlab, { diffs: [] }],
		["Azure DevOps", ado, { changes: [] }],
	])(
		"never reads %s's answer without the count as on the branch",
		async (_name, provider, body) => {
			mockFetch.mockResolvedValue(json(200, body));

			expect(await isCommitOnBranch({ ...provider, ...base })).toEqual({
				ok: false,
				outcome: "unreachable",
			});
		},
	);

	it.each([
		[401, "unauthorized"],
		[404, "not-found"],
		[500, "unreachable"],
	])("answers a %s as %s", async (status, outcome) => {
		mockFetch.mockResolvedValue(json(status));

		expect(await isCommitOnBranch({ ...github, ...base })).toEqual({
			ok: false,
			outcome,
		});
	});
});

describe("failures", () => {
	it.each([
		[401, "unauthorized"],
		[404, "not-found"],
		[500, "unreachable"],
	])("answers a %s as %s", async (status, outcome) => {
		mockFetch.mockResolvedValue(json(status));

		expect(await compareRepositoryRefs(github)).toEqual({
			ok: false,
			outcome,
		});
	});

	it("never carries the token out of the request", async () => {
		mockFetch.mockRejectedValue(new Error(`boom ${SECRET_TOKEN}`));

		const result = await compareRepositoryRefs(gitlab);

		expect(result).toEqual({ ok: false, outcome: "unreachable" });
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});
});

describe("readRepositoryFileAtCommit", () => {
	const base = { path: "rules/a.md", sha: TO, maxBytes: 1024 };

	it("reads GitHub's contents at the commit", async () => {
		const bytes = Buffer.from("alpha\n");
		mockFetch.mockResolvedValue(
			json(200, {
				type: "file",
				size: bytes.length,
				encoding: "base64",
				content: bytes.toString("base64"),
				sha: "3d0b5c3c0b0f4e0c7d1b4e0a0d1c9d0f1a2b3c4d",
			}),
		);

		await readRepositoryFileAtCommit({ ...github, ...base });

		expect(call(0).url.searchParams.get("ref")).toBe(TO);
	});

	it("tells Azure DevOps the version is a commit", async () => {
		mockFetch.mockResolvedValue(json(404));

		const result = await readRepositoryFileAtCommit({ ...ado, ...base });

		expect(result).toEqual({ ok: true, state: "absent" });
		const { url } = call(0);
		expect(url.searchParams.get("versionDescriptor.version")).toBe(TO);
		expect(url.searchParams.get("versionDescriptor.versionType")).toBe(
			"commit",
		);
	});

	/** GitLab's HEAD on a file: no body, the size in a header. */
	function head(size: number | null, status = 200) {
		return new Response(null, {
			status,
			headers: size === null ? {} : { "X-Gitlab-Size": String(size) },
		});
	}

	function methods(): string[] {
		return mockFetch.mock.calls.map(
			([, init]) => (init as { method?: string }).method ?? "GET",
		);
	}

	it("reads GitLab's file at the commit through the files API, asking its size first", async () => {
		const bytes = Buffer.from("alpha\n");
		mockFetch.mockResolvedValueOnce(head(bytes.length));
		mockFetch.mockResolvedValueOnce(
			json(200, {
				size: bytes.length,
				encoding: "base64",
				content: bytes.toString("base64"),
			}),
		);

		const result = await readRepositoryFileAtCommit({ ...gitlab, ...base });

		expect(methods()).toEqual(["HEAD", "GET"]);
		for (const n of [0, 1]) {
			const { url } = call(n);
			expect(url.origin + url.pathname).toBe(
				"https://gitlab.com/api/v4/projects/example-org%2Fmemory/repository/files/rules%2Fa.md",
			);
			expect(url.searchParams.get("ref")).toBe(TO);
		}
		expect(result).toMatchObject({ ok: true, state: "found" });
		expect(
			Buffer.from((result as { bytes: Uint8Array }).bytes).toString(
				"utf8",
			),
		).toBe("alpha\n");
	});

	it("is absent for a GitLab 404 on the HEAD, and tooLarge past the cap WITHOUT a GET that would buffer the file", async () => {
		mockFetch.mockResolvedValueOnce(head(null, 404));
		expect(
			await readRepositoryFileAtCommit({ ...gitlab, ...base }),
		).toEqual({
			ok: true,
			state: "absent",
		});
		expect(methods()).toEqual(["HEAD"]);

		mockFetch.mockClear();
		mockFetch.mockResolvedValueOnce(head(5000));
		expect(
			await readRepositoryFileAtCommit({ ...gitlab, ...base }),
		).toEqual({
			ok: true,
			state: "tooLarge",
		});
		expect(methods(), "a too-large file is never fetched").toEqual([
			"HEAD",
		]);
	});

	it("falls back to the GET's own reported size when the HEAD carries none", async () => {
		mockFetch.mockResolvedValueOnce(head(null));
		mockFetch.mockResolvedValueOnce(
			json(200, { size: 5000, encoding: "base64", content: "AAAA" }),
		);

		expect(
			await readRepositoryFileAtCommit({ ...gitlab, ...base }),
		).toEqual({ ok: true, state: "tooLarge" });
		expect(methods()).toEqual(["HEAD", "GET"]);
	});

	it("answers a rejected credential as unauthorized", async () => {
		mockFetch.mockResolvedValue(json(401));

		expect(
			await readRepositoryFileAtCommit({ ...gitlab, ...base }),
		).toEqual({
			ok: false,
			outcome: "unauthorized",
		});
		expect(methods()).toEqual(["HEAD"]);
	});

	it("answers an unreachable provider on the HEAD as unreachable", async () => {
		mockFetch.mockRejectedValue(new Error("network down"));

		expect(
			await readRepositoryFileAtCommit({ ...gitlab, ...base }),
		).toEqual({ ok: false, outcome: "unreachable" });
	});
});
