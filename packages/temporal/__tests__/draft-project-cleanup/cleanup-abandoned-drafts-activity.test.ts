/**
 * Unit tests for `cleanupAbandonedDraftsActivity` + the pure-function
 * classifier `findAbandonedDrafts`.
 *
 * Group 5 of `2026-05-23-unified-context-uploader-wizard/tasks.md` (5.5
 * sub-tasks (a)-(d)). Pins the contract documented in spec §6.3:
 *   (a) classifier boundary — exactly 14d excluded, 14d + 1ms included,
 *       soft-deleted / non-DRAFT excluded.
 *   (b) end-to-end with mocked DB + Temporal client — 3 abandoned DRAFTs
 *       with 5 in-flight crawls between them produce
 *       `{ draftsDeleted: 3, workflowsCancelled: 5, errors: [] }`.
 *   (c) `WorkflowNotFoundError` per row tolerated — counts as cancelled,
 *       no entry in `errors[]`.
 *   (d) genuine activity error in one DRAFT does not abort the batch —
 *       error added to `errors[]` and remaining DRAFTs processed.
 *
 * Why not `TestWorkflowEnvironment`: repo convention (see
 * `packages/temporal/src/workflows/monitoring/__tests__/incident-lifecycle.test.ts`
 * header) is to mock the activity's I/O surface directly and assert on the
 * observable call sequence. Avoids pulling the Temporalite binary into CI;
 * runs in <100ms.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/draft-project-cleanup/cleanup-abandoned-drafts-activity.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — DB + temporal client + logger
// ---------------------------------------------------------------------------

const mockProjectFindMany = vi.fn();
const mockProjectContextFindMany = vi.fn();
const mockSoftDeleteProject = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findMany: (...args: unknown[]) => mockProjectFindMany(...args),
		},
		projectContext: {
			findMany: (...args: unknown[]) =>
				mockProjectContextFindMany(...args),
		},
	},
	softDeleteProject: (...args: unknown[]) => mockSoftDeleteProject(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

const mockWorkflowCancel = vi.fn();
const mockGetHandle = vi.fn((workflowId: string) => ({
	cancel: () => mockWorkflowCancel(workflowId),
}));
const mockGetTemporalClient = vi.fn(async () => ({
	workflow: {
		getHandle: mockGetHandle,
	},
}));

vi.mock("../../src/client", () => ({
	getTemporalClient: () => mockGetTemporalClient(),
}));

// Stub `@temporalio/activity` so `heartbeat()` is a no-op in tests.
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

// Imports MUST come after vi.mock — module-init order matters.
import {
	cleanupAbandonedDraftsActivity,
	type DraftProjectCandidate,
	findAbandonedDrafts,
} from "../../src/activities/draft-project-cleanup/cleanup-abandoned-drafts-activity";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDraft(
	overrides: Partial<DraftProjectCandidate> = {},
): DraftProjectCandidate {
	return {
		id: "draft-1",
		userId: "user-1",
		organizationId: null,
		updatedAt: new Date("2026-05-01T00:00:00Z"),
		status: "DRAFT",
		deletedAt: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// (a) Classifier — boundary tests
// ---------------------------------------------------------------------------

describe("findAbandonedDrafts (classifier)", () => {
	const now = new Date("2026-05-23T00:00:00Z");

	it("excludes a DRAFT updated exactly 14 days ago", () => {
		// 14 * 24h before now == 2026-05-09T00:00:00Z exactly.
		const exactly14d = new Date("2026-05-09T00:00:00Z");
		const out = findAbandonedDrafts(
			[makeDraft({ id: "boundary", updatedAt: exactly14d })],
			now,
			14,
		);
		expect(out).toEqual([]);
	});

	it("includes a DRAFT updated 14 days + 1ms ago", () => {
		const past14d = new Date("2026-05-08T23:59:59.999Z");
		const out = findAbandonedDrafts(
			[makeDraft({ id: "past", updatedAt: past14d })],
			now,
			14,
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("past");
	});

	it("excludes a soft-deleted DRAFT regardless of age", () => {
		const ancient = new Date("2025-01-01T00:00:00Z");
		const out = findAbandonedDrafts(
			[
				makeDraft({
					id: "soft-deleted",
					updatedAt: ancient,
					deletedAt: new Date("2025-02-01T00:00:00Z"),
				}),
			],
			now,
			14,
		);
		expect(out).toEqual([]);
	});

	it("excludes ACTIVE / ARCHIVED projects regardless of age", () => {
		const ancient = new Date("2025-01-01T00:00:00Z");
		const out = findAbandonedDrafts(
			[
				makeDraft({
					id: "active",
					status: "ACTIVE",
					updatedAt: ancient,
				}),
				makeDraft({
					id: "archived",
					status: "ARCHIVED",
					updatedAt: ancient,
				}),
			],
			now,
			14,
		);
		expect(out).toEqual([]);
	});

	it("returns all qualifying DRAFTs together", () => {
		const ancient = new Date("2025-01-01T00:00:00Z");
		const recent = new Date("2026-05-22T00:00:00Z"); // 1 day ago
		const out = findAbandonedDrafts(
			[
				makeDraft({ id: "old-1", updatedAt: ancient }),
				makeDraft({ id: "old-2", updatedAt: ancient }),
				makeDraft({ id: "fresh", updatedAt: recent }),
			],
			now,
			14,
		);
		expect(out.map((d) => d.id).sort()).toEqual(["old-1", "old-2"]);
	});

	it("respects a custom cutoffDays override", () => {
		// 7 day window — a 10-day-old DRAFT should qualify, a 5-day-old one
		// should not.
		const tenDaysAgo = new Date("2026-05-13T00:00:00Z");
		const fiveDaysAgo = new Date("2026-05-18T00:00:00Z");
		const out = findAbandonedDrafts(
			[
				makeDraft({ id: "ten", updatedAt: tenDaysAgo }),
				makeDraft({ id: "five", updatedAt: fiveDaysAgo }),
			],
			now,
			7,
		);
		expect(out.map((d) => d.id)).toEqual(["ten"]);
	});
});

// ---------------------------------------------------------------------------
// (b)-(d) Activity — end-to-end with mocked DB + Temporal client
// ---------------------------------------------------------------------------

describe("cleanupAbandonedDraftsActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: no DRAFTs found.
		mockProjectFindMany.mockResolvedValue([]);
		mockProjectContextFindMany.mockResolvedValue([]);
		mockSoftDeleteProject.mockResolvedValue({});
		mockWorkflowCancel.mockResolvedValue(undefined);
	});

	it("is a no-op when no DRAFTs qualify (early return)", async () => {
		mockProjectFindMany.mockResolvedValue([]);

		const result = await cleanupAbandonedDraftsActivity();

		expect(result).toEqual({
			draftsDeleted: 0,
			workflowsCancelled: 0,
			errors: [],
		});
		expect(mockGetTemporalClient).not.toHaveBeenCalled();
		expect(mockSoftDeleteProject).not.toHaveBeenCalled();
	});

	it("(b) end-to-end: cancels 5 in-flight crawls across 3 DRAFTs and soft-deletes all 3", async () => {
		const drafts: DraftProjectCandidate[] = [
			makeDraft({ id: "d1", userId: "u1" }),
			makeDraft({ id: "d2", userId: "u2", organizationId: "org-1" }),
			makeDraft({ id: "d3", userId: "u3" }),
		];
		mockProjectFindMany.mockResolvedValue(drafts);

		// d1: 2 in-flight workflows; d2: 2; d3: 1. Total 5.
		mockProjectContextFindMany.mockImplementation(
			async (args: { where: { projectId: string } }) => {
				const map: Record<
					string,
					Array<{
						id: string;
						projectId: string;
						urlActiveWorkflowId: string;
					}>
				> = {
					d1: [
						{
							id: "ctx-1",
							projectId: "d1",
							urlActiveWorkflowId: "wf-1",
						},
						{
							id: "ctx-2",
							projectId: "d1",
							urlActiveWorkflowId: "wf-2",
						},
					],
					d2: [
						{
							id: "ctx-3",
							projectId: "d2",
							urlActiveWorkflowId: "wf-3",
						},
						{
							id: "ctx-4",
							projectId: "d2",
							urlActiveWorkflowId: "wf-4",
						},
					],
					d3: [
						{
							id: "ctx-5",
							projectId: "d3",
							urlActiveWorkflowId: "wf-5",
						},
					],
				};
				return map[args.where.projectId] ?? [];
			},
		);

		const result = await cleanupAbandonedDraftsActivity();

		expect(result).toEqual({
			draftsDeleted: 3,
			workflowsCancelled: 5,
			errors: [],
		});
		// Verify every workflow was cancelled exactly once.
		expect(mockWorkflowCancel).toHaveBeenCalledTimes(5);
		expect(mockWorkflowCancel).toHaveBeenCalledWith("wf-1");
		expect(mockWorkflowCancel).toHaveBeenCalledWith("wf-2");
		expect(mockWorkflowCancel).toHaveBeenCalledWith("wf-3");
		expect(mockWorkflowCancel).toHaveBeenCalledWith("wf-4");
		expect(mockWorkflowCancel).toHaveBeenCalledWith("wf-5");
		// Verify every DRAFT was soft-deleted with the right
		// (projectId, userId, organizationId) tuple — tenancy matters.
		expect(mockSoftDeleteProject).toHaveBeenCalledTimes(3);
		expect(mockSoftDeleteProject).toHaveBeenCalledWith(
			"d1",
			"u1",
			undefined,
		);
		expect(mockSoftDeleteProject).toHaveBeenCalledWith("d2", "u2", "org-1");
		expect(mockSoftDeleteProject).toHaveBeenCalledWith(
			"d3",
			"u3",
			undefined,
		);
	});

	it("(c) tolerates Temporal `not found` per workflow — counts as cancelled, no entry in errors[]", async () => {
		mockProjectFindMany.mockResolvedValue([makeDraft({ id: "d1" })]);
		mockProjectContextFindMany.mockResolvedValue([
			{ id: "ctx-1", projectId: "d1", urlActiveWorkflowId: "wf-stale-1" },
			{ id: "ctx-2", projectId: "d1", urlActiveWorkflowId: "wf-stale-2" },
		]);
		// Both workflows return "not found" — they already finalized.
		mockWorkflowCancel.mockRejectedValue(
			new Error("workflow execution not found"),
		);

		const result = await cleanupAbandonedDraftsActivity();

		expect(result.workflowsCancelled).toBe(2);
		expect(result.errors).toEqual([]);
		expect(result.draftsDeleted).toBe(1);
	});

	it("(d) genuine error on one DRAFT does not abort the batch — error added to errors[] and remaining DRAFTs processed", async () => {
		mockProjectFindMany.mockResolvedValue([
			makeDraft({ id: "d1" }),
			makeDraft({ id: "d2" }),
			makeDraft({ id: "d3" }),
		]);

		// d2 has one in-flight workflow that throws a non-"not found" error.
		// d1 + d3 have no in-flight workflows.
		mockProjectContextFindMany.mockImplementation(
			async (args: { where: { projectId: string } }) => {
				if (args.where.projectId === "d2") {
					return [
						{
							id: "ctx-broken",
							projectId: "d2",
							urlActiveWorkflowId: "wf-broken",
						},
					];
				}
				return [];
			},
		);
		mockWorkflowCancel.mockImplementation(async (workflowId: string) => {
			if (workflowId === "wf-broken") {
				throw new Error(
					"Temporal namespace unavailable — connection refused",
				);
			}
		});

		const result = await cleanupAbandonedDraftsActivity();

		// The cancel error must NOT block the d2 soft-delete (the workflow
		// is best-effort cancellable; the soft-delete is the durable signal
		// per spec §6.3 step 4 + the comment in the activity).
		expect(result.draftsDeleted).toBe(3);
		expect(result.workflowsCancelled).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			id: "ctx-broken",
			kind: "cancel",
		});
		expect(result.errors[0]?.message).toMatch(/connection refused/i);
		// Even with the failure, all three DRAFTs must be soft-deleted.
		expect(mockSoftDeleteProject).toHaveBeenCalledTimes(3);
	});

	it("(d-bis) soft-delete error on one DRAFT does not abort the batch — error added to errors[] with kind: 'soft-delete' and remaining DRAFTs processed", async () => {
		mockProjectFindMany.mockResolvedValue([
			makeDraft({ id: "d1" }),
			makeDraft({ id: "d2" }),
			makeDraft({ id: "d3" }),
		]);
		mockProjectContextFindMany.mockResolvedValue([]);
		// d2's soft-delete throws a generic DB error.
		mockSoftDeleteProject.mockImplementation(async (projectId: string) => {
			if (projectId === "d2") {
				throw new Error("postgres deadlock");
			}
		});

		const result = await cleanupAbandonedDraftsActivity();

		expect(result.draftsDeleted).toBe(2);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatchObject({
			id: "d2",
			kind: "soft-delete",
		});
		expect(result.errors[0]?.message).toMatch(/deadlock/i);
	});

	it("respects custom cutoffDays + batchSize passed to the activity", async () => {
		mockProjectFindMany.mockResolvedValue([]);

		await cleanupAbandonedDraftsActivity({
			cutoffDays: 7,
			batchSize: 100,
		});

		// Inspect the query the activity actually issued.
		const findCall = mockProjectFindMany.mock.calls[0]?.[0] as
			| {
					where: { updatedAt: { lt: Date } };
					take: number;
			  }
			| undefined;
		expect(findCall?.take).toBe(100);
		// cutoff = now - 7d (allowing a few seconds of test runtime slack).
		const cutoff = findCall?.where.updatedAt.lt;
		expect(cutoff).toBeInstanceOf(Date);
		const expectedCutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const actualCutoffMs = (cutoff as Date).getTime();
		// 60s slack — the test should finish well within that.
		expect(Math.abs(actualCutoffMs - expectedCutoffMs)).toBeLessThan(
			60_000,
		);
	});

	it("does not call getTemporalClient when there are zero in-flight workflows across all DRAFTs (lazy-resolution)", async () => {
		mockProjectFindMany.mockResolvedValue([
			makeDraft({ id: "d1" }),
			makeDraft({ id: "d2" }),
		]);
		mockProjectContextFindMany.mockResolvedValue([]);

		const result = await cleanupAbandonedDraftsActivity();

		expect(mockGetTemporalClient).not.toHaveBeenCalled();
		expect(result.draftsDeleted).toBe(2);
		expect(result.workflowsCancelled).toBe(0);
	});
});
