import { editFrameString } from "@repo/database";
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
	oldString: z.string(),
	newString: z.string(),
	expectedReplacements: z.number().default(1),
});

const outputSchema = z.object({
	success: z.boolean(),
	replacementsMade: z.number(),
	error: z.string().optional(),
});

/**
 * Edit frame by string replacement
 *
 * Performs a precise string replacement in the frame content.
 * Validates that the expected number of occurrences exists before replacing.
 */
export const editFrameStringProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/frames/{id}/edit-string",
		tags: ["Frames"],
		summary: "Edit frame by string replacement",
		description:
			"Perform a precise string replacement in the frame content",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const result = await editFrameString({
			frameId: input.id,
			userId: context.user.id,
			organizationId,
			oldString: input.oldString,
			newString: input.newString,
			expectedReplacements: input.expectedReplacements,
		});

		return {
			success: result.success,
			replacementsMade: result.replacementsMade,
			error: result.error,
		};
	});
