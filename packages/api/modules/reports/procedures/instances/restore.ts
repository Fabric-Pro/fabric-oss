import { ORPCError } from "@orpc/server";
import {
	canAccessReportInstance,
	getTemplateInstance,
	restoreReportInstanceVersion,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCanEditReportInstance,
	assertReportPermission,
} from "../../lib/report-access";

const restoreInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const restoreInstanceProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(restoreInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertReportPermission(
			organizationId,
			context.user,
			Permissions.REPORT_UPDATE,
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

		await assertCanEditReportInstance(existing, context.user);

		if (
			!(await canAccessReportInstance(
				existing,
				{ userId: context.user.id, organizationId },
				undefined,
				true,
			))
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "Project report write access denied",
			});
		}

		// Can only restore archived instances
		if (existing.status !== "ARCHIVED") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only archived instances can be restored",
			});
		}

		// Restore the instance (creates a new version from the archived one)
		const restored = await restoreReportInstanceVersion(input.id);

		return {
			id: restored.id,
			sId: restored.sId,
			version: restored.version,
			status: restored.status,
			name: restored.name,
			templateId: restored.templateId,
			restoredAt: new Date().toISOString(),
		};
	});
