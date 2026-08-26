import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @repo/integrations/gitlab — keep the REAL GitLabApiError class.
vi.mock("@repo/integrations/gitlab", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@repo/integrations/gitlab")>();
	return {
		...actual,
		gitlabRequest: vi.fn(),
	};
});

import { GitLabApiError, gitlabRequest } from "@repo/integrations/gitlab";
import {
	fetchGitLabLatestRelease,
	fetchGitLabMergeRequests,
	fetchGitLabReleases,
} from "../src/activities/daily-brief/providers/gitlab";

const gitlabRequestMock = vi.mocked(gitlabRequest);

beforeEach(() => {
	vi.resetAllMocks();
});

// =============================================================================
// Factories
// =============================================================================

function glRelease(tag: string, releasedAt: string) {
	return {
		tag_name: tag,
		name: tag,
		description: `notes ${tag}`,
		released_at: releasedAt,
		author: { username: "alice" },
		_links: { self: `https://gitlab.com/grp/proj/-/releases/${tag}` },
	};
}

function glMr(overrides: Record<string, unknown>) {
	return {
		iid: 1,
		title: "MR",
		description: "body",
		state: "opened",
		draft: false,
		web_url: "https://gitlab.com/grp/proj/-/merge_requests/1",
		created_at: "2026-06-09T01:00:00Z",
		updated_at: "2026-06-09T02:00:00Z",
		closed_at: null,
		merged_at: null,
		author: { username: "alice" },
		reviewers: [],
		source_branch: "feat",
		target_branch: "main",
		...overrides,
	};
}

// =============================================================================
// fetchGitLabReleases
// =============================================================================

describe("fetchGitLabReleases", () => {
	it("maps fields and paginates via x-next-page", async () => {
		gitlabRequestMock
			.mockResolvedValueOnce({
				status: 200,
				headers: new Headers({ "x-next-page": "2" }),
				body: [glRelease("v2", "2026-06-09T10:00:00Z")],
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: new Headers(),
				body: [glRelease("v1", "2026-06-01T10:00:00Z")],
			});
		const out = await fetchGitLabReleases({
			getToken: async () => "tok",
			owner: "grp",
			repo: "proj",
			repositoryUrl: "https://gitlab.com/grp/proj",
			remainingMs: () => 60_000,
		});
		expect(out.truncated).toBe(false);
		expect(out.releases.map((r) => r.tag_name)).toEqual(["v2", "v1"]);
		expect(out.releases[0]).toMatchObject({
			draft: false,
			published_at: "2026-06-09T10:00:00Z",
			body: "notes v2",
		});
		// project path is URL-encoded "grp/proj"
		expect(gitlabRequestMock.mock.calls[0][0].path).toBe(
			"/projects/grp%2Fproj/releases",
		);
	});

	it("marks truncated at the page cap with a next page pending", async () => {
		for (let p = 1; p <= 5; p++) {
			gitlabRequestMock.mockResolvedValueOnce({
				status: 200,
				headers: new Headers({ "x-next-page": String(p + 1) }),
				body: [glRelease(`v${p}`, "2026-06-09T10:00:00Z")],
			});
		}
		const out = await fetchGitLabReleases({
			getToken: async () => "t",
			owner: "g",
			repo: "p",
			repositoryUrl: "u",
			remainingMs: () => 60_000,
		});
		expect(out.truncated).toBe(true);
		expect(gitlabRequestMock).toHaveBeenCalledTimes(5); // cap respected
	});

	it("upcoming_release maps to prerelease (filtered out downstream)", async () => {
		gitlabRequestMock.mockResolvedValueOnce({
			status: 200,
			headers: new Headers(),
			body: [
				{
					...glRelease("v-future", "2026-07-01T00:00:00Z"),
					upcoming_release: true,
				},
			],
		});
		const out = await fetchGitLabReleases({
			getToken: async () => "t",
			owner: "g",
			repo: "p",
			repositoryUrl: "u",
			remainingMs: () => 60_000,
		});
		expect(out.releases[0].prerelease).toBe(true);
	});

	it("budget exhausted before a page → stops with truncated, no request started", async () => {
		const out = await fetchGitLabReleases({
			getToken: async () => "t",
			owner: "g",
			repo: "p",
			repositoryUrl: "u",
			remainingMs: () => 100,
		});
		expect(out).toEqual({ releases: [], truncated: true });
		expect(gitlabRequestMock).not.toHaveBeenCalled();
	});

	it("budget below floor before token acquisition → truncated, getToken NOT called", async () => {
		const getToken = vi.fn(async () => "t");
		const out = await fetchGitLabReleases({
			getToken,
			owner: "g",
			repo: "p",
			repositoryUrl: "u",
			remainingMs: () => 100, // below MIN_FETCH_MS (500)
		});
		expect(out).toEqual({ releases: [], truncated: true });
		expect(getToken).not.toHaveBeenCalled();
		expect(gitlabRequestMock).not.toHaveBeenCalled();
	});

	it("hanging getToken is bounded by the budget → GitLab: token acquisition timed out", async () => {
		const hangingGetToken = () => new Promise<string>(() => {});
		await expect(
			fetchGitLabReleases({
				getToken: hangingGetToken,
				owner: "g",
				repo: "p",
				repositoryUrl: "u",
				remainingMs: () => 600, // > MIN_FETCH_MS, small enough to time out fast
			}),
		).rejects.toThrow("GitLab: token acquisition timed out");
	});

	it("401-refresh callback handed to gitlabRequest is budget-bounded", async () => {
		// gitlabRequest is mocked here, so the 401 retry happens inside the real
		// rest-client — assert the WIRING: the onRefreshToken the fetcher passes
		// must already be bounded, not the raw (potentially hanging) getToken.
		let calls = 0;
		const getToken = () => {
			calls += 1;
			return calls === 1
				? Promise.resolve("tok") // initial acquisition succeeds
				: new Promise<string>(() => {}); // the refresh stalls forever
		};
		gitlabRequestMock.mockResolvedValueOnce({
			status: 200,
			headers: new Headers(),
			body: [],
		});
		await fetchGitLabReleases({
			getToken,
			owner: "g",
			repo: "p",
			repositoryUrl: "u",
			remainingMs: () => 600,
		});
		const onRefreshToken =
			gitlabRequestMock.mock.calls[0][0].onRefreshToken;
		expect(onRefreshToken).toBeDefined();
		await expect(
			(onRefreshToken as () => Promise<string>)(),
		).rejects.toThrow("token acquisition timed out");
	});

	it("non-404 GitLabApiError is rethrown with the provider prefix (FR-6)", async () => {
		gitlabRequestMock.mockRejectedValueOnce(
			new GitLabApiError(401, "Unauthorized"),
		);
		await expect(
			fetchGitLabReleases({
				getToken: async () => "t",
				owner: "g",
				repo: "p",
				repositoryUrl: "u",
				remainingMs: () => 60_000,
			}),
		).rejects.toThrow("GitLab API error: HTTP 401: Unauthorized");
	});

	it("generic errors (e.g. token refresh failure) also get the provider prefix", async () => {
		const failingGetToken = async () => {
			throw new Error("refresh_token revoked");
		};
		await expect(
			fetchGitLabReleases({
				getToken: failingGetToken,
				owner: "g",
				repo: "p",
				repositoryUrl: "u",
				remainingMs: () => 60_000,
			}),
		).rejects.toThrow("GitLab: refresh_token revoked");
		await expect(
			fetchGitLabLatestRelease({
				getToken: failingGetToken,
				owner: "g",
				repo: "p",
				repositoryUrl: "u",
				timeoutMs: 5000,
			}),
		).rejects.toThrow("GitLab: refresh_token revoked"); // getToken is INSIDE the try
	});
});

// =============================================================================
// fetchGitLabLatestRelease
// =============================================================================

describe("fetchGitLabLatestRelease", () => {
	it("hanging getToken is bounded by timeoutMs → GitLab: token acquisition timed out", async () => {
		const hangingGetToken = () => new Promise<string>(() => {});
		await expect(
			fetchGitLabLatestRelease({
				getToken: hangingGetToken,
				owner: "g",
				repo: "p",
				repositoryUrl: "u",
				timeoutMs: 500,
			}),
		).rejects.toThrow("GitLab: token acquisition timed out");
	});

	it("401-refresh callback handed to gitlabRequest is bounded by timeoutMs", async () => {
		let calls = 0;
		const getToken = () => {
			calls += 1;
			return calls === 1
				? Promise.resolve("tok")
				: new Promise<string>(() => {}); // the refresh stalls forever
		};
		gitlabRequestMock.mockResolvedValueOnce({
			status: 200,
			headers: new Headers(),
			body: glRelease("v1", "2026-06-09T10:00:00Z"),
		});
		await fetchGitLabLatestRelease({
			getToken,
			owner: "g",
			repo: "p",
			repositoryUrl: "u",
			timeoutMs: 500,
		});
		const onRefreshToken =
			gitlabRequestMock.mock.calls[0][0].onRefreshToken;
		expect(onRefreshToken).toBeDefined();
		await expect(
			(onRefreshToken as () => Promise<string>)(),
		).rejects.toThrow("token acquisition timed out");
	});

	it("returns null on 404", async () => {
		gitlabRequestMock.mockRejectedValueOnce(
			new GitLabApiError(404, "Not Found"),
		);
		await expect(
			fetchGitLabLatestRelease({
				getToken: async () => "t",
				owner: "g",
				repo: "p",
				repositoryUrl: "u",
				timeoutMs: 5000,
			}),
		).resolves.toBeNull();
	});
});

// =============================================================================
// fetchGitLabMergeRequests
// =============================================================================

describe("fetchGitLabMergeRequests", () => {
	it("budget below floor before token acquisition → truncated, getToken NOT called", async () => {
		const getToken = vi.fn(async () => "t");
		const out = await fetchGitLabMergeRequests({
			getToken,
			owner: "g",
			repo: "p",
			updatedSince: new Date("2026-06-09T00:00:00Z"),
			remainingMs: () => 100, // below MIN_FETCH_MS (500)
		});
		expect(out).toEqual({ mrs: [], truncated: true });
		expect(getToken).not.toHaveBeenCalled();
		expect(gitlabRequestMock).not.toHaveBeenCalled();
	});

	it("maps MR fields to the PR shape", async () => {
		gitlabRequestMock.mockResolvedValueOnce({
			status: 200,
			headers: new Headers(),
			body: [
				glMr({
					iid: 7,
					state: "merged",
					merged_at: "2026-06-09T12:00:00Z",
					reviewers: [{ username: "rev1" }],
				}),
			],
		});
		const out = await fetchGitLabMergeRequests({
			getToken: async () => "t",
			owner: "g",
			repo: "p",
			updatedSince: new Date("2026-06-09T00:00:00Z"),
			remainingMs: () => 60_000,
		});
		expect(out.truncated).toBe(false); // short page → window provably exhausted
		expect(out.mrs[0]).toMatchObject({
			number: 7,
			state: "closed",
			merged_at: "2026-06-09T12:00:00Z",
			requested_reviewers: [{ login: "rev1" }],
			base: { ref: "main" },
		});
		// ordering params asserted — the short-circuit invariant depends on them
		expect(gitlabRequestMock.mock.calls[0][0].query).toMatchObject({
			state: "all",
			order_by: "updated_at",
			sort: "desc",
		});
	});

	it("MR budget exhaustion mid-pagination → partial mrs + truncated", async () => {
		const fullPage = Array.from({ length: 50 }, (_, i) =>
			glMr({ iid: i + 1, updated_at: "2026-06-09T12:00:00Z" }),
		);
		gitlabRequestMock.mockResolvedValueOnce({
			status: 200,
			headers: new Headers(),
			body: fullPage,
		});
		// token-bound check, then page 1 ok, then exhausted before page 2.
		const budgets = [60_000, 60_000, 100];
		const out = await fetchGitLabMergeRequests({
			getToken: async () => "t",
			owner: "g",
			repo: "p",
			updatedSince: new Date("2026-06-09T00:00:00Z"),
			remainingMs: () => budgets.shift() ?? 100,
		});
		expect(out.mrs).toHaveLength(50);
		expect(out.truncated).toBe(true);
	});

	it("MR cap hit without window proof → truncated (cache must not claim coverage)", async () => {
		// Two FULL pages, all updated in-window → cap (100) reached with more possible.
		const page = (offset: number) =>
			Array.from({ length: 50 }, (_, i) =>
				glMr({
					iid: offset + i + 1,
					updated_at: "2026-06-09T12:00:00Z",
				}),
			);
		gitlabRequestMock
			.mockResolvedValueOnce({
				status: 200,
				headers: new Headers(),
				body: page(0),
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: new Headers(),
				body: page(50),
			});
		const out = await fetchGitLabMergeRequests({
			getToken: async () => "t",
			owner: "g",
			repo: "p",
			updatedSince: new Date("2026-06-09T00:00:00Z"),
			remainingMs: () => 60_000,
		});
		expect(out.mrs).toHaveLength(100);
		expect(out.truncated).toBe(true);
	});

	it("short-circuits past the window like GitHub", async () => {
		// Page 1 full (50 MRs), last one updated BEFORE updatedSince → no page 2.
		const oldMrs = Array.from({ length: 50 }, (_, i) =>
			glMr({
				iid: i + 1,
				state: "opened",
				updated_at: "2026-06-01T00:00:00Z",
			}),
		);
		gitlabRequestMock.mockResolvedValueOnce({
			status: 200,
			headers: new Headers(),
			body: oldMrs,
		});
		await fetchGitLabMergeRequests({
			getToken: async () => "t",
			owner: "g",
			repo: "p",
			updatedSince: new Date("2026-06-09T00:00:00Z"),
			remainingMs: () => 60_000,
		});
		expect(gitlabRequestMock).toHaveBeenCalledTimes(1);
	});
});
