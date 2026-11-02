import { seedWorkingDraftIfAbsent } from "@repo/database";
import { logger } from "@repo/logs";

/**
 * Leave the first generation editable, after the draft commits and in a separate
 * transaction. Keeping this outside completeTopicDraft lets short-form callers
 * seed only when requested without adding a content-type branch to that writer.
 * A crash between writes leaves a READY candidate recoverable through adoption.
 *
 * Swallow seed errors because the draft is already committed: rethrowing makes
 * Temporal retry the whole activity, paying for another model call that then
 * reports superseded; a READY draft without a working draft is recoverable
 * through the adopt control.
 */
export async function seedWorkingDraftAfterCommit(
	prefix: string,
	input: Parameters<typeof seedWorkingDraftIfAbsent>[0],
): Promise<boolean> {
	const context = {
		draftId: input.sourceDraftId,
		topicId: input.topicId,
		projectId: input.projectId,
	};
	try {
		const seeded = await seedWorkingDraftIfAbsent(input);
		if (seeded.status === "project_ineligible") {
			logger.warn(
				`${prefix} project became ineligible before the working draft could be seeded`,
				context,
			);
		} else if (seeded.status === "source_not_found") {
			logger.info(
				`${prefix} draft was superseded before it could seed a working draft`,
				context,
			);
		} else if (seeded.status === "already_exists") {
			logger.debug(
				`${prefix} topic already has a working draft; left untouched`,
				context,
			);
		}
		return seeded.status === "seeded";
	} catch (error) {
		logger.warn(`${prefix} failed to seed a working draft`, {
			...context,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
