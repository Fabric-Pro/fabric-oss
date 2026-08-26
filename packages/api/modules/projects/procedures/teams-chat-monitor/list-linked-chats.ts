import { getLinkedTeamsChats } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Returns all Teams group chats linked to a project with:
 *   - seen-message counts (rough signal of activity)
 *   - consecutiveFailures, lastErrorMessage, lastErrorAt so the settings UI
 *     can surface per-chat "auth expired — re-link?" warnings.
 */
export const listLinkedChatsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/teams-chat-monitor/linked",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "List linked Teams chats",
		description:
			"Returns all Teams group chats linked to a project, including failure state.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		return await getLinkedTeamsChats(input.projectId);
	});
