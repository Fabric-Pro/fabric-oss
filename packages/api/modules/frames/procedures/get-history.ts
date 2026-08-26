import { getFrameById, getFrameEditHistory } from "@repo/database";
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
	limit: z.number().default(50),
});

const outputSchema = z.object({
	history: z.array(
		z.object({
			id: z.string(),
			editType: z.string(),
			oldString: z.string().nullable(),
			newString: z.string().nullable(),
			editedBy: z.string(),
			editedAt: z.string(),
			revertedToVersion: z.number().nullable(),
		}),
	),
});

/**
 * Get frame edit history
 *
 * Returns the version history of a frame.
 */
export const getFrameHistoryProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/frames/{id}/history",
		tags: ["Frames"],
		summary: "Get frame edit history",
		description: "Get version history for a frame",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify the frame exists and user has access
		const frame = await getFrameById({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!frame) {
			throw new Error("Frame not found");
		}

		const history = await getFrameEditHistory(input.id, input.limit);

		return {
			history: history.map((entry, index) => ({
				id: entry.id,
				editType: entry.editType,
				oldString: entry.oldString,
				newString: entry.newString,
				editedBy: entry.editedBy,
				editedAt: entry.editedAt.toISOString(),
				revertedToVersion: entry.revertedToVersion,
				// Add version number (1 is oldest)
				version: history.length - index,
			})),
		};
	});
