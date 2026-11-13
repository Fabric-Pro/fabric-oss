import { ORPCError } from "@orpc/server";
import { db, previewNewsletterSendRecipientCount } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * How many people "Send now" would email right now, after the same member and
 * organization reconciliation the send runs. Read-only; the send dialog shows it
 * so nobody is emailed by surprise.
 */
export const recipientPreviewProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project. Take the tenant from the loaded row; `input.organizationId`
		// is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);
		return previewNewsletterSendRecipientCount(input.projectId);
	});
