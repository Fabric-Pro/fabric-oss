import { ORPCError } from "@orpc/client";
import {
	PUBLISHING_SNOOZE_PRESETS,
	setPublishingTopicSnooze,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * Set or clear a topic's snooze (1D, Fizzy #2265).
 *
 * The input accepts a PRESET NAME and deliberately no timestamp. FR6 allows
 * exactly three durations; resolving them server-side is what makes that a
 * constraint rather than a UI convention, since this is a public REST route.
 */
export const setTopicSnoozeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/publishing-topics/{topicId}/snooze",
		tags: ["Projects", "Publishing Suite"],
		summary: "Snooze or un-snooze a publishing topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** null clears the snooze and its rationale. */
			preset: z.enum(PUBLISHING_SNOOZE_PRESETS).nullable(),
			reason: z.string().max(2000).nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertPublishingSuiteFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(PUBLISHING_TOPIC_UPDATE) gates
		// project access; the DB helper re-scopes the write to
		// { id: topicId, projectId } and writes no tenant columns.
		const result = await setPublishingTopicSnooze({
			id: input.topicId,
			projectId: input.projectId,
			preset: input.preset,
			reason: input.reason,
		});
		if (!result) {
			throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
		}
		return { topic: result.topic };
	});
