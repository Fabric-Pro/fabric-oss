import { getOrganizationMembership, isPlatformAdmin } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	canCreateProjectReport,
	canEditProjectReport,
} from "../lib/report-access";

const capabilitiesInputSchema = z.object({
	projectId: z.string().optional(),
});

/**
 * What the caller may manage in the report suite, so the UI can hide controls
 * the API would refuse. Every mutation still enforces its own check.
 *
 * - `isPlatformAdmin`: may create, edit and archive SYSTEM and public templates.
 * - `isOrganizationAdmin`: admin or owner of the active organization; may edit
 *   and archive ORGANIZATION templates and any report in the organization.
 * - `canEditProjectReports`: for `projectId`, whether the caller may add reports
 *   to that project and generate samples; `null` when no project was named.
 *   Editing an existing report is the report's own `canEdit`, which an
 *   organization Viewer with an Editor project row also holds.
 * - `canSetProjectDefaults`: for `projectId`, whether the caller may set that
 *   project's defaults for its reports, which that same Viewer also may;
 *   `null` when no project was named.
 */
export const reportCapabilitiesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	// A read whose name does not look like one; without this every page that
	// asks what the caller may manage writes an activity row.
	.meta({ auditActivity: "never" })
	.input(capabilitiesInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);

		const [
			platformAdmin,
			membership,
			canEditProjectReports,
			canSetProjectDefaults,
		] = await Promise.all([
			isPlatformAdmin(context.user),
			organizationId
				? getOrganizationMembership(organizationId, context.user.id)
				: null,
			input.projectId
				? canCreateProjectReport(input.projectId, context.user)
				: null,
			input.projectId
				? canEditProjectReport(input.projectId, context.user)
				: null,
		]);

		return {
			isPlatformAdmin: platformAdmin,
			isOrganizationAdmin:
				membership?.role === "admin" || membership?.role === "owner",
			canEditProjectReports,
			canSetProjectDefaults,
		};
	});
