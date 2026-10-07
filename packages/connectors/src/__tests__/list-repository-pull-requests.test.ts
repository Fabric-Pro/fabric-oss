import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRepositoryPullRequests } from "../repository-pull-requests";

const fetchMock = vi.fn();
beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const common = {
	token: "synthetic-read-token",
	owner: "example-org",
	repo: "instructions",
	branch: "release/1.2",
	page: 2,
};
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status });
}

describe("native repository proposals", () => {
	it.each([
		{
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example-org/instructions",
			body: [
				{
					number: 42,
					title: "Rule update",
					user: { login: "developer" },
					draft: true,
					html_url: "https://untrusted.example",
				},
			],
			path: "/pulls",
			branchKey: "base",
			pageKey: "page",
			pageValue: "2",
			url: "https://github.com/example-org/instructions/pull/42",
		},
		{
			provider: "GITLAB",
			repositoryUrl: "https://gitlab.com/example-org/instructions",
			body: [
				{
					iid: 42,
					title: "Rule update",
					author: { name: "developer" },
					draft: true,
					web_url: "https://untrusted.example",
				},
			],
			path: "/merge_requests",
			branchKey: "target_branch",
			pageKey: "page",
			pageValue: "2",
			url: "https://gitlab.com/example-org/instructions/-/merge_requests/42",
		},
		{
			provider: "AZURE_DEVOPS",
			repositoryUrl:
				"https://dev.azure.com/example-org/example-project/_git/instructions",
			body: {
				value: [
					{
						pullRequestId: 42,
						title: "Rule update",
						createdBy: { displayName: "developer" },
						isDraft: true,
						url: "https://untrusted.example",
					},
				],
			},
			path: "/pullrequests",
			branchKey: "searchCriteria.targetRefName",
			pageKey: "$skip",
			pageValue: "30",
			url: "https://dev.azure.com/example-org/example-project/_git/instructions/pullrequest/42",
		},
	] as const)(
		"reads one bounded native $provider page with canonical links",
		async (fixture) => {
			fetchMock.mockResolvedValue(response(fixture.body));
			const answer = await listRepositoryPullRequests({
				...common,
				provider: fixture.provider,
				repositoryUrl: fixture.repositoryUrl,
			});
			expect(answer).toEqual({
				ok: true,
				hasMore: false,
				pullRequests: [
					{
						number: 42,
						title: "Rule update",
						author: "developer",
						draft: true,
						url: fixture.url,
					},
				],
			});
			expect(fetchMock).toHaveBeenCalledOnce();
			const [address, options] = fetchMock.mock.calls[0];
			const url = new URL(address);
			expect(url.pathname.endsWith(fixture.path)).toBe(true);
			expect(url.searchParams.get(fixture.branchKey)).toBe(
				fixture.provider === "AZURE_DEVOPS"
					? "refs/heads/release/1.2"
					: common.branch,
			);
			expect(url.searchParams.get(fixture.pageKey)).toBe(
				fixture.pageValue,
			);
			expect(options.method ?? "GET").toBe("GET");
			expect(JSON.stringify(answer)).not.toContain(common.token);
		},
	);
	it.each([0, -1, 1.5, 1001])(
		"refuses invalid page %s without provider I/O",
		async (page) => {
			expect(
				await listRepositoryPullRequests({
					...common,
					provider: "GITHUB",
					repositoryUrl:
						"https://github.com/example-org/instructions",
					page,
				}),
			).toEqual({ ok: false, outcome: "unreachable" });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);
	it("keeps provider authentication failures distinct from an empty proposal list", async () => {
		fetchMock.mockResolvedValue(response({}, 401));
		expect(
			await listRepositoryPullRequests({
				...common,
				provider: "GITHUB",
				repositoryUrl: "https://github.com/example-org/instructions",
			}),
		).toEqual({ ok: false, outcome: "unauthorized" });
	});
	it("rejects a provider page larger than the requested bound", async () => {
		fetchMock.mockResolvedValue(
			response(
				Array.from({ length: 31 }, (_, n) => ({
					number: n + 1,
					title: "Rule update",
				})),
			),
		);
		expect(
			await listRepositoryPullRequests({
				...common,
				provider: "GITHUB",
				repositoryUrl: "https://github.com/example-org/instructions",
			}),
		).toEqual({ ok: false, outcome: "unreachable" });
	});
});
