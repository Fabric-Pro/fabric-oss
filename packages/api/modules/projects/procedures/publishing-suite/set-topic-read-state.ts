import { ORPCError } from "@orpc/client";
import { setPublishingTopicReadState } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";

/**
 * Set the caller's own read marker for a topic (1D, Fizzy #2265).
 *
 * Gated on PUBLISHING_TOPIC_READ rather than _UPDATE: marking your own copy
 * read is not editing the topic, and requiring edit rights would make the
 * Inbox's unread badge permanently wrong for a read-only member.
 */
export const setTopicReadStateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/publishing-topics/{topicId}/read-state",
		tags: ["Projects", "Publishing Suite"],
		summary: "Mark a publishing topic read or unread for the caller",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			read: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);
		// AUTHORIZATION: the marker is always written for the AUTHENTICATED
		// user. The input carries no userId, so one caller can never set
		// another's read state.
		const ok = await setPublishingTopicReadState({
			id: input.topicId,
			projectId: input.projectId,
			userId: context.user.id,
			read: input.read,
		});
		if (!ok) {
			throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
		}
		return { read: input.read };
	});
