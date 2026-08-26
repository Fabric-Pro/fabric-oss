import { describe, expect, it } from "vitest";
import {
	classifyPullRequests,
	type GitHubPullRequest,
} from "../collect-github-pull-requests";

const WINDOW_START = new Date("2026-01-01T00:00:00Z");
const WINDOW_END = new Date("2026-12-31T23:59:59Z");

function mergedPr(
	overrides: Partial<GitHubPullRequest> = {},
): GitHubPullRequest {
	return {
		number: 1,
		title: "Add feature",
		body: null,
		state: "closed",
		draft: false,
		html_url: "https://github.com/o/r/pull/1",
		created_at: "2026-05-01T00:00:00Z",
		updated_at: "2026-06-01T00:00:00Z",
		closed_at: "2026-06-01T00:00:00Z",
		merged_at: "2026-06-01T00:00:00Z",
		user: { login: "octocat", id: 583231 },
		requested_reviewers: null,
		head: { ref: "feature" },
		base: { ref: "main" },
		...overrides,
	};
}

describe("classifyPullRequests — authorGithubId capture (flag-gated)", () => {
	it("captures the numeric author id as a string when captureAuthorGithubId is true", () => {
		const items = classifyPullRequests({
			prs: [mergedPr()],
			repoFullName: "o/r",
			timeWindowStart: WINDOW_START,
			timeWindowEnd: WINDOW_END,
			captureAuthorGithubId: true,
		});
		expect(items.length).toBeGreaterThan(0);
		expect(items[0].author).toBe("octocat");
		expect(items[0].authorGithubId).toBe("583231");
	});

	it("omits authorGithubId when the flag is absent, even when pr.user.id is present (Daily Brief default — the source-level lock)", () => {
		const items = classifyPullRequests({
			prs: [mergedPr()],
			repoFullName: "o/r",
			timeWindowStart: WINDOW_START,
			timeWindowEnd: WINDOW_END,
			// captureAuthorGithubId omitted → default OFF
		});
		expect(items.length).toBeGreaterThan(0);
		expect(items[0].author).toBe("octocat"); // login is still captured
		expect(items[0].authorGithubId).toBeUndefined();
	});

	it("omits authorGithubId when the flag is explicitly false", () => {
		const items = classifyPullRequests({
			prs: [mergedPr()],
			repoFullName: "o/r",
			timeWindowStart: WINDOW_START,
			timeWindowEnd: WINDOW_END,
			captureAuthorGithubId: false,
		});
		expect(items.length).toBeGreaterThan(0);
		expect(items[0].authorGithubId).toBeUndefined();
	});

	it("omits authorGithubId when the PR has no user even with the flag on", () => {
		const items = classifyPullRequests({
			prs: [mergedPr({ user: null })],
			repoFullName: "o/r",
			timeWindowStart: WINDOW_START,
			timeWindowEnd: WINDOW_END,
			captureAuthorGithubId: true,
		});
		expect(items.length).toBeGreaterThan(0);
		expect(items[0].author).toBeUndefined();
		expect(items[0].authorGithubId).toBeUndefined();
	});
});
