/**
 * The coverage index behind the richer traceability matrix.
 *
 * What is worth pinning here is not the joining — it is the handful of places
 * where the honest answer and the convenient answer differ:
 *
 *  - a hand-authored case must never be reported stale;
 *  - "nobody classified this" must not be reported as "a person runs this";
 *  - the commit must come from the NEWEST result or not at all, because a
 *    commit from two runs back reads as current and is therefore worse than
 *    none.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	testCase: { findMany: vi.fn() },
}));
vi.mock("../../../client", () => ({
	db: dbMock,
	Prisma: { DbNull: "DbNull" },
}));

import {
	type CoverageIndexEntry,
	getCoverageIndexForStory,
	summariseCoverageTypes,
} from "../coverage-index";
import { fingerprintSpecText } from "../test-case-drift";

const STORY = {
	title: "Checkout",
	description: "A cart flow",
	acceptanceCriteria: "AC1: totals never go negative",
};
const CURRENT_HASH = fingerprintSpecText(STORY);

/** A row shaped like the Prisma select in the query under test. */
const row = (overrides: Record<string, unknown> = {}) => ({
	id: "tc1",
	identifier: "TC-001",
	title: "Discount applies",
	coverageType: "E2E",
	currentResult: "PASSED",
	lastRunAt: new Date("2026-07-01T00:00:00Z"),
	automationFilePath: "e2e/checkout.spec.ts",
	draftedFromSpecHash: CURRENT_HASH,
	workItemLinks: [{ acceptanceCriterionRefs: ["AC 1"] }],
	resultEvents: [
		{
			pipelineRun: { commitSha: "abc1234" },
			_count: { agenticSteps: 3 },
		},
	],
	...overrides,
});

const load = () =>
	getCoverageIndexForStory({
		projectId: "p1",
		storyId: "s1",
		story: STORY,
	});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getCoverageIndexForStory", () => {
	it("carries every dimension the matrix reports", async () => {
		dbMock.testCase.findMany.mockResolvedValue([row()]);

		const { entries, currentSpecHash } = await load();

		expect(currentSpecHash).toBe(CURRENT_HASH);
		expect(entries[0]).toMatchObject({
			identifier: "TC-001",
			acceptanceCriterionRefs: ["AC 1"],
			coverageType: "E2E",
			specFilePath: "e2e/checkout.spec.ts",
			commitSha: "abc1234",
			evidenceCount: 3,
			isStale: false,
		});
	});

	it("never reports a hand-authored case as stale", async () => {
		// A case with no recorded hash was not derived from the feature text, so
		// it cannot have drifted from it. Flagging it would be telling somebody
		// their own work is out of date.
		dbMock.testCase.findMany.mockResolvedValue([
			row({ draftedFromSpecHash: null }),
		]);

		expect((await load()).entries[0].isStale).toBe(false);
	});

	it("reports a case drafted from older text as stale", async () => {
		dbMock.testCase.findMany.mockResolvedValue([
			row({ draftedFromSpecHash: "drafted-from-something-else" }),
		]);

		expect((await load()).entries[0].isStale).toBe(true);
	});

	it("reports no commit rather than a stale one when the newest result is manual", async () => {
		// A commit from two runs back reads as current, which is worse than
		// reporting none at all.
		dbMock.testCase.findMany.mockResolvedValue([
			row({
				resultEvents: [
					{ pipelineRun: null, _count: { agenticSteps: 0 } },
				],
			}),
		]);

		const entry = (await load()).entries[0];
		expect(entry.commitSha).toBeNull();
		expect(entry.evidenceCount).toBe(0);
	});

	it("handles a case that has never run", async () => {
		dbMock.testCase.findMany.mockResolvedValue([
			row({
				resultEvents: [],
				currentResult: "NOT_RUN",
				lastRunAt: null,
			}),
		]);

		expect((await load()).entries[0]).toMatchObject({
			commitSha: null,
			evidenceCount: 0,
			lastRunAt: null,
		});
	});

	it("reads only the newest result, so provenance cannot come from history", async () => {
		await load();

		const select = dbMock.testCase.findMany.mock.calls[0][0].select;
		expect(select.resultEvents.take).toBe(1);
		expect(select.resultEvents.orderBy).toEqual({ occurredAt: "desc" });
	});

	it("counts only steps that actually captured evidence", async () => {
		// Counting every step would report an evidence number for a run that
		// captured nothing.
		await load();

		const select = dbMock.testCase.findMany.mock.calls[0][0].select;
		expect(
			select.resultEvents.select._count.select.agenticSteps.where,
		).toEqual({ evidenceKey: { not: null } });
	});

	it("scopes to the project and excludes deleted cases", async () => {
		await load();

		const where = dbMock.testCase.findMany.mock.calls[0][0].where;
		expect(where.projectId).toBe("p1");
		expect(where.deletedAt).toBeNull();
	});
});

describe("summariseCoverageTypes", () => {
	const entry = (coverageType: CoverageIndexEntry["coverageType"]) =>
		({ coverageType }) as CoverageIndexEntry;

	it("keeps unclassified cases apart from deliberately manual ones", () => {
		// Folding null into MANUAL would make an unclassified backlog look like a
		// considered manual-testing policy.
		expect(
			summariseCoverageTypes([entry("MANUAL"), entry(null), entry(null)]),
		).toMatchObject({ manual: 1, unknown: 2 });
	});

	it("counts each pyramid level", () => {
		expect(
			summariseCoverageTypes([
				entry("UNIT"),
				entry("UNIT"),
				entry("INTEGRATION"),
				entry("E2E"),
			]),
		).toEqual({ unit: 2, integration: 1, e2e: 1, manual: 0, unknown: 0 });
	});
});
