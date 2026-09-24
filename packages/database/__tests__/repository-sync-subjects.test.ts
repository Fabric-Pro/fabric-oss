/**
 * The repository-sync subject registry's database half (Decision 46). The
 * instruction queries are stand-ins here: this file pins the wiring, and
 * instruction-repository-sync-queries.test.ts pins what each query does.
 */
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	claim: vi.fn(),
	leaseHeld: vi.fn(),
	writeBack: vi.fn(),
	recordFailure: vi.fn(),
	findForPush: vi.fn(),
	canCreate: vi.fn(),
}));

vi.mock("../prisma/queries/instruction-repository-sync", () => ({
	claimDueInstructionSyncRows: m.claim,
	instructionSyncLeaseHeld: m.leaseHeld,
	writeBackInstructionSync: m.writeBack,
	recordInstructionSyncCheckFailure: m.recordFailure,
	findInstructionSyncsForPush: m.findForPush,
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	canCreateProjectInstructions: m.canCreate,
}));

import { REPOSITORY_SYNC_SUBJECT_STORES } from "../prisma/queries/repository-sync-subjects";

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
