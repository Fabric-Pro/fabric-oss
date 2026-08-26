import { revertFrameToVersion } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	toVersion: z.number().min(1),
});

const outputSchema = z.object({
	success: z.boolean(),
	error: z.string().optional(),
});

/**
 * Revert frame to a previous version
 *
 * Restores the frame content to a historical version.
 */
export const revertFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/frames/{id}/revert",
		tags: ["Frames"],
		summary: "Revert frame to version",
		description: "Restore frame to a previous version",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await revertFrameToVersion({
			frameId: input.id,
			userId: context.user.id,
			organizationId,
			toVersion: input.toVersion,
		});

		return {
			success: result.success,
			error: result.error,
		};
	});
