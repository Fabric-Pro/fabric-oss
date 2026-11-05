import { ORPCError } from "@orpc/server";
import {
	getProjectForReportsOnly,
	hasProjectAccess,
	isFeatureEnabled,
	listOrganizationProjectsForReports,
} from "@repo/database";
import { ProjectStatusSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	canReachProjectReports,
	inheritsOrganizationReportEditor,
} from "../lib/report-access";

/**
 * A project as the report surface reads it, for someone who may open its reports:
 * its name, status, project management binding and repositories, and nothing else.
 * An organization admin or owner, or a system admin who is a member, reaches it
 * with no project row where the report suite is on, so `projects.get` and the
 * project's other pages stay with the project's members.
 */
export const reportProjectProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(
		z.object({
			id: z.string().min(1).max(128),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const reaches =
			(await canReachProjectReports(input.id, context.user)) &&
			((organizationId !== null &&
				(await isFeatureEnabled("REPORT_SUITE_V2", organizationId))) ||
				(await hasProjectAccess(input.id, context.user.id)));
		const project = reaches
			? await getProjectForReportsOnly(input.id, organizationId)
			: null;
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		return { project };
	});

/**
 * Every live project of the organization, for someone who inherits Project Editor
 * on their reports, where the report suite is on. A project card's fields only,
 * and no drafts. Anyone else is refused: their list is `projects.list`.
 */
export const reportOrganizationProjectsProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(100).optional().default(50),
			offset: z.number().min(0).optional().default(0),
			status: ProjectStatusSchema.optional(),
			search: z.string().max(INPUT_BOUNDS.name).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (
			!organizationId ||
			!(await isFeatureEnabled("REPORT_SUITE_V2", organizationId)) ||
			!(await inheritsOrganizationReportEditor(
				organizationId,
				context.user,
			))
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization admins and owners can list all of its projects",
			});
		}
		return listOrganizationProjectsForReports({
			userId: context.user.id,
			organizationId,
			limit: input.limit,
			offset: input.offset,
			status: input.status,
			search: input.search,
		});
	});
