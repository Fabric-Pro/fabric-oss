import {
	createIncidentNotification,
	failContextSummary,
	type SummaryTenancy,
} from "@repo/database";
import { logger } from "@repo/logs";

/**
 * Failure boundary for a summarization run: flip the row FAILED and raise a
 * SEV-2 admin incident via the canonical helper. NEVER throws — the workflow is
 * a degradation boundary, so a failure to record a failure must not re-throw
 * into it. `createIncidentNotification` already swallows its own errors; the DB
 * flip is additionally guarded here.
 */
export async function notifySummaryFailureActivity(input: {
	summaryId: string;
	projectId: string;
	tenancy: SummaryTenancy;
	error: string;
}): Promise<void> {
	try {
		await failContextSummary({ id: input.summaryId, error: input.error });
	} catch (error) {
		logger.error("[Context Summarization] failed to mark summary FAILED", {
			summaryId: input.summaryId,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	try {
		await createIncidentNotification({
			source: "errorRate",
			incidentId: `context-summarization-${input.summaryId}`,
			severity: "sev2",
			title: "Context summarization failed",
			summary: input.error,
			link: `/app/projects/${input.projectId}`,
			startedAt: new Date(),
		});
	} catch (error) {
		logger.error(
			"[Context Summarization] failed to raise failure incident",
			{
				summaryId: input.summaryId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}
