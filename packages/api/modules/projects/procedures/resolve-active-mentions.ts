import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { filterAuthorizedMentionRecipients } from "../lib/user-mention";

/**
 * Resolve which of the given user IDs are still active members of the
 * document's project/org. Used by the document editor to render
 * greyed-out chips for removed users.
 */
export const resolveActiveMentionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.input(
		z.object({
			userIds: z.array(z.string()).max(200),
			organizationId: z.string().nullable(),
			projectId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		if (input.userIds.length === 0) {
			return { activeIds: [] as string[] };
		}
		const activeIds = await filterAuthorizedMentionRecipients(
			input.userIds,
			input.projectId,
			input.organizationId,
		);
		return { activeIds };
	});
