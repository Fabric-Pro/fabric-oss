/**
 * The repository-sync subject registry's Temporal half (Decision 46): which
 * kinds exist, and that each subject is its database store plus a start.
 */
import type { AutomaticRepositorySyncTrigger } from "@repo/database";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

const m = vi.hoisted(() => {
	const store = (kind: string) => ({
		kind,
		listDueAndClaim: vi.fn(),
		leaseHeld: vi.fn(),
		writeBack: vi.fn(),
		recordCheckFailure: vi.fn(),
		recordPendingHead: vi.fn(),
		settlePendingHead: vi.fn(),
		findByRepository: vi.fn(),
		checkPermission: vi.fn(),
	});
	return {
		start: vi.fn(),
		startContext: vi.fn(),
		store: store("instructions"),
		contextStore: store("context"),
	};
});

vi.mock("@repo/database", () => ({
	REPOSITORY_SYNC_SUBJECT_STORES: {
		instructions: m.store,
		context: m.contextStore,
	},
}));
vi.mock("../src/activities/lib/instruction-sync-start", () => ({
	startAutomaticInstructionSync: m.start,
}));
vi.mock("../src/activities/lib/context-sync-start", () => ({
	startAutomaticContextSync: m.startContext,
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
	it("registers exactly the instructions and context subjects, and the poll claims exactly the registered kinds", () => {
		expect(REPOSITORY_SYNC_SUBJECT_KINDS).toEqual([
			"instructions",
			"context",
		]);
		expect(Object.keys(REPOSITORY_SYNC_SUBJECTS)).toEqual([
			...REPOSITORY_SYNC_SUBJECT_KINDS,
		]);
		expect(repositorySyncSubject("instructions").kind).toBe("instructions");
		expect(repositorySyncSubject("context").kind).toBe("context");
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

	it("claims with a lease length, never a date from the worker's clock (Fizzy #2683)", () => {
		expectTypeOf<
			Parameters<RepositorySyncSubject["listDueAndClaim"]>[1]
		>().toEqualTypeOf<{ limit: number; leaseMs: number }>();
	});

	it("starts a run with an automatic trigger every registered subject can store, and answers with the start's result (Decisions 47 and 56, Fizzy #2673)", () => {
		// Checked by `tsc`: the seam's trigger is the intersection of the
		// subjects' non-MANUAL enum values, whatever they are...
		expectTypeOf<
			Parameters<RepositorySyncSubject["startRun"]>[1]
		>().toEqualTypeOf<AutomaticRepositorySyncTrigger>();
		// ...and today that is exactly these two, so widening both enums is
		// noticed here.
		expectTypeOf<AutomaticRepositorySyncTrigger>().toEqualTypeOf<
			"POLL" | "WEBHOOK"
		>();
		expectTypeOf<
			Awaited<ReturnType<RepositorySyncSubject["startRun"]>>
		>().toEqualTypeOf<RepositorySyncStartResult>();
	});

	it("serves the context subject's database half from its @repo/database store", () => {
		const subject = repositorySyncSubject("context");
		expect(subject.listDueAndClaim).toBe(m.contextStore.listDueAndClaim);
		expect(subject.leaseHeld).toBe(m.contextStore.leaseHeld);
		expect(subject.writeBack).toBe(m.contextStore.writeBack);
		expect(subject.recordCheckFailure).toBe(
			m.contextStore.recordCheckFailure,
		);
		// The Living Memory twin of the re-check request (Fizzy #2673).
		expect(subject.recordPendingHead).toBe(
			m.contextStore.recordPendingHead,
		);
		expect(subject.settlePendingHead).toBe(
			m.contextStore.settlePendingHead,
		);
		expect(subject.findByRepository).toBe(m.contextStore.findByRepository);
		expect(subject.checkPermission).toBe(m.contextStore.checkPermission);
	});

	it("starts the context subject's run through the Living Memory starter, never the instructions one (Fizzy #2673)", async () => {
		const reached = {
			outcome: "started",
			workflowId: "context-repository-sync-proj_1",
			runId: "run_1",
		};
		m.start.mockClear();
		m.startContext.mockResolvedValue(reached);
		await expect(
			repositorySyncSubject("context").startRun(
				{ id: "sync_1", projectId: "proj_1", organizationId: "org_1" },
				"POLL",
				{ expected: { syncId: "sync_1", generation: 3 } },
			),
		).resolves.toBe(reached);
		expect(m.startContext).toHaveBeenCalledWith(
			{
				projectId: "proj_1",
				organizationId: "org_1",
				trigger: "POLL",
				expected: { syncId: "sync_1", generation: 3 },
			},
			undefined,
		);
		expect(m.start).not.toHaveBeenCalled();
	});

	it("starts the instructions subject's run through the sync starter, passing the expected row and the decorator on (Decision 56)", async () => {
		const reached = {
			outcome: "already_running",
			workflowId: "project-instruction-repository-sync-proj_1",
			runId: "run_open",
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
				projectId: "proj_1",
				organizationId: "org_1",
				trigger: "WEBHOOK",
				expected: { syncId: "sync_1", generation: 3 },
			},
			passThrough,
		);
	});
});
