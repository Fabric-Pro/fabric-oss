import { getOrganizationMembership, isPlatformAdmin } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { canEditProjectReport } from "../lib/report-access";

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
 * - `canEditProjectReports`: for `projectId`, whether the caller may create and
 *   edit that project's reports; `null` when no project was named.
 */
export const reportCapabilitiesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(capabilitiesInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);

		const [platformAdmin, membership, canEditProjectReports] =
			await Promise.all([
				isPlatformAdmin(context.user),
				organizationId
					? getOrganizationMembership(organizationId, context.user.id)
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
		};
	});
