/**
 * The Coding Instructions lifecycle reaper (Fizzy #2550).
 *
 * Two failures it exists to end, both of them silent and both unbounded:
 * an upload whose dialog was closed before `finalize` stays RECEIVING forever
 * (nothing else ever moves it, the tab polls it for every viewer, and its
 * staged objects are referenced by a row that will never reach a verdict), and
 * the retention prune only ever ran at the END of a SUCCESSFUL validation
 * workflow, so repeated failures accumulated staged copies with nothing
 * collecting them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listAbandoned: vi.fn(),
	listPendingAbandoned: vi.fn(),
	listStaleValidating: vi.fn(),
	failStaleValidating: vi.fn(),
	rejectAbandoned: vi.fn(),
	markSwept: vi.fn(),
	rotateAbandoned: vi.fn(),
	listProjectsWithPrunable: vi.fn(),
	listPrunable: vi.fn(),
	deleteSnapshot: vi.fn(),
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
	describe: vi.fn(),
	getHandle: vi.fn(),
	getTemporalClient: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listAbandonedReceivingInstructionSnapshots: (...a: unknown[]) =>
		mocks.listAbandoned(...a),
	listPendingAbandonedInstructionSnapshots: (...a: unknown[]) =>
		mocks.listPendingAbandoned(...a),
	listStaleValidatingInstructionSnapshots: (...a: unknown[]) =>
		mocks.listStaleValidating(...a),
	failStaleValidatingInstructionSnapshot: (...a: unknown[]) =>
		mocks.failStaleValidating(...a),
	rejectAbandonedInstructionSnapshot: (...a: unknown[]) =>
		mocks.rejectAbandoned(...a),
	markAbandonedInstructionSnapshotSwept: (...a: unknown[]) =>
		mocks.markSwept(...a),
	rotateAbandonedInstructionSnapshot: (...a: unknown[]) =>
		mocks.rotateAbandoned(...a),
	listProjectsWithPrunableInstructionSnapshots: (...a: unknown[]) =>
		mocks.listProjectsWithPrunable(...a),
	listPrunableInstructionSnapshots: (...a: unknown[]) =>
		mocks.listPrunable(...a),
	deleteInstructionSnapshot: (...a: unknown[]) => mocks.deleteSnapshot(...a),
}));

// The liveness guard. `finalize` starts the validation workflow BEFORE it
// writes VALIDATING and tolerates losing that write, so phase 1 asks Temporal
// whether an execution exists for the snapshot's deterministic id before it
// rejects a RECEIVING row.
vi.mock("../../client", () => ({
	getTemporalClient: (...a: unknown[]) => mocks.getTemporalClient(...a),
}));

/** The error name the SDK raises for an id Temporal has never heard of. */
class WorkflowNotFoundError extends Error {
	override name = "WorkflowNotFoundError";
}

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		listObjects: (...a: unknown[]) => mocks.listObjects(...a),
		deleteObjects: (...a: unknown[]) => mocks.deleteObjects(...a),
	}),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		log: vi.fn(),
	},
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

// Imported AFTER the mocks so the activity captures them.
import {
	RECEIVING_ABANDON_AFTER_MS,
	VALIDATING_STALE_AFTER_MS,
} from "@repo/instructions";
import { reapInstructionSnapshots } from "../project-instructions-reaper";

/** One abandoned candidate row, as the query returns it. */
function abandonedRow(id: string, projectId = "p1", organizationId = "o1") {
	return {
		id,
		projectId,
		organizationId,
		createdAt: new Date(Date.now() - RECEIVING_ABANDON_AFTER_MS - 1_000),
	};
}

type PruneCandidate = { projectId: string; organizationId: string };

/**
 * Serves a STABLE candidate population through the candidate query the way
 * Postgres does: one canonical order, `OFFSET`/`LIMIT` over it, and the size
 * of the whole population on every page.
 *
 * The query is one `UNION`ed relation now, so the reaper sees exactly this —
 * a window of one ordering, not two independently-skipped lists.
 */
function servePrunePopulation(population: PruneCandidate[]): void {
	mocks.listProjectsWithPrunable.mockImplementation(
		async (_keep: unknown, limit: number, offset: number) => ({
			candidates: population.slice(offset, offset + limit),
			total: population.length,
		}),
	);
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.listAbandoned.mockResolvedValue([]);
	mocks.listPendingAbandoned.mockResolvedValue([]);
	mocks.listStaleValidating.mockResolvedValue([]);
	mocks.failStaleValidating.mockResolvedValue({ changed: true });
	mocks.rejectAbandoned.mockResolvedValue({ changed: true });
	mocks.markSwept.mockResolvedValue({ changed: true });
	mocks.rotateAbandoned.mockResolvedValue({ rotated: true });
	mocks.listProjectsWithPrunable.mockResolvedValue({
		candidates: [],
		total: 0,
	});
	mocks.listPrunable.mockResolvedValue([]);
	mocks.deleteSnapshot.mockResolvedValue({ deleted: true });
	mocks.listObjects.mockResolvedValue({ objects: [] });
	mocks.deleteObjects.mockImplementation((keys: string[]) =>
		Promise.resolve({ deleted: keys.length, errors: [] }),
	);
	// The default is "Temporal has never heard of this id", which is the only
	// answer that lets a RECEIVING row be closed out.
	mocks.describe.mockRejectedValue(new WorkflowNotFoundError("not found"));
	mocks.getHandle.mockImplementation(() => ({ describe: mocks.describe }));
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { getHandle: mocks.getHandle },
	});
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * One stale VALIDATING candidate, as phase 0's query returns it.
 *
 * `updatedAt` is part of the row for a reason (round 8, finding 1): it is the
 * version the sweep inspected, and the heal writes it back into its own WHERE
 * clause so a row that moved on since cannot be overwritten.
 */
function validatingRow(
	id: string,
	projectId = "p1",
	organizationId = "o1",
	updatedAt = new Date("2026-09-17T10:00:00.000Z"),
) {
	return { id, projectId, organizationId, updatedAt };
}

/**
 * PHASE 0 (round 7, finding 1). A row stranded in VALIDATING with no
 * execution behind it.
 *
 * VALIDATING normally means a workflow owns the row and writes its verdict
 * either way. `finalize` starts that workflow BEFORE it writes VALIDATING,
 * though, so a status write slow enough to land after the run has already
 * exhausted its retries and closed leaves the row VALIDATING with nothing
 * behind it: the boundary catch's FAILED marker ran while the row still said
 * FAILED and matched nothing, and the delayed write then landed on top. A
 * worker that dies between the gate's claim and the boundary catch leaves the
 * same shape.
 *
 * This phase HEALS that; it does not prevent it. Prevention needs an
 * ownership token on the row, which is a schema change and a follow-up. What
 * matters here is that the row stops polling forever with no "Try again"
 * offered, and that the heal is decided on the EXECUTION rather than on age
 * alone — a running workflow is exactly why a row is legitimately VALIDATING.
 */
describe("reapInstructionSnapshots: stranded VALIDATING rows", () => {
	it("asks for candidates older than the shared staleness threshold", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));

		await reapInstructionSnapshots();

		const [cutoff, limit] = mocks.listStaleValidating.mock.calls[0]!;
		// The constant is shared with the tab's polling decision, so the two
		// cannot disagree about which rows are still alive.
		expect((cutoff as Date).getTime()).toBe(
			Date.now() - VALIDATING_STALE_AFTER_MS,
		);
		expect(limit).toBe(100);
	});

	it("fails a stale row whose execution has CLOSED, bound to the row's own tenant", async () => {
		mocks.listStaleValidating.mockResolvedValue([
			validatingRow(
				"snap_strand",
				"p7",
				"o7",
				new Date("2026-09-17T09:00:00.000Z"),
			),
		]);
		mocks.describe.mockResolvedValue({ status: { name: "FAILED" } });

		const result = await reapInstructionSnapshots();

		expect(mocks.getHandle).toHaveBeenCalledWith(
			"project-instruction-snapshot-snap_strand",
		);
		// The dedicated phase-0 transition, with the tenant that came off the
		// row rather than off a request — and with the row version this run
		// described, so a generation that started after the describe cannot be
		// matched by this write.
		expect(mocks.failStaleValidating).toHaveBeenCalledWith({
			snapshotId: "snap_strand",
			projectId: "p7",
			organizationId: "o7",
			observedUpdatedAt: new Date("2026-09-17T09:00:00.000Z"),
		});
		// NO storage work: a FAILED row keeps its staging objects so that
		// "Try again" has something to re-run over.
		expect(mocks.listObjects).not.toHaveBeenCalled();
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			staleValidating: 1,
			healedValidating: 1,
			skippedLive: 0,
			errorCount: 0,
		});
	});

	it("fails a stale row Temporal has never heard of", async () => {
		// The start was lost outright, so nothing was ever going to write a
		// verdict for this row.
		mocks.listStaleValidating.mockResolvedValue([
			validatingRow("snap_absent"),
		]);
		mocks.describe.mockRejectedValue(
			new WorkflowNotFoundError("not found"),
		);

		expect(await reapInstructionSnapshots()).toMatchObject({
			healedValidating: 1,
			errorCount: 0,
		});
		expect(mocks.failStaleValidating).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: "snap_absent" }),
		);
	});

	it("leaves a row whose execution is still RUNNING strictly alone", async () => {
		// The whole reason a row is legitimately VALIDATING. Writing FAILED
		// here would kill a live validation.
		mocks.listStaleValidating.mockResolvedValue([
			validatingRow("snap_live"),
		]);
		mocks.describe.mockResolvedValue({ status: { name: "RUNNING" } });

		expect(await reapInstructionSnapshots()).toMatchObject({
			staleValidating: 1,
			healedValidating: 0,
			skippedLive: 1,
			errorCount: 0,
		});
		expect(mocks.failStaleValidating).not.toHaveBeenCalled();
	});

	it("counts a describe failure as an error for that row and carries on", async () => {
		// An unreachable Temporal proves nothing, and a wrongly-failed row is
		// a validation killed mid-flight. Err toward live, count it so the
		// outage is visible, and let the next run decide.
		mocks.listStaleValidating.mockResolvedValue([
			validatingRow("snap_unknown"),
			validatingRow("snap_dead", "p2", "o2"),
		]);
		mocks.describe
			.mockRejectedValueOnce(new Error("connection refused"))
			.mockRejectedValueOnce(new WorkflowNotFoundError("not found"));

		const result = await reapInstructionSnapshots();

		expect(mocks.failStaleValidating).toHaveBeenCalledTimes(1);
		expect(mocks.failStaleValidating).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: "snap_dead" }),
		);
		expect(result).toMatchObject({
			staleValidating: 2,
			healedValidating: 1,
			errorCount: 1,
		});
	});

	it("does not count a row the compare-and-set did not move", async () => {
		// A real verdict landed between the candidate query and the write:
		// the predicate matches nothing, and nothing was healed.
		mocks.listStaleValidating.mockResolvedValue([
			validatingRow("snap_raced"),
		]);
		mocks.failStaleValidating.mockResolvedValue({ changed: false });

		expect(await reapInstructionSnapshots()).toMatchObject({
			staleValidating: 1,
			healedValidating: 0,
		});
	});

	// Round 8, finding 1. `describe` and the write are two operations, so a
	// newer generation can begin in between: `finalize` starting a fresh
	// execution, or a "Try again" after an overlapping reaper attempt already
	// wrote FAILED. The database refuses that write because the row's
	// `updatedAt` no longer matches the version phase 0 described, and the
	// reaper's whole response to `changed: false` must be to move on — no
	// re-read, no second write, no storage work, and nothing counted.
	it("leaves a candidate alone when the compare-and-set loses to a newer generation", async () => {
		const observedUpdatedAt = new Date("2026-09-17T09:30:00.000Z");
		mocks.listStaleValidating.mockResolvedValue([
			validatingRow("snap_regen", "p9", "o9", observedUpdatedAt),
			validatingRow("snap_dead", "p2", "o2"),
		]);
		// Both executions look closed to this run.
		mocks.describe.mockResolvedValue({ status: { name: "COMPLETED" } });
		// The first row moved after it was described; the second did not.
		mocks.failStaleValidating
			.mockResolvedValueOnce({ changed: false })
			.mockResolvedValueOnce({ changed: true });

		const result = await reapInstructionSnapshots();

		// One attempt per candidate, each carrying the version it described.
		expect(mocks.failStaleValidating).toHaveBeenCalledTimes(2);
		expect(mocks.failStaleValidating).toHaveBeenNthCalledWith(1, {
			snapshotId: "snap_regen",
			projectId: "p9",
			organizationId: "o9",
			observedUpdatedAt,
		});
		// Nothing else touched the row the write refused.
		expect(mocks.rejectAbandoned).not.toHaveBeenCalled();
		expect(mocks.rotateAbandoned).not.toHaveBeenCalled();
		expect(mocks.markSwept).not.toHaveBeenCalled();
		expect(mocks.deleteSnapshot).not.toHaveBeenCalled();
		expect(mocks.listObjects).not.toHaveBeenCalled();
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		// A refused write is not an error either: the row is simply alive
		// again, and a live row is the normal reason to skip one.
		expect(result).toMatchObject({
			staleValidating: 2,
			healedValidating: 1,
			errorCount: 0,
		});
	});

	it("heals nothing when the Temporal client will not construct", async () => {
		mocks.listStaleValidating.mockResolvedValue([
			validatingRow("snap_strand"),
		]);
		mocks.getTemporalClient.mockRejectedValue(new Error("no client"));

		expect(await reapInstructionSnapshots()).toMatchObject({
			healedValidating: 0,
			errorCount: 1,
		});
		expect(mocks.failStaleValidating).not.toHaveBeenCalled();
	});

	it("logs one line of counts and no identifiers", async () => {
		mocks.listStaleValidating.mockResolvedValue([
			validatingRow("snap_strand", "p7", "o7"),
		]);
		mocks.describe.mockResolvedValue({ status: { name: "TERMINATED" } });

		await reapInstructionSnapshots();

		const [logged] = mocks.loggerInfo.mock.calls.find(
			([fields]) =>
				(fields as { event?: string }).event ===
				"instructions.reaper.validating_healed",
		)!;
		expect(logged).toEqual({
			event: "instructions.reaper.validating_healed",
			scanned: 1,
			healed: 1,
			skippedLive: 0,
		});
		expect(JSON.stringify(logged)).not.toContain("snap_strand");
	});

	it("reports hitCap when phase 0's candidate query comes back full", async () => {
		mocks.listStaleValidating.mockResolvedValue(
			Array.from({ length: 100 }, (_, i) => validatingRow(`snap_${i}`)),
		);
		mocks.describe.mockResolvedValue({ status: { name: "RUNNING" } });

		const result = await reapInstructionSnapshots();

		expect(result).toMatchObject({ staleValidating: 100, hitCap: true });
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "instructions.reaper.cap_hit" }),
			expect.any(String),
		);
	});

	it("stops mid-phase when the wall-clock budget is spent, and runs nothing after it", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
		mocks.listStaleValidating.mockResolvedValue([
			validatingRow("snap_1"),
			validatingRow("snap_2", "p2", "o2"),
		]);
		mocks.listAbandoned.mockResolvedValue([abandonedRow("snap_3")]);
		mocks.describe.mockResolvedValue({ status: { name: "COMPLETED" } });
		// The first row's write takes eleven minutes of the ten-minute budget.
		mocks.failStaleValidating.mockImplementationOnce(async () => {
			vi.setSystemTime(Date.now() + 11 * 60_000);
			return { changed: true };
		});
		mocks.failStaleValidating.mockResolvedValue({ changed: true });

		const result = await reapInstructionSnapshots();

		expect(mocks.failStaleValidating).toHaveBeenCalledTimes(1);
		// Phase 1's candidate query ran before any phase did — the client is
		// acquired once for both — but no row of it was touched, and neither
		// later phase even queried.
		expect(mocks.rejectAbandoned).not.toHaveBeenCalled();
		expect(mocks.listPendingAbandoned).not.toHaveBeenCalled();
		expect(mocks.listProjectsWithPrunable).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			staleValidating: 2,
			healedValidating: 1,
			rejected: 0,
			hitCap: true,
		});
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.reaper.budget_exhausted",
				budget: "time",
				phase: "heal-validating",
			}),
			expect.any(String),
		);
	});
});

describe("reapInstructionSnapshots: abandoned RECEIVING uploads", () => {
	it("asks for candidates older than the shared abandonment threshold", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));

		const result = await reapInstructionSnapshots();

		const [cutoff, limit] = mocks.listAbandoned.mock.calls[0]!;
		// The constant is shared with the tab's polling decision, so the two
		// cannot disagree about which rows are still alive.
		expect((cutoff as Date).getTime()).toBe(
			Date.now() - RECEIVING_ABANDON_AFTER_MS,
		);
		expect(limit).toBe(200);
		expect(result.cutoffAt).toBe((cutoff as Date).toISOString());
	});

	it("closes the row out FIRST, then deletes its staging prefix", async () => {
		mocks.listAbandoned.mockResolvedValue([abandonedRow("snap_1")]);
		mocks.listObjects.mockResolvedValue({
			objects: [
				{ key: "projects/p1/instructions/staging/snap_1/f1", size: 1 },
				{ key: "projects/p1/instructions/staging/snap_1/f2", size: 1 },
			],
		});

		const result = await reapInstructionSnapshots();

		expect(mocks.rejectAbandoned).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			// Tenant-bound by the values that came off the row itself, never
			// off a request: this sweep has no tenant in scope.
			projectId: "p1",
			organizationId: "o1",
			cutoff: expect.any(Date),
		});
		// A snapshot whose objects were deleted while its row still said
		// RECEIVING is an upload the tab offers to finish and that cannot be
		// finished.
		expect(mocks.rejectAbandoned.mock.invocationCallOrder[0]!).toBeLessThan(
			mocks.deleteObjects.mock.invocationCallOrder[0]!,
		);
		expect(mocks.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({
				bucket: "skills",
				prefix: "projects/p1/instructions/staging/snap_1/",
			}),
		);
		// The completion mark comes LAST, after the prefix is actually
		// clean: it is what takes the row out of phase 1b's population, so a
		// row that was not finished must keep it.
		expect(mocks.markSwept).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			projectId: "p1",
			organizationId: "o1",
		});
		expect(mocks.deleteObjects.mock.invocationCallOrder[0]!).toBeLessThan(
			mocks.markSwept.mock.invocationCallOrder[0]!,
		);
		expect(mocks.rotateAbandoned).not.toHaveBeenCalled();
		expect(result.scanned).toBe(1);
		expect(result.rejected).toBe(1);
		expect(result.stagingObjectsDeleted).toBe(2);
		expect(result.errorCount).toBe(0);
	});

	it("touches no storage for a row the conditional write did not move", async () => {
		// A `finalize` that arrived between the candidate query and the write
		// moved the row to VALIDATING: that upload is alive, and its staged
		// bytes are what its own workflow is about to verify.
		mocks.listAbandoned.mockResolvedValue([abandonedRow("snap_racing")]);
		mocks.rejectAbandoned.mockResolvedValue({ changed: false });

		const result = await reapInstructionSnapshots();

		expect(mocks.listObjects).not.toHaveBeenCalled();
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			scanned: 1,
			rejected: 0,
			stagingObjectsDeleted: 0,
		});
	});

	it("counts a failed sweep, leaves the row pending, rotates it and carries on", async () => {
		// `deleteObjects` never throws by itself; it reports per-key failures
		// in `errors`, which `deleteObjectsUnderPrefix` raises as a COUNT.
		// The run must not abort on it: the other candidates are different
		// tenants, and this row keeps its pending mark, so phase 1b of the
		// next run finds it again.
		mocks.listAbandoned.mockResolvedValue([
			abandonedRow("snap_bad"),
			abandonedRow("snap_ok", "p2", "o2"),
		]);
		mocks.listObjects.mockImplementation((args: { prefix: string }) =>
			Promise.resolve({
				objects: args.prefix.includes("snap_bad")
					? [{ key: `${args.prefix}f1`, size: 1 }]
					: [],
			}),
		);
		mocks.deleteObjects.mockResolvedValue({
			deleted: 0,
			errors: [
				{
					key: "projects/p1/instructions/staging/snap_bad/f1",
					message: "denied",
				},
			],
		});

		const result = await reapInstructionSnapshots();

		expect(result).toMatchObject({
			scanned: 2,
			rejected: 2,
			errorCount: 1,
		});
		// The mark is the row's ticket back into phase 1b; a failed sweep
		// must not clear it. The rotation is what stops this one prefix
		// sitting at the head of the queue on every future run.
		expect(mocks.markSwept).toHaveBeenCalledTimes(1);
		expect(mocks.markSwept).toHaveBeenCalledWith({
			snapshotId: "snap_ok",
			projectId: "p2",
			organizationId: "o2",
		});
		expect(mocks.rotateAbandoned).toHaveBeenCalledWith({
			snapshotId: "snap_bad",
			projectId: "p1",
			organizationId: "o1",
		});
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.reaper.abandoned_sweep_error",
				phase: "reject-abandoned",
			}),
			expect.any(String),
		);
		// NOTHING off the error but its class. Its message here is a count,
		// but `listObjects`, `deleteObjects`, the provider SDK and Prisma all
		// throw on their own, with request URLs, buckets, prefixes and object
		// keys in theirs — and a key names a project, a snapshot and a file.
		// The ids that ARE logged came off the row and are this feature's
		// structured-log convention.
		const [logged] = mocks.loggerWarn.mock.calls[0]!;
		expect(logged).toEqual({
			event: "instructions.reaper.abandoned_sweep_error",
			phase: "reject-abandoned",
			snapshotId: "snap_bad",
			projectId: "p1",
			organizationId: "o1",
			errorName: "Error",
		});
		expect(JSON.stringify(logged)).not.toContain("snap_bad/f1");
	});

	it("carries on to the next candidate after one that changed nothing", async () => {
		mocks.listAbandoned.mockResolvedValue([
			abandonedRow("snap_racing"),
			abandonedRow("snap_dead", "p2", "o2"),
		]);
		mocks.rejectAbandoned
			.mockResolvedValueOnce({ changed: false })
			.mockResolvedValueOnce({ changed: true });

		const result = await reapInstructionSnapshots();

		expect(result).toMatchObject({ scanned: 2, rejected: 1 });
		expect(mocks.listObjects).toHaveBeenCalledTimes(1);
		expect(mocks.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({
				prefix: "projects/p2/instructions/staging/snap_dead/",
			}),
		);
	});
});

/**
 * Phase 1b. `rejectAbandonedInstructionSnapshot` commits the verdict and its
 * audit row BEFORE the staging objects are deleted — the ordering the tab
 * depends on — so an attempt that dies in that gap, or one whose sweep
 * failed, strands staged bytes under a row that is REJECTED now and therefore
 * invisible to the RECEIVING candidate query. The activity retry cannot reach
 * it either.
 *
 * Those rows are found by the mark they still carry, not by a time window:
 * `detail: "staging pending"` on their one rejection element, which only a
 * completed sweep rewrites.
 */
describe("reapInstructionSnapshots: re-sweeping closed abandonments", () => {
	it("asks for pending abandonments and deletes what is still under their prefixes", async () => {
		mocks.listPendingAbandoned.mockResolvedValue([
			{ id: "snap_left", projectId: "p1", organizationId: "o1" },
		]);
		mocks.listObjects.mockResolvedValue({
			objects: [
				{
					key: "projects/p1/instructions/staging/snap_left/f1",
					size: 1,
				},
			],
		});

		const result = await reapInstructionSnapshots();

		// A budget and an exclusion list; no `since`, because eligibility is
		// the mark on the row and `updatedAt` only orders the queue.
		expect(mocks.listPendingAbandoned).toHaveBeenCalledWith(
			200,
			[],
			expect.any(Date),
		);
		// The mark is cleared only AFTER the prefix came back clean: it is
		// what takes this row out of the population for good, so a row that
		// was not actually finished must keep it.
		expect(mocks.markSwept).toHaveBeenCalledWith({
			snapshotId: "snap_left",
			projectId: "p1",
			organizationId: "o1",
		});
		expect(mocks.deleteObjects.mock.invocationCallOrder[0]!).toBeLessThan(
			mocks.markSwept.mock.invocationCallOrder[0]!,
		);
		expect(mocks.rotateAbandoned).not.toHaveBeenCalled();
		expect(mocks.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({
				bucket: "skills",
				prefix: "projects/p1/instructions/staging/snap_left/",
			}),
		);
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			["projects/p1/instructions/staging/snap_left/f1"],
			{ bucket: "skills" },
		);
		expect(result).toMatchObject({
			resweptAbandoned: 1,
			stagingObjectsDeleted: 1,
			errorCount: 0,
			// The verdict was recorded once, by the attempt that made it.
			rejected: 0,
			scanned: 0,
		});
		expect(mocks.rejectAbandoned).not.toHaveBeenCalled();
	});

	it("costs one list call and no deletes when the prefix is already empty", async () => {
		// A row whose earlier sweep emptied the prefix but died before it
		// could clear the mark. Marking it now is what stops it coming back.
		mocks.listPendingAbandoned.mockResolvedValue([
			{ id: "snap_clean", projectId: "p1", organizationId: "o1" },
		]);

		const result = await reapInstructionSnapshots();

		expect(mocks.listObjects).toHaveBeenCalledTimes(1);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(mocks.markSwept).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			resweptAbandoned: 1,
			stagingObjectsDeleted: 0,
		});
	});

	it("counts a failed sweep, leaves the row pending, rotates it and carries on", async () => {
		mocks.listPendingAbandoned.mockResolvedValue([
			{ id: "snap_bad", projectId: "p1", organizationId: "o1" },
			{ id: "snap_ok", projectId: "p2", organizationId: "o2" },
		]);
		mocks.listObjects.mockImplementation((args: { prefix: string }) =>
			Promise.resolve({
				objects: args.prefix.includes("snap_bad")
					? [{ key: `${args.prefix}f1`, size: 1 }]
					: [],
			}),
		);
		mocks.deleteObjects.mockResolvedValue({
			deleted: 0,
			errors: [
				{
					key: "projects/p1/instructions/staging/snap_bad/f1",
					message: "denied",
				},
			],
		});

		const result = await reapInstructionSnapshots();

		// Both rows were attempted, one of them failed, and the run finished.
		expect(result).toMatchObject({
			resweptAbandoned: 2,
			errorCount: 1,
		});
		expect(mocks.markSwept).toHaveBeenCalledTimes(1);
		expect(mocks.markSwept).toHaveBeenCalledWith({
			snapshotId: "snap_ok",
			projectId: "p2",
			organizationId: "o2",
		});
		// Still pending, so the next run finds it again — and rotated to the
		// back, so it does not sit at the head of the oldest-first queue
		// every hour while the rows behind it are never reached.
		expect(mocks.rotateAbandoned).toHaveBeenCalledTimes(1);
		expect(mocks.rotateAbandoned).toHaveBeenCalledWith({
			snapshotId: "snap_bad",
			projectId: "p1",
			organizationId: "o1",
		});
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.reaper.abandoned_sweep_error",
				phase: "resweep-abandoned",
			}),
			expect.any(String),
		);
	});

	it("sweeps the OLDEST pending rows first, in the order the query returned", async () => {
		// The rotation itself. The query orders oldest-first and each failure
		// is re-dated to the back, so a row whose delete keeps failing is
		// retried without starving the rows behind it.
		mocks.listPendingAbandoned.mockResolvedValue([
			{ id: "snap_oldest", projectId: "p1", organizationId: "o1" },
			{ id: "snap_newer", projectId: "p2", organizationId: "o2" },
		]);

		const result = await reapInstructionSnapshots();

		expect(
			mocks.markSwept.mock.calls.map(
				(call) => (call[0] as { snapshotId: string }).snapshotId,
			),
		).toEqual(["snap_oldest", "snap_newer"]);
		expect(result.resweptAbandoned).toBe(2);
	});

	it("excludes the rows phase 1 closed out in the same run, in the query", async () => {
		// Rejecting a row writes the pending mark, so it is eligible
		// immediately — with its prefix already swept moments earlier.
		// Re-listing it costs a list call and, worse, a slot in a budget that
		// exists for the rows phase 1 could NOT finish. Skipping it after the
		// query would also make a full page report a backlog that is not
		// there, so the exclusion goes INTO the query.
		mocks.listAbandoned.mockResolvedValue([
			abandonedRow("snap_fresh"),
			abandonedRow("snap_racing", "p3", "o3"),
		]);
		mocks.rejectAbandoned
			.mockResolvedValueOnce({ changed: true })
			.mockResolvedValueOnce({ changed: false });
		mocks.listPendingAbandoned.mockResolvedValue([
			{ id: "snap_stranded", projectId: "p2", organizationId: "o2" },
		]);

		const result = await reapInstructionSnapshots();

		// Only the row phase 1 actually moved is excluded; the one its
		// conditional write did not match was never its work.
		expect(mocks.listPendingAbandoned).toHaveBeenCalledWith(
			200,
			["snap_fresh"],
			expect.any(Date),
		);
		expect(
			mocks.listObjects.mock.calls.map(
				(call) => (call[0] as { prefix: string }).prefix,
			),
		).toEqual([
			"projects/p1/instructions/staging/snap_fresh/",
			"projects/p2/instructions/staging/snap_stranded/",
		]);
		expect(result).toMatchObject({ rejected: 1, resweptAbandoned: 1 });
	});
});

describe("reapInstructionSnapshots: the failure-path prune", () => {
	it("prunes exactly the projects the candidate query listed, with the retention windows", async () => {
		servePrunePopulation([
			{ projectId: "p1", organizationId: "o1" },
			{ projectId: "p2", organizationId: "o2" },
		]);
		// Real promoted keys, not toy strings: the prune filters its delete
		// set to the pruned snapshot's OWN prefixes, because a derived
		// snapshot's inherited rows carry the BASE's keys until promotion
		// rewrites them (Fizzy #2546).
		mocks.listPrunable.mockResolvedValue([
			{
				id: "old_1",
				storageKeys: ["projects/p1/instructions/snapshots/old_1/f1"],
			},
		]);

		const result = await reapInstructionSnapshots();

		expect(mocks.listProjectsWithPrunable).toHaveBeenCalledWith(
			{ ready: 5, rejected: 2 },
			25,
			expect.any(Number),
		);
		expect(
			mocks.listPrunable.mock.calls.map((call) => [call[0], call[1]]),
		).toEqual([
			["p1", "o1"],
			["p2", "o2"],
		]);
		// Rows before objects here too — the prune helper is the one the
		// snapshot workflow already uses, unchanged.
		expect(mocks.deleteSnapshot.mock.invocationCallOrder[0]!).toBeLessThan(
			mocks.deleteObjects.mock.invocationCallOrder[0]!,
		);
		expect(result).toMatchObject({
			projectsPruned: 2,
			snapshotsPruned: 2,
			errorCount: 0,
		});
	});

	it("counts a project whose prune failed and goes on to the next one", async () => {
		// Up to a hundred UNRELATED tenants per run: one project's storage
		// hiccup must not stop the other ninety-nine, and the next hourly run
		// retries it.
		servePrunePopulation([
			{ projectId: "p_bad", organizationId: "o1" },
			{ projectId: "p_ok", organizationId: "o2" },
		]);
		// A provider error, as they actually arrive: a message naming the
		// request, and a short code.
		const providerError = Object.assign(
			new Error(
				"AccessDenied: https://example.com/bucket/projects/p_bad/instructions/staging/s1/secret.env",
			),
			{ name: "S3ServiceException", code: "AccessDenied" },
		);
		mocks.listPrunable.mockImplementation(async (projectId: string) =>
			projectId === "p_bad"
				? Promise.reject(providerError)
				: [{ id: "old_1", storageKeys: [] }],
		);

		const result = await reapInstructionSnapshots();

		expect(result).toMatchObject({
			projectsPruned: 1,
			snapshotsPruned: 1,
			errorCount: 1,
		});
		// The class and the code, and nothing else off the error: a provider
		// message carries request URLs, bucket names, prefixes and keys.
		const [logged] = mocks.loggerError.mock.calls[0]!;
		expect(logged).toEqual({
			event: "instructions.reaper.prune_error",
			projectId: "p_bad",
			organizationId: "o1",
			errorName: "S3ServiceException",
			code: "AccessDenied",
		});
		expect(JSON.stringify(logged)).not.toContain("secret.env");
	});
});

describe("reapInstructionSnapshots: per-run budgets", () => {
	it("reports hitCap when a candidate query comes back full", async () => {
		mocks.listAbandoned.mockResolvedValue(
			Array.from({ length: 200 }, (_, i) => abandonedRow(`snap_${i}`)),
		);
		mocks.rejectAbandoned.mockResolvedValue({ changed: false });

		const result = await reapInstructionSnapshots();

		expect(result.scanned).toBe(200);
		expect(result.hitCap).toBe(true);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "instructions.reaper.cap_hit" }),
			expect.any(String),
		);
	});

	it("reports hitCap when the pending query comes back full", async () => {
		// The query already excluded this run's phase-1 rows, so a full page
		// is a genuine backlog of un-swept abandonments rather than the rows
		// phase 1 just finished coming round again — and monitoring must not
		// read that run as quiet.
		mocks.listPendingAbandoned.mockResolvedValue(
			Array.from({ length: 200 }, (_, i) => ({
				id: `snap_${i}`,
				projectId: "p1",
				organizationId: "o1",
			})),
		);

		const result = await reapInstructionSnapshots();

		expect(result.resweptAbandoned).toBe(200);
		expect(result.hitCap).toBe(true);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "instructions.reaper.cap_hit" }),
			expect.any(String),
		);
	});

	it("reports and warns when a prefix sweep stopped at its page budget", async () => {
		mocks.listPendingAbandoned.mockResolvedValue([
			{ id: "snap_wide", projectId: "p1", organizationId: "o1" },
		]);
		// A prefix that never stops paginating — the legacy export residue
		// this budget exists for.
		mocks.listObjects.mockResolvedValue({
			objects: [
				{
					key: "projects/p1/instructions/staging/snap_wide/f1",
					size: 1,
				},
			],
			nextContinuationToken: "more",
		});

		const result = await reapInstructionSnapshots();

		expect(mocks.listObjects).toHaveBeenCalledTimes(20);
		expect(result.storageTruncated).toBe(true);
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			// Counts only: a key names a project, a snapshot and a file.
			{
				event: "instructions.reaper.storage_truncated",
				maxPrefixPages: 20,
				stagingObjectsDeleted: 20,
				snapshotsPruned: 0,
			},
			expect.any(String),
		);
	});

	it("reports hitCap when the prune candidate query comes back full", async () => {
		servePrunePopulation(
			Array.from({ length: 25 }, (_, i) => ({
				projectId: `p${i}`,
				organizationId: "o1",
			})),
		);

		expect((await reapInstructionSnapshots()).hitCap).toBe(true);
	});

	it("reports a quiet run as all zeroes and no cap", async () => {
		expect(await reapInstructionSnapshots()).toMatchObject({
			scanned: 0,
			rejected: 0,
			staleValidating: 0,
			healedValidating: 0,
			skippedLive: 0,
			resweptAbandoned: 0,
			stagingObjectsDeleted: 0,
			projectsPruned: 0,
			snapshotsPruned: 0,
			errorCount: 0,
			storageTruncated: false,
			hitCap: false,
		});
		expect(mocks.loggerWarn).not.toHaveBeenCalled();
	});
});

/**
 * The liveness guard (Finding 1).
 *
 * `finalize` starts the validation workflow BEFORE it writes VALIDATING —
 * writing the status first would strand the row in VALIDATING forever if the
 * start then failed — and it TOLERATES losing that write: a pre-read
 * RECEIVING plus `WorkflowExecutionAlreadyStartedError` is treated as a
 * confirmed retry. So "RECEIVING and six hours old" is not by itself proof
 * that nothing is running, and rejecting such a row deletes the very staging
 * objects a live run is about to verify.
 */
describe("reapInstructionSnapshots: the liveness guard", () => {
	it("asks Temporal about the snapshot's deterministic workflow id", async () => {
		mocks.listAbandoned.mockResolvedValue([abandonedRow("snap_1")]);

		await reapInstructionSnapshots();

		// The same id `finalize` starts under. A drifted copy here would
		// answer "nothing is running" for every snapshot, silently.
		expect(mocks.getHandle).toHaveBeenCalledWith(
			"project-instruction-snapshot-snap_1",
		);
	});

	it("leaves a candidate whose execution still exists strictly alone", async () => {
		mocks.listAbandoned.mockResolvedValue([abandonedRow("snap_live")]);
		mocks.describe.mockResolvedValue({ status: { name: "RUNNING" } });

		const result = await reapInstructionSnapshots();

		// No verdict, no storage: this row belongs to a workflow.
		expect(mocks.rejectAbandoned).not.toHaveBeenCalled();
		expect(mocks.listObjects).not.toHaveBeenCalled();
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			scanned: 1,
			rejected: 0,
			skippedLive: 1,
			errorCount: 0,
		});
	});

	it("skips a CLOSED execution too — the workflow owns that verdict", async () => {
		// Closed means `finalize` was called and the run reached a verdict of
		// its own. Writing REJECTED over it would be the reaper overruling a
		// workflow that did its job.
		mocks.listAbandoned.mockResolvedValue([abandonedRow("snap_done")]);
		mocks.describe.mockResolvedValue({ status: { name: "COMPLETED" } });

		expect(await reapInstructionSnapshots()).toMatchObject({
			rejected: 0,
			skippedLive: 1,
		});
		expect(mocks.rejectAbandoned).not.toHaveBeenCalled();
	});

	it("proceeds to the conditional write only when Temporal has never heard of the id", async () => {
		mocks.listAbandoned.mockResolvedValue([abandonedRow("snap_dead")]);
		mocks.describe.mockRejectedValue(
			new WorkflowNotFoundError("workflow not found"),
		);

		const result = await reapInstructionSnapshots();

		expect(mocks.rejectAbandoned).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: "snap_dead" }),
		);
		expect(result).toMatchObject({ rejected: 1, skippedLive: 0 });
	});

	it("counts any other describe failure as an error for that row and carries on", async () => {
		// An unreachable Temporal cannot distinguish "the start was lost"
		// from "the start succeeded", and a wrongly-rejected upload costs a
		// user real work. Err toward live, count it so the outage is visible,
		// and let the next run decide.
		mocks.listAbandoned.mockResolvedValue([
			abandonedRow("snap_unknown"),
			abandonedRow("snap_dead", "p2", "o2"),
		]);
		mocks.describe
			.mockRejectedValueOnce(new Error("connection refused"))
			.mockRejectedValueOnce(new WorkflowNotFoundError("not found"));

		const result = await reapInstructionSnapshots();

		expect(mocks.rejectAbandoned).toHaveBeenCalledTimes(1);
		expect(mocks.rejectAbandoned).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: "snap_dead" }),
		);
		expect(result).toMatchObject({
			scanned: 2,
			rejected: 1,
			skippedLive: 0,
			errorCount: 1,
		});
	});

	it("rejects nothing at all when the Temporal client will not construct", async () => {
		mocks.listAbandoned.mockResolvedValue([abandonedRow("snap_1")]);
		mocks.getTemporalClient.mockRejectedValue(
			Object.assign(
				new Error("connect ECONNREFUSED temporal.example.com:7233"),
				{ code: "ECONNREFUSED" },
			),
		);

		const result = await reapInstructionSnapshots();

		expect(mocks.rejectAbandoned).not.toHaveBeenCalled();
		expect(result).toMatchObject({ rejected: 0, errorCount: 1 });
		// Counts, the error's class and its code — never the message, which
		// for a connection failure names the deployment's own endpoint.
		const [logged] = mocks.loggerWarn.mock.calls[0]!;
		expect(logged).toEqual({
			event: "instructions.reaper.temporal_unavailable",
			candidates: 1,
			errorName: "Error",
			code: "ECONNREFUSED",
		});
		expect(JSON.stringify(logged)).not.toContain("temporal.example.com");
	});

	it("never asks Temporal anything when neither phase has candidates", async () => {
		// Phase 1b and the prune work on rows whose verdict is already
		// written; a client connection for them would be cost with no answer
		// to buy.
		mocks.listPendingAbandoned.mockResolvedValue([
			{ id: "snap_left", projectId: "p1", organizationId: "o1" },
		]);

		await reapInstructionSnapshots();

		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});
});

/**
 * The prune rotation (Finding 2, reopened in round 5).
 *
 * The candidate query is ONE ordered, deduplicated relation now, so a page is
 * a window of one order and the rotation is a walk of that window. The two
 * separately-skipped `groupBy` windows this replaces were not a window of
 * anything: with twenty-five sticky READY-only projects and twenty-five
 * sticky rejected-only ones, offset 0 returned half of each and offset 25
 * returned nothing at all, every hour, so half the population was starved
 * indefinitely.
 *
 * So these tests drive a real population through the query's own
 * OFFSET/LIMIT/total semantics and assert which projects the run actually
 * PRUNED, rather than re-deriving the offset arithmetic the reaper just did.
 */
describe("reapInstructionSnapshots: the prune candidate rotation", () => {
	/** The projects the run handed to the prune helper, in order. */
	function prunedProjects(): string[] {
		return mocks.listPrunable.mock.calls.map((call) => call[0] as string);
	}

	function offsetsAsked(): number[] {
		return mocks.listProjectsWithPrunable.mock.calls.map(
			(call) => call[2] as number,
		);
	}

	/**
	 * A stable population of the three kinds the two retention windows
	 * produce: projects over the READY window only, over the REJECTED/FAILED
	 * window only, and over both — which the `UNION` returns ONCE, because a
	 * project over both windows is one unit of prune work. Ordered as the
	 * query orders it.
	 */
	function population(size: number): PruneCandidate[] {
		const kinds = ["both", "ready_only", "rejected_only"];
		return Array.from({ length: size }, (_, i) => ({
			projectId: `${kinds[i % 3]}_${String(i).padStart(3, "0")}`,
			organizationId: `o${i % 4}`,
		})).sort((a, b) => a.projectId.localeCompare(b.projectId));
	}

	it("asks for the head page first, with the retention windows and the run's slice", async () => {
		servePrunePopulation(population(60));

		await reapInstructionSnapshots();

		// The head page is where `total` comes from: the population size
		// rides on the page's rows, so only a page that HAS rows reports it.
		expect(mocks.listProjectsWithPrunable.mock.calls[0]).toEqual([
			{ ready: 5, rejected: 2 },
			25,
			0,
		]);
	});

	it("advances one whole slice per hour, from the run's own clock", async () => {
		vi.useFakeTimers();
		// 07:30 UTC on the hour grid is hour 7, so seven slices of 25 in —
		// and the population is wide enough that nothing wraps. UTC, not
		// local: the grid is `Date.now()`, so a local-time fixture would put
		// this run on a different hour in every timezone.
		vi.setSystemTime(new Date(Date.UTC(1970, 0, 1, 7, 30, 0)));
		const hours = Math.floor(Date.now() / 3_600_000);
		servePrunePopulation(population(1_000));

		await reapInstructionSnapshots();

		expect(offsetsAsked()).toEqual([0, (hours * 25) % 1_000]);
	});

	it("asks for nothing but the head page when the population fits in one slice", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(Date.UTC(1970, 0, 1, 3)));
		const small = population(10);
		servePrunePopulation(small);

		await reapInstructionSnapshots();

		// Rotating a population smaller than one slice can only re-walk a
		// prefix of it: the head page already IS every candidate.
		expect(offsetsAsked()).toEqual([0]);
		expect(prunedProjects()).toEqual(small.map((c) => c.projectId));
	});

	it("wraps at the size of the candidate population", async () => {
		vi.useFakeTimers();
		// Hour 1 of the epoch: one slice in, sixty candidates.
		vi.setSystemTime(new Date(Date.UTC(1970, 0, 1, 1)));
		const sixty = population(60);
		servePrunePopulation(sixty);

		await reapInstructionSnapshots();

		expect(offsetsAsked()).toEqual([0, 25]);
		expect(prunedProjects()).toEqual(
			sixty.slice(25, 50).map((c) => c.projectId),
		);
	});

	it("fills a rotated page that reached the END from the head of the ordering", async () => {
		vi.useFakeTimers();
		// Hour 2 of the epoch and sixty candidates: offset 50, so the rotated
		// page is ten rows short of a slice.
		vi.setSystemTime(new Date(Date.UTC(1970, 0, 1, 2)));
		const sixty = population(60);
		servePrunePopulation(sixty);

		await reapInstructionSnapshots();

		// The wraparound page costs no third query: the head page this run
		// already fetched IS the start of the ordering.
		expect(offsetsAsked()).toEqual([0, 50]);
		expect(prunedProjects()).toEqual([
			...sixty.slice(50).map((c) => c.projectId),
			...sixty.slice(0, 15).map((c) => c.projectId),
		]);
	});

	it("asks for offset zero when there is nothing to prune", async () => {
		// `% 0` is NaN, which is not an offset.
		servePrunePopulation([]);

		await reapInstructionSnapshots();

		expect(offsetsAsked()).toEqual([0]);
		expect(prunedProjects()).toEqual([]);
	});

	it("reaches every candidate project within ceil(total / slice) runs", async () => {
		// The coverage claim itself, over the offsets the clock produces on
		// consecutive hours and over the projects that were actually pruned —
		// wraparound page included.
		vi.useFakeTimers();
		const sixty = population(60);
		servePrunePopulation(sixty);
		const covered = new Set<string>();
		for (let hour = 0; hour < Math.ceil(60 / 25); hour++) {
			vi.setSystemTime(new Date(Date.UTC(1970, 0, 1, hour)));
			mocks.listPrunable.mockClear();
			await reapInstructionSnapshots();
			for (const projectId of prunedProjects()) {
				covered.add(projectId);
			}
		}
		expect(covered).toEqual(new Set(sixty.map((c) => c.projectId)));
	});
});

/**
 * The global run budgets (Finding 3).
 *
 * The row budgets bound how many units of work a run SELECTS; nothing bounded
 * what a unit costs. One prefix is up to twenty pages, one pruned snapshot
 * carries its own file keys, and the product of the nominal limits runs to
 * millions of keys — far past the activity's 15-minute start-to-close
 * timeout. A run that times out is retried FROM THE TOP, so an early phase
 * that cannot finish means the later phases never run at all.
 */
describe("reapInstructionSnapshots: the global run budgets", () => {
	it("stops the prune mid-project when the object budget is spent", async () => {
		servePrunePopulation([
			{ projectId: "p1", organizationId: "o1" },
			{ projectId: "p2", organizationId: "o2" },
		]);
		// One snapshot that spends the whole run budget on its own file keys,
		// and a second behind it in the same project.
		mocks.listPrunable.mockImplementation(async (projectId: string) =>
			projectId === "p1"
				? [
						{
							id: "big",
							storageKeys: Array.from(
								{ length: 20_000 },
								(_, i) =>
									`projects/p1/instructions/snapshots/big/f${i}`,
							),
						},
						{
							id: "next",
							storageKeys: [
								"projects/p1/instructions/snapshots/next/f1",
							],
						},
					]
				: [
						{
							id: "other",
							storageKeys: [
								"projects/p2/instructions/snapshots/other/f1",
							],
						},
					],
		);

		const result = await reapInstructionSnapshots();

		// The first snapshot's rows and objects went; the second snapshot of
		// the same project did not, and the second project was never started.
		expect(mocks.deleteSnapshot).toHaveBeenCalledTimes(1);
		expect(mocks.listPrunable).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			projectsPruned: 1,
			snapshotsPruned: 1,
			storageTruncated: true,
			hitCap: true,
		});
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.reaper.budget_exhausted",
				budget: "objects",
				phase: "prune",
			}),
			expect.any(String),
		);
	});

	it("stops between phases when the wall-clock budget is spent", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-17T12:00:00.000Z"));
		mocks.listAbandoned.mockResolvedValue([
			abandonedRow("snap_1"),
			abandonedRow("snap_2", "p2", "o2"),
		]);
		mocks.listPendingAbandoned.mockResolvedValue([
			{ id: "snap_left", projectId: "p3", organizationId: "o3" },
		]);
		servePrunePopulation([{ projectId: "p4", organizationId: "o4" }]);
		// The first row's sweep takes eleven minutes of the ten-minute
		// budget.
		mocks.markSwept.mockImplementationOnce(async () => {
			vi.setSystemTime(Date.now() + 11 * 60_000);
			return { changed: true };
		});
		mocks.markSwept.mockResolvedValue({ changed: true });

		const result = await reapInstructionSnapshots();

		// One row closed out, then nothing: not the second candidate, not
		// phase 1b, not the prune — and neither later phase even ran its
		// candidate query.
		expect(result).toMatchObject({
			scanned: 2,
			rejected: 1,
			resweptAbandoned: 0,
			projectsPruned: 0,
			hitCap: true,
		});
		expect(mocks.listPendingAbandoned).not.toHaveBeenCalled();
		expect(mocks.listProjectsWithPrunable).not.toHaveBeenCalled();
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "instructions.reaper.budget_exhausted",
				budget: "time",
			}),
			expect.any(String),
		);
	});

	it("leaves an abandonment PENDING when the object budget cut its sweep short", async () => {
		// The completion mark is permanent. Clearing it over a prefix that
		// still has bytes under it would strand them for good, so a sweep the
		// RUN budget stopped must not be recorded as finished — unlike one
		// the per-prefix page budget stopped, whose residue belongs to the
		// bucket-lifecycle rule.
		mocks.listPendingAbandoned.mockResolvedValue([
			{ id: "snap_wide", projectId: "p1", organizationId: "o1" },
		]);
		mocks.listObjects.mockResolvedValue({
			objects: Array.from({ length: 20_001 }, (_, i) => ({
				key: `projects/p1/instructions/staging/snap_wide/f${i}`,
				size: 1,
			})),
			nextContinuationToken: "more",
		});

		const result = await reapInstructionSnapshots();

		expect(mocks.markSwept).not.toHaveBeenCalled();
		// Not a failure either: nothing went wrong, so nothing rotates it to
		// the back of the oldest-first queue.
		expect(mocks.rotateAbandoned).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			stagingObjectsDeleted: 20_000,
			errorCount: 0,
			storageTruncated: true,
			hitCap: true,
		});
	});
});
