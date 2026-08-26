/**
 * Keeping a test case honest as its feature changes.
 *
 * Two behaviours carry the weight:
 *
 *  - the staleness signal must not cry wolf, or people learn to dismiss it —
 *    which is exactly the failure it exists to prevent;
 *  - accepting a proposal marks the case current, rejecting one does NOT.
 *    Rejecting says "this suggestion was wrong", not "this case is up to date".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	testCase: {
		findMany: vi.fn(),
		findFirst: vi.fn(),
		updateMany: vi.fn(),
	},
}));
const updateTestCase = vi.hoisted(() => vi.fn());

vi.mock("../../../client", () => ({
	db: dbMock,
	// Mirrors the real sentinel closely enough to assert on: what matters is
	// that the code writes DbNull and never a bare `null` or JsonNull.
	Prisma: { DbNull: "DbNull" },
}));
vi.mock("../test-cases", () => ({
	updateTestCase: (i: unknown) => updateTestCase(i),
}));

import {
	acceptTestCaseStepProposal,
	fingerprintSpecText,
	listDriftedTestCases,
	rejectTestCaseStepProposal,
} from "../test-case-drift";

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.testCase.updateMany.mockResolvedValue({ count: 1 });
	updateTestCase.mockResolvedValue({ id: "tc1" });
});

describe("fingerprintSpecText", () => {
	const base = {
		title: "Checkout",
		description: "A cart flow",
		acceptanceCriteria: "AC1: totals never go negative",
	};

	it("is stable across whitespace and case, so a reflow is not a rewrite", () => {
		// A signal that fires on re-indentation is one people learn to ignore.
		expect(
			fingerprintSpecText({
				...base,
				description: "  A   cart\n\nflow  ",
				title: "CHECKOUT",
			}),
		).toBe(fingerprintSpecText(base));
	});

	it("changes when the acceptance criteria actually change", () => {
		expect(
			fingerprintSpecText({
				...base,
				acceptanceCriteria: "AC1: totals may go negative",
			}),
		).not.toBe(fingerprintSpecText(base));
	});

	it("treats absent description and criteria as empty, not as a difference", () => {
		expect(fingerprintSpecText({ title: "X" })).toBe(
			fingerprintSpecText({
				title: "X",
				description: null,
				acceptanceCriteria: null,
			}),
		);
	});
});

describe("listDriftedTestCases", () => {
	it("never reports a hand-authored case as DRIFTED, whatever else lists it", async () => {
		// The drift branch still requires a recorded fingerprint that no longer
		// matches. It moved inside an OR when the list widened to include cases
		// carrying a proposal, so the assertion follows it there rather than
		// being dropped: without this, a regression that flagged every
		// hand-authored case as out of date would pass unnoticed.
		dbMock.testCase.findMany.mockResolvedValue([]);

		await listDriftedTestCases({
			projectId: "p1",
			storyId: "s1",
			currentSpecHash: "hash-now",
		});

		const where = dbMock.testCase.findMany.mock.calls[0][0].where;
		const driftBranch = where.OR.find(
			(b: Record<string, unknown>) => b.draftedFromSpecHash,
		);
		expect(driftBranch.draftedFromSpecHash).toEqual({ not: null });
		// And excludes anything already matching the current text.
		expect(driftBranch.NOT).toEqual({ draftedFromSpecHash: "hash-now" });
	});

	it("leaves retired cases alone", async () => {
		dbMock.testCase.findMany.mockResolvedValue([]);

		await listDriftedTestCases({
			projectId: "p1",
			storyId: "s1",
			currentSpecHash: "h",
		});

		expect(dbMock.testCase.findMany.mock.calls[0][0].where.state).toEqual({
			notIn: ["CLOSED"],
		});
	});

	it("reports whether each drifted case already has a proposal", async () => {
		dbMock.testCase.findMany.mockResolvedValue([
			{
				id: "tc1",
				identifier: "TC-001",
				title: "One",
				draftedFromSpecHash: "old",
				proposedSteps: [{ action: "a", expected: "b" }],
			},
			{
				id: "tc2",
				identifier: "TC-002",
				title: "Two",
				draftedFromSpecHash: "old",
				proposedSteps: null,
			},
		]);

		const drifted = await listDriftedTestCases({
			projectId: "p1",
			storyId: "s1",
			currentSpecHash: "new",
		});

		expect(drifted.map((d) => d.hasProposal)).toEqual([true, false]);
	});
});

describe("accept / reject asymmetry", () => {
	it("accepting applies the steps and marks the case current", async () => {
		dbMock.testCase.findFirst.mockResolvedValue({
			proposedSteps: [{ action: "Click pay", expected: "Receipt shows" }],
		});

		const result = await acceptTestCaseStepProposal({
			projectId: "p1",
			testCaseId: "tc1",
			actorUserId: "u1",
			currentSpecHash: "hash-now",
		});

		expect(result).toEqual({ applied: true });
		// Applied through the ordinary update path, so an accepted proposal gets
		// the same ordering and activity trail as a human edit.
		expect(updateTestCase.mock.calls[0][0].data.steps).toEqual([
			{ action: "Click pay", expected: "Receipt shows" },
		]);
		expect(dbMock.testCase.updateMany.mock.calls[0][0].data).toMatchObject({
			draftedFromSpecHash: "hash-now",
			proposedSteps: "DbNull",
		});
	});

	it("rejecting clears the proposal WITHOUT marking the case current", async () => {
		await rejectTestCaseStepProposal({
			projectId: "p1",
			testCaseId: "tc1",
		});

		const data = dbMock.testCase.updateMany.mock.calls[0][0].data;
		expect(data.proposedSteps).toBe("DbNull");
		// The case is still drifted — the suggestion was wrong, the drift is real.
		// Stamping it current here would hide it until the next edit.
		expect(data.draftedFromSpecHash).toBeUndefined();
	});

	it("refuses to apply an empty proposal rather than blanking the steps", async () => {
		// A stale button must not wipe a case's steps.
		dbMock.testCase.findFirst.mockResolvedValue({ proposedSteps: [] });

		expect(
			await acceptTestCaseStepProposal({
				projectId: "p1",
				testCaseId: "tc1",
				currentSpecHash: "h",
			}),
		).toEqual({ applied: false, reason: "NO_PROPOSAL" });
		expect(updateTestCase).not.toHaveBeenCalled();
	});

	it("reports a case from another project as not found", async () => {
		dbMock.testCase.findFirst.mockResolvedValue(null);

		expect(
			await acceptTestCaseStepProposal({
				projectId: "p1",
				testCaseId: "someone-elses",
				currentSpecHash: "h",
			}),
		).toEqual({ applied: false, reason: "NOT_FOUND" });
	});
});

/**
 * Which revisions may clear the spec-drift flag.
 *
 * This is the asymmetry the second revision path turns on, and it is easy to
 * lose: a case revised against a pull request was never compared to the
 * specification, so marking it as matching one states something nobody checked.
 * A case can honestly be both revised-from-implementation and still spec-drifted
 * — that is not a contradiction to be tidied away.
 */
describe("acceptTestCaseStepProposal — stamping by proposal source", () => {
	const steps = [{ action: "Press Place order", expected: "Order placed" }];

	/** The data written by the final updateMany, which is what stamps. */
	function clearingWrite() {
		return dbMock.testCase.updateMany.mock.calls.at(-1)?.[0]?.data;
	}

	it("stamps the hash for a SPEC proposal, clearing the drift", async () => {
		dbMock.testCase.findFirst.mockResolvedValue({
			proposedSteps: steps,
			proposedFrom: "SPEC",
		});

		await acceptTestCaseStepProposal({
			projectId: "p1",
			testCaseId: "tc1",
			currentSpecHash: "hash-now",
		});

		expect(clearingWrite()).toMatchObject({
			draftedFromSpecHash: "hash-now",
		});
	});

	it("does NOT stamp for an IMPLEMENTATION proposal, so real drift survives", async () => {
		dbMock.testCase.findFirst.mockResolvedValue({
			proposedSteps: steps,
			proposedFrom: "IMPLEMENTATION",
		});

		await acceptTestCaseStepProposal({
			projectId: "p1",
			testCaseId: "tc1",
			currentSpecHash: "hash-now",
		});

		const data = clearingWrite();
		// Absent entirely, not set to undefined: the column must be left alone.
		expect(data).not.toHaveProperty("draftedFromSpecHash");
		// The steps still applied and the proposal still cleared — only the
		// staleness claim is withheld.
		expect(updateTestCase).toHaveBeenCalled();
		expect(data).toMatchObject({
			proposedSteps: "DbNull",
			proposedAt: null,
		});
	});

	it("treats a proposal predating the column as SPEC, so pending ones still clear", async () => {
		// Every proposal outstanding when `proposedFrom` shipped was spec-derived.
		dbMock.testCase.findFirst.mockResolvedValue({
			proposedSteps: steps,
			proposedFrom: null,
		});

		await acceptTestCaseStepProposal({
			projectId: "p1",
			testCaseId: "tc1",
			currentSpecHash: "hash-now",
		});

		expect(clearingWrite()).toMatchObject({
			draftedFromSpecHash: "hash-now",
		});
	});
});

/**
 * Which cases the out-of-date list has to be able to show.
 *
 * A proposal is only reachable through this list. A case that can hold one but
 * never appears here is a case whose Accept and Reject do not exist — the
 * proposal gets written, billed, and stranded. Since revising against the
 * IMPLEMENTATION can be asked of any case, including a hand-authored one that
 * never had a spec fingerprint, "drifted" alone is too narrow a filter.
 */
describe("listDriftedTestCases — what the list must include", () => {
	function whereOf() {
		return dbMock.testCase.findMany.mock.calls.at(-1)?.[0]?.where;
	}

	beforeEach(() => {
		dbMock.testCase.findMany.mockResolvedValue([]);
	});

	it("asks for drifted cases OR cases carrying a proposal", async () => {
		await listDriftedTestCases({
			projectId: "p1",
			storyId: "s1",
			currentSpecHash: "hash-now",
		});

		const or = whereOf()?.OR;
		expect(or).toHaveLength(2);
		// Without the second branch a hand-authored case could be given a
		// proposal that nobody could ever accept.
		expect(JSON.stringify(or)).toContain("proposedSteps");
	});

	it("marks a hand-authored case with a proposal as NOT spec-drifted", async () => {
		// It has no fingerprint, so it cannot have drifted from the feature text
		// — offering "revise against the spec" for it would correct nothing.
		dbMock.testCase.findMany.mockResolvedValue([
			{
				id: "tc1",
				identifier: "TC-1",
				title: "Hand written",
				draftedFromSpecHash: null,
				proposedSteps: [{ action: "a", expected: "b" }],
			},
		]);

		const [row] = await listDriftedTestCases({
			projectId: "p1",
			storyId: "s1",
			currentSpecHash: "hash-now",
		});

		expect(row).toMatchObject({ hasProposal: true, isSpecDrifted: false });
	});

	it("marks a case whose fingerprint no longer matches as spec-drifted", async () => {
		dbMock.testCase.findMany.mockResolvedValue([
			{
				id: "tc2",
				identifier: "TC-2",
				title: "Drafted then rewritten",
				draftedFromSpecHash: "hash-then",
				proposedSteps: null,
			},
		]);

		const [row] = await listDriftedTestCases({
			projectId: "p1",
			storyId: "s1",
			currentSpecHash: "hash-now",
		});

		expect(row).toMatchObject({ hasProposal: false, isSpecDrifted: true });
	});

	it("does not call a case drifted when its fingerprint still matches", async () => {
		// Listed only because it carries a proposal.
		dbMock.testCase.findMany.mockResolvedValue([
			{
				id: "tc3",
				identifier: "TC-3",
				title: "Current, but proposed against",
				draftedFromSpecHash: "hash-now",
				proposedSteps: [{ action: "a", expected: "b" }],
			},
		]);

		const [row] = await listDriftedTestCases({
			projectId: "p1",
			storyId: "s1",
			currentSpecHash: "hash-now",
		});

		expect(row.isSpecDrifted).toBe(false);
	});
});
