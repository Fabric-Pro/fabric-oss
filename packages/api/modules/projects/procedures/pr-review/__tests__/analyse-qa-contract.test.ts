/**
 * Contract gaps in `analysePullRequestQaProcedure` and the query it depends on —
 * found by the QA review lens reviewing its own pull request (#2411) on staging.
 *
 * Worth recording how these arrived, because it is the argument for the feature:
 * the lens read 30 files of its own implementation, returned six findings, and
 * every one was a real untested branch in code written the day before. These are
 * three of them. The other three are UI and live in the web suite.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.fn();
const mockGetReview = vi.fn();
const mockFeatures = vi.fn();
const mockReplace = vi.fn();
const mockReview = vi.fn();
const mockAudit = vi.fn();

vi.mock("@repo/database", () => ({
	getProjectQaSettings: (...a: unknown[]) => mockSettings(...a),
	getPullRequestReview: (...a: unknown[]) => mockGetReview(...a),
	listFeaturesForPrReview: (...a: unknown[]) => mockFeatures(...a),
	replaceLensFindings: (...a: unknown[]) => mockReplace(...a),
	setPullRequestReviewFindingStatus: vi.fn(),
	getProjectImportGraph: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	reviewPullRequestForQa: (...a: unknown[]) => mockReview(...a),
	diffFilePaths: () => new Set<string>(),
	PR_REVIEW_MAX_FEATURES: 40,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mockAudit(...a),
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
		requireProjectPermission: () => (c: unknown) => c,
	};
});

const { analysePullRequestQaProcedure } = await import("../analyse-qa");

const context = { user: { id: "user-1" }, session: {} };

function call() {
	return (
		analysePullRequestQaProcedure as unknown as {
			handler: (a: { input: unknown; context: unknown }) => Promise<{
				configured: boolean;
				findings: unknown[];
				dropped: number;
			}>;
		}
	).handler({
		input: { projectId: "proj-1", id: "rev-1" },
		context,
	});
}

const READ_REVIEW = {
	id: "rev-1",
	diff: "diff --git a/a.ts b/a.ts",
	diffTruncated: false,
	repoOwner: "acme",
	repoName: "store",
	prNumber: 42,
	headSha: "a".repeat(40),
	failureText: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockSettings.mockResolvedValue({
		prReviewQaLensEnabled: true,
		prReviewArchitectureLensEnabled: true,
		strategyDepth: "AVERAGE",
	});
	mockGetReview.mockResolvedValue(READ_REVIEW);
	mockFeatures.mockResolvedValue([]);
	mockReplace.mockResolvedValue([]);
	mockReview.mockResolvedValue({ findings: [], dropped: 0, model: "m" });
});

describe("a review with no stored diff", () => {
	it("is refused, and does NOT write findings or stamp the review as analysed", () => {
		// Lens finding #1. The UI disables the button when there is no diff, but the
		// procedure is a reachable API surface of its own — and the damaging half is
		// not the refusal, it is that a failed analysis must not leave the review
		// LOOKING analysed. `qaAnalysedAt` is what the panel reads to decide between
		// "not reviewed" and "reviewed, found nothing".
		mockGetReview.mockResolvedValue({ ...READ_REVIEW, diff: null });

		return expect(call())
			.rejects.toThrow(/nothing to review/i)
			.then(() => {
				expect(mockReview).not.toHaveBeenCalled();
				expect(mockReplace).not.toHaveBeenCalled();
			});
	});

	it("surfaces the stored failure reason rather than a generic message", async () => {
		mockGetReview.mockResolvedValue({
			...READ_REVIEW,
			diff: null,
			failureText:
				"GitHub returned no diff for this pull request (HTTP 406).",
		});

		await expect(call()).rejects.toThrow(/HTTP 406/);
	});
});

describe("no AI provider configured", () => {
	it("returns configured:false as DATA and writes nothing", async () => {
		// Lens finding #5, server half. Null from the lens is an advisory state, not
		// a failure — but it must not stamp the review either, or the panel would
		// claim a review that never happened.
		mockReview.mockResolvedValue(null);

		const result = await call();

		expect(result.configured).toBe(false);
		expect(result.findings).toEqual([]);
		expect(mockReplace).not.toHaveBeenCalled();
	});
});

describe("the audit row", () => {
	it("records how many findings the grounding filter discarded", async () => {
		// The ratio of kept to dropped is the earliest signal that the prompt or the
		// model has drifted, and it is invisible from the finding list alone.
		mockReview.mockResolvedValue({ findings: [], dropped: 4, model: "m" });

		await call();

		expect(mockAudit.mock.calls[0][1]).toMatchObject({
			action: "project.pull_request.reviewed",
			metadata: expect.objectContaining({
				droppedUngrounded: 4,
				lens: "QA",
			}),
		});
	});

	it("carries neither the diff nor the finding bodies", async () => {
		mockReview.mockResolvedValue({
			findings: [
				{
					severity: "HIGH",
					title: "secret-looking title",
					detail: "diff --git a/a.ts b/a.ts",
					filePath: null,
					storyId: null,
					criterionRef: null,
				},
			],
			dropped: 0,
			model: "m",
		});
		mockReplace.mockResolvedValue([{ id: "f-1" }]);

		await call();

		const audit = JSON.stringify(mockAudit.mock.calls[0][1]);
		expect(audit).not.toContain("diff --git");
		expect(audit).not.toContain("secret-looking title");
	});
});

describe("the feature context handed to the lens", () => {
	it("is capped at the same limit the lens documents", async () => {
		// Lens finding #2's other half: the caller caps the list, which is WHY the
		// query's least-covered-first ordering matters — the cap decides which
		// features the model ever sees.
		await call();

		expect(mockFeatures).toHaveBeenCalledWith({
			projectId: "proj-1",
			limit: 40,
		});
	});
});

describe("QA depth reaches the lens (the pull-request review work scope)", () => {
	it.each(["EASY", "AVERAGE", "HARD"])(
		"passes the project's %s depth through",
		async (depth) => {
			// "Integrates with QA depth configuration (light projects get lighter QA
			// review)" — an explicit scope line. The lens reads the SAME
			// strategyDepth the test-case drafter reads, so one setting means one
			// thing across the QA surface.
			mockSettings.mockResolvedValue({
				prReviewQaLensEnabled: true,
				prReviewArchitectureLensEnabled: true,
				strategyDepth: depth,
			});

			await call();

			expect(mockReview).toHaveBeenCalledWith(
				expect.objectContaining({ strategyDepth: depth }),
			);
		},
	);
});
