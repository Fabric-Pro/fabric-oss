import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getProjectReposForCodeSearch: vi.fn(),
	db: { project: { findUnique: vi.fn() } },
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((token: string) => token),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
// The collector now resolves credentials via the REAL `./resolve-repo-auth`,
// which imports `@repo/integrations/gitlab`. Stub it so the module graph loads;
// GitLab rows degrade to the stored-token path (env creds unset below), and the
// MR fetcher itself is mocked, so these stubs are never actually invoked.
vi.mock("@repo/integrations/gitlab", () => ({
	getValidGitLabAccessToken: vi.fn(),
	refreshGitLabToken: vi.fn(),
}));
// Provider fetchers are mocked (file-scoped, hoisted). The existing GitHub-only
// tests never reach these modules — GitHub rows resolve to `{kind:"github"}` and
// go through the real `fetchPullRequestsForRepo`/global-fetch pipeline — so these
// mocks are inert for Tasks 4/5. ADO's real constant exports are preserved via
// `importActual` because the tests assert against `ADO_PR_SCAN_TRUNCATED`.
vi.mock("../src/activities/daily-brief/providers/gitlab", () => ({
	fetchGitLabMergeRequests: vi.fn(),
}));
vi.mock("../src/activities/daily-brief/providers/azure-devops", async () => {
	const actual = await vi.importActual<
		typeof import("../src/activities/daily-brief/providers/azure-devops")
	>("../src/activities/daily-brief/providers/azure-devops");
	return { ...actual, fetchAdoPullRequests: vi.fn() };
});

import { db, getProjectReposForCodeSearch } from "@repo/database";
import {
	collectGitHubPullRequestsActivity,
	type GitHubPullRequest,
} from "../src/activities/daily-brief/collect-github-pull-requests";
import { fetchAdoPullRequests } from "../src/activities/daily-brief/providers/azure-devops";
import { fetchGitLabMergeRequests } from "../src/activities/daily-brief/providers/gitlab";
import type { RepoIntegrationRow } from "../src/activities/daily-brief/resolve-repo-auth";

const dbMock = vi.mocked(db) as unknown as {
	project: { findUnique: ReturnType<typeof vi.fn> };
};
const getProjectReposForCodeSearchMock = vi.mocked(
	getProjectReposForCodeSearch,
);
const reposMock = getProjectReposForCodeSearchMock;
const fetchGitLabMergeRequestsMock = vi.mocked(fetchGitLabMergeRequests);
const fetchAdoPullRequestsMock = vi.mocked(fetchAdoPullRequests);

// GitLab OAuth client creds MUST be unset so the resolver uses the degraded
// stored-token path (no network refresh) for GITLAB rows in this file.
delete process.env.GITLAB_CLIENT_ID;
delete process.env.GITLAB_CLIENT_SECRET;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.resetAllMocks();
	vi.unstubAllGlobals();
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

// =============================================================================
// Shared fixtures (reused by Tasks 5 and 9)
// =============================================================================

function ghRepo(integrationId: string, fullName: string): RepoIntegrationRow {
	const [owner, repo] = fullName.split("/");
	return {
		integrationId,
		provider: "GITHUB",
		owner,
		repo,
		branch: "main",
		repositoryUrl: `https://github.com/${fullName}`,
		encryptedAccessToken: "enc",
		encryptedRefreshToken: null,
		tokenExpiresAt: null,
		updatedAt: new Date(),
		encryptedPat: null,
		azureOrganization: null,
		authMethod: "OAUTH",
	};
}

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function mergedPr(n: number) {
	return {
		number: n,
		title: `PR ${n}`,
		body: "b",
		state: "closed",
		draft: false,
		html_url: `https://github.com/o/r/pull/${n}`,
		created_at: "2026-06-09T01:00:00Z",
		updated_at: "2026-06-09T12:00:00Z",
		closed_at: "2026-06-09T12:00:00Z",
		merged_at: "2026-06-09T12:00:00Z",
		user: { login: "alice" },
		requested_reviewers: [],
		head: { ref: "feat" },
		base: { ref: "main" },
	};
}

/** GitHub PR list endpoint stub (single page; subsequent pages empty). */
function stubGitHubPrFetch(prs: unknown[]) {
	fetchMock.mockResolvedValue(jsonResponse(prs));
}

function tenantOk() {
	dbMock.project.findUnique.mockResolvedValue({
		organizationId: "org1",
		userId: "u1",
	});
}

// =============================================================================
// Task 4 — FR-9 tenant guard
// =============================================================================

const baseInput = {
	projectId: "p1",
	organizationId: "org1" as string | null,
	userId: "u1" as string | undefined,
	timeWindowStart: new Date("2026-06-09T00:00:00Z"),
	timeWindowEnd: new Date("2026-06-10T00:00:00Z"),
};

describe("collectGitHubPullRequestsActivity — tenant guard (FR-9)", () => {
	it("org-context mismatch → empty output, no repo lookup", async () => {
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: "other",
			userId: "x",
		});
		const out = await collectGitHubPullRequestsActivity(baseInput);
		expect(out).toEqual({ items: [], failures: [], stalePrActions: [] });
		expect(getProjectReposForCodeSearchMock).not.toHaveBeenCalled();
	});

	it("personal-context mismatch with userId present → empty output", async () => {
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: null,
			userId: "someone-else",
		});
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			organizationId: null,
		});
		expect(out.items).toEqual([]);
		expect(getProjectReposForCodeSearchMock).not.toHaveBeenCalled();
	});

	it("legacy payload (no userId) + org context → org-only check passes", async () => {
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org1",
			userId: "whoever",
		});
		getProjectReposForCodeSearchMock.mockResolvedValue([]);
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			userId: undefined,
		});
		expect(getProjectReposForCodeSearchMock).toHaveBeenCalled(); // proceeded
		expect(out.failures).toEqual([]);
	});

	it("legacy payload (no userId) + personal context → fails closed, no credential path", async () => {
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: null,
			userId: "u1",
		});
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			organizationId: null,
			userId: undefined,
		});
		expect(out).toEqual({ items: [], failures: [], stalePrActions: [] });
		expect(getProjectReposForCodeSearchMock).not.toHaveBeenCalled();
	});

	it("matching tenant proceeds to repo collection", async () => {
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org1",
			userId: "u1",
		});
		getProjectReposForCodeSearchMock.mockResolvedValue([]);
		const out = await collectGitHubPullRequestsActivity(baseInput);
		expect(out).toEqual({ items: [], failures: [], stalePrActions: [] });
	});
});

// =============================================================================
// Task 5 — FR-10 soft budget machinery
// =============================================================================

describe("collectGitHubPullRequestsActivity — budget machinery (FR-10)", () => {
	it("soft-budget exhaustion mid-run records failures for remaining repos, keeps completed items", async () => {
		vi.useFakeTimers();
		// two GitHub repos; first fetch advances the clock past PR_SOFT_BUDGET_MS
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org1",
			userId: "u1",
		});
		getProjectReposForCodeSearchMock.mockResolvedValue([
			ghRepo("int-budget-1", "o/r1"),
			ghRepo("int-budget-2", "o/r2"),
		]);
		fetchMock.mockImplementationOnce(async () => {
			vi.advanceTimersByTime(91_000); // > PR_SOFT_BUDGET_MS (90_000)
			return jsonResponse([mergedPr(1)]);
		});
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-budget-1",
		});
		expect(out.items.length).toBeGreaterThan(0); // repo 1's merged PR survived
		expect(out.failures).toContainEqual({
			repoFullName: "o/r2",
			reason: "Skipped — pull request fetch time budget exceeded for this brief",
		});
		vi.useRealTimers();
	});

	it("every fetch carries an AbortSignal", async () => {
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org1",
			userId: "u1",
		});
		getProjectReposForCodeSearchMock.mockResolvedValue([
			ghRepo("int-signal-1", "o/r1"),
		]);
		fetchMock.mockResolvedValue(jsonResponse([]));
		await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-signal-1",
		});
		expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("budget expires after page 1 while a second full page is possible → partial items + PR_SCAN_INCOMPLETE failure + second run refetches (nothing cached)", async () => {
		vi.useFakeTimers();
		const fullPage = Array.from({ length: 50 }, (_, i) => mergedPr(i + 1));
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org1",
			userId: "u1",
		});
		getProjectReposForCodeSearchMock.mockResolvedValue([
			ghRepo("int-page-budget-1", "o/r1"),
		]);
		// First page: full (50), advances clock past budget before page 2 can start
		fetchMock.mockImplementationOnce(async () => {
			vi.advanceTimersByTime(91_000); // > PR_SOFT_BUDGET_MS after page 1
			return jsonResponse(fullPage);
		});
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-page-budget-1",
		});
		// Items from page 1 survive
		expect(out.items.length).toBeGreaterThan(0);
		// PR_SCAN_INCOMPLETE failure recorded
		expect(
			out.failures.some(
				(f) =>
					f.repoFullName === "o/r1" &&
					/incomplete|budget|too many/i.test(f.reason),
			),
		).toBe(true);
		// Not cached: second run with same integrationId should refetch
		fetchMock.mockResolvedValue(jsonResponse([]));
		vi.useRealTimers();
		const out2 = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-page-budget-1",
		});
		// Fetch was called again (not served from cache)
		expect(fetchMock).toHaveBeenCalled();
		// Second run returns 0 items (empty mock)
		expect(out2.items).toHaveLength(0);
	});

	it("cap-hit — two full 50-PR pages all updated in-window → items capped, failure entry, no cache write", async () => {
		// Each page is a full 50 items, all updated in-window, so no window proof
		const page = (offset: number) =>
			Array.from({ length: 50 }, (_, i) => ({
				...mergedPr(offset + i + 1),
				// all updated within window so no short-circuit
				updated_at: "2026-06-09T12:00:00Z",
			}));
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org1",
			userId: "u1",
		});
		getProjectReposForCodeSearchMock.mockResolvedValue([
			ghRepo("int-cap-1", "o/r1"),
		]);
		fetchMock
			.mockResolvedValueOnce(jsonResponse(page(0)))
			.mockResolvedValueOnce(jsonResponse(page(50)));
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-cap-1",
		});
		// Items are capped at MAX_PRS_PER_REPO (100)
		// (some items may be classified into multiple kinds, but raw PRs ≤ 100)
		const uniquePrNumbers = new Set(out.items.map((i) => i.prNumber));
		expect(uniquePrNumbers.size).toBeLessThanOrEqual(100);
		// PR_SCAN_INCOMPLETE failure recorded (cap hit without window proof)
		expect(
			out.failures.some(
				(f) =>
					f.repoFullName === "o/r1" &&
					/incomplete|budget|too many/i.test(f.reason),
			),
		).toBe(true);
		// Not cached: second run should refetch
		fetchMock.mockResolvedValue(jsonResponse([]));
		const out2 = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-cap-1",
		});
		expect(fetchMock).toHaveBeenCalled();
		expect(out2.items).toHaveLength(0);
	});

	it("naturally-exhausted list (short page) → truncated false, cached (second run does NOT refetch), no failure entry", async () => {
		// Short page (< 50) → proven complete → not truncated → cached
		const shortPage = [mergedPr(1), mergedPr(2), mergedPr(3)];
		dbMock.project.findUnique.mockResolvedValue({
			organizationId: "org1",
			userId: "u1",
		});
		getProjectReposForCodeSearchMock.mockResolvedValue([
			ghRepo("int-exhausted-1", "o/r1"),
		]);
		fetchMock.mockResolvedValue(jsonResponse(shortPage));
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-exhausted-1",
		});
		// 3 PRs, all merged in-window → some items
		expect(out.items.length).toBeGreaterThan(0);
		// No PR_SCAN_INCOMPLETE failure
		expect(
			out.failures.some(
				(f) =>
					f.repoFullName === "o/r1" &&
					/incomplete|budget|too many/i.test(f.reason),
			),
		).toBe(false);
		// Cached: second run should NOT call fetch again
		fetchMock.mockClear();
		const out2 = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-exhausted-1",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(out2.items.length).toBeGreaterThan(0); // served from cache
	});
});

// =============================================================================
// Task 9 — provider dispatch (GitLab MRs + Azure DevOps PRs)
// =============================================================================

import { ADO_PR_SCAN_TRUNCATED } from "../src/activities/daily-brief/providers/azure-devops";

/** A GitLab repo row — resolves (real resolver) to `{kind:"gitlab"}`. */
function glRepo(
	integrationId: string,
	owner: string,
	repo: string,
): RepoIntegrationRow {
	return { ...ghRepo(integrationId, `${owner}/${repo}`), provider: "GITLAB" };
}
/** An Azure DevOps repo row — resolves (real resolver) to `{kind:"ado"}`. */
function adoRepo(
	integrationId: string,
	owner: string,
	repo: string,
): RepoIntegrationRow {
	return {
		...ghRepo(integrationId, `${owner}/${repo}`),
		provider: "AZURE_DEVOPS",
		authMethod: "PAT",
		encryptedAccessToken: null,
		encryptedPat: "enc-pat",
		azureOrganization: owner,
		repositoryUrl: `https://dev.azure.com/${owner}/Proj/_git/${repo}`,
	};
}
/** Normalized GitHub-shaped raw PR — what the provider fetchers return. */
function normPr(overrides: Partial<GitHubPullRequest>): GitHubPullRequest {
	return {
		number: 1,
		title: "PR",
		body: "b",
		state: "open",
		draft: false,
		html_url: "https://example.com/pr/1",
		created_at: "2026-06-09T01:00:00Z",
		updated_at: "2026-06-09T02:00:00Z",
		closed_at: null,
		merged_at: null,
		user: { login: "alice" },
		requested_reviewers: [],
		head: { ref: "feat" },
		base: { ref: "main" },
		...overrides,
	};
}

describe("collectGitHubPullRequestsActivity — provider dispatch (Task 9)", () => {
	it("GitLab MRs flow through cache and classification (pr_merged emitted; cached on 2nd run)", async () => {
		tenantOk();
		reposMock.mockResolvedValue([glRepo("int-gl-1", "grp", "proj")]);
		fetchGitLabMergeRequestsMock.mockResolvedValue({
			mrs: [
				normPr({
					number: 7,
					merged_at: "2026-06-09T12:00:00Z",
					state: "closed",
				}),
			],
			truncated: false,
		});
		const out1 = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-gl-1",
		});
		expect(out1.items).toContainEqual(
			expect.objectContaining({ kind: "pr_merged", prNumber: 7 }),
		);
		await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-gl-1",
		}); // same window, within TTL
		expect(fetchGitLabMergeRequestsMock).toHaveBeenCalledTimes(1); // cache hit
	});

	it("ADO bypasses the cache: same window twice → fetchAdoPullRequests called twice", async () => {
		tenantOk();
		reposMock.mockResolvedValue([adoRepo("int-ado-1", "org", "r")]);
		fetchAdoPullRequestsMock.mockResolvedValue({
			prs: [],
			truncated: false,
		});
		await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-ado-1",
		});
		await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-ado-1",
		});
		expect(fetchAdoPullRequestsMock).toHaveBeenCalledTimes(2);
	});

	it("ADO different window within TTL → fresh bucket queries with the NEW window", async () => {
		tenantOk();
		reposMock.mockResolvedValue([adoRepo("int-ado-2", "org", "r")]);
		fetchAdoPullRequestsMock.mockResolvedValue({
			prs: [],
			truncated: false,
		});
		await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-ado-2",
		});
		const laterWindow = {
			...baseInput,
			projectId: "p-ado-2",
			timeWindowStart: new Date("2026-06-10T00:00:00Z"),
			timeWindowEnd: new Date("2026-06-11T00:00:00Z"),
		};
		await collectGitHubPullRequestsActivity(laterWindow);
		expect(fetchAdoPullRequestsMock).toHaveBeenLastCalledWith(
			expect.objectContaining({
				windowStart: laterWindow.timeWindowStart,
				windowEnd: laterWindow.timeWindowEnd,
			}),
		);
	});

	it("ADO truncated → ADO_PR_SCAN_TRUNCATED failure entry", async () => {
		tenantOk();
		reposMock.mockResolvedValue([adoRepo("int-ado-3", "org", "r")]);
		fetchAdoPullRequestsMock.mockResolvedValue({
			prs: [],
			truncated: true,
		});
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-ado-3",
		});
		expect(out.failures).toContainEqual({
			repoFullName: "org/r",
			reason: ADO_PR_SCAN_TRUNCATED,
		});
	});

	it("ADO classification: completed → pr_merged; abandoned → pr_closed; active+reviewers → pr_awaiting_review", async () => {
		tenantOk();
		reposMock.mockResolvedValue([adoRepo("int-ado-4", "org", "r")]);
		fetchAdoPullRequestsMock.mockResolvedValue({
			prs: [
				normPr({
					number: 1,
					state: "closed",
					merged_at: "2026-06-09T12:00:00Z",
					closed_at: "2026-06-09T12:00:00Z",
				}),
				normPr({
					number: 2,
					state: "closed",
					merged_at: null,
					closed_at: "2026-06-09T13:00:00Z",
				}),
				normPr({
					number: 3,
					state: "open",
					created_at: "2026-06-09T14:00:00Z",
					updated_at: "2026-06-09T14:00:00Z",
					requested_reviewers: [{ login: "rev1" }],
				}),
			],
			truncated: false,
		});
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-ado-4",
		});
		const kinds = out.items.map((i) => [i.prNumber, i.kind]);
		expect(kinds).toContainEqual([1, "pr_merged"]);
		expect(kinds).toContainEqual([2, "pr_closed"]);
		expect(kinds).toContainEqual([3, "pr_awaiting_review"]);
	});

	it("boundary PRs exactly at windowStart/windowEnd are included", async () => {
		tenantOk();
		reposMock.mockResolvedValue([adoRepo("int-ado-5", "org", "r")]);
		fetchAdoPullRequestsMock.mockResolvedValue({
			prs: [
				normPr({
					number: 1,
					state: "closed",
					merged_at: baseInput.timeWindowStart.toISOString(),
					closed_at: baseInput.timeWindowStart.toISOString(),
				}),
				normPr({
					number: 2,
					created_at: baseInput.timeWindowEnd.toISOString(),
				}),
			],
			truncated: false,
		});
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-ado-5",
		});
		expect(out.items).toContainEqual(
			expect.objectContaining({ prNumber: 1, kind: "pr_merged" }),
		);
		expect(out.items).toContainEqual(
			expect.objectContaining({ prNumber: 2, kind: "pr_opened" }),
		);
	});

	it("ADO stale: old active PR with pending reviewers → pr_review_stale via creationDate", async () => {
		tenantOk();
		reposMock.mockResolvedValue([adoRepo("int-ado-6", "org", "r")]);
		fetchAdoPullRequestsMock.mockResolvedValue({
			prs: [
				normPr({
					number: 9,
					state: "open",
					created_at: "2026-05-01T00:00:00Z",
					updated_at: "2026-05-01T00:00:00Z",
					requested_reviewers: [{ login: "rev1" }],
				}),
			],
			truncated: false,
		});
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-ado-6",
		});
		expect(out.stalePrActions).toContainEqual(
			expect.objectContaining({
				kind: "pr_review_stale",
				targetIdentifier: "PR #9",
			}),
		);
	});

	it("provider failure isolation: ADO repo throws → GitHub repo unaffected", async () => {
		tenantOk();
		reposMock.mockResolvedValue([
			adoRepo("int-ado-bad", "org", "bad"),
			ghRepo("int-gh-good", "o/good"),
		]);
		fetchAdoPullRequestsMock.mockRejectedValue(
			new Error("Azure DevOps API error: HTTP 403"),
		);
		stubGitHubPrFetch([mergedPr(5)]); // fetch-stub helper from the Task 4 prelude
		const out = await collectGitHubPullRequestsActivity({
			...baseInput,
			projectId: "p-iso-1",
		});
		expect(out.items).toContainEqual(
			expect.objectContaining({
				prNumber: 5,
				kind: "pr_merged",
				repoFullName: "o/good",
			}),
		);
		expect(out.failures).toContainEqual(
			expect.objectContaining({
				repoFullName: "org/bad",
				reason: expect.stringContaining("Azure DevOps API error"),
			}),
		);
	});
});
