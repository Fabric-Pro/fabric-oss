/**
 * Unit tests for the Test Case run-result query layer (`../test-cases`, TG-R2).
 *
 * Mocks the Prisma client (`../../../client`) — no real DB, mirroring
 * `test-cases.test.ts`. Asserts the pure decision logic the result helpers own:
 *   - `recordTestCaseResult`: one-tx append-event + refresh-current, actor-label
 *     resolution (explicit actorLabel > user display > null), and the live-case
 *     guard (missing/soft-deleted → null, no writes);
 *   - `resetProjectTestResults`: NOT_RUN-only selection, MANUAL NOT_RUN event per
 *     case + denormalized reset, tenant XOR, and the nothing-to-reset short
 *     circuit (count 0, no writes);
 *   - `listTestCaseResultHistory`: newest-first ordering + provenance select;
 *   - `computePlanPassRate` / `computeProjectResultRollup`: the pass-over-executed
 *     tally and the tenant XOR / plan-membership WHERE.
 *
 * Run with: pnpm --filter @repo/database test prisma/queries/projects/__tests__/test-case-results.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
	const make = () => ({
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		createMany: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		groupBy: vi.fn(),
		count: vi.fn(),
	});
	return {
		dbMock: {
			testCase: make(),
			testResultEvent: make(),
			user: make(),
			$transaction: vi.fn(),
		},
	};
});

vi.mock("../../../client", () => ({ db: dbMock }));

import {
	computePlanPassRate,
	computeProjectResultRollup,
	listTestCaseResultHistory,
	recordTestCaseResult,
	resetProjectTestResults,
} from "../test-case-results";

/** Callback-form `$transaction` runs against the shared mock (tx === dbMock). */
function defaultTransaction() {
	dbMock.$transaction.mockImplementation(async (arg: unknown) =>
		typeof arg === "function"
			? (arg as (tx: unknown) => unknown)(dbMock)
			: Promise.all(arg as Promise<unknown>[]),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	defaultTransaction();
});

describe("recordTestCaseResult", () => {
	beforeEach(() => {
		dbMock.testCase.findFirst.mockResolvedValue({ id: "tc1" });
		dbMock.testResultEvent.create.mockResolvedValue({ id: "ev1" });
		dbMock.testCase.update.mockResolvedValue({
			id: "tc1",
			currentResult: "PASSED",
		});
	});

	it("appends the event and refreshes the denormalized current in one tx", async () => {
		dbMock.user.findUnique.mockResolvedValue({
			name: "Alice",
			email: "a@example.com",
		});

		const result = await recordTestCaseResult({
			testCaseId: "tc1",
			result: "PASSED",
			source: "MANUAL",
			changedByUserId: "u1",
			testPlanId: "tp1",
			note: "smoke ok",
		});

		expect(dbMock.$transaction).toHaveBeenCalledTimes(1);

		const eventArg = dbMock.testResultEvent.create.mock.calls[0][0];
		expect(eventArg.data).toMatchObject({
			testCaseId: "tc1",
			result: "PASSED",
			source: "MANUAL",
			changedByUserId: "u1",
			testPlanId: "tp1",
			note: "smoke ok",
			actorLabel: null,
			externalRunRef: null,
			externalRunUrl: null,
		});
		expect(eventArg.data.occurredAt).toBeInstanceOf(Date);

		const updateArg = dbMock.testCase.update.mock.calls[0][0];
		expect(updateArg.where).toEqual({ id: "tc1" });
		expect(updateArg.data).toMatchObject({
			currentResult: "PASSED",
			lastRunSource: "MANUAL",
			lastRunByLabel: "Alice",
		});
		expect(updateArg.data.lastRunAt).toBeInstanceOf(Date);

		// The updated case is returned with the new event nested.
		expect(result).toEqual({
			id: "tc1",
			currentResult: "PASSED",
			event: { id: "ev1" },
		});
	});

	it("stamps the same instant on the event and the denormalized lastRunAt", async () => {
		dbMock.user.findUnique.mockResolvedValue({
			name: "Alice",
			email: null,
		});
		await recordTestCaseResult({
			testCaseId: "tc1",
			result: "FAILED",
			source: "MANUAL",
			changedByUserId: "u1",
		});
		const eventAt = dbMock.testResultEvent.create.mock.calls[0][0].data
			.occurredAt as Date;
		const runAt = dbMock.testCase.update.mock.calls[0][0].data
			.lastRunAt as Date;
		expect(eventAt.getTime()).toBe(runAt.getTime());
	});

	it("prefers an explicit actorLabel (PM_SYNC) over any user lookup", async () => {
		await recordTestCaseResult({
			testCaseId: "tc1",
			result: "PASSED",
			source: "PM_SYNC",
			actorLabel: "Azure DevOps · run 4821",
			externalRunRef: "4821",
			externalRunUrl: "https://dev.azure.com/x/_testManagement/runs/4821",
		});

		// actorLabel present → never touches the user table.
		expect(dbMock.user.findUnique).not.toHaveBeenCalled();
		expect(
			dbMock.testResultEvent.create.mock.calls[0][0].data,
		).toMatchObject({
			source: "PM_SYNC",
			actorLabel: "Azure DevOps · run 4821",
			externalRunRef: "4821",
			changedByUserId: null,
		});
		expect(
			dbMock.testCase.update.mock.calls[0][0].data.lastRunByLabel,
		).toBe("Azure DevOps · run 4821");
	});

	it("falls back to the user email when the user has no name", async () => {
		dbMock.user.findUnique.mockResolvedValue({
			name: null,
			email: "b@example.com",
		});
		await recordTestCaseResult({
			testCaseId: "tc1",
			result: "BLOCKED",
			source: "MANUAL",
			changedByUserId: "u1",
		});
		expect(
			dbMock.testCase.update.mock.calls[0][0].data.lastRunByLabel,
		).toBe("b@example.com");
	});

	it("leaves lastRunByLabel null when there is no actor at all", async () => {
		await recordTestCaseResult({
			testCaseId: "tc1",
			result: "NOT_RUN",
			source: "MANUAL",
		});
		expect(dbMock.user.findUnique).not.toHaveBeenCalled();
		expect(
			dbMock.testCase.update.mock.calls[0][0].data.lastRunByLabel,
		).toBeNull();
	});

	it("returns null and never writes when the case is missing/soft-deleted", async () => {
		dbMock.testCase.findFirst.mockResolvedValue(null);
		const result = await recordTestCaseResult({
			testCaseId: "tc1",
			result: "PASSED",
			source: "MANUAL",
			changedByUserId: "u1",
		});
		expect(result).toBeNull();
		expect(dbMock.testResultEvent.create).not.toHaveBeenCalled();
		expect(dbMock.testCase.update).not.toHaveBeenCalled();
	});

	it("guards the live-case check by id + deletedAt:null (no projectId at this layer)", async () => {
		await recordTestCaseResult({
			testCaseId: "tc1",
			result: "PASSED",
			source: "MANUAL",
		});
		expect(dbMock.testCase.findFirst).toHaveBeenCalledWith({
			where: { id: "tc1", deletedAt: null },
			select: { id: true },
		});
	});
});

describe("resetProjectTestResults", () => {
	it("appends a MANUAL NOT_RUN event per non-NOT_RUN case + resets current (org context)", async () => {
		dbMock.testCase.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
		dbMock.user.findUnique.mockResolvedValue({ name: "Bob", email: null });

		const res = await resetProjectTestResults({
			projectId: "p1",
			organizationId: "org1",
			changedByUserId: "u1",
		});

		expect(res).toEqual({ reset: 2 });

		// Only cases that have a result get selected (NOT_RUN excluded), org XOR.
		expect(dbMock.testCase.findMany.mock.calls[0][0].where).toEqual({
			projectId: "p1",
			deletedAt: null,
			currentResult: { not: "NOT_RUN" },
			organizationId: "org1",
		});

		// One append per case, attributed to the resetter — history preserved.
		const createManyArg =
			dbMock.testResultEvent.createMany.mock.calls[0][0];
		expect(createManyArg.data).toHaveLength(2);
		expect(createManyArg.data[0]).toMatchObject({
			testCaseId: "a",
			result: "NOT_RUN",
			source: "MANUAL",
			changedByUserId: "u1",
		});
		expect(createManyArg.data[1]).toMatchObject({ testCaseId: "b" });

		// Denormalized current reset for exactly the selected ids.
		const updateArg = dbMock.testCase.updateMany.mock.calls[0][0];
		expect(updateArg.where).toEqual({ id: { in: ["a", "b"] } });
		expect(updateArg.data).toMatchObject({
			currentResult: "NOT_RUN",
			lastRunSource: "MANUAL",
			lastRunByLabel: "Bob",
		});
		expect(updateArg.data.lastRunAt).toBeInstanceOf(Date);
	});

	it("uses the personal-context XOR filter (organizationId null)", async () => {
		dbMock.testCase.findMany.mockResolvedValue([{ id: "a" }]);
		dbMock.user.findUnique.mockResolvedValue({ name: "Bob", email: null });
		await resetProjectTestResults({
			projectId: "p1",
			organizationId: null,
			changedByUserId: "u1",
		});
		expect(
			dbMock.testCase.findMany.mock.calls[0][0].where.organizationId,
		).toBeNull();
	});

	it("returns { reset: 0 } and writes nothing when there is nothing to reset", async () => {
		dbMock.testCase.findMany.mockResolvedValue([]);

		const res = await resetProjectTestResults({
			projectId: "p1",
			organizationId: "org1",
			changedByUserId: "u1",
		});

		expect(res).toEqual({ reset: 0 });
		expect(dbMock.testResultEvent.createMany).not.toHaveBeenCalled();
		expect(dbMock.testCase.updateMany).not.toHaveBeenCalled();
		expect(dbMock.user.findUnique).not.toHaveBeenCalled();
	});
});

describe("listTestCaseResultHistory", () => {
	it("returns events newest-first with provenance, or [] when empty", async () => {
		dbMock.testResultEvent.findMany.mockResolvedValue([]);
		dbMock.testResultEvent.count.mockResolvedValue(0);
		const res = await listTestCaseResultHistory({ testCaseId: "tc1" });
		expect(res).toEqual({ items: [], total: 0 });

		const arg = dbMock.testResultEvent.findMany.mock.calls[0][0];
		expect(arg.where).toEqual({ testCaseId: "tc1" });
		// `id` is the tiebreaker: without it, rows sharing one `occurredAt`
		// come back in whatever order the plan produces, and offset paging
		// then drops or repeats a row at the page boundary.
		expect(arg.orderBy).toEqual([{ occurredAt: "desc" }, { id: "desc" }]);
		// Provenance joins: the acting user + the plan run.
		expect(arg.select.changedByUser).toEqual({
			select: { id: true, name: true, email: true, image: true },
		});
		expect(arg.select.testPlan).toEqual({
			select: { id: true, identifier: true, name: true },
		});
	});

	it("passes rows straight through (newest-first ordering owned by the DB)", async () => {
		const rows = [{ id: "ev2" }, { id: "ev1" }];
		dbMock.testResultEvent.findMany.mockResolvedValue(rows);
		dbMock.testResultEvent.count.mockResolvedValue(2);
		await expect(
			listTestCaseResultHistory({ testCaseId: "tc1" }),
		).resolves.toEqual({ items: rows, total: 2 });
	});

	it("pages with limit/offset while `total` stays the untruncated count", async () => {
		// The panel renders 5 rows and says how many exist; if `total` were the
		// page size, a truncated list would look complete.
		dbMock.testResultEvent.findMany.mockResolvedValue([{ id: "ev9" }]);
		dbMock.testResultEvent.count.mockResolvedValue(37);
		const res = await listTestCaseResultHistory({
			testCaseId: "tc1",
			limit: 1,
			offset: 15,
		});
		expect(res.total).toBe(37);
		expect(res.items).toHaveLength(1);

		const arg = dbMock.testResultEvent.findMany.mock.calls[0][0];
		expect(arg.take).toBe(1);
		expect(arg.skip).toBe(15);
	});
});

describe("computePlanPassRate", () => {
	it("computes passed / executed (NOT_RUN excluded from the denominator)", async () => {
		dbMock.testCase.groupBy.mockResolvedValue([
			{ currentResult: "PASSED", _count: { _all: 3 } },
			{ currentResult: "FAILED", _count: { _all: 1 } },
			{ currentResult: "NOT_RUN", _count: { _all: 2 } },
		]);

		const rollup = await computePlanPassRate("tp1");

		expect(rollup).toEqual({
			total: 6,
			notRun: 2,
			passed: 3,
			failed: 1,
			blocked: 0,
			skipped: 0,
			executed: 4,
			passRate: 0.75,
		});
		expect(dbMock.testCase.groupBy.mock.calls[0][0].where).toEqual({
			deletedAt: null,
			planLinks: { some: { planId: "tp1" } },
		});
	});

	it("leaves SKIPPED out of the denominator, like NOT_RUN", async () => {
		// A skipped case did not run, so counting it as executed would punish a
		// suite for tests it was deliberately told to skip: 3/4 here, not 3/5.
		dbMock.testCase.groupBy.mockResolvedValue([
			{ currentResult: "PASSED", _count: { _all: 3 } },
			{ currentResult: "FAILED", _count: { _all: 1 } },
			{ currentResult: "SKIPPED", _count: { _all: 1 } },
		]);

		const rollup = await computePlanPassRate("tp1");

		expect(rollup.total).toBe(5);
		expect(rollup.skipped).toBe(1);
		expect(rollup.executed).toBe(4);
		expect(rollup.passRate).toBe(0.75);
	});

	it("reads 0% (not 100%) when a plan's cases were all skipped", async () => {
		// Not 100%: nothing ran. Distinct from the all-NOT_RUN case below only in
		// WHY nothing ran, which the counts preserve.
		dbMock.testCase.groupBy.mockResolvedValue([
			{ currentResult: "SKIPPED", _count: { _all: 4 } },
		]);
		const rollup = await computePlanPassRate("tp1");
		expect(rollup.executed).toBe(0);
		expect(rollup.passRate).toBe(0);
		expect(rollup.skipped).toBe(4);
	});

	it("reads 0% (not 100%) when no member case has been executed", async () => {
		dbMock.testCase.groupBy.mockResolvedValue([
			{ currentResult: "NOT_RUN", _count: { _all: 4 } },
		]);
		const rollup = await computePlanPassRate("tp1");
		expect(rollup.executed).toBe(0);
		expect(rollup.passRate).toBe(0);
	});
});

describe("computeProjectResultRollup", () => {
	it("tallies project-wide counts with the org XOR filter", async () => {
		dbMock.testCase.groupBy.mockResolvedValue([
			{ currentResult: "PASSED", _count: { _all: 2 } },
			{ currentResult: "BLOCKED", _count: { _all: 1 } },
		]);

		const rollup = await computeProjectResultRollup({
			projectId: "p1",
			organizationId: "org1",
		});

		expect(rollup).toMatchObject({
			total: 3,
			passed: 2,
			blocked: 1,
			executed: 3,
			passRate: 2 / 3,
		});
		expect(dbMock.testCase.groupBy.mock.calls[0][0].where).toEqual({
			projectId: "p1",
			deletedAt: null,
			organizationId: "org1",
		});
	});

	it("omits the tenant narrowing entirely when organizationId is undefined", async () => {
		dbMock.testCase.groupBy.mockResolvedValue([]);
		await computeProjectResultRollup({ projectId: "p1" });
		expect(dbMock.testCase.groupBy.mock.calls[0][0].where).toEqual({
			projectId: "p1",
			deletedAt: null,
		});
	});

	it("treats a personal context (organizationId null) as organizationId:null", async () => {
		dbMock.testCase.groupBy.mockResolvedValue([]);
		await computeProjectResultRollup({
			projectId: "p1",
			organizationId: null,
		});
		expect(
			dbMock.testCase.groupBy.mock.calls[0][0].where.organizationId,
		).toBeNull();
	});
});
