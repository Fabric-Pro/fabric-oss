/**
 * `cleanupAbandonedDraftsActivity` — Unified Context Uploader Wizard.
 *
 * Sweeps DRAFT `Project` rows abandoned for more than `cutoffDays` (default
 * 14) and:
 *   1. Cancels every in-flight URL crawl Temporal workflow on the DRAFT
 *      (LINK rows with `extractionStatus IN ('PENDING', 'EXTRACTING')`
 *      AND `urlActiveWorkflowId IS NOT NULL`). `not found` from the
 *      Temporal handle is tolerated — the workflow already finalized
 *      between query and cancel.
 *   2. Soft-deletes the DRAFT via `softDeleteProject(...)` so the existing
 *      7-day retention cron (`projectDeleteCleanupWorkflow`) eventually
 *      reaps the row + Qdrant vectors.
 *
 * Deliberately **silent**. No `Notification` rows are written for
 * cancelled crawls (the user has already abandoned the DRAFT; surfacing
 * "we cancelled N crawls on a DRAFT you forgot about" is noise).
 *
 * Per `fabric/standards/backend/temporal.md`: cancellation calls are
 * side-effecting work and live in this activity, never in the workflow
 * body. The workflow stays trivially deterministic.
 *
 * Sibling pattern to:
 *   - `cleanupWizardTempContextsActivity` (hourly, file rows only).
 *   - `projectDeleteCleanupWorkflow` activities (post-soft-delete sweep).
 *
 * The classifier `findAbandonedDrafts(now, cutoffDays)` is exported as a
 * pure function so the boundary condition tests can run
 * without DB / Temporal infrastructure.
 */

import { db, softDeleteProject } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { getTemporalClient } from "../../client";

/** Default abandonment cutoff — doubled from the 7-day "Continue draft" banner. */
const DEFAULT_CUTOFF_DAYS = 14;

/** Batch ceiling per workflow run — cron fires daily, so any back-pressure self-corrects within 24h. */
const DEFAULT_BATCH_SIZE = 50;

/**
 * Compact shape used by both the classifier (`findAbandonedDrafts`) and
 * the inner soft-delete loop. Keeps the heavy `Prisma.ProjectGetPayload`
 * type out of the activity boundary so the classifier can be exercised
 * with a fixture in tests.
 */
export interface DraftProjectCandidate {
	id: string;
	userId: string;
	organizationId: string | null;
	updatedAt: Date;
	status: "DRAFT" | "ACTIVE" | "ARCHIVED";
	deletedAt: Date | null;
}

/**
 * In-flight LINK row to cancel. The fields are exactly what we need for
 * the Temporal cancel call + post-cancel logging.
 */
export interface InFlightLinkRow {
	id: string;
	projectId: string;
	urlActiveWorkflowId: string;
}

export interface CleanupAbandonedDraftsInput {
	/** Override cutoff in days. Default = 14. */
	cutoffDays?: number;
	/** Override per-run batch ceiling. Default = 50. */
	batchSize?: number;
}

export interface CleanupAbandonedDraftsOutput {
	draftsDeleted: number;
	workflowsCancelled: number;
	errors: Array<{
		/** Either the projectId or the contextId, depending on where the failure was raised. */
		id: string;
		/** Stable kind so callers can tell what failed. */
		kind: "cancel" | "soft-delete";
		message: string;
	}>;
}

/**
 * Pure-function classifier — given a `now` and the cutoff window, returns
 * the subset of `drafts` that qualify for cleanup. Exported solely so unit
 * tests can exercise the boundary condition (exactly 14 days = exclude;
 * 14 days + 1ms = include; soft-deleted = exclude; non-DRAFT = exclude).
 *
 * Mirrors the Prisma `where` clause from the activity body — keep in
 * lock-step or the boundary test catches the drift.
 */
export function findAbandonedDrafts(
	drafts: DraftProjectCandidate[],
	now: Date,
	cutoffDays: number = DEFAULT_CUTOFF_DAYS,
): DraftProjectCandidate[] {
	const cutoff = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);
	return drafts.filter(
		(d) =>
			d.status === "DRAFT" &&
			d.deletedAt === null &&
			// Strict `<` matches the Prisma `{ lt: cutoff }` filter — at exactly
			// the boundary the row is excluded. This is the assertion in test (a).
			d.updatedAt.getTime() < cutoff.getTime(),
	);
}

/**
 * Schedule-driven sweep activity. Idempotent — re-running just finds
 * whatever still qualifies under the cutoff at the new `now`.
 *
 * Heartbeats every ~30s while the loop is running so the configured
 * 10-minute startToCloseTimeout is enforced via the heartbeat-timeout
 * surface (5m / 30s) instead of silently swallowing a hung worker. Per
 * `fabric/standards/backend/temporal.md`: heartbeats are the only safe
 * signal Temporal has into long activities.
 */
export async function cleanupAbandonedDraftsActivity(
	input: CleanupAbandonedDraftsInput = {},
): Promise<CleanupAbandonedDraftsOutput> {
	const cutoffDays = input.cutoffDays ?? DEFAULT_CUTOFF_DAYS;
	const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;

	// Read `now` exactly once so a long sweep doesn't see the cutoff move
	// underneath it (otherwise a DRAFT that's right at the boundary could
	// be queried in twice in the same run).
	const now = new Date();
	const cutoff = new Date(now.getTime() - cutoffDays * 24 * 60 * 60 * 1000);

	logger.info(
		`[DraftProjectCleanup] Sweep started — cutoffDays=${cutoffDays} cutoffAt=${cutoff.toISOString()} batchSize=${batchSize}`,
	);

	// Heartbeat ticker — swallow errors from outside a Temporal activity
	// context (Vitest) so tests can call the activity directly.
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat();
		} catch {
			// Outside an activity context (tests). Silent.
		}
	}, 30_000);

	const errors: CleanupAbandonedDraftsOutput["errors"] = [];
	let draftsDeleted = 0;
	let workflowsCancelled = 0;

	try {
		// Step 1: find candidates. Single query with the cutoff baked in.
		// The pure-function classifier is what the unit test exercises;
		// the production path runs the same predicate in Postgres for
		// efficiency.
		const candidates = await db.project.findMany({
			where: {
				status: "DRAFT",
				deletedAt: null,
				updatedAt: { lt: cutoff },
			},
			select: {
				id: true,
				userId: true,
				organizationId: true,
				updatedAt: true,
				status: true,
				deletedAt: true,
			},
			orderBy: { updatedAt: "asc" },
			take: batchSize,
		});

		if (candidates.length === 0) {
			logger.info(
				"[DraftProjectCleanup] No abandoned DRAFTs found — sweep is a no-op.",
			);
			return {
				draftsDeleted: 0,
				workflowsCancelled: 0,
				errors: [],
			};
		}

		logger.info(
			`[DraftProjectCleanup] Found ${candidates.length} abandoned DRAFT(s) to process`,
		);

		// Lazy-resolve the Temporal client — only pay the cost when we
		// actually have a candidate. Reused across all candidates in the
		// batch; the SDK pools the underlying connection.
		let temporalClient: Awaited<
			ReturnType<typeof getTemporalClient>
		> | null = null;

		for (const draft of candidates) {
			// Per-draft heartbeat so a slow Postgres or Temporal call still
			// keeps the worker visible to the server.
			try {
				heartbeat();
			} catch {
				/* outside activity context */
			}

			// Step 2: enumerate in-flight LINK workflows for this draft.
			let inFlight: InFlightLinkRow[] = [];
			try {
				const rows = await db.projectContext.findMany({
					where: {
						projectId: draft.id,
						type: "LINK",
						extractionStatus: { in: ["PENDING", "EXTRACTING"] },
						urlActiveWorkflowId: { not: null },
					},
					select: {
						id: true,
						projectId: true,
						urlActiveWorkflowId: true,
					},
				});
				// Narrow the nullable for TS — Prisma's `not: null` filter
				// doesn't propagate to the select inference.
				inFlight = rows
					.filter((r) => r.urlActiveWorkflowId !== null)
					.map((r) => ({
						id: r.id,
						projectId: r.projectId,
						urlActiveWorkflowId: r.urlActiveWorkflowId as string,
					}));
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				logger.error(
					`[DraftProjectCleanup] Failed to enumerate LINK rows for DRAFT ${draft.id}: ${message}`,
				);
				errors.push({ id: draft.id, kind: "cancel", message });
				// Skip soft-delete too — we can't safely abandon
				// workflows we never tried to cancel. Next sweep retries.
				continue;
			}

			// Step 3: per-row cancel loop. Identical contract to
			// `cancel-draft-crawls.ts` (the on-demand sibling).
			if (inFlight.length > 0) {
				if (temporalClient === null) {
					temporalClient = await getTemporalClient();
				}

				for (const row of inFlight) {
					try {
						const handle = temporalClient.workflow.getHandle(
							row.urlActiveWorkflowId,
						);
						await handle.cancel();
						workflowsCancelled++;
						logger.info(
							`[DraftProjectCleanup] Cancelled workflow ${row.urlActiveWorkflowId} on DRAFT ${draft.id} context ${row.id}`,
						);
					} catch (error) {
						const message =
							error instanceof Error
								? error.message
								: "Unknown error";
						// Same race-with-completion handling as
						// `cancel-draft-crawls.ts`: workflow finalized between
						// our query and the cancel — count as cancelled.
						if (/not\s+found/i.test(message)) {
							workflowsCancelled++;
							logger.warn(
								`[DraftProjectCleanup] Workflow ${row.urlActiveWorkflowId} not found — likely completed; treating as silent success`,
							);
							continue;
						}
						logger.error(
							`[DraftProjectCleanup] Failed to cancel ${row.urlActiveWorkflowId} on DRAFT ${draft.id} context ${row.id}: ${message}`,
						);
						errors.push({ id: row.id, kind: "cancel", message });
					}
				}
			}

			// Step 4: soft-delete the DRAFT. Even if some cancels failed,
			// proceed — the workflows are best-effort cancellable; the
			// soft-delete is the durable signal that this DRAFT is gone.
			try {
				await softDeleteProject(
					draft.id,
					draft.userId,
					draft.organizationId ?? undefined,
				);
				draftsDeleted++;
				logger.info(
					`[DraftProjectCleanup] Soft-deleted abandoned DRAFT ${draft.id}`,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				logger.error(
					`[DraftProjectCleanup] Failed to soft-delete DRAFT ${draft.id}: ${message}`,
				);
				errors.push({ id: draft.id, kind: "soft-delete", message });
				// Continue with remaining drafts — one failure must not
				// abort the batch.
			}
		}

		logger.info(
			`[DraftProjectCleanup] Sweep complete — draftsDeleted=${draftsDeleted} workflowsCancelled=${workflowsCancelled} errorCount=${errors.length}`,
		);

		return {
			draftsDeleted,
			workflowsCancelled,
			errors,
		};
	} finally {
		clearInterval(heartbeatInterval);
	}
}
