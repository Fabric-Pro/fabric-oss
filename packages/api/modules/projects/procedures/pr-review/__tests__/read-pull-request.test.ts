/**
 * `projects.pullRequestReviews.read` — fetch a pull request and store the diff.
 *
 * Locks the contract phase 2 will be built on:
 *   - an integration belonging to another project is not readable, and says so
 *     as "not connected" rather than as a credential failure;
 *   - a non-GitHub repo is refused by name instead of failing deeper;
 *   - a diff larger than the cap is TRUNCATED AND MARKED — the whole point of
 *     the bound is that a partial read never reads as a complete one;
 *   - a PR whose metadata read but whose diff did not is recorded FAILED, not as
 *     a review of an empty change;
 *   - the outward read is audited either way, and the audit never carries the
 *     diff or the token.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindIntegration = vi.fn();
const mockResolveToken = vi.fn();
const mockRecordRead = vi.fn();
const mockRecordAudit = vi.fn();
const mockFetch = vi.fn();
const capturedPermissions: unknown[] = [];

vi.mock("@repo/database", () => ({
	recordPullRequestRead: (...a: unknown[]) => mockRecordRead(...a),
	listPullRequestReviews: vi.fn(),
	getPullRequestReview: vi.fn(),
}));

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		projectRepositoryIntegration: {
			findFirst: (...a: unknown[]) => mockFindIntegration(...a),
		},
	},
}));

vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: (...a: unknown[]) => mockResolveToken(...a),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mockRecordAudit(...a),
}));

vi.mock("../../../lib/pr-review-feature", () => ({
	assertPrReviewEnabled: () => undefined,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: (permission: unknown) => {
			capturedPermissions.push(permission);
			return (c: unknown) => c;
		},
	};
});

const { PR_REVIEW_MAX_DIFF_BYTES, readPullRequestProcedure } = await import(
	"../read-pull-request"
);

const context = { user: { id: "user-1" }, session: {} };

const githubIntegration = {
	id: "int-1",
	provider: "GITHUB",
	repositoryOwner: "acme",
	repositoryName: "store",
	// The host resolves its API base from this, so a self-hosted instance needs
	// no second setting. Absent here, every read would fail on an invalid URL.
	repositoryUrl: "https://github.com/acme/store",
	azureOrganization: null,
	project: { organizationId: "org-1" },
};

const prPayload = {
	title: "Add checkout retry",
	html_url: "https://github.com/acme/store/pull/42",
	changed_files: 3,
	user: { login: "dana" },
	head: { sha: "a".repeat(40) },
	base: { sha: "b".repeat(40) },
};

function callRead(input: Record<string, unknown> = {}) {
	return (
		readPullRequestProcedure as unknown as {
			handler: (a: { input: unknown; context: unknown }) => Promise<{
				id: string;
				status: string;
				diffTruncated: boolean;
				changedFiles: number;
				prNumber: number;
			}>;
		}
	).handler({
		input: {
			projectId: "proj-1",
			repositoryIntegrationId: "int-1",
			prNumber: 42,
			...input,
		},
		context,
	});
}

/** GitHub answers metadata as JSON and the diff as text from one endpoint. */
function stubGithub({
	diff = "diff --git a/a.ts b/a.ts\n+const x = 1;\n",
	diffOk = true,
}: {
	diff?: string;
	diffOk?: boolean;
} = {}) {
	mockFetch.mockImplementation(
		(_url: string, init: { headers: Record<string, string> }) =>
			init.headers.Accept === "application/vnd.github.v3.diff"
				? Promise.resolve({
						ok: diffOk,
						status: diffOk ? 200 : 406,
						text: () => Promise.resolve(diff),
					})
				: Promise.resolve({
						ok: true,
						status: 200,
						json: () => Promise.resolve(prPayload),
					}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", mockFetch);
	mockFindIntegration.mockResolvedValue(githubIntegration);
	mockResolveToken.mockResolvedValue({ token: "gh-token" });
	// The write echoes back what it was asked to store, so assertions can read
	// the persisted shape without a database.
	mockRecordRead.mockImplementation((input: Record<string, unknown>) =>
		Promise.resolve({ id: "rev-1", ...input }),
	);
	stubGithub();
});

describe("readPullRequestProcedure", () => {
	it("is gated on the QA surface's write permission, not its read one", () => {
		// Reading a PR spends an API call against the customer's credential, so a
		// read-only member must not be able to trigger it.
		expect(capturedPermissions).toContain("TEST_CASE_UPDATE");
	});

	it("refuses an integration that belongs to another project", async () => {
		mockFindIntegration.mockResolvedValue(null);

		await expect(callRead()).rejects.toThrow(
			/not connected to this project/i,
		);
		expect(mockResolveToken).not.toHaveBeenCalled();
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("scopes the integration lookup by projectId", async () => {
		await callRead();

		expect(mockFindIntegration).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "int-1", projectId: "proj-1" },
			}),
		);
	});

	it("takes the owning organization from the project, not from the caller", async () => {
		// A caller-supplied org would let somebody pair their own project with
		// another organization's id: `requireProjectPermission` authorizes the
		// project and never looks at the org (SOC 2 CC6.1/CC6.3).
		mockFindIntegration.mockResolvedValue({
			...githubIntegration,
			project: { organizationId: "org-owning-the-project" },
		});

		await callRead({ organizationId: "org-the-caller-claims" });

		expect(mockResolveToken).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-owning-the-project",
			}),
		);
	});

	it("refuses a provider it has no implementation for, by name", async () => {
		// GitHub, GitLab and Azure DevOps are implemented. Anything else is
		// refused here rather than failing deeper with a confusing error.
		mockFindIntegration.mockResolvedValue({
			...githubIntegration,
			provider: "BITBUCKET",
		});

		await expect(callRead()).rejects.toThrow(
			/not supported for BITBUCKET/i,
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("refuses when the repository has no usable credential", async () => {
		mockResolveToken.mockResolvedValue({ token: null });

		await expect(callRead()).rejects.toThrow(/no usable credential/i);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("stores the PR's identity and diff, and audits the outward read", async () => {
		const review = await callRead();

		expect(review.status).toBe("READ");
		const stored = mockRecordRead.mock.calls[0][0];
		expect(stored).toMatchObject({
			projectId: "proj-1",
			repoOwner: "acme",
			repoName: "store",
			prNumber: 42,
			title: "Add checkout retry",
			authorLabel: "dana",
			headSha: "a".repeat(40),
			baseSha: "b".repeat(40),
			changedFiles: 3,
			diffTruncated: false,
			requestedById: "user-1",
		});

		const audit = mockRecordAudit.mock.calls[0][1];
		expect(audit).toMatchObject({
			action: "project.pull_request.read",
			outcome: "success",
			projectId: "proj-1",
		});
		// The ledger records WHAT was read, never the code itself or the token.
		expect(JSON.stringify(audit)).not.toContain("gh-token");
		expect(JSON.stringify(audit)).not.toContain("diff --git");
	});

	it("truncates a diff larger than the cap and marks it truncated", async () => {
		stubGithub({ diff: "x".repeat(PR_REVIEW_MAX_DIFF_BYTES + 5_000) });

		const review = await callRead();

		const stored = mockRecordRead.mock.calls[0][0];
		expect(stored.diff).toHaveLength(PR_REVIEW_MAX_DIFF_BYTES);
		// The mark is the point: a partial read must never look like a whole one.
		expect(stored.diffTruncated).toBe(true);
		expect(review.status).toBe("READ");
	});

	it("does not mark a diff exactly at the cap as truncated", async () => {
		stubGithub({ diff: "x".repeat(PR_REVIEW_MAX_DIFF_BYTES) });

		await callRead();

		expect(mockRecordRead.mock.calls[0][0].diffTruncated).toBe(false);
	});

	it("records a readable PR whose diff could not be fetched as FAILED", async () => {
		stubGithub({ diffOk: false });

		const review = await callRead();

		expect(review.status).toBe("FAILED");
		const stored = mockRecordRead.mock.calls[0][0];
		expect(stored.diff).toBeNull();
		expect(stored.failureText).toMatch(/HTTP 406/);
		expect(mockRecordAudit.mock.calls[0][1]).toMatchObject({
			outcome: "failure",
		});
	});

	it("reports a missing pull request without leaking GitHub's error body", async () => {
		mockFetch.mockResolvedValue({ ok: false, status: 404 });

		await expect(callRead()).rejects.toThrow(
			/read pull request #42 in acme\/store/,
		);
		expect(mockRecordRead).not.toHaveBeenCalled();
	});

	it("refuses a PR GitHub returns with no commit range", async () => {
		mockFetch.mockImplementation(() =>
			Promise.resolve({
				ok: true,
				status: 200,
				json: () =>
					Promise.resolve({ title: "Draft", head: {}, base: {} }),
			}),
		);

		await expect(callRead()).rejects.toThrow(/no commit range/i);
		expect(mockRecordRead).not.toHaveBeenCalled();
	});
});
