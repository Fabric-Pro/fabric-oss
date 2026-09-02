/**
 * The failure marker for a blog post attempt (#1853, Phase 2B-3).
 *
 * A separate activity from the generator on purpose. The generator commits its
 * own success, but by definition it cannot be trusted to record its own
 * failure — the reason it failed may be the very thing that stops it writing.
 * The workflow owns this call, behind its own short-timeout proxy so a failing
 * run does not sit on GENERATING for another generation budget, holding the
 * partial unique index against every retry.
 *
 * The write is a compare-and-set on `status = 'GENERATING'` scoped by
 * `{ id, projectId }`, so a marker arriving after a deadline sweep already
 * reclaimed the attempt changes nothing. That is a normal outcome and NOT an
 * error: throwing here would make the workflow's last-resort catch fire and
 * report a crash where there was only a race the database already settled.
 */

import { failTopicDraft } from "@repo/database";
import { logger } from "@repo/logs";

export interface MarkBlogPostFailedInput {
	draftId: string;
	projectId: string;
	message: string;
}

export async function markBlogPostFailedActivity(
	input: MarkBlogPostFailedInput,
): Promise<void> {
	const { persisted } = await failTopicDraft({
		id: input.draftId,
		projectId: input.projectId,
		error: input.message,
	});

	if (!persisted) {
		logger.info(
			"[publishing-blog-post] failure marker skipped; attempt was already terminal",
			{ draftId: input.draftId, projectId: input.projectId },
		);
	}
}
