/**
 * The Living Memory sync's status table (design 2026-09-23 §5.4) over a
 * run's ledger, as `record` applies it. `record` itself is pinned end to end
 * in `__tests__/project-context-repository-sync-activities.test.ts`.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/activities/lib/__tests__/context-sync-record.test.ts
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ recordAuditTx: vi.fn() }));

import {
	type ContextSyncRunCounts,
	deriveContextSyncRunVerdict,
	EMPTY_CONTEXT_SYNC_RUN_COUNTS,
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
