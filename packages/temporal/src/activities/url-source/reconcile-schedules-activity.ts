/**
 * Reconciliation Activity: prune orphaned URL-source schedules.
 *
 * Iterates every Temporal Schedule whose ID begins with
 * `url-source-schedule-` and checks against the corresponding
 * `ProjectContext` row. A schedule is considered an orphan when any of:
 *   - The context row no longer exists (hard-deleted bypassed the post-
 *     delete hook).
 *   - The context row's `urlRefreshMode` is no longer scheduled (ONCE or
 *     LIVE) — the schedule should have been deleted on the cadence change.
 *   - The context row's persisted `urlScheduleId` doesn't match the
 *     schedule we found (drift: two schedules for one row).
 *
 * The activity heartbeats so the workflow timer doesn't fire mid-scan in
 * orgs with thousands of contexts. Idempotent: re-running on a clean DB
 * makes zero changes.
 */

import { Context } from "@temporalio/activity";
import type { ScheduleSummary } from "@temporalio/client";
import { getScheduleClient } from "../../client";
import {
	deleteUrlSourceSchedule,
	parseContextIdFromScheduleId,
} from "../../schedules/url-source-schedule";
import { activityLogger } from "../lib/activity-logger";

const SCHEDULE_ID_PREFIX = "url-source-schedule-";

export interface ReconcileUrlSourceSchedulesActivityInput {
	dryRun: boolean;
}

export interface ReconcileUrlSourceSchedulesActivityOutput {
	scanned: number;
	orphansDeleted: number;
	dryRun: boolean;
}

type ProjectContextFetcher = (contextId: string) => Promise<{
	urlRefreshMode: string | null;
	urlScheduleId: string | null;
} | null>;

/**
 * Default fetcher: pulls the row from `@repo/database` directly. Exported
 * as a parameter on the activity so unit tests can stub it without a
 * Prisma round-trip.
 */
async function defaultProjectContextFetcher(contextId: string): Promise<{
	urlRefreshMode: string | null;
	urlScheduleId: string | null;
} | null> {
	const { db } = await import("@repo/database/prisma/client");
	const row = await db.projectContext.findUnique({
		where: { id: contextId },
		select: {
			urlRefreshMode: true,
			urlScheduleId: true,
		},
	});
	if (!row) {
		return null;
	}
	return {
		urlRefreshMode: row.urlRefreshMode ?? null,
		urlScheduleId: row.urlScheduleId ?? null,
	};
}

const SCHEDULED_MODES = new Set(["DAILY", "WEEKLY", "MONTHLY"]);

/**
 * Pure orphan-classifier used by both the activity and its unit tests.
 * Returns the reason this schedule should be dropped, or null to keep it.
 *
 * Exported so the reconciliation test can exercise the three orphan
 * conditions without the Temporal/Prisma stack.
 */
export function classifyScheduleOrphan(args: {
	scheduleId: string;
	row: { urlRefreshMode: string | null; urlScheduleId: string | null } | null;
}): "missing-row" | "non-scheduled-mode" | "id-mismatch" | null {
	if (!args.row) {
		return "missing-row";
	}
	if (!args.row.urlRefreshMode) {
		return "non-scheduled-mode";
	}
	if (!SCHEDULED_MODES.has(args.row.urlRefreshMode)) {
		return "non-scheduled-mode";
	}
	if (args.row.urlScheduleId !== args.scheduleId) {
		return "id-mismatch";
	}
	return null;
}

/**
 * Internal worker — extracted so tests can call it with a fake schedule
 * list + fake context fetcher without spinning up `@temporalio/client`.
 */
export async function reconcileUrlSourceSchedules(args: {
	listSchedules: () => AsyncIterable<ScheduleSummary>;
	deleteSchedule: (scheduleId: string) => Promise<void>;
	fetchContext: ProjectContextFetcher;
	dryRun: boolean;
	heartbeat?: (details?: unknown) => void;
}): Promise<ReconcileUrlSourceSchedulesActivityOutput> {
	let scanned = 0;
	let orphansDeleted = 0;

	for await (const summary of args.listSchedules()) {
		if (!summary.scheduleId.startsWith(SCHEDULE_ID_PREFIX)) {
			continue;
		}
		scanned++;
		args.heartbeat?.({ scanned, orphansDeleted });

		const contextId = parseContextIdFromScheduleId(summary.scheduleId);
		if (!contextId) {
			continue;
		}

		const row = await args.fetchContext(contextId);
		const reason = classifyScheduleOrphan({
			scheduleId: summary.scheduleId,
			row,
		});
		if (!reason) {
			continue;
		}

		if (!args.dryRun) {
			await args.deleteSchedule(summary.scheduleId);
		}
		orphansDeleted++;
	}

	return {
		scanned,
		orphansDeleted,
		dryRun: args.dryRun,
	};
}

export async function reconcileUrlSourceSchedulesActivity(
	input: ReconcileUrlSourceSchedulesActivityInput,
): Promise<ReconcileUrlSourceSchedulesActivityOutput> {
	activityLogger.info("[ReconcileUrlSourceSchedules] start", {
		dryRun: input.dryRun,
	});

	const scheduleClient = await getScheduleClient();

	const result = await reconcileUrlSourceSchedules({
		listSchedules: () =>
			scheduleClient.list({
				// Server-side query filter to keep the list small; we also
				// filter again client-side to be defensive against indexing
				// gaps in Temporal Cloud.
				query: `ScheduleId STARTS_WITH "${SCHEDULE_ID_PREFIX}"`,
			}),
		deleteSchedule: async (scheduleId) => {
			await deleteUrlSourceSchedule({ scheduleId }, scheduleClient);
		},
		fetchContext: defaultProjectContextFetcher,
		dryRun: input.dryRun,
		heartbeat: (details) => {
			try {
				Context.current().heartbeat(details);
			} catch {
				// Heartbeating outside an activity context (e.g. tests) is OK.
			}
		},
	});

	activityLogger.info("[ReconcileUrlSourceSchedules] done", {
		scanned: result.scanned,
		orphansDeleted: result.orphansDeleted,
		dryRun: result.dryRun,
	});
	return result;
}
