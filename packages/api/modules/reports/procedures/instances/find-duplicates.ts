import { ORPCError } from "@orpc/server";
import { findLikelyDuplicateReports } from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { canReachProjectReports } from "../../lib/report-access";

const findDuplicatesInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	// Compare with the project's reports; without one, the caller's own.
	projectId: z.string().min(1).max(128).optional(),
	name: z.string().max(500).default(""),
	prompt: z.string().max(100_000).default(""),
});

/**
 * Reports a new one would likely duplicate, asked before it is created: the
 * same title or the same prompt. Advisory only; creating stays allowed. The
 * project is authorized as `instances.list` authorizes it, and only reports
 * the caller may open are named.
 */
export const findDuplicateInstancesProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(findDuplicatesInputSchema)
	.handler(async ({ input, context }) => {
		if (input.projectId) {
			// Reach is `canReachProjectReports`'s, which admits an organization
			// admin to every project's reports.
			await assertProjectPermission(
				input.projectId,
				context.user.id,
				Permissions.REPORT_READ,
				undefined,
				{ admitUnreachableOrganizationMember: true },
			);
			if (
				!(await canReachProjectReports(input.projectId, context.user))
			) {
				throw new ORPCError("FORBIDDEN", {
					message: "You do not have access to this project's reports",
				});
			}
		}
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			return { duplicates: [] };
		}

		const duplicates = await findLikelyDuplicateReports({
			userId: context.user.id,
			organizationId,
			projectId: input.projectId,
			name: input.name,
			prompt: input.prompt,
		});
		return {
			duplicates: duplicates.map((report) => ({
				...report,
				createdAt: report.createdAt.toISOString(),
				lastRunAt: report.lastRunAt?.toISOString() ?? null,
			})),
		};
	});
