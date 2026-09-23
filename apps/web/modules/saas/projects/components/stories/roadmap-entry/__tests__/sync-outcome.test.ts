import { describe, expect, it } from "vitest";
import {
	describeSyncOutcome,
	MAX_JOB_CLOSE_GRACE_POLLS,
	type SyncProgressSnapshot,
	shouldAwaitJobClose,
} from "../sync-outcome";

function progress(
	overrides: Partial<SyncProgressSnapshot> = {},
): SyncProgressSnapshot {
	return {
		status: "completed",
		syncedCount: 0,
		failedCount: 0,
		conflictedCount: 0,
		message: "Sync completed",
		...overrides,
	};
}

const base = { direction: "pull" as const, pmToolName: "Jira" };

describe("describeSyncOutcome — FR44 no new work items", () => {
	it("says 'No new work items' for a confirmed pull that found nothing", () => {
		expect(
			describeSyncOutcome({
				...base,
				progress: progress(),
				jobStatus: "COMPLETED",
			}),
		).toEqual({
			tone: "success",
			title: "No new work items",
			description: "Your Roadmap already has everything from Jira.",
		});
	});

	it("keeps the generic 'Sync finished' when the job row never confirmed it", () => {
		expect(
			describeSyncOutcome({
				...base,
				progress: progress(),
				jobStatus: null,
			}),
		).toEqual({ tone: "success", title: "Sync finished" });
	});

	it("keeps the generic copy for an empty push", () => {
		expect(
			describeSyncOutcome({
				...base,
				direction: "push",
				progress: progress(),
				jobStatus: "COMPLETED",
			}).title,
		).toBe("Sync finished");
	});
});

describe("describeSyncOutcome — existing copy unchanged", () => {
	it("routes conflicts to the Review Center", () => {
		const spec = describeSyncOutcome({
			...base,
			progress: progress({
				syncedCount: 2,
				conflictedCount: 1,
				failedCount: 1,
			}),
			jobStatus: "COMPLETED",
		});
		expect(spec).toEqual({
			tone: "warning",
			title: "Sync finished — 2 synced · 1 need review · 1 failed",
			description:
				"1 item changed in Jira since the last sync. Choose which version to keep in the Review Center.",
			reviewConflicts: true,
			duration: 10000,
		});
	});

	it("reports a partial failure as an error", () => {
		expect(
			describeSyncOutcome({
				...base,
				progress: progress({
					syncedCount: 3,
					failedCount: 2,
					message: "2 failed",
				}),
				jobStatus: "COMPLETED",
			}),
		).toEqual({
			tone: "error",
			title: "Sync finished — 3 synced · 2 failed",
			description: "2 failed",
		});
	});

	it("counts synced items with the direction's preposition", () => {
		expect(
			describeSyncOutcome({
				...base,
				progress: progress({ syncedCount: 4 }),
				jobStatus: "COMPLETED",
			}).title,
		).toBe("Synced 4 stories from Jira");
		expect(
			describeSyncOutcome({
				...base,
				direction: "push",
				progress: progress({ syncedCount: 1 }),
				jobStatus: null,
			}).title,
		).toBe("Synced 1 stories to Jira");
	});

	it("reports cancelled and failed runs", () => {
		expect(
			describeSyncOutcome({
				...base,
				progress: progress({ status: "cancelled" }),
				jobStatus: "FAILED",
			}),
		).toEqual({ tone: "info", title: "Sync cancelled" });
		expect(
			describeSyncOutcome({
				...base,
				progress: progress({ status: "failed", message: "boom" }),
				jobStatus: "FAILED",
			}),
		).toEqual({ tone: "error", title: "Sync failed", description: "boom" });
	});
});

describe("shouldAwaitJobClose — bounded grace polls", () => {
	it("waits while a completed run's row is still RUNNING or missing", () => {
		expect(shouldAwaitJobClose(progress(), "RUNNING", 0)).toBe(true);
		expect(shouldAwaitJobClose(progress(), null, 3)).toBe(true);
	});

	it("stops waiting once the row closes", () => {
		expect(shouldAwaitJobClose(progress(), "COMPLETED", 0)).toBe(false);
		expect(shouldAwaitJobClose(progress(), "FAILED", 0)).toBe(false);
	});

	it("gives up after the grace budget", () => {
		expect(
			shouldAwaitJobClose(
				progress(),
				"RUNNING",
				MAX_JOB_CLOSE_GRACE_POLLS,
			),
		).toBe(false);
	});

	it("never waits on a failed or cancelled run", () => {
		expect(
			shouldAwaitJobClose(progress({ status: "failed" }), "RUNNING", 0),
		).toBe(false);
		expect(
			shouldAwaitJobClose(progress({ status: "cancelled" }), null, 0),
		).toBe(false);
	});
});
