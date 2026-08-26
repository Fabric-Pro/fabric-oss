import { ORPCError } from "@orpc/server";
import {
	archiveReportInstanceVersion,
	getTemplateInstance,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const archiveInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const archiveInstanceProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_DELETE))
	.input(archiveInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify instance exists and user has access
		const existing = await getTemplateInstance({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template instance not found or access denied",
			});
		}

		// Cannot archive an already archived instance
		if (existing.status === "ARCHIVED") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Instance is already archived",
			});
		}

		// Archive the instance
		const archived = await archiveReportInstanceVersion(input.id);

		return {
			id: archived.id,
			sId: archived.sId,
			version: archived.version,
			status: archived.status,
			name: archived.name,
			archivedAt: new Date().toISOString(),
		};
	});
