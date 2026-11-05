import { revertFrameToVersion } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { frameRevisionSchema } from "../lib/frame-edit-contract";
import { frameEditErrors } from "../lib/frame-edit-errors";

const inputSchema = z
	.object({
		id: z.string(),
		organizationId: z.string().nullable().optional(),
		toVersion: z.number().int().min(1).optional(),
		historyEntryId: z.string().min(1).optional(),
		expectedUpdatedAt: frameRevisionSchema,
	})
	.refine(
		(value) => Boolean(value.historyEntryId) !== Boolean(value.toVersion),
		{ message: "Choose one saved version." },
	);

const outputSchema = z.object({
	success: z.boolean(),
	updatedAt: z.string().optional(),
	error: z.string().optional(),
});

/**
 * Revert frame to a previous version
 *
 * Restores the frame content to a historical version.
 */
export const revertFrameProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.use(frameEditErrors)
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
			historyEntryId: input.historyEntryId,
			expectedUpdatedAt: new Date(input.expectedUpdatedAt),
		});

		return {
			success: result.success,
			updatedAt: result.updatedAt,
			error: result.error,
		};
	});
