/**
 * The instructions subject's lease, crash recovery, failure receipt and
 * re-check request with its settle, against a stateful row store
 * (Decisions 31, 35, 48 and 54; Fizzy #2682). Each case here
 * is about what the SQL does to a row, so none of them can pass on call
 * shapes alone: the store evaluates every predicate of the fence, the
 * database clock included, and throws on any statement it cannot evaluate.
 * The SQL each function sends is pinned separately, by the protocol tests in
 * instruction-repository-sync-queries.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instructionSyncRowStore as store } from "./_helpers/instruction-sync-row-store";

vi.mock("../prisma/client", async () => {
	const { instructionSyncRowStore } = await import(
		"./_helpers/instruction-sync-row-store"
	);
	// The real tagged-template builders (`Prisma.sql` is `sqltag`), so the
	// store receives each statement exactly as Postgres would.
	const { join, sqltag } = await vi.importActual<
		typeof import("@prisma/client/runtime/client")
	>("@prisma/client/runtime/client");
	return {
		db: instructionSyncRowStore.root,
		Prisma: {
			PrismaClientKnownRequestError: class extends Error {},
			JsonNull: "JsonNull",
			join,
			sql: sqltag,
		},
	};
});
vi.mock("../prisma/queries/audit-log", async () => {
	const { instructionSyncRowStore } = await import(
		"./_helpers/instruction-sync-row-store"
	);
	return {
		recordAuditTx: (tx: unknown, entry: unknown) =>
			instructionSyncRowStore.recordAudit(tx, entry),
	};
});
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: vi.fn(),
}));

import {
	claimDueInstructionSyncRows,
	computeSchedulingPatch,
	instructionSyncBackoffMs,
	instructionSyncLeaseHeld,
	recordInstructionSyncCheckFailure,
	recordPendingInstructionSyncHead,
	settlePendingInstructionSyncHead,
	writeBackInstructionSync,
} from "../prisma/queries/instruction-repository-sync";
import type { ClaimedRepositorySyncRow } from "../prisma/queries/repository-sync-subjects";

const MIN = 60 * 1000;
const LEASE_MS = 2 * MIN;
const at = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00.000Z`);
const PATCH = { nextCheckAt: at("12:15") };

/** Task 4's claim activity: a two-minute lease, which the database dates. */
function claim(limit: number): Promise<ClaimedRepositorySyncRow[]> {
	return claimDueInstructionSyncRows(store.root, {
		limit,
		leaseMs: LEASE_MS,
	});
}

/** Whether the lease read finds the lease still held. */
async function held(row: ClaimedRepositorySyncRow): Promise<boolean> {
	return (await instructionSyncLeaseHeld(store.root, row)).held;
}

async function claimOne(): Promise<ClaimedRepositorySyncRow> {
	const [row] = await claim(1);
	if (!row) {
		throw new Error("expected a due row");
	}
	return row;
}

function receipt(row: ClaimedRepositorySyncRow) {
	return store.root.$transaction((tx) =>
		recordInstructionSyncCheckFailure(tx, {
			row,
			pollRunId: "poll_run_1",
			error: "REF_MISSING",
			pause: "REF_MISSING",
			now: store.now(),
		}),
	);
}

beforeEach(() => {
	store.reset();
	store.put({ id: "sync_1", nextCheckAt: at("11:50") });
});

describe("the lease fence on a stateful row store (Decisions 31, 48 and 54)", () => {
	it("holds while nothing moved the row, and the write lands with the database's time as updatedAt", async () => {
		const row = await claimOne();
		expect(row.leaseUntil).toEqual(at("12:02"));
		store.advance(MIN);

		expect(await held(row)).toBe(true);
		expect(await writeBackInstructionSync(store.root, row, PATCH)).toEqual({
			applied: true,
		});
		expect(store.row("sync_1")).toMatchObject({
			nextCheckAt: at("12:15"),
			updatedAt: at("12:01"),
		});
	});

	it.each([
		["behind", at("11:00")],
		["ahead of", at("13:00")],
	])(
		"dates the lease from the database's clock, with the worker's clock an hour %s it (Fizzy #2683)",
		async (_label, workerNow) => {
			vi.useFakeTimers({ now: workerNow });
			try {
				// The store's clock is T = 12:00; the worker's is an hour off.
				const row = await claimOne();
				expect(row.leaseUntil).toEqual(at("12:02"));
				expect(store.row("sync_1")?.nextCheckAt).toEqual(at("12:02"));
				// The fence judges it by the same clock: held until 12:02.
				store.advance(LEASE_MS - 1);
				expect(await held(row)).toBe(true);
				expect(
					await writeBackInstructionSync(store.root, row, PATCH),
				).toEqual({ applied: true });
			} finally {
				vi.useRealTimers();
			}
		},
	);

	/**
	 * The check's calibration, as `checkInstructionSyncRemoteHead` does it on
	 * the worker that runs the check: the offset from its own first lease
	 * read, added to that worker's clock for every schedule write
	 * (Fizzy #2683).
	 */
	async function calibrate(
		row: ClaimedRepositorySyncRow,
	): Promise<() => Date> {
		const lease = await instructionSyncLeaseHeld(store.root, row);
		expect(lease).toEqual({ held: true, dbNow: store.now() });
		const clockSkewMs = lease.dbNow.getTime() - Date.now();
		return () => new Date(Date.now() + clockSkewMs);
	}

	const WRITTEN_EFFECTS = [
		["a reschedule", { kind: "reschedule", delayMs: 2 * MIN }, 2 * MIN],
		// The claimed failure count is 1, so this backoff counts 2.
		["a backoff", { kind: "backoff" }, instructionSyncBackoffMs(2)],
		["a success", { kind: "success", commitSha: "c".repeat(40) }, 15 * MIN],
	] as const;

	/**
	 * The claiming worker's clock and the checking worker's, against the
	 * database's 12:00. Temporal gives the claim and the check no worker
	 * affinity, so the two can differ; the check's offset must be its own.
	 */
	describe.each([
		["both an hour behind the database", at("11:00"), at("11:00")],
		["both an hour ahead of the database", at("13:00"), at("13:00")],
		[
			"the claimer an hour ahead and the checker on the database's time",
			at("13:00"),
			at("12:00"),
		],
		[
			"the claimer an hour behind and the checker an hour ahead",
			at("11:00"),
			at("13:00"),
		],
	])("with %s (Fizzy #2683)", (_label, claimerNow, checkerNow) => {
		beforeEach(() => {
			vi.useFakeTimers({ now: claimerNow });
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it.each(WRITTEN_EFFECTS)(
			"dates %s on the database's clock, so the written check is ahead of it by exactly its delay",
			async (_effect, effect, delayMs) => {
				const row = await claimOne();
				// The check runs on another worker, with its own clock.
				vi.setSystemTime(checkerNow);
				const dbNow = await calibrate(row);
				// A minute of work, on both clocks.
				store.advance(MIN);
				vi.advanceTimersByTime(MIN);

				const patch = computeSchedulingPatch(effect, {
					now: dbNow(),
					failureCount: row.failureCount,
					generation: row.generation,
				});
				expect(
					await writeBackInstructionSync(store.root, row, patch),
				).toEqual({ applied: true });
				const written = store.row("sync_1")?.nextCheckAt;
				expect(written?.getTime()).toBe(
					store.now().getTime() + delayMs,
				);
				// Not due again until the delay has passed on the database's
				// clock: nothing re-claims it this poll.
				expect(await claim(1)).toEqual([]);
			},
		);
	});

	describe.each([
		["behind", at("11:00")],
		["ahead of", at("13:00")],
	])(
		"with the caller's clock an hour %s the database's (Fizzy #2683)",
		(_label, workerNow) => {
			beforeEach(() => {
				vi.useFakeTimers({ now: workerNow });
			});
			afterEach(() => {
				vi.useRealTimers();
			});

			it("makes a settled re-check due on the database's clock, not the caller's", async () => {
				store.putRun({
					id: "sync_1:run_open",
					syncId: "sync_1",
					projectId: "proj_1",
					organizationId: "org_1",
					generation: 3,
					finishedAt: at("12:00"),
				});
				store.update("sync_1", { nextCheckAt: at("12:15") });
				store.advance(MIN);
				const sync = {
					syncId: "sync_1",
					projectId: "proj_1",
					organizationId: "org_1",
					generation: 3,
				};
				await recordPendingInstructionSyncHead(store.root, {
					...sync,
					commitSha: "d".repeat(40),
				});
				expect(
					await settlePendingInstructionSyncHead(store.root, {
						...sync,
						runId: "run_open",
					}),
				).toEqual({ applied: true, settled: "made_due" });
				expect(store.row("sync_1")?.nextCheckAt).toEqual(at("12:01"));
			});
		},
	);

	it("a row with no schedule is never claimed, even when automatic and unpaused", async () => {
		// The state a pause leaves behind, or a pause that was cleared
		// without setting the row due: `nextCheckAt <= now` is never true
		// for NULL, so the claim's own predicate keeps it out.
		store.put({
			id: "sync_null",
			nextCheckAt: null,
			automaticPausedReason: null,
		});
		expect((await claim(10)).map((row) => row.id)).toEqual(["sync_1"]);
	});

	it("an expired lease with no competing writer applies nothing (Review Focus 3)", async () => {
		const row = await claimOne();
		store.advance(LEASE_MS - 1);
		expect(await held(row)).toBe(true);

		// Nothing else touched the row. Only the database's clock moved.
		store.advance(1);
		expect(await held(row)).toBe(false);
		expect(await writeBackInstructionSync(store.root, row, PATCH)).toEqual({
			applied: false,
		});
		expect(await receipt(row)).toEqual({ applied: false });
		expect(store.row("sync_1")).toMatchObject({
			nextCheckAt: at("12:02"),
			automaticPausedReason: null,
		});
		expect(store.runs()).toEqual([]);
		expect(store.audits()).toEqual([]);
	});

	/**
	 * The ways a check loses its row while its lease is still in time. Each
	 * case moves only the one fenced column its writer moves, so dropping
	 * that predicate from the fence fails exactly that case (Decision 31).
	 */
	const LOST_LEASES = [
		[
			"a run of the same generation completed and moved the clock",
			{ nextCheckAt: at("12:15"), failureCount: 0 },
		],
		[
			"the sync was paused after the claim",
			{
				automaticPausedReason: "PERMISSION_REVOKED",
				automaticPausedAt: at("12:01"),
			},
		],
		["automatic sync was turned off", { automatic: false }],
		["the generation moved (a re-configure)", { generation: 4 }],
	] as const;

	it.each(LOST_LEASES)(
		"applies nothing when %s (Review Focus 3)",
		async (_label, changes) => {
			const row = await claimOne();
			store.advance(MIN);
			store.update("sync_1", changes);
			const before = store.row("sync_1");

			expect(await held(row)).toBe(false);
			expect(
				await writeBackInstructionSync(store.root, row, PATCH),
			).toEqual({
				applied: false,
			});
			expect(store.row("sync_1")).toEqual(before);
		},
	);

	it("applies nothing when the row is gone (switched to upload mode)", async () => {
		const row = await claimOne();
		store.remove("sync_1");
		expect(await writeBackInstructionSync(store.root, row, PATCH)).toEqual({
			applied: false,
		});
	});

	it("a replaced claimant writes nothing, and the claim that replaced it writes", async () => {
		const first = await claimOne();
		// The first check stalled past its lease; a later tick re-claims the row.
		store.advance(3 * MIN);
		const second = await claimOne();
		expect(second.leaseUntil).toEqual(at("12:05"));

		expect(
			await writeBackInstructionSync(store.root, first, PATCH),
		).toEqual({
			applied: false,
		});
		expect(
			await writeBackInstructionSync(store.root, second, PATCH),
		).toEqual({
			applied: true,
		});
		expect(store.row("sync_1")?.nextCheckAt).toEqual(at("12:15"));
	});

	it("recovers a check that crashed after its claim: the row comes due when the lease ends, ahead of rows a finished check moved out, and only the new lease writes", async () => {
		// The check for this lease dies without writing anything.
		const crashed = await claimOne();
		// A row a finished check moved 15 minutes out.
		store.put({ id: "sync_2", nextCheckAt: at("12:15") });

		store.advance(LEASE_MS - 1);
		expect(await claim(4)).toEqual([]);

		store.advance(15 * MIN + 1);
		const again = await claim(4);
		expect(again.map((row) => row.id)).toEqual(["sync_1", "sync_2"]);
		const [recovered] = again;
		if (!recovered) {
			throw new Error("expected sync_1 to be re-claimed");
		}
		expect(
			await writeBackInstructionSync(store.root, crashed, PATCH),
		).toEqual({
			applied: false,
		});
		expect(
			await writeBackInstructionSync(store.root, recovered, PATCH),
		).toEqual({ applied: true });
	});
});

describe("the poll's failure receipt on a stateful row store (Decisions 35 and 54)", () => {
	it("commits the pause, the FAILED POLL run row and the completion audit together", async () => {
		const row = await claimOne();
		store.advance(MIN);

		expect(await receipt(row)).toEqual({ applied: true });
		expect(store.row("sync_1")).toMatchObject({
			automaticPausedReason: "REF_MISSING",
			automaticPausedAt: at("12:01"),
			// The claim's lease is gone: a paused row has no next check.
			nextCheckAt: null,
		});
		expect(store.runs()).toEqual([
			expect.objectContaining({
				id: "sync_1:poll_run_1:3",
				trigger: "POLL",
				status: "FAILED",
				error: "REF_MISSING",
			}),
		]);
		expect(store.audits()).toEqual([
			expect.objectContaining({
				action: "project.instructions.repository_sync_completed",
			}),
		]);
	});

	it("rolls back the pause and the run row when the audit write fails", async () => {
		const row = await claimOne();
		store.advance(MIN);
		store.failNextAuditWith(new Error("audit insert failed"));

		await expect(receipt(row)).rejects.toThrow("audit insert failed");
		expect(store.row("sync_1")).toMatchObject({
			automaticPausedReason: null,
			automaticPausedAt: null,
			nextCheckAt: at("12:02"),
		});
		expect(store.runs()).toEqual([]);
		expect(store.audits()).toEqual([]);
		// Nothing was left half written, and the lease still holds.
		expect(await held(row)).toBe(true);
	});

	it("writes nothing more when retried: the first receipt's pause ended the lease", async () => {
		const row = await claimOne();
		store.advance(MIN);

		expect(await receipt(row)).toEqual({ applied: true });
		expect(await receipt(row)).toEqual({ applied: false });
		expect(store.runs()).toHaveLength(1);
		expect(store.audits()).toHaveLength(1);
	});

	it("fails when the receipt is written on the root client inside the transaction, as a stray db would be", async () => {
		const row = await claimOne();
		await expect(
			store.root.$transaction(() =>
				recordInstructionSyncCheckFailure(store.root, {
					row,
					pollRunId: "poll_run_1",
					error: "REF_MISSING",
					pause: "REF_MISSING",
					now: store.now(),
				}),
			),
		).rejects.toThrow("db was used while a transaction was open");
		expect(store.row("sync_1")?.automaticPausedReason).toBeNull();
	});
});

describe("the pending head on a stateful row store (Fizzy #2682)", () => {
	const PUSHED = "d".repeat(40);
	const TARGET = {
		syncId: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		generation: 3,
	};

	function recordPending(overrides: Partial<typeof TARGET> = {}) {
		return recordPendingInstructionSyncHead(store.root, {
			...TARGET,
			...overrides,
			commitSha: PUSHED,
		});
	}

	it("never disturbs a held lease: only the marker moves, and the check's reschedule still lands", async () => {
		const row = await claimOne();
		store.advance(MIN);
		const before = store.row("sync_1");

		expect(await recordPending()).toEqual({ applied: true });
		expect(store.row("sync_1")).toEqual({
			...before,
			pendingCommitSha: PUSHED,
		});
		expect(await held(row)).toBe(true);
		expect(await writeBackInstructionSync(store.root, row, PATCH)).toEqual({
			applied: true,
		});
		expect(store.row("sync_1")).toMatchObject({
			nextCheckAt: at("12:15"),
			pendingCommitSha: PUSHED,
		});
	});

	it("needs no lease: it lands on a row whose lease has lapsed", async () => {
		const row = await claimOne();
		store.advance(LEASE_MS);
		expect(await held(row)).toBe(false);

		expect(await recordPending()).toEqual({ applied: true });
		expect(store.row("sync_1")).toMatchObject({
			nextCheckAt: at("12:02"),
			pendingCommitSha: PUSHED,
		});
	});

	it("keeps only the last head written, even when an older push is delivered after a newer one", async () => {
		expect(
			await recordPendingInstructionSyncHead(store.root, {
				...TARGET,
				commitSha: PUSHED,
			}),
		).toEqual({ applied: true });
		const older = "b".repeat(40);
		expect(
			await recordPendingInstructionSyncHead(store.root, {
				...TARGET,
				commitSha: older,
			}),
		).toEqual({ applied: true });
		// One slot, last write wins: the newer head is gone. This is why the
		// completion treats any marker as a re-check request and never
		// compares its SHA with the run's commit.
		expect(store.row("sync_1")?.pendingCommitSha).toBe(older);
	});

	it.each([
		["the generation moved (a re-configure)", { generation: 2 }],
		["the row is another organization's", { organizationId: "org_2" }],
		["the row is another project's", { projectId: "proj_2" }],
	] as const)("writes nothing when %s", async (_label, overrides) => {
		const before = store.row("sync_1");
		expect(await recordPending(overrides)).toEqual({ applied: false });
		expect(store.row("sync_1")).toEqual(before);
	});
});

describe("settling a re-check request against the open run's receipt, on a stateful row store (Fizzy #2682)", () => {
	const PUSHED = "d".repeat(40);
	const SYNC = {
		syncId: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		generation: 3,
	};

	/** The open run's receipt, as `begin` inserted it and, once finished, its completion left it. */
	function receipt(finishedAt: Date | null) {
		store.putRun({
			id: "sync_1:run_open",
			syncId: "sync_1",
			projectId: "proj_1",
			organizationId: "org_1",
			generation: 3,
			finishedAt,
		});
	}

	function writeMarker() {
		return recordPendingInstructionSyncHead(store.root, {
			...SYNC,
			commitSha: PUSHED,
		});
	}

	function settle() {
		// No `now`: the settle reads the database's clock under its lock.
		return settlePendingInstructionSyncHead(store.root, {
			...SYNC,
			runId: "run_open",
		});
	}

	it("writes nothing while the receipt is unfinished: that completion is still to come and will consume the marker", async () => {
		receipt(null);
		expect(await writeMarker()).toEqual({ applied: true });
		const before = store.row("sync_1");

		expect(await settle()).toEqual({
			applied: false,
			settled: "consumer_pending",
		});
		expect(store.row("sync_1")).toEqual(before);
		expect(store.row("sync_1")?.pendingCommitSha).toBe(PUSHED);
	});

	it("applies the marker itself when the completion committed before it, while the workflow was still closing: due now, marker cleared", async () => {
		// The completion committed at 12:00, found no marker and scheduled
		// 12:15; `already_running` was still the answer because the workflow
		// had not returned. The marker lands a minute later.
		store.update("sync_1", { nextCheckAt: at("12:15") });
		receipt(at("12:00"));
		store.advance(MIN);
		expect(await writeMarker()).toEqual({ applied: true });

		expect(await settle()).toEqual({ applied: true, settled: "made_due" });
		expect(store.row("sync_1")).toMatchObject({
			nextCheckAt: at("12:01"),
			pendingCommitSha: null,
		});
		// The next tick claims it rather than waiting for 12:15.
		expect((await claim(1)).map((row) => row.id)).toEqual(["sync_1"]);
	});

	it("keeps a paused row unscheduled when it applies the marker (Fizzy #2703)", async () => {
		store.update("sync_1", {
			automaticPausedReason: "REF_MISSING",
			automaticPausedAt: at("12:00"),
			nextCheckAt: null,
		});
		receipt(at("12:00"));
		expect(await writeMarker()).toEqual({ applied: true });

		expect(await settle()).toEqual({ applied: true, settled: "made_due" });
		expect(store.row("sync_1")).toMatchObject({
			nextCheckAt: null,
			pendingCommitSha: null,
		});
	});

	it("is stale, and writes nothing, once the generation moved", async () => {
		receipt(at("12:00"));
		expect(await writeMarker()).toEqual({ applied: true });
		store.update("sync_1", { generation: 4 });
		const before = store.row("sync_1");

		expect(await settle()).toEqual({ applied: false, settled: "stale" });
		expect(store.row("sync_1")).toEqual(before);
	});

	it("making the row due ends a check's held lease, so that check's reschedule applies nothing", async () => {
		const row = await claimOne();
		store.advance(MIN);
		receipt(at("12:00"));
		expect(await writeMarker()).toEqual({ applied: true });

		expect(await settle()).toEqual({ applied: true, settled: "made_due" });
		expect(await held(row)).toBe(false);
		expect(await writeBackInstructionSync(store.root, row, PATCH)).toEqual({
			applied: false,
		});
		expect(store.row("sync_1")?.nextCheckAt).toEqual(at("12:01"));
	});
});
