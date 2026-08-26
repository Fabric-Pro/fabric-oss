/**
 * Delete File Procedure
 *
 * Deletes a file from the user's workspace.
 */

import { deleteWorkspaceFile, getWorkspaceFileById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const inputSchema = z.object({
	id: z.string(),
});

export const deleteFileProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_DELETE))
	.route({
		method: "DELETE",
		path: "/workspace/files/{id}",
		tags: ["Workspace"],
		summary: "Delete a file",
		description: "Delete a file from the user's workspace",
	})
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		// Verify ownership
		const existing = await getWorkspaceFileById(input.id);
		if (!existing) {
			throw new Error("File not found");
		}
		if (existing.userId !== context.user.id) {
			throw new Error("Access denied");
		}

		await deleteWorkspaceFile(input.id);

		return { success: true };
	});
