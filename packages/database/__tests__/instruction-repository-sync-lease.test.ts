/**
 * The instructions subject's lease, crash recovery and failure receipt,
 * against a stateful row store (Decisions 31, 35, 48 and 54). Each case here
 * is about what the SQL does to a row, so none of them can pass on call
 * shapes alone: the store evaluates every predicate of the fence, the
 * database clock included, and throws on any statement it cannot evaluate.
 * The SQL each function sends is pinned separately, by the protocol tests in
 * instruction-repository-sync-queries.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
	instructionSyncLeaseHeld,
	recordInstructionSyncCheckFailure,
	writeBackInstructionSync,
} from "../prisma/queries/instruction-repository-sync";
import type { ClaimedRepositorySyncRow } from "../prisma/queries/repository-sync-subjects";

const MIN = 60 * 1000;
const LEASE_MS = 2 * MIN;
const at = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00.000Z`);
const PATCH = { nextCheckAt: at("12:15") };

/** Task 4's claim activity: a two-minute lease from the database's clock. */
function claim(limit: number): Promise<ClaimedRepositorySyncRow[]> {
	return claimDueInstructionSyncRows(store.root, {
		limit,
		leaseUntil: new Date(store.now().getTime() + LEASE_MS),
		now: store.now(),
	});
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

		expect(await instructionSyncLeaseHeld(store.root, row)).toBe(true);
		expect(await writeBackInstructionSync(store.root, row, PATCH)).toEqual({
			applied: true,
		});
		expect(store.row("sync_1")).toMatchObject({
			nextCheckAt: at("12:15"),
			updatedAt: at("12:01"),
		});
	});

	it("an expired lease with no competing writer applies nothing (Review Focus 3)", async () => {
		const row = await claimOne();
		store.advance(LEASE_MS - 1);
		expect(await instructionSyncLeaseHeld(store.root, row)).toBe(true);

		// Nothing else touched the row. Only the database's clock moved.
		store.advance(1);
		expect(await instructionSyncLeaseHeld(store.root, row)).toBe(false);
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

			expect(await instructionSyncLeaseHeld(store.root, row)).toBe(false);
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
			nextCheckAt: at("12:02"),
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
		expect(await instructionSyncLeaseHeld(store.root, row)).toBe(true);
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
