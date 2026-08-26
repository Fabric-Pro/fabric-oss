import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Returns all Slack channels linked to a project, including per-channel
 * failure state (consecutiveFailures, lastErrorMessage, lastErrorAt) so the
 * settings UI can surface "auth expired — re-link?" warnings and the seen
 * message count as a rough signal of activity.
 */
export const listLinkedChannelsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/slack-channel-monitor/linked",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "List linked Slack channels",
		description:
			"Returns all Slack channels linked to a project, including failure state.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		return await db.projectLinkedSlackChannel.findMany({
			where: { projectId: input.projectId },
			include: {
				_count: {
					select: { seenMessages: true },
				},
			},
			orderBy: { linkedAt: "desc" },
		});
	});
