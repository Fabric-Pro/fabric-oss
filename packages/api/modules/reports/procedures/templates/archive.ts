import { ORPCError } from "@orpc/server";
import { getReportTemplate, setReportTemplateArchivedAt } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertCanManageReportTemplate,
	assertReportPermission,
} from "../../lib/report-access";

const archiveTemplateInputSchema = z.object({
	id: z.string(),
});

async function setArchived(
	templateId: string,
	archived: boolean,
	context: {
		user: { id: string; role?: string | null };
		session: { activeOrganizationId?: string | null };
	},
) {
	const organizationId = resolveOrganizationId(undefined, context.session);
	await assertReportPermission(
		organizationId,
		context.user,
		Permissions.REPORT_UPDATE,
	);

	const existing = await getReportTemplate({
		id: templateId,
		userId: context.user.id,
		organizationId,
	});

	if (!existing) {
		throw new ORPCError("NOT_FOUND", {
			message: "Report template not found",
		});
	}

	await assertCanManageReportTemplate(existing, context.user);

	const updated = await setReportTemplateArchivedAt(
		templateId,
		archived ? new Date() : null,
	);

	return {
		id: updated.id,
		archivedAt: updated.archivedAt?.toISOString() ?? null,
	};
}

/**
 * Archive a template: it leaves template pickers, and the reports already
 * created from it keep running. The middleware only admits members: a platform
 * admin archives system templates whatever their organization role there.
 */
export const archiveTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(archiveTemplateInputSchema)
	.handler(async ({ input, context }) =>
		setArchived(input.id, true, context),
	);

export const unarchiveTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(archiveTemplateInputSchema)
	.handler(async ({ input, context }) =>
		setArchived(input.id, false, context),
	);
