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
import type { FindingReviewProgress } from "../activities/security-scan/review-activities";
import type { ReviewProposal } from "../activities/security-scan/review-schemas";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";
import {
	type BulkRunInputExtras,
	claimBulkRunResume,
	pauseBulkRun,
} from "./lib/bulk-run-pause";
import {
	BULK_RUN_PAUSE_BEYOND_MS,
	chatGptPlanPauseOf,
	untilRunDeadline,
	withChatGptPlanWaitResuming,
} from "./lib/chatgpt-plan-wait";

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
const RUN_FINDING_REVIEW_TIMEOUT_MS = 15 * 60_000;
const { runFindingReviewActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: RUN_FINDING_REVIEW_TIMEOUT_MS,
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
		maximumAttempts: 2,
		// A spent plan is waited out below, never retried in seconds.
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

/** Left after a plan wait for the persist or failure write that ends the run. */
const PERSIST_RESERVE_MS = 2 * 60_000;

export interface ScanFindingReviewInput extends BulkRunInputExtras {
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
	/** Paused for a ChatGPT plan reset; a resume run starts at `resumesAt`. */
	paused?: boolean;
	resumesAt?: string;
}

export async function scanFindingReviewWorkflow(
	input: ScanFindingReviewInput,
): Promise<ScanFindingReviewOutput> {
	const { reviewId, projectId, scanId, userId, organizationId } = input;

	// A resume after a ChatGPT plan pause (Fizzy #2770) takes its row back
	// first, and ends quietly when a Cancel or the other resume got there.
	let resumeFrom: FindingReviewProgress | undefined;
	if (input.resumeOf) {
		const claim = await claimBulkRunResume<FindingReviewProgress>(
			"SCAN_REVIEW",
			{ ...input, resumeOf: input.resumeOf },
		);
		if (!claim.claimed) {
			return {
				success: false,
				reviewedCount: 0,
				flaggedCount: 0,
				error: "The review was no longer waiting to resume.",
			};
		}
		resumeFrom = claim.progress;
	}

	try {
		if (!input.resumeOf) {
			await markReviewRunningActivity({ reviewId });
		}

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
			// When every shared ChatGPT plan runs out part-way, the review
			// waits for the reset and judges only the findings it had not
			// reached (Fizzy #2770) — never past the run's own deadline.
			// `userId` is null: this bulk run never uses the clicker's own
			// plan, so its reset cannot help.
			// A longer wait pauses the review instead: it saves the
			// findings already judged and a resume run judges the rest.
			let run: Awaited<ReturnType<typeof runFindingReviewActivity>>;
			try {
				run = await withChatGptPlanWaitResuming<
					FindingReviewProgress,
					Awaited<ReturnType<typeof runFindingReviewActivity>>
				>(
					(resume) =>
						runFindingReviewActivity({
							projectId,
							userId,
							organizationId,
							findings,
							rubric,
							...(resume && { resume }),
						}),
					{
						organizationId,
						userId: null,
						maxWaitMs: untilRunDeadline(
							RUN_FINDING_REVIEW_TIMEOUT_MS + PERSIST_RESERVE_MS,
						),
						pauseBeyondMs: BULK_RUN_PAUSE_BEYOND_MS,
						resumeFrom,
					},
				);
			} catch (error) {
				const pause = chatGptPlanPauseOf(error);
				if (!pause) {
					throw error;
				}
				const paused = await pauseBulkRun({
					kind: "SCAN_REVIEW",
					runId: reviewId,
					input,
					pause,
					progress: pause.progress,
				});
				return {
					success: false,
					reviewedCount: 0,
					flaggedCount: 0,
					paused: true,
					resumesAt: paused.resumesAt,
				};
			}
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
