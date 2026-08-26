import { getLinkedTeamsChannels } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Returns all Teams channels linked to a project with:
 *   - seen-message counts (rough signal of activity)
 *   - consecutiveFailures, lastErrorMessage, lastErrorAt so the settings UI
 *     can surface per-channel "auth expired — re-link?" warnings.
 */
export const listLinkedChannelsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/teams-channel-monitor/linked",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "List linked Teams channels",
		description:
			"Returns all Teams channels linked to a project, including failure state.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		return await getLinkedTeamsChannels(input.projectId);
	});
