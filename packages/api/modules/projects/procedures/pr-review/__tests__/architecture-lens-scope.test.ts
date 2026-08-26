/**
 * The architecture lens reports only what the REVIEWED repository states.
 *
 * This is a regression guard with a specific history. The lens used to check two
 * layer rules alongside the cycles, and it judged them with declarations read
 * from the filesystem of the server running Fabric — not from the project being
 * reviewed. A package directory this repository happens not to have read as
 * "declares nothing" rather than as "cannot check", so every cross-package import
 * inside it was reported as an undeclared dependency. Any reviewed repository
 * laid out as a monorepo got a review composed almost entirely of that mistake.
 *
 * Nothing here mocks `layer-rules` or `workspace-dependencies`, and that is the
 * whole point: the pre-existing toggle test mocks both, so it would have passed
 * against the broken lens. This file exercises the real modules against a graph
 * whose package directories are deliberately absent from this repository, which
 * is exactly the shape that used to produce false findings.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.fn();
const mockGetReview = vi.fn();
const mockGraph = vi.fn();
const mockReplace = vi.fn();

vi.mock("@repo/database", () => ({
	getProjectQaSettings: (...a: unknown[]) => mockSettings(...a),
	getPullRequestReview: (...a: unknown[]) => mockGetReview(...a),
	getProjectImportGraph: (...a: unknown[]) => mockGraph(...a),
	replaceLensFindings: (...a: unknown[]) => mockReplace(...a),
	listFeaturesForPrReview: vi.fn(),
	setPullRequestReviewFindingStatus: vi.fn(),
}));

/**
 * Every path in the fixture graph counts as touched by the diff. The old layer
 * rules only reported an edge the change was implicated in, so a diff that
 * touched nothing would have hidden the bug rather than exposed it.
 */
vi.mock("@repo/ai", () => ({
	reviewPullRequestForQa: vi.fn(),
	diffFilePaths: () =>
		new Set([
			"packages/ledger-core/src/index.ts",
			"packages/billing-adapters/src/stripe.ts",
			"apps/merchant-portal/src/page.ts",
		]),
	PR_REVIEW_MAX_FEATURES: 40,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
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

const { analysePullRequestArchitectureProcedure } = await import(
	"../analyse-architecture"
);

type Handler = {
	handler: (a: { input: unknown; context: unknown }) => Promise<unknown>;
};

function run() {
	return (
		analysePullRequestArchitectureProcedure as unknown as Handler
	).handler({
		input: { projectId: "proj-1", id: "rev-1" },
		context: { user: { id: "user-1" }, session: {} },
	});
}

/**
 * Package directories chosen so this repository cannot possibly declare them.
 * Acyclic on purpose — a cycle is a legitimate finding, and one here would make
 * a zero-findings assertion pass for the wrong reason.
 *
 * `packages/… → apps/…` is included because it is precisely what the withdrawn
 * direction rule rated HIGH, on nothing but this repository's own convention
 * about what those directories mean.
 */
const FOREIGN_EDGES = [
	{
		from: "packages/ledger-core/src/index.ts",
		to: "packages/billing-adapters/src/stripe.ts",
	},
	{
		from: "packages/billing-adapters/src/stripe.ts",
		to: "apps/merchant-portal/src/page.ts",
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	mockSettings.mockResolvedValue({
		prReviewQaLensEnabled: true,
		prReviewArchitectureLensEnabled: true,
	});
	mockGetReview.mockResolvedValue({
		id: "rev-1",
		diff: "diff --git a/packages/ledger-core/src/index.ts b/packages/ledger-core/src/index.ts",
		diffTruncated: false,
		repoOwner: "example-org",
		repoName: "example-repo",
		prNumber: 7,
		headSha: "b".repeat(40),
		failureText: null,
	});
	mockGraph.mockResolvedValue({ analysisId: "an-1", edges: FOREIGN_EDGES });
	mockReplace.mockResolvedValue([]);
});

describe("architecture lens scope", () => {
	it("reports nothing for a reviewed repository whose packages this one does not declare", async () => {
		await run();

		expect(mockReplace).toHaveBeenCalledTimes(1);
		const { findings } = mockReplace.mock.calls[0][0] as {
			findings: Array<{ title: string }>;
		};

		// Before the fix this stored two findings: an undeclared dependency for
		// each cross-package edge, plus a HIGH "library imports an application".
		expect(findings).toEqual([]);
	});

	it("never emits a layer-rule finding", async () => {
		await run();

		const { findings } = mockReplace.mock.calls[0][0] as {
			findings: Array<{ title: string }>;
		};
		const titles = findings.map((f) => f.title).join("\n");

		expect(titles).not.toMatch(/undeclared dependency/i);
		expect(titles).not.toMatch(/library imports an application/i);
	});

	it("does not claim a layer-rule verdict in its result", async () => {
		// The response used to carry `layerViolations` and `layerRulesChecked`.
		// A reader treating either as "your layers are fine" would have been
		// reading this server's workspace, not theirs.
		const result = (await run()) as Record<string, unknown>;

		expect(result).not.toHaveProperty("layerViolations");
		expect(result).not.toHaveProperty("layerRulesChecked");
	});
});

describe("the audit record after the lens moved to lib/", () => {
	// A refactor replaced the handler's locals with `{ length: 0 }` shims so the
	// audit block would still compile. It compiled and it lied: every run recorded
	// `architectureRules: 0` and `atlasAnalysisId: null` regardless of what the
	// project declared or which analysis produced the graph. The numbers exist to
	// make a ratio readable afterwards, and a constant is worse than an absence.
	it("carries the declared-rule count and the analysis id off the lens result", () => {
		const source = readFileSync(
			join(__dirname, "..", "analyse-architecture.ts"),
			"utf8",
		);

		expect(source).toContain("architectureRules: result.rulesDeclared");
		expect(source).toContain("atlasAnalysisId: result.analysisId");
		// The shims themselves must not come back.
		expect(source).not.toContain("const rules = { length: 0 }");
		expect(source).not.toContain("analysisId: null as string | null");
	});
});
