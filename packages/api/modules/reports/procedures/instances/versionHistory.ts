import { ORPCError } from "@orpc/server";
import {
	getReportActiveInstanceVersion,
	getReportInstanceVersionHistory,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const versionHistoryInputSchema = z.object({
	sId: z.string(),
	organizationId: z.string().nullable().optional(),
	limit: z.number().min(1).max(50).default(10),
	includeArchived: z.boolean().default(true),
});

export const versionHistoryProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_UPDATE))
	.input(versionHistoryInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get the active version first to verify access
		const activeVersion = await getReportActiveInstanceVersion(input.sId);

		if (!activeVersion) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template instance not found",
			});
		}

		// Verify user has access (tenant isolation)
		const hasAccess = organizationId
			? activeVersion.organizationId === organizationId
			: activeVersion.userId === context.user.id &&
				activeVersion.organizationId === null;

		if (!hasAccess) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template instance not found or access denied",
			});
		}

		// Get version history
		const versions = await getReportInstanceVersionHistory(input.sId, {
			limit: input.limit,
			includeArchived: input.includeArchived,
		});

		return {
			sId: input.sId,
			versions: versions.map((v) => ({
				id: v.id,
				version: v.version,
				status: v.status,
				name: v.name,
				description: v.description,
				templateName: v.template.name,
				runCount: v.runCount,
				lastRunAt: v.lastRunAt?.toISOString() || null,
				createdAt: v.createdAt.toISOString(),
				updatedAt: v.updatedAt.toISOString(),
			})),
			total: versions.length,
		};
	});
