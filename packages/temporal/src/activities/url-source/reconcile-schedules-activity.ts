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
 *
 * Company website sources (Fizzy #2719) use the same schedule id scheme, keyed
 * by their `CompanyContextSource` id. When no `ProjectContext` row matches a
 * schedule's context id, the source table is checked, and the schedule is
 * classified against whichever row exists — so a live company schedule is
 * kept, and one whose source is gone (deleted, or cascaded away with its
 * organization) is removed. Context ids are cuids, unique across both tables.
 * A company source that refreshes on a schedule but records no schedule id is
 * one whose schedule is being created, or whose id could not be recorded: it
 * still wants that schedule, so it is kept.
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

/** The schedule bookkeeping of the row a schedule id names. */
export interface UrlSourceScheduleRow {
	urlRefreshMode: string | null;
	urlScheduleId: string | null;
	/** Set when the row is a company source, not a project context. */
	company?: true;
}

type ProjectContextFetcher = (
	contextId: string,
) => Promise<UrlSourceScheduleRow | null>;

/**
 * Default fetcher: pulls the row from `@repo/database` directly — the
 * `ProjectContext`, or failing that the company source with the same id.
 * Exported so unit tests can exercise the lookup order; the activity takes
 * a fetcher parameter so tests can also stub it without a Prisma round-trip.
 */
export async function fetchUrlSourceScheduleRow(
	contextId: string,
): Promise<UrlSourceScheduleRow | null> {
	const { db } = await import("@repo/database/prisma/client");
	const row = await db.projectContext.findUnique({
		where: { id: contextId },
		select: {
			urlRefreshMode: true,
			urlScheduleId: true,
		},
	});
	if (!row) {
		return fetchCompanyContextSource(contextId);
	}
	return {
		urlRefreshMode: row.urlRefreshMode ?? null,
		urlScheduleId: row.urlScheduleId ?? null,
	};
}

/**
 * The schedule bookkeeping of a company source, by id alone. This sweep has
 * no tenant: the schedule id carries only the context id, and the worker's
 * connection is not bound by row-level security. It reads the two schedule
 * columns and nothing else.
 */
async function fetchCompanyContextSource(
	contextId: string,
): Promise<UrlSourceScheduleRow | null> {
	const { db } = await import("@repo/database/prisma/client");
	const source = await db.companyContextSource.findUnique({
		where: { id: contextId },
		select: {
			urlRefreshMode: true,
			urlScheduleId: true,
		},
	});
	if (!source) {
		return null;
	}
	return {
		urlRefreshMode: source.urlRefreshMode ?? null,
		urlScheduleId: source.urlScheduleId ?? null,
		company: true,
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
	row: UrlSourceScheduleRow | null;
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
		// A company source still wants its schedule while the id is not
		// recorded (see the top of this file). The row was looked up by the
		// id this schedule names, so this is the schedule it would record.
		if (args.row.company && args.row.urlScheduleId === null) {
			return null;
		}
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
		fetchContext: fetchUrlSourceScheduleRow,
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
