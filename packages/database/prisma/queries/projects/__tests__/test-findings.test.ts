/**
 * Unit tests for findings. Mocks the Prisma client and
 * `createStory`, mirroring pipeline-results.test.ts.
 *
 * The point of a finding is that ONE fault recurring nightly is ONE row with a
 * rising count — so what these pin is the counting and the lifecycle, not the
 * CRUD.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, createStoryMock } = vi.hoisted(() => {
	const make = () => ({
		findFirst: vi.fn(),
		findMany: vi.fn(),
		upsert: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	});
	return {
		dbMock: {
			testFinding: make(),
			// The finding upserts are collected and sent as one batch. Prisma's
			// array form resolves every operation in it, so the stand-in must too
			// — returning undefined here would make every assertion below pass
			// while nothing was actually written.
			$transaction: vi.fn(async (ops: unknown) =>
				Array.isArray(ops) ? Promise.all(ops) : ops,
			),
		},
		createStoryMock: vi.fn(),
	};
});

// `Prisma.DbNull` is a real value, not a type: on a Json column a bare `null` is
// the JSON value `null` rather than SQL NULL. A mock without it makes the
// clearing path write `undefined`, which Prisma treats as "leave unchanged" —
// the exact bug the clearing test below exists to catch.
vi.mock("../../../client", () => ({
	db: dbMock,
	Prisma: { DbNull: "DbNull" },
}));
vi.mock("../stories", () => ({
	createStory: (...args: unknown[]) => createStoryMock(...args),
}));

import {
	dismissFinding,
	listFindings,
	mergeFindings,
	parseAnalysisDiff,
	promoteFindingToBug,
	recordFindingsForRun,
	resolveFindingsNotSeen,
	setFindingAnalysis,
} from "../test-findings";

const BASE = {
	projectId: "p1",
	organizationId: "org1",
	userId: "u1",
	pipelineRunId: "run1",
};

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.testFinding.findMany.mockResolvedValue([]);
	dbMock.testFinding.upsert.mockResolvedValue({});
	dbMock.testFinding.updateMany.mockResolvedValue({ count: 0 });
});

describe("recordFindingsForRun", () => {
	it("counts one fault once, however many cases it failed in", async () => {
		// A parameterised suite reports the same assertion across twenty cases.
		// Counting each would make `occurrences` a measure of suite SHAPE rather
		// than of how often the fault actually recurred.
		const result = await recordFindingsForRun({
			...BASE,
			failures: Array.from({ length: 20 }, (_, i) => ({
				fingerprint: "same",
				testName: `case ${i}`,
				failureMessage: "boom",
			})),
		});

		expect(dbMock.testFinding.upsert).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ created: 1, updated: 0 });
	});

	it("bumps the occurrence of a fault it has seen before", async () => {
		dbMock.testFinding.findMany.mockResolvedValue([
			{ fingerprint: "known", status: "OPEN" },
		]);

		const result = await recordFindingsForRun({
			...BASE,
			failures: [{ fingerprint: "known", testName: "t" }],
		});

		expect(result).toEqual({ created: 0, updated: 1 });
		expect(
			dbMock.testFinding.upsert.mock.calls[0][0].update.occurrences,
		).toEqual({ increment: 1 });
	});

	it("refreshes the NAME of a fault it has seen before", async () => {
		// The name was written on create and never again, so a finding whose name
		// improved kept the original forever. Agentic findings were created with a
		// raw case cuid for a name, and because their fingerprint is keyed on the
		// case id, every re-run took the update branch and preserved that cuid —
		// fixing only the writer would have left every existing one unreadable.
		dbMock.testFinding.findMany.mockResolvedValue([
			{ fingerprint: "known", status: "OPEN" },
		]);

		await recordFindingsForRun({
			...BASE,
			failures: [
				{
					fingerprint: "known",
					testName: "TC-001 Primary buttons render new green accent",
				},
			],
		});

		expect(dbMock.testFinding.upsert.mock.calls[0][0].update.testName).toBe(
			"TC-001 Primary buttons render new green accent",
		);
	});

	it("reopens a resolved fault that came back", async () => {
		// Leaving it RESOLVED is how a regression goes unnoticed.
		dbMock.testFinding.findMany.mockResolvedValue([
			{ fingerprint: "regressed", status: "RESOLVED" },
		]);

		await recordFindingsForRun({
			...BASE,
			failures: [{ fingerprint: "regressed", testName: "t" }],
		});

		expect(dbMock.testFinding.upsert.mock.calls[0][0].update.status).toBe(
			"OPEN",
		);
	});

	it("leaves a promoted fault promoted", async () => {
		// Its bug is already tracking it; flipping it back to OPEN double-reports
		// the same problem in two places.
		dbMock.testFinding.findMany.mockResolvedValue([
			{ fingerprint: "tracked", status: "PROMOTED" },
		]);

		await recordFindingsForRun({
			...BASE,
			failures: [{ fingerprint: "tracked", testName: "t" }],
		});

		expect(dbMock.testFinding.upsert.mock.calls[0][0].update.status).toBe(
			"PROMOTED",
		);
	});

	it("records a failure that matched no case", async () => {
		// The case-centric view loses these entirely today, and they are exactly
		// the coverage gap worth surfacing.
		await recordFindingsForRun({
			...BASE,
			failures: [
				{ fingerprint: "orphan", testName: "t", testCaseId: null },
			],
		});

		expect(
			dbMock.testFinding.upsert.mock.calls[0][0].create.testCaseId,
		).toBe(null);
	});

	it("writes nothing when a run had no failures", async () => {
		const result = await recordFindingsForRun({ ...BASE, failures: [] });

		expect(result).toEqual({ created: 0, updated: 0 });
		expect(dbMock.testFinding.upsert).not.toHaveBeenCalled();
	});
});

describe("resolveFindingsNotSeen", () => {
	it("closes only findings the run did not report, for the cases it touched", async () => {
		dbMock.testFinding.updateMany.mockResolvedValue({ count: 2 });

		const closed = await resolveFindingsNotSeen({
			projectId: "p1",
			seenFingerprints: ["a"],
			testCaseIds: ["c1"],
		});

		expect(closed).toBe(2);
		const where = dbMock.testFinding.updateMany.mock.calls[0][0].where;
		// Scoped: an unrelated failure elsewhere must not be resolved by accident.
		expect(where.testCaseId).toEqual({ in: ["c1"] });
		expect(where.fingerprint).toEqual({ notIn: ["a"] });
		// PROMOTED findings are left alone — their bug owns the lifecycle.
		expect(where.status).toBe("OPEN");
	});

	it("does nothing when the run touched no cases", async () => {
		const closed = await resolveFindingsNotSeen({
			projectId: "p1",
			seenFingerprints: [],
			testCaseIds: [],
		});

		expect(closed).toBe(0);
		expect(dbMock.testFinding.updateMany).not.toHaveBeenCalled();
	});
});

describe("promoteFindingToBug", () => {
	const finding = {
		id: "f1",
		fingerprint: "abc123",
		testName: "resets the password",
		classname: "auth.spec.ts",
		failureMessage: "AssertionError: nope",
		occurrences: 4,
		firstSeenAt: new Date("2026-07-01T00:00:00Z"),
		testCaseId: "c1",
		promotedStoryId: null,
	};

	it("opens a bug carrying the recurrence and the failure", async () => {
		dbMock.testFinding.findFirst.mockResolvedValue(finding);
		createStoryMock.mockResolvedValue({ id: "bug1" });
		dbMock.testFinding.update.mockResolvedValue({});

		const result = await promoteFindingToBug({
			projectId: "p1",
			findingId: "f1",
			createdById: "u1",
		});

		expect(result).toEqual({ storyId: "bug1", alreadyPromoted: false });
		const body = createStoryMock.mock.calls[0][0].description as string;
		// How often it has happened is the reason someone promoted it.
		expect(body).toContain("4 time(s)");
		expect(body).toContain("AssertionError: nope");
		expect(body).toContain("abc123");
		// And the finding is marked so ingestion stops reopening it.
		expect(dbMock.testFinding.update.mock.calls[0][0].data).toMatchObject({
			status: "PROMOTED",
			promotedStoryId: "bug1",
		});
	});

	it("is idempotent — a second promote returns the first bug", async () => {
		dbMock.testFinding.findFirst.mockResolvedValue({
			...finding,
			promotedStoryId: "bug1",
		});

		const result = await promoteFindingToBug({
			projectId: "p1",
			findingId: "f1",
			createdById: "u1",
		});

		expect(result).toEqual({ storyId: "bug1", alreadyPromoted: true });
		expect(createStoryMock).not.toHaveBeenCalled();
	});

	it("refuses a finding belonging to another project", async () => {
		// projectId is in the WHERE, so a foreign id matches nothing rather than
		// being promoted into this project's backlog.
		dbMock.testFinding.findFirst.mockResolvedValue(null);

		await expect(
			promoteFindingToBug({
				projectId: "p1",
				findingId: "someone-elses",
				createdById: "u1",
			}),
		).rejects.toThrow(/not found in this project/i);
		expect(createStoryMock).not.toHaveBeenCalled();
	});
});

describe("listFindings — feature scope", () => {
	beforeEach(() => {
		dbMock.testFinding.findMany.mockResolvedValue([]);
	});

	it("lists the whole project when no feature is named", async () => {
		await listFindings({ projectId: "p1", status: "OPEN" });

		const where = dbMock.testFinding.findMany.mock.calls[0][0].where;
		expect(where).toEqual({
			projectId: "p1",
			deletedAt: null,
			status: "OPEN",
		});
		// Notably NO testCase clause: a project-level list must still show the
		// failures Fabric tracks no case for, which are the ones most at risk of
		// never being looked at.
		expect(where.testCase).toBeUndefined();
	});

	it("reaches through the matched case's feature link when one is named", async () => {
		await listFindings({ projectId: "p1", storyId: "s1", status: "OPEN" });

		const where = dbMock.testFinding.findMany.mock.calls[0][0].where;
		expect(where.testCase).toEqual({
			deletedAt: null,
			workItemLinks: { some: { userStoryId: "s1" } },
		});
		// The tenant guard survives the added join.
		expect(where.projectId).toBe("p1");
	});

	it("excludes unattributable failures from a feature's list, by construction", async () => {
		// A finding with no testCaseId cannot belong to a feature — there is no
		// link to follow. The `testCase` relation filter drops those rows, which
		// is the honest answer: they stay on the project surface, the only place
		// they can actually be triaged. Asserted because the tempting "fix" is an
		// OR that pulls every orphan failure into every feature.
		await listFindings({ projectId: "p1", storyId: "s1" });

		const where = dbMock.testFinding.findMany.mock.calls[0][0].where;
		expect(where.OR).toBeUndefined();
		expect(where.testCase).toBeDefined();
	});
});

describe("the diff an analysis reasoned over", () => {
	const DIFF = {
		commitRange: { baseSha: "aaa111", headSha: "bbb222" },
		changedFiles: [{ path: "src/cart.ts", reason: "shares 'cart'" }],
		truncated: false,
	};

	beforeEach(() => {
		dbMock.testFinding.updateMany.mockResolvedValue({ count: 1 });
	});

	it("stores the diff beside the cause", async () => {
		await setFindingAnalysis({
			projectId: "p1",
			findingId: "f1",
			suspectedCause: "cause",
			suspectedKind: "PRODUCT_BUG",
			analysisModel: "m",
			analysisDiff: DIFF,
		});

		const data = dbMock.testFinding.updateMany.mock.calls[0][0].data;
		expect(data.analysisDiff).toEqual(DIFF);
	});

	it("clears a previous diff with SQL NULL, not an omission", async () => {
		// `undefined` means "leave unchanged" to Prisma, so omitting the field on
		// a re-analysis with no diff would leave the OLD file list sitting under
		// the NEW cause — presenting a hypothesis as diff-correlated when it was
		// reached without one. A bare `null` is no better: on a Json column it
		// persists the JSON value `null` rather than SQL NULL.
		await setFindingAnalysis({
			projectId: "p1",
			findingId: "f1",
			suspectedCause: "cause",
			suspectedKind: "PRODUCT_BUG",
			analysisModel: "m",
			analysisDiff: null,
		});

		const data = dbMock.testFinding.updateMany.mock.calls[0][0].data;
		expect(data.analysisDiff).toBe("DbNull");
		expect(data.analysisDiff).not.toBeUndefined();
	});
});

describe("parseAnalysisDiff", () => {
	it("accepts a well-formed diff", () => {
		expect(
			parseAnalysisDiff({
				commitRange: { baseSha: "a", headSha: "b" },
				changedFiles: [{ path: "p", reason: "r" }],
				truncated: true,
			}),
		).toEqual({
			commitRange: { baseSha: "a", headSha: "b" },
			changedFiles: [{ path: "p", reason: "r" }],
			truncated: true,
		});
	});

	it.each([
		["null", null],
		["a string", "not an object"],
		["no commit range", { changedFiles: [{ path: "p", reason: "r" }] }],
		[
			"half a commit range",
			{
				commitRange: { baseSha: "a" },
				changedFiles: [{ path: "p", reason: "r" }],
			},
		],
		["no file list", { commitRange: { baseSha: "a", headSha: "b" } }],
		[
			"an empty file list",
			{
				commitRange: { baseSha: "a", headSha: "b" },
				changedFiles: [],
			},
		],
	])("returns null for %s", (_label, raw) => {
		// A Json column cannot promise its own shape: rows predate the schema,
		// migrations get rolled back, and this value renders straight into JSX.
		// Every malformed case must degrade to "no diff" rather than throw.
		expect(parseAnalysisDiff(raw)).toBeNull();
	});

	it("drops malformed entries rather than the whole diff", () => {
		const parsed = parseAnalysisDiff({
			commitRange: { baseSha: "a", headSha: "b" },
			changedFiles: [
				{ path: "keep.ts", reason: "r" },
				{ path: "no-reason.ts" },
				"not an object",
			],
			truncated: false,
		});

		expect(parsed?.changedFiles).toEqual([
			{ path: "keep.ts", reason: "r" },
		]);
	});

	it("treats a missing truncation flag as not truncated", () => {
		// The flag drives a warning that more files may have changed. Absent must
		// mean "no warning", never a warning nobody can act on.
		expect(
			parseAnalysisDiff({
				commitRange: { baseSha: "a", headSha: "b" },
				changedFiles: [{ path: "p", reason: "r" }],
			})?.truncated,
		).toBe(false);
	});
});

describe("dismissFinding", () => {
	it("hides a finding without claiming the test passed", async () => {
		// RESOLVED means ingestion saw the test go green. IGNORED means a person
		// decided not to chase it. Collapsing them would make a dismissal read as
		// a fix — and the recurrence logic reopens RESOLVED rows, so the two
		// states behave differently as well as meaning different things.
		dbMock.testFinding.findFirst.mockResolvedValue({
			id: "f1",
			status: "OPEN",
		});

		const result = await dismissFinding({
			projectId: "p1",
			findingId: "f1",
		});

		expect(result).toEqual({ findingId: "f1", alreadyDismissed: false });
		const args = dbMock.testFinding.update.mock.calls[0][0];
		expect(args.data.status).toBe("IGNORED");
	});

	it("scopes the lookup by project, so a foreign id matches nothing", async () => {
		dbMock.testFinding.findFirst.mockResolvedValue(null);

		await expect(
			dismissFinding({ projectId: "p1", findingId: "someone-elses" }),
		).rejects.toThrow(/not found/i);

		const where = dbMock.testFinding.findFirst.mock.calls[0][0].where;
		expect(where.projectId).toBe("p1");
		expect(dbMock.testFinding.update).not.toHaveBeenCalled();
	});

	it("refuses to dismiss a finding whose bug is already tracking it", async () => {
		// Hiding it would orphan the bug from the evidence that justified it.
		dbMock.testFinding.findFirst.mockResolvedValue({
			id: "f1",
			status: "PROMOTED",
		});

		await expect(
			dismissFinding({ projectId: "p1", findingId: "f1" }),
		).rejects.toThrow(/promoted/i);
		expect(dbMock.testFinding.update).not.toHaveBeenCalled();
	});

	it("is idempotent — dismissing twice writes once", async () => {
		dbMock.testFinding.findFirst.mockResolvedValue({
			id: "f1",
			status: "IGNORED",
		});

		const result = await dismissFinding({
			projectId: "p1",
			findingId: "f1",
		});

		expect(result.alreadyDismissed).toBe(true);
		expect(dbMock.testFinding.update).not.toHaveBeenCalled();
	});
});

describe("mergeFindings", () => {
	const rows = [
		{
			id: "primary",
			status: "OPEN",
			occurrences: 2,
			firstSeenAt: new Date("2026-07-10"),
			lastSeenAt: new Date("2026-07-20"),
		},
		{
			id: "dup1",
			status: "OPEN",
			occurrences: 3,
			firstSeenAt: new Date("2026-07-01"),
			lastSeenAt: new Date("2026-07-25"),
		},
	];

	it("sums occurrences and widens the window to cover every merged row", async () => {
		// The whole point is that recurrence becomes readable: three rows each
		// saying "Seen 1 time" is the bug this repairs, so the total and the
		// first/last window must span all of them.
		dbMock.testFinding.findMany.mockResolvedValue(rows);

		const result = await mergeFindings({
			projectId: "p1",
			primaryId: "primary",
			duplicateIds: ["dup1"],
		});

		expect(result).toEqual({
			primaryId: "primary",
			mergedCount: 1,
			occurrences: 5,
		});
		// The primary's update and the duplicates' soft-delete go out together,
		// so a partial merge cannot leave occurrences summed on a row whose
		// duplicates are still visible.
		expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
		const updateArgs = dbMock.testFinding.update.mock.calls[0][0];
		expect(updateArgs.data.occurrences).toBe(5);
		expect(updateArgs.data.firstSeenAt).toEqual(new Date("2026-07-01"));
		expect(updateArgs.data.lastSeenAt).toEqual(new Date("2026-07-25"));
	});

	it("soft-deletes the duplicates rather than removing them", async () => {
		// Their fingerprints stay put, so a recurrence writing the same
		// fingerprint lands on the soft-deleted row instead of colliding with
		// @@unique([projectId, fingerprint]) — and a wrong merge stays reversible.
		dbMock.testFinding.findMany.mockResolvedValue(rows);

		await mergeFindings({
			projectId: "p1",
			primaryId: "primary",
			duplicateIds: ["dup1"],
		});

		const args = dbMock.testFinding.updateMany.mock.calls[0][0];
		expect(args.where.id).toEqual({ in: ["dup1"] });
		expect(args.where.projectId).toBe("p1");
		expect(args.data.deletedAt).toBeInstanceOf(Date);
	});

	it("ignores the primary appearing in its own duplicate list", async () => {
		dbMock.testFinding.findMany.mockResolvedValue([rows[0]]);

		const result = await mergeFindings({
			projectId: "p1",
			primaryId: "primary",
			duplicateIds: ["primary"],
		});

		expect(result.mergedCount).toBe(0);
		expect(dbMock.$transaction).not.toHaveBeenCalled();
	});

	it("refuses when a duplicate already has a bug", async () => {
		// Skipping it silently would leave the caller believing the list is
		// tidier than it is.
		dbMock.testFinding.findMany.mockResolvedValue([
			rows[0],
			{ ...rows[1], status: "PROMOTED" },
		]);

		await expect(
			mergeFindings({
				projectId: "p1",
				primaryId: "primary",
				duplicateIds: ["dup1"],
			}),
		).rejects.toThrow(/promoted/i);
		expect(dbMock.$transaction).not.toHaveBeenCalled();
	});
});
