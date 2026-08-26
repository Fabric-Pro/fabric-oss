/**
 * Unit tests for RCA→BUG. Mocks the Prisma client and `createStory`,
 * mirroring pipeline-results.test.ts.
 *
 * The behaviour that matters here is what the bug BODY says. The requirement
 * asks for "root cause analysis on failures"; what shipped was failure
 * reporting, and
 * until now it did not even carry the assertion CI printed — that text sits in
 * the run's `results` JSON, so a reader had to leave Fabric to learn anything
 * about why the test failed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, createStoryMock } = vi.hoisted(() => {
	const make = () => ({
		findUnique: vi.fn(),
		findFirst: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
	});
	return {
		dbMock: {
			testCase: make(),
			userStory: make(),
			testResultEvent: make(),
			testPipelineRun: make(),
			// The latest-failure lookup is one `findFirst` per failing case sent as
			// a single batch. Prisma's array form resolves every operation in it,
			// so the stand-in must too.
			$transaction: vi.fn(async (ops: unknown) =>
				Array.isArray(ops) ? Promise.all(ops) : ops,
			),
		},
		createStoryMock: vi.fn(),
	};
});

vi.mock("../../../client", () => ({ db: dbMock }));
vi.mock("../stories", () => ({
	createStory: (...args: unknown[]) => createStoryMock(...args),
}));

import { openBugsForFailedCases } from "../pipeline-results-rca";

const INPUT = {
	projectId: "p1",
	createdById: "u1",
	testCaseIds: ["c1"],
};

/** One failing case, no existing bug, one FAILED event pointing at a run. */
function arrange(
	runResults: unknown,
	overrides: { commitSha?: string | null; branch?: string | null } = {},
) {
	dbMock.testCase.findMany.mockResolvedValue([
		{
			id: "c1",
			identifier: "TC-014",
			title: "resets the password",
			lastRunByLabel: "GitHub Actions",
		},
	]);
	dbMock.userStory.findMany.mockResolvedValue([]);
	// One row per failing case — the query asks for exactly the latest FAILED
	// event per case rather than reading the case's whole failure history.
	dbMock.testResultEvent.findFirst.mockResolvedValue({
		testCaseId: "c1",
		note: "resets the password (tag match)",
		externalRunUrl: "https://github.com/acme/store/actions/runs/9",
		actorLabel: "GitHub Actions · run 9",
		pipelineRunId: "run1",
	});
	dbMock.testPipelineRun.findMany.mockResolvedValue([
		{
			id: "run1",
			results: runResults,
			branch: overrides.branch ?? "main",
			commitSha: overrides.commitSha ?? "abcdef1234567890",
			pipelineName: "e2e",
		},
	]);
	createStoryMock.mockResolvedValue({ id: "bug1" });
}

function bodyOfOpenedBug(): string {
	return createStoryMock.mock.calls[0][0].description as string;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("openBugsForFailedCases", () => {
	it("carries the assertion CI printed into the bug body", async () => {
		arrange([
			{
				name: "resets the password",
				status: "FAILED",
				matchedCaseId: "c1",
				failureMessage:
					"AssertionError: expected 'Welcome' to be 'Reset sent'",
			},
		]);

		const opened = await openBugsForFailedCases(INPUT);

		expect(opened).toBe(1);
		const body = bodyOfOpenedBug();
		expect(body).toContain(
			"AssertionError: expected 'Welcome' to be 'Reset sent'",
		);
		// Fenced, so a stack trace is not re-wrapped into soup by the renderer.
		expect(body).toContain("```");
	});

	it("keeps Fabric's own ticket references out of the customer's bug", async () => {
		// This body is persisted into the CUSTOMER's roadmap. It used to end
		// with a parenthesised Fabric card number, which means nothing to the
		// person reading the bug, in a place no reviewer looks. The assertion
		// below is deliberately generic rather than pinned to the one number
		// that leaked.
		arrange([
			{
				name: "resets the password",
				status: "FAILED",
				matchedCaseId: "c1",
				failureMessage: "AssertionError: nope",
			},
		]);

		await openBugsForFailedCases(INPUT);

		const body = bodyOfOpenedBug();
		expect(body).toContain("Opened automatically from a pipeline result");
		expect(body).not.toMatch(/card\s*\d{3,}/i);
	});

	it("names the branch and short commit — the next question after 'what broke'", async () => {
		arrange(
			[
				{
					name: "t",
					status: "FAILED",
					matchedCaseId: "c1",
					failureMessage: "boom",
				},
			],
			{ branch: "release/2.0", commitSha: "0123456789abcdef" },
		);

		await openBugsForFailedCases(INPUT);

		const body = bodyOfOpenedBug();
		expect(body).toContain("release/2.0");
		expect(body).toContain("01234567");
		// Short sha, not the full 40 characters.
		expect(body).not.toContain("0123456789abcdef");
	});

	it("truncates a runner that dumps a whole log file", async () => {
		arrange([
			{
				name: "t",
				status: "FAILED",
				matchedCaseId: "c1",
				failureMessage: "x".repeat(5000),
			},
		]);

		await openBugsForFailedCases(INPUT);

		const body = bodyOfOpenedBug();
		expect(body).toContain("truncated");
		// The bug stays readable rather than becoming the log file.
		expect(body.length).toBeLessThan(2500);
	});

	it("still opens the bug when the run carries no failure text", async () => {
		// Older runs, and providers that report only a status, have none. The bug
		// is still worth opening — it just says less.
		arrange([{ name: "t", status: "FAILED", matchedCaseId: "c1" }]);

		const opened = await openBugsForFailedCases(INPUT);

		expect(opened).toBe(1);
		expect(bodyOfOpenedBug()).not.toContain("What CI reported");
	});

	it("survives a malformed results payload instead of losing the bug", async () => {
		// `results` is JSON, not a typed column: a legacy or corrupt row must not
		// throw and cost this case its bug.
		arrange({ not: "an array" });

		const opened = await openBugsForFailedCases(INPUT);

		expect(opened).toBe(1);
		expect(bodyOfOpenedBug()).not.toContain("What CI reported");
	});

	it("ignores another case's failure message in the same run", async () => {
		// One run covers many cases; picking the wrong record would attach a
		// stranger's stack trace to this bug.
		arrange([
			{
				name: "other",
				status: "FAILED",
				matchedCaseId: "c2",
				failureMessage: "SOMEONE ELSE'S FAILURE",
			},
			{
				name: "mine",
				status: "FAILED",
				matchedCaseId: "c1",
				failureMessage: "MY FAILURE",
			},
		]);

		await openBugsForFailedCases(INPUT);

		const body = bodyOfOpenedBug();
		expect(body).toContain("MY FAILURE");
		expect(body).not.toContain("SOMEONE ELSE'S FAILURE");
	});

	it("does not reopen a bug that is already open for the case", async () => {
		arrange([]);
		dbMock.userStory.findMany.mockResolvedValue([
			{ originTestCaseId: "c1" },
		]);

		const opened = await openBugsForFailedCases(INPUT);

		expect(opened).toBe(0);
		expect(createStoryMock).not.toHaveBeenCalled();
	});

	it("writes nothing when no case is currently failing", async () => {
		dbMock.testCase.findMany.mockResolvedValue([]);

		const opened = await openBugsForFailedCases(INPUT);

		expect(opened).toBe(0);
		expect(dbMock.testResultEvent.findFirst).not.toHaveBeenCalled();
	});

	it("asks for one latest failure per case, not the whole failure history", async () => {
		// The bug body needs exactly one event per failing case. Reading every
		// FAILED event those cases ever produced and picking one in Node made the
		// cost grow with how long a test had been flaky — invisible in the output,
		// which is why it needs an assertion on the query shape.
		arrange([
			{
				name: "resets the password",
				status: "FAILED",
				matchedCaseId: "c1",
				failureMessage: "AssertionError: nope",
			},
		]);

		await openBugsForFailedCases(INPUT);

		expect(dbMock.testResultEvent.findMany).not.toHaveBeenCalled();
		expect(dbMock.testResultEvent.findFirst).toHaveBeenCalledTimes(1);
		const args = dbMock.testResultEvent.findFirst.mock.calls[0][0];
		expect(args.where).toEqual({ testCaseId: "c1", result: "FAILED" });
		expect(args.orderBy).toEqual({ occurredAt: "desc" });
	});
});
