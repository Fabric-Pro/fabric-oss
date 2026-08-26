/**
 * Both review lenses refuse BEFORE doing any work when their project toggle is
 * off (the per-lens switches).
 *
 * "Before" is the whole assertion. A lens that checked its toggle after loading
 * the review, resolving the graph, or calling a model would have already spent
 * the API call or the credit that turning it off was meant to prevent — and the
 * refusal would look identical from the outside.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.fn();
const mockGetReview = vi.fn();
const mockGraph = vi.fn();
const mockReplace = vi.fn();
const mockReview = vi.fn();
const mockAudit = vi.fn();

vi.mock("@repo/database", () => ({
	getProjectQaSettings: (...a: unknown[]) => mockSettings(...a),
	getPullRequestReview: (...a: unknown[]) => mockGetReview(...a),
	getProjectImportGraph: (...a: unknown[]) => mockGraph(...a),
	replaceLensFindings: (...a: unknown[]) => mockReplace(...a),
	listFeaturesForPrReview: vi.fn(),
	setPullRequestReviewFindingStatus: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	reviewPullRequestForQa: (...a: unknown[]) => mockReview(...a),
	diffFilePaths: () => new Set<string>(),
	PR_REVIEW_MAX_FEATURES: 40,
}));

vi.mock("@repo/utils/import-cycles", () => ({ findImportCycles: () => [] }));

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
const { analysePullRequestArchitectureProcedure } = await import(
	"../analyse-architecture"
);

const context = { user: { id: "user-1" }, session: {} };

type Handler = {
	handler: (a: { input: unknown; context: unknown }) => Promise<unknown>;
};

function call(procedure: unknown) {
	return (procedure as Handler).handler({
		input: { projectId: "proj-1", id: "rev-1" },
		context,
	});
}

const BOTH_ON = {
	prReviewQaLensEnabled: true,
	prReviewArchitectureLensEnabled: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockSettings.mockResolvedValue(BOTH_ON);
	mockGetReview.mockResolvedValue({
		id: "rev-1",
		diff: "diff --git a/a.ts b/a.ts",
		diffTruncated: false,
		repoOwner: "acme",
		repoName: "store",
		prNumber: 42,
		headSha: "a".repeat(40),
		failureText: null,
	});
	mockGraph.mockResolvedValue({ analysisId: "an-1", edges: [] });
	mockReplace.mockResolvedValue([]);
	mockReview.mockResolvedValue({ findings: [], dropped: 0, model: "m" });
});

describe("QA lens toggle", () => {
	it("refuses without reading the review or calling the model", async () => {
		mockSettings.mockResolvedValue({
			...BOTH_ON,
			prReviewQaLensEnabled: false,
		});

		await expect(call(analysePullRequestQaProcedure)).rejects.toThrow(
			/QA review lens is turned off/i,
		);
		// The point of the toggle: nothing was spent discovering it was off.
		expect(mockGetReview).not.toHaveBeenCalled();
		expect(mockReview).not.toHaveBeenCalled();
		expect(mockReplace).not.toHaveBeenCalled();
	});

	it("runs when the toggle is on", async () => {
		await call(analysePullRequestQaProcedure);

		expect(mockReview).toHaveBeenCalled();
	});

	it("is not gated by the ARCHITECTURE toggle", async () => {
		// Two independent switches, not one shared "reviews" flag.
		mockSettings.mockResolvedValue({
			...BOTH_ON,
			prReviewArchitectureLensEnabled: false,
		});

		await call(analysePullRequestQaProcedure);

		expect(mockReview).toHaveBeenCalled();
	});
});

describe("architecture lens toggle", () => {
	it("refuses without reading the review or the import graph", async () => {
		mockSettings.mockResolvedValue({
			...BOTH_ON,
			prReviewArchitectureLensEnabled: false,
		});

		await expect(
			call(analysePullRequestArchitectureProcedure),
		).rejects.toThrow(/architecture review lens is turned off/i);
		expect(mockGetReview).not.toHaveBeenCalled();
		expect(mockGraph).not.toHaveBeenCalled();
		expect(mockReplace).not.toHaveBeenCalled();
	});

	it("runs when the toggle is on", async () => {
		await call(analysePullRequestArchitectureProcedure);

		expect(mockGraph).toHaveBeenCalled();
	});

	it("is not gated by the QA toggle", async () => {
		mockSettings.mockResolvedValue({
			...BOTH_ON,
			prReviewQaLensEnabled: false,
		});

		await call(analysePullRequestArchitectureProcedure);

		expect(mockGraph).toHaveBeenCalled();
	});

	it("reports 'not indexed' rather than writing an empty clean result", async () => {
		// "We never mapped your imports" and "your imports are fine" must not
		// collapse into the same stored state.
		mockGraph.mockResolvedValue({ analysisId: null, edges: [] });

		const result = (await call(
			analysePullRequestArchitectureProcedure,
		)) as {
			indexed: boolean;
		};

		expect(result.indexed).toBe(false);
		expect(mockReplace).not.toHaveBeenCalled();
	});
});
