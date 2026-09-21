/**
 * Writer for `Project.pmStatusSyncLastRun` (Fizzy #2304, spec D2.6).
 *
 * Three activities record into the same JSON: the poll's fetch, its failure
 * paths, and reconcile's outcome counts. Each writes only its own top-level
 * key, so the write is a jsonb merge in ONE statement rather than a
 * read-modify-write that two activities could interleave.
 *
 * Every write is guarded twice in its WHERE clause:
 *   - `pmStatusSyncEnabled = true`: nothing is recorded for a project whose
 *     switch is off;
 *   - `pmStatusSyncSessionAt = sessionAt`: an activity that read the session
 *     before the switch was turned off and on again cannot write its stale
 *     numbers into the new session's summary.
 *
 * Non-fatal by contract: the summary is observability, never a reason to fail
 * a poll. A write that fails, or a patch the schema rejects, is logged and
 * dropped.
 */
import { logger } from "@repo/logs";
import {
	type PmStatusSyncLastRun,
	pmStatusSyncLastRunSchema,
} from "../../src/pm-status-sync-last-run-schema";
import { db } from "../client";

export { type PmStatusSyncLastRun, pmStatusSyncLastRunSchema };

/** A provider error body can be a whole HTML page; the card needs a line. */
const MAX_ERROR_LENGTH = 500;

export async function mergePmStatusSyncLastRun(args: {
	projectId: string;
	sessionAt: Date;
	patch: Omit<Partial<PmStatusSyncLastRun>, "sessionAt">;
}): Promise<void> {
	const { projectId, sessionAt } = args;
	const patch = args.patch.failure
		? {
				...args.patch,
				failure: {
					...args.patch.failure,
					error: args.patch.failure.error.slice(0, MAX_ERROR_LENGTH),
				},
			}
		: args.patch;
	const parsed = pmStatusSyncLastRunSchema.safeParse({
		sessionAt: sessionAt.toISOString(),
		...patch,
	});
	if (!parsed.success) {
		logger.warn(
			{
				event: "pm_status_sync.last_run_rejected",
				projectId,
				issues: parsed.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			},
			"Dropped a PM status-sync last-run patch that does not match the schema",
		);
		return;
	}
	const payload = JSON.stringify(parsed.data);
	try {
		// A non-object value (SQL NULL after a fresh session, or anything
		// else) is replaced rather than merged: jsonb `||` on a scalar builds
		// an array instead of merging keys.
		await db.$executeRaw`
			UPDATE "project"
			SET "pmStatusSyncLastRun" =
				CASE
					WHEN jsonb_typeof("pmStatusSyncLastRun") = 'object' THEN "pmStatusSyncLastRun"
					ELSE '{}'::jsonb
				END || ${payload}::jsonb
			WHERE "id" = ${projectId}
				AND "pmStatusSyncEnabled" = true
				AND "pmStatusSyncSessionAt" = ${sessionAt}
		`;
	} catch (error) {
		// Object-first, message-second — the consola convention used across
		// this directory (see user-last-seen.ts).
		logger.warn(
			{
				event: "pm_status_sync.last_run_write_failed",
				projectId,
				err: {
					message:
						error instanceof Error ? error.message : String(error),
					name: error instanceof Error ? error.name : "UnknownError",
				},
			},
			"Failed to record the PM status-sync last run",
		);
	}
}
