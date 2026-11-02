/**
 * Weave Execution Watchdog Workflow
 *
 * Cron-driven safety net for Weave/CodingRun rows whose workflows exited
 * ungracefully and never got their non-cancellable cleanup block to run
 * (force-terminated by `workflowExecutionTimeout`, worker crash, OOM,
 * dropped connection).
 *
 * Runs every 5 minutes on the `fabric-worker` queue, fetches up to
 * `batchSize` non-terminal rows whose `startedAt` is older than the
 * configured ceiling, signals each owning workflow to cancel, falls
 * through to `terminate` when the signal goes unacknowledged, calls the
 * provider cleanup directly, and flips the DB row to
 * `TERMINATED_STALE` with an audit-log entry.
 */

import { log, patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const {
	findStaleWeaveSessions,
	findStaleWeaveSessionsWithRuntime,
	cancelWeaveExecutionViaSignal,
	terminateWeaveWorkflow,
	cleanupWeaveResourcesActivity,
	markWeaveExecutionStale,
	cleanupRemoteWeaveResourcesActivity,
	markClosedCodingRunRecoveryRequired,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

export interface WeaveExecutionWatchdogInput {
	/**
	 * Rows whose `startedAt` is older than this many minutes are
	 * considered stale. Defaults to `WEAVE_MAX_RUN_MINUTES` (or 120 when
	 * unset). The default applies even when the caller passes `0` — that
	 * would otherwise nuke every in-flight row, which is never what we
	 * want from a scheduled cron.
	 */
	staleAfterMinutes?: number;
	/**
	 * Max rows per table per tick — keeps each watchdog run bounded so
	 * a backlog never blows past the 2-minute activity timeout.
	 */
	batchSize?: number;
}

export interface WeaveExecutionWatchdogOutput {
	killedWeave: number;
	killedCodingRun: number;
	scanned: number;
}

export async function weaveExecutionWatchdogWorkflow(
	input: WeaveExecutionWatchdogInput = {},
): Promise<WeaveExecutionWatchdogOutput> {
	const confirmedCleanup = patched("fabric-agents-watchdog-cancellation-v2");
	// `process.env` reads are non-deterministic in Temporal workflows
	// under SDK 1.16 + reuseV8Context — so the env-or-default fallback
	// for `staleAfterMinutes` lives inside `findStaleWeaveSessions`
	// instead. Pass 0 / undefined here and the activity reads
	// `WEAVE_MAX_RUN_MINUTES` and defaults to 120.
	const staleAfterMinutes =
		input.staleAfterMinutes && input.staleAfterMinutes > 0
			? input.staleAfterMinutes
			: 0;
	const batchSize =
		input.batchSize && input.batchSize > 0 ? input.batchSize : 50;

	const stale = await (confirmedCleanup
		? findStaleWeaveSessionsWithRuntime
		: findStaleWeaveSessions)({
		staleAfterMinutes,
		batchSize,
	});

	let killedWeave = 0;
	let killedCodingRun = 0;

	for (const row of stale.rows) {
		try {
			const signalled = await cancelWeaveExecutionViaSignal({
				workflowId: row.workflowId,
				kind: row.kind,
			});
			if (!signalled) {
				await terminateWeaveWorkflow({
					workflowId: row.workflowId,
					reason: "watchdog_stale",
				});
			}

			// Call provider cleanup directly — the workflow may have died
			// before its own finally ran, so we can't rely on the polite
			// path having torn the session down.
			const remoteTarget = (
				row.providerMetadata as
					| { executionTarget?: { connectionId?: string } }
					| undefined
			)?.executionTarget?.connectionId;
			const cleanupActivity =
				confirmedCleanup && remoteTarget
					? cleanupRemoteWeaveResourcesActivity
					: cleanupWeaveResourcesActivity;
			let cleanup: Awaited<
				ReturnType<typeof cleanupWeaveResourcesActivity>
			>;
			try {
				cleanup = await cleanupActivity({
					sessionId: row.sessionId,
					provider: row.provider,
					...(confirmedCleanup && row.providerMetadata
						? { providerMetadata: row.providerMetadata }
						: {}),
					userId: row.userId,
					organizationId: row.organizationId,
					weaveExecutionId: row.kind === "weave" ? row.id : null,
					codingRunId: row.kind === "coding_run" ? row.id : null,
					exitReason: "timeout",
					workflowId: row.workflowId,
					runDurationMs: Date.now() - row.startedAtMs,
				});
			} catch (error) {
				if (
					confirmedCleanup &&
					row.kind === "coding_run" &&
					row.sessionId &&
					row.requiresConfirmedCleanup
				) {
					await markClosedCodingRunRecoveryRequired({
						codingRunId: row.id,
						workflowId: row.workflowId,
						organizationId: row.organizationId,
					});
					continue;
				}
				throw error;
			}

			if (
				confirmedCleanup &&
				row.sessionId &&
				row.requiresConfirmedCleanup &&
				!cleanup.destroyed
			) {
				log.warn("native_watchdog_cancellation_unconfirmed", {
					id: row.id,
				});
				if (row.kind === "coding_run") {
					await markClosedCodingRunRecoveryRequired({
						codingRunId: row.id,
						workflowId: row.workflowId,
						organizationId: row.organizationId,
					});
				}
				continue;
			}
			await markWeaveExecutionStale({
				kind: row.kind,
				id: row.id,
				organizationId: row.organizationId,
				sessionId: row.sessionId,
				runDurationMs: Date.now() - row.startedAtMs,
			});

			if (row.kind === "weave") {
				killedWeave++;
			} else {
				killedCodingRun++;
			}
		} catch (err) {
			log.error("weave_watchdog_row_failed", {
				id: row.id,
				kind: row.kind,
				workflowId: row.workflowId,
				error: err instanceof Error ? err.message : String(err),
			});
			// Continue — one bad row must not stop the sweep.
		}
	}

	log.info("weave_watchdog_completed", {
		killedWeave,
		killedCodingRun,
		scanned: stale.rows.length,
		staleAfterMinutes,
		batchSize,
	});

	return { killedWeave, killedCodingRun, scanned: stale.rows.length };
}
