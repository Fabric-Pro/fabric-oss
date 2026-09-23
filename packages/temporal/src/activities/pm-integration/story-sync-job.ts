import { jobCompleteAll, jobFail } from "../lib/job-progress";

export interface CloseStorySyncJobInput {
	outcome: "COMPLETED" | "FAILED";
	/** Shown verbatim in the Job Hub on a failure. */
	message: string;
	errorClass?: string;
	counts: Record<string, number>;
}

/**
 * Close the `PM_STORY_SYNC` row the API opened for this story-sync run.
 *
 * Called from the workflow's `finally`, so every exit — success, early
 * return, cancellation or a thrown failure — closes the durable "a sync is
 * running" fact the Roadmap and the capability engine read. Matches any
 * RUNNING row of the workflow, and never throws: bookkeeping must not change
 * the sync's outcome.
 */
export async function closeStorySyncJob(
	input: CloseStorySyncJobInput,
): Promise<void> {
	if (input.outcome === "COMPLETED") {
		await jobCompleteAll(input.counts);
		return;
	}
	await jobFail(input.message, { errorClass: input.errorClass });
}
