/**
 * `projects.pipelineResults.analyseFinding` — propose a cause for a CI failure.
 *
 * The contract worth locking is mostly about what this must NOT do. The product
 * ruling (2026-07-26) is that an agentic failure never auto-files: the analysis
 * enriches a finding and a human promotes it. So these tests pin:
 *
 *   - the write touches ONLY the four advisory columns — never `status`, never
 *     `promotedStoryId`, and it opens no story;
 *   - every non-answer is RETURNED as a reason the UI can render, not thrown;
 *   - a model failure is logged without the failure text (customer code);
 *   - the org whose prompt override applies comes from the FINDING, never from
 *     the caller;
 *   - an empty conclusion is not stored, so the UI cannot show a confident badge
 *     with nothing behind it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetFinding = vi.fn();
const mockSetAnalysis = vi.fn();
const mockAnalyse = vi.fn();
/**
 * Defaults to "no diff", which is what a project with no connected repo, an
 * expired token or an unresolvable commit range produces — and therefore what
 * most of these tests should see.
 */
const mockResolveDiff = vi.fn(async () => null as unknown);
const mockLogError = vi.fn();
const capturedPermissions: unknown[] = [];

vi.mock("@repo/database", () => ({
	getFindingForAnalysis: (...a: unknown[]) => mockGetFinding(...a),
	setFindingAnalysis: (...a: unknown[]) => mockSetAnalysis(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: (...a: unknown[]) => mockLogError(...a),
	},
}));

vi.mock("../../../lib/analyse-test-failure", () => ({
	analyseTestFailure: (...a: unknown[]) => mockAnalyse(...a),
}));

// Mocked at its own seam: the real resolver reaches the repo integrations and
// their token refresh, which would drag that whole graph into what is a
// procedure test. Its own behaviour — including that a failed compare must cost
// the diff and never the analysis — is covered where it lives.
vi.mock("../../../lib/resolve-failure-diff", () => ({
	resolveFailureDiff: (...a: unknown[]) => mockResolveDiff(...a),
}));
vi.mock("../../../lib/pipeline-results-feature", () => ({
	assertPipelineResultsEnabled: () => undefined,
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

const { analyseQaFindingProcedure } = await import("../analyse-finding");

const context = { user: { id: "user-1" } };

const FINDING = {
	id: "f1",
	testName: "resets the password",
	classname: "auth/password.spec.ts",
	failureMessage: "AssertionError: expected 200 to equal 401",
	occurrences: 4,
	firstSeenAt: new Date("2026-07-01T00:00:00.000Z"),
	lastSeenAt: new Date("2026-07-05T00:00:00.000Z"),
	caseTitle: "A user resets their password",
	organizationId: "org-from-finding",
};

function callAnalyse(input: Record<string, unknown> = {}) {
	return (
		analyseQaFindingProcedure as unknown as {
			handler: (a: {
				input: unknown;
				context: unknown;
			}) => Promise<Record<string, unknown>>;
		}
	).handler({
		input: { projectId: "p1", findingId: "f1", ...input },
		context,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetFinding.mockResolvedValue(FINDING);
	mockSetAnalysis.mockResolvedValue({ updated: true });
	mockAnalyse.mockResolvedValue({
		suspectedCause: "The reset endpoint returns 200 for an expired token.",
		kind: "PRODUCT_BUG",
		model: "Claude Opus",
	});
});

describe("analyseQaFindingProcedure", () => {
	it("is write-gated, because it spends tokens and writes to the finding", () => {
		expect(capturedPermissions).toContain("TEST_CASE_UPDATE");
	});

	it("stores the analysis and hands it straight back to the caller", async () => {
		const result = await callAnalyse();

		expect(result).toMatchObject({
			analysed: true,
			suspectedKind: "PRODUCT_BUG",
			analysisModel: "Claude Opus",
		});
		expect(mockSetAnalysis).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				findingId: "f1",
				suspectedKind: "PRODUCT_BUG",
			}),
		);
	});

	it("writes ONLY the advisory columns — it files nothing", async () => {
		// The load-bearing test for the product ruling. If this feature ever
		// starts setting `status` or `promotedStoryId`, an agentic guess has begun
		// filing work items unattended, which is precisely what was ruled out.
		await callAnalyse();

		const written = mockSetAnalysis.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(Object.keys(written).sort()).toEqual([
			"analysisDiff",
			"analysisModel",
			"findingId",
			"projectId",
			"suspectedCause",
			"suspectedKind",
		]);
		expect(written).not.toHaveProperty("status");
		expect(written).not.toHaveProperty("promotedStoryId");
	});

	it("stores the diff it reasoned over, so the evidence outlives the prompt", async () => {
		// The first cut shipped the correlation into the PROMPT and then threw it away, so
		// a reader got a confident cause and no way to check which files it was
		// reached from.
		const diff = {
			commitRange: { baseSha: "aaa1111", headSha: "bbb2222" },
			changedFiles: [
				{ path: "src/auth/reset-token.ts", reason: "shares 'reset'" },
			],
			truncated: false,
		};
		mockResolveDiff.mockResolvedValueOnce(diff);

		const result = await callAnalyse();

		expect(mockSetAnalysis).toHaveBeenCalledWith(
			expect.objectContaining({ analysisDiff: diff }),
		);
		expect(result).toMatchObject({ analysisDiff: diff });
	});

	it("writes an explicit null when there was no diff, clearing a previous one", async () => {
		// The subtle half. `resolveFailureDiff` returns null for a disconnected
		// repo, an expired token or an unresolvable range. If that null were
		// merely omitted, the file list from an EARLIER analysis would survive
		// underneath a freshly written cause and read as its reasoning — a
		// hypothesis claiming diff correlation it never had.
		await callAnalyse();

		const written = mockSetAnalysis.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(written).toHaveProperty("analysisDiff");
		expect(written.analysisDiff).toBeNull();
	});

	it("resolves the prompt override from the FINDING's org, not the caller", async () => {
		await callAnalyse();

		expect(mockAnalyse).toHaveBeenCalledWith(
			expect.objectContaining({
				tenant: {
					userId: "user-1",
					organizationId: "org-from-finding",
				},
			}),
		);
	});

	it("returns a reason instead of throwing when the finding is gone", async () => {
		// Deleted, or belonging to another project — NOT "resolved by a sync",
		// which the lookup does not filter on and therefore cannot produce here.
		mockGetFinding.mockResolvedValue(null);

		await expect(callAnalyse()).resolves.toEqual({
			analysed: false,
			reason: "NOT_FOUND",
		});
		expect(mockAnalyse).not.toHaveBeenCalled();
	});

	it("returns a reason when the model errors, and logs no customer code", async () => {
		mockAnalyse.mockRejectedValue(
			new Error("rate limited: 429 from provider"),
		);

		await expect(callAnalyse()).resolves.toEqual({
			analysed: false,
			reason: "MODEL_ERROR",
		});
		expect(mockSetAnalysis).not.toHaveBeenCalled();

		// The failure message is the customer's own test output. It goes to the
		// model and to their screen; it must not go to our logs.
		const logged = JSON.stringify(mockLogError.mock.calls);
		expect(logged).not.toContain(FINDING.failureMessage);
		expect(logged).toContain("f1");
	});

	it("refuses rather than silently using an unseeded prompt", async () => {
		// An analysis produced by a prompt no admin can see or edit is exactly
		// what the editable-prompt rule exists to prevent, so "not seeded" is a
		// refusal the user can act on — not a fallback.
		mockAnalyse.mockResolvedValue(null);

		await expect(callAnalyse()).resolves.toEqual({
			analysed: false,
			reason: "PROMPT_UNAVAILABLE",
		});
		expect(mockSetAnalysis).not.toHaveBeenCalled();
	});

	it("does not store an empty conclusion", async () => {
		// A blank cause beside an UNKNOWN badge reads as "we analysed this and
		// learned nothing", which is indistinguishable from this feature being
		// broken. Better to say the run produced nothing.
		mockAnalyse.mockResolvedValue({
			suspectedCause: "",
			kind: "UNKNOWN",
			model: "Claude Opus",
		});

		await expect(callAnalyse()).resolves.toEqual({
			analysed: false,
			reason: "NO_CONCLUSION",
		});
		expect(mockSetAnalysis).not.toHaveBeenCalled();
	});

	it("reports NOT_FOUND when the write matches nothing", async () => {
		// The same race, caught on the write side rather than the read side.
		mockSetAnalysis.mockResolvedValue({ updated: false });

		await expect(callAnalyse()).resolves.toEqual({
			analysed: false,
			reason: "NOT_FOUND",
		});
	});
});
