/**
 * Delete File Procedure
 *
 * Deletes a file from the user's workspace. A page (a frame or slideshow) is
 * not deleted here: its stored files and records are cleaned up with it by
 * `frames.delete`, and a row removed from this route would leave them behind.
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

const PAGE_FILE_TYPES: ReadonlySet<string> = new Set(["FRAME", "SLIDESHOW"]);

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
		if (PAGE_FILE_TYPES.has(existing.fileType)) {
			throw new Error(
				"A page is deleted from its own page, not as a file",
			);
		}

		await deleteWorkspaceFile(input.id);

		return { success: true };
	});
