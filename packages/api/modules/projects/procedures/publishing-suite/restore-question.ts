import { ORPCError } from "@orpc/client";
import { restoreTopicQuestion } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * `publishingSuite.restoreQuestion` (Fizzy #1851) — re-open a soft-closed
 * (`POSSIBLY_RESOLVED`) question on a topic.
 *
 * `reconcileTopicQuestions` soft-closes a root the newest analysis stopped
 * raising, deliberately rather than deleting it: a question a regeneration
 * dropped is weak evidence that it was settled. Until now that was one-way.
 * The panel told the reader those questions "can still be answered" and gave
 * them no way to bring one back into the list that gets answered — the
 * maturation side has had `restoreQuestion` for exactly this since #5.
 *
 * NEVER DELETES and never resolves: the only transition is
 * `POSSIBLY_RESOLVED -> OPEN`. A RESOLVED root is refused rather than re-opened,
 * because re-opening one would undo somebody's answer.
 *
 * No notification. Restoring is the reader putting a question back on their own
 * list; whoever it then waits on is what `setQuestionAssignees` is for, and that
 * one does notify.
 */
export const restorePublishingQuestionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/decisions/{questionRootId}/restore",
		tags: ["Projects", "Publishing Suite"],
		summary: "Re-open a soft-closed question on a topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			/** The question thread ROOT, not a reply. */
			questionRootId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ restored: z.boolean() }))
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		const result = await restoreTopicQuestion({
			topicId: input.topicId,
			projectId: input.projectId,
			entryId: input.questionRootId,
		});
		if (!result) {
			throw new ORPCError("NOT_FOUND", {
				message:
					"That question is not set aside, so there is nothing to restore.",
			});
		}
		return { restored: true };
	});
