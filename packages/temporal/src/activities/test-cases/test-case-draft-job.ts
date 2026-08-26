/**
 * Activities that move a test-case drafting run through its ledger, and the
 * completion notification.
 *
 * These are the cheap, retryable bookends around the expensive part: flipping
 * the row to RUNNING, appending each feature's outcome, and landing the terminal
 * state. They touch only Postgres, so unlike the drafting activity they are safe
 * to retry.
 */

import {
	completeTestCaseDraftJob,
	markTestCaseDraftJobRunning,
	parseFeatureOutcomes,
	recordTestCaseDraftFeatureOutcome,
	type TestCaseDraftFeatureOutcome,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import {
	NotificationCategory,
	NotificationType,
} from "@repo/database/prisma/generated/enums";
import {
	getNotificationPreferences,
	isCategoryEnabled,
} from "@repo/database/prisma/queries/notification-preferences";
import { logger } from "@repo/logs";
import type { DraftTestCasesForFeatureResult } from "./draft-test-cases-for-feature";

/** Prisma's unique-constraint violation — here, the notification dedupe index. */
function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "P2002"
	);
}

export interface BeginTestCaseDraftJobInput {
	jobId: string;
}

/**
 * PENDING → RUNNING. Returns false when the run was cancelled before a worker
 * picked it up, which tells the workflow to stop without spending anything.
 */
export async function beginTestCaseDraftJob(
	input: BeginTestCaseDraftJobInput,
): Promise<boolean> {
	return await markTestCaseDraftJobRunning(input.jobId);
}

export interface RecordTestCaseDraftOutcomeInput {
	jobId: string;
	outcome: DraftTestCasesForFeatureResult;
}

/**
 * Append one feature's outcome and advance progress. Returns false once the job
 * is no longer RUNNING (cancelled mid-run) so the workflow stops rather than
 * drafting features nobody is waiting for.
 */
export async function recordTestCaseDraftOutcome(
	input: RecordTestCaseDraftOutcomeInput,
): Promise<boolean> {
	const outcome: TestCaseDraftFeatureOutcome = {
		storyId: input.outcome.storyId,
		storyIdentifier: input.outcome.storyIdentifier,
		storyTitle: input.outcome.storyTitle,
		status: input.outcome.status,
		caseIds: input.outcome.caseIds,
		...(input.outcome.error ? { error: input.outcome.error } : {}),
	};
	return await recordTestCaseDraftFeatureOutcome({
		jobId: input.jobId,
		outcome,
	});
}

export interface FinalizeTestCaseDraftJobInput {
	jobId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
}

/** Bound for the composed failure reason — mirrors the per-feature error bound. */
const MAX_RUN_FAILURE_REASON_LENGTH = 300;

/** "Feature 5", falling back to the title, then to a neutral label (NOT_FOUND rows carry neither). */
function featureLabel(outcome: TestCaseDraftFeatureOutcome): string {
	if (outcome.storyIdentifier) {
		return `Feature ${outcome.storyIdentifier}`;
	}
	return outcome.storyTitle || "A selected feature";
}

/** The per-feature failure clause, phrased to follow the feature's label. */
function featureFailureClause(outcome: TestCaseDraftFeatureOutcome): string {
	switch (outcome.status) {
		case "NO_ACCEPTANCE_CRITERIA":
			return "has no acceptance criteria — add criteria, then draft again";
		case "NO_AI_PROVIDER":
			return "has no AI provider configured";
		case "NO_CASES":
			return "produced no usable cases";
		case "NOT_FOUND":
			return "was not found in this project";
		case "FAILED":
			return outcome.error
				? `failed to generate: ${outcome.error}`
				: "failed to generate";
		case "DRAFTED":
			// Unreachable — callers filter to non-DRAFTED outcomes first.
			return "";
		default: {
			const exhaustive: never = outcome.status;
			return exhaustive;
		}
	}
}

/**
 * Compose the user-facing reason a run produced zero cases from its recorded
 * per-feature outcomes.
 *
 * The ledger already knows exactly why each feature was skipped or failed
 * (NO_ACCEPTANCE_CRITERIA, a provider error, …), but the terminal write used to
 * discard that and land a generic "No test cases could be drafted." — which is
 * what the failure toast and notification render, leaving the user with an
 * error they can do nothing about. One shared cause reads as a single
 * sentence; mixed causes are listed per feature, bounded to a toast-sized
 * length. An empty ledger (every append lost) falls back to the generic text.
 */
export function describeFailedDraftRun(
	outcomes: TestCaseDraftFeatureOutcome[],
): string {
	const failed = outcomes.filter((outcome) => outcome.status !== "DRAFTED");
	if (failed.length === 0) {
		return "No test cases could be drafted.";
	}
	if (failed.length === 1) {
		return `${featureLabel(failed[0])} ${featureFailureClause(failed[0])}.`;
	}

	const shared = failed.every(
		(outcome) => outcome.status === failed[0].status,
	);
	if (shared) {
		switch (failed[0].status) {
			case "NO_ACCEPTANCE_CRITERIA":
				return "None of the selected features have acceptance criteria — add criteria, then draft again.";
			case "NO_AI_PROVIDER":
				return "No AI provider is configured for this project.";
			case "NO_CASES":
				return "The model produced no usable cases for any selected feature.";
			case "NOT_FOUND":
				return "The selected features were not found in this project.";
			case "FAILED": {
				// Batch failures share one upstream cause in practice (credits,
				// rate limit) — surface it once instead of N times.
				const error = failed.find((outcome) => outcome.error)?.error;
				return error
					? `AI generation failed for every selected feature: ${error}`.slice(
							0,
							MAX_RUN_FAILURE_REASON_LENGTH,
						)
					: "AI generation failed for every selected feature.";
			}
			default:
				break;
		}
	}

	const listed = failed
		.map(
			(outcome) =>
				`${featureLabel(outcome)} ${featureFailureClause(outcome)}`,
		)
		.join("; ");
	return listed.length > MAX_RUN_FAILURE_REASON_LENGTH
		? `${listed.slice(0, MAX_RUN_FAILURE_REASON_LENGTH)}…`
		: listed;
}

function draftJobHref(
	projectId: string,
	jobId: string,
	organizationSlug: string | null,
): string {
	// Deep-links the Cases list to this run's batch — the job id is the batch's
	// identity, so the list can resolve exactly the cases it created.
	const base = organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;
	return `${base}?tab=test-cases&draftJob=${jobId}`;
}

/**
 * Land the terminal state and tell the requester.
 *
 * A run "succeeds" when at least one feature drafted; it fails only when none
 * did. Partial success is the common, healthy case for a batch — some features
 * lack criteria — and reporting that as failure would train people to ignore the
 * notification.
 *
 * The notification is emitted here rather than through @repo/api's
 * `createNotification` because this package cannot reach across into it (dep
 * cycle) — same as the security-scan and URL-source emitters, including the
 * write-time preference gate and the dedupe coalesce those repeat.
 */
export async function finalizeTestCaseDraftJob(
	input: FinalizeTestCaseDraftJobInput,
): Promise<void> {
	const job = await db.testCaseDraftJob.findUnique({
		where: { id: input.jobId },
		select: {
			status: true,
			createdCaseIds: true,
			totalFeatures: true,
			featureOutcomes: true,
		},
	});
	if (!job || job.status !== "RUNNING") {
		// Cancelled mid-run, or already terminal. Nothing to land, nobody to tell.
		return;
	}

	const createdCount = job.createdCaseIds.length;
	const succeeded = createdCount > 0;
	// The actionable reason, mined from the ledger this activity already holds —
	// e.g. "Feature 3 has no acceptance criteria — add criteria, then draft
	// again." instead of the generic text the toast used to show.
	const failureReason = succeeded
		? null
		: describeFailedDraftRun(parseFeatureOutcomes(job.featureOutcomes));

	const finished = await completeTestCaseDraftJob({
		jobId: input.jobId,
		status: succeeded ? "SUCCEEDED" : "FAILED",
		error: failureReason,
	});
	if (!finished) {
		// Lost the race to a cancel — the user already moved on.
		return;
	}

	// Write-time preference filter: TEST_CASES_DRAFTED is category PROJECT, gated
	// by the Sync/Project toggle. Default-on when no preference row exists.
	const flags = await getNotificationPreferences(input.userId);
	if (!isCategoryEnabled(flags, NotificationCategory.PROJECT)) {
		return;
	}

	let organizationSlug: string | null = null;
	if (input.organizationId) {
		try {
			const org = await db.organization.findUnique({
				where: { id: input.organizationId },
				select: { slug: true },
			});
			organizationSlug = org?.slug ?? null;
		} catch (error) {
			logger.warn("[testCaseDraftJob] Failed to resolve org slug", {
				jobId: input.jobId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const title = succeeded
		? `${createdCount} draft test case${createdCount === 1 ? "" : "s"} ready`
		: "No test cases could be drafted";
	const snippet = succeeded
		? `Drafted from ${job.totalFeatures} feature${job.totalFeatures === 1 ? "" : "s"} — review and mark them ready`
		: (failureReason ??
			"None of the selected features produced test cases");

	const dedupeKey = `test-cases-drafted:${input.jobId}`;
	const payload = {
		jobId: input.jobId,
		createdCount,
		totalFeatures: job.totalFeatures,
	};

	try {
		await db.notification.create({
			data: {
				userId: input.userId,
				organizationId: input.organizationId ?? null,
				type: NotificationType.TEST_CASES_DRAFTED,
				category: NotificationCategory.PROJECT,
				title,
				snippet,
				link: draftJobHref(
					input.projectId,
					input.jobId,
					organizationSlug,
				),
				projectId: input.projectId,
				payload,
				dedupeKey,
			},
		});
	} catch (error) {
		if (isUniqueViolation(error)) {
			await db.notification
				.updateMany({
					where: {
						userId: input.userId,
						dedupeKey,
						readAt: null,
						archivedAt: null,
					},
					data: { title, snippet, payload },
				})
				.catch(() => {
					/* best-effort coalesce */
				});
			return;
		}
		logger.warn(
			"[testCaseDraftJob] Failed to emit completion notification",
			{
				jobId: input.jobId,
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}
