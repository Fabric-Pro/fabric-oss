/**
 * The repository-sync subject registry's Temporal half (Decision 46): which
 * kinds exist, and that each subject is its database store plus a start.
 */
import type { InstructionSyncTrigger } from "@repo/database";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	store: {
		kind: "instructions",
		listDueAndClaim: vi.fn(),
		leaseHeld: vi.fn(),
		writeBack: vi.fn(),
		recordCheckFailure: vi.fn(),
		recordPendingHead: vi.fn(),
		settlePendingHead: vi.fn(),
		findByRepository: vi.fn(),
		checkPermission: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	REPOSITORY_SYNC_SUBJECT_STORES: { instructions: m.store },
}));
vi.mock("../src/activities/lib/instruction-sync-start", () => ({
	startAutomaticInstructionSync: m.start,
}));

import type { RepositorySyncStartResult } from "../src/activities/lib/instruction-sync-start";
import {
	REPOSITORY_SYNC_SUBJECT_KINDS,
	REPOSITORY_SYNC_SUBJECTS,
	type RepositorySyncSubject,
	repositorySyncSubject,
} from "../src/activities/lib/repository-sync-subjects";

function passThrough<T extends object>(options: T): T {
	return options;
}

describe("repository sync subjects (Decision 46)", () => {
	it("registers exactly the instructions subject, and the poll claims exactly the registered kinds", () => {
		expect(REPOSITORY_SYNC_SUBJECT_KINDS).toEqual(["instructions"]);
		expect(Object.keys(REPOSITORY_SYNC_SUBJECTS)).toEqual([
			...REPOSITORY_SYNC_SUBJECT_KINDS,
		]);
		expect(repositorySyncSubject("instructions").kind).toBe("instructions");
	});

	it("serves the instructions subject's database half from its @repo/database store", () => {
		const subject = repositorySyncSubject("instructions");
		expect(subject.listDueAndClaim).toBe(m.store.listDueAndClaim);
		expect(subject.leaseHeld).toBe(m.store.leaseHeld);
		expect(subject.writeBack).toBe(m.store.writeBack);
		expect(subject.recordCheckFailure).toBe(m.store.recordCheckFailure);
		// The webhook and the poll leave and settle an open run's re-check
		// request through the subject, never the query (Fizzy #2682).
		expect(subject.recordPendingHead).toBe(m.store.recordPendingHead);
		expect(subject.settlePendingHead).toBe(m.store.settlePendingHead);
		expect(subject.findByRepository).toBe(m.store.findByRepository);
		expect(subject.checkPermission).toBe(m.store.checkPermission);
	});

	it("starts a run with any trigger but MANUAL, and answers with the start's result (Decisions 47 and 56)", () => {
		expectTypeOf<
			Parameters<RepositorySyncSubject["startRun"]>[1]
		>().toEqualTypeOf<Exclude<InstructionSyncTrigger, "MANUAL">>();
		expectTypeOf<
			Awaited<ReturnType<RepositorySyncSubject["startRun"]>>
		>().toEqualTypeOf<RepositorySyncStartResult>();
	});

	it("starts the instructions subject's run through the sync starter, passing the row's id, the expected row and the decorator on (Decision 56)", async () => {
		const reached = {
			outcome: "already_running",
			workflowId: "project-instruction-repository-sync-proj_1",
			runId: "run_open",
			runKey: "sync_1:run_open",
		};
		m.start.mockResolvedValue(reached);
		await expect(
			repositorySyncSubject("instructions").startRun(
				{ id: "sync_1", projectId: "proj_1", organizationId: "org_1" },
				"WEBHOOK",
				{
					expected: { syncId: "sync_1", generation: 3 },
					decorate: passThrough,
				},
			),
		).resolves.toBe(reached);
		expect(m.start).toHaveBeenCalledWith(
			{
				syncId: "sync_1",
				projectId: "proj_1",
				organizationId: "org_1",
				trigger: "WEBHOOK",
				expected: { syncId: "sync_1", generation: 3 },
			},
			passThrough,
		);
	});
});
