import { ORPCError } from "@orpc/server";
import { getReportArtifact } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertArtifactTenantAccess } from "./_tenant";

const getInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getArtifactProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(getInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const artifact = await getReportArtifact(input.id);

		if (!artifact) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report artifact not found",
			});
		}

		assertArtifactTenantAccess(artifact, {
			userId: context.user.id,
			organizationId,
		});

		return artifact;
	});
