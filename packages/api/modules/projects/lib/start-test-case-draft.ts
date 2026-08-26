/**
 * Start a test-case drafting run.
 *
 * Extracted so two callers share one path: the "Draft cases" button, and the
 * automatic run that fires when a feature reaches **Ready for Dev** under the
 * test-first flow. Both have to claim the same job ledger and dispatch the same
 * workflow, and a second copy of that would drift on the first change to either.
 *
 * The claim is the load-bearing part. `claimTestCaseDraftJob` does its overlap
 * check and its insert in ONE transaction, serialized per project by an advisory
 * lock, because the drafter has no existing-case dedupe before it bills: two runs
 * over the same feature would pay for duplicate generations AND append duplicate
 * cases.
 */

import {
	claimTestCaseDraftJob,
	failTestCaseDraftJob,
	setTestCaseDraftJobWorkflowId,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

/**
 * The claimed row's own status type, taken from the ledger rather than restated.
 *
 * It has to stay the Prisma enum and not widen to `string`: this value is
 * returned straight out of the procedure, and the drafting UI narrows on it to
 * decide whether a run is still active. Widening here propagates through the
 * procedure's inferred output and breaks that narrowing in the client.
 */
type ClaimedDraftJobStatus = NonNullable<
	Awaited<ReturnType<typeof claimTestCaseDraftJob>>["job"]
>["status"];

export type StartTestCaseDraftResult =
	| { started: true; jobId: string; status: ClaimedDraftJobStatus }
	/** Another run already covers one of these features. */
	| { started: false; reason: "blocked"; blockedStoryIds: string[] }
	/** The claim succeeded but Temporal did not take the workflow. */
	| { started: false; reason: "dispatch-failed"; jobId: string };

/**
 * Claim a job and dispatch the workflow.
 *
 * Returns a result rather than throwing, because the two callers need opposite
 * things from a failure: the button turns it into a message the user reads, and
 * the automatic trigger swallows it — nobody pressed anything, so an error has
 * nowhere to go and must never fail the transition that caused it.
 */
export async function startTestCaseDraft(input: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	requestedById: string;
	storyIds: string[];
}): Promise<StartTestCaseDraftResult> {
	const claim = await claimTestCaseDraftJob({
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		requestedById: input.requestedById,
		storyIds: input.storyIds,
	});
	if (claim.blockedStoryIds) {
		return {
			started: false,
			reason: "blocked",
			blockedStoryIds: claim.blockedStoryIds,
		};
	}
	const job = claim.job;

	try {
		const client = await getTemporalClient();
		// Keyed on the job row, so the id is reconstructible from the ledger
		// alone — cancel does not have to trust a client-held id.
		const workflowId = `test-case-draft-${job.id}`;
		await client.workflow.start(
			// String workflow name to avoid minification issues in production
			// builds.
			"testCaseDraftWorkflow",
			withCorrelationMemo({
				taskQueue: "ai-chat",
				workflowId,
				args: [
					{
						jobId: job.id,
						projectId: input.projectId,
						userId: input.userId,
						organizationId: input.organizationId ?? undefined,
						storyIds: input.storyIds,
					},
				],
			}),
		);
		await setTestCaseDraftJobWorkflowId({ jobId: job.id, workflowId });
		return { started: true, jobId: job.id, status: job.status };
	} catch (error) {
		// Mark it FAILED rather than leaving a PENDING row the client polls
		// forever.
		await failTestCaseDraftJob({
			jobId: job.id,
			error:
				error instanceof Error
					? error.message
					: "Failed to start the drafting run",
		});
		return { started: false, reason: "dispatch-failed", jobId: job.id };
	}
}
