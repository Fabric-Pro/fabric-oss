/**
 * Tests for the URL-source schedule reconciliation activity
 * (`packages/temporal/src/activities/url-source/reconcile-schedules-activity.ts`).
 *
 * Two layers:
 *   1. `classifyScheduleOrphan` — pure orphan-classifier.
 *   2. `reconcileUrlSourceSchedules` — internal worker that takes
 *      explicit list/delete/fetch dependencies so we can stub the whole
 *      Temporal + Prisma stack with vi.fn().
 */
import { describe, expect, it, vi } from "vitest";
import {
	classifyScheduleOrphan,
	reconcileUrlSourceSchedules,
} from "../../src/activities/url-source/reconcile-schedules-activity";

describe("classifyScheduleOrphan", () => {
	it("flags missing rows as 'missing-row'", () => {
		expect(
			classifyScheduleOrphan({
				scheduleId: "url-source-schedule-ctx-1",
				row: null,
			}),
		).toBe("missing-row");
	});

	it("flags rows whose mode is ONCE/LIVE/null as 'non-scheduled-mode'", () => {
		for (const mode of [null, "ONCE", "LIVE"]) {
			expect(
				classifyScheduleOrphan({
					scheduleId: "url-source-schedule-ctx-1",
					row: {
						urlRefreshMode: mode,
						urlScheduleId: "url-source-schedule-ctx-1",
					},
				}),
			).toBe("non-scheduled-mode");
		}
	});

	it("flags rows whose persisted urlScheduleId mismatches as 'id-mismatch'", () => {
		expect(
			classifyScheduleOrphan({
				scheduleId: "url-source-schedule-ctx-1",
				row: {
					urlRefreshMode: "DAILY",
					urlScheduleId: "url-source-schedule-ctx-OTHER",
				},
			}),
		).toBe("id-mismatch");
	});

	it("returns null for healthy rows", () => {
		expect(
			classifyScheduleOrphan({
				scheduleId: "url-source-schedule-ctx-1",
				row: {
					urlRefreshMode: "WEEKLY",
					urlScheduleId: "url-source-schedule-ctx-1",
				},
			}),
		).toBeNull();
	});
});

describe("reconcileUrlSourceSchedules — worker", () => {
	function makeSchedules(ids: string[]) {
		return async function* () {
			for (const id of ids) {
				yield { scheduleId: id } as never;
			}
		};
	}

	it("deletes orphan schedules and keeps healthy ones", async () => {
		const fetchContext = vi.fn(async (contextId: string) => {
			if (contextId === "ctx-healthy") {
				return {
					urlRefreshMode: "DAILY",
					urlScheduleId: "url-source-schedule-ctx-healthy",
				};
			}
			if (contextId === "ctx-non-scheduled") {
				return {
					urlRefreshMode: "ONCE",
					urlScheduleId: null,
				};
			}
			if (contextId === "ctx-mismatched") {
				return {
					urlRefreshMode: "WEEKLY",
					urlScheduleId: "url-source-schedule-ctx-OTHER",
				};
			}
			// ctx-missing: no row at all
			return null;
		});

		const deleteSchedule = vi.fn().mockResolvedValue(undefined);

		const result = await reconcileUrlSourceSchedules({
			listSchedules: makeSchedules([
				"url-source-schedule-ctx-healthy",
				"url-source-schedule-ctx-non-scheduled",
				"url-source-schedule-ctx-mismatched",
				"url-source-schedule-ctx-missing",
				// Foreign schedule — should be ignored even if listing leaks it.
				"agent-health-monitor",
			]),
			deleteSchedule,
			fetchContext,
			dryRun: false,
		});

		expect(result.scanned).toBe(4);
		expect(result.orphansDeleted).toBe(3);
		expect(deleteSchedule).toHaveBeenCalledTimes(3);
		expect(deleteSchedule).toHaveBeenCalledWith(
			"url-source-schedule-ctx-non-scheduled",
		);
		expect(deleteSchedule).toHaveBeenCalledWith(
			"url-source-schedule-ctx-mismatched",
		);
		expect(deleteSchedule).toHaveBeenCalledWith(
			"url-source-schedule-ctx-missing",
		);
		expect(deleteSchedule).not.toHaveBeenCalledWith(
			"url-source-schedule-ctx-healthy",
		);
	});

	it("dryRun: counts orphans but performs no deletes", async () => {
		const fetchContext = vi.fn().mockResolvedValue(null); // every row missing
		const deleteSchedule = vi.fn().mockResolvedValue(undefined);

		const result = await reconcileUrlSourceSchedules({
			listSchedules: makeSchedules([
				"url-source-schedule-ctx-1",
				"url-source-schedule-ctx-2",
			]),
			deleteSchedule,
			fetchContext,
			dryRun: true,
		});

		expect(result.scanned).toBe(2);
		expect(result.orphansDeleted).toBe(2);
		expect(result.dryRun).toBe(true);
		expect(deleteSchedule).not.toHaveBeenCalled();
	});

	it("returns scanned:0 when no schedules match the prefix", async () => {
		const fetchContext = vi.fn();
		const deleteSchedule = vi.fn();
		const result = await reconcileUrlSourceSchedules({
			listSchedules: makeSchedules([
				"agent-health-monitor",
				"project-delete-cleanup",
			]),
			deleteSchedule,
			fetchContext,
			dryRun: false,
		});

		expect(result.scanned).toBe(0);
		expect(result.orphansDeleted).toBe(0);
		expect(fetchContext).not.toHaveBeenCalled();
	});

	it("heartbeats with running totals when a callback is provided", async () => {
		const heartbeat = vi.fn();
		const result = await reconcileUrlSourceSchedules({
			listSchedules: makeSchedules([
				"url-source-schedule-ctx-a",
				"url-source-schedule-ctx-b",
			]),
			deleteSchedule: vi.fn().mockResolvedValue(undefined),
			fetchContext: vi.fn().mockResolvedValue(null),
			dryRun: false,
			heartbeat,
		});

		expect(result.scanned).toBe(2);
		expect(heartbeat).toHaveBeenCalledTimes(2);
		expect(heartbeat.mock.calls[1][0]).toMatchObject({
			scanned: 2,
			orphansDeleted: 1,
		});
	});
});
