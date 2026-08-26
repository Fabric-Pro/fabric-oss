/**
 * Delete Template Procedure
 *
 * Deletes an automation template with ownership verification.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const deleteTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_TEMPLATE_MANAGE))
	.route({
		method: "DELETE",
		path: "/automation-templates/{id}",
		tags: ["Automation Templates"],
		summary: "Delete automation template",
		description: "Delete an automation template",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Delete template with strict tenant isolation
		// Organization context: only delete org templates
		// Personal context: only delete personal templates (organizationId is null)
		const tenantFilter = organizationId
			? { organizationId }
			: { userId: user.id, organizationId: null };

		const result = await db.automationTemplate.deleteMany({
			where: {
				id: input.id,
				...tenantFilter,
			},
		});

		if (result.count === 0) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template not found or access denied",
			});
		}

		return { deleted: true };
	});
