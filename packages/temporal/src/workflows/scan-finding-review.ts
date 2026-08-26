/**
 * Scan finding REVIEW workflow (G7 — on-demand AI false-positive review).
 *
 * Orchestrates the adversarial review pipeline on the general-purpose
 * `fabric-worker` queue:
 *   markReviewRunning → gatherReviewFindings → runFindingReview
 *   → persistReviewResults
 * Any failure routes to failReview so the run never hangs in PENDING/RUNNING.
 *
 * This is a SEPARATE workflow from securityAccessibilityScanWorkflow, so it has
 * no impact on in-flight scan replays. All side effects live in activities; this
 * workflow only sequences them, so it stays deterministic / replay-safe. The
 * review only PROPOSES changes (dismiss / severity / uncertain) — it never
 * mutates findings; applying a proposal is a separate explicit user step.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { ReviewProposal } from "../activities/security-scan/review-schemas";

// Cheap DB-only activities — retry generously.
const {
	markReviewRunningActivity,
	gatherReviewFindingsActivity,
	persistReviewResultsActivity,
	failReviewActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// LLM judge activity — long timeout + heartbeat, few retries (cost). The batched
// loop heartbeats between batches so the 2-minute heartbeat window holds.
const { runFindingReviewActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "15 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

export interface ScanFindingReviewInput {
	reviewId: string;
	projectId: string;
	/** Pin a specific scan; omit to review the latest COMPLETED scan's findings. */
	scanId?: string | null;
	userId: string;
	organizationId?: string | null;
}

export interface ScanFindingReviewOutput {
	success: boolean;
	reviewedCount: number;
	flaggedCount: number;
	error?: string;
}

export async function scanFindingReviewWorkflow(
	input: ScanFindingReviewInput,
): Promise<ScanFindingReviewOutput> {
	const { reviewId, projectId, scanId, userId, organizationId } = input;

	try {
		await markReviewRunningActivity({ reviewId });

		const { findings, rubric } = await gatherReviewFindingsActivity({
			projectId,
			scanId,
		});

		// Nothing open to review → record an empty (but COMPLETED) review rather
		// than spinning up the judge. Persist still records the FINDINGS_REVIEWED
		// activity so the run reads honestly.
		const proposals: ReviewProposal[] = [];
		let reviewedCount = 0;
		let modelName: string | null = null;
		let inputTokens = 0;
		let outputTokens = 0;

		if (findings.length > 0) {
			const run = await runFindingReviewActivity({
				projectId,
				userId,
				organizationId,
				findings,
				rubric,
			});
			proposals.push(...run.proposals);
			reviewedCount = run.reviewedCount;
			modelName = run.modelName;
			inputTokens = run.inputTokens;
			outputTokens = run.outputTokens;
		}

		const result = await persistReviewResultsActivity({
			reviewId,
			projectId,
			userId,
			organizationId,
			proposals,
			reviewedCount,
			modelName,
			inputTokens,
			outputTokens,
		});

		return {
			success: true,
			reviewedCount: result.reviewedCount,
			flaggedCount: result.flaggedCount,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		try {
			await failReviewActivity({ reviewId, message });
		} catch {
			// failReview is best-effort; the row stays RUNNING only if both the
			// review AND this fail-write die.
		}
		return {
			success: false,
			reviewedCount: 0,
			flaggedCount: 0,
			error: message,
		};
	}
}
