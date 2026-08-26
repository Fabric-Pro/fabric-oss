/**
 * The test-case update path at the procedure layer.
 *
 * The queries below it already pin the accept/reject asymmetry. What these
 * cover is what only this layer decides:
 *
 *  - accepting must stamp the hash of the feature as it stands NOW. Pass the
 *    wrong one and the case never clears — it reappears as drifted forever,
 *    and the signal people were supposed to trust becomes noise;
 *  - an empty revision must be reported, never stored. A proposal a person can
 *    "accept" into zero steps deletes coverage on a single click;
 *  - a feature with no acceptance criteria must not reach the model at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	userStory: { findFirst: vi.fn() },
	testCase: { findFirst: vi.fn() },
	projectRepositoryIntegration: { findFirst: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	acceptTestCaseStepProposal: vi.fn(),
	findImplementationPullRequest: vi.fn(),
	fingerprintSpecText: vi.fn(),
	listDriftedTestCases: vi.fn(),
	proposeTestCaseSteps: vi.fn(),
	rejectTestCaseStepProposal: vi.fn(),
}));
vi.mock("@repo/database/prisma/client", () => ({ db: dbMock }));
vi.mock("@repo/ai", () => ({
	reviseTestCaseSteps: vi.fn(),
	reviseTestCaseStepsFromImplementation: vi.fn(),
}));
vi.mock("@repo/integrations", () => ({ resolveFreshRepoToken: vi.fn() }));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
vi.mock("../../../lib/test-cases-feature", () => ({
	assertTestCasesFeatureEnabled: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const make = () => {
		const chain: Record<string, unknown> = {};
		for (const m of ["use", "route", "input", "output"]) {
			chain[m] = () => chain;
		}
		chain.handler = (fn: unknown) => ({
			handler: fn,
			__permission: chain.__permission,
		});
		return chain;
	};
	// One chain per procedure, so the permission recorded by the last one
	// defined does not overwrite the others'.
	const chains: Record<string, unknown>[] = [];
	return {
		get tenantProtectedProcedure() {
			const chain = make();
			chains.push(chain);
			return chain;
		},
		requireProjectPermission: (p: string) => {
			const chain = chains[chains.length - 1];
			chain.__permission = p;
			return () => chain;
		},
		resolveOrganizationId: (orgId: unknown) => orgId ?? undefined,
		Permissions: {
			TEST_CASE_READ: "test-case:read",
			TEST_CASE_UPDATE: "test-case:update",
		},
	};
});

import {
	reviseTestCaseSteps,
	reviseTestCaseStepsFromImplementation,
} from "@repo/ai";
import {
	acceptTestCaseStepProposal,
	findImplementationPullRequest,
	fingerprintSpecText,
	listDriftedTestCases,
	proposeTestCaseSteps,
} from "@repo/database";
import { resolveFreshRepoToken } from "@repo/integrations";
import {
	acceptTestCaseStepsProcedure,
	listDriftedTestCasesProcedure,
	proposeTestCaseStepsFromImplementationProcedure,
	proposeTestCaseStepsProcedure,
} from "../test-case-drift";

// biome-ignore lint/complexity/noBannedTypes: matches the harness the sibling procedure tests use.
const handlerOf = (p: unknown) => (p as { handler: Function }).handler;
const ctx = { user: { id: "u1" }, session: {} };
const STORY = {
	id: "s1",
	title: "Checkout",
	description: "cart",
	acceptanceCriteria: "AC1: totals never go negative",
	// Read off the project, never from the caller's input — see the procedure.
	project: { organizationId: "org-owning-the-project" },
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.userStory.findFirst.mockResolvedValue(STORY);
	vi.mocked(fingerprintSpecText).mockReturnValue("hash-now");
	vi.mocked(listDriftedTestCases).mockResolvedValue([]);
});

describe("permissions", () => {
	it("gates reading on TEST_CASE_READ and writing on TEST_CASE_UPDATE", () => {
		expect(
			(listDriftedTestCasesProcedure as unknown as Record<string, string>)
				.__permission,
		).toBe("test-case:read");
		expect(
			(acceptTestCaseStepsProcedure as unknown as Record<string, string>)
				.__permission,
		).toBe("test-case:update");
	});
});

describe("listDriftedTestCasesProcedure", () => {
	it("compares against the feature text as it stands now", async () => {
		await handlerOf(listDriftedTestCasesProcedure)({
			input: { projectId: "p1", storyId: "s1", organizationId: null },
			context: ctx,
		});

		expect(fingerprintSpecText).toHaveBeenCalledWith(STORY);
		expect(listDriftedTestCases).toHaveBeenCalledWith({
			projectId: "p1",
			storyId: "s1",
			currentSpecHash: "hash-now",
		});
	});

	it("reports a feature from another project as not found", async () => {
		dbMock.userStory.findFirst.mockResolvedValue(null);

		await expect(
			handlerOf(listDriftedTestCasesProcedure)({
				input: {
					projectId: "p1",
					storyId: "elsewhere",
					organizationId: null,
				},
				context: ctx,
			}),
		).rejects.toThrow(/not found/i);
	});
});

describe("acceptTestCaseStepsProcedure", () => {
	it("stamps the CURRENT feature hash, so an accepted case stops being drifted", async () => {
		// Stamping anything else leaves the case listed as drifted forever, and
		// the drift list stops meaning anything.
		vi.mocked(acceptTestCaseStepProposal).mockResolvedValue({
			applied: true,
		});

		await handlerOf(acceptTestCaseStepsProcedure)({
			input: {
				projectId: "p1",
				testCaseId: "tc1",
				storyId: "s1",
				organizationId: null,
			},
			context: ctx,
		});

		expect(acceptTestCaseStepProposal).toHaveBeenCalledWith({
			projectId: "p1",
			testCaseId: "tc1",
			actorUserId: "u1",
			currentSpecHash: "hash-now",
		});
	});
});

describe("proposeTestCaseStepsProcedure", () => {
	const input = {
		projectId: "p1",
		testCaseId: "tc1",
		storyId: "s1",
		organizationId: null,
	};

	beforeEach(() => {
		dbMock.testCase.findFirst.mockResolvedValue({
			title: "Discount applies",
			steps: [{ action: "Click pay", expected: "Receipt" }],
			workItemLinks: [{ acceptanceCriterionRefs: ["AC 1", "AC 3"] }],
		});
	});

	it("refuses before spending a generation when the feature has no criteria", async () => {
		dbMock.userStory.findFirst.mockResolvedValue({
			...STORY,
			acceptanceCriteria: "   ",
		});

		await expect(
			handlerOf(proposeTestCaseStepsProcedure)({ input, context: ctx }),
		).rejects.toThrow(/no acceptance criteria/i);
		expect(reviseTestCaseSteps).not.toHaveBeenCalled();
	});

	it("reports an empty revision instead of storing it", async () => {
		// A stored empty proposal is one click away from blanking the case's
		// steps. Deleting coverage is a decision, not an accept.
		vi.mocked(reviseTestCaseSteps).mockResolvedValue({
			steps: [],
			rationale: "The feature dropped discounts.",
		});

		const result = await handlerOf(proposeTestCaseStepsProcedure)({
			input,
			context: ctx,
		});

		expect(result).toEqual({
			proposed: false,
			reason: "NOTHING_TO_VERIFY",
			rationale: "The feature dropped discounts.",
		});
		expect(proposeTestCaseSteps).not.toHaveBeenCalled();
	});

	it("stores a real revision and returns it for review", async () => {
		vi.mocked(reviseTestCaseSteps).mockResolvedValue({
			steps: [{ action: "Apply SAVE10", expected: "Total drops" }],
			rationale: "Discount now applies before tax.",
		});
		vi.mocked(proposeTestCaseSteps).mockResolvedValue(true);

		const result = await handlerOf(proposeTestCaseStepsProcedure)({
			input,
			context: ctx,
		});

		expect(proposeTestCaseSteps).toHaveBeenCalledWith({
			projectId: "p1",
			testCaseId: "tc1",
			steps: [{ action: "Apply SAVE10", expected: "Total drops" }],
			// Tagged SPEC, which is what keeps accepting one of these stamping
			// the case as current. The implementation path tags IMPLEMENTATION
			// and deliberately does not.
			source: "SPEC",
		});
		expect(result).toMatchObject({ proposed: true });
	});

	it("passes the case's existing steps to the reviser, not just the feature", async () => {
		// Without them this is a re-draft, which returns a near-duplicate beside
		// the original — the failure an update path exists to avoid.
		vi.mocked(reviseTestCaseSteps).mockResolvedValue({
			steps: [{ action: "a", expected: "b" }],
			rationale: "r",
		});
		vi.mocked(proposeTestCaseSteps).mockResolvedValue(true);

		await handlerOf(proposeTestCaseStepsProcedure)({ input, context: ctx });

		expect(vi.mocked(reviseTestCaseSteps).mock.calls[0][0]).toMatchObject({
			caseTitle: "Discount applies",
			// Every criterion the case claims, not just the first: the reviser is
			// asked to revise steps against what the case actually covers.
			acceptanceCriterionRefs: ["AC 1", "AC 3"],
			currentSteps: [{ action: "Click pay", expected: "Receipt" }],
		});
	});

	it("bills the organization that owns the project, not the one the caller names", async () => {
		// `resolveOrganizationId` hands back the caller's string as-is and
		// requireProjectPermission does not check it, so trusting the input here
		// would let a caller run generations against someone else's provider and
		// budget. The org is read off the loaded project instead.
		vi.mocked(reviseTestCaseSteps).mockResolvedValue({
			steps: [{ action: "a", expected: "b" }],
			rationale: "r",
		});
		vi.mocked(proposeTestCaseSteps).mockResolvedValue(true);

		await handlerOf(proposeTestCaseStepsProcedure)({
			input: { ...input, organizationId: "someone-elses-org" },
			context: ctx,
		});

		expect(vi.mocked(reviseTestCaseSteps).mock.calls[0][1]).toMatchObject({
			organizationId: "org-owning-the-project",
		});
	});

	it("surfaces a missing AI provider as an actionable message", async () => {
		vi.mocked(reviseTestCaseSteps).mockResolvedValue(null);

		await expect(
			handlerOf(proposeTestCaseStepsProcedure)({ input, context: ctx }),
		).rejects.toThrow(/No AI provider/i);
	});
});

/**
 * Revising a case against the code that shipped, rather than the spec.
 *
 * The behaviours worth pinning here are the ones a reader would otherwise have
 * to take on trust:
 *
 *  - the PR comes from a coding run, and a feature with none must be REFUSED
 *    rather than quietly re-reading the spec — a button that says it checks the
 *    implementation and checks something else is worse than one that fails;
 *  - the proposal is stored as IMPLEMENTATION, which is what stops accepting it
 *    from stamping the case as matching a specification nobody consulted;
 *  - the diff, not the acceptance criteria, is what reaches the model;
 *  - truncation is reported, so a revision that read part of a change cannot be
 *    read as one that saw all of it.
 */
describe("proposeTestCaseStepsFromImplementationProcedure", () => {
	const input = {
		projectId: "p1",
		testCaseId: "tc1",
		storyId: "s1",
		organizationId: null,
	};

	const PR = {
		prNumber: 42,
		repositoryOwner: "example-org",
		repositoryName: "example-repo",
		pullRequestUrl: "https://github.com/example-org/example-repo/pull/42",
	};

	/** A diff long enough to be real, short enough to read. */
	const DIFF = [
		"diff --git a/app/checkout.tsx b/app/checkout.tsx",
		"@@ -1,3 +1,3 @@",
		"-  <button>Pay now</button>",
		"+  <button>Place order</button>",
	].join("\n");

	function arrangeDiff(body: string, ok = true, status = 200) {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok,
				status,
				text: () => Promise.resolve(body),
			}),
		);
	}

	beforeEach(() => {
		vi.mocked(findImplementationPullRequest).mockResolvedValue(PR);
		dbMock.testCase.findFirst.mockResolvedValue({
			title: "Checkout pays",
			steps: [{ action: "Press Pay now", expected: "Order is placed" }],
		});
		dbMock.projectRepositoryIntegration.findFirst.mockResolvedValue({
			id: "int1",
		});
		vi.mocked(resolveFreshRepoToken).mockResolvedValue({
			token: "t",
		} as never);
		vi.mocked(reviseTestCaseStepsFromImplementation).mockResolvedValue({
			steps: [
				{ action: "Press Place order", expected: "Order is placed" },
			],
			rationale: "The button was renamed.",
		});
		vi.mocked(proposeTestCaseSteps).mockResolvedValue(true);
		arrangeDiff(DIFF);
	});

	it("refuses when no coding run recorded a pull request", async () => {
		vi.mocked(findImplementationPullRequest).mockResolvedValue(null);

		await expect(
			handlerOf(proposeTestCaseStepsFromImplementationProcedure)({
				input,
				context: ctx,
			}),
		).rejects.toThrow(/no implementation to revise against/i);

		// The refusal must come BEFORE anything is spent: no diff fetched, no
		// generation billed to discover the feature was never implemented.
		expect(fetch).not.toHaveBeenCalled();
		expect(reviseTestCaseStepsFromImplementation).not.toHaveBeenCalled();
	});

	it("stores the proposal as IMPLEMENTATION, so accepting cannot clear spec drift", async () => {
		await handlerOf(proposeTestCaseStepsFromImplementationProcedure)({
			input,
			context: ctx,
		});

		expect(proposeTestCaseSteps).toHaveBeenCalledWith(
			expect.objectContaining({ source: "IMPLEMENTATION" }),
		);
	});

	it("puts the diff in front of the model and not the acceptance criteria", async () => {
		await handlerOf(proposeTestCaseStepsFromImplementationProcedure)({
			input,
			context: ctx,
		});

		const [modelInput] = vi.mocked(reviseTestCaseStepsFromImplementation)
			.mock.calls[0];
		expect(modelInput.diff).toContain("Place order");
		// The spec is deliberately absent: this path answers "what does the code
		// do", and re-admitting the criteria re-opens the question it settles.
		expect(JSON.stringify(modelInput)).not.toContain(
			"totals never go negative",
		);
	});

	it("bills the organization that owns the project, not the caller's input", async () => {
		await handlerOf(proposeTestCaseStepsFromImplementationProcedure)({
			input: { ...input, organizationId: "someone-elses-org" },
			context: ctx,
		});

		expect(
			vi.mocked(reviseTestCaseStepsFromImplementation).mock.calls[0][1],
		).toMatchObject({ organizationId: "org-owning-the-project" });
	});

	it("reports a truncated diff instead of absorbing it", async () => {
		arrangeDiff("x".repeat(200_001));

		const result = await handlerOf(
			proposeTestCaseStepsFromImplementationProcedure,
		)({ input, context: ctx });

		expect(result.diffTruncated).toBe(true);
	});

	it("reports an empty revision rather than storing steps that delete coverage", async () => {
		vi.mocked(reviseTestCaseStepsFromImplementation).mockResolvedValue({
			steps: [],
			rationale: "The diff removes this flow entirely.",
		});

		const result = await handlerOf(
			proposeTestCaseStepsFromImplementationProcedure,
		)({ input, context: ctx });

		expect(result.proposed).toBe(false);
		expect(proposeTestCaseSteps).not.toHaveBeenCalled();
	});

	it("refuses an empty diff without billing a generation", async () => {
		arrangeDiff("   ");

		await expect(
			handlerOf(proposeTestCaseStepsFromImplementationProcedure)({
				input,
				context: ctx,
			}),
		).rejects.toThrow(/empty diff/i);
		expect(reviseTestCaseStepsFromImplementation).not.toHaveBeenCalled();
	});

	it("refuses when the PR's repository is not connected to this project", async () => {
		dbMock.projectRepositoryIntegration.findFirst.mockResolvedValue(null);

		await expect(
			handlerOf(proposeTestCaseStepsFromImplementationProcedure)({
				input,
				context: ctx,
			}),
		).rejects.toThrow(/not connected to this project/i);
	});

	it("does not echo GitHub's response body into the error", async () => {
		// GitHub's error envelope can carry the credential back; the message is
		// composed from the status alone.
		arrangeDiff(
			'{"message":"Bad credentials","token":"ghs_secret"}',
			false,
			401,
		);

		await expect(
			handlerOf(proposeTestCaseStepsFromImplementationProcedure)({
				input,
				context: ctx,
			}),
		).rejects.toThrow(/HTTP 401/);
		await expect(
			handlerOf(proposeTestCaseStepsFromImplementationProcedure)({
				input,
				context: ctx,
			}),
		).rejects.not.toThrow(/ghs_secret/);
	});
});
