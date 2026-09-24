/**
 * The Living Memory sync's status table (design 2026-09-23 §5.4) over a
 * run's ledger, as `record` applies it, the scheduling effect of each
 * verdict (§11.1, Fizzy #2673), and the completed audit row's trigger.
 * `record` itself is pinned end to end in
 * `__tests__/project-context-repository-sync-activities.test.ts`.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/activities/lib/__tests__/context-sync-record.test.ts
 */
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ recordAuditTx: vi.fn() }));
vi.mock("@repo/database", () => ({ recordAuditTx: m.recordAuditTx }));

import type { Prisma } from "@repo/database";
import type { ContextSyncTrigger } from "../../../lib/context-sync-types";
import {
	type ContextSyncRunCounts,
	deriveContextSyncRunVerdict,
	deriveContextSyncScheduling,
	EMPTY_CONTEXT_SYNC_RUN_COUNTS,
	recordContextSyncCompletedAudit,
	tallyContextSyncRun,
} from "../context-sync-record";

function counts(overrides: Partial<ContextSyncRunCounts> = {}) {
	return { ...EMPTY_CONTEXT_SYNC_RUN_COUNTS, ...overrides };
}

describe("tallyContextSyncRun", () => {
	it("tallies the apply ledger, the prune counts and the plan's attention", () => {
		expect(
			tallyContextSyncRun({
				plan: {
					keptCount: 6,
					excludedCount: 0,
					attentionCount: 4,
					attention: [],
					protectedPrefixes: [],
					missingPaths: [],
					keptKeys: [],
					protectedKeys: [],
				},
				outcomes: {
					a: "created",
					b: "created",
					c: "updated",
					d: "adopted",
					e: "unchanged",
					f: "conflict",
					g: "path-in-use",
				},
				removedCount: 5,
				pruneConflicts: { keys: ["x", "y"], overflow: 3 },
			}),
		).toEqual({
			created: 2,
			updated: 1,
			adopted: 1,
			unchanged: 1,
			conflict: 1,
			pathInUse: 1,
			removed: 5,
			pruneConflicts: 5,
			attention: 4,
		});
	});

	it("reads a run with no plan receipt as no attention", () => {
		expect(
			tallyContextSyncRun({
				plan: null,
				outcomes: {},
				removedCount: 0,
				pruneConflicts: { keys: [], overflow: 0 },
			}),
		).toEqual(EMPTY_CONTEXT_SYNC_RUN_COUNTS);
	});
});

describe("deriveContextSyncRunVerdict (§5.4)", () => {
	it.each([
		// Never begun: nothing can have been written.
		[{ begun: false, error: "STORE_FAILED" }, "FAILED", "STORE_FAILED"],
		[{ begun: false, cancelled: true }, "FAILED", "INTERRUPTED"],
		[{ begun: false }, "FAILED", "STORE_FAILED"],
		// A typed failure or refusal wins over everything the ledger says.
		[
			{ error: "LIMITS_EXCEEDED", counts: counts({ created: 3 }) },
			"FAILED",
			"LIMITS_EXCEEDED",
		],
		[{ error: "SUPERSEDED", cancelled: true }, "FAILED", "SUPERSEDED"],
		// A cancelled run stopped before pruning and indexing.
		[
			{ cancelled: true, counts: counts({ created: 3 }) },
			"FAILED",
			"INTERRUPTED",
		],
		[{ counts: counts({ attention: 1, created: 9 }) }, "PARTIAL", null],
		[{ counts: counts({ conflict: 1 }) }, "PARTIAL", null],
		[{ counts: counts({ pathInUse: 1 }) }, "PARTIAL", null],
		[{ counts: counts({ pruneConflicts: 1 }) }, "PARTIAL", null],
		[{ counts: counts({ created: 1 }) }, "SUCCEEDED", null],
		[{ counts: counts({ updated: 1 }) }, "SUCCEEDED", null],
		[{ counts: counts({ adopted: 1 }) }, "SUCCEEDED", null],
		[{ counts: counts({ removed: 1 }) }, "SUCCEEDED", null],
		[{ counts: counts({ unchanged: 7 }) }, "UNCHANGED", null],
		[{}, "UNCHANGED", null],
	] as const)("%j → %s %s", (input, status, error) => {
		expect(
			deriveContextSyncRunVerdict({
				begun: true,
				error: null,
				cancelled: false,
				counts: counts(),
				...input,
			}),
		).toEqual({ status, error });
	});
});

describe("deriveContextSyncScheduling (§11.1)", () => {
	const SHA = "c".repeat(40);
	it.each([
		// The head was applied: evaluated, whichever trigger ran it.
		["MANUAL", "SUCCEEDED", null, SHA, { kind: "success", commitSha: SHA }],
		["POLL", "UNCHANGED", null, SHA, { kind: "success", commitSha: SHA }],
		// Every file it could was applied; the same head would leave the
		// same files needing attention.
		["WEBHOOK", "PARTIAL", null, SHA, { kind: "success", commitSha: SHA }],
		// Too big: not retried at that head, unless none was pinned.
		[
			"POLL",
			"FAILED",
			"LIMITS_EXCEEDED",
			SHA,
			{ kind: "suppress", commitSha: SHA },
		],
		["POLL", "FAILED", "LIMITS_EXCEEDED", null, { kind: "backoff" }],
		[
			"POLL",
			"FAILED",
			"REF_MISSING",
			null,
			{ kind: "pause", reason: "REF_MISSING" },
		],
		// No selected path at the head: the twin of ROOT_MISSING.
		[
			"WEBHOOK",
			"FAILED",
			"PATHS_MISSING",
			SHA,
			{ kind: "pause", reason: "REF_MISSING" },
		],
		// A manual run never pauses automatic sync or backs it off: a
		// member's "Sync now" leaves the schedule the automatic runs set.
		["MANUAL", "FAILED", "PATHS_MISSING", SHA, { kind: "none" }],
		["MANUAL", "FAILED", "REF_MISSING", null, { kind: "none" }],
		["MANUAL", "FAILED", "CLONE_FAILED", null, { kind: "none" }],
		["MANUAL", "FAILED", "STORE_FAILED", SHA, { kind: "none" }],
		["MANUAL", "FAILED", "INTEGRATION_UNAVAILABLE", null, { kind: "none" }],
		["MANUAL", "FAILED", "INTERRUPTED", null, { kind: "none" }],
		["MANUAL", "FAILED", "LIMITS_EXCEEDED", null, { kind: "none" }],
		// ...but a pinned head it failed on is still not retried by the poll.
		[
			"MANUAL",
			"FAILED",
			"LIMITS_EXCEEDED",
			SHA,
			{ kind: "suppress", commitSha: SHA },
		],
		// A revoked member pauses only automatic sync: a manual run's
		// requester is not the configuration's member.
		[
			"WEBHOOK",
			"FAILED",
			"PERMISSION_DENIED",
			null,
			{ kind: "pause", reason: "PERMISSION_REVOKED" },
		],
		[
			"POLL",
			"FAILED",
			"PERMISSION_DENIED",
			null,
			{ kind: "pause", reason: "PERMISSION_REVOKED" },
		],
		["MANUAL", "FAILED", "PERMISSION_DENIED", null, { kind: "none" }],
		// Another configuration or another run owns the schedule.
		["POLL", "FAILED", "CONFIGURATION_CHANGED", null, { kind: "none" }],
		["POLL", "FAILED", "SUPERSEDED", null, { kind: "none" }],
		["POLL", "FAILED", "RUN_IN_PROGRESS", null, { kind: "none" }],
		["POLL", "FAILED", "NOT_CONFIGURED", null, { kind: "none" }],
		// Anything else is transient.
		["POLL", "FAILED", "CLONE_FAILED", null, { kind: "backoff" }],
		["POLL", "FAILED", "STORE_FAILED", SHA, { kind: "backoff" }],
		[
			"POLL",
			"FAILED",
			"INTEGRATION_UNAVAILABLE",
			null,
			{ kind: "backoff" },
		],
		["POLL", "FAILED", "INTERRUPTED", null, { kind: "backoff" }],
		["WEBHOOK", "FAILED", "STORE_FAILED", SHA, { kind: "backoff" }],
	] as const)(
		"%s %s %s (commit %s) → %j",
		(trigger, status, error, commitSha, effect) => {
			expect(
				deriveContextSyncScheduling({
					trigger,
					status,
					error,
					commitSha,
				}),
			).toEqual(effect);
		},
	);
});

describe("recordContextSyncCompletedAudit", () => {
	it.each(["MANUAL", "POLL", "WEBHOOK"] as const)(
		"carries the run's own trigger (%s) in the completed audit row",
		async (trigger: ContextSyncTrigger) => {
			m.recordAuditTx.mockClear();
			const tx = {} as Prisma.TransactionClient;

			await recordContextSyncCompletedAudit(tx, {
				projectId: "proj-1",
				organizationId: "org-1",
				syncId: "sync-1",
				runKey: "sync-1:run-a",
				actingUserId: "user-1",
				trigger,
				repository: "example-org/handbook",
				status: "UNCHANGED",
				error: null,
				commitSha: null,
				counts: counts(),
			});

			expect(m.recordAuditTx).toHaveBeenCalledWith(
				tx,
				expect.objectContaining({
					action: "project.context.repository_sync_completed",
					metadata: expect.objectContaining({ trigger }),
				}),
			);
		},
	);
});
