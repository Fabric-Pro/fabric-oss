/**
 * Unit tests for `recordPmSyncLog`.
 *
 * Covers the three contracts that make the write helper safe to slot into the
 * sync outcome boundaries (T4):
 *
 *  A. Non-fatal contract — a thrown DB error from `createPmSyncLog` is caught
 *     and logged; the helper resolves normally (never rethrows), so the
 *     caller's sync result is unaffected.
 *  B. Context resolution — `batchId`/`correlationId` equal the Temporal
 *     `runId`, read exactly once; both fall back to `null` when
 *     `activityInfo()` throws (no activity context / unit-test path).
 *  C. No SKIP — `status` is typed to SUCCESS|FAILURE|CONFLICT only; every
 *     valid status produces exactly one write, and there is no path that
 *     writes for a skipped / nothing-to-do outcome (D4).
 *
 * `createPmSyncLog` (`@repo/database`) and `activityInfo`
 * (`@temporalio/activity`) are mocked so the test stays self-contained.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/record-pm-sync-log.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordPmSyncLogInput } from "../record-pm-sync-log";

const mocks = vi.hoisted(() => ({
	createPmSyncLogMock: vi.fn(),
	activityInfoMock: vi.fn(),
	loggerWarnMock: vi.fn(),
	loggerErrorMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createPmSyncLog: (...args: unknown[]) => mocks.createPmSyncLogMock(...args),
}));

vi.mock("@temporalio/activity", () => ({
	activityInfo: (...args: unknown[]) => mocks.activityInfoMock(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: mocks.loggerWarnMock,
		error: mocks.loggerErrorMock,
		log: vi.fn(),
	},
}));

// Import AFTER the mocks so the helper captures them.
import { recordPmSyncLog } from "../record-pm-sync-log";

const RUN_ID = "run-1234-abcd";

/** A minimal org-context SUCCESS push input the helper accepts. */
function baseInput(
	overrides: Partial<RecordPmSyncLogInput> = {},
): RecordPmSyncLogInput {
	return {
		direction: "push",
		entityType: "FEATURE",
		entityId: "feat-1",
		title: "Checkout flow refactor",
		pmTool: "azure-devops",
		status: "SUCCESS",
		organizationId: "org-1",
		projectId: "proj-1",
		actorUserId: "user-1",
		externalId: "AB#42",
		externalUrl: "https://dev.azure.com/work/42",
		...overrides,
	} as RecordPmSyncLogInput;
}

beforeEach(() => {
	mocks.createPmSyncLogMock.mockReset();
	mocks.activityInfoMock.mockReset();
	mocks.loggerWarnMock.mockReset();
	mocks.loggerErrorMock.mockReset();
	// Default: inside an activity with a known runId.
	mocks.activityInfoMock.mockReturnValue({
		workflowExecution: { runId: RUN_ID },
	});
	mocks.createPmSyncLogMock.mockResolvedValue({ id: "log-1" });
});

describe("recordPmSyncLog — emits one row", () => {
	it("delegates exactly one createPmSyncLog call per invocation", async () => {
		await recordPmSyncLog(baseInput());
		expect(mocks.createPmSyncLogMock).toHaveBeenCalledTimes(1);
	});

	it("passes the caller fields straight through to the insert", async () => {
		await recordPmSyncLog(baseInput());
		expect(mocks.createPmSyncLogMock).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "push",
				entityType: "FEATURE",
				entityId: "feat-1",
				title: "Checkout flow refactor",
				pmTool: "azure-devops",
				status: "SUCCESS",
				organizationId: "org-1",
				projectId: "proj-1",
				actorUserId: "user-1",
				externalId: "AB#42",
				externalUrl: "https://dev.azure.com/work/42",
			}),
		);
	});

	it("returns void (callers do not branch on the write result)", async () => {
		await expect(recordPmSyncLog(baseInput())).resolves.toBeUndefined();
	});
});

describe("A — non-fatal contract", () => {
	it("catches a thrown DB error, logs it, and resolves normally", async () => {
		mocks.createPmSyncLogMock.mockRejectedValue(new Error("db is down"));

		// The promise must RESOLVE (not reject) — the caller's sync path is
		// never broken by a log-write failure.
		await expect(recordPmSyncLog(baseInput())).resolves.toBeUndefined();
	});

	it("logs the failure with the pm.sync.log.write_failed tag", async () => {
		mocks.createPmSyncLogMock.mockRejectedValue(new Error("db is down"));

		await recordPmSyncLog(baseInput());

		// The failure is observed, not silently swallowed.
		expect(mocks.loggerWarnMock).toHaveBeenCalledTimes(1);
		expect(mocks.loggerWarnMock).toHaveBeenCalledWith(
			"pm.sync.log.write_failed",
			expect.objectContaining({
				entityType: "FEATURE",
				entityId: "feat-1",
				status: "SUCCESS",
				error: "db is down",
			}),
		);
	});

	it("does not log a failure on the happy path", async () => {
		await recordPmSyncLog(baseInput());
		expect(mocks.loggerWarnMock).not.toHaveBeenCalled();
	});
});

describe("B — Temporal context resolution", () => {
	it("derives batchId and correlationId from the runId, read once", async () => {
		await recordPmSyncLog(baseInput());

		// Both fields derive from a SINGLE runId read.
		expect(mocks.activityInfoMock).toHaveBeenCalledTimes(1);
		expect(mocks.createPmSyncLogMock).toHaveBeenCalledWith(
			expect.objectContaining({
				batchId: RUN_ID,
				correlationId: RUN_ID,
			}),
		);
	});

	it("falls back to null for both when activityInfo() throws", async () => {
		mocks.activityInfoMock.mockImplementation(() => {
			throw new Error("not in an activity context");
		});

		await recordPmSyncLog(baseInput());

		expect(mocks.createPmSyncLogMock).toHaveBeenCalledWith(
			expect.objectContaining({
				batchId: null,
				correlationId: null,
			}),
		);
	});
});

describe("C — no SKIP path", () => {
	it("writes one row for each of SUCCESS / FAILURE / CONFLICT", async () => {
		const statuses: RecordPmSyncLogInput["status"][] = [
			"SUCCESS",
			"FAILURE",
			"CONFLICT",
		];

		for (const status of statuses) {
			mocks.createPmSyncLogMock.mockClear();
			await recordPmSyncLog(baseInput({ status }));
			expect(mocks.createPmSyncLogMock).toHaveBeenCalledTimes(1);
			expect(mocks.createPmSyncLogMock).toHaveBeenCalledWith(
				expect.objectContaining({ status }),
			);
		}
	});

	it("does not accept a SKIP status (compile-time union excludes it)", async () => {
		// @ts-expect-error — SKIP is not a member of PmSyncLogStatus; there is
		// no skipped / nothing-to-do code path (D4). If this stops erroring, a
		// SKIP value leaked into the status union.
		await recordPmSyncLog(baseInput({ status: "SKIP" }));
		// The call itself still runs at runtime (TS-only guard); the assertion
		// that matters is the compile-time @ts-expect-error above. This also
		// pins the spec decision (D4) that the helper has NO runtime status
		// gate — the type union is the only gate. If a future change adds a
		// defensive runtime check that short-circuits on SKIP, this assertion
		// will fail, which is intentional: the spec has no SKIP write path.
		expect(mocks.createPmSyncLogMock).toHaveBeenCalled();
	});
});

describe("entityType is constrained to EPIC | FEATURE | STORY", () => {
	it("accepts EPIC, FEATURE, and STORY", async () => {
		for (const entityType of ["EPIC", "FEATURE", "STORY"] as const) {
			mocks.createPmSyncLogMock.mockClear();
			await recordPmSyncLog(baseInput({ entityType }));
			expect(mocks.createPmSyncLogMock).toHaveBeenCalledWith(
				expect.objectContaining({ entityType }),
			);
		}
	});

	it("rejects TASK at the type level", async () => {
		// @ts-expect-error — there is no TASK entityType anywhere.
		await recordPmSyncLog(baseInput({ entityType: "TASK" }));
		expect(mocks.createPmSyncLogMock).toHaveBeenCalled();
	});
});
