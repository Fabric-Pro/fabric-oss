import { beforeEach, describe, expect, it, vi } from "vitest";

// Bare unit test: Context.current() throws "Activity context not initialized"
// outside a real Temporal activity execution, so collectPullRequests's
// `Context.current().heartbeat()` needs Context mocked (mirrors
// collect-stories.test.ts / fetch-ado-states-heartbeat.test.ts).
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

// vi.mock factories are hoisted above all other top-level code, so the mock's
// backing fn must be created via vi.hoisted (see collect-stories.test.ts).
const { collectGitHubPullRequestsActivityMock } = vi.hoisted(() => ({
	collectGitHubPullRequestsActivityMock: vi.fn(),
}));

vi.mock("../../daily-brief/collect-github-pull-requests", () => ({
	collectGitHubPullRequestsActivity: collectGitHubPullRequestsActivityMock,
}));

import {
	collectPullRequests,
	PR_MAX_FAILURE_REASON_CHARS,
	PR_MAX_FAILURES,
} from "../collect-pull-requests";

const WINDOW_START = "2026-07-01T00:00:00.000Z";
const WINDOW_END = "2026-07-08T00:00:00.000Z";
const IN_WINDOW = new Date("2026-07-04T12:00:00.000Z");

function baseInput() {
	return {
		projectId: "proj-a",
		organizationId: "org-a",
		userId: "user-a",
		windowStart: WINDOW_START,
		windowEnd: WINDOW_END,
	};
}

function prItem(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		kind: "pr_opened",
		prNumber: 1,
		repoFullName: "acme/repo",
		url: "https://github.com/acme/repo/pull/1",
		occurredAt: IN_WINDOW,
		title: "A PR",
		...overrides,
	};
}

beforeEach(() => {
	collectGitHubPullRequestsActivityMock.mockReset();
	collectGitHubPullRequestsActivityMock.mockResolvedValue({
		items: [],
		failures: [],
		stalePrActions: [],
	});
});

describe("collectPullRequests", () => {
	// F6: a mass provider failure (one failure per repo) must not push the
	// activity return past Temporal's ~4MB gRPC limit — bound the array length
	// and each reason string, and treat truncation as source incompleteness.
	it("bounds an oversized failures[] array to PR_MAX_FAILURES entries with reasons capped at PR_MAX_FAILURE_REASON_CHARS, and sets capExhausted", async () => {
		const hugeReason = "x".repeat(PR_MAX_FAILURE_REASON_CHARS * 3);
		const failures = Array.from(
			{ length: PR_MAX_FAILURES + 25 },
			(_, i) => ({
				repoFullName: `acme/repo-${i}`,
				reason: hugeReason,
			}),
		);
		collectGitHubPullRequestsActivityMock.mockResolvedValue({
			items: [],
			failures,
			stalePrActions: [],
		});

		const result = await collectPullRequests(baseInput());

		expect(result.failures.length).toBeLessThanOrEqual(PR_MAX_FAILURES);
		for (const f of result.failures) {
			expect(f.reason.length).toBeLessThanOrEqual(
				PR_MAX_FAILURE_REASON_CHARS,
			);
		}
		expect(result.capExhausted).toBe(true);
	});

	it("preserves the other failure fields (repoFullName) and truncates only reason", async () => {
		collectGitHubPullRequestsActivityMock.mockResolvedValue({
			items: [],
			failures: [
				{
					repoFullName: "acme/repo-1",
					reason: "x".repeat(PR_MAX_FAILURE_REASON_CHARS + 100),
				},
			],
			stalePrActions: [],
		});

		const result = await collectPullRequests(baseInput());

		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]?.repoFullName).toBe("acme/repo-1");
		expect(result.failures[0]?.reason).toHaveLength(
			PR_MAX_FAILURE_REASON_CHARS,
		);
	});

	it("leaves a small failures[] array unchanged and does not set capExhausted from failures", async () => {
		collectGitHubPullRequestsActivityMock.mockResolvedValue({
			items: [],
			failures: [{ repoFullName: "acme/repo-1", reason: "auth expired" }],
			stalePrActions: [],
		});

		const result = await collectPullRequests(baseInput());

		expect(result.failures).toEqual([
			{ repoFullName: "acme/repo-1", reason: "auth expired" },
		]);
		expect(result.capExhausted).toBe(false);
	});

	it("returns items + count for the base case, unaffected by the failures bound", async () => {
		collectGitHubPullRequestsActivityMock.mockResolvedValue({
			items: [prItem({ prNumber: 1 }), prItem({ prNumber: 2 })],
			failures: [],
			stalePrActions: [],
		});

		const result = await collectPullRequests(baseInput());

		expect(result.count).toBe(2);
		expect(result.qualifyingCount).toBe(2);
		expect(result.capExhausted).toBe(false);
	});

	// The publishing path is the ONLY caller that requests PR-author github-id
	// capture. It threads `captureAuthorGithubId: true` into the shared collector
	// so the numeric id is emitted here (and only here) for the attribution
	// resolver — the Daily Brief proxy call omits the flag and never sees it.
	it("requests author-github-id capture and surfaces authorGithubId on the emitted item", async () => {
		collectGitHubPullRequestsActivityMock.mockResolvedValue({
			items: [prItem({ prNumber: 1, authorGithubId: "583231" })],
			failures: [],
			stalePrActions: [],
		});

		const result = await collectPullRequests(baseInput());

		expect(collectGitHubPullRequestsActivityMock).toHaveBeenCalledWith(
			expect.objectContaining({ captureAuthorGithubId: true }),
		);
		expect(result.items[0]).toHaveProperty("authorGithubId", "583231");
	});
});
