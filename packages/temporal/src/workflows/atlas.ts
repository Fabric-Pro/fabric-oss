/**
 * Atlas analysis workflow.
 *
 * New, standalone workflow (sits beside `codeIndexingWorkflow`; does not modify
 * it — so no `patched()` migration risk). Orchestration only: every side effect
 * lives in an activity. Pipeline:
 *   ANALYZING → structure (clone + build graph + persist)
 *             → describe changed modules (AI)
 *             → derive business capability graph (AI)
 *             → finalize (READY, commit + manifest + counts)
 * On any failure the analysis row is finalized FAILED and the workflow returns
 * cleanly (the DB row is the source of truth for the UI).
 */

import type { AtlasWorkflowInput } from "@repo/atlas";
import {
	ActivityCancellationType,
	CancellationScope,
	isCancellation,
	proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "../activities";

// Clone + walk + build + persist. Big monorepos take a while, so the window is
// generous and the activity emits an interval heartbeat (see `withHeartbeat`) —
// the heartbeat timeout only trips if the worker genuinely dies, not during a
// long but healthy clone/parse. The start-to-close window is sized for a very
// large monorepo (thousands of files → a multi-language parse + graph build that
// can run well past an hour); the heartbeat is what actually detects a dead
// worker, so this generous cap never false-times-out a slow-but-healthy run.
//
// `cancellationType: TRY_CANCEL` so a "Cancel analysis" request unblocks the
// workflow immediately (it delivers the cancel to the activity — which observes
// `Context.current().cancellationSignal` to stop the clone/parse and free its
// ~9GB working set — without waiting for the activity to finish unwinding). The
// CancelledFailure then surfaces into the workflow's catch below.
const { atlasRunStructureActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "90 minutes",
	// The streaming parse yields to the event loop every few dozen files so
	// `withHeartbeat`'s 20s timer keeps firing mid-parse (see
	// `buildTechnicalGraphStreaming`), and bounded per-file reads keep any single
	// file fast — so a short heartbeat timeout never false-times-out a healthy
	// run. 2 minutes detects a genuinely dead worker (OOM, node-scale-down
	// eviction, deploy) in ~2 minutes instead of 30, turning a disruption from a
	// 30-minute stall into a blink before the retry re-drives the clone.
	// (Activity timeout/retry changes are replay-safe — no `patched()` needed.)
	heartbeatTimeout: "2 minutes",
	cancellationType: ActivityCancellationType.TRY_CANCEL,
	retry: {
		initialInterval: "5s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		// A long clone/parse can be disrupted more than once (a node eviction,
		// then a deploy). With ~2-minute heartbeat detection each retry kicks in
		// quickly, so allow several attempts to ride out repeated disruptions
		// rather than failing the whole analysis on the second hit.
		maximumAttempts: 4,
	},
});

// AI activities (describe modules, business/System-Map derivation) — rate-limit-
// aware and interval-heartbeated: the 20s `withHeartbeat` timer fires during the
// awaited provider calls, so a 2-minute heartbeat timeout detects a dead worker
// fast without false-timing-out a slow provider batch. A few attempts so a
// disruption mid-derivation retries rather than failing the analysis.
const { atlasDescribeModulesActivity, atlasDeriveBusinessActivity } =
	proxyActivities<typeof activities>({
		startToCloseTimeout: "30 minutes",
		heartbeatTimeout: "2 minutes",
		retry: {
			initialInterval: "5s",
			maximumInterval: "120s",
			backoffCoefficient: 2,
			maximumAttempts: 3,
		},
	});

// Short DB updates.
const { atlasMarkStatusActivity, atlasFinalizeActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "1s",
		maximumInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

export interface AtlasWorkflowOutput {
	status: "READY" | "FAILED";
	nodeCount: number;
	edgeCount: number;
	error?: string;
}

export async function atlasWorkflow(
	input: AtlasWorkflowInput,
): Promise<AtlasWorkflowOutput> {
	const tenant = {
		userId: input.userId,
		organizationId: input.organizationId,
	};

	try {
		await atlasMarkStatusActivity({
			...tenant,
			analysisId: input.analysisId,
			status: "ANALYZING",
		});

		const structure = await atlasRunStructureActivity({
			...tenant,
			analysisId: input.analysisId,
			projectId: input.projectId,
			repositoryIntegrationId: input.repositoryIntegrationId,
		});

		// `fresh` (B5) flows into the AI activities so they skip override-feeding,
		// and into finalize so it persists `appliedUserOverrides = false`. Adding
		// fields to an activity's INPUT is replay-safe (no command-sequence change).
		const describe = await atlasDescribeModulesActivity({
			...tenant,
			analysisId: input.analysisId,
			projectId: input.projectId,
			changedModuleKeys: structure.changedModuleKeys,
			fresh: input.fresh,
		});

		// Pass the change signal so the activity can skip the (expensive) AI
		// re-derivation when nothing changed and a business graph already exists.
		// The workflow command sequence is unchanged (the activity always runs),
		// so this stays replay-safe.
		const business = await atlasDeriveBusinessActivity({
			...tenant,
			analysisId: input.analysisId,
			projectId: input.projectId,
			incremental: input.incremental,
			changedModuleKeys: structure.changedModuleKeys,
			fresh: input.fresh,
		});

		// Sum telemetry across the two AI activities (T3); pick the first non-null
		// model and concatenate any reasoning. Pure data folding — no new activity
		// call, so replay-safe. `durationMs` is derived server-side in finalize
		// from the run's start time (avoids non-deterministic time in the workflow).
		const promptTokens = describe.promptTokens + business.promptTokens;
		const completionTokens =
			describe.completionTokens + business.completionTokens;
		const totalTokens = describe.totalTokens + business.totalTokens;
		const model = describe.model ?? business.model;
		const reasoning =
			[describe.reasoning, business.reasoning]
				.filter((r): r is string => Boolean(r))
				.join("\n\n") || undefined;

		await atlasFinalizeActivity({
			...tenant,
			analysisId: input.analysisId,
			status: "READY",
			commitSha: structure.commitSha,
			commitAt: structure.commitAt,
			manifest: structure.manifest,
			nodeCount: structure.nodeCount,
			edgeCount: structure.edgeCount,
			filesAnalyzed: structure.filesAnalyzed,
			modulesDescribed: describe.described,
			incremental: input.incremental,
			fresh: input.fresh,
			model,
			promptTokens,
			completionTokens,
			totalTokens,
			reasoning,
		});

		return {
			status: "READY",
			nodeCount: structure.nodeCount,
			edgeCount: structure.edgeCount,
		};
	} catch (err) {
		// Distinguish a user "Cancel analysis" (Temporal cancellation, surfaced
		// as a CancelledFailure once the in-flight activity is cancelled) from a
		// genuine pipeline failure, so the row reads "Cancelled by user" rather
		// than a confusing generic error. `isCancellation` walks the failure
		// chain, so it matches even when the cancel is wrapped in an
		// ActivityFailure.
		const cancelled = isCancellation(err);
		const message = cancelled
			? "Cancelled by user"
			: err instanceof Error
				? err.message
				: String(err);

		// Finalize FAILED on the way out. This is the SAME finalize activity the
		// success path's failure branch already used — no NEW activity is added
		// to the normal (non-cancel) path and no existing call is reordered, so
		// existing replay histories stay deterministic without a `patched()`
		// guard (the cancel branch only ever runs for a cancelled execution,
		// which no prior history exercised).
		//
		// On cancellation the workflow's own scope is already cancelled, so the
		// finalize activity must run inside `CancellationScope.nonCancellable`
		// or it would itself be cancelled and the row would never reach FAILED.
		// `nonCancellable` is a TS-SDK runtime construct (it emits no Temporal
		// history command), so wrapping the existing call is replay-safe on the
		// non-cancel path too.
		await CancellationScope.nonCancellable(async () => {
			await atlasFinalizeActivity({
				...tenant,
				analysisId: input.analysisId,
				status: "FAILED",
				error: message,
			});
		});
		return { status: "FAILED", nodeCount: 0, edgeCount: 0, error: message };
	}
}
