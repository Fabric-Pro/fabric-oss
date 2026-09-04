/**
 * Context Summarization Workflow
 *
 * Compresses a project's raw context into a structured, LLM-generated summary
 * stored alongside the raw (raw is NEVER touched). The run's status is fully
 * observable via the `ProjectContextSummary` row (PENDING → GENERATING →
 * COMPLETED | FAILED), so there is no query handler.
 *
 * Sequence: create PENDING → mark GENERATING → fetch → generate → persist
 * COMPLETED → embed (best-effort).
 *
 * This workflow is a DEGRADATION BOUNDARY: the entire body after the row is
 * created is wrapped so ANY failure routes to `notifySummaryFailureActivity`
 * (flip FAILED + raise a SEV-2 admin incident) and the workflow RETURNS cleanly
 * — it must never throw out into the caller (the manual API trigger and the
 * auto cron both fire-and-forget). The embed step is additionally isolated so a
 * failed embed can't undo an already-COMPLETED summary.
 *
 * New file — no `patched()` gating is required.
 */

import type { SourceSelection } from "@repo/database";
import {
	CancellationScope,
	isCancellation,
	log,
	proxyActivities,
} from "@temporalio/workflow";
import type { cancelSummaryActivity as CancelFn } from "../activities/context-summarization/cancel-summary";
import type { createPendingSummaryActivity as CreatePendingFn } from "../activities/context-summarization/create-pending-summary";
import type { embedSummaryActivity as EmbedFn } from "../activities/context-summarization/embed-summary";
import type { fetchContextForSummaryActivity as FetchFn } from "../activities/context-summarization/fetch-context-for-summary";
import type { generateSummaryActivity as GenerateFn } from "../activities/context-summarization/generate-summary";
import type { markSummaryGeneratingActivity as MarkGeneratingFn } from "../activities/context-summarization/mark-summary-generating";
import type { notifySummaryFailureActivity as NotifyFailureFn } from "../activities/context-summarization/notify-summary-failure";
import type { persistSummaryActivity as PersistFn } from "../activities/context-summarization/persist-summary";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";

export interface ContextSummarizationInput {
	projectId: string;
	userId: string | null;
	organizationId: string | null;
	trigger: "AUTO" | "MANUAL";
	triggeredByUserId?: string | null;
	/** Which source types to consider; omitted = all. */
	sources?: SourceSelection;
}

export interface ContextSummarizationOutput {
	summaryId: string | null;
	status: "COMPLETED" | "FAILED" | "CANCELLED";
}

const { createPendingSummaryActivity } = proxyActivities<{
	createPendingSummaryActivity: typeof CreatePendingFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: { initialInterval: "2s", backoffCoefficient: 2, maximumAttempts: 3 },
});

const { markSummaryGeneratingActivity } = proxyActivities<{
	markSummaryGeneratingActivity: typeof MarkGeneratingFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: { initialInterval: "2s", backoffCoefficient: 2, maximumAttempts: 3 },
});

const { fetchContextForSummaryActivity } = proxyActivities<{
	fetchContextForSummaryActivity: typeof FetchFn;
}>({
	startToCloseTimeout: "90 seconds",
	retry: { initialInterval: "2s", backoffCoefficient: 2, maximumAttempts: 3 },
});

// The one long activity — map-reduce compression over the whole eligible
// history (as many bounded LLM folds as the project needs). It heartbeats every
// batch and checkpoints to the DB row, so a retry RESUMES from the keyset cursor
// rather than restarting; the generous start-to-close bounds a pathological run.
const { generateSummaryActivity } = proxyActivities<{
	generateSummaryActivity: typeof GenerateFn;
}>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
		// See backlog-context-analysis-workflow: a configuration refusal is
		// deterministic, so the retry budget buys nothing but delay.
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

const { persistSummaryActivity } = proxyActivities<{
	persistSummaryActivity: typeof PersistFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: { initialInterval: "2s", backoffCoefficient: 2, maximumAttempts: 3 },
});

const { embedSummaryActivity } = proxyActivities<{
	embedSummaryActivity: typeof EmbedFn;
}>({
	startToCloseTimeout: "120 seconds",
	retry: { initialInterval: "2s", backoffCoefficient: 2, maximumAttempts: 2 },
});

const { notifySummaryFailureActivity } = proxyActivities<{
	notifySummaryFailureActivity: typeof NotifyFailureFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: { initialInterval: "2s", backoffCoefficient: 2, maximumAttempts: 2 },
});

const { cancelSummaryActivity } = proxyActivities<{
	cancelSummaryActivity: typeof CancelFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: { initialInterval: "2s", backoffCoefficient: 2, maximumAttempts: 3 },
});

export async function contextSummarizationWorkflow(
	input: ContextSummarizationInput,
): Promise<ContextSummarizationOutput> {
	const tenancy = {
		userId: input.userId,
		organizationId: input.organizationId,
	};

	let summaryId: string | null = null;
	try {
		const created = await createPendingSummaryActivity({
			projectId: input.projectId,
			tenancy,
			trigger: input.trigger,
			triggeredByUserId: input.triggeredByUserId ?? null,
			sourceSelection: input.sources,
		});
		summaryId = created.summaryId;

		await markSummaryGeneratingActivity({ summaryId });

		const fetched = await fetchContextForSummaryActivity({
			projectId: input.projectId,
			tenancy,
			snapshotThrough: created.snapshotThrough,
		});

		// Map-reduce over ALL eligible context, chronologically, in bounded
		// batches; checkpoints each batch so a retry resumes rather than restarts.
		const generated = await generateSummaryActivity({
			summaryId,
			projectId: input.projectId,
			projectName: fetched.projectName,
			tenancy,
			snapshotThrough: created.snapshotThrough,
			sourceSelection: input.sources,
		});

		await persistSummaryActivity({
			summaryId,
			content: generated.content,
			tokenCount: generated.tokenCount,
			model: generated.model,
			coveredContextCount: generated.coveredContextCount,
			coveredThrough: generated.coveredThrough,
			references: generated.references,
			stats: generated.stats,
			spentInputTokens: generated.spentInputTokens,
			spentOutputTokens: generated.spentOutputTokens,
			spentCostMicroUsd: generated.spentCostMicroUsd,
		});

		// Best-effort embed AFTER the row is COMPLETED — isolated so a failed
		// embed leaves the finished summary intact (the activity already
		// swallows its own errors; this is belt-and-suspenders).
		try {
			await embedSummaryActivity({
				summaryId,
				projectId: input.projectId,
				tenancy,
				content: generated.content,
			});
		} catch (embedError) {
			log.warn("[Context Summarization] embed step failed (non-fatal)", {
				projectId: input.projectId,
				summaryId,
				error:
					embedError instanceof Error
						? embedError.message
						: String(embedError),
			});
		}

		return { summaryId, status: "COMPLETED" };
	} catch (error) {
		// User cancellation: flip the row CANCELLED in a non-cancellable scope (so
		// the activity always runs even though the workflow is cancelling) and
		// return cleanly. The prior COMPLETED summary is left untouched.
		if (isCancellation(error)) {
			log.info("[Context Summarization] run cancelled", {
				projectId: input.projectId,
				summaryId,
			});
			if (summaryId) {
				const id = summaryId;
				await CancellationScope.nonCancellable(() =>
					cancelSummaryActivity({ summaryId: id }),
				);
			}
			return { summaryId, status: "CANCELLED" };
		}

		const message = error instanceof Error ? error.message : String(error);
		log.error("[Context Summarization] run failed", {
			projectId: input.projectId,
			summaryId,
			error: message,
		});

		if (summaryId) {
			try {
				await notifySummaryFailureActivity({
					summaryId,
					projectId: input.projectId,
					tenancy,
					error: message,
				});
			} catch (notifyError) {
				log.error(
					"[Context Summarization] failure-notify activity threw (unexpected)",
					{
						projectId: input.projectId,
						summaryId,
						error:
							notifyError instanceof Error
								? notifyError.message
								: String(notifyError),
					},
				);
			}
		}

		return { summaryId, status: "FAILED" };
	}
}
