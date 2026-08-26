/**
 * Get Template Procedure
 *
 * Retrieves a template by ID with ownership verification.
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

export const getTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_TEMPLATE_READ))
	.route({
		method: "GET",
		path: "/automation-templates/{id}",
		tags: ["Automation Templates"],
		summary: "Get automation template",
		description: "Get an automation template by ID",
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

		// Get template with strict tenant isolation
		// Organization context: only org templates (public or private within same org)
		// Personal context: only personal templates (organizationId is null)
		const tenantFilter = organizationId
			? { organizationId }
			: { userId: user.id, organizationId: null };

		const template = await db.automationTemplate.findFirst({
			where: {
				id: input.id,
				...tenantFilter,
			},
		});

		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template not found",
			});
		}

		return { template };
	});
