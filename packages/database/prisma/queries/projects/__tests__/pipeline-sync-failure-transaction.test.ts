/**
 * `recordPipelineSyncFailure`'s atomicity (card #2383, finding 2), and
 * `advancePipelineSyncState`'s matching lock (card #2383 follow-up review,
 * finding A) — see that function's doc comment in `pipeline-results.ts` for
 * why the success path needed the SAME advisory lock the failure path
 * already had.
 *
 * The read-then-upsert used to run as two separate statements, so two
 * overlapping writers for the SAME `(projectId, provider, pipelineKey)` could
 * both read the prior state and both compute `repeat === false` — producing
 * two transition-level `warn` logs for what is really one transition. The fix wraps the read + upsert in a
 * transaction guarded by a Postgres advisory lock keyed on that triple, so a
 * second writer for the same key blocks until the first commits and then sees
 * the FIRST writer's row (correctly computing `repeat: true`).
 *
 * Before the follow-up fix, `advancePipelineSyncState` (the SUCCESS path)
 * wrote the same row WITHOUT taking that lock, so a failing attempt and a
 * concurrent successful attempt for the same source did not serialize: an
 * older failure could clobber a newer success back to FAILED. It now takes
 * the identical lock, keyed the same way, and — when it also has to clear a
 * `clearFallbackKey` row (a second, different key) — acquires BOTH locks in
 * globally SORTED order so two concurrent `advancePipelineSyncState` calls
 * for two different sources can never lock the same pair of keys in opposite
 * order and deadlock.
 *
 * These are unit tests against a mocked Prisma client — the ordering and
 * transaction-wrapping assertions don't need a real Postgres connection to
 * prove the code takes the lock before it reads/writes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { advisoryObjectKey } from "../../lib/refresh-lock-key";

const { dbMock } = vi.hoisted(() => {
	const testPipelineSyncState = {
		findUnique: vi.fn(),
		upsert: vi.fn(),
		updateMany: vi.fn(),
	};
	return {
		dbMock: {
			testPipelineSyncState,
			$transaction: vi.fn(),
			$executeRaw: vi.fn(),
		},
	};
});

vi.mock("../../../client", () => ({ db: dbMock }));

import {
	advancePipelineSyncState,
	recordPipelineSyncFailure,
} from "../pipeline-results";

const baseInput = {
	projectId: "p1",
	organizationId: null,
	userId: "u1",
	provider: "github-actions",
	pipelineKey: "acme/store",
	error: "GitHub rejected the credential.",
	errorDetail: null,
	kind: "CREDENTIAL_REJECTED",
	failedAt: new Date("2026-08-17T00:00:00Z"),
	attemptStartedAt: new Date("2026-08-17T00:00:00Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	// Mirrors report-schedule-queries.test.ts's pattern: invoke the transaction
	// callback with the SAME mocked db object standing in for `tx`, since
	// `$executeRaw` and `testPipelineSyncState` live at the same level on both.
	dbMock.$transaction.mockImplementation(
		async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock),
	);
	dbMock.testPipelineSyncState.upsert.mockResolvedValue({});
});

describe("recordPipelineSyncFailure — atomicity", () => {
	it("wraps the read + upsert in a transaction with an explicit timeout", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);

		await recordPipelineSyncFailure(baseInput);

		expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
		const [, options] = dbMock.$transaction.mock.calls[0];
		expect(options).toMatchObject({
			timeout: expect.any(Number),
			maxWait: expect.any(Number),
		});
	});

	it("acquires the advisory lock BEFORE reading the prior state", async () => {
		const callOrder: string[] = [];
		dbMock.$executeRaw.mockImplementation(() => {
			callOrder.push("lock");
			return Promise.resolve();
		});
		dbMock.testPipelineSyncState.findUnique.mockImplementation(() => {
			callOrder.push("read");
			return Promise.resolve(null);
		});
		dbMock.testPipelineSyncState.upsert.mockImplementation(() => {
			callOrder.push("write");
			return Promise.resolve({});
		});

		await recordPipelineSyncFailure(baseInput);

		expect(callOrder).toEqual(["lock", "read", "write"]);
	});

	it("locks with pg_advisory_xact_lock, not a plain query (void return can't deserialize via $queryRaw)", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);

		await recordPipelineSyncFailure(baseInput);

		expect(dbMock.$executeRaw).toHaveBeenCalledTimes(1);
		const [strings] = dbMock.$executeRaw.mock.calls[0];
		expect(strings.join("")).toContain("pg_advisory_xact_lock");
	});

	it("hashes the SAME lock key for the SAME (project, provider, pipelineKey), a DIFFERENT key otherwise", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);

		await recordPipelineSyncFailure(baseInput);
		const firstArgs = dbMock.$executeRaw.mock.calls[0];

		vi.clearAllMocks();
		dbMock.$transaction.mockImplementation(
			async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock),
		);
		dbMock.testPipelineSyncState.upsert.mockResolvedValue({});
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);

		// Same triple → same hashed lock id.
		await recordPipelineSyncFailure({ ...baseInput });
		expect(dbMock.$executeRaw.mock.calls[0]).toEqual(firstArgs);

		vi.clearAllMocks();
		dbMock.$transaction.mockImplementation(
			async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock),
		);
		dbMock.testPipelineSyncState.upsert.mockResolvedValue({});
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);

		// Different pipelineKey → different hashed lock id.
		await recordPipelineSyncFailure({
			...baseInput,
			pipelineKey: "acme/other-repo",
		});
		expect(dbMock.$executeRaw.mock.calls[0]).not.toEqual(firstArgs);
	});
});

describe("recordPipelineSyncFailure — repeat detection", () => {
	it("returns repeat: false when there is no prior row", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);

		const { repeat } = await recordPipelineSyncFailure(baseInput);

		expect(repeat).toBe(false);
	});

	it("returns repeat: true when the prior row is FAILED with the SAME kind", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			status: "FAILED",
			lastErrorKind: "CREDENTIAL_REJECTED",
		});

		const { repeat } = await recordPipelineSyncFailure(baseInput);

		expect(repeat).toBe(true);
	});

	it("returns repeat: false when the prior row is FAILED with a DIFFERENT kind", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			status: "FAILED",
			lastErrorKind: "PERMISSION_MISSING",
		});

		const { repeat } = await recordPipelineSyncFailure(baseInput);

		expect(repeat).toBe(false);
	});

	it("returns repeat: false when the prior row is SUCCESS (a source that recovered then failed again)", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			status: "SUCCESS",
			lastErrorKind: "CREDENTIAL_REJECTED",
		});

		const { repeat } = await recordPipelineSyncFailure(baseInput);

		expect(repeat).toBe(false);
	});

	it("upserts the new error/errorDetail/kind regardless of repeat status", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			status: "FAILED",
			lastErrorKind: "CREDENTIAL_REJECTED",
		});

		await recordPipelineSyncFailure({
			...baseInput,
			error: "GitHub rejected the credential (retry 2).",
			errorDetail: "raw body",
		});

		expect(dbMock.testPipelineSyncState.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({
					status: "FAILED",
					lastError: "GitHub rejected the credential (retry 2).",
					lastErrorDetail: "raw body",
					lastErrorKind: "CREDENTIAL_REJECTED",
				}),
			}),
		);
	});
});

const baseAdvanceInput = {
	projectId: "p1",
	organizationId: null,
	userId: "u1",
	provider: "github-actions",
	fetchedAt: new Date("2026-08-17T00:00:00Z"),
	attemptStartedAt: new Date("2026-08-17T00:00:00Z"),
};

describe("advancePipelineSyncState — advisory lock (finding A)", () => {
	beforeEach(() => {
		dbMock.testPipelineSyncState.updateMany.mockResolvedValue({ count: 0 });
		// No prior attempt stamp — the monotonic guard lets the write through.
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);
	});

	it("wraps the read/clear/upsert in a transaction with an explicit timeout", async () => {
		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
		});

		expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
		const [, options] = dbMock.$transaction.mock.calls[0];
		expect(options).toMatchObject({
			timeout: expect.any(Number),
			maxWait: expect.any(Number),
		});
	});

	it("acquires the advisory lock BEFORE reading the prior attempt stamp and writing", async () => {
		const callOrder: string[] = [];
		dbMock.$executeRaw.mockImplementation(() => {
			callOrder.push("lock");
			return Promise.resolve();
		});
		dbMock.testPipelineSyncState.findUnique.mockImplementation(() => {
			callOrder.push("read");
			return Promise.resolve(null);
		});
		dbMock.testPipelineSyncState.upsert.mockImplementation(() => {
			callOrder.push("upsert");
			return Promise.resolve({});
		});

		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
		});

		// The compare and the write are inside the SAME held lock — that is
		// what makes the monotonic guard atomic without a second mechanism.
		expect(callOrder).toEqual(["lock", "read", "upsert"]);
	});

	it("hashes the SAME lock key `recordPipelineSyncFailure` would use for the identical triple", async () => {
		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
		});
		const advanceLockCall = dbMock.$executeRaw.mock.calls[0];

		vi.clearAllMocks();
		dbMock.$transaction.mockImplementation(
			async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock),
		);
		dbMock.testPipelineSyncState.upsert.mockResolvedValue({});
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);

		await recordPipelineSyncFailure(baseInput); // same projectId/provider/pipelineKey
		const failureLockCall = dbMock.$executeRaw.mock.calls[0];

		expect(advanceLockCall).toEqual(failureLockCall);
	});

	it("takes only ONE lock when there is no clearFallbackKey", async () => {
		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
		});

		expect(dbMock.$executeRaw).toHaveBeenCalledTimes(1);
		expect(dbMock.testPipelineSyncState.updateMany).not.toHaveBeenCalled();
	});

	it("takes only ONE lock when clearFallbackKey equals the pipelineKey (nothing to clear)", async () => {
		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
			clearFallbackKey: "acme/store",
		});

		expect(dbMock.$executeRaw).toHaveBeenCalledTimes(1);
		expect(dbMock.testPipelineSyncState.updateMany).not.toHaveBeenCalled();
	});

	it("takes BOTH locks — for the success key and the DIFFERENT clearFallbackKey — when clearing a fallback row", async () => {
		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
			clearFallbackKey: "acme/fallback-store",
		});

		expect(dbMock.$executeRaw).toHaveBeenCalledTimes(2);
		expect(dbMock.testPipelineSyncState.updateMany).toHaveBeenCalledTimes(
			1,
		);
	});

	it("acquires two-key locks in globally SORTED order, regardless of which argument is the fallback (deadlock-ordering guard)", async () => {
		// pipelineKey < clearFallbackKey alphabetically.
		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "alpha",
			clearFallbackKey: "beta",
		});
		const firstOrderIds = dbMock.$executeRaw.mock.calls.map(
			(call) => call[2],
		);

		vi.clearAllMocks();
		dbMock.$transaction.mockImplementation(
			async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock),
		);
		dbMock.testPipelineSyncState.upsert.mockResolvedValue({});
		dbMock.testPipelineSyncState.updateMany.mockResolvedValue({ count: 0 });

		// pipelineKey > clearFallbackKey alphabetically — the OPPOSITE argument
		// order. If locks were acquired "pipelineKey first, then fallback" (call
		// order) rather than sorted by value, this would lock in the reverse
		// relative order to the first call, which is exactly the AB/BA shape
		// that deadlocks two concurrent callers.
		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "zulu",
			clearFallbackKey: "alpha",
		});
		const secondOrderIds = dbMock.$executeRaw.mock.calls.map(
			(call) => call[2],
		);

		const alphaId = advisoryObjectKey("p1:github-actions:alpha");
		const betaId = advisoryObjectKey("p1:github-actions:beta");
		const zuluId = advisoryObjectKey("p1:github-actions:zulu");

		expect(firstOrderIds).toEqual([alphaId, betaId]);
		expect(secondOrderIds).toEqual([alphaId, zuluId]);
	});

	it("still clears the fallback row's FAILED status to SUPERSEDED", async () => {
		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
			clearFallbackKey: "acme/fallback-store",
			lastRunExternalId: "42",
		});

		expect(dbMock.testPipelineSyncState.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					pipelineKey: "acme/fallback-store",
					status: "FAILED",
				}),
				data: expect.objectContaining({ status: "SUPERSEDED" }),
			}),
		);
	});
});

// ----------------------------------------------------------------------------
// Monotonic attempt guard
//
// The advisory lock serializes the two writers but establishes no order BETWEEN
// ATTEMPTS. The sync activity runs with `heartbeatTimeout: 30 seconds` and
// `maximumAttempts: 3`, and Temporal does not kill a heartbeat-timed-out
// attempt — it starts another while the first is still hung in an HTTP call. So
// an older attempt can wake up and commit FAILED on top of a newer attempt's
// SUCCESS. `lastAttemptStartedAt` is the ordering token that stops it.
// ----------------------------------------------------------------------------

describe("recordPipelineSyncFailure — monotonic guard", () => {
	it("skips the write when the stored attempt is NEWER", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			status: "SUCCESS",
			lastErrorKind: null,
			lastAttemptStartedAt: new Date("2026-08-17T00:05:00Z"),
		});

		const result = await recordPipelineSyncFailure(baseInput);

		expect(result).toEqual({ repeat: false, applied: false });
		expect(dbMock.testPipelineSyncState.upsert).not.toHaveBeenCalled();
	});

	it("writes when the stored attempt is OLDER", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			status: "SUCCESS",
			lastErrorKind: null,
			lastAttemptStartedAt: new Date("2026-08-16T23:55:00Z"),
		});

		const result = await recordPipelineSyncFailure(baseInput);

		expect(result).toEqual({ repeat: false, applied: true });
		expect(dbMock.testPipelineSyncState.upsert).toHaveBeenCalledTimes(1);
	});

	it("writes on an EQUAL stamp — the same attempt must be able to update its own row", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			status: "FAILED",
			lastErrorKind: "CREDENTIAL_REJECTED",
			lastAttemptStartedAt: baseInput.attemptStartedAt,
		});

		const result = await recordPipelineSyncFailure(baseInput);

		expect(result).toEqual({ repeat: true, applied: true });
		expect(dbMock.testPipelineSyncState.upsert).toHaveBeenCalledTimes(1);
	});

	it("writes when the stored stamp is NULL — a pre-existing row has no attempt identity", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			status: "FAILED",
			lastErrorKind: "CREDENTIAL_REJECTED",
			lastAttemptStartedAt: null,
		});

		const result = await recordPipelineSyncFailure(baseInput);

		expect(result.applied).toBe(true);
		expect(dbMock.testPipelineSyncState.upsert).toHaveBeenCalledTimes(1);
	});

	it("persists the attempt stamp so the NEXT writer can order against it", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);

		await recordPipelineSyncFailure(baseInput);

		expect(dbMock.testPipelineSyncState.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					lastAttemptStartedAt: baseInput.attemptStartedAt,
				}),
				update: expect.objectContaining({
					lastAttemptStartedAt: baseInput.attemptStartedAt,
				}),
			}),
		);
	});

	it("still reports `repeat` honestly when the write is dropped", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			status: "FAILED",
			lastErrorKind: "CREDENTIAL_REJECTED",
			lastAttemptStartedAt: new Date("2026-08-17T00:05:00Z"),
		});

		const result = await recordPipelineSyncFailure(baseInput);

		expect(result).toEqual({ repeat: true, applied: false });
	});
});

describe("advancePipelineSyncState — monotonic guard", () => {
	beforeEach(() => {
		dbMock.testPipelineSyncState.updateMany.mockResolvedValue({ count: 0 });
	});

	it("skips the SUCCESS write when the stored attempt is NEWER", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			lastAttemptStartedAt: new Date("2026-08-17T00:05:00Z"),
		});

		const result = await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
		});

		expect(result).toBeNull();
		expect(dbMock.testPipelineSyncState.upsert).not.toHaveBeenCalled();
	});

	it("writes when the stored attempt is OLDER, and stamps this attempt", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue({
			lastAttemptStartedAt: new Date("2026-08-16T23:55:00Z"),
		});

		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
		});

		expect(dbMock.testPipelineSyncState.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				update: expect.objectContaining({
					status: "SUCCESS",
					lastAttemptStartedAt: baseAdvanceInput.attemptStartedAt,
				}),
			}),
		);
	});

	it("guards the fallback-key clear with the same rule, in one atomic statement", async () => {
		dbMock.testPipelineSyncState.findUnique.mockResolvedValue(null);

		await advancePipelineSyncState({
			...baseAdvanceInput,
			pipelineKey: "acme/store",
			clearFallbackKey: "acme/fallback-store",
		});

		expect(dbMock.testPipelineSyncState.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: "FAILED",
					OR: [
						{ lastAttemptStartedAt: null },
						{
							lastAttemptStartedAt: {
								lte: baseAdvanceInput.attemptStartedAt,
							},
						},
					],
				}),
			}),
		);
	});
});
