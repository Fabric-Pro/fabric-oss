/**
 * Get Chat Artifact
 */

import { ORPCError } from "@orpc/server";
import { getChatArtifact } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const artifact = await getChatArtifact(
			input.id,
			context.user.id,
			organizationId,
		);

		if (!artifact) {
			throw new ORPCError("NOT_FOUND", {
				message: "Artifact not found",
			});
		}

		return { artifact };
	});
