/**
 * Delete Chat Artifact
 */

import { deleteChatArtifact } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const deleteProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_DELETE, {
			requireOrganization: true,
		}),
	)
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await deleteChatArtifact(input.id, context.user.id, organizationId);
		return { success: true };
	});
