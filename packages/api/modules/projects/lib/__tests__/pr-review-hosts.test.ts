/**
 * The URLs each host is actually called with.
 *
 * This file exists because of what its absence cost. The Azure provider shipped
 * addressing `/{org}/{org}/_apis/...` instead of `/{org}/{project}/...`, because
 * `repositoryOwner` holds the organization for an Azure connection and nothing
 * ever asserted on the string handed to `fetch`. Every other test mocked one
 * layer above it, so a wrong path segment was invisible: the code compiled, the
 * suite passed, and the whole provider would have 404'd on first contact.
 *
 * So these assert the request, not the outcome. GitLab and Azure have no live
 * verification behind them, and until they do this is the only thing standing
 * between a typo'd path and a customer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	azureProvider,
	githubProvider,
	gitlabProvider,
} from "../pr-review-hosts";

const fetchMock = vi.fn();

function ok(body: unknown, text?: string) {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => text ?? "",
	};
}

/** Every call's URL, in order, so a sequence can be asserted as a whole. */
function urls(): string[] {
	return fetchMock.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchMock);
});

describe("githubProvider", () => {
	const target = {
		token: "tok",
		repositoryUrl: "https://github.com/acme/store",
		repositoryOwner: "acme",
		repositoryName: "store",
		prNumber: 42,
		maxDiffBytes: 400_000,
	};

	it("reads the pull request and its diff from the same endpoint", async () => {
		fetchMock
			.mockResolvedValueOnce(
				ok({ head: { sha: "h" }, base: { sha: "b" }, title: "t" }),
			)
			.mockResolvedValueOnce(ok(null, "diff --git a/x b/x"));

		const result = await githubProvider.read(target);

		expect(urls()[0]).toBe(
			"https://api.github.com/repos/acme/store/pulls/42",
		);
		expect(urls()[1]).toBe(urls()[0]);
		// The diff comes from a different Accept header, not a different path.
		expect(fetchMock.mock.calls[1][1].headers.Accept).toBe(
			"application/vnd.github.v3.diff",
		);
		expect(result.diff).toContain("diff --git");
	});

	it("addresses a self-hosted instance through its own /api/v3", async () => {
		fetchMock
			.mockResolvedValueOnce(
				ok({ head: { sha: "h" }, base: { sha: "b" } }),
			)
			.mockResolvedValueOnce(ok(null, "diff --git a/x b/x"));

		await githubProvider.read({
			...target,
			repositoryUrl: "https://git.internal.example/acme/store",
		});

		expect(urls()[0]).toBe(
			"https://git.internal.example/api/v3/repos/acme/store/pulls/42",
		);
	});

	it("creates on the issue and edits on the repository", async () => {
		fetchMock.mockResolvedValue(ok({ id: 7, html_url: "u" }));

		await githubProvider.createComment({ ...target, body: "b" });
		await githubProvider.editComment({
			...target,
			commentId: 7,
			body: "b",
		});

		expect(urls()[0]).toBe(
			"https://api.github.com/repos/acme/store/issues/42/comments",
		);
		// The shipped bug was deriving this from the issue path.
		expect(urls()[1]).toBe(
			"https://api.github.com/repos/acme/store/issues/comments/7",
		);
	});
});

describe("gitlabProvider", () => {
	const target = {
		token: "tok",
		repositoryUrl: "https://gitlab.com/group/store",
		repositoryOwner: "group",
		repositoryName: "store",
		prNumber: 9,
		maxDiffBytes: 400_000,
	};

	it("addresses the project by its URL-encoded path", async () => {
		fetchMock
			.mockResolvedValueOnce(
				ok({ diff_refs: { head_sha: "h", base_sha: "b" }, title: "t" }),
			)
			.mockResolvedValueOnce(ok([]));

		await gitlabProvider.read(target);

		expect(urls()[0]).toBe(
			"https://gitlab.com/api/v4/projects/group%2Fstore/merge_requests/9",
		);
	});

	it("keeps a subgroup path intact", async () => {
		// `repositoryOwner` stores the whole namespace for a nested project, so
		// this has to encode all of it rather than assuming one level.
		fetchMock
			.mockResolvedValueOnce(
				ok({ diff_refs: { head_sha: "h", base_sha: "b" } }),
			)
			.mockResolvedValueOnce(ok([]));

		await gitlabProvider.read({
			...target,
			repositoryUrl: "https://gitlab.com/group/sub/store",
			repositoryOwner: "group/sub",
		});

		expect(urls()[0]).toContain(
			"projects/group%2Fsub%2Fstore/merge_requests/9",
		);
	});

	it("asks for diffs, the endpoint that replaced the deprecated one", async () => {
		fetchMock
			.mockResolvedValueOnce(
				ok({ diff_refs: { head_sha: "h", base_sha: "b" } }),
			)
			.mockResolvedValueOnce(ok([]));

		await gitlabProvider.read(target);

		// GitLab deprecated `/changes` in 15.7 and will remove it in API v5.
		expect(urls()[1]).toContain("/merge_requests/9/diffs");
		expect(urls()[1]).not.toContain("/changes");
	});

	it("assembles a per-file change into a diff the shared parser reads", async () => {
		fetchMock
			.mockResolvedValueOnce(
				ok({ diff_refs: { head_sha: "h", base_sha: "b" } }),
			)
			.mockResolvedValueOnce(
				ok([
					{
						old_path: "src/a.ts",
						new_path: "src/a.ts",
						diff: "@@ -1,1 +1,2 @@\n x\n+y",
					},
				]),
			);

		const result = await gitlabProvider.read(target);

		expect(result.diff).toContain("diff --git a/src/a.ts b/src/a.ts");
		expect(result.diff).toContain("+++ b/src/a.ts");
	});

	it("posts a note and edits it by note id", async () => {
		fetchMock.mockResolvedValue(ok({ id: 55 }));

		await gitlabProvider.createComment({ ...target, body: "b" });
		await gitlabProvider.editComment({
			...target,
			commentId: 55,
			body: "b",
		});

		expect(urls()[0]).toContain("/merge_requests/9/notes");
		expect(urls()[1]).toContain("/merge_requests/9/notes/55");
		expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
	});
});

describe("azureProvider", () => {
	const target = {
		token: "tok",
		// The organization, the PROJECT, then the repository.
		repositoryUrl: "https://dev.azure.com/my-org/MyProject/_git/store",
		// Holds the ORGANIZATION for an Azure connection, not the project.
		repositoryOwner: "my-org",
		repositoryName: "store",
		azureOrganization: "my-org",
		prNumber: 12,
		maxDiffBytes: 400_000,
	};

	it("addresses the project from the URL, not the owner column", async () => {
		// The bug this pins: reading `repositoryOwner` as the project produced
		// `/my-org/my-org/_apis/...`, which 404s for every customer whose project
		// is not named after their organization.
		fetchMock.mockResolvedValueOnce(ok({ title: "t" }));

		await azureProvider.read(target);

		expect(urls()[0]).toContain(
			"/my-org/MyProject/_apis/git/repositories/store",
		);
		expect(urls()[0]).not.toContain("/my-org/my-org/");
		expect(urls()[0]).toContain("/pullrequests/12");
	});

	it("falls back to the organization in a visualstudio.com hostname", async () => {
		fetchMock.mockResolvedValueOnce(ok({ title: "t" }));

		await azureProvider.read({
			...target,
			repositoryUrl:
				"https://my-org.visualstudio.com/MyProject/_git/store",
			azureOrganization: null,
		});

		expect(urls()[0]).toContain(
			"my-org.visualstudio.com/my-org/MyProject/",
		);
	});

	it("creates a thread and edits the comment inside it", async () => {
		fetchMock.mockResolvedValueOnce(ok({ id: 300, comments: [{ id: 2 }] }));

		const created = await azureProvider.createComment({
			...target,
			body: "b",
		});

		expect(urls()[0]).toContain("/pullRequests/12/threads");
		// Azure needs both ids to edit, so both are packed into the one number
		// every other host stores.
		fetchMock.mockResolvedValueOnce(ok({}));
		await azureProvider.editComment({
			...target,
			commentId: created.id,
			body: "b2",
		});

		expect(urls()[1]).toContain("/threads/300/comments/2");
		expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");
	});

	it("reports a deleted comment as gone rather than throwing", async () => {
		// The caller creates a fresh comment on null. Throwing here would leave a
		// review permanently unable to post again.
		fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

		await expect(
			azureProvider.editComment({ ...target, commentId: 1, body: "b" }),
		).resolves.toBeNull();
	});

	it("stops before the diff when there is no commit range", async () => {
		fetchMock.mockResolvedValueOnce(ok({ title: "t" }));

		const result = await azureProvider.read(target);

		expect(result.diff).toBeNull();
		expect(result.failureText).toMatch(/no commit range/i);
		// One call only: nothing is spent chasing a diff that cannot exist.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("azureProvider — assembling a diff", () => {
	const target = {
		token: "tok",
		repositoryUrl: "https://dev.azure.com/my-org/MyProject/_git/store",
		repositoryOwner: "my-org",
		repositoryName: "store",
		azureOrganization: "my-org",
		prNumber: 12,
		maxDiffBytes: 400_000,
	};

	const pr = {
		title: "t",
		lastMergeSourceCommit: { commitId: "head" },
		lastMergeTargetCommit: { commitId: "base" },
	};

	it("reads a renamed file from its OLD path at the base commit", async () => {
		// The bug: fetching the NEW path at the base commit 404s, so an ordinary
		// move rendered as a whole-file rewrite.
		fetchMock
			.mockResolvedValueOnce(ok(pr))
			.mockResolvedValueOnce(
				ok({
					changes: [
						{
							item: { path: "/src/new.ts" },
							changeType: "rename, edit",
							sourceServerItem: "/src/old.ts",
						},
					],
				}),
			)
			.mockResolvedValueOnce(ok({ content: "a\nb\nc" }))
			.mockResolvedValueOnce(ok({ content: "a\nCHANGED\nc" }));

		const result = await azureProvider.read(target);

		const contentCalls = urls().slice(2);
		// Old content from the old path, new content from the new one.
		expect(contentCalls[0]).toContain(encodeURIComponent("/src/old.ts"));
		expect(contentCalls[0]).toContain("version=base");
		expect(contentCalls[1]).toContain(encodeURIComponent("/src/new.ts"));
		expect(contentCalls[1]).toContain("version=head");
		// And the result is a real diff, not the file twice.
		expect(result.diff).toContain("rename from src/old.ts");
		expect(result.diff).toContain("+CHANGED");
		expect(result.diff).not.toContain("-a");
	});

	it("still shows a rename that changed nothing", async () => {
		// GitHub and GitLab both emit rename headers for a no-op move. Dropping it
		// left an Azure reviewer with no evidence the file had moved at all.
		fetchMock
			.mockResolvedValueOnce(ok(pr))
			.mockResolvedValueOnce(
				ok({
					changes: [
						{
							item: { path: "/src/new.ts" },
							changeType: "rename",
							sourceServerItem: "/src/old.ts",
						},
					],
				}),
			)
			.mockResolvedValueOnce(ok({ content: "same" }))
			.mockResolvedValueOnce(ok({ content: "same" }));

		const result = await azureProvider.read(target);

		expect(result.diff).toContain("rename from src/old.ts");
		expect(result.diff).toContain("rename to src/new.ts");
	});

	it("skips a file whose contents failed to load, rather than inventing them", async () => {
		// A 503 on one side is NOT "the file did not exist there". Treating it as
		// empty renders the whole of the other side as added, which is a fabricated
		// diff every line of which would ground.
		fetchMock
			.mockResolvedValueOnce(ok(pr))
			.mockResolvedValueOnce(
				ok({
					changes: [
						{ item: { path: "/src/a.ts" }, changeType: "edit" },
					],
				}),
			)
			.mockResolvedValueOnce({ ok: false, status: 503 })
			.mockResolvedValueOnce(ok({ content: "new content" }));

		const result = await azureProvider.read(target);

		// Null, not a fabricated diff: no file was assembled, so there is nothing
		// to review rather than a whole file pretending to be new.
		expect(result.diff).toBeNull();
		expect(result.failureText).toMatch(/no file changes/i);
	});

	it("survives a network throw on one file", async () => {
		// This used to reject the whole read and lose every file already assembled.
		fetchMock
			.mockResolvedValueOnce(ok(pr))
			.mockResolvedValueOnce(
				ok({
					changes: [
						{ item: { path: "/src/a.ts" }, changeType: "edit" },
					],
				}),
			)
			.mockRejectedValueOnce(new Error("ECONNRESET"))
			.mockResolvedValueOnce(ok({ content: "new" }));

		await expect(azureProvider.read(target)).resolves.toBeDefined();
	});
});
