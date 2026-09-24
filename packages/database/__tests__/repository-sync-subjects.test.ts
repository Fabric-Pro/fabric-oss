/**
 * The repository-sync subject registry's database half (Decision 46). The
 * instruction queries are stand-ins here: this file pins the wiring, and
 * instruction-repository-sync-queries.test.ts pins what each query does.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Prisma } from "../prisma/client";

const m = vi.hoisted(() => ({
	claim: vi.fn(),
	leaseHeld: vi.fn(),
	writeBack: vi.fn(),
	recordFailure: vi.fn(),
	recordPending: vi.fn(),
	settlePending: vi.fn(),
	findForPush: vi.fn(),
	canCreate: vi.fn(),
}));

vi.mock("../prisma/queries/instruction-repository-sync", () => ({
	claimDueInstructionSyncRows: m.claim,
	instructionSyncLeaseHeld: m.leaseHeld,
	writeBackInstructionSync: m.writeBack,
	recordInstructionSyncCheckFailure: m.recordFailure,
	recordPendingInstructionSyncHead: m.recordPending,
	settlePendingInstructionSyncHead: m.settlePending,
	findInstructionSyncsForPush: m.findForPush,
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: m.canCreate,
}));

import {
	REPOSITORY_SYNC_SUBJECT_STORES,
	type RepositorySyncSubjectStore,
} from "../prisma/queries/repository-sync-subjects";

describe("REPOSITORY_SYNC_SUBJECT_STORES (Decision 46)", () => {
	it("registers exactly the instructions subject", () => {
		expect(Object.keys(REPOSITORY_SYNC_SUBJECT_STORES)).toEqual([
			"instructions",
		]);
		expect(REPOSITORY_SYNC_SUBJECT_STORES.instructions.kind).toBe(
			"instructions",
		);
	});

	it("serves the instructions subject from the instruction sync queries", () => {
		const store = REPOSITORY_SYNC_SUBJECT_STORES.instructions;
		expect(store.listDueAndClaim).toBe(m.claim);
		expect(store.leaseHeld).toBe(m.leaseHeld);
		expect(store.writeBack).toBe(m.writeBack);
		expect(store.recordCheckFailure).toBe(m.recordFailure);
		expect(store.findByRepository).toBe(m.findForPush);
	});

	it("claims with a lease length, never a caller's date: the database dates the lease (Fizzy #2683)", () => {
		expectTypeOf<
			Parameters<RepositorySyncSubjectStore["listDueAndClaim"]>[1]
		>().toEqualTypeOf<{ limit: number; leaseMs: number }>();
	});

	it("reads the lease with the database's clock, which the check calibrates its own clock from (Fizzy #2683)", () => {
		expectTypeOf<
			Awaited<ReturnType<RepositorySyncSubjectStore["leaseHeld"]>>
		>().toEqualTypeOf<{ held: boolean; dbNow: Date }>();
	});

	it("records a pending head on the row's own identity, tenant and generation (Fizzy #2682)", async () => {
		const tx = { tag: "tx" } as unknown as Prisma.TransactionClient;
		m.recordPending.mockResolvedValue({ applied: true });
		await expect(
			REPOSITORY_SYNC_SUBJECT_STORES.instructions.recordPendingHead(
				tx,
				{
					id: "sync_1",
					projectId: "proj_1",
					organizationId: "org_1",
					generation: 3,
				},
				"d".repeat(40),
			),
		).resolves.toEqual({ applied: true });
		expect(m.recordPending).toHaveBeenCalledWith(tx, {
			syncId: "sync_1",
			projectId: "proj_1",
			organizationId: "org_1",
			generation: 3,
			commitSha: "d".repeat(40),
		});
	});

	it("settles a pending head against the run's receipt on the row's own identity, tenant and generation (Fizzy #2682)", async () => {
		const runner = { tag: "db" } as unknown as Parameters<
			typeof REPOSITORY_SYNC_SUBJECT_STORES.instructions.settlePendingHead
		>[0];
		m.settlePending.mockResolvedValue({
			applied: false,
			settled: "consumer_pending",
		});
		await expect(
			REPOSITORY_SYNC_SUBJECT_STORES.instructions.settlePendingHead(
				runner,
				{
					id: "sync_1",
					projectId: "proj_1",
					organizationId: "org_1",
					generation: 3,
				},
				"run_open",
			),
		).resolves.toEqual({ applied: false, settled: "consumer_pending" });
		expect(m.settlePending).toHaveBeenCalledWith(runner, {
			syncId: "sync_1",
			projectId: "proj_1",
			organizationId: "org_1",
			generation: 3,
			runId: "run_open",
		});
	});

	it("checks the delegate's INSTRUCTION_CREATE on the row's project (Decision 33)", async () => {
		m.canCreate.mockResolvedValue(false);
		await expect(
			REPOSITORY_SYNC_SUBJECT_STORES.instructions.checkPermission({
				projectId: "proj_1",
				userId: "user_1",
			}),
		).resolves.toBe(false);
		expect(m.canCreate).toHaveBeenCalledWith("proj_1", "user_1");
	});
});
